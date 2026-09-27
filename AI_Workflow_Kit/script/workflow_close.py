#!/usr/bin/env python3
"""Deterministic step-close decision after a verified Coder/Designer result.

  workflow_close.py check [--step S] [--base auto|REF|none] [--json]

Combines, in code, everything a `quick` close used to rely on Main remembering:

  1. Objective gates   (workflow_gates.py)  — every command gate must pass.
  2. Worker guard      (workflow_guard.py)  — the latest verdict for the step.
  3. Blast radius      (workflow_security_scope.py, diff vs the pre-step tag).
  4. Card facts        — **Risk:** and **Pipeline profile:** from STEPS.md.

decision:
  close_quick          quick card, all objective gates green, >=1 command gate,
                       clean guard, no blast-radius hit, risk not high
  review               continue with Reviewer (and Tester) — includes quick
                       cards that were refused, with the reasons listed
  reopen_coder         an Objective gate failed
  reject_worker_result the guard found a boundary violation

Exit: 0 close_quick/review · 1 reopen_coder/reject_worker_result · 2 error.
The decision is also written to <git-common-dir>/pavans-workflow/close-checks/<step>.json.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPT_DIR / f"{name}.py")
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def common_git_dir(root: Path) -> Path | None:
    try:
        output = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--git-common-dir"], capture_output=True, text=True, check=True
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None
    path = Path(output)
    return path if path.is_absolute() else (root / path).resolve()


def decide(root: Path, step: str | None, base: str, run_gates: bool, timeout: int) -> dict[str, object]:
    gates_mod = load("workflow_gates")
    scope_mod = load("workflow_security_scope")
    guard_mod = load("workflow_guard")

    gates = gates_mod.evaluate(root, step, run_gates, timeout)
    step_id = str(gates["step"])
    resolved_base = scope_mod.resolve_base(root, base, step_id)
    scope = scope_mod.scope(scope_mod.git_paths(root, resolved_base), root, resolved_base)
    try:
        guard = guard_mod.cmd_status(guard_mod.repo_root(root), step_id)
    except guard_mod.GuardError as error:
        guard = {"verdict": "unavailable", "error": str(error)}

    profile = str(gates["pipeline_profile"])
    risk = str(gates["risk"])
    guard_verdict = str(guard.get("verdict"))
    quick_blockers: list[str] = []
    if risk == "high":
        quick_blockers.append("card risk is high")
    if scope["forbid_quick"]:
        quick_blockers.append("blast radius: " + ", ".join(scope["reasons"]))  # type: ignore[arg-type]
    if not gates["command_gates"]:
        quick_blockers.append("no deterministic Objective gate (a quick close needs at least one command gate)")
    if guard_verdict in {"missing", "unavailable"}:
        quick_blockers.append("no guard verdict for this step")
    elif guard_verdict == "unscoped":
        quick_blockers.append("Coder scope unverified: STATE.yaml target_files was empty")

    if gates["status"] == "fail":
        decision = "reopen_coder"
    elif guard_verdict == "violation":
        decision = "reject_worker_result"
    elif profile == "quick" and not quick_blockers and run_gates:
        decision = "close_quick"
    else:
        decision = "review"

    effective = "quick" if decision == "close_quick" else ("critical" if profile == "critical" else "standard")
    return {
        "step": step_id,
        "decision": decision,
        "requested_profile": profile,
        "effective_profile": effective,
        "quick_forbidden": profile == "quick" and decision != "close_quick",
        "quick_blockers": quick_blockers if profile == "quick" else [],
        "offer_scoped_security": bool(scope["offer_scoped"]),
        "risk": risk,
        "card_sha256": gates["card_sha256"],
        "objective": {
            "status": gates["status"],
            "command_gates": gates["command_gates"],
            "failed": [gate.get("id") for gate in gates["gates"] if gate.get("ok") is False],  # type: ignore[union-attr]
        },
        "guard": {key: guard.get(key) for key in ("verdict", "id", "role", "agent", "violations", "notes", "error") if key in guard},
        "scope": {key: scope[key] for key in ("base", "reasons", "forbid_hits", "hits", "checked")},
        "checked_at": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def record(root: Path, payload: dict[str, object]) -> str | None:
    common = common_git_dir(root)
    if common is None:
        return None
    directory = common / "pavans-workflow" / "close-checks"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{payload['step']}.json"
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temporary.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)
    return str(path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("action", nargs="?", default="check", choices=["check"])
    parser.add_argument("--step", default=None)
    parser.add_argument("--project", default=None)
    parser.add_argument("--base", default="auto")
    parser.add_argument("--no-run", action="store_true", help="list gates without running them (never close_quick)")
    parser.add_argument("--timeout", type=int, default=int(os.environ.get("WF_GATE_TIMEOUT", "120")))
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    root = Path(args.project).resolve() if args.project else SCRIPT_DIR.parents[1]
    try:
        payload = decide(root, args.step, args.base, not args.no_run, args.timeout)
    except (ValueError, OSError, RuntimeError, SystemExit) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2
    payload["evidence"] = record(root, payload)
    if args.json:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
    else:
        print(f"step {payload['step']} · decision {payload['decision']} · profile {payload['requested_profile']} -> {payload['effective_profile']}")
        for blocker in payload["quick_blockers"]:  # type: ignore[union-attr]
            print(f"  quick refused: {blocker}")
        if payload["offer_scoped_security"]:
            print("  offer a scoped Security pass (blast radius: " + ", ".join(payload["scope"]["reasons"]) + ")")  # type: ignore[index]
        for violation in payload["guard"].get("violations") or []:  # type: ignore[union-attr]
            print(f"  guard violation: {violation['path']}: {violation['reason']}")
        for gate in payload["objective"]["failed"]:  # type: ignore[index]
            print(f"  objective gate failed: {gate}")
    return 1 if payload["decision"] in {"reopen_coder", "reject_worker_result"} else 0


if __name__ == "__main__":
    raise SystemExit(main())
