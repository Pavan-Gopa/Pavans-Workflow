#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("diversity", Path(__file__).with_name("workflow_model_diversity.py"))
assert spec and spec.loader
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

BALANCED = """modelRoles:
  workflow_orchestrator: "@default"
  workflow_coder: a/coder:max
  workflow_reviewer: b/review:high
  workflow_tester: a/tester:max
  workflow_architect: c/arch:high
  workflow_security: c/sec:max
  workflow_orchestrator_backup: b/main:high
  workflow_coder_backup: c/coder:high
  workflow_reviewer_backup: a/review:high
  workflow_tester_backup: b/tester:high
  workflow_architect_backup: a/arch:high
  workflow_security_backup: b/sec:max
task:
  maxConcurrency: 1
"""
assert mod.analyse(mod.read_roles(BALANCED)) == []

same_as_coder = BALANCED.replace("workflow_reviewer: b/review:high", "workflow_reviewer: a/coder:low")
codes = [item["code"] for item in mod.analyse(mod.read_roles(same_as_coder))]
assert "reviewer_not_independent" in codes, codes

alias_to_backup = BALANCED.replace("workflow_reviewer: b/review:high", 'workflow_reviewer: "@workflow_coder_backup"')
codes = [item["code"] for item in mod.analyse(mod.read_roles(alias_to_backup))]
assert codes.count("reviewer_not_independent") == 1, "aliases resolve before comparison"

same_provider = BALANCED.replace("workflow_tester_backup: b/tester:high", "workflow_tester_backup: a/tester:high")
codes = [item["code"] for item in mod.analyse(mod.read_roles(same_provider))]
assert codes == ["backup_same_provider"], codes

concentrated = BALANCED
for role in ("coder", "tester", "architect", "security"):
    concentrated = __import__("re").sub(rf"workflow_{role}_backup: \S+", f"workflow_{role}_backup: b/flash:high", concentrated)
codes = [item["code"] for item in mod.analyse(mod.read_roles(concentrated))]
assert "backup_concentration" in codes, codes

cycle = 'modelRoles:\n  workflow_reviewer: "@workflow_coder"\n  workflow_coder: "@workflow_reviewer"\n'
assert mod.analyse(mod.read_roles(cycle)) == [], "alias cycles never crash"

print("workflow_model_diversity.selftest: PASS")
