import assert from "node:assert/strict";
import {
	deriveRoutingExplanation,
	type RoutingReasonCode,
} from "../lib/workflow-routing.ts";
import { parseWorkflowState, type RuntimeSnapshot } from "../lib/workflow-dashboard-core.ts";

const baseState = parseWorkflowState(`
schema_version: 2
current_step: S3
current_work_item_id: S3.D2
current_work_item: Add error handling
completed_steps: []
onboarding:
  status: complete
  mode: quick
implementation:
  status: running
review:
  enabled: true
  status: pending
qa:
  enabled: true
  status: pending
security:
  next_run: none
retry_guard:
  blocker: null
omp:
  model_failure:
    status: none
`);

const baseRuntime: RuntimeSnapshot = {
	mainStatus: "idle",
	mainActivity: "Ready for instruction",
};

// 1. Worker running
const runningWorker = deriveRoutingExplanation(baseState, {
	...baseRuntime,
	worker: {
		id: "coder-1",
		agent: "workflow-coder",
		status: "running",
		startedAt: Date.now(),
	},
});
assert.equal(runningWorker.reasonCode, "worker_running");
assert.match(runningWorker.action, /Wait for Coder result/);

// 2. Objective ready for review
const waitingReview = deriveRoutingExplanation(
	{ ...baseState, implementationStatus: "waiting_review" },
	baseRuntime,
);
assert.equal(waitingReview.reasonCode, "objective_ready_for_review");
assert.equal(waitingReview.actor, "reviewer");

// 3. Review requested changes
const reviewChanges = deriveRoutingExplanation(
	{ ...baseState, reviewVerdict: "changes_requested" },
	baseRuntime,
);
assert.equal(reviewChanges.reasonCode, "review_changes_requested");
assert.equal(reviewChanges.actor, "coder");

// 4. QA pending
const qaPending = deriveRoutingExplanation(
	{ ...baseState, reviewVerdict: "approved", qaStatus: "pending" },
	baseRuntime,
);
assert.equal(qaPending.reasonCode, "qa_pending");
assert.equal(qaPending.actor, "tester");

// 5. QA bugs
const qaBugs = deriveRoutingExplanation(
	{ ...baseState, qaStatus: "bugs" },
	baseRuntime,
);
assert.equal(qaBugs.reasonCode, "qa_bugs");
assert.equal(qaBugs.actor, "coder");

// 6. Stop-gate ready
const stopGateReady = deriveRoutingExplanation(
	{ ...baseState, reviewVerdict: "approved", qaStatus: "qa_green" },
	baseRuntime,
);
assert.equal(stopGateReady.reasonCode, "stop_gate_ready");
assert.equal(stopGateReady.actor, "orchestrator");

// 7. Model failure waiting authorization
const modelFailure = deriveRoutingExplanation(
	{
		...baseState,
		modelFailureStatus: "awaiting_human",
		modelFailureRole: "coder",
		modelFailureInstruction: "Choose Coder backup or change the model",
	},
	baseRuntime,
);
assert.equal(modelFailure.reasonCode, "model_failure_waiting_authorization");
assert.equal(modelFailure.actor, "human");

// 8. Human blocker
const blocked = deriveRoutingExplanation(
	{ ...baseState, blocker: "Missing external API token", nextActor: "human" },
	baseRuntime,
);
assert.equal(blocked.reasonCode, "human_blocker");
assert.equal(blocked.actor, "human");

// 9. Onboarding pending
const onboardingPending = deriveRoutingExplanation(
	{ ...baseState, onboardingStatus: "pending" },
	baseRuntime,
);
assert.equal(onboardingPending.reasonCode, "onboarding");
assert.equal(onboardingPending.actor, "human");

console.log("workflow routing selftest: PASS");
console.log("  reasons: worker_running, objective_ready, review_changes, qa_pending, qa_bugs, stop_gate_ready");
console.log("  exceptions: model_failure_waiting_authorization, human_blocker, onboarding_pending");
