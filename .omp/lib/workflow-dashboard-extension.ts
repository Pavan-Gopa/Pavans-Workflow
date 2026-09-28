import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Key } from "@oh-my-pi/pi-tui";
import type { AssistantUsageMessage } from "./workflow-dashboard-core.ts";
import { deriveRoutingExplanation } from "./workflow-routing.ts";
import { installContextEconomy } from "./workflow-context-economy.ts";
import { installWorkflowContextSnapshot } from "./workflow-context-snapshot.ts";
import {
	clearWorkers,
	currentWorker,
	readDashboardFiles,
	rebuildMainUsage,
	recordMainTurn,
	recordWorkerLifecycle,
	recordWorkerProgress,
	runtimeSnapshot,
	setMainActivity,
	type WorkerProgress,
} from "./workflow-dashboard-data.ts";
import { requestDashboardRender, showDashboard } from "./workflow-dashboard-panel.ts";
import { UPDATE_TIMEOUT_MS, updaterInvocation } from "./workflow-update-command.ts";

let listenersInstalled = false;

function installListeners(pi: ExtensionAPI): void {
	if (listenersInstalled) return;
	listenersInstalled = true;
	pi.events.on("task:subagent:progress", data => {
		recordWorkerProgress((data as { progress?: Partial<WorkerProgress> }).progress ?? {});
		requestDashboardRender();
	});
	pi.events.on("task:subagent:lifecycle", data => {
		recordWorkerLifecycle(data as { id?: string; agent?: string; status?: "started" | WorkerProgress["status"] });
		requestDashboardRender();
	});
}

export default function workflowDashboard(pi: ExtensionAPI): void {
	installContextEconomy(pi);
	installWorkflowContextSnapshot(pi);
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		clearWorkers();
		rebuildMainUsage(ctx);
		installListeners(pi);
	});
	pi.on("session_switch", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		clearWorkers();
		rebuildMainUsage(ctx);
		requestDashboardRender();
	});
	pi.on("turn_end", async (event, ctx) => {
		if (!ctx.hasUI) return;
		recordMainTurn(event.message as AssistantUsageMessage, event.turnIndex);
		requestDashboardRender();
	});
	pi.on("agent_start", async () => {
		setMainActivity("Planning and routing the next verified transition");
		requestDashboardRender();
	});
	pi.on("agent_end", async () => {
		setMainActivity("Ready for instruction or the next transition");
		requestDashboardRender();
	});
	pi.on("tool_execution_start", async event => {
		setMainActivity(`Using ${event.toolName}`);
		requestDashboardRender();
	});
	pi.on("tool_execution_end", async () => {
		setMainActivity(currentWorker() ? "Supervising the active worker" : "Verifying evidence and selecting the next transition");
		requestDashboardRender();
	});
	pi.on("auto_compaction_start", async () => requestDashboardRender());
	pi.on("auto_compaction_end", async () => requestDashboardRender());
	pi.on("session_compact", async () => requestDashboardRender());

	pi.registerCommand("workflow-dashboard", {
		description: "Open the live PLAN | CURRENT | STATISTICS workflow dashboard",
		handler: async (_args, ctx) => showDashboard(pi, ctx),
	});
	pi.registerShortcut(Key.alt("w"), {
		description: "Open Pavan's live workflow dashboard",
		handler: async ctx => showDashboard(pi, ctx),
	});
	pi.registerCommand("workflow-why", {
		description: "Explain why the workflow selected the current step and next actor",
		handler: async (_args, ctx) => {
			const files = await readDashboardFiles(ctx.cwd);
			const current = files.steps.find(step => step.id === files.state.currentStep);
			const routing = deriveRoutingExplanation(files.state, runtimeSnapshot(ctx), current);
			ctx.ui.notify([
				`Current step: ${files.state.currentStep}`,
				`Current status: ${files.state.implementationStatus}`,
				`Next actor: ${routing.actorLabel ?? routing.actor ?? "Main"}`,
				"",
				`Action: ${routing.action}`,
				`Reason: ${routing.reason} (${routing.reasonCode})`,
			].join("\n"), "info");
		},
	});

	const update = async (args: string, ctx: ExtensionContext) => {
		const invocation = updaterInvocation(args);
		if (invocation.errors.length > 0) {
			ctx.ui.notify(`${invocation.errors.join("\n")}\nUsage: /workflow-update [check] [--ref <tag>] [--refresh-graphify]`, "error");
			return;
		}
		ctx.ui.notify(invocation.mode === "check" ? "Checking for workflow updates..." : "Updating workflow framework...", "info");
		const result = await pi.exec("bash", invocation.argv, { cwd: ctx.cwd, timeout: UPDATE_TIMEOUT_MS });
		ctx.ui.notify(
			(result.code === 0 ? result.stdout : result.stderr || result.stdout).trim() || `Update exited ${result.code}`,
			result.code === 0 ? "info" : "error",
		);
	};
	pi.registerCommand("workflow-update", { description: "Safely update workflow framework", handler: update });
	pi.registerCommand("work-update", { description: "Fast workflow update alias", handler: update });
}
