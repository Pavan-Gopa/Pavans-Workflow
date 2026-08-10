import assert from "node:assert/strict";
import {
	SessionUsageTracker,
	deriveDashboardViewModel,
	displayWidth,
	parseSteps,
	parseWorkflowState,
	renderDashboard,
	type DashboardData,
	type MetricsReport,
} from "../lib/workflow-dashboard-core.ts";

const stateSource = `
project_prefix: fixture
current_step: WP-13
current_work_item: Remove provider quota code
step_description: >-
  Replace the stale dashboard with the live control surface.
completed_steps:
  - WP-01
  - W-08
implementation:
  status: running
  attempts: 2
review:
  enabled: true
  status: pending
  verdict: null
qa:
  enabled: true
  status: pending
security:
  next_run: none
retry_guard:
  repeated_failure_count: 0
  blocker: null
omp:
  active_agent: CoderS13Run01
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
`;

const stepsSource = `
# Step cards

## S0 — _(title)_

**Goal:** placeholder

**Do:**
1. placeholder

## WP-01 — Bootstrap release

**Goal:** Establish the workflow.

**Do:**
- [x] Install the workflow
- [x] Verify onboarding

**Objective gates:**
- [x] Bootstrap works

## W-08 — Search refactor

**Goal:** Improve search.

**Do:**
1. Remove old search
2. Add focused regression verification

**Done when:**
- [x] Search is fast

## WP-13 — Torrent UI rates

**Goal:** Build a responsive live board that keeps a very long Unicode title 你好世界 visible without breaking borders.

**Depends on:** WP-01

**Do:**
- [x] Keep Alt-A and Alt-W separate
- [ ] Remove provider quota code
- [ ] Fix parser and checklist behavior
- [ ] Build responsive wide medium narrow layouts
- [ ] Capture real per-model session tokens
- [ ] Verify downstream findings reopen TODO items

**Objective gates:**
- [x] Existing workflow state remains canonical
- [ ] Dashboard smoke passes

**Judgment gates:**
- [ ] Main verification confirms live behavior

## release-2 — Packaging

**Goal:** Package the result.

**Do:**
* [ ] Create release archive

## feature/auth — Authentication

**Goal:** Add authentication.

**Do:**
- Design contract
- Implement contract
`;

const state = parseWorkflowState(stateSource);
const steps = parseSteps(stepsSource);
assert.equal(state.currentStep, "WP-13");
assert.equal(state.currentWorkItem, "Remove provider quota code");
assert.equal(state.implementationAttempts, 2);
assert.equal(state.modelFailureStatus, "none");
assert.deepEqual(steps.map(step => step.id), ["WP-01", "W-08", "WP-13", "release-2", "feature/auth"]);
assert.equal(steps[0].todos.filter(item => item.done).length, 2);
assert.equal(steps[1].todos.length, 2);
assert.equal(steps[1].todos.every(item => !item.canonical), true);
assert.equal(steps[1].todos.every(item => !item.done), true);
assert.equal(steps[2].todos.length, 6);
assert.equal(steps[4].todos.length, 2);

const metrics: MetricsReport = {
	storage: { data_since: "2026-08-10T00:00:00Z", valid_events: 72 },
	summary: {
		completed_steps: 8,
		completed_product_steps: 8,
		first_pass_step_success: { count: 18, total: 25, rate_pct: 72 },
		average_coder_attempts: 1.3,
		reviewer_rejection: { count: 9, total: 31, rate_pct: 29 },
		qa_escape: { count: 1, total: 25, rate_pct: 4 },
		repeated_failure_incidents: 1,
		runtime_interruption: { count: 2, total: 35, rate_pct: 5.7 },
		model_failure: { count: 1, total: 35, rate_pct: 2.9 },
	},
	step_stats: {
		"WP-13": {
			status: "in_progress",
			started_at: "2026-08-10T00:00:00Z",
			completed_at: null,
			duration_ms: 252_000,
			coder_attempts: 2,
			product_reviews: { runs: 1, approved: 0, changes_requested: 1 },
			qa_runs: { runs: 1, qa_green: 0, bugs: 1 },
			architect_modes: {},
			failure_count: 1,
			runtime_interruptions: 1,
			gate_skips: {},
			human_rating: "good",
			models: [{ role: "coder", provider: "openai-codex", model: "gpt-5.6-luna", runs: 2 }],
		},
	},
	role_stats: {
		coder: {
			runs: 35,
			verified_results: 31,
			results: { waiting_review: 31, blocked: 4 },
			median_duration_ms: 222_000,
			first_review_approval: { count: 18, total: 25, rate_pct: 72 },
		},
	},
	failure_categories: { missed_requirement: 8, incorrect_implementation: 5 },
	detected_by: { reviewer: 12, tester: 5, orchestrator: 3 },
	model_samples: [
		{
			role: "coder",
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			runs: 2,
			median_duration_ms: 222_000,
			first_review_approval: { count: 1, total: 2, rate_pct: 50 },
			sample_warning: "small sample",
		},
	],
};

const tracker = new SessionUsageTracker();
tracker.recordAssistantMessage(
	{
		role: "assistant",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		timestamp: 1,
		responseId: "main-1",
		usage: { input: 100, output: 50, cacheWrite: 20, totalTokens: 999 },
	},
	"orchestrator",
	"main-1",
);
tracker.recordAssistantMessage(
	{
		role: "assistant",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		timestamp: 1,
		responseId: "main-1",
		usage: { input: 100, output: 50, cacheWrite: 20 },
	},
	"orchestrator",
	"main-1",
);
tracker.recordAssistantMessage(
	{
		role: "assistant",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		timestamp: 2,
		responseId: "main-2",
		usage: { output: 10 },
	},
	"orchestrator",
	"main-2",
);
tracker.recordWorkerProgress({ id: "coder-1", agent: "workflow-coder", tokens: 100, requests: 1 });
tracker.recordWorkerProgress({ id: "coder-1", agent: "workflow-coder", tokens: 150, requests: 2, resolvedModel: "anthropic/claude-opus-5:high" });
tracker.recordWorkerProgress({ id: "coder-1", agent: "workflow-coder", tokens: 150, requests: 2, resolvedModel: "anthropic/claude-opus-5:high" });
tracker.recordWorkerProgress({ id: "coder-1", agent: "workflow-coder", tokens: 200, requests: 3, resolvedModel: "anthropic/claude-opus-5:high" });
tracker.recordWorkerProgress({ id: "review-1", agent: "workflow-reviewer", tokens: 30, requests: 1, resolvedModel: "google/gemini-3.6-flash" });
const usage = tracker.snapshot();
assert.equal(usage.totalTokens, 410);
assert.deepEqual(usage.models.map(model => model.model), [
	"openai-codex/gpt-5.6-sol",
	"anthropic/claude-opus-5",
	"google/gemini-3.6-flash",
]);
assert.equal(usage.models[0].roles.orchestrator, 180);
assert.equal(usage.models[1].roles.coder, 200);
assert.equal(usage.models[1].requests, 3);
assert.equal(usage.models[2].roles.reviewer, 30);

metrics.role_stats = {
	...metrics.role_stats,
	reviewer: {
		runs: 31,
		verified_results: 31,
		results: { approved: 22, changes_requested: 9, blocked: 0 },
		median_duration_ms: 208_000,
		product_rejection: { count: 9, total: 31, rate_pct: 29 },
	},
	tester: {
		runs: 28,
		verified_results: 28,
		results: { qa_green: 26, bugs: 2, blocked: 0 },
		median_duration_ms: 221_000,
	},
	architect: {
		runs: 7,
		verified_results: 7,
		results: { design_ready: 2, advice_ready: 3 },
		median_duration_ms: 390_000,
		modes: { advisory: 3, design: 2, grilling: 2 },
	},
	security: {
		runs: 2,
		verified_results: 2,
		results: { security_clean: 1, findings_open: 1 },
		median_duration_ms: 420_000,
	},
};
metrics.model_samples?.push(
	{ role: "reviewer", provider: "google", model: "gemini-3.6-flash", runs: 6, median_duration_ms: 208_000 },
	{ role: "tester", provider: "openai", model: "gpt-5.6-max", runs: 5, median_duration_ms: 221_000 },
	{ role: "architect", provider: "anthropic", model: "claude-opus-5", runs: 3, median_duration_ms: 390_000, sample_warning: "small sample" },
	{ role: "security", provider: "zai", model: "glm-5.2", runs: 2, median_duration_ms: 420_000, sample_warning: "small sample" },
);
metrics.step_stats = {
	...metrics.step_stats,
	"W-08": {
		status: "completed",
		started_at: "2026-08-09T00:00:00Z",
		completed_at: "2026-08-09T00:10:00Z",
		duration_ms: 600_000,
		coder_attempts: 1,
		product_reviews: { runs: 1, approved: 1, changes_requested: 0 },
		qa_runs: { runs: 1, qa_green: 1, bugs: 0 },
		architect_modes: {},
		failure_count: 0,
		runtime_interruptions: 0,
		gate_skips: {},
		human_rating: "good",
		models: [
			{ role: "coder", provider: "openai-codex", model: "gpt-5.6-luna", runs: 1 },
			{ role: "reviewer", provider: "google", model: "gemini-3.6-flash", runs: 1 },
		],
	},
};

const data: DashboardData = { state, steps, metrics, sessionUsage: usage };
const runtime: RuntimeSnapshot = {
	worker: {
		id: "coder-1",
		agent: "workflow-coder",
		status: "running",
		startedAt: Date.now() - 222_000,
		durationMs: 222_000,
		resolvedModel: "openai-codex/gpt-5.6-luna:high",
	},
	mainModel: "openai-codex/gpt-5.6-sol",
	mainStatus: "working",
	mainActivity: "Supervising the active worker",
};

const currentView = deriveDashboardViewModel(data, runtime);
assert.equal(currentView.relation, "current");
assert.equal(currentView.status, "Coder running");
assert.match(currentView.nextAction, /Wait for Coder result/);

for (const [width, expectedLayout] of [[160, "wide"], [120, "medium"], [80, "narrow"]] as const) {
	const rendered = renderDashboard(currentView, width, 34);
	assert.equal(rendered.layout, expectedLayout);
	for (const line of rendered.lines) assert.equal(displayWidth(line.text), width, `${expectedLayout}: ${line.text}`);
	const text = rendered.lines.map(line => line.text).join("\n");
	assert.match(text, /THIS OMP SESSION/);
	assert.match(text, /410 tok/);
	assert.doesNotMatch(text, /PROVIDER QUOTA|MODEL PAIRS/);
}

const wideText = renderDashboard(currentView, 160, 34).lines.map(line => line.text).join("\n");
assert.match(wideText, /PLAN\s+\|CURRENT STEP\s+\|STATISTICS/);
assert.match(wideText, /Remove provider quota code/);
assert.match(wideText, /CURRENT ROLE · CODER/);
assert.match(wideText, /CURRENT MODEL · GPT 5.6 Luna/);

assert.doesNotMatch(wideText, /#1|leaderboard|quality score/i);
const completedView = deriveDashboardViewModel(data, runtime, "W-08");
assert.equal(completedView.relation, "completed");
const completedText = renderDashboard(completedView, 160, 38).lines.map(line => line.text).join("\n");
assert.match(completedText, /RESULT · Completed Stop-gate/);
assert.match(completedText, new RegExp("openai-codex/gpt-5\\.6-luna"));
assert.doesNotMatch(completedText, /ACTIVE · Coder/);
assert.match(completedText, /Legacy Do list/);

const futureView = deriveDashboardViewModel(data, { ...runtime, worker: undefined }, "release-2");
assert.equal(futureView.relation, "planned");
assert.match(renderDashboard(futureView, 160, 30).lines.map(line => line.text).join("\n"), /Planned · no execution data yet/);

const changedState = { ...state, implementationStatus: "waiting_review", reviewStatus: "changes_requested", reviewVerdict: "changes_requested", nextActor: "coder" };
const reopened = deriveDashboardViewModel({ ...data, state: changedState }, { ...runtime, worker: undefined });
assert.match(reopened.nextAction, /reopens affected TODO/);

const blockedState = { ...state, blocker: "Repeated failure on current approach", nextActor: "architect" };
const blocked = deriveDashboardViewModel({ ...data, state: blockedState }, { ...runtime, worker: undefined });
assert.equal(blocked.status, "Blocked");
assert.match(renderDashboard(blocked, 80, 28).lines.map(line => line.text).join("\n"), /BLOCKED/);

const unavailable = deriveDashboardViewModel(
	{ ...data, metrics: undefined, metricsError: "store unavailable" },
	{ ...runtime, worker: undefined },
);
const unavailableText = renderDashboard(unavailable, 120, 30).lines.map(line => line.text).join("\n");
assert.match(unavailableText, /Canonical metrics unavailable/);
assert.match(unavailableText, /THIS OMP SESSION/);

const mainOnly = deriveDashboardViewModel(data, { ...runtime, worker: undefined, mainActivity: "Ready for instruction or the next transition" });
const mainOnlyText = renderDashboard(mainOnly, 160, 34).lines.map(line => line.text).join("\n");
assert.match(mainOnlyText, /MAIN · GPT 5.6 Sol/);
assert.doesNotMatch(mainOnlyText, /CURRENT ROLE/);
assert.doesNotMatch(mainOnlyText, /ACTIVE ·/);

const exactMismatch = deriveDashboardViewModel(
	data,
	{ ...runtime, worker: { ...runtime.worker!, resolvedModel: "openai-codex/gpt-5.6-luna-plus" } },
);
const mismatchText = renderDashboard(exactMismatch, 160, 40).lines.map(line => line.text).join("\n");
assert.doesNotMatch(mismatchText, /CURRENT MODEL ·/);

for (const [role, agent, model, expected] of [
	["reviewer", "workflow-reviewer", "google/gemini-3.6-flash", "Product rejection"],
	["tester", "workflow-tester", "openai/gpt-5.6-max", "Green 26 · Bugs 2"],
	["architect", "workflow-architect", "anthropic/claude-opus-5", "Advisory 3 · Design 2 · Grilling 2"],
	["security", "workflow-security", "zai/glm-5.2", "Clean 1 · Findings 1"],
] as const) {
	const roleView = deriveDashboardViewModel(
		{ ...data, state: { ...state, nextActor: role } },
		{ ...runtime, worker: { ...runtime.worker!, agent, resolvedModel: model } },
	);
	const roleText = renderDashboard(roleView, 160, 48).lines.map(line => line.text).join("\n");
	assert.match(roleText, new RegExp(`CURRENT ROLE · ${role.toUpperCase()}`));
	assert.match(roleText, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(roleText, /CURRENT MODEL ·/);
}

const waitingState = {
	...state,
	nextActor: "human",
	modelFailureStatus: "awaiting_human",
	modelFailureRole: "coder",
	modelFailureInstruction: "Choose Coder backup or change the model",
};
const waiting = deriveDashboardViewModel({ ...data, state: waitingState }, { ...runtime, worker: undefined });
const waitingText = renderDashboard(waiting, 80, 28).lines.map(line => line.text).join("\n");
assert.equal(waiting.status, "Waiting for Human");
assert.match(waitingText, /NEXT ACTION · Choose Coder backup/);

const freshMetrics: MetricsReport = {
	storage: { data_since: null, valid_events: 0 },
	summary: { completed_product_steps: 0 },
	role_stats: {},
	step_stats: {},
	failure_categories: {},
	detected_by: {},
	model_samples: [],
};
const collecting = deriveDashboardViewModel({ ...data, metrics: freshMetrics }, { ...runtime, worker: undefined });
assert.match(renderDashboard(collecting, 160, 34).lines.map(line => line.text).join("\n"), /Collecting data · 0 completed steps/);
assert.match(wideText, /small sample/);

const fifteenSource = Array.from({ length: 15 }, (_, index) => {
	const ordinal = index + 1;
	const id = `WP-${String(ordinal).padStart(2, "0")}`;
	const title = ordinal === 15
		? "Release packaging with a deliberately long title 你好世界 that must never break a border"
		: `Step ${ordinal}`;
	const todo = ordinal === 8
		? [
			"- [x] Remove obsolete provider quota implementation",
			"- [x] Parse generic step identifiers",
			"- [x] Preserve Alt-A Agent Hub behavior",
			"- [ ] Build the responsive live task board",
			"- [ ] Verify every acceptance fixture",
			"- [ ] Publish the verified result",
		].join("\n")
		: "- [ ] Complete this planned step";
	return `## ${id} — ${title}\n\n**Goal:** Goal for ${id}.\n\n**Depends on:** ${ordinal === 1 ? "none" : `WP-${String(ordinal - 1).padStart(2, "0")}`}\n\n**Do:**\n${todo}\n\n**Objective gates:**\n- [ ] command exits 0\n\n**Judgment gates:**\n- [ ] intended semantics hold\n`;
}).join("\n");
const fifteenSteps = parseSteps(fifteenSource);
assert.equal(fifteenSteps.length, 15);
const fifteenState = {
	...state,
	currentStep: "WP-08",
	currentWorkItem: "Build the responsive live task board",
	completedSteps: Array.from({ length: 7 }, (_, index) => `WP-${String(index + 1).padStart(2, "0")}`),
};
const fifteenData: DashboardData = { ...data, state: fifteenState, steps: fifteenSteps };
const fifteenView = deriveDashboardViewModel(fifteenData, runtime);
const fifteenRendered = renderDashboard(fifteenView, 160, 34);
const fifteenText = fifteenRendered.lines.map(line => line.text).join("\n");
assert.match(fifteenText, /Step 8 \/ 15/);
assert.match(fifteenText, /7 complete · 8 remaining/);
assert.match(fifteenText, /TODO · 3 \/ 6 verified/);
assert.match(fifteenText, /● Build the responsive live task board/);

const shortPlan = renderDashboard(fifteenView, 160, 12);
assert.match(shortPlan.lines.map(line => line.text).join("\n"), /↑ \d+ earlier/);
assert.match(shortPlan.lines.map(line => line.text).join("\n"), /↓ \d+ later/);
const scrolledDetail = renderDashboard(fifteenView, 160, 12, 4);
assert.ok(scrolledDetail.maxDetailScroll > 0);
assert.match(scrolledDetail.lines.map(line => line.text).join("\n"), /↑ \d+ detail line/);
for (const line of renderDashboard(fifteenView, 160, 34).lines) assert.equal(displayWidth(line.text), 160);

const todosBeforeWorkerResult = fifteenSteps[7].todos.map(item => ({ ...item }));
deriveDashboardViewModel(
	fifteenData,
	{ ...runtime, worker: { ...runtime.worker!, status: "completed" } },
);
assert.deepEqual(fifteenSteps[7].todos, todosBeforeWorkerResult);

const sourceWithReopenedItem = fifteenSource.replace(
	"- [ ] Build the responsive live task board",
	"- [x] Build the responsive live task board",
);
const completedTodo = parseSteps(sourceWithReopenedItem)[7];
assert.equal(completedTodo.todos[3].done, true);
const reopenedSource = sourceWithReopenedItem.replace(
	"- [x] Build the responsive live task board",
	"- [ ] Build the responsive live task board",
);
const reopenedTodo = parseSteps(reopenedSource)[7];
assert.equal(reopenedTodo.todos[3].done, false);

const outsidePlanState = { ...fifteenState, completedSteps: [...fifteenState.completedSteps, "OLD-99"] };
const outsidePlan = deriveDashboardViewModel({ ...fifteenData, state: outsidePlanState }, runtime);
assert.match(renderDashboard(outsidePlan, 160, 34).lines.map(line => line.text).join("\n"), /completed outside current plan/);

const parserFailure = deriveDashboardViewModel(
	{
		state: parseWorkflowState(""),
		steps: [],
		stateError: "STATE.yaml unreadable",
		stepsError: "STEPS.md malformed",
		metrics,
		sessionUsage: usage,
	},
	{ ...runtime, worker: undefined },
);
const parserFailureText = renderDashboard(parserFailure, 80, 24).lines.map(line => line.text).join("\n");
assert.match(parserFailureText, /STATE.yaml/);
assert.match(parserFailureText, /STEPS.md/);

if (process.env.WORKFLOW_DASHBOARD_MOCKUPS === "1") {
	for (const [label, view] of [
		["NORMAL CURRENT", mainOnly],
		["ACTIVE WORKER", currentView],
		["WAITING FOR HUMAN", waiting],
		["HISTORICAL SELECTION", completedView],
	] as const) {
		console.log(`\n### ${label}\n`);
		console.log(renderDashboard(view, 160, 18).lines.map(line => line.text).join("\n"));
	}
}

console.log("workflow dashboard selftest: PASS");
console.log("  parser: generic IDs, template filtering, checkbox and legacy Do items");
console.log("  state: current, historical, future, blocker, and reopen semantics");
console.log("  telemetry: Main/worker per-model tokens without duplicate progress counting");
console.log("  rendering: exact 160/120/80-column borders and responsive layouts");
