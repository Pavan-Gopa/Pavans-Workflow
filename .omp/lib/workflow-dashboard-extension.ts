import { access } from "node:fs/promises";
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

async function experimentInstalled(cwd: string): Promise<boolean> {
	try {
		await access(`${cwd}/.omp/workflow-context-policy.json`);
		return true;
	} catch {
		return false;
	}
}

async function runExperimentAction(pi: ExtensionAPI, action: string, ctx: ExtensionContext): Promise<void> {
	const allowed = ["status", "doctor", "update", "rollback"];
	const normalized = allowed.includes(action) ? action : "status";
	if (normalized === "rollback") {
		const confirmed = await ctx.ui.confirm(
			"Roll back context-economy experiment?",
			"Restore the pre-experiment workflow overlay and managed config/keybinding sections. Product files and live workflow state are preserved.",
		);
		if (!confirmed) return;
	}
	const result = await pi.exec("bash", ["AI_Workflow_Kit/script/workflow_experiment.sh", normalized], {
		cwd: ctx.cwd,
		timeout: 300_000,
	});
	ctx.ui.notify(
		(result.code === 0 ? result.stdout : result.stderr || result.stdout).trim() || `Experiment action exited ${result.code}`,
		result.code === 0 ? "info" : "error",
	);
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
			const routing = deriveRoutingExplanation(files.state, runtimeSnapshot(ctx));
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
		const tokens = args.trim().split(/\s+/).filter(Boolean);
		if (await experimentInstalled(ctx.cwd)) {
			await runExperimentAction(pi, tokens.includes("check") ? "status" : "update", ctx);
			return;
		}
		const updater = ["AI_Workflow_Kit/script/workflow_update.sh", tokens.includes("check") ? "check" : "apply"];
		if (tokens.includes("--refresh-graphify")) updater.push("--refresh-graphify");
		ctx.ui.notify("Updating workflow framework...", "info");
		const result = await pi.exec("bash", updater, { cwd: ctx.cwd, timeout: 300_000 });
		ctx.ui.notify(
			(result.code === 0 ? result.stdout : result.stderr || result.stdout).trim() || `Update exited ${result.code}`,
			result.code === 0 ? "info" : "error",
		);
	};
	pi.registerCommand("workflow-update", { description: "Safely update workflow framework", handler: update });
	pi.registerCommand("work-update", { description: "Fast workflow update alias", handler: update });

	pi.registerCommand("workflow-experiment", {
		description: "Manage the context-economy experiment: status, doctor, update, rollback",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			await runExperimentAction(pi, args.trim() || "status", ctx);
		},
	});
}
