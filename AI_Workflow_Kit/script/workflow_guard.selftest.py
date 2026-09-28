#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
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


def guard(root: Path, *args: str) -> tuple[int, dict]:
    completed = subprocess.run(
        [sys.executable, str(SCRIPT), "--project", str(root), *args, "--json"],
        capture_output=True,
        text=True,
    )
    assert completed.returncode in (0, 1), completed.stderr
    return completed.returncode, json.loads(completed.stdout)


def write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def round_trip(root: Path, role: str, change, *extra: str) -> tuple[int, dict]:
    guard(root, "snapshot", "--role", role, "--agent", f"workflow-{role.replace('_', '-')}")
    change()
    return guard(root, "verify", *extra)


def main() -> int:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw) / "Pavan's Workflow project"
        root.mkdir()
        git(root, "init", "-q")
        git(root, "config", "user.email", "t@example.com")
        git(root, "config", "user.name", "t")
        write(root, "AI_Workflow_Kit/docs/AI/STATE.yaml", STATE)
        write(root, "AI_Workflow_Kit/docs/STEPS.md", "## S4 — Step\n")
        write(root, "src/app.ts", "export const app = 1\n")
        write(root, "src/feature/x.ts", "export const x = 1\n")
        write(root, "notes/pre-existing.md", "draft\n")
        git(root, "add", "-A")
        git(root, "commit", "-qm", "base")
        write(root, "notes/pre-existing.md", "Human draft in progress\n")  # dirty before any worker

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

        # A worker that reverts a pre-existing Human edit is still caught.
        code, verdict = round_trip(root, "security", lambda: git(root, "checkout", "--", "notes/pre-existing.md"))
        assert code == 1 and verdict["violations"][0]["path"] == "notes/pre-existing.md", verdict

        # OMP re-serializes .omp/config.yml itself when the Human changes a model
        # (Alt+M) while a worker runs, and leaves its settings lock file behind:
        # the config change is a note for Main, never a violation; the lock is
        # never a change; every other .omp/ file stays protected.
        write(root, ".omp/config.yml", 'modelRoles:\n  # Main slot.\n  workflow_orchestrator: "@default"\ntools:\n  dirs:\n    - .\n')
        git(root, "add", "-A")
        git(root, "commit", "-qm", "config")

        def omp_saves_model_role() -> None:
            write(root, ".omp/config.yml", 'modelRoles:\n  workflow_orchestrator: "@default"\n  default: x/y:high\ntools:\n  dirs:\n    - "."\n')
            write(root, ".omp/config.yml.lock", "")

        code, verdict = round_trip(root, "reviewer", omp_saves_model_role)
        assert code == 0 and verdict["verdict"] == "clean", verdict
        assert any(item.startswith(".omp/config.yml changed") for item in verdict["notes"]), verdict
        assert verdict["changed"] == [".omp/config.yml"], verdict
        git(root, "checkout", "--", ".omp/config.yml")

        code, verdict = round_trip(root, "coder", lambda: write(root, ".omp/extensions/workflow-guard.ts", "// disabled\n"))
        assert code == 1 and verdict["violations"][0]["path"] == ".omp/extensions/workflow-guard.ts", verdict
        (root / ".omp/extensions/workflow-guard.ts").unlink()

        write(root, "AI_Workflow_Kit/docs/AI/STATE.yaml", "current_step: S5\ntarget_files: []\n")
        code, verdict = round_trip(root, "coder", lambda: write(root, "src/other.ts", "export {}\n"))
        assert code == 0 and verdict["verdict"] == "unscoped" and verdict["notes"], verdict

        code, verdict = round_trip(root, "explore", lambda: write(root, "scratch.txt", "x\n"))
        assert code == 1 and verdict["role"] == "unknown", "unrecognised agents are read-only"

        _, status = guard(root, "status", "--step", "S4")
        assert status["step"] == "S4" and status["verdict"] in {"clean", "violation"}
        _, missing = guard(root, "status", "--step", "S99")
        assert missing["verdict"] == "missing"

        no_open = subprocess.run([sys.executable, str(SCRIPT), "--project", str(root), "verify"], capture_output=True, text=True)
        assert no_open.returncode == 2 and "no open guard snapshot" in no_open.stderr

        # Caches from running tests are not changes; symlinks (even to
        # directories) are hashed instead of aborting the guard.
        def caches_and_links() -> None:
            write(root, "src/__pycache__/app.cpython-311.pyc", "x")
            write(root, ".pytest_cache/v/cache/lastfailed", "{}")
            (root / "linkdir").symlink_to(Path(raw))
        code, verdict = round_trip(root, "reviewer", caches_and_links)
        assert code == 1 and [item["path"] for item in verdict["violations"]] == ["linkdir"], verdict
        (root / "linkdir").unlink()

        # Resolving records the Human decision next to the verdict.
        _, resolved = guard(root, "resolve", "--id", verdict["id"], "--note", "Human: symlink removed")
        assert resolved["note"] == "Human: symlink removed"
        _, history = guard(root, "status", "--all", "--step", "S5")
        assert any(item.get("resolution") for item in history), history

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
        assert code == 1 and verdict["violations"][0]["path"] == "../services/api/main.go", verdict

    print("workflow_guard.selftest: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
