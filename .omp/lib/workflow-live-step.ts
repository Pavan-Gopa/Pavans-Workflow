import type { DashboardData, RuntimeSnapshot, StepCard } from "./workflow-dashboard-core.ts";

export type LiveStepSource = "work_item" | "runtime_todo" | "worker" | "state" | "pending_todo" | "none";

export type LiveStepResolution = {
	id?: string;
	source: LiveStepSource;
	raw?: string;
	stateId?: string;
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

	const leading = text.match(/^(?:current\s+)?(?:step|review|qa|security|design)?\s*[:#-]?\s*\[?([A-Za-z0-9][A-Za-z0-9._/-]*)\]?\b/i)?.[1];
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

function runtimeTodoStep(data: DashboardData, statuses: string[]): string | undefined {
	const tasks = data.runtimeTodo?.phases.flatMap(phase => phase.tasks) ?? [];
	return uniqueStep(
		tasks.filter(task => statuses.includes(task.status)).map(task => task.content),
		data.steps,
	);
}

function workerStep(runtime: RuntimeSnapshot, steps: StepCard[]): string | undefined {
	const worker = runtime.worker;
	if (!worker || (worker.status !== "running" && worker.status !== "pending")) return undefined;
	const values = [worker.assignment, worker.task, worker.lastIntent];
	const focused: string[] = [];
	for (const value of values) {
		if (!value) continue;
		const match = value.match(/(?:^|\n)\s*(?:step|review|qa|security|design|current step)\s*:\s*([^\n]+)/i);
		focused.push(match?.[1] ?? value);
	}
	return uniqueStep(focused, steps);
}

/**
 * Resolve the step that is actually live in the current OMP process.
 *
 * Strong active evidence intentionally outranks a valid-but-stale
 * STATE.yaml.current_step. This restores the moving plan cursor after a resumed
 * session while keeping STATE.yaml authoritative whenever runtime evidence is
 * absent or ambiguous.
 */
export function resolveLiveStep(data: DashboardData, runtime: RuntimeSnapshot): LiveStepResolution {
	const stateId = canonicalStepId(data.state.currentStep, data.steps);

	const workItemId = canonicalStepId(data.state.currentWorkItemId, data.steps);
	if (workItemId) {
		return { id: workItemId, source: "work_item", raw: data.state.currentWorkItemId, stateId };
	}

	const activeTodoId = runtimeTodoStep(data, ["in_progress", "blocked"]);
	if (activeTodoId) return { id: activeTodoId, source: "runtime_todo", stateId };

	const activeWorkerId = workerStep(runtime, data.steps);
	if (activeWorkerId) return { id: activeWorkerId, source: "worker", stateId };

	if (stateId) return { id: stateId, source: "state", raw: data.state.currentStep, stateId };

	const pendingTodoId = runtimeTodoStep(data, ["pending"]);
	if (pendingTodoId) return { id: pendingTodoId, source: "pending_todo", stateId };

	return {
		source: "none",
		raw: normalized(data.state.currentStep) || undefined,
		stateId,
	};
}

export function applyLiveStep(data: DashboardData, runtime: RuntimeSnapshot): {
	data: DashboardData;
	resolution: LiveStepResolution;
} {
	const resolution = resolveLiveStep(data, runtime);
	if (!resolution.id || resolution.id === data.state.currentStep) return { data, resolution };
	return {
		data: {
			...data,
			state: { ...data.state, currentStep: resolution.id },
		},
		resolution,
	};
}
