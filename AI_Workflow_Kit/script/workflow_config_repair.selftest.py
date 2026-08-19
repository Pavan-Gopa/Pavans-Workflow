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
  workflow_orchestrator: custom/main
  workflow_coder: custom/coder

retry:
  enabled: true
'''
normalized, notes = mod.normalize_config_text(base)
assert "workflow_orchestrator: custom/main" in normalized
assert "workflow_coder: custom/coder" in normalized
assert 'workflow_designer: "@workflow_architect"' in normalized
assert mod.validate_config_text(normalized) == []

broken = normalized.replace('"@workflow_architect"', '@workflow_architect').replace('"@workflow_reviewer"', '@workflow_reviewer')
repaired, notes = mod.normalize_config_text(broken)
assert 'workflow_designer: "@workflow_architect"' in repaired
assert 'workflow_design_advisor: "@workflow_reviewer"' in repaired
assert any("quoted" in note for note in notes)
assert mod.validate_config_text(repaired) == []

with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp) / "project"
    omp = root / ".omp"
    omp.mkdir(parents=True)
    upstream = Path(tmp) / "upstream.yml"
    upstream.write_text(base, encoding="utf-8")
    broken_path = omp / "config.yml.broken-123"
    custom = broken.replace("custom/main", "provider/my-main").replace("custom/coder", "provider/my-coder")
    broken_path.write_text(custom, encoding="utf-8")
    label, notes = mod.repair_project(root, upstream, None)
    result = (omp / "config.yml").read_text(encoding="utf-8")
    assert label == "OMP broken backup"
    assert "provider/my-main" in result and "provider/my-coder" in result
    assert mod.validate_config_text(result) == []

with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp) / "project"
    (root / ".omp").mkdir(parents=True)
    git = Path(tmp) / ".git"
    backup = git / "pavans-workflow/update-backups/20260819T000000Z/.omp"
    backup.mkdir(parents=True)
    (backup / "config.yml").write_text(base.replace("custom/main", "backup/main"), encoding="utf-8")
    upstream = Path(tmp) / "upstream.yml"
    upstream.write_text(base, encoding="utf-8")
    label, notes = mod.repair_project(root, upstream, git)
    result = (root / ".omp/config.yml").read_text(encoding="utf-8")
    assert label == "workflow update backup"
    assert "backup/main" in result
    assert mod.validate_config_text(result) == []

print("workflow config repair selftest: PASS")
