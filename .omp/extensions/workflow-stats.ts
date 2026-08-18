// Manual OMP Stats integration for Pavan's Workflow v3.
//
// The extension intentionally does nothing on session start, session switch,
// Main turns, or subagent lifecycle events. Stats is launched only by an
// explicit Human action: `/workflow-stats` or `o` in the Alt+W dashboard.
// No persistent below-editor widget is installed.

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getStatsRuntime } from "../lib/workflow-stats-runtime.ts";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function startAndOpen(ctx: ExtensionContext): Promise<void> {
	const runtime = getStatsRuntime(ctx.cwd);
	try {
		if (ctx.hasUI) ctx.ui.notify(`Starting OMP Stats on ${runtime.controller.url}…`, "info");
		let state = await runtime.controller.ensureStarted(true);
		if (state.status !== "ready" && state.status !== "sync-warning") {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`OMP Stats unavailable: ${state.error ?? "unknown error"}. The workflow itself is unaffected.`,
					"error",
				);
			}
			return;
		}
		state = await runtime.controller.requestSync(true);
		const url = state.url ?? runtime.controller.url;
		const opened = await runtime.openInBrowser(url);
		if (ctx.hasUI) {
			ctx.ui.notify(
				opened
					? `OMP Stats opened: ${url}`
					: `OMP Stats is running. Open this URL manually: ${url}`,
				"info",
			);
		}
	} catch (error) {
		if (ctx.hasUI) ctx.ui.notify(`OMP Stats command failed: ${errorMessage(error)}`, "error");
	}
}

export default function workflowStats(pi: ExtensionAPI): void {
	pi.registerCommand("workflow-stats", {
		description: "Explicitly start, sync, and open the local OMP Stats dashboard",
		handler: async (_args, ctx) => startAndOpen(ctx),
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Stops only a server explicitly started by this workflow process.
		getStatsRuntime(ctx.cwd).controller.shutdown();
	});
}
