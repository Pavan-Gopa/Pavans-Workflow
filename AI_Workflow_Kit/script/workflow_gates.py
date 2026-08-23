#!/usr/bin/env python3
"""Run backticked Objective Gate commands for the current (or named) step."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

STEP_HEADING = re.compile(
    r"^##[ \t]+([A-Za-z0-9][A-Za-z0-9._/-]*)[ \t]+(?:—|-)[ \t]+(.+?)\s*$",
    re.M,
)
OBJECTIVE_SECTION = re.compile(
    r"(?:^|\n)(?:#{3,}\s+Objective gates\s*|\*\*Objective gates:\*\*[^\n]*)\n(.*?)(?=\n(?:#{2,}\s+|\*\*[A-Za-z][^:\n]{0,40}:\*\*)|\Z)",
    re.I | re.S,
)
GATE_LINE = re.compile(
    r"^\s*[-*]\s*\[(?P<done>[ xX])\]\s*(?:\[(?P<id>[^\]]+)\]\s*)?(?P<body>.+?)\s*$"
)
COMMAND = re.compile(r"`([^`]+)`")
CURRENT_STEP = re.compile(r"^current_step:\s*(.+?)\s*$", re.M)


def repo_root_from_here() -> Path:
    return Path(__file__).resolve().parents[2]


def strip_scalar(value: str) -> str:
    text = value.strip()
    if (text.startswith('"') and text.endswith('"')) or (text.startswith("'") and text.endswith("'")):
        text = text[1:-1]
    comment = re.search(r"\s+#", text)
    if comment:
        text = text[: comment.start()]
    if text in {"null", "~", "-", ""}:
        return ""
    return text.strip()


def current_step_id(state_path: Path, explicit: str | None) -> str:
    if explicit:
        return explicit
    text = state_path.read_text(encoding="utf-8")
    match = CURRENT_STEP.search(text)
    if not match:
        raise SystemExit("ERROR: current_step missing from STATE.yaml")
    step = strip_scalar(match.group(1))
    if not step:
        raise SystemExit("ERROR: current_step is empty")
    return step


def parse_cards(steps_text: str) -> dict[str, str]:
    matches = list(STEP_HEADING.finditer(steps_text))
    cards: dict[str, str] = {}
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(steps_text)
        cards[match.group(1)] = steps_text[start:end]
    return cards


def looks_like_command(command: str) -> bool:
    text = command.strip()
    if not text or " " not in text and "/" not in text and text in {"true", "false"}:
        return False
    if re.match(r"^(npm|pnpm|yarn|bun|cargo|go|pytest|python3?|node|bash|make|uv|deno|git|omp)\b", text):
        return True
    if text.startswith("./") or text.startswith("bash ") or text.endswith(".sh"):
        return True
    if re.search(r"\b(test|lint|build|typecheck|vitest|jest|mocha)\b", text):
        return True
    return bool(re.match(r"^[A-Za-z0-9._/-]+(\s+.+)?$", text)) and not text.endswith(".")


def extract_gates(body: str) -> list[dict[str, object]]:
    section = OBJECTIVE_SECTION.search(body)
    if not section:
        return []
    gates: list[dict[str, object]] = []
    for raw in section.group(1).splitlines():
        match = GATE_LINE.match(raw)
        if not match:
            continue
        body_text = match.group("body")
        command_match = COMMAND.search(body_text)
        command = command_match.group(1).strip() if command_match else ""
        runnable = bool(command) and looks_like_command(command)
        gates.append(
            {
                "id": (match.group("id") or "").strip() or None,
                "done": match.group("done").lower() == "x",
                "text": body_text.strip(),
                "command": command if runnable else None,
                "kind": "command" if runnable else "manual",
            }
        )
    return gates


def run_command(command: str, cwd: Path, timeout: int) -> dict[str, object]:
    try:
        completed = subprocess.run(
            command,
            shell=True,
            cwd=cwd,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        return {
            "exit_code": 124,
            "timed_out": True,
            "stdout_tail": (exc.stdout or "")[-2000:] if isinstance(exc.stdout, str) else "",
            "stderr_tail": (exc.stderr or "")[-2000:] if isinstance(exc.stderr, str) else f"timed out after {timeout}s",
        }
    stdout = completed.stdout or ""
    stderr = completed.stderr or ""
    return {
        "exit_code": completed.returncode,
        "timed_out": False,
        "stdout_tail": stdout[-2000:],
        "stderr_tail": stderr[-2000:],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", nargs="?", default="run", choices=["run", "list"])
    parser.add_argument("--step", default=None)
    parser.add_argument("--project", default=None)
    parser.add_argument("--timeout", type=int, default=int(os.environ.get("WF_GATE_TIMEOUT", "120")))
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    root = Path(args.project).resolve() if args.project else repo_root_from_here()
    steps_path = root / "AI_Workflow_Kit" / "docs" / "STEPS.md"
    state_path = root / "AI_Workflow_Kit" / "docs" / "AI" / "STATE.yaml"
    if not steps_path.is_file():
        print(f"ERROR: missing {steps_path}", file=sys.stderr)
        return 2

    step_id = current_step_id(state_path, args.step) if state_path.is_file() or args.step else ""
    if not args.step and not state_path.is_file():
        print("ERROR: STATE.yaml missing and --step not given", file=sys.stderr)
        return 2
    cards = parse_cards(steps_path.read_text(encoding="utf-8"))
    if step_id not in cards:
        print(f"ERROR: step {step_id} not found in STEPS.md", file=sys.stderr)
        return 2

    gates = extract_gates(cards[step_id])
    results = []
    failed = 0
    for gate in gates:
        item = dict(gate)
        if args.action == "run" and gate["kind"] == "command":
            outcome = run_command(str(gate["command"]), root, args.timeout)
            item.update(outcome)
            item["ok"] = outcome["exit_code"] == 0
            if not item["ok"]:
                failed += 1
        elif gate["kind"] == "command":
            item["ok"] = None
        else:
            item["ok"] = None
        results.append(item)

    payload = {
        "step": step_id,
        "gate_count": len(results),
        "command_gates": sum(1 for item in results if item["kind"] == "command"),
        "failed_commands": failed,
        "status": "fail" if failed else "pass" if any(item["kind"] == "command" for item in results) else "no_commands",
        "gates": results,
    }
    if args.json:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
    else:
        print(f"step {payload['step']} · {payload['status']} · {payload['command_gates']} command / {payload['gate_count']} gates")
        for item in results:
            mark = "OK  " if item.get("ok") is True else "FAIL" if item.get("ok") is False else "SKIP"
            label = item.get("id") or "(ungated)"
            detail = item.get("command") or item.get("text")
            print(f"{mark} {label} · {detail}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
