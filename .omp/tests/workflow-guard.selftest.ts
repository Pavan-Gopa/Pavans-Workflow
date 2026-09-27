import assert from "node:assert/strict";
import {
	backupAuthorization,
	editedPaths,
	GuardTracker,
	guardMessage,
	guardRole,
	isBackupAgent,
	parseVerdict,
} from "../lib/workflow-guard.ts";

// Roles: workflow agents map to guard roles; anything else is read-only "unknown".
assert.equal(guardRole("workflow-coder"), "coder");
assert.equal(guardRole("workflow-coder-backup"), "coder");
assert.equal(guardRole("workflow-design-advisor"), "design_advisor");
assert.equal(guardRole("workflow-designer-backup"), "designer");
assert.equal(guardRole("explore"), "unknown");
assert.equal(isBackupAgent("workflow-tester-backup"), true);
assert.equal(isBackupAgent("workflow-tester"), false);

// Backup workers need a recorded Human authorization in STATE.yaml.
const noFailure = "omp:\n  model_failure:\n    status: none\n";
assert.deepEqual(backupAuthorization(noFailure, "workflow-coder"), { allowed: true }, "primaries are never blocked");
const blocked = backupAuthorization(noFailure, "workflow-coder-backup");
assert.equal(blocked.allowed, false);
assert.match((blocked as { reason: string }).reason, /backup_authorized/);
const awaiting = "omp:\n  model_failure:\n    status: awaiting_human\n    role: coder\n";
assert.equal(backupAuthorization(awaiting, "workflow-coder-backup").allowed, false, "awaiting_human is not an authorization");
const authorizedByAgent =
	'omp:\n  model_failure:\n    status: backup_authorized\n    role: coder\n    backup_agent: workflow-coder-backup\n    human_instruction: "use the backup"\n';
assert.equal(backupAuthorization(authorizedByAgent, "workflow-coder-backup").allowed, true);
assert.equal(backupAuthorization(authorizedByAgent, "workflow-reviewer-backup").allowed, false, "authorization is per role");
const authorizedByRole = "omp:\n  model_failure:\n    status: backup_authorized\n    role: tester\n    backup_agent: null\n";
assert.equal(backupAuthorization(authorizedByRole, "workflow-tester-backup").allowed, true);
assert.equal(backupAuthorization("", "workflow-security-backup").allowed, false, "missing state never authorizes");

// Tracker: FIFO per agent, Main edits remembered only while a worker runs.
const tracker = new GuardTracker();
tracker.recordMainEdit("ignored.md");
assert.deepEqual(tracker.takeMainEdits(), [], "no worker running -> nothing recorded");
tracker.open("workflow-coder", "s1");
tracker.open("workflow-coder", "s2");
tracker.recordMainEdit("AI_Workflow_Kit/docs/AI/STATE.yaml");
assert.equal(tracker.active(), true);
assert.equal(tracker.close("workflow-coder"), "s1");
assert.deepEqual(tracker.takeMainEdits(), ["AI_Workflow_Kit/docs/AI/STATE.yaml"], "still running: edits kept");
assert.equal(tracker.close("workflow-coder"), "s2");
assert.equal(tracker.close("workflow-coder"), undefined);
assert.deepEqual(tracker.takeMainEdits(), ["AI_Workflow_Kit/docs/AI/STATE.yaml"]);
assert.deepEqual(tracker.takeMainEdits(), [], "cleared once no worker remains");

assert.deepEqual(editedPaths("write", { path: "a.ts", content: "x" }), ["a.ts"]);
assert.deepEqual(editedPaths("edit", { path: "b.ts", edits: [{ path: "c.ts" }, {}] }), ["b.ts", "c.ts"]);
assert.deepEqual(editedPaths("bash", { command: "echo > d" }), [], "bash writes cannot be attributed");

// Messages for Main.
assert.equal(guardMessage({ verdict: "clean" }), undefined);
const violation = guardMessage({
	verdict: "violation",
	agent: "workflow-reviewer",
	step: "S3",
	violations: [{ path: "src/app.ts", reason: "reviewer is read-only" }],
});
assert.match(violation ?? "", /Do not accept this worker result/);
assert.match(violation ?? "", /src\/app\.ts: reviewer is read-only/);
assert.match(guardMessage({ verdict: "unscoped", agent: "workflow-coder", changed: ["x.ts"] }) ?? "", /target_files was empty/);
assert.equal(parseVerdict("not json"), undefined);
assert.equal(parseVerdict('{"verdict":"clean"}')?.verdict, "clean");

console.log("OK workflow guard extension logic selftest");
