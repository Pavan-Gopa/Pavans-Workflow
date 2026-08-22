import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { currentWorker } from "./workflow-dashboard-data.ts";
import {
	DEFAULT_CONTEXT_ECONOMY_POLICY,
	evaluateContextEconomy,
	formatContextEconomyStatus,
	initialContextEconomyState,
	isContextEconomyPhase,
	normalizeContextEconomyPolicy,
	type ContextEconomyPolicy,
	type ContextEconomyRuntimeState,
	type ContextEconomyStatus,
} from "./workflow-context-economy-core.ts";

type AutoCompactionStartLike = {
	reason: "threshold" | "overflow" | "idle" | "incomplete";
	action: "context-full" | "remote" | "handoff" | "shake" | "snapcompact";
};

type AutoCompactionEndLike = {
	action: "context-full" | "remote" | "handoff" | "shake" | "snapcompact";
	aborted: boolean;
	errorMessage?: string;
};

const POLICY_PATH = ".omp/workflow-context-policy.json";
const CUSTOM_ENTRY = "workflow-context-economy";
const SAFE_BOUNDARY_DELAY_MS = 120;

let activeContext: ExtensionContext | undefined;
let activeSessionId: string | undefined;
let policy: ContextEconomyPolicy = DEFAULT_CONTEXT_ECONOMY_POLICY;
let state: ContextEconomyRuntimeState = initialContextEconomyState();
let scheduled: Timer | undefined;
let checkRunning = false;
let installed = false;

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

function sessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

function hasActiveWorker(): boolean {
	const worker = currentWorker();
	return worker?.status === "running" || worker?.status === "pending";
}

function persist(pi: ExtensionAPI, eventReason: string): void {
	state = { ...state, updatedAt: Date.now() };
	pi.appendEntry(CUSTOM_ENTRY, {
		version: 1,
		phase: state.phase,
		armed: state.armed,
		compacting: state.compacting,
		updatedAt: state.updatedAt,
		lastReason: state.lastReason,
		eventReason,
		lastAction: state.lastAction,
		lastCompactionAt: state.lastCompactionAt,
		lastBeforeTokens: state.lastBeforeTokens,
		lastAfterTokens: state.lastAfterTokens,
		lastError: state.lastError,
	});
}

function restore(ctx: ExtensionContext): void {
	state = initialContextEconomyState();
	for (const entry of ctx.sessionManager.getBranch() as unknown as Array<Record<string, unknown>>) {
		if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY) continue;
		const data = entry.data;
		if (!data || typeof data !== "object") continue;
		const value = data as Partial<ContextEconomyRuntimeState>;
		state = {
			phase: isContextEconomyPhase(value.phase) ? value.phase : "unavailable",
			armed: value.armed === true,
			compacting: false,
			updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
			lastReason: typeof value.lastReason === "string" ? value.lastReason : undefined,
			lastAction: typeof value.lastAction === "string" ? value.lastAction : undefined,
			lastCompactionAt: typeof value.lastCompactionAt === "number" ? value.lastCompactionAt : undefined,
			lastBeforeTokens: typeof value.lastBeforeTokens === "number" ? value.lastBeforeTokens : undefined,
			lastAfterTokens: typeof value.lastAfterTokens === "number" ? value.lastAfterTokens : undefined,
			lastError: typeof value.lastError === "string" ? value.lastError : undefined,
		};
	}
}

async function loadPolicy(ctx: ExtensionContext): Promise<void> {
	try {
		const raw = JSON.parse(await readFile(`${ctx.cwd}/${POLICY_PATH}`, "utf8"));
		policy = normalizeContextEconomyPolicy(raw);
	} catch {
		policy = DEFAULT_CONTEXT_ECONOMY_POLICY;
	}
}

function clearScheduled(ctx?: ExtensionContext): void {
	if (scheduled && ctx) ctx.clearTimer(scheduled);
	scheduled = undefined;
}

function schedule(pi: ExtensionAPI, ctx: ExtensionContext, reason: string, delayMs = SAFE_BOUNDARY_DELAY_MS): void {
	if (!ctx.hasUI || ctx.mode !== "tui") return;
	clearScheduled(ctx);
	const expectedSession = sessionId(ctx);
	scheduled = ctx.setTimeout(() => {
		scheduled = undefined;
		if (activeSessionId !== expectedSession) return;
		void check(pi, ctx, reason);
	}, delayMs);
}

async function finishCompaction(pi: ExtensionAPI, ctx: ExtensionContext, beforeTokens: number, action: string): Promise<void> {
	await new Promise<void>(resolve => ctx.setTimeout(() => resolve(), 50));
	const usage = ctx.getContextUsage();
	state = {
		...state,
		phase: usage && usage.percent <= policy.rearmPercent ? "below" : "cooldown",
		armed: false,
		compacting: false,
		lastAction: action,
		lastCompactionAt: Date.now(),
		lastBeforeTokens: beforeTokens,
		lastAfterTokens: usage?.tokens,
		lastError: undefined,
		updatedAt: Date.now(),
	};
	persist(pi, `compaction completed via ${action}`);
}

async function runOpportunisticCompaction(pi: ExtensionAPI, ctx: ExtensionContext, reason: string): Promise<void> {
	const before = ctx.getContextUsage();
	if (!before || state.compacting) return;
	state = {
		...state,
		phase: "compacting",
		armed: true,
		compacting: true,
		lastBeforeTokens: before.tokens,
		lastError: undefined,
		updatedAt: Date.now(),
	};
	persist(pi, reason);
	let callbackError: Error | undefined;
	let completed = false;
	try {
		await ctx.compact({
			onComplete: () => {
				completed = true;
			},
			onError: error => {
				callbackError = error;
			},
		});
		if (callbackError) throw callbackError;
		if (!completed) {
			const after = ctx.getContextUsage();
			completed = Boolean(after && after.tokens < before.tokens);
		}
		if (!completed) throw new Error("OMP returned without a completed compaction result");
		await finishCompaction(pi, ctx, before.tokens, policy.methodOrder.join("->"));
	} catch (error) {
		state = {
			...state,
			phase: "error",
			armed: true,
			compacting: false,
			lastError: errorText(error),
			updatedAt: Date.now(),
		};
		persist(pi, "opportunistic compaction failed");
		ctx.ui.notify(`Floating compaction failed: ${state.lastError}`, "warning");
	}
}

async function check(pi: ExtensionAPI, ctx: ExtensionContext, reason: string): Promise<void> {
	if (checkRunning || state.compacting || !ctx.hasUI || ctx.mode !== "tui") return;
	checkRunning = true;
	try {
		const decision = evaluateContextEconomy({
			usage: ctx.getContextUsage(),
			policy,
			state,
			now: Date.now(),
			mainIdle: ctx.isIdle(),
			activeWorker: hasActiveWorker(),
			pendingMessages: ctx.hasPendingMessages(),
		});
		const changed = decision.phase !== state.phase || decision.armed !== state.armed || state.lastReason !== decision.reason;
		state = {
			...state,
			phase: decision.phase,
			armed: decision.armed,
			lastReason: decision.reason,
			updatedAt: Date.now(),
		};
		if (changed && (decision.armed || decision.phase === "below" || decision.phase === "hard_threshold")) {
			persist(pi, `${reason}: ${decision.reason}`);
		}
		if (decision.shouldCompact) {
			await runOpportunisticCompaction(pi, ctx, `${reason}: ${decision.reason}`);
		}
	} finally {
		checkRunning = false;
	}
}

function onAutoCompactionStart(pi: ExtensionAPI, event: AutoCompactionStartLike, ctx: ExtensionContext): void {
	const usage = ctx.getContextUsage();
	state = {
		...state,
		phase: "compacting",
		armed: true,
		compacting: true,
		lastAction: event.action,
		lastBeforeTokens: usage?.tokens,
		lastError: undefined,
		updatedAt: Date.now(),
	};
	persist(pi, `native auto-compaction started (${event.reason}/${event.action})`);
}

function onAutoCompactionEnd(pi: ExtensionAPI, event: AutoCompactionEndLike, ctx: ExtensionContext): void {
	const usage = ctx.getContextUsage();
	const failed = event.aborted || Boolean(event.errorMessage);
	state = {
		...state,
		phase: failed ? "error" : usage && usage.percent <= policy.rearmPercent ? "below" : "cooldown",
		armed: failed,
		compacting: false,
		lastAction: event.action,
		lastCompactionAt: failed ? state.lastCompactionAt : Date.now(),
		lastAfterTokens: usage?.tokens,
		lastError: event.errorMessage,
		updatedAt: Date.now(),
	};
	persist(pi, failed ? "native auto-compaction failed" : "native auto-compaction completed");
}

export function getContextEconomyStatus(ctx?: ExtensionContext): ContextEconomyStatus {
	const live = ctx ?? activeContext;
	return {
		usage: live?.getContextUsage(),
		policy,
		state,
		activeWorker: hasActiveWorker(),
		pendingMessages: live?.hasPendingMessages() ?? false,
		mainIdle: live?.isIdle() ?? true,
	};
}

export function getContextEconomyState(): ContextEconomyRuntimeState {
	return { ...state };
}

export function formatContextEconomyDashboardLine(ctx: ExtensionContext): { text: string; warning: boolean } {
	const status = getContextEconomyStatus(ctx);
	return {
		text: formatContextEconomyStatus(status),
		warning: status.state.phase === "error" || status.state.phase === "hard_threshold",
	};
}

export function installContextEconomy(pi: ExtensionAPI): void {
	if (installed) return;
	installed = true;
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		activeContext = ctx;
		activeSessionId = sessionId(ctx);
		await loadPolicy(ctx);
		restore(ctx);
		schedule(pi, ctx, "session start", 250);
	});
	pi.on("session_switch", async (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		clearScheduled(activeContext);
		activeContext = ctx;
		activeSessionId = sessionId(ctx);
		await loadPolicy(ctx);
		restore(ctx);
		schedule(pi, ctx, "session switch", 250);
	});
	pi.on("turn_end", async (_event, ctx) => schedule(pi, ctx, "turn end"));
	pi.on("agent_end", async (event, ctx) => {
		if (!event.willContinue) schedule(pi, ctx, "agent settled");
	});
	pi.on("tool_execution_end", async (_event, ctx) => schedule(pi, ctx, "tool boundary", 200));
	pi.on("auto_compaction_start", async (event, ctx) => onAutoCompactionStart(pi, event, ctx));
	pi.on("auto_compaction_end", async (event, ctx) => onAutoCompactionEnd(pi, event, ctx));
	pi.on("session_compact", async (_event, ctx) => schedule(pi, ctx, "session compacted", 100));
	pi.on("session_shutdown", async (_event, ctx) => {
		clearScheduled(ctx);
		if (activeSessionId === sessionId(ctx)) {
			activeContext = undefined;
			activeSessionId = undefined;
		}
	});
	pi.events.on("task:subagent:lifecycle", data => {
		const payload = data as { status?: string };
		if (!activeContext || payload.status === "started" || payload.status === "running" || payload.status === "pending") return;
		schedule(pi, activeContext, "worker settled", 200);
	});
	pi.registerCommand("workflow-context-economy", {
		description: "Show the floating context-compaction controller state",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatContextEconomyStatus(getContextEconomyStatus(ctx)), state.phase === "error" ? "warning" : "info");
		},
	});
}
