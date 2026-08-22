#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
from pathlib import Path

MODULE = Path(__file__).with_name("workflow_experiment_config.py")
spec = importlib.util.spec_from_file_location("workflow_experiment_config", MODULE)
assert spec and spec.loader
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

base = '''modelRoleStorage: project

modelRoles:
  workflow_orchestrator: custom/main:medium
  workflow_coder: custom/coder:max

cycleOrder:
  - slow
  - default

contextPromotion:
  enabled: true
  customRule: keep-me

compaction:
  enabled: false
  thresholdPercent: 77
  reserveTokens: 54321
  methodOrder:
    - remote
    - handoff

task:
  maxRuntimeMs: 14400000
  softRequestBudget: 0
'''

applied = mod.apply_experiment(base)
assert mod.validate_experiment(applied) == []
assert "workflow_orchestrator: custom/main:medium" in applied
assert "workflow_coder: custom/coder:max" in applied
assert "customRule: keep-me" in applied
assert "reserveTokens: 54321" in applied
assert applied.count(mod.MARKER) == 1
assert mod.apply_experiment(applied) == applied

changed_during_experiment = applied.replace("custom/main:medium", "new/main:high").replace("reserveTokens: 54321", "reserveTokens: 60000")
restored = mod.restore_experiment(changed_during_experiment, base)
assert mod.MARKER not in restored
assert "new/main:high" in restored
assert "reserveTokens: 54321" in restored
assert "thresholdPercent: 77" in restored
assert "customRule: keep-me" in restored
assert "- slow" in restored and "- default" in restored

minimal = '''modelRoles:
  workflow_orchestrator: x/main
  workflow_coder: x/coder
'''
minimal_applied = mod.apply_experiment(minimal)
assert mod.validate_experiment(minimal_applied) == []
assert minimal_applied.count("compaction:") == 1
assert minimal_applied.count("contextPromotion:") == 1
assert minimal_applied.count("cycleOrder:") == 1
minimal_restored = mod.restore_experiment(minimal_applied, minimal)
assert "compaction:" not in minimal_restored
assert "contextPromotion:" not in minimal_restored
assert "cycleOrder:" not in minimal_restored
assert "x/main" in minimal_restored

print("workflow experiment config selftest: PASS")
