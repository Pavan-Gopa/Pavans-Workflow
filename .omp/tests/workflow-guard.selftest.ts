import assert from "node:assert/strict";
import {
	backupAuthorization,
	blockReason,
	editedPaths,
	GuardTracker,
	gitStateCommands,
	guardMessage,
	guardRole,
	isBackupAgent,
	isMainSession,
	isWorkerSession,
	lspWrite,
	parseAllow,
	parseVerdict,
	ShellWindows,
	targetsSessionDirectory,
} from "../lib/workflow-guard.ts";

// Roles: workflow agents map to guard roles; anything else is "unknown" and not guarded.
assert.equal(guardRole("workflow-coder"), "coder");
assert.equal(guardRole("workflow-coder-backup"), "coder");
assert.equal(guardRole("workflow-design-advisor"), "design_advisor");
assert.equal(guardRole("workflow-designer-backup"), "designer");
assert.equal(guardRole("explore"), "unknown");
assert.equal(isBackupAgent("workflow-tester-backup"), true);
assert.equal(isBackupAgent("workflow-tester"), false);

// Main vs worker session: agent identity decides; hasUI only without it.
assert.equal(isMainSession({ kind: "main" }, false), true, "headless Main (print/RPC) is still Main");
assert.equal(isMainSession({ kind: "sub" }, true), false, "a worker never counts as Main");
assert.equal(isMainSession(undefined, true), true);
assert.equal(isMainSession(undefined, false), false);
assert.equal(isWorkerSession({ kind: "sub", id: "0-WorkflowCoder", name: "workflow-coder" }), true);
assert.equal(isWorkerSession({ kind: "sub", id: "0-Scout", name: "scout" }), false, "OMP's own agents are not workflow workers");
assert.equal(isWorkerSession({ kind: "sub", id: "tan-1", name: "sub" }), false, "/tan clones are not workers");
assert.equal(isWorkerSession({ kind: "main", id: "Main", name: "main" }), false);
assert.equal(isWorkerSession(undefined), false);

// Backup workers need a recorded primary failure authorization in STATE.yaml.
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

// A worker session finds its snapshot by its agent id (= lifecycle id).
tracker.open("workflow-coder", "snap-live", "job-live", 20);
assert.equal(tracker.snapshotFor("job-live"), "snap-live", "before `started`, by spawn key");
tracker.bind("run-live", "workflow-coder");
assert.equal(tracker.snapshotFor("run-live"), "snap-live");
assert.equal(tracker.snapshotFor("someone-else"), undefined);
assert.equal(tracker.close("run-live", "workflow-coder"), "snap-live");

// Shell windows: merged per run, forgotten once taken, open commands end at take time.
const windows = new ShellWindows();
windows.start("run-a", "c1", 1_000);
windows.end("c1", 2_000);
windows.start("run-a", "c2", 3_000);
windows.end("c2", 4_000);
windows.start("run-a", "c3", 10_000);
windows.end("c3", 11_000);
windows.start("run-b", "c4", 1_500);
windows.start("run-a", "c5", 20_000);
assert.deepEqual(windows.take("run-a", 25_000), [[1_000, 4_000], [10_000, 11_000], [20_000, 25_000]]);
assert.deepEqual(windows.take("run-a"), [], "taken once");
windows.end("c4", 1_700);
assert.deepEqual(windows.take("run-b"), [[1_500, 1_700]], "runs are kept apart");
assert.deepEqual(windows.take(undefined), []);

// git commands that change repository state are found with where they run.
const cwd = "/work/proj";
const first = (command: string, bashCwd?: string) => gitStateCommands(command, cwd, bashCwd)[0];
const certain = [
	"git commit -m 'x'",
	"git add -A && git commit -m wip",
	"npm test && git push origin HEAD",
	"git -c core.pager=cat checkout main",
	"git --no-pager stash",
	"git stash pop",
	"git reset --hard HEAD~1",
	"git restore src/app.ts",
	"git clean -fdx",
	"git switch -c feature",
	"git branch -D old",
	"git branch feature-x",
	"git tag v1.0.0",
	"git tag -d v1.0.0",
	"FOO=1 git rebase -i HEAD~3",
	"sudo git merge dev",
	"sudo -u me git commit -m x",
	"nice -n 5 git commit -m x",
	"bash -lc 'git commit -am x'",
	"echo $(git stash) done",
	"if true; then git cherry-pick abc; fi",
	"bash <<'EOF'\ngit commit -m from-heredoc\nEOF",
	"git worktree add ../wt",
	"git apply fix.patch",
	"/usr/bin/git update-ref refs/heads/x HEAD",
	"timeout 30 git pull --rebase",
	"timeout -s KILL 30 git pull",
	"git ls-files -m | xargs git add",
	"git ls-files -d | xargs -n 1 git rm",
	"find . -name '*.orig' -exec git rm {} +",
	'cd "$(git rev-parse --show-toplevel)" && git add -A && git commit -m x',
	'git -C "$(pwd)" commit -m x',
	"cd $PWD && git commit -m x",
	"git init && git commit -m x",
];
for (const command of certain) {
	const found = first(command);
	assert.ok(found && targetsSessionDirectory(found, cwd), `must block without asking git: ${command} -> ${JSON.stringify(found)}`);
}
assert.equal(first("git commit -m x")?.command, "git commit -m x");

// Elsewhere: the extension compares the target repository with the session's.
assert.deepEqual(first("cd src && git rm old.ts"), { command: "git rm old.ts", dir: "/work/proj/src" });
assert.deepEqual(first("git -C src checkout -- ."), { command: "git checkout -- .", dir: "/work/proj/src" });
assert.deepEqual(first('cd "$PWD/src" && git add x'), { command: "git add x", dir: "/work/proj/src" });
assert.deepEqual(first("cd .. && git commit -am x"), { command: "git commit -am x", dir: "/work" });
assert.deepEqual(first("git -C /tmp/fixture commit -m x"), { command: "git commit -m x", dir: "/tmp/fixture" });
assert.deepEqual(first("env -C /tmp/fx git commit -m x"), { command: "git commit -m x", dir: "/tmp/fx" });
assert.deepEqual(first("GIT_DIR=/tmp/x.git git update-ref refs/heads/a HEAD"), { command: "git update-ref refs/heads/a HEAD", gitDir: "/tmp/x.git" });
assert.deepEqual(first("GIT_DIR=.git git commit -m x"), { command: "git commit -m x", gitDir: "/work/proj/.git" });
assert.deepEqual(first("git commit -m x", "/tmp/fixture"), { command: "git commit -m x", dir: "/tmp/fixture" }, "the bash tool's cwd argument");
assert.deepEqual(first("git commit -m x", "sub"), { command: "git commit -m x", dir: "/work/proj/sub" });
assert.equal(targetsSessionDirectory({ command: "git add x", dir: "/work/proj/src" }, cwd), false);
assert.deepEqual(
	first('cd "$(git rev-parse --show-toplevel)" && git commit -qm fx', "/tmp/fx/sub"),
	{ command: "git commit -qm fx", dir: "/tmp/fx/sub" },
	"the top level of the repository the shell is in, which git then identifies",
);
assert.ok(targetsSessionDirectory(first("/usr/bin/env git add -A")!, cwd), "wrappers by absolute path");
assert.ok(targetsSessionDirectory(first("/usr/bin/sudo git commit -m x")!, cwd));

const none = [
	"git status --porcelain",
	"git diff HEAD~1 -- src/",
	"git log --oneline -20 | head",
	"git show HEAD:src/app.ts > /tmp/old.ts",
	"git blame src/app.ts",
	"git grep -n TODO",
	"git ls-files | wc -l",
	"git rev-parse --show-toplevel",
	"git branch",
	"git branch -vv",
	"git branch --list 'feat/*'",
	"git branch --show-current",
	"git tag",
	"git tag -l 'v*'",
	"git tag --sort=-v:refname",
	"git stash list",
	"git stash show -p stash@{0}",
	"git remote -v",
	"git worktree list",
	"git apply --check fix.patch",
	"git fetch origin",
	"git config --get user.email",
	"git commit --help",
	"git stash -h",
	"git clean -n",
	"git clean -nd",
	"git add -n .",
	"git push --dry-run origin HEAD",
	"echo 'git commit -m x'",
	"grep -rn \"git reset --hard\" docs/",
	"rg 'git push' -g '*.md'",
	"cat > /tmp/setup.sh <<'EOF'\ngit init\ngit commit -m fixture\nEOF",
	"# git commit later\nnpm test",
	"cd /tmp/fixture && git init -q && git commit -qm base",
	"cd tests/fixtures/repo && git init -q && git add -A && git commit -qm x",
	"git init -q .tmp/fx && git -C .tmp/fx commit -qm fx",
	"cd tests/fixtures/repo && git init -q -b main && git add -A && git commit -qm x",
	"git init -q -b main tests/fixtures/repo && git -C tests/fixtures/repo add -A",
	"git init --initial-branch main --template /tmp/t tests/fx && git -C tests/fx commit -m x",
	'cd "$TMPDIR/repo" && git add -A',
	"cd && git commit -m x",
	"npm run release",
	"python3 -m pytest -q",
	"",
];
for (const command of none) {
	assert.deepEqual(gitStateCommands(command, cwd), [], `must allow: ${command}`);
}

// lsp calls that edit files.
assert.deepEqual(lspWrite("lsp", { action: "rename", file: "src/a.ts", symbol: "x", new_name: "y" }), { action: "lsp rename", paths: ["src/a.ts"] });
assert.deepEqual(lspWrite("lsp", { action: "rename_file", file: "src/a.ts", new_name: "src/b.ts" }), { action: "lsp rename_file", paths: ["src/a.ts", "src/b.ts"] });
assert.deepEqual(lspWrite("lsp", { action: "code_actions", file: "src/a.ts", apply: true, query: "fix" }), { action: "lsp code_actions", paths: ["src/a.ts"] });
assert.equal(lspWrite("lsp", { action: "rename", file: "src/a.ts", apply: false }), undefined, "a preview edits nothing");
assert.equal(lspWrite("lsp", { action: "code_actions", file: "src/a.ts" }), undefined);
assert.equal(lspWrite("lsp", { action: "references", file: "src/a.ts" }), undefined);
assert.equal(lspWrite("edit", { action: "rename" }), undefined);

// The worker sees why a call was blocked and that nothing changed.
const decision = parseAllow('{"allowed": false, "blocked": [{"path": "src/app.ts", "reason": "reviewer is read-only"}, {"command": "git commit -m x", "reason": "workers never change git state"}]}');
assert.equal(decision?.allowed, false);
const reason = blockReason(decision!);
assert.match(reason, /nothing was changed/);
assert.match(reason, /src\/app\.ts — reviewer is read-only/);
assert.match(reason, /`git commit -m x` — workers never change git state/);
assert.equal(parseAllow("garbage"), undefined);
assert.equal(parseAllow('{"verdict": "clean"}'), undefined);

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
assert.deepEqual(editedPaths("edit", { input: "[a.ts#1a2B]\n", path: "a.ts", paths: ["a.ts", "b.ts"] }), ["a.ts", "b.ts"], "OMP's derived paths");
assert.deepEqual(
	editedPaths("edit", { input: "*** Begin Patch\n*** Update File: Cargo.toml\n@@\n[dependencies]\nMV the old section\n+serde = \"1\"\n*** End Patch\n" }),
	["Cargo.toml"],
	"apply_patch context lines are not paths",
);
assert.deepEqual(editedPaths("bash", { command: "echo > d" }), [], "bash writes are not edit paths");

// Messages for Main.
assert.equal(guardMessage({ verdict: "clean" }), undefined);
const note = guardMessage({ verdict: "clean", agent: "workflow-coder", step: "S3", notes: ["only modelRoles changed"] });
assert.match(note ?? "", /note on workflow-coder \(step S3\)/, "clean verdicts still surface their notes");
assert.match(note ?? "", /Not a violation/);
assert.doesNotMatch(note ?? "", /Do not accept/);
assert.equal(
	guardMessage({ verdict: "clean", agent: "workflow-reviewer", step: "S3", notes: [], shell_suspects: ["src/x.ts"] }),
	undefined,
	"changes by others or suspects never interrupt Main",
);
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
