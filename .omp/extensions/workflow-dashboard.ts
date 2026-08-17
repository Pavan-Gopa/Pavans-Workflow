import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { Key, matchesKey } from "@oh-my-pi/pi-tui";
import {
	deriveDashboardViewModel,
	parseSteps,
	parseWorkflowState,
	renderDashboard,
	SessionUsageTracker,
	type AssistantUsageMessage,
	type DashboardData,
	type MetricsReport,
	type RuntimeSnapshot,
	type StepCard,
	type TextLine,
	type WorkerSnapshot,
	type WorkflowState,
} from "../lib/workflow-dashboard-core.ts";
import { OmpStatsController } from "../lib/omp-stats-link.ts";

const STATE_PATH = "AI_Workflow_Kit/docs/AI/STATE.yaml";
const STEPS_PATH = "AI_Workflow_Kit/docs/STEPS.md";
const METRICS_HELPER_PATH = "AI_Workflow_Kit/script/workflow_metrics.sh";
const METRICS_REFRESH_MS = 15_000;
const LIVE_REFRESH_MS = 1_000;

type ThemeTone = "accent" | "muted" | "warning";
type ThemeLike = { fg: (tone: ThemeTone, text: string) => string };
type KeybindingsLike = { matches: (data: string, action: string) => boolean };

type WorkerProgress = WorkerSnapshot & {
	task?: string;
	assignment?: string;
	lastIntent?: string;
	currentTool?: string;
	toolCount?: number;
	requests?: number;
	tokens?: number;
	updatedAt: number;
};

type DashboardFiles = {
	state: WorkflowState;
	steps: StepCard[];
	stateError?: string;
	stepsError?: string;
};

const liveWorkers = new Map<string, WorkerProgress>();
const sessionUsage = new SessionUsageTracker();
let mainActivity = "Ready for instruction";
let listenersInstalled = false;
let activePanel: WorkflowDashboard | undefined;
let metricsCache: { data?: MetricsReport; error?: string; fetchedAt: number } = { fetchedAt: 0 };
const ompStats = new OmpStatsController({ onChange: () => activePanel?.requestRender() });

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function modelText(ctx: ExtensionContext | undefined): string | undefined {
	const model = ctx?.models.current() ?? ctx?.model;
	return model ? `${model.provider}/${model.id}` : undefined;
}

function currentWorker(): WorkerProgress | undefined {
	return [...liveWorkers.values()]
		.filter(worker => worker.status === "running" || worker.status === "pending")
		.sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

function humanMainActivity(toolName: string): string {
	return (
		{
			read: "Reading workflow evidence",
			grep: "Locating relevant evidence",
			glob: "Mapping relevant project files",
			bash: "Running a workflow check",
			eval: "Evaluating workflow evidence",
			task: "Starting a fresh specialized worker",
			hub: "Supervising the active worker",
			edit: "Updating verified workflow state",
			write: "Persisting verified workflow state",
			todo: "Updating the live task checklist",
			ask: "Requesting required Human input",
		}[toolName] ?? "Working on the next verified transition"
	);
}

function rebuildMainUsage(ctx: ExtensionContext): void {
	sessionUsage.reset();
	const entries = ctx.sessionManager.getBranch() as unknown as Array<{
		id?: string;
		type?: string;
		message?: AssistantUsageMessage;
	}>;
	for (const [index, entry] of entries.entries()) {
		if (entry.type !== "message" || !entry.message) continue;
		sessionUsage.recordAssistantMessage(entry.message, "orchestrator", `entry:${entry.id ?? index}`);
	}
}

async function readDashboardFiles(cwd: string): Promise<DashboardFiles> {
	const [stateResult, stepsResult] = await Promise.allSettled([
		readFile(`${cwd}/${STATE_PATH}`, "utf8"),
		readFile(`${cwd}/${STEPS_PATH}`, "utf8"),
	]);
	const stateSource = stateResult.status === "fulfilled" ? stateResult.value : "";
	const stepsSource = stepsResult.status === "fulfilled" ? stepsResult.value : "";
	return {
		state: parseWorkflowState(stateSource),
		steps: parseSteps(stepsSource),
		stateError: stateResult.status === "rejected" ? errorMessage(stateResult.reason) : undefined,
		stepsError: stepsResult.status === "rejected" ? errorMessage(stepsResult.reason) : undefined,
	};
}

async function refreshMetrics(pi: ExtensionAPI, cwd: string, force = false): Promise<void> {
	if (!force && Date.now() - metricsCache.fetchedAt < METRICS_REFRESH_MS) return;
	metricsCache = { ...metricsCache, fetchedAt: Date.now() };
	try {
		const result = await pi.exec("bash", [METRICS_HELPER_PATH, "report", "--json"], { cwd, timeout: 10_000 });
		if (result.code !== 0) throw new Error(result.stderr.trim() || `metrics helper exited ${result.code}`);
		const data = JSON.parse(result.stdout) as MetricsReport;
		if (data.available === false) throw new Error(data.error ?? "metrics unavailable");
		metricsCache = { data, fetchedAt: Date.now() };
	} catch (error) {
		metricsCache = { error: errorMessage(error), fetchedAt: Date.now() };
	}
}

function runtimeSnapshot(ctx: ExtensionContext): RuntimeSnapshot {
	return {
		worker: currentWorker(),
		mainModel: modelText(ctx),
		mainStatus: ctx.isIdle() ? "idle" : "working",
		mainActivity,
	};
}

class WorkflowDashboard implements Component {
	private data?: DashboardData;
	private selectedStepId?: string;
	private followCurrent = true;
	private detailScroll = 0;
	private maxDetailScroll = 0;
	private timer?: Timer;
	private localRefreshing = false;
	private metricsRefreshing = false;
	private closed = false;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly ctx: ExtensionContext,
		private readonly tui: TUI,
		private readonly theme: ThemeLike,
		private readonly keybindings: KeybindingsLike,
		private readonly done: (value: undefined) => void,
	) {
		this.timer = ctx.setInterval(() => this.refresh(false), LIVE_REFRESH_MS);
		this.refresh(true);
	}

	private syncSelection(): void {
		if (!this.data) return;
		const currentExists = this.data.steps.some(step => step.id === this.data?.state.currentStep);
		const selectedExists = this.data.steps.some(step => step.id === this.selectedStepId);
		if (this.followCurrent && currentExists) this.selectedStepId = this.data.state.currentStep;
		else if (!selectedExists) this.selectedStepId = currentExists ? this.data.state.currentStep : this.data.steps[0]?.id;
	}

	private publish(files: DashboardFiles): void {
		this.data = {
			...files,
			metrics: metricsCache.data,
			metricsError: metricsCache.error,
			sessionUsage: sessionUsage.snapshot(),
		};
		this.syncSelection();
		this.requestRender();
	}

	private publishMetrics(): void {
		if (!this.data || this.closed) return;
		this.data = {
			...this.data,
			metrics: metricsCache.data,
			metricsError: metricsCache.error,
			sessionUsage: sessionUsage.snapshot(),
		};
		this.requestRender();
	}

	private async refreshLocal(): Promise<void> {
		if (this.localRefreshing || this.closed) return;
		this.localRefreshing = true;
		try {
			const files = await readDashboardFiles(this.ctx.cwd);
			if (!this.closed) this.publish(files);
		} finally {
			this.localRefreshing = false;
		}
	}

	private async refreshMetricsData(force: boolean): Promise<void> {
		if (this.metricsRefreshing || this.closed) return;
		this.metricsRefreshing = true;
		try {
			await refreshMetrics(this.pi, this.ctx.cwd, force);
			this.publishMetrics();
		} finally {
			this.metricsRefreshing = false;
		}
	}

	private refresh(forceMetrics: boolean): void {
		void this.refreshLocal();
		void this.refreshMetricsData(forceMetrics);
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.timer) this.ctx.clearTimer(this.timer);
		if (activePanel === this) activePanel = undefined;
		this.done(undefined);
	}

	private selectBy(delta: number): void {
		if (!this.data?.steps.length) return;
		const currentIndex = this.data.steps.findIndex(step => step.id === this.selectedStepId);
		const nextIndex = Math.min(this.data.steps.length - 1, Math.max(0, (currentIndex >= 0 ? currentIndex : 0) + delta));
		this.selectedStepId = this.data.steps[nextIndex].id;
		this.followCurrent = false;
		this.detailScroll = 0;
	}

	private selectBoundary(last: boolean): void {
		if (!this.data?.steps.length) return;
		this.selectedStepId = this.data.steps[last ? this.data.steps.length - 1 : 0].id;
		this.followCurrent = false;
		this.detailScroll = 0;
	}

	handleInput(data: string): void {
		if (
			this.keybindings.matches(data, "app.interrupt") ||
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.alt("w")) ||
			matchesKey(data, "q")
		) {
			this.close();
			return;
		}
		if (matchesKey(data, "o")) {
			void ompStats.open(this.pi, this.ctx);
			return;
		}
		if (matchesKey(data, "r")) {
			this.refresh(true);
			void ompStats.sync(true);
			return;
		}
		if (matchesKey(data, "c")) {
			if (this.data?.steps.some(step => step.id === this.data?.state.currentStep)) {
				this.selectedStepId = this.data.state.currentStep;
				this.followCurrent = true;
				this.detailScroll = 0;
			}
		} else if (matchesKey(data, Key.up)) this.selectBy(-1);
		else if (matchesKey(data, Key.down)) this.selectBy(1);
		else if (matchesKey(data, Key.home)) this.selectBoundary(false);
		else if (matchesKey(data, Key.end)) this.selectBoundary(true);
		else if (matchesKey(data, Key.pageUp)) this.detailScroll = Math.max(0, this.detailScroll - Math.max(4, Math.floor(this.tui.terminal.rows / 3)));
		else if (matchesKey(data, Key.pageDown)) this.detailScroll = Math.min(this.maxDetailScroll, this.detailScroll + Math.max(4, Math.floor(this.tui.terminal.rows / 3)));
		else return;
		this.requestRender();
	}

	render(width: number): readonly string[] {
		const panelWidth = Math.max(20, width);
		const bodyHeight = Math.max(8, this.tui.terminal.rows - 9);
		const statsLine: TextLine = { text: ompStats.panelRow(panelWidth), tone: ompStats.panelTone() };
		let rendered: TextLine[];
		if (!this.data) {
			const border = `+${"-".repeat(Math.max(0, panelWidth - 2))}+`;
			const content = "Loading plan and live workflow state…";
			rendered = [
				{ text: border, tone: "accent" },
				{ text: `|${content.slice(0, Math.max(0, panelWidth - 2)).padEnd(Math.max(0, panelWidth - 2))}|`, tone: "muted" },
				statsLine,
				{ text: border, tone: "accent" },
			];
		} else {
			const liveData = { ...this.data, sessionUsage: sessionUsage.snapshot() };
			const view = deriveDashboardViewModel(liveData, runtimeSnapshot(this.ctx), this.selectedStepId);
			const result = renderDashboard(view, panelWidth, Math.max(8, bodyHeight - 1), this.detailScroll);
			this.maxDetailScroll = result.maxDetailScroll;
			this.detailScroll = Math.min(this.detailScroll, this.maxDetailScroll);
			rendered = [...result.lines];
			rendered.splice(Math.max(0, rendered.length - 1), 0, statsLine);
		}
		return rendered.map(line => {
			if (line.tone === "warning") return this.theme.fg("warning", line.text);
			if (line.tone === "accent") return this.theme.fg("accent", line.text);
			if (line.tone === "muted") return this.theme.fg("muted", line.text);
			return line.text;
		});
	}

	invalidate(): void {}

	requestRender(): void {
		this.invalidate();
		this.tui.requestRender();
	}
}

function installLiveListeners(pi: ExtensionAPI): void {
	if (listenersInstalled) return;
	listenersInstalled = true;
	pi.events.on("task:subagent:progress", data => {
		const payload = data as {
			progress?: Partial<WorkerProgress> & { id?: string; agent?: string; status?: WorkerProgress["status"] };
		};
		const progress = payload.progress;
		if (!progress?.id || !progress.agent || !progress.status) return;
		const previous = liveWorkers.get(progress.id);
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
		liveWorkers.set(worker.id, worker);
		sessionUsage.recordWorkerProgress(worker);
		activePanel?.requestRender();
	});
	pi.events.on("task:subagent:lifecycle", data => {
		const payload = data as { id?: string; agent?: string; status?: "started" | WorkerProgress["status"] };
		if (!payload.id || !payload.agent || !payload.status) return;
		const previous = liveWorkers.get(payload.id);
		liveWorkers.set(payload.id, {
			...(previous ?? {
				id: payload.id,
				agent: payload.agent,
				startedAt: Date.now(),
			}),
			status: payload.status === "started" ? "running" : payload.status,
			updatedAt: Date.now(),
		});
		if (["completed", "failed", "aborted"].includes(payload.status)) void ompStats.sync(false);
		activePanel?.requestRender();
	});
}

async function showDashboard(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	installLiveListeners(pi);
	ompStats.attach(ctx);
	void ompStats.start(ctx, false);
	await ctx.ui.custom<undefined>((tui, theme, keybindings, done) => {
		const panel = new WorkflowDashboard(pi, ctx, tui, theme, keybindings, done);
		activePanel = panel;
		return panel;
	});
}

export default function workflowDashboard(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		liveWorkers.clear();
		rebuildMainUsage(ctx);
		installLiveListeners(pi);
		ompStats.attach(ctx);
		ctx.ui.notify(`OMP Stats: ${ompStats.snapshot().url} (starting in background)`, "info");
		void ompStats.start(ctx, false).then(url => {
			if (url) void ompStats.sync(true);
			else ctx.ui.notify(`OMP Stats unavailable: ${ompStats.snapshot().error ?? "start failed"}`, "warning");
		});
	});
	pi.on("session_switch", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		liveWorkers.clear();
		rebuildMainUsage(ctx);
		ompStats.attach(ctx);
		void ompStats.start(ctx, false).then(url => {
			if (url) void ompStats.sync(false);
		});
		activePanel?.requestRender();
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		await ompStats.shutdown(ctx);
	});
	pi.on("turn_end", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const message = event.message as AssistantUsageMessage;
		sessionUsage.recordAssistantMessage(
			message,
			"orchestrator",
			`turn:${event.turnIndex}:${message.timestamp ?? 0}:${message.responseId ?? ""}`,
		);
		void ompStats.sync(false);
		activePanel?.requestRender();
	});
	pi.on("agent_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		mainActivity = "Planning and routing the next verified transition";
		activePanel?.requestRender();
	});
	pi.on("agent_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		mainActivity = "Ready for instruction or the next transition";
		activePanel?.requestRender();
	});
	pi.on("tool_execution_start", async (event, ctx) => {
		if (!ctx.hasUI) return;
		mainActivity = humanMainActivity(event.toolName);
		activePanel?.requestRender();
	});
	pi.on("tool_execution_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		mainActivity = currentWorker()
			? "Supervising the active worker"
			: "Verifying evidence and selecting the next transition";
		activePanel?.requestRender();
	});

	pi.registerCommand("workflow-dashboard", {
		description: "Open the live PLAN | CURRENT | STATISTICS workflow dashboard",
		handler: async (_args, ctx) => showDashboard(pi, ctx),
	});
	pi.registerCommand("workflow-stats", {
		description: "Open the local OMP observability dashboard in the default browser",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			await ompStats.open(pi, ctx);
		},
	});
	pi.registerShortcut(Key.alt("w"), {
		description: "Open Pavan's live workflow dashboard",
		handler: async ctx => showDashboard(pi, ctx),
	});
}
