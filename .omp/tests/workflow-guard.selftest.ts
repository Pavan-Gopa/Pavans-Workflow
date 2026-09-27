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
const designAdvisorRole = "omp:\n  model_failure:\n    status: backup_authorized\n    role: design_advisor\n";
assert.equal(backupAuthorization(designAdvisorRole, "workflow-design-advisor-backup").allowed, true, "role spelling is normalized");
assert.equal(backupAuthorization("", "workflow-security-backup").allowed, false, "missing state never authorizes");

// Tracker: spawnKey binding, aborted spawns, follow-up turns, Main edits.
const tracker = new GuardTracker();
tracker.recordMainEdit("ignored.md");
assert.deepEqual(tracker.takeMainEdits(), [], "no worker running -> nothing recorded");
tracker.open("workflow-coder", "snap-aborted", "job-0", 1);
tracker.open("workflow-coder", "snap-1", "job-1", 2);
assert.equal(tracker.bind("job-1", "workflow-coder"), true, "bound by spawnKey (= async job id)");
tracker.recordMainEdit("AI_Workflow_Kit/docs/AI/STATE.yaml");
assert.equal(tracker.close("job-1", "workflow-coder"), "snap-1");
assert.equal(tracker.close("job-0", "workflow-coder"), undefined, "the older spawn never started and was dropped on bind");
assert.deepEqual(tracker.takeMainEdits(), ["AI_Workflow_Kit/docs/AI/STATE.yaml"]);
assert.deepEqual(tracker.takeMainEdits(), [], "cleared once no worker remains");

// A spawn that never started is dropped when the next run of that agent binds.
tracker.open("workflow-reviewer", "snap-never-started", undefined, 10);
tracker.open("workflow-reviewer", "snap-real", undefined, 11);
assert.equal(tracker.bind("run-9", "workflow-reviewer"), true);
assert.equal(tracker.close("run-9", "workflow-reviewer"), "snap-real");
assert.equal(tracker.close(undefined, "workflow-reviewer"), undefined, "stale snapshot was discarded");

// Follow-up turn: started without a spawn -> caller must snapshot.
assert.equal(tracker.bind("run-parked", "workflow-tester"), false);

assert.deepEqual(editedPaths("write", { path: "a.ts", content: "x" }), ["a.ts"]);
assert.deepEqual(editedPaths("edit", { path: "b.ts", edits: [{ path: "c.ts" }, { rename: "d.ts" }, {}] }), ["b.ts", "c.ts", "d.ts"]);
assert.deepEqual(
	editedPaths("edit", { input: "*** Begin Patch\n[src/app.ts#1a2B]\nPUT 3.=3:\n+x\n[\"docs/my file.md\"#ffff]\nMV docs/renamed.md\n+[not/a/header]\n*** End Patch\n" }),
	["src/app.ts", "docs/my file.md", "docs/renamed.md"],
	"hashline mode (OMP default)",
);
assert.deepEqual(
	editedPaths("edit", { input: "*** Begin Patch\n*** Update File: src/a.py\n*** Move to: src/b.py\n*** Add File: new.txt\n*** End Patch\n" }),
	["src/a.py", "src/b.py", "new.txt"],
	"apply_patch mode",
);
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
