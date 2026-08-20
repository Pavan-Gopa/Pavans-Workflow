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

export async function startAndOpenStats(ctx: ExtensionContext): Promise<void> {
	const runtime = getStatsRuntime(ctx.cwd);
	const url = runtime.controller.url;
	try {
		if (ctx.hasUI) ctx.ui.notify(`Starting OMP Stats on ${url}…`, "info");
		const opened = await runtime.openInBrowser(url);
		const state = runtime.controller.snapshot;
		if (state.status !== "ready") {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`OMP Stats unavailable: ${state.error ?? "unknown error"}. The workflow itself is unaffected.`,
					"error",
				);
			}
			return;
		}
		if (ctx.hasUI) {
			ctx.ui.notify(
				opened
					? `OMP Stats opened: ${state.url}`
					: `OMP Stats is running. Open this URL manually: ${state.url}`,
				"info",
			);
		}
	} catch (error) {
		if (ctx.hasUI) ctx.ui.notify(`OMP Stats command failed: ${errorMessage(error)}`, "error");
	}
}

export default function workflowStats(pi: ExtensionAPI): void {
	pi.registerCommand("workflow-stats", {
		description: "Explicitly sync, start, and open the native OMP Stats dashboard",
		handler: async (_args, ctx) => startAndOpenStats(ctx),
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Stops only the native server handle owned/reused by this workflow process.
		getStatsRuntime(ctx.cwd).controller.shutdown();
	});
}
