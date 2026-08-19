import assert from "node:assert/strict";
import { applyLiveStep, resolveLiveStep } from "../lib/workflow-live-step.ts";
import type { DashboardData, RuntimeSnapshot, StepCard, WorkflowState } from "../lib/workflow-dashboard-core.ts";

const steps: StepCard[] = [
	{
		id: "S0",
		title: "Ready",
		goal: "Ready.",
		dependsOn: "-",
		risk: "normal",
		pipelineProfile: "standard",
		todos: [{ id: "S0.D1", text: "Bootstrap", done: true, canonical: true }],
		objectiveGates: [],
		judgmentGates: [],
	},
	{
		id: "S30",
		title: "Batch hardening",
		goal: "Harden batch processing.",
		dependsOn: "-",
		risk: "normal",
		pipelineProfile: "standard",
		todos: [{ id: "S30.D1", text: "Route Coder", done: false, canonical: true }],
		objectiveGates: [],
		judgmentGates: [],
	},
	{
		id: "S31",
		title: "Release",
		goal: "Release.",
		dependsOn: "-",
		risk: "normal",
		pipelineProfile: "standard",
		todos: [{ id: "S31.D1", text: "Package", done: false, canonical: true }],
		objectiveGates: [],
		judgmentGates: [],
	},
];

function state(currentStep: string, currentWorkItemId = "-", implementationStatus = "running"): WorkflowState {
	return {
		schemaVersion: 2,
		currentStep,
		currentWorkItemId,
		currentWorkItem: "-",
		stepDescription: "-",
		track: "IMPLEMENTATION",
		nextActor: "coder",
		completedSteps: ["S0"],
		onboardingStatus: "complete",
		onboardingMode: "quick",
		implementationStatus,
		implementationAttempts: 0,
		reviewStatus: "pending",
		reviewVerdict: "-",
		reviewEnabled: true,
		qaStatus: "pending",
		qaEnabled: true,
		securityNextRun: "none",
		pipelineProfile: "standard",
		pipelineAuthorizedBy: "-",
		pipelineAuthorizedAt: "-",
		pipelineNote: "-",
		blocker: "-",
		repeatedFailureCount: 0,
		activeAgent: "-",
		activeRole: "-",
		interruptionStatus: "none",
		modelFailureStatus: "none",
		modelFailureRole: "-",
		modelFailureInstruction: "-",
	};
}

function data(
	currentStep: string,
	currentWorkItemId = "-",
	runtimeTodo?: DashboardData["runtimeTodo"],
	implementationStatus = "running",
): DashboardData {
	return {
		state: state(currentStep, currentWorkItemId, implementationStatus),
		steps,
		runtimeTodo,
		sessionUsage: { totalTokens: 0, models: [] },
	};
}

const idleRuntime: RuntimeSnapshot = { mainStatus: "idle", mainActivity: "Ready" };

const canonical = data("S30");
assert.deepEqual(resolveLiveStep(canonical, idleRuntime), { id: "S30", source: "state", raw: "S30" });

const workItemWins = data("S0", "S30.D1");
assert.equal(resolveLiveStep(workItemWins, idleRuntime).id, "S30");
assert.equal(resolveLiveStep(workItemWins, idleRuntime).source, "work_item");

const todoWins = data("S0", "-", {
	available: true,
	source: "tool_result",
	phases: [{ name: "Fix", tasks: [{ content: "[S30] Route Coder", status: "in_progress" }] }],
});
assert.equal(resolveLiveStep(todoWins, idleRuntime).id, "S30");
assert.equal(resolveLiveStep(todoWins, idleRuntime).source, "runtime_todo");
assert.equal(applyLiveStep(todoWins, idleRuntime).data.state.currentStep, "S30");

const workerWins = data("S0");
const activeRuntime: RuntimeSnapshot = {
	mainStatus: "working",
	mainActivity: "Supervising",
	worker: {
		id: "coder-s30",
		agent: "workflow-coder",
		status: "running",
		startedAt: Date.now(),
		assignment: "Step: S30\nGoal: harden the batch workspace",
	},
};
assert.equal(resolveLiveStep(workerWins, activeRuntime).id, "S30");
assert.equal(resolveLiveStep(workerWins, activeRuntime).source, "worker");

const pendingDoesNotOverrideValidState = data(
	"S0",
	"-",
	{
		available: true,
		source: "tool_result",
		phases: [{ name: "Later", tasks: [{ content: "[S31] Package", status: "pending" }] }],
	},
	"pending",
);
assert.equal(resolveLiveStep(pendingDoesNotOverrideValidState, idleRuntime).id, "S0");

const malformedStateFallsBack = data("S0 # stale comment", "-", {
	available: true,
	source: "tool_result",
	phases: [{ name: "Fix", tasks: [{ content: "[S30] Route Coder", status: "blocked" }] }],
});
assert.equal(resolveLiveStep(malformedStateFallsBack, idleRuntime).id, "S30");

console.log("workflow live step selftest: PASS");
console.log("  precedence: work item -> active Todo -> active worker -> canonical state");
console.log("  recovery: stale STATE can no longer pin the live plan cursor");
