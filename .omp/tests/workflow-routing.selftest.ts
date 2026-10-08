import assert from "node:assert/strict";
import {
	deriveRoutingExplanation,
	effectivePipelineProfile,
	ponytailModeForRetry,
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
assert.equal(reviewChanges.ponytailMode, "lite");

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
assert.equal(qaBugs.reasonCode, "qa_bugs_red_test");
assert.equal(qaBugs.actor, "coder");
assert.equal(qaBugs.ponytailMode, "lite");

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
		modelFailureBackupAgent: "-",
		modelFailureAuthorizedBy: "-",
	},
	baseRuntime,
);
assert.equal(modelFailure.reasonCode, "model_failure_waiting_authorization");
assert.equal(modelFailure.actor, "human");

const autoFailover = deriveRoutingExplanation(
	{
		...baseState,
		modelFailureStatus: "backup_authorized",
		modelFailureAuthorizedBy: "auto",
		modelFailureRole: "coder",
		modelFailureBackupAgent: "workflow-coder-backup",
	},
	baseRuntime,
);
assert.equal(autoFailover.reasonCode, "auto_failover");
assert.match(autoFailover.action, /workflow-coder-backup/);
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

const quickClose = deriveRoutingExplanation(
	{ ...baseState, implementationStatus: "waiting_review" },
	baseRuntime,
	{ pipelineProfile: "quick", risk: "low" },
);
assert.equal(quickClose.reasonCode, "quick_profile_close");
assert.equal(quickClose.actor, "orchestrator");

const highRiskKeepsReview = deriveRoutingExplanation(
	{ ...baseState, implementationStatus: "waiting_review", reviewEnabled: true },
	baseRuntime,
	{ pipelineProfile: "quick", risk: "high" },
);
assert.equal(highRiskKeepsReview.reasonCode, "quick_forbidden");
assert.equal(highRiskKeepsReview.actor, "reviewer");
assert.equal(effectivePipelineProfile(baseState, { pipelineProfile: "quick", risk: "high" }), "standard");

const blastRadiusBlocksQuick = deriveRoutingExplanation(
	{ ...baseState, implementationStatus: "waiting_review", reviewEnabled: true, pipelineQuickForbidden: true },
	baseRuntime,
	{ pipelineProfile: "quick", risk: "low", quickForbidden: true },
);
assert.equal(blastRadiusBlocksQuick.reasonCode, "quick_forbidden");
assert.equal(effectivePipelineProfile(
	{ ...baseState, pipelineQuickForbidden: true },
	{ pipelineProfile: "quick", risk: "low" },
), "standard");

const securityOffer = deriveRoutingExplanation(
	{
		...baseState,
		reviewVerdict: "approved",
		qaStatus: "qa_green",
		securityNextRun: "offer_scoped",
	},
	baseRuntime,
);
assert.equal(securityOffer.reasonCode, "security_offer");
assert.equal(securityOffer.actor, "human");

assert.equal(ponytailModeForRetry({ kind: "first" }), "full");
assert.equal(ponytailModeForRetry({ kind: "review_changes", repeatedFailureCount: 1 }), "lite");
assert.equal(ponytailModeForRetry({ kind: "qa_bugs", repeatedFailureCount: 2 }), "off");

const standardStillReviews = deriveRoutingExplanation(
	{ ...baseState, implementationStatus: "waiting_review" },
	baseRuntime,
);
assert.equal(standardStillReviews.reasonCode, "objective_ready_for_review");

console.log("workflow routing selftest: PASS");
console.log("  reasons: worker_running, objective_ready, quick_profile_close, review_changes, qa_pending, qa_bugs_red_test, stop_gate_ready, security_offer");
console.log("  exceptions: model_failure_waiting_authorization, human_blocker, onboarding_pending, high-risk/blast-radius ignore quick");

