import { readFile } from "node:fs/promises";
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
const tracker = new GuardTracker();
let mainContext: ExtensionContext | undefined;
let listenerInstalled = false;
let degradedNotified = false;

function degraded(pi: ExtensionAPI, message: string): void {
	pi.logger.warn(`[workflow-guard] ${message}`);
	if (degradedNotified) return;
	degradedNotified = true;
	mainContext?.ui.notify(`Workflow guard unavailable: ${message}. Worker boundaries are not being verified.`, "warning");
}

async function verify(pi: ExtensionAPI, agent: string): Promise<void> {
	const snapshotId = tracker.close(agent);
	if (!snapshotId || !mainContext) return;
	const args = [GUARD_SCRIPT, "verify", "--id", snapshotId, "--json"];
	for (const path of tracker.takeMainEdits()) args.push("--exempt", path);
	const result = await pi.exec("python3", args, { cwd: mainContext.cwd, timeout: 30_000 });
	const verdict = parseVerdict(result.stdout);
	if (!verdict) {
		degraded(pi, (result.stderr || result.stdout).trim() || `verify exited ${result.code}`);
		return;
	}
	const message = guardMessage(verdict);
	if (!message) return;
	mainContext.ui.notify(message.split("\n")[0], verdict.verdict === "violation" ? "error" : "warning");
	pi.sendMessage(
		{ customType: GUARD_MESSAGE_TYPE, content: message, display: true, details: verdict },
		{ deliverAs: "aside" },
	);
}

export default function workflowGuard(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		mainContext = ctx;
		if (listenerInstalled) return;
		listenerInstalled = true;
		pi.events.on("task:subagent:lifecycle", data => {
			const payload = data as { agent?: string; status?: string };
			if (!payload.agent || !payload.status || !TERMINAL_STATUSES.has(payload.status)) return;
			void verify(pi, payload.agent).catch(error => degraded(pi, error instanceof Error ? error.message : String(error)));
		});
	});

	// Fires in the parent (Main) session before a worker's model is resolved.
	pi.on("before_subagent_spawn", async (event, ctx) => {
		let stateText = "";
		try {
			stateText = await readFile(`${ctx.cwd}/${STATE_PATH}`, "utf8");
		} catch {
			// No workflow state (e.g. outside a workflow project): nothing to authorize.
		}
		const authorization = backupAuthorization(stateText, event.agent);
		if (!authorization.allowed) return { block: true, reason: authorization.reason };

		const result = await pi.exec(
			"python3",
			[GUARD_SCRIPT, "snapshot", "--role", guardRole(event.agent), "--agent", event.agent, "--json"],
			{ cwd: ctx.cwd, timeout: 20_000 },
		);
		try {
			const snapshot = JSON.parse(result.stdout) as { id?: string };
			if (result.code === 0 && snapshot.id) tracker.open(event.agent, snapshot.id);
			else degraded(pi, (result.stderr || result.stdout).trim() || `snapshot exited ${result.code}`);
		} catch {
			degraded(pi, (result.stderr || result.stdout).trim() || `snapshot exited ${result.code}`);
		}
		return undefined;
	});

	// Main's own edits during a worker run are Main's, not the worker's.
	pi.on("tool_call", async (event, ctx) => {
		if (!ctx.hasUI || !tracker.active()) return undefined;
		for (const path of editedPaths(event.toolName, event.input)) tracker.recordMainEdit(path);
		return undefined;
	});
}
