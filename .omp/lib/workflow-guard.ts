// Pure decision logic for the workflow-guard extension. Dependency-free so the
// selftest runs without OMP. The extension wires these into OMP hooks:
//   before_subagent_spawn  -> backup authorization + guard snapshot
//   task:subagent:lifecycle -> guard verify when the worker finishes
//   tool_call (Main only)  -> remember Main's own edits so they are not blamed on the worker

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
	const recordedRole = normalizeRole(state.modelFailureRole === "-" ? undefined : state.modelFailureRole);
	const role = normalizeRole(agent);
	const matches = recordedAgent ? recordedAgent === agent : Boolean(recordedRole && recordedRole === role);
	if (state.modelFailureStatus === "backup_authorized" && matches) return { allowed: true };
	return {
		allowed: false,
		reason:
			`${agent} needs explicit Human authorization. Record the primary failure and the Human's words in STATE.yaml ` +
			`(omp.model_failure.status: backup_authorized, backup_agent: ${agent}, human_instruction: "...") before dispatch.`,
	};
}

/** FIFO of open guard snapshots per agent name (workflow runs one worker at a time). */
export class GuardTracker {
	#pending = new Map<string, string[]>();
	#mainTouched = new Set<string>();

	open(agent: string, snapshotId: string): void {
		const queue = this.#pending.get(agent) ?? [];
		queue.push(snapshotId);
		this.#pending.set(agent, queue);
	}

	close(agent: string): string | undefined {
		const queue = this.#pending.get(agent);
		const id = queue?.shift();
		if (queue && queue.length === 0) this.#pending.delete(agent);
		return id;
	}

	active(): boolean {
		return this.#pending.size > 0;
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

export function editedPaths(toolName: string, input: unknown): string[] {
	if (toolName !== "edit" && toolName !== "write") return [];
	const record = (input ?? {}) as { path?: unknown; edits?: Array<{ path?: unknown }> };
	const paths = new Set<string>();
	if (typeof record.path === "string") paths.add(record.path);
	for (const edit of Array.isArray(record.edits) ? record.edits : []) {
		if (typeof edit?.path === "string") paths.add(edit.path);
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
	if (verdict.verdict === "clean") return undefined;
	const who = `${verdict.agent ?? verdict.role ?? "worker"} (step ${verdict.step ?? "-"})`;
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
