import { readFile, stat } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	parseSteps,
	parseWorkflowState,
	SessionUsageTracker,
	type AssistantUsageMessage,
	type DashboardData,
	type MetricsReport,
	type RuntimeSnapshot,
	type StepCard,
	type WorkerSnapshot,
} from "./workflow-dashboard-core.ts";

const STATE_PATH = "AI_Workflow_Kit/docs/AI/STATE.yaml";
const STEPS_PATH = "AI_Workflow_Kit/docs/STEPS.md";
const METRICS_HELPER = "AI_Workflow_Kit/script/workflow_metrics.sh";
const METRICS_REFRESH_MS = 15_000;

export type WorkerProgress = WorkerSnapshot & {
	task?: string;
	assignment?: string;
	lastIntent?: string;
	currentTool?: string;
	toolCount?: number;
	requests?: number;
	tokens?: number;
	updatedAt: number;
};

export type DashboardFiles = {
	state: DashboardData["state"];
	steps: StepCard[];
	stateMtime?: number;
	stepsMtime?: number;
	stateError?: string;
	stepsError?: string;
};

const workers = new Map<string, WorkerProgress>();
const usage = new SessionUsageTracker();
let mainActivity = "Ready for instruction";
let metricsCache: { data?: MetricsReport; error?: string; fetchedAt: number } = { fetchedAt: 0 };

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function clearWorkers(): void {
	workers.clear();
}

export function hubActiveAgentConsistent(active: string | undefined): boolean | undefined {
	if (!active || active === "-") return undefined;
	return [...workers.values()].some(worker =>
		(worker.status === "running" || worker.status === "pending") && worker.agent === active,
	);
}

export function currentWorker(): WorkerProgress | undefined {
	return [...workers.values()]
		.filter(worker => worker.status === "running" || worker.status === "pending")
		.sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

function displayWorker(worker: WorkerProgress | undefined): WorkerProgress | undefined {
	if (!worker) return undefined;
	if (/workflow-design-advisor(?:-backup)?$/.test(worker.agent)) return { ...worker, agent: "Design Advisor" };
	if (/workflow-designer(?:-backup)?$/.test(worker.agent)) return { ...worker, agent: "Designer" };
	return worker;
}

export function runtimeSnapshot(ctx: ExtensionContext): RuntimeSnapshot {
	const model = ctx.models.current() ?? ctx.model;
	return {
		worker: displayWorker(currentWorker()),
		mainModel: model ? `${model.provider}/${model.id}` : undefined,
		mainStatus: ctx.isIdle() ? "idle" : "working",
		mainActivity,
	};
}

export function setMainActivity(value: string): void {
	mainActivity = value;
}

export function rebuildMainUsage(ctx: ExtensionContext): void {
	usage.reset();
	const branch = ctx.sessionManager.getBranch() as unknown as Array<{
		id?: string;
		type?: string;
		message?: AssistantUsageMessage;
	}>;
	for (const [index, entry] of branch.entries()) {
		if (entry.type === "message" && entry.message) {
			usage.recordAssistantMessage(entry.message, "orchestrator", `entry:${entry.id ?? index}`);
		}
	}
}

export function recordMainTurn(message: AssistantUsageMessage, turnIndex: number): void {
	usage.recordAssistantMessage(
		message,
		"orchestrator",
		`turn:${turnIndex}:${message.timestamp ?? 0}:${message.responseId ?? ""}`,
	);
}

export function recordWorkerProgress(progress: Partial<WorkerProgress> & {
	id?: string;
	agent?: string;
	status?: WorkerProgress["status"];
}): void {
	if (!progress.id || !progress.agent || !progress.status) return;
	const previous = workers.get(progress.id);
	const worker: WorkerProgress = {
		id: progress.id,
		agent: progress.agent,
		status: progress.status,
		startedAt: previous?.startedAt ?? Date.now(),
		updatedAt: Date.now(),
		task: progress.task ?? previous?.task,
		assignment: progress.assignment ?? previous?.assignment,
		lastIntent: progress.lastIntent ?? previous?.lastIntent,
		currentTool: progress.currentTool ?? previous?.currentTool,
		toolCount: progress.toolCount ?? previous?.toolCount,
		requests: progress.requests ?? previous?.requests,
		tokens: progress.tokens ?? previous?.tokens,
		durationMs: progress.durationMs ?? previous?.durationMs,
		resolvedModel: progress.resolvedModel ?? previous?.resolvedModel,
		resolvedModelIsFallback: progress.resolvedModelIsFallback ?? previous?.resolvedModelIsFallback,
	};
	workers.set(worker.id, worker);
	usage.recordWorkerProgress(worker);
}

export function recordWorkerLifecycle(payload: {
	id?: string;
	agent?: string;
	status?: "started" | WorkerProgress["status"];
}): void {
	if (!payload.id || !payload.agent || !payload.status) return;
	const previous = workers.get(payload.id);
	workers.set(payload.id, {
		...(previous ?? { id: payload.id, agent: payload.agent, startedAt: Date.now() }),
		status: payload.status === "started" ? "running" : payload.status,
		updatedAt: Date.now(),
	});
}

export async function readDashboardFiles(cwd: string): Promise<DashboardFiles> {
	const [stateFile, stepsFile, stateInfo, stepsInfo] = await Promise.allSettled([
		readFile(`${cwd}/${STATE_PATH}`, "utf8"),
		readFile(`${cwd}/${STEPS_PATH}`, "utf8"),
		stat(`${cwd}/${STATE_PATH}`),
		stat(`${cwd}/${STEPS_PATH}`),
	]);
	return {
		state: parseWorkflowState(stateFile.status === "fulfilled" ? stateFile.value : ""),
		steps: parseSteps(stepsFile.status === "fulfilled" ? stepsFile.value : ""),
		stateMtime: stateInfo.status === "fulfilled" ? stateInfo.value.mtimeMs : undefined,
		stepsMtime: stepsInfo.status === "fulfilled" ? stepsInfo.value.mtimeMs : undefined,
		stateError: stateFile.status === "rejected" ? errorText(stateFile.reason) : undefined,
		stepsError: stepsFile.status === "rejected" ? errorText(stepsFile.reason) : undefined,
	};
}

export async function refreshMetrics(pi: ExtensionAPI, cwd: string, force = false): Promise<void> {
	if (!force && Date.now() - metricsCache.fetchedAt < METRICS_REFRESH_MS) return;
	metricsCache = { ...metricsCache, fetchedAt: Date.now() };
	try {
		const result = await pi.exec("bash", [METRICS_HELPER, "report", "--json"], { cwd, timeout: 10_000 });
		if (result.code !== 0) throw new Error(result.stderr.trim() || `metrics helper exited ${result.code}`);
		const data = JSON.parse(result.stdout) as MetricsReport;
		if (data.available === false) throw new Error(data.error ?? "metrics unavailable");
		metricsCache = { data, fetchedAt: Date.now() };
	} catch (error) {
		metricsCache = { error: errorText(error), fetchedAt: Date.now() };
	}
}

export function makeDashboardData(files: DashboardFiles): DashboardData & DashboardFiles {
	return {
		...files,
		metrics: metricsCache.data,
		metricsError: metricsCache.error,
		sessionUsage: usage.snapshot(),
	};
}

export function metricsFetchedAt(): number {
	return metricsCache.fetchedAt;
}
