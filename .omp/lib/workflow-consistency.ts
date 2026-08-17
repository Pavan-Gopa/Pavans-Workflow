// Read-only drift diagnostics for workflow state.
//
// Main owns all writes; this module only detects inconsistencies between
// STATE.yaml, STEPS.md, and the native OMP runtime Todo. The dashboard shows
// findings but never corrects them.

import {
	isValidWorkItemId,
	normalizeWorkItemText,
	type ChecklistItem,
	type StepCard,
	type WorkflowState,
} from "./workflow-dashboard-core.ts";
import type { RuntimeTodoSnapshot } from "./workflow-runtime-todo.ts";
import { linkRuntimeTodo } from "./workflow-runtime-todo.ts";

export type ConsistencySeverity = "warn" | "fail";

export type ConsistencyFinding = {
	code: string;
	severity: ConsistencySeverity;
	message: string;
};

export type ConsistencyInput = {
	state: WorkflowState;
	steps: StepCard[];
	runtimeTodo?: RuntimeTodoSnapshot;
	// Set by the extension after comparing STATE.yaml omp.active_agent with
	// live hub jobs; undefined means "not checked".
	hubActiveAgentConsistent?: boolean;
};

const IMPLEMENTATION_STATUSES = new Set([
	"pending",
	"running",
	"waiting_review",
	"changes_requested",
	"blocked",
	"complete",
]);

const REVIEW_STATUSES = new Set(["pending", "in_progress", "approved", "changes_requested", "blocked", "skipped"]);
const QA_STATUSES = new Set(["pending", "in_progress", "qa_green", "bugs", "blocked", "skipped"]);
const MODEL_FAILURE_STATUSES = new Set(["none", "awaiting_human", "backup_authorized"]);

export function allChecklistItems(step: StepCard): ChecklistItem[] {
	return [...step.todos, ...step.objectiveGates, ...step.judgmentGates];
}

export function checkWorkflowConsistency(input: ConsistencyInput): ConsistencyFinding[] {
	const findings: ConsistencyFinding[] = [];
	const { state, steps } = input;
	const stepIds = new Set(steps.map(step => step.id));

	if (state.schemaVersion > 2) {
		findings.push({
			code: "schema_unsupported",
			severity: "fail",
			message: `schema_version ${state.schemaVersion} is newer than supported (max 2)`,
		});
	} else if (state.schemaVersion < 2) {
		findings.push({
			code: "schema_legacy",
			severity: "warn",
			message: "legacy schema v1 · run workflow_migrate.sh apply",
		});
	}

	if (state.currentStep !== "-" && steps.length > 0 && !stepIds.has(state.currentStep)) {
		findings.push({
			code: "current_step_missing",
			severity: "fail",
			message: `current_step ${state.currentStep} not found in STEPS.md`,
		});
	}

	// Duplicate stable IDs across the whole plan.
	const seen = new Map<string, string>();
	for (const step of steps) {
		for (const item of allChecklistItems(step)) {
			if (!item.id) continue;
			const owner = seen.get(item.id);
			if (owner) {
				findings.push({
					code: "duplicate_id",
					severity: "fail",
					message: `duplicate work item ID ${item.id} (${owner} and ${step.id})`,
				});
			} else {
				seen.set(item.id, step.id);
			}
		}
	}

	const activeWork = state.currentWorkItemId !== "-" ? state.currentWorkItemId : undefined;
	if (activeWork) {
		if (!isValidWorkItemId(activeWork)) {
			findings.push({
				code: "work_item_id_invalid",
				severity: "fail",
				message: `current_work_item_id ${activeWork} does not match <step>.<D|O|J><n>`,
			});
		} else {
			const ownerStep = steps.find(step => allChecklistItems(step).some(item => item.id === activeWork));
			if (!ownerStep) {
				findings.push({
					code: "work_item_id_missing",
					severity: "fail",
					message: `current_work_item_id ${activeWork} not found in STEPS.md`,
				});
			} else {
				if (ownerStep.id !== state.currentStep) {
					findings.push({
						code: "work_item_wrong_step",
						severity: "fail",
						message: `current_work_item_id ${activeWork} belongs to ${ownerStep.id}, not current_step ${state.currentStep}`,
					});
				}
				const item = allChecklistItems(ownerStep).find(candidate => candidate.id === activeWork);
				if (item?.done && state.implementationStatus !== "complete") {
					findings.push({
						code: "work_item_already_checked",
						severity: "warn",
						message: `current_work_item_id ${activeWork} is already checked while work is active`,
					});
				}
				if (item && state.currentWorkItem !== "-" && normalizeWorkItemText(item.text) !== normalizeWorkItemText(state.currentWorkItem)) {
					findings.push({
						code: "work_item_text_mismatch",
						severity: "warn",
						message: `current_work_item text does not match ${activeWork}`,
					});
				}
			}
		}
	} else if (state.currentWorkItem !== "-" && state.currentStep !== "-") {
		// Legacy text-only linkage: conservative uniqueness check.
		const currentStep = steps.find(step => step.id === state.currentStep);
		const needle = normalizeWorkItemText(state.currentWorkItem);
		if (currentStep && needle) {
			const exact = currentStep.todos.filter(item => normalizeWorkItemText(item.text) === needle);
			if (exact.length === 0) {
				findings.push({
					code: "work_item_text_unresolved",
					severity: "warn",
					message: "current_work_item has no stable ID and matches no checklist item exactly",
				});
			}
		}
	}

	for (const completed of state.completedSteps) {
		if (steps.length > 0 && !stepIds.has(completed)) {
			findings.push({
				code: "completed_step_missing",
				severity: "warn",
				message: `completed step ${completed} not found in current plan`,
			});
			continue;
		}
		const step = steps.find(candidate => candidate.id === completed);
		if (step && step.objectiveGates.some(gate => !gate.done)) {
			findings.push({
				code: "completed_step_open_gates",
				severity: "warn",
				message: `completed step ${completed} still has open objective gates`,
			});
		}
	}

	if (!IMPLEMENTATION_STATUSES.has(state.implementationStatus)) {
		findings.push({
			code: "enum_invalid",
			severity: "warn",
			message: `unknown implementation.status "${state.implementationStatus}"`,
		});
	}
	if (state.reviewStatus !== "-" && !REVIEW_STATUSES.has(state.reviewStatus)) {
		findings.push({
			code: "enum_invalid",
			severity: "warn",
			message: `unknown review.status "${state.reviewStatus}"`,
		});
	}
	if (state.qaStatus !== "-" && !QA_STATUSES.has(state.qaStatus)) {
		findings.push({
			code: "enum_invalid",
			severity: "warn",
			message: `unknown qa.status "${state.qaStatus}"`,
		});
	}
	if (state.modelFailureStatus !== "-" && !MODEL_FAILURE_STATUSES.has(state.modelFailureStatus)) {
		findings.push({
			code: "enum_invalid",
			severity: "warn",
			message: `unknown omp.model_failure.status "${state.modelFailureStatus}"`,
		});
	}
	if (state.modelFailureStatus === "awaiting_human" && state.modelFailureRole === "-") {
		findings.push({
			code: "model_failure_incomplete",
			severity: "warn",
			message: "model_failure is awaiting_human but no role is recorded",
		});
	}

	if (input.hubActiveAgentConsistent === false) {
		findings.push({
			code: "active_agent_drift",
			severity: "warn",
			message: "omp.active_agent does not match any live hub worker",
		});
	}

	if (input.runtimeTodo?.available) {
		const link = linkRuntimeTodo(input.runtimeTodo, steps, state.currentStep !== "-" ? state.currentStep : undefined);
		for (const invalid of link.invalid) {
			findings.push({
				code: "runtime_todo_unknown_id",
				severity: "warn",
				message: `Runtime Todo references unknown item ${invalid}`,
			});
		}
	}

	return findings;
}
