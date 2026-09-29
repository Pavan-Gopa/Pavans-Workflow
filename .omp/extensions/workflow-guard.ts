import { access, readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	backupAuthorization,
	blockReason,
	editedPaths,
	type GitStateCommand,
	GUARD_MESSAGE_TYPE,
	GUARD_SCRIPT,
	GuardTracker,
	gitStateCommands,
	guardMessage,
	guardRole,
	isMainSession,
	isWorkerSession,
	isWorkflowAgent,
	lspWrite,
	parseAllow,
	parseVerdict,
	ShellWindows,
	TERMINAL_STATUSES,
	targetsSessionDirectory,
} from "../lib/workflow-guard.ts";

const STATE_PATH = "AI_Workflow_Kit/docs/AI/STATE.yaml";
const INSTALL_RECORD = "AI_Workflow_Kit/installed.manifest";
// OMP rebinds this factory to every subagent session without re-evaluating the
// module, so this state is shared by Main and the workers it runs in-process.
const tracker = new GuardTracker();
const shellWindows = new ShellWindows();
const repositoryIds = new Map<string, Promise<string | undefined>>();
let parentContext: ExtensionContext | undefined;
let listenerInstalled = false;
let degradedNotified = false;

type ExecResult = { code: number; stdout: string; stderr: string };

function notify(message: string, level: "info" | "warning" | "error"): void {
	if (parentContext?.hasUI) parentContext.ui.notify(message, level);
}

function degraded(pi: ExtensionAPI, message: string): void {
	pi.logger.warn(`[workflow-guard] ${message}`);
	if (degradedNotified) return;
	degradedNotified = true;
	notify(`Workflow guard unavailable: ${message}. Worker boundaries are not being checked.`, "warning");
}

/** pi.exec that never throws: OMP blocks a tool call whose handler throws, and a broken guard must not block work. */
async function run(pi: ExtensionAPI, command: string, args: string[], cwd: string, timeout: number): Promise<ExecResult> {
	try {
		return await pi.exec(command, args, { cwd, timeout });
	} catch (error) {
		return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}

async function snapshot(pi: ExtensionAPI, cwd: string, agent: string, spawnKey?: string, runId?: string): Promise<void> {
	const result = await run(pi, "python3", [GUARD_SCRIPT, "snapshot", "--role", guardRole(agent), "--agent", agent, "--json"], cwd, 20_000);
	try {
		const payload = JSON.parse(result.stdout) as { id?: string; skipped?: boolean };
		if (payload.skipped) return; // guard mode off
		if (result.code !== 0 || !payload.id) throw new Error("no snapshot id");
		tracker.open(agent, payload.id, spawnKey);
		if (runId) tracker.bind(runId, agent);
	} catch {
		degraded(pi, (result.stderr || result.stdout).trim() || `snapshot exited ${result.code}`);
	}
}

async function verify(pi: ExtensionAPI, runId: string | undefined, agent: string): Promise<void> {
	const snapshotId = tracker.close(runId, agent);
	const windows = shellWindows.take(runId);
	if (!snapshotId || !parentContext) return;
	const args = [GUARD_SCRIPT, "verify", "--id", snapshotId, "--json"];
	for (const path of tracker.takeMainEdits()) args.push(`--exempt=${path}`);
	for (const [start, end] of windows) args.push(`--window=${start}:${end}`);
	const result = await run(pi, "python3", args, parentContext.cwd, 30_000);
	const verdict = parseVerdict(result.stdout);
	if (!verdict) {
		degraded(pi, (result.stderr || result.stdout).trim() || `verify exited ${result.code}`);
		return;
	}
	const message = guardMessage(verdict);
	if (!message) return;
	const actionable = verdict.verdict === "violation" || verdict.verdict === "unscoped";
	notify(message.split("\n")[0], verdict.verdict === "violation" ? "error" : actionable ? "warning" : "info");
	// Violations and unscoped runs reach Main at its next step (and wake it when
	// idle); a note rides along with Main's next turn and never starts one.
	pi.sendMessage(
		{ customType: GUARD_MESSAGE_TYPE, content: message, display: true, details: verdict },
		{ deliverAs: actionable ? "aside" : "nextTurn" },
	);
}

/** The git common dir identifying a repository, or undefined when `args` do not name one. */
function repositoryId(pi: ExtensionAPI, args: string[], cwd: string): Promise<string | undefined> {
	const key = `${cwd}\0${args.join("\0")}`;
	let pending = repositoryIds.get(key);
	if (!pending) {
		pending = (async () => {
			for (const flags of [["--path-format=absolute", "--git-common-dir"], ["--absolute-git-dir"]]) {
				const result = await run(pi, "git", [...args, "rev-parse", ...flags], cwd, 5_000);
				if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
			}
			return undefined;
		})();
		// Only the session's own repository is stable enough to remember.
		if (args.length === 2 && args[0] === "-C" && args[1] === cwd) repositoryIds.set(key, pending);
	}
	return pending;
}

/** Whether a git state change targets the session's repository (fixture repositories elsewhere are fine). */
async function inSessionRepository(pi: ExtensionAPI, ctx: ExtensionContext, found: GitStateCommand): Promise<boolean> {
	if (targetsSessionDirectory(found, ctx.cwd)) return true;
	const ours = await repositoryId(pi, ["-C", ctx.cwd], ctx.cwd);
	if (!ours) return false;
	const theirs = found.gitDir
		? await repositoryId(pi, [`--git-dir=${found.gitDir}`], ctx.cwd)
		: found.dir
			? await repositoryId(pi, ["-C", found.dir], ctx.cwd)
			: undefined;
	return theirs === ours;
}

/** Ask the guard script whether a worker tool call may run. Fails open: a broken guard never blocks work. */
async function allow(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	tool: string,
	paths: string[],
	command: string | undefined,
	action: string | undefined,
): Promise<string | undefined> {
	const args = [GUARD_SCRIPT, "allow", `--agent=${ctx.agent.name}`, `--tool=${tool}`, `--base=${ctx.cwd}`, "--json"];
	const snapshotId = tracker.snapshotFor(ctx.agent.id);
	if (snapshotId) args.push(`--id=${snapshotId}`);
	for (const path of paths) args.push(`--path=${path}`);
	if (command) args.push(`--command=${command}`);
	if (action) args.push(`--action=${action}`);
	const result = await run(pi, "python3", args, ctx.cwd, 15_000);
	const decision = parseAllow(result.stdout);
	if (!decision) {
		degraded(pi, (result.stderr || result.stdout).trim() || `allow exited ${result.code}`);
		return undefined;
	}
	return decision.allowed ? undefined : blockReason(decision);
}

/** Lifecycle events arrive on the parent (Main) session's event bus. */
function installLifecycleListener(pi: ExtensionAPI): void {
	if (listenerInstalled) return;
	listenerInstalled = true;
	pi.events.on("task:subagent:lifecycle", data => {
		const payload = data as { id?: string; agent?: string; status?: string };
		if (!payload.agent || !payload.status || !parentContext || !isWorkflowAgent(payload.agent)) return;
		const agent = payload.agent;
		const cwd = parentContext.cwd;
		const handle = async () => {
			if (payload.status === "started" && payload.id && !tracker.bind(payload.id, agent)) {
				// A parked worker woken with agent://<id>: no spawn hook fired.
				await snapshot(pi, cwd, agent, undefined, payload.id);
			} else if (TERMINAL_STATUSES.has(payload.status ?? "")) {
				await verify(pi, payload.id, agent);
			}
		};
		void handle().catch(error => degraded(pi, error instanceof Error ? error.message : String(error)));
	});
}

export default function workflowGuard(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (!isMainSession(ctx.agent, ctx.hasUI)) return;
		parentContext = ctx;
		installLifecycleListener(pi);
		try {
			await access(`${ctx.cwd}/${INSTALL_RECORD}`);
		} catch {
			try {
				await access(`${ctx.cwd}/${STATE_PATH}`);
				notify(
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
		// OMP's own agents (scout, explore, task, ...) are Main's helpers, not workflow workers.
		if (isWorkflowAgent(event.agent)) await snapshot(pi, ctx.cwd, event.agent, event.spawnKey);
		return undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (isMainSession(ctx.agent, ctx.hasUI)) {
			// Main's own edits during a worker run are Main's, not the worker's.
			if (tracker.active()) for (const path of editedPaths(event.toolName, event.input)) tracker.recordMainEdit(path);
			return undefined;
		}
		if (!isWorkerSession(ctx.agent)) return undefined;
		// Inside a workflow worker: stop out-of-scope actions before they run.
		const lsp = lspWrite(event.toolName, event.input);
		const paths = lsp?.paths ?? editedPaths(event.toolName, event.input);
		let command: string | undefined;
		if (event.toolName === "bash") {
			const input = event.input as { command?: unknown; cwd?: unknown };
			if (typeof input.command === "string") {
				const bashCwd = typeof input.cwd === "string" && input.cwd ? input.cwd : undefined;
				for (const found of gitStateCommands(input.command, ctx.cwd, bashCwd)) {
					if (await inSessionRepository(pi, ctx, found)) {
						command = found.command;
						break;
					}
				}
			}
		}
		if (!paths.length && !command && !lsp) return undefined;
		const reason = await allow(pi, ctx, event.toolName, paths, command, lsp?.action);
		return reason ? { block: true, reason } : undefined;
	});

	// Windows of worker commands whose file writes the guard cannot attribute.
	const unattributedWriter = (toolName: string, args: unknown) => toolName === "bash" || Boolean(lspWrite(toolName, args));
	pi.on("tool_execution_start", async (event, ctx) => {
		if (isWorkerSession(ctx.agent) && unattributedWriter(event.toolName, event.args)) shellWindows.start(ctx.agent.id, event.toolCallId);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (isWorkerSession(ctx.agent)) shellWindows.end(event.toolCallId);
	});
}
