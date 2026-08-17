// Pure TypeScript module for structured routing explanations and /workflow why logic.

import {
	normalizeRole,
	roleLabel,
	type RuntimeSnapshot,
	type WorkflowState,
} from "./workflow-dashboard-core.ts";

export type RoutingReasonCode =
	| "worker_running"
	| "objective_ready_for_review"
	| "review_changes_requested"
	| "qa_pending"
	| "qa_bugs"
	| "stop_gate_ready"
	| "human_blocker"
	| "model_failure_waiting_authorization"
	| "role_not_configured"
	| "onboarding"
	| "unknown";

export type RoutingExplanation = {
	action: string;
	reason: string;
	reasonCode: RoutingReasonCode;
	actor?: string;
	actorLabel?: string;
	prerequisites?: string[];
};

export function deriveRoutingExplanation(
	state: WorkflowState,
	runtime: RuntimeSnapshot,
): RoutingExplanation {
	if (state.modelFailureStatus === "awaiting_human") {
		const role = roleLabel(state.modelFailureRole);
		return {
			action: state.modelFailureInstruction !== "-"
				? state.modelFailureInstruction
				: `Human authorizes ${role} backup or changes the model`,
			reason: `Persistent model or provider failure recorded on role ${role}; manual backup authorization required`,
			reasonCode: "model_failure_waiting_authorization",
			actor: "human",
			actorLabel: "Human",
			prerequisites: ["Human instruction `continue <role> with backup` or model switch in Alt+M"],
		};
	}

	if (state.blocker !== "-") {
		if (normalizeRole(state.nextActor) === "architect") {
			return {
				action: "Main requests Architect escalation",
				reason: `Active blocker recorded: "${state.blocker}"; escalating to Architect for design resolution`,
				reasonCode: "human_blocker",
				actor: "architect",
				actorLabel: "Architect",
			};
		}
		const isHuman = state.nextActor === "human";
		return {
			action: isHuman ? "Human resolves the recorded blocker" : "Main verifies and resolves the blocker",
			reason: `Active blocker recorded in STATE.yaml: "${state.blocker}"`,
			reasonCode: "human_blocker",
			actor: isHuman ? "human" : "orchestrator",
			actorLabel: isHuman ? "Human" : "Main",
		};
	}

	if (state.onboardingStatus !== "complete") {
		return {
			action: "Human completes onboarding and model selection",
			reason: "onboarding.status is pending in STATE.yaml",
			reasonCode: "onboarding",
			actor: "human",
			actorLabel: "Human",
			prerequisites: ["Select Quick, Guided, or Advanced onboarding mode via /workflow onboard"],
		};
	}

	if (runtime.worker && (runtime.worker.status === "running" || runtime.worker.status === "pending")) {
		const label = roleLabel(runtime.worker.agent);
		return {
			action: `Wait for ${label} result, then Main verifies it`,
			reason: `Worker session '${runtime.worker.id}' (${label}) is actively executing`,
			reasonCode: "worker_running",
			actor: normalizeRole(runtime.worker.agent) ?? runtime.worker.agent,
			actorLabel: label,
		};
	}

	if (state.reviewVerdict === "changes_requested" || state.reviewStatus === "changes_requested") {
		return {
			action: "Main reopens the affected work item, then dispatches a fresh Coder",
			reason: "Reviewer requested changes on the previous implementation",
			reasonCode: "review_changes_requested",
			actor: "coder",
			actorLabel: "Coder",
		};
	}

	if (state.qaStatus === "bugs") {
		return {
			action: "Main records the bug and dispatches a fresh Coder",
			reason: "Tester reported reproducible product bugs in the previous QA run",
			reasonCode: "qa_bugs",
			actor: "coder",
			actorLabel: "Coder",
		};
	}

	if (state.implementationStatus === "waiting_review" && state.reviewEnabled) {
		return {
			action: "Main verifies Coder evidence, then dispatches Reviewer",
			reason: "Implementation status is waiting_review and independent code review is enabled",
			reasonCode: "objective_ready_for_review",
			actor: "reviewer",
			actorLabel: "Reviewer",
		};
	}

	if (state.reviewVerdict === "approved" && state.qaEnabled && state.qaStatus !== "qa_green") {
		return {
			action: "Main verifies review, then dispatches Tester",
			reason: "Reviewer approved the Judgment Gates and QA is enabled",
			reasonCode: "qa_pending",
			actor: "tester",
			actorLabel: "Tester",
		};
	}

	if (state.reviewVerdict === "approved" && (state.qaStatus === "qa_green" || !state.qaEnabled)) {
		return {
			action: "Main closes the Stop-gate and opens the next step",
			reason: "Reviewer approved and QA is satisfied; step Stop-gate conditions met",
			reasonCode: "stop_gate_ready",
			actor: "orchestrator",
			actorLabel: "Main",
		};
	}

	const role = normalizeRole(state.nextActor);
	if (role) {
		return {
			action: `Main dispatches a fresh ${roleLabel(role)}`,
			reason: `STATE.yaml next_actor is configured as '${state.nextActor}'`,
			reasonCode: "unknown",
			actor: role,
			actorLabel: roleLabel(role),
		};
	}

	return {
		action: "Main verifies evidence and selects the next transition",
		reason: "All prior gates evaluated; Main evaluating repository evidence for the next stage",
		reasonCode: "unknown",
		actor: "orchestrator",
		actorLabel: "Main",
	};
}
