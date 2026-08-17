// Reads the latest native OMP Todo snapshot from session branch entries.
//
// Sources, in priority order (searched from the end of the branch):
//   1. `custom` entry with customType === "user_todo_edit" and data.phases;
//   2. successful `toolResult` message with toolName === "todo" and details.phases.
//
// Error tool results (isError === true) are ignored: they still carry
// details.phases (usually empty), so the isError guard is load-bearing.
// Unknown/malformed structures never throw; they yield an unavailable snapshot.
//
// This module only imports helpers from workflow-dashboard-core.ts; the core
// module imports this module's types with `import type` only, keeping the
// runtime dependency edge one-directional.

import { extractWorkItemId, type StepCard } from "./workflow-dashboard-core.ts";

export type RuntimeTodoStatus =
	| "pending"
	| "in_progress"
	| "completed"
	| "abandoned"
	| "blocked";

export type RuntimeTodoItem = {
	content: string;
	status: RuntimeTodoStatus;
	blocker?: string;
};

export type RuntimeTodoPhase = {
	name: string;
	tasks: RuntimeTodoItem[];
};

export type RuntimeTodoSource = "user_todo_edit" | "tool_result";

export type RuntimeTodoSnapshot = {
	available: boolean;
	source?: RuntimeTodoSource;
	phases: RuntimeTodoPhase[];
};

const RUNTIME_TODO_STATUSES: ReadonlySet<string> = new Set([
	"pending",
	"in_progress",
	"completed",
	"abandoned",
	"blocked",
]);

const UNAVAILABLE: RuntimeTodoSnapshot = { available: false, phases: [] };

function parsePhases(value: unknown): RuntimeTodoPhase[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const phases: RuntimeTodoPhase[] = [];
	for (const rawPhase of value) {
		if (typeof rawPhase !== "object" || rawPhase === null) return undefined;
		if (!("name" in rawPhase) || typeof rawPhase.name !== "string") return undefined;
		if (!("tasks" in rawPhase) || !Array.isArray(rawPhase.tasks)) return undefined;
		const tasks: RuntimeTodoItem[] = [];
		for (const rawTask of rawPhase.tasks) {
			if (typeof rawTask !== "object" || rawTask === null) return undefined;
			if (!("content" in rawTask) || typeof rawTask.content !== "string") return undefined;
			if (!("status" in rawTask) || typeof rawTask.status !== "string") return undefined;
			if (!RUNTIME_TODO_STATUSES.has(rawTask.status)) return undefined;
			const task: RuntimeTodoItem = { content: rawTask.content, status: rawTask.status as RuntimeTodoStatus };
			if ("blocker" in rawTask && typeof rawTask.blocker === "string" && rawTask.blocker.trim()) {
				task.blocker = rawTask.blocker;
			}
			tasks.push(task);
		}
		phases.push({ name: rawPhase.name, tasks });
	}
	return phases;
}

/**
 * Scan session branch entries (as returned by ctx.sessionManager.getBranch())
 * from newest to oldest and return the first usable Todo snapshot.
 */
export function readRuntimeTodo(entries: unknown): RuntimeTodoSnapshot {
	if (!Array.isArray(entries)) return UNAVAILABLE;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (typeof entry !== "object" || entry === null) continue;
		if ("type" in entry && entry.type === "custom" && "customType" in entry && entry.customType === "user_todo_edit") {
			const data = "data" in entry && typeof entry.data === "object" && entry.data !== null ? entry.data : undefined;
			const phases = data && "phases" in data ? parsePhases(data.phases) : undefined;
			if (phases) return { available: true, source: "user_todo_edit", phases };
			continue;
		}
		if ("type" in entry && entry.type === "message" && "message" in entry) {
			const message = entry.message;
			if (typeof message !== "object" || message === null) continue;
			if (!("role" in message) || message.role !== "toolResult") continue;
			if (!("toolName" in message) || message.toolName !== "todo") continue;
			if ("isError" in message && message.isError === true) continue;
			const details = "details" in message && typeof message.details === "object" && message.details !== null ? message.details : undefined;
			const phases = details && "phases" in details ? parsePhases(details.phases) : undefined;
			if (phases) return { available: true, source: "tool_result", phases };
		}
	}
	return UNAVAILABLE;
}

export function runtimeTodoCounts(snapshot: RuntimeTodoSnapshot): { done: number; total: number } {
	let done = 0;
	let total = 0;
	for (const phase of snapshot.phases) {
		for (const task of phase.tasks) {
			total += 1;
			if (task.status === "completed" || task.status === "abandoned") done += 1;
		}
	}
	return { done, total };
}

export type RuntimeTodoLink = {
	matched: number;
	runOnly: number;
	stepOnly: number;
	invalid: string[];
};

/**
 * Link runtime todo tasks to stable checklist IDs.
 * - matched: task carries an ID that exists in some step card;
 * - run-only: task has no parent ID;
 * - step-only: open `D` item in the live step with no runtime task referencing it;
 * - invalid: task references an ID that exists in no step card.
 */
export function linkRuntimeTodo(
	snapshot: RuntimeTodoSnapshot,
	steps: StepCard[],
	liveStepId?: string,
): RuntimeTodoLink {
	const knownIds = new Set<string>();
	for (const step of steps) {
		for (const item of [...step.todos, ...step.objectiveGates, ...step.judgmentGates]) {
			if (item.id) knownIds.add(item.id);
		}
	}
	const referenced = new Set<string>();
	const link: RuntimeTodoLink = { matched: 0, runOnly: 0, stepOnly: 0, invalid: [] };
	if (!snapshot.available) return link;
	for (const phase of snapshot.phases) {
		for (const task of phase.tasks) {
			const { id } = extractWorkItemId(task.content);
			if (!id) {
				link.runOnly += 1;
				continue;
			}
			if (knownIds.has(id)) {
				link.matched += 1;
				referenced.add(id);
			} else if (!link.invalid.includes(id)) {
				link.invalid.push(id);
			}
		}
	}
	const liveStep = liveStepId ? steps.find(step => step.id === liveStepId) : undefined;
	if (liveStep) {
		for (const item of liveStep.todos) {
			if (!item.done && item.id && !referenced.has(item.id)) link.stepOnly += 1;
		}
	}
	return link;
}
