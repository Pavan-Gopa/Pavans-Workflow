// Pure TypeScript module for structured routing explanations and /workflow why logic.

import {
	normalizeRole,
	roleLabel,
	type RuntimeSnapshot,
	type WorkflowState,
} from "./workflow-dashboard-core.ts";

export type PipelineProfile = "quick" | "standard" | "critical";
export type StepRisk = "low" | "normal" | "high";
export type PonytailMode = "full" | "lite" | "off";

export type StepRoutingMeta = {
	pipelineProfile?: PipelineProfile;
	risk?: StepRisk;
	quickForbidden?: boolean;
};

export type RoutingReasonCode =
	| "worker_running"
	| "objective_ready_for_review"
	| "quick_profile_close"
	| "quick_forbidden"
	| "review_changes_requested"
	| "qa_pending"
	| "qa_bugs"
	| "qa_bugs_red_test"
	| "stop_gate_ready"
	| "security_offer"
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
	pipelineProfile?: PipelineProfile;
	ponytailMode?: PonytailMode;
};

export function effectivePipelineProfile(
	state: WorkflowState,
	step?: StepRoutingMeta,
): PipelineProfile {
	const candidate: PipelineProfile = step?.pipelineProfile || state.pipelineProfile || "standard";
	if (candidate === "quick" && (step?.risk === "high" || step?.quickForbidden || state.pipelineQuickForbidden)) {
		return "standard";
	}
	return candidate;
}

export function ponytailModeForRetry(input: {
	implementationAttempts?: number;
	repeatedFailureCount?: number;
	kind: "first" | "review_changes" | "qa_bugs";
}): PonytailMode {
	if (input.kind === "first") return "full";
	if ((input.repeatedFailureCount ?? 0) >= 2) return "off";
	return "lite";
}

function qaSatisfied(state: WorkflowState): boolean {
	return !state.qaEnabled || state.qaStatus === "qa_green" || state.qaStatus === "skipped";
}

export function deriveRoutingExplanation(
	state: WorkflowState,
	runtime: RuntimeSnapshot,
	step?: StepRoutingMeta,
): RoutingExplanation {
	const profile = effectivePipelineProfile(state, step);

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
			pipelineProfile: profile,
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
				pipelineProfile: profile,
			};
		}
		const isHuman = state.nextActor === "human";
		return {
			action: isHuman ? "Human resolves the recorded blocker" : "Main verifies and resolves the blocker",
			reason: `Active blocker recorded in STATE.yaml: "${state.blocker}"`,
			reasonCode: "human_blocker",
			actor: isHuman ? "human" : "orchestrator",
			actorLabel: isHuman ? "Human" : "Main",
			pipelineProfile: profile,
		};
	}

	if (state.onboardingStatus !== "complete") {
		return {
			action: "Human completes onboarding and model selection",
			reason: "onboarding.status is pending in STATE.yaml",
			reasonCode: "onboarding",
			actor: "human",
			actorLabel: "Human",
			pipelineProfile: profile,
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
			pipelineProfile: profile,
		};
	}

	if (state.reviewVerdict === "changes_requested" || state.reviewStatus === "changes_requested") {
		const mode = ponytailModeForRetry({
			implementationAttempts: state.implementationAttempts,
			repeatedFailureCount: state.repeatedFailureCount,
			kind: "review_changes",
		});
		return {
			action: `Main reopens the affected work item, then dispatches a fresh Coder with ponytail_mode: ${mode}`,
			reason: "Reviewer requested changes; retry uses a smaller Ponytail mode so the previous approach is not rewritten",
			reasonCode: "review_changes_requested",
			actor: "coder",
			actorLabel: "Coder",
			pipelineProfile: profile,
			ponytailMode: mode,
		};
	}

	if (state.qaStatus === "bugs") {
		const mode = ponytailModeForRetry({
			implementationAttempts: state.implementationAttempts,
			repeatedFailureCount: state.repeatedFailureCount,
			kind: "qa_bugs",
		});
		return {
			action: `Main keeps Tester-added failing tests as Objective Gates, then dispatches Coder with ponytail_mode: ${mode}`,
			reason: "Tester reported reproducible product bugs and should already have added a failing test",
			reasonCode: "qa_bugs_red_test",
			actor: "coder",
			actorLabel: "Coder",
			pipelineProfile: profile,
			ponytailMode: mode,
			prerequisites: ["Failing test path from Tester new_tests is an Objective Gate"],
		};
	}

	const requestedQuick = (step?.pipelineProfile || state.pipelineProfile) === "quick";
	if (state.implementationStatus === "waiting_review" && requestedQuick && profile !== "quick") {
		return {
			action: "Main re-runs Objective Gates, then dispatches Reviewer — quick is blocked by blast radius or high risk",
			reason: step?.risk === "high"
				? "Card is marked quick but Risk is high; the full Coder → Reviewer → Tester loop stays in force"
				: "Card is marked quick but the verified diff hit auth/API/schema/migration paths; quick is forbidden",
			reasonCode: "quick_forbidden",
			actor: "reviewer",
			actorLabel: "Reviewer",
			pipelineProfile: profile,
			prerequisites: [
				"python3 AI_Workflow_Kit/script/workflow_gates.py run --json",
				"python3 AI_Workflow_Kit/script/workflow_security_scope.py --json",
			],
		};
	}

	if (state.implementationStatus === "waiting_review" && profile === "quick") {
		return {
			action: "Main re-runs Objective Gates with workflow_gates.py, then closes the Stop-gate",
			reason: "Pipeline profile is quick; Reviewer and Tester are skipped after deterministic gates. High-risk cards and blast-radius hits cannot use quick.",
			reasonCode: "quick_profile_close",
			actor: "orchestrator",
			actorLabel: "Main",
			pipelineProfile: profile,
			prerequisites: ["python3 AI_Workflow_Kit/script/workflow_gates.py run --json"],
		};
	}

	if (state.implementationStatus === "waiting_review" && state.reviewEnabled) {
		return {
			action: "Main re-runs Objective Gates, then dispatches Reviewer",
			reason: "Implementation status is waiting_review and independent code review is enabled",
			reasonCode: "objective_ready_for_review",
			actor: "reviewer",
			actorLabel: "Reviewer",
			pipelineProfile: profile,
			prerequisites: ["python3 AI_Workflow_Kit/script/workflow_gates.py run --json"],
		};
	}

	if (state.reviewVerdict === "approved" && state.qaEnabled && state.qaStatus !== "qa_green") {
		return {
			action: "Main verifies review, then dispatches Tester",
			reason: profile === "critical"
				? "Reviewer approved; critical profile keeps QA on the path"
				: "Reviewer approved the Judgment Gates and QA is enabled",
			reasonCode: "qa_pending",
			actor: "tester",
			actorLabel: "Tester",
			pipelineProfile: profile,
		};
	}

	if (state.reviewVerdict === "approved" && qaSatisfied(state) && state.securityNextRun === "offer_scoped") {
		return {
			action: "Main asks Human whether to run a scoped Security pass on the blast-radius files",
			reason: "Verified diff matched auth/credential/trust-boundary paths; this is optional and not a full pre-release campaign",
			reasonCode: "security_offer",
			actor: "human",
			actorLabel: "Human",
			pipelineProfile: profile,
			prerequisites: ["python3 AI_Workflow_Kit/script/workflow_security_scope.py --json"],
		};
	}

	if (state.reviewVerdict === "approved" && qaSatisfied(state)) {
		return {
			action: "Main closes the Stop-gate and opens the next step",
			reason: "Reviewer approved and QA is satisfied; step Stop-gate conditions met",
			reasonCode: "stop_gate_ready",
			actor: "orchestrator",
			actorLabel: "Main",
			pipelineProfile: profile,
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
			pipelineProfile: profile,
		};
	}

	return {
		action: "Main verifies evidence and selects the next transition",
		reason: "All prior gates evaluated; Main evaluating repository evidence for the next stage",
		reasonCode: "unknown",
		actor: "orchestrator",
		actorLabel: "Main",
		pipelineProfile: profile,
	};
}
