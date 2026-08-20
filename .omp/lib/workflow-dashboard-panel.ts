import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Component, OverlayOptions, TUI } from "@oh-my-pi/pi-tui";
import { Key, matchesKey, routeSgrMouseInput, ScrollView } from "@oh-my-pi/pi-tui";
import {
	deriveDashboardViewModel,
	type DashboardData,
	type TextLine,
	type TodoViewMode,
} from "./workflow-dashboard-core.ts";
import { checkWorkflowConsistency, type ConsistencyFinding } from "./workflow-consistency.ts";
import { applyLiveStep, type LiveStepResolution } from "./workflow-live-step.ts";
import { linkRuntimeTodo, readRuntimeTodo } from "./workflow-runtime-todo.ts";
import { getStatsRuntime } from "./workflow-stats-runtime.ts";
import { renderExpandedDashboard } from "./workflow-dashboard-viewport.ts";
import {
	hubActiveAgentConsistent,
	makeDashboardData,
	metricsFetchedAt,
	readDashboardFiles,
	refreshMetrics,
	runtimeSnapshot,
	type DashboardFiles,
} from "./workflow-dashboard-data.ts";

const LIVE_REFRESH_MS = 1_000;
const MOUSE_SCROLL_LINES = 3;

/**
 * Alt+W must be a real fullscreen overlay. OMP enables SGR mouse reporting only
 * for fullscreen overlays, so mounting this dashboard as ordinary custom editor
 * content would draw a scrollbar without ever receiving wheel events.
 */
export const DASHBOARD_OVERLAY_OPTIONS: OverlayOptions = {
	fullscreen: true,
	mouseTracking: true,
	anchor: "top-left",
	width: "100%",
	height: "100%",
};

type ThemeTone = "accent" | "muted" | "warning";
type ThemeLike = { fg: (tone: ThemeTone, text: string) => string };
type KeybindingsLike = { matches: (data: string, action: string) => boolean };

let activePanel: WorkflowDashboard | undefined;
export const requestDashboardRender = (): void => activePanel?.requestRender();

function recoveredFinding(resolution: LiveStepResolution, raw: string): ConsistencyFinding | undefined {
	if (!resolution.id || resolution.source === "state" || resolution.id === raw) return undefined;
	return {
		code: "live_step_recovered",
		severity: "warn",
		message: `live step ${resolution.id} recovered from ${resolution.source}; STATE current_step is ${raw}`,
	};
}

class WorkflowDashboard implements Component {
	private data?: DashboardData & DashboardFiles;
	private selectedStepId?: string;
	private liveStepId?: string;
	private followLive = true;
	private revealSelection = true;
	private timer?: Timer;
	private refreshingFiles = false;
	private refreshingMetrics = false;
	private closed = false;
	private todoMode?: TodoViewMode;
	private layout: "wide" | "medium" | "narrow" = "wide";
	private showHelp = false;
	private readonly viewport: ScrollView;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly ctx: ExtensionContext,
		private readonly tui: TUI,
		private readonly theme: ThemeLike,
		private readonly keybindings: KeybindingsLike,
		private readonly done: (value: undefined) => void,
	) {
		this.viewport = new ScrollView([], {
			height: Math.max(6, tui.terminal.rows),
			scrollbar: "auto",
			fastScrollLines: 5,
			theme: {
				track: text => theme.fg("muted", text),
				thumb: text => theme.fg("accent", text),
			},
		});
		this.timer = ctx.setInterval(() => this.refresh(false), LIVE_REFRESH_MS);
		this.refresh(true);
	}

	private syncSelection(fallback?: string): void {
		if (!this.data) return;
		const live = this.liveStepId ?? fallback ?? this.data.state.currentStep;
		const hasLive = this.data.steps.some(step => step.id === live);
		const hasSelected = this.data.steps.some(step => step.id === this.selectedStepId);
		if (this.followLive && hasLive) {
			if (this.selectedStepId !== live) this.revealSelection = true;
			this.selectedStepId = live;
		} else if (!hasSelected) {
			this.selectedStepId = hasLive ? live : this.data.steps[0]?.id;
			this.revealSelection = true;
		}
	}

	private publish(files: DashboardFiles): void {
		this.data = makeDashboardData(files);
		this.syncSelection(files.state.currentStep);
		this.requestRender();
	}

	private async refreshFiles(): Promise<void> {
		if (this.refreshingFiles || this.closed) return;
		this.refreshingFiles = true;
		try {
			const files = await readDashboardFiles(this.ctx.cwd);
			if (!this.closed) this.publish(files);
		} finally {
			this.refreshingFiles = false;
		}
	}

	private async refreshMetricsData(force: boolean): Promise<void> {
		if (this.refreshingMetrics || this.closed) return;
		this.refreshingMetrics = true;
		try {
			await refreshMetrics(this.pi, this.ctx.cwd, force);
			if (this.data && !this.closed) this.publish(this.data);
		} finally {
			this.refreshingMetrics = false;
		}
	}

	private refresh(forceMetrics: boolean): void {
		void this.refreshFiles();
		void this.refreshMetricsData(forceMetrics);
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.timer) this.ctx.clearTimer(this.timer);
		if (activePanel === this) activePanel = undefined;
		this.done(undefined);
	}

	private move(delta: number): void {
		if (!this.data?.steps.length) return;
		const current = this.data.steps.findIndex(step => step.id === this.selectedStepId);
		const index = Math.min(this.data.steps.length - 1, Math.max(0, (current < 0 ? 0 : current) + delta));
		this.selectedStepId = this.data.steps[index].id;
		this.followLive = false;
		this.revealSelection = true;
	}

	private boundary(last: boolean): void {
		if (!this.data?.steps.length) return;
		this.selectedStepId = this.data.steps[last ? this.data.steps.length - 1 : 0].id;
		this.followLive = false;
		this.revealSelection = true;
	}

	private manualScroll(action: () => void): void {
		this.followLive = false;
		this.revealSelection = false;
		action();
		this.requestRender();
	}

	private revealSelected(lines: TextLine[], viewportHeight: number): void {
		if (!this.revealSelection || !this.selectedStepId) return;
		const needle = ` ${this.selectedStepId} `;
		const row = lines.findIndex(line => line.text.includes(needle));
		if (row >= 0) {
			const margin = Math.min(3, Math.max(0, Math.floor(viewportHeight / 4)));
			const top = this.viewport.getScrollOffset();
			const bottom = top + viewportHeight - 1;
			if (row < top + margin) this.viewport.setScrollOffset(Math.max(0, row - margin));
			else if (row > bottom - margin) this.viewport.setScrollOffset(row - viewportHeight + margin + 1);
		}
		this.revealSelection = false;
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				if (event.wheel !== null) {
					this.manualScroll(() => this.viewport.scroll(event.wheel * MOUSE_SCROLL_LINES));
					return true;
				}
				return false;
			});
			return;
		}
		if (
			this.keybindings.matches(data, "app.interrupt") ||
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.alt("w")) ||
			matchesKey(data, "q")
		) return this.close();
		if (matchesKey(data, "r")) return this.refresh(true);
		if (matchesKey(data, "o")) {
			const stats = getStatsRuntime(this.ctx.cwd);
			void stats.openInBrowser(stats.controller.url).then(opened => {
				if (!opened) this.ctx.ui.notify(`Open OMP Stats manually: ${stats.controller.url}`, "warning");
			});
			return;
		}
		if (matchesKey(data, "t")) {
			const mode = this.todoMode ?? (this.layout === "wide" ? "both" : "step");
			this.todoMode = mode === "both" ? "step" : mode === "step" ? "run" : "both";
			return this.requestRender();
		}
		if (matchesKey(data, "?")) {
			this.showHelp = !this.showHelp;
			return this.requestRender();
		}
		if (matchesKey(data, "c")) {
			const live = this.liveStepId ?? this.data?.state.currentStep;
			if (live && this.data?.steps.some(step => step.id === live)) {
				this.selectedStepId = live;
				this.followLive = true;
				this.revealSelection = true;
			}
		} else if (matchesKey(data, Key.up)) this.move(-1);
		else if (matchesKey(data, Key.down)) this.move(1);
		else if (matchesKey(data, Key.home)) this.boundary(false);
		else if (matchesKey(data, Key.end)) this.boundary(true);
		else if (matchesKey(data, "shift+up")) return this.manualScroll(() => this.viewport.scroll(-5));
		else if (matchesKey(data, "shift+down")) return this.manualScroll(() => this.viewport.scroll(5));
		else if (matchesKey(data, Key.pageUp)) return this.manualScroll(() => this.viewport.page(-1));
		else if (matchesKey(data, Key.pageDown)) return this.manualScroll(() => this.viewport.page(1));
		else if (matchesKey(data, "g")) return this.manualScroll(() => this.viewport.scrollToTop());
		else if (matchesKey(data, "shift+g")) return this.manualScroll(() => this.viewport.scrollToBottom());
		else return;
		this.requestRender();
	}

	render(width: number): readonly string[] {
		const panelWidth = Math.max(20, width);
		const viewportHeight = Math.max(6, this.tui.terminal.rows);
		const naturalBodyHeight = Math.max(8, viewportHeight - 8);
		let lines: TextLine[];
		if (!this.data) {
			const border = `+${"-".repeat(panelWidth - 2)}+`;
			lines = [
				{ text: border, tone: "accent" },
				{ text: `|${"Loading plan and live workflow state…".padEnd(panelWidth - 2)}|`, tone: "muted" },
				{ text: border, tone: "accent" },
			];
		} else {
			const runtime = runtimeSnapshot(this.ctx);
			const runtimeTodo = readRuntimeTodo(this.ctx.sessionManager.getBranch());
			const raw: DashboardData = {
				...this.data,
				runtimeTodo,
				freshness: {
					stateMtime: this.data.stateMtime,
					stepsMtime: this.data.stepsMtime,
					metricsFetchedAt: metricsFetchedAt(),
					now: Date.now(),
				},
			};
			const applied = applyLiveStep(raw, runtime);
			this.liveStepId = applied.resolution.id;
			this.syncSelection(applied.resolution.id);
			const findings = checkWorkflowConsistency({
				state: this.data.state,
				steps: this.data.steps,
				runtimeTodo,
				hubActiveAgentConsistent: hubActiveAgentConsistent(this.data.state.activeAgent),
			});
			const recovered = recoveredFinding(applied.resolution, this.data.state.currentStep);
			if (recovered) findings.unshift(recovered);
			const liveData: DashboardData = {
				...applied.data,
				runtimeTodoLink: linkRuntimeTodo(runtimeTodo, applied.data.steps, applied.resolution.id),
				consistency: findings,
			};
			const view = deriveDashboardViewModel(liveData, runtime, this.selectedStepId, this.todoMode);
			const result = renderExpandedDashboard(
				view,
				panelWidth,
				naturalBodyHeight,
				getStatsRuntime(this.ctx.cwd).footerInfo(),
			);
			this.layout = result.layout;
			lines = result.lines.map(line => ({
				...line,
				text: line.text.replace("PgUp/PgDn details", "wheel/PgUp/PgDn scroll"),
			}));
			if (this.showHelp) {
				const help = "HELP: ↑/↓ step · wheel/PgUp/PgDn scroll · Shift+↑/↓ fast · g/G top/bottom · c live · t todo · r refresh · o Stats";
				lines.splice(2, 0, { text: `|${help.slice(0, panelWidth - 2).padEnd(panelWidth - 2)}|`, tone: "accent" });
			}
		}

		const styled = lines.map(line => {
			if (line.tone === "warning" || line.tone === "accent" || line.tone === "muted") {
				return this.theme.fg(line.tone, line.text);
			}
			return line.text;
		});
		this.viewport.setHeight(viewportHeight);
		this.viewport.setLines(styled);
		this.revealSelected(lines, viewportHeight);
		return this.viewport.render(panelWidth);
	}

	invalidate(): void {}
	requestRender(): void { this.tui.requestRender(); }
}

export async function showDashboard(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	await ctx.ui.custom<undefined>(
		(tui, theme, keybindings, done) => {
			const panel = new WorkflowDashboard(pi, ctx, tui, theme, keybindings, done);
			activePanel = panel;
			return panel;
		},
		{
			overlay: true,
			overlayOptions: DASHBOARD_OVERLAY_OPTIONS,
		},
	);
}
