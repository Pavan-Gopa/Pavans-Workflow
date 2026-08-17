// OMP Stats observability panel: auto-launches (or reuses) the local OMP
// Stats dashboard on session start, keeps a persistent widget with the bare
// URL below the editor, syncs after lifecycle events, and exposes
// /workflow-stats for check/retry/sync/open. Stats failures never break the
// workflow: every controller call is swallowed into widget state.

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getStatsRuntime, STATS_WIDGET_KEY } from "../lib/workflow-stats-runtime.ts";

let listenersInstalled = false;
let widgetUnsubscribe: (() => void) | undefined;
let startAnnounced = false;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function installWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	widgetUnsubscribe?.();
	const runtime = getStatsRuntime(ctx.cwd);
	const apply = (): void => {
		const lines = runtime.widgetLines();
		if (lines.length === 0) ctx.ui.setWidget(STATS_WIDGET_KEY, undefined);
		else ctx.ui.setWidget(STATS_WIDGET_KEY, lines, { placement: "belowEditor" });
	};
	widgetUnsubscribe = runtime.subscribe(() => apply());
	apply();
}

function installListeners(pi: ExtensionAPI): void {
	if (listenersInstalled) return;
	listenersInstalled = true;
	// Sync after a subagent completes, fails, or is stopped.
	pi.events.on("task:subagent:lifecycle", data => {
		const payload = data as { status?: string };
		if (payload.status === "started") return;
		void getStatsRuntime().controller.requestSync();
	});
}

function startStats(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	installWidget(ctx);
	const runtime = getStatsRuntime(ctx.cwd);
	void runtime.controller.ensureStarted().then(state => {
		if (state.status === "ready" || state.status === "sync-warning") {
			void runtime.controller.requestSync();
			if (!startAnnounced) {
				startAnnounced = true;
				ctx.ui.notify(`OMP Stats ${state.status === "ready" ? "ready" : "ready (sync warning)"}: ${state.url}`, "info");
			}
		} else if (state.status === "unavailable" && state.error) {
			ctx.ui.notify(`OMP Stats unavailable: ${state.error}`, "warning");
		}
	});
}

export default function workflowStats(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		installListeners(pi);
		startStats(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		// The server is process-scoped; re-apply the widget for the new view.
		if (!ctx.hasUI) return;
		installWidget(ctx);
	});

	// Sync after the main orchestrator finishes a turn (throttled inside the
	// controller, so turn bursts cannot stack sync requests).
	pi.on("turn_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		void getStatsRuntime(ctx.cwd).controller.requestSync();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const runtime = getStatsRuntime(ctx.cwd);
		runtime.controller.shutdown();
		widgetUnsubscribe?.();
		widgetUnsubscribe = undefined;
		startAnnounced = false;
		if (ctx.hasUI) {
			try {
				ctx.ui.setWidget(STATS_WIDGET_KEY, undefined);
			} catch {
				// UI already torn down.
			}
		}
	});

	pi.registerCommand("workflow-stats", {
		description: "Check OMP Stats, retry launch if needed, sync, and open it in the browser",
		handler: async (_args, ctx) => {
			const runtime = getStatsRuntime(ctx.cwd);
			installWidget(ctx);
			try {
				let state = runtime.controller.snapshot;
				if (state.status !== "ready" && state.status !== "sync-warning") {
					if (ctx.hasUI) ctx.ui.notify("OMP Stats: checking server…", "info");
					state = await runtime.controller.ensureStarted(true);
				}
				if (state.status === "ready" || state.status === "sync-warning") {
					state = await runtime.controller.requestSync(true);
					const url = state.url ?? runtime.controller.url;
					const opened = await runtime.openInBrowser(url);
					if (ctx.hasUI) {
						ctx.ui.notify(
							opened
								? `OMP Stats opened in your browser: ${url}`
								: `OMP Stats is running, but no browser opener worked. Open it manually: ${url}`,
							"info",
						);
					}
					return;
				}
				if (ctx.hasUI) {
					ctx.ui.notify(`OMP Stats unavailable: ${state.error ?? "unknown error"}. Fix the cause and run /workflow-stats again.`, "error");
				}
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`OMP Stats command failed: ${errorMessage(error)}`, "error");
			}
		},
	});
}
