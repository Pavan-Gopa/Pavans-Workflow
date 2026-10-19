#!/usr/bin/env python3
"""Deterministic tests for workflow_framework.py (install, update, rollback, verify)."""

from __future__ import annotations

import importlib.util
import json
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

# the skills selftest holds the agent-spelling variants and the canonical "as shipped" agent files
st_spec = importlib.util.spec_from_file_location("workflow_skills_selftest", Path(__file__).with_name("workflow_skills.selftest.py"))
assert st_spec and st_spec.loader
st = importlib.util.module_from_spec(st_spec)
st_spec.loader.exec_module(st)


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
    # Plain file view: in an installed project the framework files may not be committed yet.
    for rel, src in fw.managed_files(ROOT, entries, use_git=False).items():
        target = destination / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)
        if rel.startswith(".omp/agents/"):  # an installed project may carry per-role skill additions; a release never does
            target.write_bytes(st.shipped_agent(rel))
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
        git(dirty_release, "init", "-q")
        git(dirty_release, "add", "-A")
        git(dirty_release, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "release")
        (dirty_release / "AI_Workflow_Kit/docs/AI").mkdir(parents=True, exist_ok=True)
        (dirty_release / "AI_Workflow_Kit/docs/AI/FEEDBACK.md").write_text("SECRET PROJECT LOG\n", encoding="utf-8")
        (dirty_release / "AI_Workflow_Kit/docs/AI/STATE.yaml.bak-20260101").write_text("SECRET BACKUP\n", encoding="utf-8")
        (dirty_release / ".omp/agents/my-private-agent.md").write_text("SECRET AGENT\n", encoding="utf-8")
        clean_target = new_repo(tmp / "clean-target")
        fw.cmd_install(dirty_release, clean_target)
        assert "SECRET" not in (clean_target / "AI_Workflow_Kit/docs/AI/FEEDBACK.md").read_text()
        assert not (clean_target / "AI_Workflow_Kit/docs/AI/STATE.yaml.bak-20260101").exists(), "untracked files never ship"
        assert not (clean_target / ".omp/agents/my-private-agent.md").exists(), "untracked files never ship"

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

        # --- per-role skill additions survive updates ------------------------------------
        ws = fw.skills_module()
        sp = new_repo(tmp / "skills-project")
        fw.cmd_install(release, sp)
        coder_rel, backup_rel = ".omp/agents/workflow-coder.md", ".omp/agents/workflow-coder-backup.md"
        shipped = (sp / coder_rel).read_bytes()
        ws.commit(sp, ws.plan_set(sp, ["workflow-coder", "workflow-coder-backup"], ["graphify"]))
        assert (sp / coder_rel).read_bytes() != shipped
        code, lines = fw.cmd_verify(sp)
        assert code == 0 and not any(level == "WARN" for level, _ in lines), ("set is not a local modification", lines)
        plan = fw.cmd_update(copy_release(tmp / "same", version="9.9.0"), sp, check=True)["plan"]
        assert coder_rel not in plan["update"] and coder_rel not in plan["overwrite_local"], "unchanged upstream: nothing to update"
        (sp / ".omp/agents/workflow-designer.md").write_text("hand edit\n", encoding="utf-8")
        code, lines = fw.cmd_verify(sp)
        assert any(level == "WARN" and "workflow-designer.md" in text for level, text in lines), "real local edits are still reported"
        assert not any(level == "WARN" and "workflow-coder" in text for level, text in lines)
        fw.copy_file(release / ".omp/agents/workflow-designer.md", sp / ".omp/agents/workflow-designer.md")

        # upstream changes the Coder's defaults and body: both arrive, the addition stays
        def line(names):
            return "autoloadSkills: " + json.dumps(names) + "\n"

        base = ws.read_skills(upstream_text := shipped.decode("utf-8"))
        base_backup = ws.read_skills((release / backup_rel).read_text(encoding="utf-8"))
        assert base and base_backup and "graphify" not in base + base_backup, (base, base_backup)
        skills_release = copy_release(tmp / "skills-release", version="9.9.0")
        (skills_release / coder_rel).write_text(
            ws.add_skills((skills_release / coder_rel).read_text(encoding="utf-8"), ["zz-new-default"]) + "\nUpstream change marker.\n",
            encoding="utf-8",
        )
        before_files = {rel: (sp / rel).read_bytes() for rel in (coder_rel, backup_rel, ws.OVERLAY_REL)}
        check = fw.cmd_update(skills_release, sp, check=True)["plan"]
        assert coder_rel in check["update"] and coder_rel not in check["overwrite_local"] and backup_rel not in check["update"], check
        # a failing update restores the agent files and the overlay
        original_record = fw.write_record

        def failing_record(*args, **kwargs):
            raise RuntimeError("injected failure after skills were applied")

        fw.write_record = failing_record
        try:
            fw.cmd_update(skills_release, sp, check=False)
            raise AssertionError("update should have failed")
        except RuntimeError as error:
            assert "injected failure" in str(error)
        finally:
            fw.write_record = original_record
        assert {rel: (sp / rel).read_bytes() for rel in before_files} == before_files, "rollback restores additions and upstream defaults"
        applied = fw.cmd_update(skills_release, sp, check=False)
        text = (sp / coder_rel).read_text(encoding="utf-8")
        assert line([*base, "zz-new-default", "graphify"]) in text, "new upstream default first, then the addition"
        assert text.endswith("Upstream change marker.\n"), "upstream change arrived"
        assert line([*base_backup, "graphify"]) in (sp / backup_rel).read_text(encoding="utf-8")
        assert applied["skills"]["changed"] == [coder_rel], applied["skills"]
        code, lines = fw.cmd_verify(sp)
        assert code == 0 and not any(level == "WARN" for level, _ in lines), lines
        assert fw.cmd_update(skills_release, sp, check=True)["changed"] is False, "nothing left to update"
        assert subprocess.run([sys.executable, str(sp / "AI_Workflow_Kit/script/workflow_skills.py"), "check", "--target", str(sp)], capture_output=True).returncode == 0

        # upstream ships what the project had added: it becomes a Workflow default, not a stale addition
        default_release = copy_release(tmp / "default-release", version="9.9.1")
        (default_release / coder_rel).write_text(
            ws.add_skills((default_release / coder_rel).read_text(encoding="utf-8"), ["graphify"]), encoding="utf-8"
        )
        applied = fw.cmd_update(default_release, sp, check=False)
        assert line([*base, "graphify"]) in (sp / coder_rel).read_text(encoding="utf-8")
        assert json.loads((sp / ws.OVERLAY_REL).read_text())["added"] == {"workflow-coder-backup": ["graphify"]}, "coder's overlay entry dropped"
        assert any("now a Workflow default" in note for note in applied["skills"]["notes"]), applied["skills"]
        code, lines = fw.cmd_verify(sp)
        assert code == 0 and not any(level == "WARN" for level, _ in lines), lines
        ws.commit(sp, ws.plan_set(sp, ["workflow-coder-backup"], []))
        assert not (sp / ws.OVERLAY_REL).exists()
        assert fw.cmd_verify(sp)[0] == 0

        # --- every key/list spelling and newline style: install, set, verify, update --check ------
        # (the variant list and OMP-parity checks live in workflow_skills.selftest.py)
        coder_text = st.shipped_agent(coder_rel).decode("utf-8")
        shipped_line = next(text for text in coder_text.split("\n") if ws._KEY.match(text))
        variant_release = tmp / "variant-release"
        shutil.copytree(release, variant_release)
        vp = new_repo(tmp / "variant-project")
        coder = vp / coder_rel
        for name, variant_line in st.VARIANTS:
            # CRLF changes how the line is rewritten, not how it is recognised: three spellings cover it here
            # (workflow_skills.selftest.py runs every spelling in both newline styles)
            for newline in ("\n", "\r\n") if name in ("canonical", "single-quoted items", "missing line") else ("\n",):
                label = f"{name} {'CRLF' if newline == chr(13) + chr(10) else 'LF'}"
                original = coder_text.replace(shipped_line + "\n", "" if variant_line is None else variant_line + "\n").replace("\n", newline).encode("utf-8")
                (variant_release / coder_rel).write_bytes(original)
                if not (vp / fw.RECORD_REL).exists():
                    fw.cmd_install(variant_release, vp)
                else:  # the next spelling arrives as an upstream change to the Coder's file
                    fw.cmd_update(variant_release, vp, check=False)
                assert coder.read_bytes() == original, label
                ws.commit(vp, ws.plan_set(vp, ["workflow-coder"], ["graphify"]))
                with_addition = coder.read_bytes()
                assert with_addition != original and ws.read_skills(with_addition.decode("utf-8"))[-1] == "graphify", label
                code, lines = fw.cmd_verify(vp)
                assert code == 0 and not any(level != "OK" for level, _ in lines), (label, lines)
                quiet = fw.cmd_update(variant_release, vp, check=True)
                assert quiet["changed"] is False and not quiet["plan"]["skills"] and not quiet["plan"]["overwrite_local"], (label, quiet["plan"])

                # a real hand edit of an agent that carries an addition is still reported
                coder.write_bytes(with_addition + b"hand edit\n")
                code, lines = fw.cmd_verify(vp)
                assert any(level == "WARN" and "workflow-coder.md" in text for level, text in lines), (label, lines)
                edited = fw.cmd_update(variant_release, vp, check=True)["plan"]
                assert coder_rel in edited["update"] and coder_rel in edited["overwrite_local"], (label, edited)
                coder.write_bytes(with_addition)

                # the addition disappears from the file while the overlay still records it:
                # verify reports it, the update plan repairs it and the update re-applies it
                coder.write_bytes(original)
                code, lines = fw.cmd_verify(vp)
                assert code == 1 and any(level == "FAIL" and "graphify" in text and "workflow-coder.md" in text for level, text in lines), (label, lines)
                repair = fw.cmd_update(variant_release, vp, check=True)
                assert repair["changed"] is True and repair["plan"]["skills"] == [coder_rel] and coder_rel not in repair["plan"]["update"], (label, repair["plan"])
                done = fw.cmd_update(variant_release, vp, check=False)
                assert coder.read_bytes() == with_addition and done["skills"]["changed"] == [coder_rel], (label, done["skills"])
                code, lines = fw.cmd_verify(vp)
                assert code == 0 and not any(level != "OK" for level, _ in lines), (label, lines)
                assert fw.cmd_update(variant_release, vp, check=True)["changed"] is False, label

                ws.commit(vp, ws.plan_set(vp, ["workflow-coder"], []))
                assert coder.read_bytes() == original and not (vp / ws.OVERLAY_REL).exists(), (label, "removal restores the shipped bytes")
                code, lines = fw.cmd_verify(vp)
                assert code == 0 and not any(level != "OK" for level, _ in lines), (label, lines)

        # --- legacy (pre-3.5) project: obsolete paths removed, clobbered README restored --
        legacy = new_repo(tmp / "legacy")
        fw.cmd_install(release, legacy)
        (legacy / fw.RECORD_REL).unlink()
        (legacy / "AI_Workflow_Kit/experiments/context-economy").mkdir(parents=True)
        (legacy / "AI_Workflow_Kit/experiments/context-economy/overlay.tar.bz2.b64.part-000.txt").write_text("x", encoding="utf-8")
        (legacy / "AI_Workflow_Kit/script/workflow_experiment.sh").write_text("#!/bin/sh\n", encoding="utf-8")
        (legacy / "VERSION").write_text("3.4.2\n", encoding="utf-8")
        (legacy / fw.VERSION_REL).unlink()
        # The legacy updater's backup may be days old by the time the user
        # finishes the update: restore anyway (the byte-identical check is the
        # safety), skipping backups that hold a framework README themselves.
        old_backup = legacy / ".git/pavans-workflow/update-backups" / "20260101T000000Z"
        old_backup.mkdir(parents=True)
        (old_backup / "README.md").write_text("# Legacy product\n", encoding="utf-8")
        framework_backup = legacy / ".git/pavans-workflow/update-backups" / "20260102T000000Z"
        framework_backup.mkdir(parents=True)
        (framework_backup / "README.md").write_text("# Pavan's Workflow\n\nold framework readme\n", encoding="utf-8")
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
