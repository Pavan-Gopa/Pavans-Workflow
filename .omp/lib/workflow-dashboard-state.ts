import type { StepCard, WorkflowState } from "./workflow-dashboard-core.ts";

function allVerified(step: StepCard): boolean {
	const items = [...step.todos, ...step.objectiveGates, ...step.judgmentGates];
	return items.length > 0 && items.every(item => item.done);
}

/**
 * Build a display-only state view for the currently loaded STEPS.md plan.
 *
 * Durable state may legitimately retain completed IDs from an older train. Those
 * IDs are history, not a warning about the active plan. Conversely, a newly
 * generated plan can have fully checked cards before completed_steps has been
 * migrated. Derive those cards as complete for display without writing STATE.
 */
export function reconcileStateWithPlan(state: WorkflowState, steps: StepCard[]): WorkflowState {
	const planIds = new Set(steps.map(step => step.id));
	const completed = new Set(state.completedSteps.filter(id => planIds.has(id)));
	for (const step of steps) {
		if (allVerified(step)) completed.add(step.id);
	}
	return { ...state, completedSteps: [...completed] };
}

function blockText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.map(block => {
			if (typeof block === "string") return block;
			if (!block || typeof block !== "object") return "";
			const record = block as Record<string, unknown>;
			return typeof record.text === "string" ? record.text : typeof record.content === "string" ? record.content : "";
		})
		.filter(Boolean)
		.join("\n");
}

/** Return newest bounded user/Main text for read-only live-step recovery. */
export function recentSessionStepEvidence(entries: unknown, limit = 10): string[] {
	if (!Array.isArray(entries)) return [];
	const result: string[] = [];
	for (let index = entries.length - 1; index >= 0 && result.length < limit; index -= 1) {
		const entry = entries[index];
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (record.type !== "message" || !record.message || typeof record.message !== "object") continue;
		const message = record.message as Record<string, unknown>;
		const role = typeof message.role === "string" ? message.role : "";
		if (role !== "user" && role !== "assistant") continue;
		const text = blockText(message.content).trim();
		if (text) result.push(text.slice(0, 8_000));
	}
	return result;
}
