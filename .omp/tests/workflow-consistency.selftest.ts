import assert from "node:assert/strict";
import { checkWorkflowConsistency, type ConsistencyFinding } from "../lib/workflow-consistency.ts";
import { parseSteps, parseWorkflowState } from "../lib/workflow-dashboard-core.ts";
import type { RuntimeTodoSnapshot } from "../lib/workflow-runtime-todo.ts";

const stepsSource = `
## S3 — Configuration import

**Goal:** Import configuration.

**Do:**
- [x] [S3.D1] Add the configuration import
- [ ] [S3.D2] Add error handling
- [ ] [S3.D3] Add regression tests

**Objective gates:**
- [ ] [S3.O1] tests exit 0

## S4 — Follow-up

**Goal:** Follow-up work.

**Do:**
- [ ] [S4.D1] Ship the docs
`;
const steps = parseSteps(stepsSource);
const baseState = parseWorkflowState(`
schema_version: 2
current_step: S3
current_work_item_id: S3.D2
current_work_item: Add error handling
completed_steps: []
implementation:
  status: running
review:
  status: pending
qa:
  status: pending
omp:
  model_failure:
    status: none
`);

function codes(findings: ConsistencyFinding[]): string[] {
	return findings.map(finding => finding.code);
}

// 1. Clean schema v2 state: no findings.
assert.deepEqual(checkWorkflowConsistency({ state: baseState, steps }), []);

// 2. Legacy schema v1 warns and suggests migration.
const v1 = parseWorkflowState(`
current_step: S3
current_work_item: Add error handling
implementation:
  status: running
`);
assert.equal(v1.schemaVersion, 1);
assert.ok(codes(checkWorkflowConsistency({ state: v1, steps })).includes("schema_legacy"));

// 3. Unsupported future schema fails.
const v9 = parseWorkflowState(`
schema_version: 9
current_step: S3
implementation:
  status: running
`);
assert.equal(v9.schemaVersion, 9);
assert.ok(codes(checkWorkflowConsistency({ state: v9, steps })).includes("schema_unsupported"));

// 4. current_work_item_id missing from the plan.
const missingId = { ...baseState, currentWorkItemId: "S3.D9" };
assert.ok(codes(checkWorkflowConsistency({ state: missingId, steps })).includes("work_item_id_missing"));

// 5. ID belonging to another step.
const wrongStep = { ...baseState, currentWorkItemId: "S4.D1" };
assert.ok(codes(checkWorkflowConsistency({ state: wrongStep, steps })).includes("work_item_wrong_step"));

// 6. Malformed ID.
const malformed = { ...baseState, currentWorkItemId: "not-an-id" };
assert.ok(codes(checkWorkflowConsistency({ state: malformed, steps })).includes("work_item_id_invalid"));

// 7. Already-checked item while work is active warns; complete status does not.
const staleChecked = { ...baseState, currentWorkItemId: "S3.D1" };
assert.ok(codes(checkWorkflowConsistency({ state: staleChecked, steps })).includes("work_item_already_checked"));
const staleCheckedComplete = { ...staleChecked, implementationStatus: "complete" };
assert.ok(!codes(checkWorkflowConsistency({ state: staleCheckedComplete, steps })).includes("work_item_already_checked"));

// 8. Text mismatch between ID and display text.
const mismatch = { ...baseState, currentWorkItem: "Something else entirely" };
assert.ok(codes(checkWorkflowConsistency({ state: mismatch, steps })).includes("work_item_text_mismatch"));

// 9. Legacy text-only linkage: unresolved text warns.
const legacyUnresolved = parseWorkflowState(`
schema_version: 2
current_step: S3
current_work_item: No such item anywhere
implementation:
  status: running
`);
assert.ok(codes(checkWorkflowConsistency({ state: legacyUnresolved, steps })).includes("work_item_text_unresolved"));

// 10. Missing current step.
const missingStep = { ...baseState, currentStep: "S99", currentWorkItemId: "-" };
assert.ok(codes(checkWorkflowConsistency({ state: missingStep, steps })).includes("current_step_missing"));

// 11. Duplicate IDs fail.
const dupSteps = parseSteps(`
## S5 — Dupes

**Do:**
- [ ] [S5.D1] One
- [ ] [S5.D1] Two
`);
assert.ok(codes(checkWorkflowConsistency({ state: { ...baseState, currentWorkItemId: "-" }, steps: dupSteps })).includes("duplicate_id"));

// 12. Completed step with open objective gates warns; completed step outside plan warns.
const completedOpenGates = { ...baseState, currentWorkItemId: "-", completedSteps: ["S3"] };
assert.ok(codes(checkWorkflowConsistency({ state: completedOpenGates, steps })).includes("completed_step_open_gates"));
const completedOutside = { ...baseState, currentWorkItemId: "-", completedSteps: ["OLD-1"] };
assert.ok(codes(checkWorkflowConsistency({ state: completedOutside, steps })).includes("completed_step_missing"));

// 13. Unknown enum values warn.
const badEnum = { ...baseState, implementationStatus: "exploded" };
assert.ok(codes(checkWorkflowConsistency({ state: badEnum, steps })).includes("enum_invalid"));

// 14. Model failure awaiting_human without a role is inconsistent.
const badFailure = { ...baseState, modelFailureStatus: "awaiting_human", modelFailureRole: "-" };
assert.ok(codes(checkWorkflowConsistency({ state: badFailure, steps })).includes("model_failure_incomplete"));

// 15. Hub active-agent drift flag surfaces.
const drifted = checkWorkflowConsistency({ state: baseState, steps, hubActiveAgentConsistent: false });
assert.ok(codes(drifted).includes("active_agent_drift"));
const consistent = checkWorkflowConsistency({ state: baseState, steps, hubActiveAgentConsistent: true });
assert.ok(!codes(consistent).includes("active_agent_drift"));

// 16. Runtime Todo referencing an unknown ID warns.
const todo: RuntimeTodoSnapshot = {
	available: true,
	phases: [{ name: "P", tasks: [{ content: "[S9.D9] Ghost", status: "pending" }] }],
};
const todoFindings = checkWorkflowConsistency({ state: baseState, steps, runtimeTodo: todo });
assert.ok(todoFindings.some(f => f.code === "runtime_todo_unknown_id" && f.message.includes("S9.D9")));

console.log("workflow consistency selftest: PASS");
console.log("  schema: v1 legacy warn, v2 clean, unsupported future fail");
console.log("  work items: missing, wrong-step, malformed, stale-checked, text mismatch");
console.log("  plan: duplicate IDs, missing steps, open gates on completed steps");
console.log("  runtime: hub drift flag, unknown runtime todo IDs, enum validation");
