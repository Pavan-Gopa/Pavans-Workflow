import assert from "node:assert/strict";
import {
	deriveDashboardViewModel,
	parseSteps,
	parseWorkflowState,
	type DashboardData,
	type RuntimeSnapshot,
} from "../lib/workflow-dashboard-core.ts";
import { renderExpandedDashboard } from "../lib/workflow-dashboard-viewport.ts";
import type { RuntimeTodoSnapshot } from "../lib/workflow-runtime-todo.ts";

const stepCards = Array.from({ length: 48 }, (_, index) => {
	const id = `S${index}`;
	const todos = index === 47
		? Array.from({ length: 60 }, (_unused, item) => `- [ ] [${id}.D${item + 1}] checklist item ${item + 1}`).join("\n")
		: `- [${index < 20 ? "x" : " "}] [${id}.D1] work item`;
	return `## ${id} — Step ${index}\n\n**Goal:** Exercise long dashboard rendering.\n\n**Do:**\n${todos}\n`;
}).join("\n");

const state = parseWorkflowState(`
schema_version: 2
current_step: S47
current_work_item_id: S47.D1
current_work_item: checklist item 1
step_description: Long dashboard fixture
completed_steps:
${Array.from({ length: 20 }, (_, index) => `  - S${index}`).join("\n")}
implementation:
  status: running
  attempts: 1
review:
  enabled: true
  status: pending
  verdict: null
security:
  next_run: none
retry_guard:
  repeated_failure_count: 0
  blocker: null
omp:
  active_agent: CoderLongDashboard
  active_role: coder
  interruption:
    status: none
  model_failure:
    status: none
    role: null
    human_instruction: null
next_actor: coder
track: IMPLEMENTATION
onboarding:
  status: complete
`);

const steps = parseSteps(stepCards);
assert.equal(steps.length, 48);
assert.equal(steps.at(-1)?.todos.length, 60);

const runtimeTodo: RuntimeTodoSnapshot = {
	available: true,
	source: "user_todo_edit",
	phases: [
		{
			name: "Implementation",
			tasks: Array.from({ length: 44 }, (_, index) => ({
				content: `[S47.D${Math.min(index + 1, 60)}] runtime todo ${index + 1}`,
				status: index === 0 ? "in_progress" as const : "pending" as const,
			})),
		},
	],
};

const data: DashboardData = { state, steps, runtimeTodo };
const runtime: RuntimeSnapshot = {
	worker: {
		id: "coder-long",
		agent: "workflow-coder",
		status: "running",
		startedAt: Date.now() - 60_000,
		resolvedModel: "openai-codex/gpt-5.6-luna",
	},
	mainStatus: "working",
	mainActivity: "Supervising long dashboard fixture",
};

const view = deriveDashboardViewModel(data, runtime, "S47", "both");
const rendered = renderExpandedDashboard(view, 160, 18, {
	status: "manual",
	url: "http://127.0.0.1:3847",
});
const text = rendered.lines.map(line => line.text).join("\n");

assert.equal(rendered.expanded, true);
assert.equal(rendered.maxDetailScroll, 0);
assert.doesNotMatch(text, /more detail lines?|\d+ earlier|\d+ later/);
for (let index = 0; index < 48; index += 1) assert.match(text, new RegExp(`\\bS${index}\\b`));
assert.match(text, /checklist item 60/);
assert.match(text, /runtime todo 44/);
assert.match(text, /RUN TODO/);

const shortView = deriveDashboardViewModel(
	{ ...data, steps: steps.slice(0, 3), state: { ...state, currentStep: "S2", currentWorkItemId: "S2.D1" }, runtimeTodo: { available: true, phases: [] } },
	{ ...runtime, worker: undefined },
	"S2",
	"both",
);
const shortRendered = renderExpandedDashboard(shortView, 160, 40);
assert.equal(shortRendered.expanded, false);

console.log("workflow-dashboard-viewport selftest: ok");
