#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ROUTE = ROOT / "AI_Workflow_Kit" / "script" / "workflow_route.py"

STEPS = """# Steps

## S1 — Standard
**Risk:** normal
**Pipeline profile:** standard

### Objective gates

- [ ] [S1.O1] `$ true` exits 0

## S2 — Critical
**Risk:** normal
**Pipeline profile:** critical

### Objective gates

- [ ] [S2.O1] `$ true` exits 0

## S3 — High Risk
**Risk:** high
**Pipeline profile:** standard

### Objective gates

- [ ] [S3.O1] `$ true` exits 0

## S4 — No Commands
**Risk:** normal
**Pipeline profile:** standard

### Objective gates

- [ ] [S4.O1] manual check only
"""


def write_project(tmp: Path, config_text: str) -> None:
    (tmp / "AI_Workflow_Kit" / "docs" / "AI").mkdir(parents=True, exist_ok=True)
    (tmp / ".omp").mkdir(parents=True, exist_ok=True)
    (tmp / "AI_Workflow_Kit" / "docs" / "STEPS.md").write_text(STEPS, encoding="utf-8")
    (tmp / "AI_Workflow_Kit" / "docs" / "AI" / "STATE.yaml").write_text("current_step: S1\n", encoding="utf-8")
    (tmp / ".omp" / "config.yml").write_text(config_text, encoding="utf-8")


def run_route(tmp: Path, step: str, metrics_path: Path | None = None) -> dict[str, object]:
    cmd = [sys.executable, str(ROUTE), "coder", "--project", str(tmp), "--step", step, "--json"]
    if metrics_path:
        cmd.extend(["--metrics-path", str(metrics_path)])
    completed = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return json.loads(completed.stdout)


def main() -> int:
    default_config = """modelRoles:
  workflow_coder: provider/strong-coder
  workflow_coder_fast: provider/fast-coder
"""
    alias_config = """modelRoles:
  workflow_coder: provider/strong-coder
  workflow_coder_fast: "@workflow_coder"
"""

    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        write_project(tmp, alias_config)

        # Rule 1: fast_not_configured when fast aliases primary
        res1 = run_route(tmp, "S1")
        assert res1["agent"] == "workflow-coder"
        assert res1["reason_code"] == "fast_not_configured"

        # Update config to have distinct fast model
        (tmp / ".omp" / "config.yml").write_text(default_config, encoding="utf-8")

        # Fast first success
        res_fast = run_route(tmp, "S1")
        assert res_fast["agent"] == "workflow-coder-fast"
        assert res_fast["reason_code"] == "fast_first"

        # Rule 3: critical_profile
        res3 = run_route(tmp, "S2")
        assert res3["agent"] == "workflow-coder"
        assert res3["reason_code"] == "critical_profile"

        # Rule 4: high_risk
        res4 = run_route(tmp, "S3")
        assert res4["agent"] == "workflow-coder"
        assert res4["reason_code"] == "high_risk"

        # Rule 5: no_command_gate
        res5 = run_route(tmp, "S4")
        assert res5["agent"] == "workflow-coder"
        assert res5["reason_code"] == "no_command_gate"

        # Rule 2: retry (metrics store has worker_started for S1)
        metrics_file = tmp / "events.jsonl"
        metrics_file.write_text(json.dumps({
            "schema_version": 1,
            "ts": "2026-10-08T10:00:00.000Z",
            "event": "worker_started",
            "event_key": "worker_started:1",
            "step": "S1",
            "run_id": "r1",
            "role": "coder_fast",
            "model": "provider/fast-coder",
        }) + "\n", encoding="utf-8")

        res2 = run_route(tmp, "S1", metrics_file)
        assert res2["agent"] == "workflow-coder"
        assert res2["reason_code"] == "retry"

        # Rule 6: auto_disabled (10 resolved attempts with < 5 first_pass)
        events = []
        # Create 10 resolved attempts for provider/fast-coder on steps T1..T10
        # 4 succeed, 6 fail
        for i in range(1, 11):
            step_id = f"T{i}"
            events.append({
                "schema_version": 1,
                "ts": f"2026-10-08T10:{i:02d}:00.000Z",
                "event": "worker_started",
                "event_key": f"worker_started:{step_id}",
                "step": step_id,
                "run_id": f"run_{step_id}",
                "role": "coder_fast",
                "model": "provider/fast-coder",
            })
            if i <= 4:
                # First pass success: step_completed follows
                events.append({
                    "schema_version": 1,
                    "ts": f"2026-10-08T10:{i:02d}:30.000Z",
                    "event": "step_completed",
                    "event_key": f"step_completed:{step_id}",
                    "step": step_id,
                })
            else:
                # Resolved failure: later coder_start follows
                events.append({
                    "schema_version": 1,
                    "ts": f"2026-10-08T10:{i:02d}:30.000Z",
                    "event": "worker_started",
                    "event_key": f"worker_started:{step_id}_strong",
                    "step": step_id,
                    "run_id": f"run_{step_id}_strong",
                    "role": "coder",
                    "model": "provider/strong-coder",
                })

        metrics_file.write_text("\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8")

        res6 = run_route(tmp, "S1", metrics_file)
        assert res6["agent"] == "workflow-coder"
        assert res6["reason_code"] == "auto_disabled"
        assert res6["window"]["resolved"] == 10
        assert res6["window"]["first_pass"] == 4

        # Model change resets window
        new_model_config = """modelRoles:
  workflow_coder: provider/strong-coder
  workflow_coder_fast: provider/new-fast-coder
"""
        (tmp / ".omp" / "config.yml").write_text(new_model_config, encoding="utf-8")

        res_reset = run_route(tmp, "S1", metrics_file)
        assert res_reset["agent"] == "workflow-coder-fast"
        assert res_reset["reason_code"] == "fast_first"
        assert res_reset["window"]["model"] == "provider/new-fast-coder"
        assert res_reset["window"]["resolved"] == 0

        # Rule 2 without metrics: a close check already written for the step proves a Coder ran.
        subprocess.run(["git", "init", "-q", str(tmp)], check=True)
        checks = tmp / ".git" / "pavans-workflow" / "close-checks"
        checks.mkdir(parents=True)
        (checks / "S1.json").write_text("{}\n", encoding="utf-8")
        res_checked = run_route(tmp, "S1", tmp / "missing-events.jsonl")
        assert res_checked["agent"] == "workflow-coder"
        assert res_checked["reason_code"] == "retry"

    print("workflow_route.selftest: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
