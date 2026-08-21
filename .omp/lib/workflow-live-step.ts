import type { DashboardData, RuntimeSnapshot, StepCard } from "./workflow-dashboard-core.ts";

export type LiveStepSource = "state" | "work_item" | "runtime_todo" | "worker" | "session" | "none";

export type LiveStepResolution = {
	id?: string;
	source: LiveStepSource;
	raw?: string;
};

type TodoResolution = {
	id?: string;
	status?: string;
};

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalized(value: string | undefined): string {
	if (!value) return "";
	let text = value.trim();
	if (!text || text === "-" || text === "null" || text === "~") return "";
	if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
		text = text.slice(1, -1).trim();
	}
	const inlineComment = text.search(/\s+#/);
	if (inlineComment >= 0) text = text.slice(0, inlineComment).trim();
	return text;
}

function canonicalStepId(value: string | undefined, steps: StepCard[]): string | undefined {
	const text = normalized(value);
	if (!text || steps.length === 0) return undefined;

	const exact = steps.find(step => step.id === text);
	if (exact) return exact.id;

	const caseInsensitive = steps.filter(step => step.id.toLowerCase() === text.toLowerCase());
	if (caseInsensitive.length === 1) return caseInsensitive[0].id;

	const stable = text.match(/^\[?([^\]\s]+?)\.(?:D|O|J)[1-9][0-9]*\]?\b/i)?.[1];
	if (stable) {
		const matched = steps.filter(step => step.id.toLowerCase() === stable.toLowerCase());
		if (matched.length === 1) return matched[0].id;
	}

	const leading = text.match(
		/^(?:current\s+)?(?:step|phase|review|qa|security|design|designer)?\s*[:#-]?\s*\[?([A-Za-z0-9][A-Za-z0-9._/-]*)\]?\b/i,
	)?.[1];
	if (leading) {
		const matched = steps.filter(step => step.id.toLowerCase() === leading.toLowerCase());
		if (matched.length === 1) return matched[0].id;
	}

	const embedded = steps.filter(step => {
		const id = escapeRegExp(step.id);
		return new RegExp(`(?:^|[^A-Za-z0-9._/-])${id}(?=$|[^A-Za-z0-9._/-])`, "i").test(text);
	});
	return embedded.length === 1 ? embedded[0].id : undefined;
}

function uniqueStep(values: Array<string | undefined>, steps: StepCard[]): string | undefined {
	const ids = new Set<string>();
	for (const value of values) {
		const id = canonicalStepId(value, steps);
		if (id) ids.add(id);
	}
	return ids.size === 1 ? [...ids][0] : undefined;
}

function runtimeTodoStep(data: DashboardData): TodoResolution {
	const tasks = data.runtimeTodo?.phases.flatMap(phase => phase.tasks) ?? [];
	for (const status of ["in_progress", "blocked", "pending"] as const) {
		const values = tasks.filter(task => task.status === status).map(task => task.content);
		const id = uniqueStep(values, data.steps);
		if (id) return { id, status };
	}
	return {};
}

function workerStep(runtime: RuntimeSnapshot, steps: StepCard[]): string | undefined {
	const worker = runtime.worker;
	if (!worker || (worker.status !== "running" && worker.status !== "pending")) return undefined;
	const values = [worker.assignment, worker.task, worker.lastIntent];
	const focused: string[] = [];
	for (const value of values) {
		if (!value) continue;
		const match = value.match(
			/(?:^|\n)\s*(?:step|phase|review|qa|security|design|designer|current step)\s*:\s*([^\n]+)/i,
		);
		focused.push(match?.[1] ?? value);
	}
	return uniqueStep(focused, steps);
}

function sessionStep(values: string[] | undefined, steps: StepCard[]): string | undefined {
	if (!values?.length) return undefined;
	// Newest evidence wins, but only when a single canonical plan ID is present
	// in that message. This avoids guessing from long historical summaries that
	// happen to mention several phases.
	for (const value of values) {
		const id = uniqueStep([value], steps);
		if (id) return id;
	}
	return undefined;
}

/**
 * Resolve the step that is actually live in the OMP session.
 *
 * Strong runtime evidence intentionally outranks a stale but syntactically
 * valid STATE.yaml current_step. Recent Main/Human session text is a final
 * read-only recovery path for experimental plans that have started a P-phase
 * before durable state has been migrated. Dashboard recovery never writes
 * canonical state.
 */
export function resolveLiveStep(
	data: DashboardData,
	runtime: RuntimeSnapshot,
	sessionEvidence?: string[],
): LiveStepResolution {
	const stateStep = canonicalStepId(data.state.currentStep, data.steps);
	const workItemStep = canonicalStepId(data.state.currentWorkItemId, data.steps);
	const todo = runtimeTodoStep(data);
	const activeWorkerStep = workerStep(runtime, data.steps);
	const recentSessionStep = sessionStep(sessionEvidence, data.steps);

	if (workItemStep) {
		return { id: workItemStep, source: "work_item", raw: data.state.currentWorkItemId };
	}

	if (todo.id && (todo.status === "in_progress" || todo.status === "blocked")) {
		return { id: todo.id, source: "runtime_todo" };
	}

	if (activeWorkerStep) {
		return { id: activeWorkerStep, source: "worker" };
	}

	if (recentSessionStep && recentSessionStep !== stateStep) {
		return { id: recentSessionStep, source: "session" };
	}

	if (stateStep) {
		return { id: stateStep, source: "state", raw: data.state.currentStep };
	}

	if (todo.id) {
		return { id: todo.id, source: "runtime_todo" };
	}

	if (recentSessionStep) {
		return { id: recentSessionStep, source: "session" };
	}

	return {
		source: "none",
		raw: normalized(data.state.currentStep) || undefined,
	};
}

export function applyLiveStep(
	data: DashboardData,
	runtime: RuntimeSnapshot,
	sessionEvidence?: string[],
): {
	data: DashboardData;
	resolution: LiveStepResolution;
} {
	const resolution = resolveLiveStep(data, runtime, sessionEvidence);
	if (!resolution.id || resolution.id === data.state.currentStep) return { data, resolution };
	return {
		data: {
			...data,
			state: { ...data.state, currentStep: resolution.id },
		},
		resolution,
	};
}
