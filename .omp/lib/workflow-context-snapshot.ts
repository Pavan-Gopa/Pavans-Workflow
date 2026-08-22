import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { applyLiveStep } from "./workflow-live-step.ts";
import { readRuntimeTodo } from "./workflow-runtime-todo.ts";
import {
	makeDashboardData,
	readDashboardFiles,
	runtimeSnapshot,
} from "./workflow-dashboard-data.ts";
import { getContextEconomyStatus } from "./workflow-context-economy.ts";

const STATE_PATH = "AI_Workflow_Kit/docs/AI/STATE.yaml";
const STEPS_PATH = "AI_Workflow_Kit/docs/STEPS.md";
const DECISIONS_PATH = "AI_Workflow_Kit/docs/DECISIONS.md";
const PROJECT_CONTEXT_PATH = "AI_Workflow_Kit/docs/PROJECT_CONTEXT.md";
const MAX_ITEMS_PER_KIND = 12;
const MAX_CHANGED_PATHS = 24;
const MAX_HUMAN_TEXT = 1200;
const MAX_ANCHOR_CHARS = 6200;

export type WorkflowContextSnapshot = {
	schemaVersion: 1;
	generatedAt: string;
	authority: string;
	workflow: Record<string, unknown>;
	currentStep: Record<string, unknown>;
	runtime: Record<string, unknown>;
	context: Record<string, unknown>;
	git: Record<string, unknown>;
	canonical: Record<string, unknown>;
	lastHumanInstruction?: string;
};

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
				return String((part as { text?: unknown }).text ?? "");
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function lastHumanInstruction(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch() as unknown as Array<Record<string, unknown>>;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!message || typeof message !== "object" || (message as { role?: string }).role !== "user") continue;
		const text = textFromContent((message as { content?: unknown }).content).trim();
		if (text) return text.slice(0, MAX_HUMAN_TEXT);
	}
	return undefined;
}

async function readText(cwd: string, path: string): Promise<string> {
	try {
		return await readFile(`${cwd}/${path}`, "utf8");
	} catch {
		return "";
	}
}

function digest(text: string): string | null {
	return text ? createHash("sha256").update(text).digest("hex").slice(0, 16) : null;
}

function yamlList(source: string, key: string): string[] {
	const lines = source.split(/\r?\n/);
	const start = lines.findIndex(line => new RegExp(`^${key}:\\s*(?:#.*)?$`).test(line));
	if (start < 0) return [];
	const result: string[] = [];
	for (let index = start + 1; index < lines.length; index += 1) {
		const line = lines[index];
		if (line && !/^\s/.test(line)) break;
		const match = /^\s+-\s+(.+?)\s*$/.exec(line);
		if (match) result.push(match[1].replace(/^["']|["']$/g, ""));
	}
	return result;
}

function pending(items: Array<{ id?: string; text: string; done: boolean }>): Array<{ id?: string; text: string }> {
	return items.filter(item => !item.done).slice(0, MAX_ITEMS_PER_KIND).map(item => ({ id: item.id, text: item.text }));
}

async function gitSummary(pi: ExtensionAPI, cwd: string): Promise<Record<string, unknown>> {
	try {
		const result = await pi.exec("git", ["status", "--short", "--untracked-files=all"], { cwd, timeout: 3_000 });
		if (result.code !== 0) return { available: false, error: (result.stderr || result.stdout).trim().slice(0, 300) };
		const lines = result.stdout.split(/\r?\n/).filter(Boolean);
		return {
			available: true,
			dirty: lines.length > 0,
			changedCount: lines.length,
			changedPaths: lines.slice(0, MAX_CHANGED_PATHS).map(line => line.slice(3)),
			elidedCount: Math.max(0, lines.length - MAX_CHANGED_PATHS),
		};
	} catch (error) {
		return { available: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export async function buildWorkflowContextSnapshot(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: { includeGit?: boolean } = {},
): Promise<WorkflowContextSnapshot> {
	const [files, stateText, stepsText, decisionsText, projectContextText] = await Promise.all([
		readDashboardFiles(ctx.cwd),
		readText(ctx.cwd, STATE_PATH),
		readText(ctx.cwd, STEPS_PATH),
		readText(ctx.cwd, DECISIONS_PATH),
		readText(ctx.cwd, PROJECT_CONTEXT_PATH),
	]);
	const runtime = runtimeSnapshot(ctx);
	const runtimeTodo = readRuntimeTodo(ctx.sessionManager.getBranch());
	const applied = applyLiveStep({ ...makeDashboardData(files), runtimeTodo }, runtime);
	const liveStepId = applied.resolution.id ?? files.state.currentStep;
	const step = files.steps.find(item => item.id === liveStepId) ?? files.steps.find(item => item.id === files.state.currentStep);
	const economy = getContextEconomyStatus(ctx);
	const worker = runtime.worker;
	return {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		authority: "Derived navigation index only. Canonical workflow files, repository source, diff, tests, and artifacts remain authoritative.",
		workflow: {
			canonicalCurrentStep: files.state.currentStep,
			liveStep: liveStepId,
			liveStepSource: applied.resolution.source,
			currentWorkItemId: files.state.currentWorkItemId || null,
			currentWorkItem: files.state.currentWorkItem || null,
			nextActor: files.state.nextActor,
			implementationStatus: files.state.implementationStatus,
			implementationAttempts: files.state.implementationAttempts,
			reviewStatus: files.state.reviewStatus,
			reviewVerdict: files.state.reviewVerdict || null,
			blocker: files.state.blocker || null,
			repeatedFailureCount: files.state.repeatedFailureCount,
			modelFailureStatus: files.state.modelFailureStatus,
			targetFiles: yamlList(stateText, "target_files").slice(0, MAX_CHANGED_PATHS),
		},
		currentStep: {
			id: step?.id ?? liveStepId,
			title: step?.title ?? null,
			goal: step?.goal?.slice(0, 900) ?? null,
			pendingDo: step ? pending(step.todos) : [],
			pendingObjectiveGates: step ? pending(step.objectiveGates) : [],
			pendingJudgmentGates: step ? pending(step.judgmentGates) : [],
		},
		runtime: {
			mainModel: runtime.mainModel ?? null,
			mainStatus: runtime.mainStatus,
			mainActivity: runtime.mainActivity,
			activeWorker: worker
				? {
					id: worker.id,
					agent: worker.agent,
					status: worker.status,
					model: worker.resolvedModel ?? null,
					tool: worker.currentTool ?? null,
					requests: worker.requests ?? null,
					tokens: worker.tokens ?? null,
				}
				: null,
			runtimeTodoPhase: (runtimeTodo as { phase?: unknown } | undefined)?.phase ?? null,
		},
		context: {
			tokens: economy.usage?.tokens ?? null,
			contextWindow: economy.usage?.contextWindow ?? null,
			percent: economy.usage?.percent ?? null,
			phase: economy.state.phase,
			armed: economy.state.armed,
			softArmPercent: economy.policy.softArmPercent,
			hardThresholdPercent: economy.policy.hardThresholdPercent,
			methodOrder: economy.policy.methodOrder,
			lastCompactionAt: economy.state.lastCompactionAt ?? null,
			lastBeforeTokens: economy.state.lastBeforeTokens ?? null,
			lastAfterTokens: economy.state.lastAfterTokens ?? null,
			lastError: economy.state.lastError ?? null,
		},
		git: options.includeGit === false ? { included: false } : await gitSummary(pi, ctx.cwd),
		canonical: {
			paths: [STATE_PATH, STEPS_PATH, DECISIONS_PATH, PROJECT_CONTEXT_PATH],
			hashes: {
				[STATE_PATH]: digest(stateText),
				[STEPS_PATH]: digest(stepsText),
				[DECISIONS_PATH]: digest(decisionsText),
				[PROJECT_CONTEXT_PATH]: digest(projectContextText),
			},
		},
		lastHumanInstruction: lastHumanInstruction(ctx),
	};
}

function compactAnchor(snapshot: WorkflowContextSnapshot): string {
	const serialized = JSON.stringify(snapshot);
	if (serialized.length <= MAX_ANCHOR_CHARS) return serialized;
	const reduced = {
		...snapshot,
		git: { note: "git detail elided from compaction anchor" },
		lastHumanInstruction: snapshot.lastHumanInstruction?.slice(0, 500),
	};
	return JSON.stringify(reduced).slice(0, MAX_ANCHOR_CHARS);
}

export function installWorkflowContextSnapshot(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "workflow_context",
		label: "Workflow Context",
		description:
			"Read a compact derived snapshot of the current workflow step, open gates, active worker, context usage, canonical hashes, and repository status. Use this first for ordinary routing; verify claims against exact canonical files and source when needed.",
		parameters: z.object({
			includeGit: z.boolean().optional().describe("Include capped git status paths (default true)"),
		}),
		loadMode: "essential",
		approval: "read",
		strict: true,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const snapshot = await buildWorkflowContextSnapshot(pi, ctx, { includeGit: params.includeGit !== false });
			return {
				content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
				details: snapshot,
			};
		},
	});

	pi.registerCommand("workflow-context", {
		description: "Show the compact authoritative workflow navigation snapshot",
		handler: async (_args, ctx) => {
			const snapshot = await buildWorkflowContextSnapshot(pi, ctx);
			ctx.ui.notify(JSON.stringify(snapshot, null, 2), "info");
		},
	});

	pi.on("session.compacting", async (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		const snapshot = await buildWorkflowContextSnapshot(pi, ctx);
		return {
			context: [
				"Pavan workflow navigation anchor (derived, compact, and non-authoritative):",
				compactAnchor(snapshot),
				"After compaction, reconcile this anchor with canonical workflow files and real repository evidence before routing or changing gates.",
			],
			preserveData: {
				workflowContext: {
					schemaVersion: 1,
					generatedAt: snapshot.generatedAt,
					liveStep: snapshot.workflow.liveStep,
					currentWorkItemId: snapshot.workflow.currentWorkItemId,
					canonicalHashes: snapshot.canonical.hashes,
				},
			},
		};
	});
}
