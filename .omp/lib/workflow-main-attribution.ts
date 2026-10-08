// Main (orchestrator) attribution for the cross-project model leaderboard.
//
// Main records metrics through bash, so the recorder subprocess cannot know which
// model Main is running. Extensions run inside Main's session and can read it, so
// this module records two events per project store, deterministically and without
// relying on Main's memory:
//   input (source "interactive")  -> human_turn        {step, model}
//   agent_start                   -> orchestrator_model {step, model}  (first sight of a step, or model change)
// `step` is STATE.yaml's current step; with no current step nothing is recorded.
// Recording is detached from the event: it never delays input, never throws, and
// stays silent on failure (the next event simply retries). No prompt text is stored.

import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { parseWorkflowState } from "./workflow-dashboard-core.ts";
import { METRICS_HELPER, STATE_PATH } from "./workflow-dashboard-data.ts";
import { isMainSession } from "./workflow-guard.ts";

export const RECORD_TIMEOUT_MS = 10_000;
export type AttributionEvent = "human_turn" | "orchestrator_model";

// Same effort suffixes the recorder strips (workflow_metrics.py THINKING_SUFFIX).
const EFFORT_SUFFIX = /:(?:off|minimal|low|medium|high|xhigh|max|auto|inherit)$/;
const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,159}$/;
const KEY_UNSAFE = /[^A-Za-z0-9._:/-]/g;

export type ModelLike = { provider?: string; id?: string };

export type RecordPlan = {
	event: AttributionEvent;
	eventKey: string;
	step: string;
	model: string;
};

/** Live Main model as `provider/id` with the effort suffix stripped; undefined when unknown or not recordable. */
export function mainModelKey(model: ModelLike | undefined): string | undefined {
	const id = model?.id?.trim().replace(EFFORT_SUFFIX, "");
	if (!id) return undefined;
	const key = model?.provider ? `${model.provider}/${id}` : id;
	return MODEL_ID.test(key) ? key : undefined;
}

/** STATE.yaml's current step when it is a real, recordable step id. */
export function currentStepId(stateText: string): string | undefined {
	const step = parseWorkflowState(stateText).currentStep.trim();
	return step !== "-" && STEP_ID.test(step) ? step : undefined;
}

/**
 * Human instruction to Main, not an OMP UI command: slash commands other than
 * `/workflow …` (e.g. /model, /clear, /workflow-stats) and `!` shell lines are not
 * explanations the Human had to give Main.
 */
export function isHumanInstruction(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed || trimmed.startsWith("!")) return false;
	if (trimmed.startsWith("/")) return /^\/workflow(?:\s|$)/.test(trimmed);
	return true;
}

export function recorderArgs(plan: RecordPlan): string[] {
	return [METRICS_HELPER, "record", plan.event, "--event-key", plan.eventKey, "--step", plan.step, "--model", plan.model];
}

/** Remembers, per step, the Main model last recorded so only changes and first sights are written. */
export class MainAttributionTracker {
	private readonly lastModelByStep = new Map<string, string>();
	private sequence = 0;

	reset(): void {
		this.lastModelByStep.clear();
	}

	planHumanTurn(step: string, model: string, now: number): RecordPlan {
		this.sequence += 1;
		return { event: "human_turn", eventKey: `human_turn:${step}:${now}:${this.sequence}`.slice(0, 160), step, model };
	}

	planModel(step: string, model: string): RecordPlan | undefined {
		if (this.lastModelByStep.get(step) === model) return undefined;
		this.lastModelByStep.set(step, model);
		// Deterministic: the same step+model is an idempotent no-op in the recorder, also across sessions.
		const safeModel = model.replace(KEY_UNSAFE, "_");
		return { event: "orchestrator_model", eventKey: `orchestrator_model:${step}:${safeModel}`.slice(0, 160), step, model };
	}

	/** A failed record must be retried by the next event, not remembered as done. */
	rollback(plan: RecordPlan): void {
		if (plan.event === "orchestrator_model" && this.lastModelByStep.get(plan.step) === plan.model) {
			this.lastModelByStep.delete(plan.step);
		}
	}
}

export type AttributionDeps = {
	tracker: MainAttributionTracker;
	readState: () => Promise<string>;
	exec: (args: string[]) => Promise<{ code: number }>;
	now?: () => number;
};

export type AttributionOutcome = "recorded" | "skipped" | "failed";

/** Resolve the current step and record one event. Never throws. */
export async function recordAttribution(
	deps: AttributionDeps,
	event: AttributionEvent,
	model: string | undefined,
): Promise<AttributionOutcome> {
	if (!model) return "skipped";
	let step: string | undefined;
	try {
		step = currentStepId(await deps.readState());
	} catch {
		return "skipped";
	}
	if (!step) return "skipped";
	const plan =
		event === "human_turn"
			? deps.tracker.planHumanTurn(step, model, (deps.now ?? Date.now)())
			: deps.tracker.planModel(step, model);
	if (!plan) return "skipped";
	try {
		const result = await deps.exec(recorderArgs(plan));
		if (result.code !== 0) throw new Error(`recorder exited ${result.code}`);
		return "recorded";
	} catch {
		deps.tracker.rollback(plan);
		return "failed";
	}
}

function liveMainModel(ctx: ExtensionContext): string | undefined {
	try {
		return mainModelKey(ctx.models.current() ?? ctx.model);
	} catch {
		return undefined;
	}
}

export default function workflowMainAttribution(pi: ExtensionAPI): void {
	const tracker = new MainAttributionTracker();
	const depsFor = (ctx: ExtensionContext): AttributionDeps => ({
		tracker,
		readState: () => readFile(`${ctx.cwd}/${STATE_PATH}`, "utf8"),
		exec: args => pi.exec("bash", args, { cwd: ctx.cwd, timeout: RECORD_TIMEOUT_MS }),
	});
	// The model is read synchronously while the event is in flight; everything else is detached.
	const detach = (ctx: ExtensionContext, event: AttributionEvent): void => {
		const model = liveMainModel(ctx);
		void recordAttribution(depsFor(ctx), event, model).catch(() => undefined);
	};

	// OMP binds project extensions into every worker session; only the top-level Main session may record.
	pi.on("session_start", async () => tracker.reset());
	pi.on("session_switch", async () => tracker.reset());
	pi.on("input", async (event, ctx) => {
		if (event.source === "interactive" && isMainSession(ctx.agent, ctx.hasUI) && isHumanInstruction(event.text)) {
			detach(ctx, "human_turn");
		}
		return undefined;
	});
	pi.on("agent_start", async (_event, ctx) => {
		if (isMainSession(ctx.agent, ctx.hasUI)) detach(ctx, "orchestrator_model");
	});
}
