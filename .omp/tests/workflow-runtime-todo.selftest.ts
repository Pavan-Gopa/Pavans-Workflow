import assert from "node:assert/strict";
import {
	linkRuntimeTodo,
	readRuntimeTodo,
	runtimeTodoCounts,
	type RuntimeTodoSnapshot,
} from "../lib/workflow-runtime-todo.ts";
import { parseSteps } from "../lib/workflow-dashboard-core.ts";

// Shapes below are grounded in real OMP 17.3.5 session JSONL entries:
//   message.role === "toolResult", toolName === "todo",
//   details: { op, phases: [{ name, tasks: [{ content, status, blocker? }] }], storage }
// Error results also carry details.phases (usually []) — the isError guard is
// what keeps them out.

const okResult = {
	type: "message",
	id: "a1",
	message: {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "todo",
		isError: false,
		details: {
			op: "init",
			phases: [
				{
					name: "Foundation",
					tasks: [
						{ content: "[S1.D1] Map the error path", status: "completed" },
						{ content: "[S1.D2] Change normalizeConfig", status: "in_progress" },
					],
				},
				{
					name: "Tests",
					tasks: [
						{ content: "[S1.D3] Add negative test", status: "pending" },
						{ content: "Run the suite", status: "pending" },
						{ content: "[S4.D9] Ghost reference", status: "blocked", blocker: "needs fixture" },
					],
				},
			],
			storage: "session",
		},
	},
};

const errorResult = {
	type: "message",
	id: "a2",
	message: {
		role: "toolResult",
		toolCallId: "call_2",
		toolName: "todo",
		isError: true,
		details: { phases: [], storage: "session" },
	},
};

const userEdit = {
	type: "custom",
	customType: "user_todo_edit",
	id: "a3",
	data: {
		phases: [
			{
				name: "Edited",
				tasks: [{ content: "[S1.D1] Human-edited task", status: "in_progress" }],
			},
		],
	},
};

// 1. Latest successful toolResult is read.
const basic = readRuntimeTodo([okResult]);
assert.equal(basic.available, true);
assert.equal(basic.source, "tool_result");
assert.equal(basic.phases.length, 2);
assert.equal(basic.phases[1].tasks[2].blocker, "needs fixture");

// 2. Error results are ignored even though they carry details.phases.
const afterError = readRuntimeTodo([okResult, errorResult]);
assert.equal(afterError.source, "tool_result");
assert.equal(afterError.phases.length, 2);

// 3. user_todo_edit takes priority over an older toolResult.
const edited = readRuntimeTodo([okResult, userEdit]);
assert.equal(edited.source, "user_todo_edit");
assert.equal(edited.phases[0].name, "Edited");

// 4. user_todo_edit with malformed data falls through to the toolResult.
const malformedEdit = readRuntimeTodo([okResult, { type: "custom", customType: "user_todo_edit", data: { phases: "nope" } }]);
assert.equal(malformedEdit.source, "tool_result");

// 5. Unknown structures never throw and report unavailable.
for (const entries of [undefined, null, "x", [], [{ type: "message", message: { role: "assistant" } }], [{ type: "custom", customType: "other" }]]) {
	assert.equal(readRuntimeTodo(entries).available, false);
}

// 6. Malformed phases (missing fields, unknown status) are rejected.
const badPhases = [
	{ phases: [{ name: "X" }] },
	{ phases: [{ name: "X", tasks: [{ content: "y" }] }] },
	{ phases: [{ name: "X", tasks: [{ content: "y", status: "exploded" }] }] },
	{ phases: [{ tasks: [] }] },
];
for (const details of badPhases) {
	const entry = { type: "message", message: { role: "toolResult", toolName: "todo", details } };
	assert.equal(readRuntimeTodo([entry]).available, false, JSON.stringify(details));
}

// 7. Counts treat completed and abandoned as done.
const counts = runtimeTodoCounts(basic);
assert.deepEqual(counts, { done: 1, total: 5 });
const withAbandoned: RuntimeTodoSnapshot = {
	available: true,
	phases: [{ name: "P", tasks: [{ content: "a", status: "abandoned" }, { content: "b", status: "pending" }] }],
};
assert.deepEqual(runtimeTodoCounts(withAbandoned), { done: 1, total: 2 });

// 8. Linkage: matched / run-only / step-only / invalid.
const steps = parseSteps(`
## S1 — Config import

**Do:**
- [x] [S1.D1] Map the error path
- [ ] [S1.D2] Change normalizeConfig
- [ ] [S1.D3] Add negative test
- [ ] [S1.D4] Document the contract

**Objective gates:**
- [ ] [S1.O1] tests exit 0

## S2 — Next step

**Do:**
- [ ] [S2.D1] Follow-up work
`);
assert.equal(steps[0].todos[0].id, "S1.D1");
assert.equal(steps[0].todos[0].text, "Map the error path");
assert.equal(steps[0].objectiveGates[0].id, "S1.O1");

const link = linkRuntimeTodo(basic, steps, "S1");
// matched: S1.D1, S1.D2, S1.D3; run-only: "Run the suite"; invalid: S4.D9.
assert.equal(link.matched, 3);
assert.equal(link.runOnly, 1);
assert.deepEqual(link.invalid, ["S4.D9"]);
// step-only: S1.D4 is open in the live step with no runtime task.
assert.equal(link.stepOnly, 1);

// 9. Selected step different from live step: step-only counts the live step only.
const linkOther = linkRuntimeTodo(basic, steps, "S2");
assert.equal(linkOther.stepOnly, 1); // S2.D1 open, unreferenced

// 10. Unavailable snapshot links to zeros.
assert.deepEqual(linkRuntimeTodo({ available: false, phases: [] }, steps, "S1"), {
	matched: 0,
	runOnly: 0,
	stepOnly: 0,
	invalid: [],
});

// 11. Multiple in_progress items are all preserved.
const multiActive = readRuntimeTodo([
	{
		type: "message",
		message: {
			role: "toolResult",
			toolName: "todo",
			details: { phases: [{ name: "P", tasks: [{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }] }] },
		},
	},
]);
assert.equal(multiActive.phases[0].tasks.filter(task => task.status === "in_progress").length, 2);

console.log("workflow runtime todo selftest: PASS");
console.log("  sources: toolResult priority, user_todo_edit override, error results ignored");
console.log("  robustness: malformed phases, unknown entries, unavailable snapshots");
console.log("  linkage: matched, run-only, step-only, invalid IDs, live vs selected step");
