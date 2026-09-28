// Pure decision logic for the workflow-guard extension. Dependency-free so the
// selftest runs without OMP. The extension wires these into OMP hooks:
//   before_subagent_spawn   -> backup authorization + guard snapshot (keyed by spawnKey)
//   task:subagent:lifecycle -> bind on `started` (snapshot follow-up turns), verify on finish
//   tool_call (Main only)   -> remember Main's own edits so they are not blamed on the worker

import { normalizeRole, parseWorkflowState } from "./workflow-dashboard-core.ts";

export const GUARD_SCRIPT = "AI_Workflow_Kit/script/workflow_guard.py";
export const GUARD_MESSAGE_TYPE = "workflow-guard";
export const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted", "cancelled", "canceled", "error"]);

export function isWorkflowAgent(agent: string | undefined): boolean {
	return Boolean(agent && /^workflow[-_]/i.test(agent));
}

export function isBackupAgent(agent: string | undefined): boolean {
	return Boolean(agent && /[-_]backup$/i.test(agent));
}

/**
 * The guard extension also runs inside every worker session. Main is the
 * top-level session in every mode (TUI, RPC, print); `hasUI` only says whether
 * a UI is attached, so it decides only on hosts without agent identity.
 */
export function isMainSession(agent: { kind: string } | undefined, hasUI: boolean): boolean {
	return agent ? agent.kind === "main" : hasUI;
}

/** Guard role for an agent name; non-workflow agents are checked as read-only "unknown". */
export function guardRole(agent: string): string {
	if (!isWorkflowAgent(agent)) return "unknown";
	const role = normalizeRole(agent)?.replace(/-/g, "_");
	return role ?? "unknown";
}

export type BackupDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * A `-backup` worker may start only after the Human authorized it and Main
 * recorded that in STATE.yaml (TEAM_CONTRACT: automatic backup selection is
 * forbidden). Enforced in code at spawn time, not by prompt.
 */
export function backupAuthorization(stateText: string, agent: string): BackupDecision {
	if (!isBackupAgent(agent)) return { allowed: true };
	const state = parseWorkflowState(stateText);
	const recordedAgent = state.modelFailureBackupAgent === "-" ? "" : state.modelFailureBackupAgent;
	const canonical = (value: string | undefined) => value?.replace(/_/g, "-");
	const recordedRole = canonical(normalizeRole(state.modelFailureRole === "-" ? undefined : state.modelFailureRole));
	const role = canonical(normalizeRole(agent));
	const matches = recordedAgent ? recordedAgent === agent : Boolean(recordedRole && recordedRole === role);
	if (state.modelFailureStatus === "backup_authorized" && matches) return { allowed: true };
	return {
		allowed: false,
		reason:
			`${agent} needs explicit Human authorization. Record the primary failure and the Human's words in STATE.yaml ` +
			`(omp.model_failure.status: backup_authorized, backup_agent: ${agent}, human_instruction: "...") before dispatch.`,
	};
}

type OpenSnapshot = { snapshotId: string; agent: string; spawnKey?: string; runId?: string; openedAt: number };

/**
 * Open guard snapshots. A snapshot is taken at spawn time (keyed by OMP's
 * spawnKey, which equals the async job id), bound to the worker's lifecycle id
 * on `started`, and verified on the terminal lifecycle event. Workers woken
 * again with `agent://<id>` (no spawn hook) get a snapshot on `started`.
 */
export class GuardTracker {
	#open: OpenSnapshot[] = [];
	#mainTouched = new Set<string>();

	open(agent: string, snapshotId: string, spawnKey?: string, now = Date.now()): void {
		this.#open.push({ snapshotId, agent, spawnKey, openedAt: now });
	}

	/**
	 * Bind a started worker to its snapshot. Returns true when a snapshot is
	 * bound, false when the caller must take one (follow-up turn). Older unbound
	 * snapshots of the same agent belong to spawns that never started (aborted
	 * or blocked before running) and are dropped.
	 */
	bind(runId: string, agent: string): boolean {
		if (this.#open.some(entry => entry.runId === runId)) return true;
		const byKey = this.#open.find(entry => !entry.runId && entry.spawnKey === runId);
		const candidates = this.#open.filter(entry => !entry.runId && entry.agent === agent);
		const chosen = byKey ?? candidates[candidates.length - 1];
		if (!chosen) return false;
		chosen.runId = runId;
		this.#open = this.#open.filter(entry => entry === chosen || entry.runId || entry.agent !== agent || entry.openedAt > chosen.openedAt);
		return true;
	}

	/** Snapshot to verify for a finished run (bound id, then spawn key, then oldest of the agent). */
	close(runId: string | undefined, agent: string): string | undefined {
		const index = [
			this.#open.findIndex(entry => runId !== undefined && entry.runId === runId),
			this.#open.findIndex(entry => runId !== undefined && !entry.runId && entry.spawnKey === runId),
			this.#open.findIndex(entry => !entry.runId && entry.agent === agent),
		].find(value => value >= 0);
		if (index === undefined) return undefined;
		const [entry] = this.#open.splice(index, 1);
		return entry.snapshotId;
	}

	active(): boolean {
		return this.#open.length > 0;
	}

	recordMainEdit(path: string | undefined): void {
		if (path && this.active()) this.#mainTouched.add(path);
	}

	/** Paths Main edited while workers ran; cleared once no worker remains open. */
	takeMainEdits(): string[] {
		const paths = [...this.#mainTouched];
		if (!this.active()) this.#mainTouched.clear();
		return paths;
	}
}

const HASHLINE_HEADER = /^\[(.+?)(?:#[0-9A-Fa-f]{4})?\]\s*$/;
const HASHLINE_MOVE = /^MV\s+(.+?)\s*$/;
const APPLY_PATCH_FILE = /^\*\*\* (?:Update|Add|Delete) File:\s*(.+?)\s*$/;
const APPLY_PATCH_MOVE = /^\*\*\* Move to:\s*(.+?)\s*$/;

function unquote(value: string): string {
	const text = value.trim();
	return text.length >= 2 && (text[0] === '"' || text[0] === "'") && text[0] === text[text.length - 1] ? text.slice(1, -1) : text;
}

/**
 * Paths an edit/write call touches, for every OMP edit mode: replace/patch
 * (`path`, `edits[].path|rename`) and the `input` text modes (hashline
 * `[path#TAG]` / `MV dest`, apply_patch `*** Update File: path`).
 */
export function editedPaths(toolName: string, input: unknown): string[] {
	if (toolName !== "edit" && toolName !== "write") return [];
	const record = (input ?? {}) as { path?: unknown; edits?: Array<{ path?: unknown; rename?: unknown }>; input?: unknown };
	const paths = new Set<string>();
	if (typeof record.path === "string") paths.add(record.path);
	for (const edit of Array.isArray(record.edits) ? record.edits : []) {
		if (typeof edit?.path === "string") paths.add(edit.path);
		if (typeof edit?.rename === "string") paths.add(edit.rename);
	}
	if (typeof record.input === "string") {
		for (const rawLine of record.input.replace(/^\uFEFF/, "").split("\n")) {
			const line = rawLine.replace(/\r$/, "");
			const match = HASHLINE_HEADER.exec(line) ?? HASHLINE_MOVE.exec(line) ?? APPLY_PATCH_FILE.exec(line) ?? APPLY_PATCH_MOVE.exec(line);
			if (match) paths.add(unquote(match[1]));
		}
	}
	return [...paths];
}

export type GuardVerdict = {
	id?: string;
	role?: string;
	agent?: string | null;
	step?: string | null;
	verdict?: string;
	violations?: Array<{ path: string; reason: string }>;
	notes?: string[];
	changed?: string[];
};

export function parseVerdict(stdout: string): GuardVerdict | undefined {
	try {
		const parsed = JSON.parse(stdout) as GuardVerdict;
		return parsed && typeof parsed === "object" && typeof parsed.verdict === "string" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Message injected into Main's context; undefined when there is nothing to act on. */
export function guardMessage(verdict: GuardVerdict): string | undefined {
	const who = `${verdict.agent ?? verdict.role ?? "worker"} (step ${verdict.step ?? "-"})`;
	if (verdict.verdict === "clean") {
		const notes = verdict.notes ?? [];
		return notes.length ? [`WORKFLOW GUARD — note on ${who}:`, ...notes.map(note => `- ${note}`)].join("\n") : undefined;
	}
	if (verdict.verdict === "violation") {
		const lines = (verdict.violations ?? []).slice(0, 12).map(item => `- ${item.path}: ${item.reason}`);
		return [
			`WORKFLOW GUARD — boundary violation by ${who}. Do not accept this worker result.`,
			...lines,
			"Record the violation, restore or quarantine the listed changes with the Human, and re-dispatch a fresh worker.",
			`Details: python3 ${GUARD_SCRIPT} status --step ${verdict.step ?? "<step>"}`,
		].join("\n");
	}
	if (verdict.verdict === "unscoped") {
		return [
			`WORKFLOW GUARD — ${who} changed files while STATE.yaml target_files was empty, so its scope could not be verified.`,
			`Changed: ${(verdict.changed ?? []).join(", ") || "-"}`,
			"Verify the diff manually; a quick close is refused until target_files is recorded before dispatch.",
		].join("\n");
	}
	return undefined;
}
