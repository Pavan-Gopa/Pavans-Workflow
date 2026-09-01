#!/usr/bin/env python3
import importlib.util
import tempfile
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("workflow_config_repair.py")
spec = importlib.util.spec_from_file_location("workflow_config_repair", MODULE_PATH)
assert spec and spec.loader
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

base = '''modelRoleStorage: project

modelRoles:
  workflow_orchestrator: custom/main:high
  workflow_coder: custom/coder

retry:
  enabled: true

task:
  batch: true
  maxRuntimeMs: 1800000
  softRequestBudget: 120
  maxConcurrency: 1
'''
normalized, notes = mod.normalize_config_text(base)
assert "default: custom/main:high" in normalized
assert 'workflow_orchestrator: "@default"' in normalized
assert "workflow_coder: custom/coder" in normalized
assert 'workflow_designer: "@workflow_architect"' in normalized
assert "modelTags:" in normalized
assert "Main Orchestrator (managed by DEFAULT)" in normalized
assert "hidden: true" in normalized
assert "maxRuntimeMs: 14400000" in normalized
assert "softRequestBudget: 0" in normalized
assert "maxConcurrency: 1" in normalized
assert mod.validate_config_text(normalized) == []
assert any("migrated explicit workflow_orchestrator" in note for note in notes)
assert any("hidden model tag" in note for note in notes)

# DEFAULT is authoritative when both old slots exist; never overwrite it with a
# stale direct workflow_orchestrator value.
with_default = base.replace(
    "  workflow_orchestrator: custom/main:high\n",
    "  default: selected/main:max\n  workflow_orchestrator: stale/main:low\n",
)
with_default_normalized, _ = mod.normalize_config_text(with_default)
assert "default: selected/main:max" in with_default_normalized
assert "stale/main:low" not in with_default_normalized
assert mod.validate_config_text(with_default_normalized) == []

# "At least four hours": never lower a user-selected longer hard wall.
long_runtime = normalized.replace("maxRuntimeMs: 14400000", "maxRuntimeMs: 28800000")
long_runtime_repaired, _ = mod.normalize_config_text(long_runtime)
assert "maxRuntimeMs: 28800000" in long_runtime_repaired
assert mod.validate_config_text(long_runtime_repaired) == []

# The normalizer is idempotent and repairs bare aliases/visible managed tags.
broken = normalized.replace('"@workflow_architect"', '@workflow_architect').replace(
    "hidden: true", "hidden: false", 1
)
repaired, notes = mod.normalize_config_text(broken)
assert 'workflow_designer: "@workflow_architect"' in repaired
assert "hidden: true" in repaired
assert any("quoted" in note for note in notes)
assert any("hid managed workflow_orchestrator" in note for note in notes)
assert mod.validate_config_text(repaired) == []
second_pass, second_notes = mod.normalize_config_text(repaired)
assert second_pass == repaired
assert second_notes == []

missing_task = '''modelRoleStorage: project
modelRoles:
  workflow_orchestrator: custom/main
  workflow_coder: custom/coder
'''
repaired_missing_task, _ = mod.normalize_config_text(missing_task)
assert "task:" in repaired_missing_task
assert "default: custom/main" in repaired_missing_task
assert 'workflow_orchestrator: "@default"' in repaired_missing_task
assert "maxRuntimeMs: 14400000" in repaired_missing_task
assert "softRequestBudget: 0" in repaired_missing_task
assert mod.validate_config_text(repaired_missing_task) == []

visible = normalized.replace("hidden: true", "hidden: false", 1)
assert "modelTags.workflow_orchestrator.hidden must be true" in mod.validate_config_text(visible)

duplicate_tags = normalized.replace(
    "modelTags:\n  workflow_orchestrator:\n    name: Main Orchestrator (managed by DEFAULT)\n    hidden: true",
    "modelTags:\n  workflow_orchestrator:\n  workflow_orchestrator:\n    hidden: false",
)
repaired_duplicate_tags, duplicate_notes = mod.normalize_config_text(duplicate_tags)
assert repaired_duplicate_tags.count("  workflow_orchestrator:\n") == 1
assert "name: Main Orchestrator (managed by DEFAULT)" in repaired_duplicate_tags
assert "hidden: true" in repaired_duplicate_tags
assert any("removed duplicate model tag" in note for note in duplicate_notes)
assert mod.validate_config_text(repaired_duplicate_tags) == []

with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp) / "project"
    omp = root / ".omp"
    omp.mkdir(parents=True)
    upstream = Path(tmp) / "upstream.yml"
    upstream.write_text(base, encoding="utf-8")
    broken_path = omp / "config.yml.broken-123"
    custom = base.replace("custom/main:high", "provider/my-main:xhigh").replace("custom/coder", "provider/my-coder")
    broken_path.write_text(custom, encoding="utf-8")
    label, notes = mod.repair_project(root, upstream, None)
    result = (omp / "config.yml").read_text(encoding="utf-8")
    assert label == "OMP broken backup"
    assert "default: provider/my-main:xhigh" in result and "provider/my-coder" in result
    assert 'workflow_orchestrator: "@default"' in result
    assert "hidden: true" in result
    assert "maxRuntimeMs: 14400000" in result
    assert "softRequestBudget: 0" in result
    assert mod.validate_config_text(result) == []

with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp) / "project"
    (root / ".omp").mkdir(parents=True)
    git = Path(tmp) / ".git"
    backup = git / "pavans-workflow/update-backups/20260819T000000Z/.omp"
    backup.mkdir(parents=True)
    (backup / "config.yml").write_text(base.replace("custom/main:high", "backup/main:max"), encoding="utf-8")
    upstream = Path(tmp) / "upstream.yml"
    upstream.write_text(base, encoding="utf-8")
    label, notes = mod.repair_project(root, upstream, git)
    result = (root / ".omp/config.yml").read_text(encoding="utf-8")
    assert label == "workflow update backup"
    assert "default: backup/main:max" in result
    assert 'workflow_orchestrator: "@default"' in result
    assert "hidden: true" in result
    assert "maxRuntimeMs: 14400000" in result
    assert "softRequestBudget: 0" in result
    assert mod.validate_config_text(result) == []

print("workflow config repair selftest: PASS")
