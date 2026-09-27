import { access, readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	backupAuthorization,
	editedPaths,
	GUARD_MESSAGE_TYPE,
	GUARD_SCRIPT,
	GuardTracker,
	guardMessage,
	guardRole,
	parseVerdict,
	TERMINAL_STATUSES,
} from "../lib/workflow-guard.ts";

const STATE_PATH = "AI_Workflow_Kit/docs/AI/STATE.yaml";
const INSTALL_RECORD = "AI_Workflow_Kit/installed.manifest";
const tracker = new GuardTracker();
let parentContext: ExtensionContext | undefined;
let listenerInstalled = false;
let degradedNotified = false;

function notify(message: string, level: "info" | "warning" | "error"): void {
	if (parentContext?.hasUI) parentContext.ui.notify(message, level);
}

function degraded(pi: ExtensionAPI, message: string): void {
	pi.logger.warn(`[workflow-guard] ${message}`);
	if (degradedNotified) return;
	degradedNotified = true;
	notify(`Workflow guard unavailable: ${message}. Worker boundaries are not being verified.`, "warning");
}

async function snapshot(pi: ExtensionAPI, cwd: string, agent: string, spawnKey?: string, runId?: string): Promise<void> {
	const result = await pi.exec(
		"python3",
		[GUARD_SCRIPT, "snapshot", "--role", guardRole(agent), "--agent", agent, "--json"],
		{ cwd, timeout: 20_000 },
	);
	try {
		const payload = JSON.parse(result.stdout) as { id?: string };
		if (result.code !== 0 || !payload.id) throw new Error("no snapshot id");
		tracker.open(agent, payload.id, spawnKey);
		if (runId) tracker.bind(runId, agent);
	} catch {
		degraded(pi, (result.stderr || result.stdout).trim() || `snapshot exited ${result.code}`);
	}
}

async function verify(pi: ExtensionAPI, runId: string | undefined, agent: string): Promise<void> {
	const snapshotId = tracker.close(runId, agent);
	if (!snapshotId || !parentContext) return;
	const args = [GUARD_SCRIPT, "verify", "--id", snapshotId, "--json"];
	for (const path of tracker.takeMainEdits()) args.push("--exempt", path);
	const result = await pi.exec("python3", args, { cwd: parentContext.cwd, timeout: 30_000 });
	const verdict = parseVerdict(result.stdout);
	if (!verdict) {
		degraded(pi, (result.stderr || result.stdout).trim() || `verify exited ${result.code}`);
		return;
	}
	const message = guardMessage(verdict);
	if (!message) return;
	notify(message.split("\n")[0], verdict.verdict === "violation" ? "error" : "warning");
	pi.sendMessage(
		{ customType: GUARD_MESSAGE_TYPE, content: message, display: true, details: verdict },
		{ deliverAs: "aside" },
	);
}

/** Lifecycle events arrive on the parent (Main) session's event bus. */
function installLifecycleListener(pi: ExtensionAPI): void {
	if (listenerInstalled) return;
	listenerInstalled = true;
	pi.events.on("task:subagent:lifecycle", data => {
		const payload = data as { id?: string; agent?: string; status?: string };
		if (!payload.agent || !payload.status || !parentContext) return;
		const agent = payload.agent;
		const cwd = parentContext.cwd;
		const run = async () => {
			if (payload.status === "started" && payload.id && !tracker.bind(payload.id, agent)) {
				// A parked worker woken with agent://<id>: no spawn hook fired.
				await snapshot(pi, cwd, agent, undefined, payload.id);
			} else if (TERMINAL_STATUSES.has(payload.status ?? "")) {
				await verify(pi, payload.id, agent);
			}
		};
		void run().catch(error => degraded(pi, error instanceof Error ? error.message : String(error)));
	});
}

export default function workflowGuard(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		parentContext = ctx;
		installLifecycleListener(pi);
		try {
			await access(`${ctx.cwd}/${INSTALL_RECORD}`);
		} catch {
			try {
				await access(`${ctx.cwd}/${STATE_PATH}`);
				ctx.ui.notify(
					"Workflow update incomplete: AI_Workflow_Kit/installed.manifest is missing. Run: bash AI_Workflow_Kit/script/workflow_update.sh apply",
					"warning",
				);
			} catch {
				// Not a workflow project.
			}
		}
	});

	// Fires in the parent (Main) session before a worker's model is resolved.
	pi.on("before_subagent_spawn", async (event, ctx) => {
		parentContext ??= ctx;
		installLifecycleListener(pi);
		let stateText = "";
		try {
			stateText = await readFile(`${ctx.cwd}/${STATE_PATH}`, "utf8");
		} catch {
			// No workflow state (e.g. outside a workflow project): nothing to authorize.
		}
		const authorization = backupAuthorization(stateText, event.agent);
		if (!authorization.allowed) return { block: true, reason: authorization.reason };
		await snapshot(pi, ctx.cwd, event.agent, event.spawnKey);
		return undefined;
	});

	// Main's own edits during a worker run are Main's, not the worker's.
	pi.on("tool_call", async (event, ctx) => {
		if (!ctx.hasUI || !tracker.active()) return undefined;
		for (const path of editedPaths(event.toolName, event.input)) tracker.recordMainEdit(path);
		return undefined;
	});
}
