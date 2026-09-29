#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "AI_Workflow_Kit" / "script" / "workflow_guard.py"

STATE = """current_step: S4
target_files:
  - src/feature/
  - "docs/guide.md"
"""


def git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True, text=True)


def guard(root: Path, *args: str, env: dict[str, str] | None = None) -> tuple[int, dict]:
    completed = subprocess.run(
        [sys.executable, str(SCRIPT), "--project", str(root), *args, "--json"],
        capture_output=True,
        text=True,
        env={**os.environ, **(env or {})},
    )
    assert completed.returncode in (0, 1), completed.stderr
    return completed.returncode, json.loads(completed.stdout)


def write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def agent_of(role: str) -> str:
    return f"workflow-{role.replace('_', '-')}"


def round_trip(root: Path, role: str, change, *extra: str) -> tuple[int, dict]:
    """pre-3.6 judgement: every change in the repository is the worker's."""
    guard(root, "snapshot", "--role", role, "--agent", agent_of(role))
    change()
    return guard(root, "verify", "--whole-repo", *extra)


def worker_edit(root: Path, role: str, rel: str, text: str, base: Path | None = None) -> tuple[int, dict]:
    """What the extension does inside a worker session: ask first, then edit only if allowed."""
    code, decision = guard(root, "allow", "--agent", agent_of(role), "--base", str(base or root), f"--path={rel}")
    if decision["allowed"]:
        write(base or root, rel, text)
    return code, decision


def legacy_semantics(root: Path, raw: str) -> None:
    code, verdict = round_trip(root, "reviewer", lambda: None)
    assert code == 0 and verdict["verdict"] == "clean", verdict
    assert verdict["changed"] == [], "pre-existing dirty files are not attributed to the worker"

    code, verdict = round_trip(root, "reviewer", lambda: write(root, "src/app.ts", "export const app = 2\n"))
    assert code == 1 and verdict["verdict"] == "violation"
    assert verdict["violations"][0]["path"] == "src/app.ts"
    assert "read-only" in verdict["violations"][0]["reason"]
    git(root, "checkout", "--", "src/app.ts")

    code, verdict = round_trip(root, "coder", lambda: write(root, "src/feature/x.ts", "export const x = 2\n"))
    assert code == 0 and verdict["verdict"] == "clean", verdict
    assert verdict["changed"] == ["src/feature/x.ts"]
    assert verdict["targets"] == ["src/feature/", "docs/guide.md"]

    code, verdict = round_trip(root, "coder", lambda: write(root, "src/app.ts", "export const app = 3\n"))
    assert code == 1 and verdict["violations"][0]["reason"].startswith("outside target_files")
    git(root, "checkout", "--", "src/app.ts")

    code, verdict = round_trip(root, "coder", lambda: write(root, "AI_Workflow_Kit/docs/STEPS.md", "## S4 — weakened\n"))
    assert code == 1 and "workflow file" in verdict["violations"][0]["reason"]
    git(root, "checkout", "--", "AI_Workflow_Kit/docs/STEPS.md")

    def commit_change() -> None:
        write(root, "src/feature/x.ts", "export const x = 3\n")
        git(root, "commit", "-qm", "worker commit", "--", "src/feature/x.ts")

    code, verdict = round_trip(root, "coder", commit_change)
    assert code == 1 and verdict["violations"][0]["path"] == "HEAD", verdict
    assert "src/feature/x.ts" in verdict["changed"], "committed changes stay visible"

    code, verdict = round_trip(root, "tester", lambda: write(root, "tests/test_feature.py", "def test_x(): pass\n"))
    assert code == 0 and verdict["verdict"] == "clean", verdict
    code, verdict = round_trip(root, "tester", lambda: write(root, "src/app.ts", "export const app = 4\n"))
    assert code == 1 and "tester" in verdict["violations"][0]["reason"]
    git(root, "checkout", "--", "src/app.ts")

    # Main edits its own state while the worker runs (reported by the extension).
    code, verdict = round_trip(
        root,
        "architect",
        lambda: write(root, "AI_Workflow_Kit/docs/AI/STATE.yaml", STATE + "notes: main\n"),
        "--exempt",
        "./AI_Workflow_Kit/docs/AI/STATE.yaml",
    )
    assert code == 0 and verdict["verdict"] == "clean", verdict
    write(root, "AI_Workflow_Kit/docs/AI/STATE.yaml", STATE)

    # A worker that reverts a pre-existing Human edit is still caught.
    code, verdict = round_trip(root, "security", lambda: git(root, "checkout", "--", "notes/pre-existing.md"))
    assert code == 1 and verdict["violations"][0]["path"] == "notes/pre-existing.md", verdict
    write(root, "notes/pre-existing.md", "Human draft in progress\n")

    # Caches from running tests are not changes; symlinks (even to
    # directories) are hashed instead of aborting the guard.
    def caches_and_links() -> None:
        write(root, "src/__pycache__/app.cpython-311.pyc", "x")
        write(root, ".pytest_cache/v/cache/lastfailed", "{}")
        write(root, ".omp/config.yml.lock", "")
        (root / "linkdir").symlink_to(Path(raw))

    code, verdict = round_trip(root, "reviewer", caches_and_links)
    assert code == 1 and [item["path"] for item in verdict["violations"]] == ["linkdir"], verdict
    (root / "linkdir").unlink()
    (root / ".omp/config.yml.lock").unlink()

    # Resolving records the Human decision next to the verdict.
    _, resolved = guard(root, "resolve", "--id", verdict["id"], "--note", "Human: symlink removed")
    assert resolved["note"] == "Human: symlink removed"
    _, history = guard(root, "status", "--all", "--step", "S4")
    assert any(item.get("resolution") for item in history), history


def attributed_semantics(root: Path) -> None:
    # 1. The failure 3.5.x produced: while a read-only worker ran, Main committed
    #    and a parallel session / the Human edited product code. None of that is
    #    the worker's, so it is listed, never a violation.
    guard(root, "snapshot", "--role", "reviewer", "--agent", "workflow-reviewer")
    write(root, "src/app.ts", "export const app = 'parallel session'\n")
    write(root, "AI_Workflow_Kit/docs/AI/STATE.yaml", STATE + "notes: main checkpoint\n")
    git(root, "commit", "-qm", "Main checkpoint ST0", "--", "AI_Workflow_Kit/docs/AI/STATE.yaml")
    write(root, ".omp/config.yml", "modelRoles:\n  default: x/y:high\n")  # OMP rewrote settings (Alt+M)
    code, verdict = guard(root, "verify")
    assert code == 0 and verdict["verdict"] == "clean", verdict
    assert verdict["violations"] == [] and verdict["notes"] == [] and verdict["changed"] == [], verdict
    assert verdict["head_moved"] is True and verdict["schema"] == 2
    assert {"src/app.ts", "AI_Workflow_Kit/docs/AI/STATE.yaml", ".omp/config.yml"} <= set(verdict["unattributed"]), verdict
    git(root, "checkout", "--", "src/app.ts")

    # 2. A Coder's own in-scope edit is attributed; others' edits are not.
    guard(root, "snapshot", "--role", "coder", "--agent", "workflow-coder")
    code, decision = worker_edit(root, "coder", "src/feature/x.ts", "export const x = 10\n")
    assert code == 0 and decision["allowed"] and decision["id"], decision
    write(root, "src/app.ts", "export const app = 'someone else'\n")
    code, verdict = guard(root, "verify")
    assert code == 0 and verdict["verdict"] == "clean" and verdict["changed"] == ["src/feature/x.ts"], verdict
    assert "src/app.ts" in verdict["unattributed"]
    git(root, "checkout", "--", "src/app.ts")

    # 3. Out-of-scope edits are blocked before they run: nothing changes, the
    #    worker carries on, and Main gets a note instead of a violation.
    guard(root, "snapshot", "--role", "coder", "--agent", "workflow-coder")
    code, decision = worker_edit(root, "coder", "src/app.ts", "export const app = 'coder'\n")
    assert code == 1 and not decision["allowed"], decision
    assert decision["blocked"][0]["reason"].startswith("outside target_files"), decision
    code, decision = worker_edit(root, "coder", ".omp/extensions/workflow-guard.ts", "// disabled\n")
    assert code == 1 and "workflow file" in decision["blocked"][0]["reason"], decision
    code, decision = guard(root, "allow", "--agent", "workflow-coder", "--tool", "bash", "--command", "git commit -am wip")
    assert code == 1 and decision["blocked"][0]["command"] == "git commit -am wip", decision
    code, verdict = guard(root, "verify")
    assert code == 0 and verdict["verdict"] == "clean", verdict
    assert len(verdict["blocked"]) == 3 and verdict["notes"][0].startswith("blocked 3 out-of-scope action(s)"), verdict
    assert not (root / ".omp/extensions/workflow-guard.ts").exists()

    # 4. Read-only roles, testers, and paths the guard does not own.
    code, decision = guard(root, "allow", "--agent", "workflow-reviewer", "--path", "src/app.ts")
    assert code == 1 and "read-only" in decision["blocked"][0]["reason"]
    code, decision = guard(root, "allow", "--agent", "workflow-tester-backup", "--path", "tests/test_new.py")
    assert code == 0 and decision["allowed"] and decision["role"] == "tester", decision
    code, decision = guard(root, "allow", "--agent", "workflow-tester", "--path", "src/app.ts")
    assert code == 1, decision
    code, decision = guard(root, "allow", "--agent", "scout", "--path", "src/app.ts")
    assert code == 0 and decision["role"] == "unknown", "OMP's own agents are not guarded"
    code, decision = guard(root, "allow", "--agent", "workflow-reviewer", "--path", "/tmp/review-notes.md", "--path", "local://scratch.md")
    assert code == 0 and decision["blocked"] == [], "files outside the repository are not the guard's business"
    code, decision = guard(root, "allow", "--agent", "workflow-reviewer", "--path", "src/__pycache__/x.pyc")
    assert code == 0, "caches are not changes"
    write(root, ".gitignore", "dist/\n.omp/extensions/local.ts\n")
    code, decision = guard(root, "allow", "--agent", "workflow-coder", "--path", "dist/bundle.js")
    assert code == 0 and decision["blocked"] == [], "git-ignored output is invisible to the guard, as in verify"
    code, decision = guard(root, "allow", "--agent", "workflow-coder", "--path", ".omp/extensions/local.ts")
    assert code == 1, "workflow files stay protected even when ignored"
    (root / ".gitignore").unlink()

    # 5. Main may widen target_files while the worker runs.
    guard(root, "snapshot", "--role", "coder", "--agent", "workflow-coder")
    write(root, "AI_Workflow_Kit/docs/AI/STATE.yaml", STATE + "  - src/app.ts\n")
    code, decision = worker_edit(root, "coder", "src/app.ts", "export const app = 'widened'\n")
    assert code == 0 and decision["allowed"], decision
    code, verdict = guard(root, "verify")
    assert code == 0 and verdict["changed"] == ["src/app.ts"], verdict
    write(root, "AI_Workflow_Kit/docs/AI/STATE.yaml", STATE)
    git(root, "checkout", "--", "src/app.ts")

    # 6. Files changed while the worker's shell ran are listed for Main, not judged.
    guard(root, "snapshot", "--role", "reviewer", "--agent", "workflow-reviewer")
    start = time.time() * 1000
    write(root, "src/generated.ts", "export {}\n")
    end = time.time() * 1000
    code, verdict = guard(root, "verify", f"--window={start:.0f}:{end:.0f}")
    assert code == 0 and verdict["verdict"] == "clean" and verdict["shell_suspects"] == ["src/generated.ts"], verdict
    (root / "src/generated.ts").unlink()
    guard(root, "snapshot", "--role", "reviewer", "--agent", "workflow-reviewer")
    write(root, "src/generated.ts", "export {}\n")
    code, verdict = guard(root, "verify", "--window=1000:2000")
    assert verdict["shell_suspects"] == [] and "src/generated.ts" in verdict["unattributed"], verdict
    (root / "src/generated.ts").unlink()

    # 7. Coder without target_files: allowed, but the verdict is unscoped.
    write(root, "AI_Workflow_Kit/docs/AI/STATE.yaml", "current_step: S5\ntarget_files: []\n")
    guard(root, "snapshot", "--role", "coder", "--agent", "workflow-coder")
    code, decision = worker_edit(root, "coder", "src/other.ts", "export {}\n")
    assert code == 0 and decision["allowed"]
    code, verdict = guard(root, "verify")
    assert code == 0 and verdict["verdict"] == "unscoped" and verdict["changed"] == ["src/other.ts"], verdict
    (root / "src/other.ts").unlink()
    write(root, "AI_Workflow_Kit/docs/AI/STATE.yaml", STATE)

    # 8. Modes: report blocks nothing and says what enforce would have blocked;
    #    off skips the guard; WF_GUARD_MODE overrides the stored mode.
    _, mode = guard(root, "mode")
    assert mode == {"mode": "enforce", "source": "default"}, mode
    _, mode = guard(root, "mode", "report", "--note", "Human: parallel sessions today")
    assert mode["mode"] == "report"
    guard(root, "snapshot", "--role", "reviewer", "--agent", "workflow-reviewer")
    code, decision = worker_edit(root, "reviewer", "src/app.ts", "export const app = 'report'\n")
    assert code == 0 and decision["allowed"] and decision["blocked"], decision
    code, decision = guard(root, "allow", "--agent", "workflow-reviewer", "--tool", "bash", "--command", "git stash")
    assert code == 0 and decision["allowed"]
    code, verdict = guard(root, "verify")
    assert code == 0 and verdict["verdict"] == "clean" and verdict["mode"] == "report", verdict
    assert any("enforce would have blocked src/app.ts" in note for note in verdict["notes"]), verdict
    assert any("`git stash`" in note for note in verdict["notes"]), verdict
    git(root, "checkout", "--", "src/app.ts")
    _, mode = guard(root, "mode", env={"WF_GUARD_MODE": "enforce"})
    assert mode == {"mode": "enforce", "source": "env WF_GUARD_MODE"}, mode
    guard(root, "mode", "off")
    _, snap = guard(root, "snapshot", "--role", "reviewer", "--agent", "workflow-reviewer")
    assert snap["skipped"] is True and snap["id"] is None, snap
    code, decision = guard(root, "allow", "--agent", "workflow-reviewer", "--path", "src/app.ts")
    assert code == 0 and decision["allowed"] and decision["mode"] == "off"
    guard(root, "mode", "enforce")

    # 9. Review findings: a mode switched mid-run, target_files moving on, glob
    #    folder names, test helpers, lsp writes, commits during the worker's shell.
    guard(root, "snapshot", "--role", "coder", "--agent", "workflow-coder")
    guard(root, "mode", "report")
    code, decision = worker_edit(root, "coder", "src/app.ts", "export const app = 'mid-run report'\n")
    assert code == 0 and decision["allowed"], decision
    guard(root, "mode", "enforce")
    code, verdict = guard(root, "verify")
    assert code == 0 and verdict["verdict"] == "clean" and verdict["violations"] == [], "a mid-run switch to report never makes a violation"
    assert any("enforce would have blocked src/app.ts" in note for note in verdict["notes"]), verdict
    ledger_run = verdict["id"]
    git(root, "checkout", "--", "src/app.ts")

    guard(root, "snapshot", "--role", "coder", "--agent", "workflow-coder")
    write(root, "AI_Workflow_Kit/docs/AI/STATE.yaml", STATE + "  - src/extra.ts\n")
    code, decision = worker_edit(root, "coder", "src/extra.ts", "export {}\n")
    assert code == 0, decision
    write(root, "AI_Workflow_Kit/docs/AI/STATE.yaml", "current_step: S6\ntarget_files:\n  - src/next/\n")
    code, verdict = guard(root, "verify")
    assert code == 0 and verdict["verdict"] == "clean" and verdict["changed"] == ["src/extra.ts"], "an allowed edit is not re-judged later"
    (root / "src/extra.ts").unlink()

    write(root, "AI_Workflow_Kit/docs/AI/STATE.yaml", "current_step: S4\ntarget_files:\n  - app/[slug]/\n  - src/**/*.gen.ts\n")
    for rel in ("app/[slug]/page.tsx", "src/deep/x/a.gen.ts"):
        code, decision = guard(root, "allow", "--agent", "workflow-coder", f"--path={rel}")
        assert code == 0, (rel, decision)
    code, decision = guard(root, "allow", "--agent", "workflow-coder", "--path=src/deep/x/a.ts")
    assert code == 1, decision
    for rel in ("conftest.py", "app/tests.py", "src/__snapshots__/a.test.ts.snap", "src/test-utils.tsx", "src/setupTests.ts", "FooTests/Helper.swift"):
        code, decision = guard(root, "allow", "--agent", "workflow-tester", f"--path={rel}")
        assert code == 0, (rel, decision)
    for rel in ("src/contests/leaderboard.ts", "src/features/protests/api.py"):
        code, decision = guard(root, "allow", "--agent", "workflow-tester", f"--path={rel}")
        assert code == 1, ("not a test path", rel, decision)
    write(root, "AI_Workflow_Kit/docs/AI/STATE.yaml", "current_step: S4\ntarget_files:\n  - src/**/\n")
    code, decision = guard(root, "allow", "--agent", "workflow-coder", "--path=src/a/b.ts")
    assert code == 0, decision
    write(root, "AI_Workflow_Kit/docs/AI/STATE.yaml", STATE)

    code, decision = guard(root, "allow", "--agent", "workflow-reviewer", "--tool", "lsp", "--action", "lsp rename")
    assert code == 1 and "read-only" in decision["blocked"][0]["reason"], decision
    code, decision = guard(root, "allow", "--agent", "workflow-coder", "--tool", "lsp", "--action", "lsp rename", "--path", "src/feature/x.ts")
    assert code == 0, decision

    guard(root, "snapshot", "--role", "tester", "--agent", "workflow-tester")
    start = time.time() * 1000
    write(root, "tests/test_commit.py", "def test(): pass\n")
    git(root, "add", "tests/test_commit.py")
    git(root, "commit", "-qm", "committed from a test script")
    end = time.time() * 1000
    code, verdict = guard(root, "verify", f"--window={start:.0f}:{end:.0f}")
    assert code == 0 and verdict["verdict"] == "clean", verdict
    assert [item["subject"] for item in verdict["suspect_commits"]] == ["committed from a test script"], verdict

    # Verified snapshots drop their dirty-file map; the ledger and verdict stay.
    common = subprocess.run(["git", "-C", str(root), "rev-parse", "--git-common-dir"], capture_output=True, text=True).stdout.strip()
    guard_dir = (root / common).resolve() / "pavans-workflow" / "guard"
    record = json.loads((guard_dir / f"{verdict['id']}.snapshot.json").read_text(encoding="utf-8"))
    assert "dirty" not in record and "dirty_count" in record, record
    assert (guard_dir / f"{ledger_run}.ledger.jsonl").is_file()


def main() -> int:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw) / "Pavan's Workflow project"
        root.mkdir()
        git(root, "init", "-q")
        git(root, "config", "user.email", "t@example.com")
        git(root, "config", "user.name", "t")
        write(root, "AI_Workflow_Kit/docs/AI/STATE.yaml", STATE)
        write(root, "AI_Workflow_Kit/docs/STEPS.md", "## S4 — Step\n")
        write(root, ".omp/config.yml", "modelRoles:\n  default: a/b\n")
        write(root, "src/app.ts", "export const app = 1\n")
        write(root, "src/feature/x.ts", "export const x = 1\n")
        write(root, "notes/pre-existing.md", "draft\n")
        git(root, "add", "-A")
        git(root, "commit", "-qm", "base")
        write(root, "notes/pre-existing.md", "Human draft in progress\n")  # dirty before any worker

        legacy_semantics(root, raw)
        attributed_semantics(root)

        _, status = guard(root, "status", "--step", "S4")
        assert status["step"] == "S4" and status["verdict"] in {"clean", "violation", "unscoped"}
        _, missing = guard(root, "status", "--step", "S99")
        assert missing["verdict"] == "missing"
        text = subprocess.run([sys.executable, str(SCRIPT), "--project", str(root), "status", "--all"], capture_output=True, text=True)
        assert text.returncode == 0 and "changed by others meanwhile" in text.stdout, text.stdout

        no_open = subprocess.run([sys.executable, str(SCRIPT), "--project", str(root), "verify"], capture_output=True, text=True)
        assert no_open.returncode == 2 and "no open guard snapshot" in no_open.stderr

    # A workflow living in a monorepo subfolder: paths are judged relative to it.
    with tempfile.TemporaryDirectory() as raw:
        mono = Path(raw) / "mono"
        mono.mkdir()
        git(mono, "init", "-q")
        git(mono, "config", "user.email", "t@example.com")
        git(mono, "config", "user.name", "t")
        app = mono / "apps" / "web"
        write(app, "AI_Workflow_Kit/docs/AI/STATE.yaml", "current_step: M1\ntarget_files:\n  - src/\n")
        write(app, ".omp/AGENTS.md", "contract\n")
        write(app, "src/page.ts", "export {}\n")
        write(mono, "services/api/main.go", "package main\n")
        git(mono, "add", "-A")
        git(mono, "commit", "-qm", "base")
        code, verdict = round_trip(app, "coder", lambda: write(app, "src/page.ts", "export const x = 1\n"))
        assert code == 0 and verdict["verdict"] == "clean" and verdict["changed"] == ["src/page.ts"], verdict
        assert verdict["step"] == "M1" and verdict["targets"] == ["src/"]
        code, verdict = round_trip(app, "coder", lambda: write(app, ".omp/AGENTS.md", "weakened\n"))
        assert code == 1 and verdict["violations"][0]["path"] == ".omp/AGENTS.md", verdict
        git(mono, "checkout", "--", ".")
        code, verdict = round_trip(app, "coder", lambda: write(mono, "services/api/main.go", "package api\n"))
        assert code == 1 and verdict["violations"][0]["path"] == "../../services/api/main.go", verdict
        git(mono, "checkout", "--", ".")

        guard(app, "snapshot", "--role", "coder", "--agent", "workflow-coder")
        code, decision = worker_edit(app, "coder", "src/page.ts", "export const y = 1\n")
        assert code == 0 and decision["allowed"], decision
        code, decision = guard(app, "allow", "--agent", "workflow-coder", "--base", str(app), "--path", "../../services/api/main.go")
        assert code == 1 and decision["blocked"][0]["path"] == "../../services/api/main.go", decision
        code, decision = guard(app, "allow", "--agent", "workflow-coder", "--base", str(mono), "--path", "apps/web/src/page.ts")
        assert code == 0, "paths are resolved against the worker's cwd"
        code, verdict = guard(app, "verify")
        assert code == 0 and verdict["changed"] == ["src/page.ts"], verdict

        # Two workflow projects in one repository keep their own mode and verdicts.
        api = mono / "services" / "api"
        write(api, "AI_Workflow_Kit/docs/AI/STATE.yaml", "current_step: M1\ntarget_files:\n  - src/\n")
        guard(api, "mode", "off")
        _, mode = guard(app, "mode")
        assert mode["mode"] == "enforce", "mode off in one project leaves the other enforced"
        _, status = guard(api, "status", "--step", "M1")
        assert status["verdict"] == "missing", "the other project's verdicts are not this project's"

    print("workflow_guard.selftest: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
