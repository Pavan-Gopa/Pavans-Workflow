#!/usr/bin/env python3
"""Deterministic tests for workflow_framework.py (install, update, rollback, verify)."""

from __future__ import annotations

import datetime as dt
import importlib.util
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("workflow_framework", Path(__file__).with_name("workflow_framework.py"))
assert spec and spec.loader
fw = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = fw  # dataclasses resolve annotations through sys.modules
spec.loader.exec_module(fw)


def git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True, text=True)


def new_repo(path: Path) -> Path:
    path.mkdir(parents=True)
    git(path, "init", "-q")
    git(path, "config", "user.email", "t@example.com")
    git(path, "config", "user.name", "t")
    return path


def copy_release(destination: Path, version: str | None = None) -> Path:
    """A minimal release tree built from this checkout's manifest (never its used state)."""
    entries = fw.parse_manifest(ROOT / fw.MANIFEST_REL)
    for rel, src in fw.managed_files(ROOT, entries).items():
        target = destination / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)
    for entry in entries:
        if entry.kind in ("seed", "config"):
            (destination / entry.path).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / entry.path, destination / entry.path)
    if version:
        (destination / fw.VERSION_REL).write_text(version + "\n", encoding="utf-8")
    return destination


def expect_error(code: int, func, *args) -> None:
    try:
        func(*args)
    except fw.FrameworkError as error:
        assert error.code == code, (error.code, str(error))
        return
    raise AssertionError(f"expected FrameworkError({code})")


def main() -> int:
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        release = copy_release(tmp / "release")

        # --- install into an existing product repository -----------------------------
        project = new_repo(tmp / "Pavan's product")
        (project / "README.md").write_text("# My product\n", encoding="utf-8")
        (project / "VERSION").write_text("1.2.3\n", encoding="utf-8")
        (project / "CHANGELOG.md").write_text("# Product changelog\n", encoding="utf-8")
        (project / ".omp").mkdir()
        (project / ".omp/config.yml").write_text("theme: dark\n", encoding="utf-8")
        result = fw.cmd_install(release, project)
        assert result["installed_files"] > 100
        assert (project / "README.md").read_text() == "# My product\n", "product README untouched"
        assert (project / "VERSION").read_text() == "1.2.3\n", "product VERSION untouched"
        assert (project / "CHANGELOG.md").read_text() == "# Product changelog\n"
        config = (project / ".omp/config.yml").read_text()
        assert "theme: dark" in config and "workflow_coder:" in config, "existing OMP config merged"
        for rel in ("AI_Workflow_Kit/docs/AI/STATE.yaml", "AI_Workflow_Kit/docs/PROJECT_CONTEXT.md"):
            assert (project / rel).is_file(), rel
        assert "_(title)_" in (project / "AI_Workflow_Kit/docs/PROJECT_CONTEXT.md").read_text(), "pristine template"
        assert "graphify-out/" in (project / ".gitignore").read_text()
        code, lines = fw.cmd_verify(project)
        assert code == 0, lines

        expect_error(3, fw.cmd_install, release, project)

        # --- conflicts are detected before anything is copied ---------------------------
        conflicted = new_repo(tmp / "conflicted")
        (conflicted / ".omp").mkdir()
        (conflicted / ".omp/AGENTS.md").write_text("my own agents file\n", encoding="utf-8")
        expect_error(4, fw.cmd_install, release, conflicted)
        assert not (conflicted / ".omp/lib").exists(), "no partial install"

        # --- the used state of a source checkout never leaks into a new project ----------
        dirty_release = copy_release(tmp / "dirty-release")
        (dirty_release / "AI_Workflow_Kit/docs/AI").mkdir(parents=True, exist_ok=True)
        (dirty_release / "AI_Workflow_Kit/docs/AI/FEEDBACK.md").write_text("SECRET PROJECT LOG\n", encoding="utf-8")
        clean_target = new_repo(tmp / "clean-target")
        fw.cmd_install(dirty_release, clean_target)
        assert "SECRET" not in (clean_target / "AI_Workflow_Kit/docs/AI/FEEDBACK.md").read_text()

        # --- update: removals, additions, local edits, custom files ---------------------
        next_release = copy_release(tmp / "next", version="9.9.0")
        (next_release / ".omp/lib/workflow-stats.ts").unlink()
        (next_release / ".omp/lib/zz-new-module.ts").write_text("export const added = true;\n", encoding="utf-8")
        (project / ".omp/extensions/my-custom.ts").write_text("export default () => {};\n", encoding="utf-8")
        (project / "AI_Workflow_Kit/docs/AI/MODELS.md").write_text("local notes\n", encoding="utf-8")
        (project / "AI_Workflow_Kit/docs/AI/STATE.yaml").write_text("current_step: S7\n", encoding="utf-8")

        check = fw.cmd_update(next_release, project, check=True)
        plan = check["plan"]
        assert ".omp/lib/workflow-stats.ts" in plan["remove"], plan
        assert ".omp/lib/zz-new-module.ts" in plan["add"]
        assert "AI_Workflow_Kit/docs/AI/MODELS.md" in plan["overwrite_local"]
        assert (project / ".omp/lib/workflow-stats.ts").exists(), "check is read-only"

        applied = fw.cmd_update(next_release, project, check=False)
        assert not (project / ".omp/lib/workflow-stats.ts").exists()
        assert (project / ".omp/lib/zz-new-module.ts").exists()
        assert (project / ".omp/extensions/my-custom.ts").exists(), "project-added files are never touched"
        assert (project / "AI_Workflow_Kit/docs/AI/STATE.yaml").read_text() == "current_step: S7\n", "state preserved"
        assert (project / fw.VERSION_REL).read_text().strip() == "9.9.0"
        backup = Path(str(applied["backup"]))
        assert (backup / "AI_Workflow_Kit/docs/AI/MODELS.md").read_text() == "local notes\n", "local edit backed up"
        assert (backup / ".omp/lib/workflow-stats.ts").is_file(), "removed file backed up"
        assert fw.read_record(project)[0] == "9.9.0"

        # --- obsolete but locally modified files are kept --------------------------------
        keep_release = copy_release(tmp / "keep", version="9.9.1")
        (keep_release / ".omp/lib/workflow-stats.ts").unlink()
        (keep_release / ".omp/lib/workflow-routing.ts").unlink()
        (project / ".omp/lib/workflow-routing.ts").write_text("// my fork\n", encoding="utf-8")
        kept = fw.cmd_update(keep_release, project, check=False)
        assert ".omp/lib/workflow-routing.ts" in kept["plan"]["keep_modified_obsolete"]
        assert (project / ".omp/lib/workflow-routing.ts").read_text() == "// my fork\n"

        # --- a failing update rolls everything back --------------------------------------
        broken_release = copy_release(tmp / "broken", version="9.9.2")
        (broken_release / ".omp/lib/zz-rollback-probe.ts").write_text("export {};\n", encoding="utf-8")
        before_agents = (project / ".omp/AGENTS.md").read_text()
        (project / ".omp/AGENTS.md").write_text("local AGENTS edit\n", encoding="utf-8")
        original_repair = fw.repair_config

        def failing_repair(source, target, dry_run=False):
            if dry_run:
                return original_repair(source, target, dry_run=True)
            raise RuntimeError("injected failure after files were copied")

        fw.repair_config = failing_repair
        try:
            fw.cmd_update(broken_release, project, check=False)
            raise AssertionError("update should have failed")
        except RuntimeError as error:
            assert "injected failure" in str(error)
        finally:
            fw.repair_config = original_repair
        assert not (project / ".omp/lib/zz-rollback-probe.ts").exists(), "added file rolled back"
        assert (project / ".omp/AGENTS.md").read_text() == "local AGENTS edit\n", "replaced file restored"
        assert fw.read_record(project)[0] == "9.9.1", "record restored"
        (project / ".omp/AGENTS.md").write_text(before_agents, encoding="utf-8")

        # --- downgrade guard ---------------------------------------------------------------
        expect_error(5, fw.cmd_update, copy_release(tmp / "old", version="1.0.0"), project, False)

        # --- verify ----------------------------------------------------------------------
        probe = project / ".omp/lib/workflow-guard.ts"
        probe.write_text("changed\n", encoding="utf-8")
        code, lines = fw.cmd_verify(project)
        assert code == 0 and any(level == "WARN" and "workflow-guard.ts" in text for level, text in lines), lines
        probe.unlink()
        code, lines = fw.cmd_verify(project)
        assert code == 1 and any("workflow-guard.ts" in text for level, text in lines if level == "FAIL"), lines

        # --- legacy (pre-3.5) project: obsolete paths removed, clobbered README restored --
        legacy = new_repo(tmp / "legacy")
        fw.cmd_install(release, legacy)
        (legacy / fw.RECORD_REL).unlink()
        (legacy / "AI_Workflow_Kit/experiments/context-economy").mkdir(parents=True)
        (legacy / "AI_Workflow_Kit/experiments/context-economy/overlay.tar.bz2.b64.part-000.txt").write_text("x", encoding="utf-8")
        (legacy / "AI_Workflow_Kit/script/workflow_experiment.sh").write_text("#!/bin/sh\n", encoding="utf-8")
        (legacy / "VERSION").write_text("3.4.2\n", encoding="utf-8")
        (legacy / fw.VERSION_REL).unlink()
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        old_backup = legacy / ".git/pavans-workflow/update-backups" / stamp
        old_backup.mkdir(parents=True)
        (old_backup / "README.md").write_text("# Legacy product\n", encoding="utf-8")
        (legacy / "README.md").write_text("# Framework README\n", encoding="utf-8")
        (next_release / "README.md").write_text("# Framework README\n", encoding="utf-8")
        upgraded = fw.cmd_update(next_release, legacy, check=False)
        assert not (legacy / "AI_Workflow_Kit/experiments").exists()
        assert not (legacy / "AI_Workflow_Kit/script/workflow_experiment.sh").exists()
        assert (legacy / "README.md").read_text() == "# Legacy product\n", "legacy clobbering undone"
        assert upgraded.get("legacy_cleanup", {}).get("restored") == ["README.md"]
        assert any("Root VERSION" in notice for notice in upgraded["plan"]["notices"])
        assert fw.cmd_verify(legacy)[0] == 0

    print("workflow_framework.selftest: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
