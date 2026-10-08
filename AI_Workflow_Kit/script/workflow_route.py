#!/usr/bin/env python3
"""Deterministic agent routing for Coder assignments.

  workflow_route.py coder [--step S] [--project P] [--json]

Decides whether a Coder step assignment should dispatch `workflow-coder-fast`
or escalate to `workflow-coder` based on role configuration, retry status,
card facts, objective gates, and recent fast coder performance window.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent


def load_module(name: str):
    path = SCRIPT_DIR / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    if not spec or not spec.loader:
        raise RuntimeError(f"unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def repo_root(start: Path | None = None) -> Path:
    current = (start or Path.cwd()).resolve()
    for parent in [current, *current.parents]:
        if (parent / ".git").exists() or (parent / "AI_Workflow_Kit" / "framework.manifest").exists():
            return parent
    return current


def state_current_step(project: Path) -> str | None:
    state_path = project / "AI_Workflow_Kit" / "docs" / "AI" / "STATE.yaml"
    if not state_path.is_file():
        return None
    for line in state_path.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("current_step:"):
            val = line.split(":", 1)[1].split("#")[0].strip()
            return val or None
    return None


def close_check_exists(root: Path, step: str) -> bool:
    """A close check for the step proves a Coder candidate already ran, even when metrics were not recorded."""
    common = load_module("workflow_close").common_git_dir(root)
    return common is not None and (common / "pavans-workflow" / "close-checks" / f"{step}.json").is_file()


def route_coder(root: Path, step: str | None = None, metrics_path: Path | None = None) -> dict[str, object]:
    gates_mod = load_module("workflow_gates")
    metrics_mod = load_module("workflow_metrics")

    if not step:
        step = state_current_step(root)
    if not step:
        raise ValueError("current_step not found in STATE.yaml and --step not given")

    # 1. Resolve fast_model and coder_model
    fast_model, _ = metrics_mod.resolve_config_model("workflow_coder_fast", root)
    coder_model, _ = metrics_mod.resolve_config_model("workflow_coder", root)

    # 2. Read metrics events
    events: list[dict[str, object]] = []
    try:
        store_override = metrics_path or (Path(os.environ[metrics_mod.METRICS_ENV]) if metrics_mod.METRICS_ENV in os.environ else None)
        events_path, _ = metrics_mod.resolve_store(override=store_override)
        if events_path.is_file():
            events, _, _ = metrics_mod.read_events(events_path)
    except Exception:
        events = []

    # 3. Calculate window for fast_model
    last_10: list[dict[str, object]] = []
    first_pass_count = 0
    if fast_model:
        fast_analysis = metrics_mod.analyze_fast_coder_attempts(events)
        resolved_attempts = [
            a for a in fast_analysis["attempts"]
            if a["model"] == fast_model and a["outcome"] in {"resolved_success", "resolved_failure"}
        ]
        last_10 = resolved_attempts[-10:]
        first_pass_count = sum(1 for a in last_10 if a["outcome"] == "resolved_success")

    window = {
        "model": fast_model,
        "resolved": len(last_10),
        "first_pass": first_pass_count,
        "size": 10,
        "threshold": 5,
    }

    # Gate facts
    gate_facts = gates_mod.evaluate(root, step, run=False, timeout=900)

    # Apply rules, first match wins
    if not fast_model or not coder_model or fast_model == coder_model:
        agent = "workflow-coder"
        reason_code = "fast_not_configured"
        reason = "Fast Coder is not configured or aliases Coder primary"
    elif any(
        e.get("event") == "worker_started" and e.get("role") in {"coder", "coder_fast"} and str(e.get("step")) == step
        for e in events
    ) or close_check_exists(root, step):
        agent = "workflow-coder"
        reason_code = "retry"
        reason = f"Step {step} already had a coder attempt"
    elif gate_facts.get("pipeline_profile") == "critical":
        agent = "workflow-coder"
        reason_code = "critical_profile"
        reason = f"Step {step} has critical pipeline profile"
    elif gate_facts.get("risk") == "high":
        agent = "workflow-coder"
        reason_code = "high_risk"
        reason = f"Step {step} has high risk level"
    elif gate_facts.get("command_gates", 0) == 0:
        agent = "workflow-coder"
        reason_code = "no_command_gate"
        reason = f"Step {step} has no command gates"
    elif len(last_10) >= 10 and first_pass_count < 5:
        agent = "workflow-coder"
        reason_code = "auto_disabled"
        reason = f"Fast Coder automatically disabled for model {fast_model} ({first_pass_count}/10 first pass < 5)"
    else:
        agent = "workflow-coder-fast"
        reason_code = "fast_first"
        reason = f"Fast Coder eligible for first attempt on step {step}"

    return {
        "step": step,
        "agent": agent,
        "reason_code": reason_code,
        "reason": reason,
        "fast_model": fast_model,
        "window": window,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("role", choices=["coder"], help="role to route")
    parser.add_argument("--step", default=None)
    parser.add_argument("--project", default=None)
    parser.add_argument("--metrics-path", default=None)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    root = Path(args.project).resolve() if args.project else repo_root()
    metrics_path = Path(args.metrics_path).resolve() if args.metrics_path else None

    try:
        payload = route_coder(root, args.step, metrics_path)
    except (ValueError, OSError, RuntimeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
    else:
        print(f"step {payload['step']} · agent {payload['agent']} · reason {payload['reason_code']} ({payload['reason']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
