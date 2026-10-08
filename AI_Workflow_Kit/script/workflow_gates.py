#!/usr/bin/env python3
"""List or run the Objective Gate commands of the current (or named) step card.

  workflow_gates.py list [--step S1] [--json]
  workflow_gates.py run  [--step S1] [--json] [--require-commands] [--timeout 900]

A gate runs when its line contains a backticked command:

  - [ ] [S1.O1] `$ npm test -- --run` exits 0        explicit marker (always runs)
  - [ ] [S1.O2] `pytest -q tests/unit` exits 0        recognised runner (npm, pytest, …)
  - [ ] [S1.O3] `./script/check.sh` exits 0           executable path

Backticked names that are not commands (`README.md`, `maxRetries`) stay manual
evidence. Every command on a line must pass. Fenced code blocks and template
cards are ignored, exactly like the Alt+W dashboard.

Exit codes: 0 pass (or no command gates without --require-commands),
1 a command gate failed, 2 usage/parse error, 3 no command gates with
--require-commands (a `quick` close needs at least one deterministic gate).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
from pathlib import Path

STEP_HEADING = re.compile(r"^##[ \t]+([A-Za-z0-9][A-Za-z0-9._/-]*)[ \t]+(?:—|-)[ \t]+(.+?)\s*$", re.M)
SECTION_HEADING = re.compile(r"^(?:#{3,}[ \t]+(?P<hash>[^\n]+?)|\*\*(?P<bold>[A-Za-z][^:\n]{0,40}):\*\*[^\n]*)[ \t]*$", re.M)
OBJECTIVE_NAMES = ("objective gates", "done when")
GATE_LINE = re.compile(r"^\s*(?:[-*]|\d+[.)])\s*\[(?P<done>[ xX])\]\s*(?:\[(?P<id>[^\]]+)\]\s*)?(?P<body>.+?)\s*$")
BACKTICK = re.compile(r"`([^`\n]+)`")
CURRENT_STEP = re.compile(r"^current_step:\s*(.+?)\s*$", re.M)
RISK = re.compile(r"\*\*Risk:\*\*\s*(low|normal|high)", re.I)
PROFILE = re.compile(r"\*\*Pipeline(?:\s+profile)?:\*\*\s*(quick|standard|critical)", re.I)
TEMPLATE_TITLES = {"title", "short title", "step title", "placeholder"}
RUNNERS = (
    "npm", "npx", "pnpm", "yarn", "bun", "bunx", "deno", "node", "tsc", "vitest", "jest", "playwright",
    "python", "python3", "pytest", "uv", "uvx", "tox", "nox", "poetry", "ruff", "mypy",
    "cargo", "go", "make", "just", "task", "cmake", "ctest", "bazel",
    "swift", "xcodebuild", "gradle", "mvn", "dotnet", "ruby", "bundle", "rake", "rspec", "php", "composer",
    "bash", "sh", "zsh", "git", "omp", "graphify", "docker", "kubectl", "terraform", "shellcheck",
    "flutter", "dart", "turbo", "nx", "lerna", "mix", "sbt", "phpunit", "pest", "rails", "xcrun",
    "eslint", "prettier", "biome", "stylelint", "golangci-lint", "swiftlint", "ktlint", "mvnw", "gradlew",
)
# Runners that are meaningful without arguments (`make`, `pytest`); every other
# runner needs at least one argument so a backticked identifier such as `task`
# or `node` is never executed by accident.
BARE_RUNNERS = ("make", "pytest", "tox", "nox", "ctest", "rspec", "rake", "jest", "vitest", "tsc", "mypy", "just")
_ENV_PREFIX = r"(?:[A-Z_][A-Z0-9_]*=\S*\s+)*"
RUNNER = re.compile(
    rf"^{_ENV_PREFIX}(?:(?:{'|'.join(re.escape(item) for item in RUNNERS)})\s+\S"
    rf"|(?:{'|'.join(re.escape(item) for item in BARE_RUNNERS)})$)"
)
# Explicit relative executables (./x, ../x) or a script path with a directory.
PATH_COMMAND = re.compile(rf"^{_ENV_PREFIX}(?:\.{{1,2}}/\S+|[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]*\.(?:sh|bash))(?:\s|$)")


def repo_root_from_here() -> Path:
    return Path(__file__).resolve().parents[2]


def strip_scalar(value: str) -> str:
    text = value.strip()
    comment = re.search(r"\s+#", text)
    if comment:
        text = text[: comment.start()]
    text = text.strip()
    if (text.startswith('"') and text.endswith('"')) or (text.startswith("'") and text.endswith("'")):
        text = text[1:-1]
    return "" if text in {"null", "~", "-", ""} else text.strip()


def current_step_id(state_path: Path) -> str:
    match = CURRENT_STEP.search(state_path.read_text(encoding="utf-8"))
    step = strip_scalar(match.group(1)) if match else ""
    if not step:
        raise SystemExit("ERROR: current_step missing or empty in STATE.yaml")
    return step


def strip_fences(text: str) -> str:
    """Blank fenced code blocks but keep line numbers stable (dashboard parity)."""
    return re.sub(r"```[\s\S]*?```", lambda block: re.sub(r"[^\n]", " ", block.group(0)), text)


def is_template_card(title: str, body: str) -> bool:
    normalized = re.sub(r"^_\((.*)\)_$", r"\1", title).strip("_ ").lower().replace("(", "").replace(")", "").strip()
    if normalized in TEMPLATE_TITLES or re.search(r"\btemplate(?: card)?\b", normalized):
        return True
    return bool(re.search(r"\{\{\s*(?:step|title|goal|item)", body, re.I))


def parse_cards(steps_text: str) -> dict[str, dict[str, str]]:
    visible = strip_fences(steps_text)
    matches = list(STEP_HEADING.finditer(visible))
    cards: dict[str, dict[str, str]] = {}
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(visible)
        body = visible[start:end]
        if is_template_card(match.group(2), body):
            continue
        cards[match.group(1)] = {"title": match.group(2).strip(), "body": body}
    return cards


def objective_lines(body: str) -> list[str]:
    headings = list(SECTION_HEADING.finditer(body))
    for preferred in OBJECTIVE_NAMES:
        for index, heading in enumerate(headings):
            name = (heading.group("hash") or heading.group("bold") or "").strip().lower()
            if name != preferred:
                continue
            end = headings[index + 1].start() if index + 1 < len(headings) else len(body)
            # A level-2 heading always ends the section.
            chunk = body[heading.end():end]
            stop = re.search(r"^##[ \t]", chunk, re.M)
            return (chunk[: stop.start()] if stop else chunk).splitlines()
    return []


# `cd dir && …`, `cd dir; …`, and `env [VAR=x] …` prefixes are skipped when
# deciding whether the rest is a command (the full text still runs).
_PREFIX = re.compile(r"^(?:cd\s+\S+\s*(?:&&|;)\s*|env(?:\s+-\S+)*\s+)+")


def command_from_span(span: str, root: Path | None = None) -> str | None:
    text = span.strip()
    if text.startswith("$ "):
        return text[2:].strip() or None
    core = _PREFIX.sub("", text)
    if RUNNER.match(core) or PATH_COMMAND.match(core):
        return text
    # An existing executable given by path (`vendor/bin/phpunit`, `bin/test`).
    first = core.split()[0] if core.split() else ""
    if root is not None and "/" in first and not first.startswith("/"):
        candidate = root / first
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return text
    return None


def extract_gates(body: str, root: Path | None = None) -> list[dict[str, object]]:
    gates: list[dict[str, object]] = []
    for raw in objective_lines(body):
        match = GATE_LINE.match(raw)
        if not match:
            continue
        text = match.group("body").strip()
        spans = BACKTICK.findall(text)
        commands = [command for command in (command_from_span(span, root) for span in spans) if command]
        gate: dict[str, object] = {
            "id": (match.group("id") or "").strip() or None,
            "done": match.group("done").lower() == "x",
            "text": text,
            "commands": commands,
            "command": commands[0] if commands else None,
            "kind": "command" if commands else "manual",
        }
        if spans and not commands:
            gate["note"] = "backticked text is not a recognised command; write `$ <command>` to run it"
        gates.append(gate)
    return gates


def card_facts(card: dict[str, str]) -> dict[str, object]:
    body = card["body"]
    risk = RISK.search(body)
    profile = PROFILE.search(body)
    return {
        "title": card["title"],
        "risk": risk.group(1).lower() if risk else "normal",
        "pipeline_profile": profile.group(1).lower() if profile else "standard",
        "card_sha256": hashlib.sha256(body.strip().encode("utf-8")).hexdigest(),
    }


def _tail(value: object) -> str:
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    return (value or "")[-2000:] if isinstance(value, str) else ""


def run_command(command: str, cwd: Path, timeout: int) -> dict[str, object]:
    process = subprocess.Popen(
        command,
        shell=True,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(process.pid, sig)
            except ProcessLookupError:
                break
            try:
                stdout, stderr = process.communicate(timeout=5)
                break
            except subprocess.TimeoutExpired:
                continue
        else:
            stdout, stderr = "", ""
        return {
            "exit_code": 124,
            "timed_out": True,
            "stdout_tail": _tail(stdout),
            "stderr_tail": (_tail(stderr) + f"\ntimed out after {timeout}s").strip(),
        }
    return {"exit_code": process.returncode, "timed_out": False, "stdout_tail": _tail(stdout), "stderr_tail": _tail(stderr)}


def evaluate(root: Path, step: str | None, run: bool, timeout: int) -> dict[str, object]:
    steps_path = root / "AI_Workflow_Kit" / "docs" / "STEPS.md"
    state_path = root / "AI_Workflow_Kit" / "docs" / "AI" / "STATE.yaml"
    if not steps_path.is_file():
        raise ValueError(f"missing {steps_path}")
    if not step:
        if not state_path.is_file():
            raise ValueError("STATE.yaml missing and --step not given")
        step = current_step_id(state_path)
    cards = parse_cards(steps_path.read_text(encoding="utf-8"))
    if step not in cards:
        raise ValueError(f"step {step} not found in STEPS.md (template cards and fenced examples are ignored)")
    gates = extract_gates(cards[step]["body"], root)
    failed = 0
    for gate in gates:
        gate["ok"] = None
        if not run or gate["kind"] != "command":
            continue
        runs = [dict(run_command(command, root, timeout), command=command) for command in gate["commands"]]  # type: ignore[union-attr]
        gate["runs"] = runs
        gate["ok"] = all(item["exit_code"] == 0 for item in runs)
        # Backward-compatible single-command fields.
        gate["exit_code"] = next((item["exit_code"] for item in runs if item["exit_code"] != 0), 0)
        gate["timed_out"] = any(item["timed_out"] for item in runs)
        if not gate["ok"]:
            failed += 1
    command_gates = sum(1 for gate in gates if gate["kind"] == "command")
    if failed:
        failing_gates = [g for g in gates if g["kind"] == "command" and not g.get("ok")]
        all_timeouts = all(
            all(r.get("timed_out") is True for r in g.get("runs", []) if r.get("exit_code") != 0 or r.get("timed_out"))
            for g in failing_gates
        )
        status = "timeout" if (failing_gates and all_timeouts) else "fail"
    else:
        status = "pass" if command_gates else "no_commands"
    if not run:
        status = "listed" if command_gates else "no_commands"
    return {
        "step": step,
        **card_facts(cards[step]),
        "gate_count": len(gates),
        "command_gates": command_gates,
        "failed_commands": failed,
        "status": status,
        "timeout_seconds": timeout,
        "gates": gates,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("action", nargs="?", default="run", choices=["run", "list"])
    parser.add_argument("--step", default=None)
    parser.add_argument("--project", default=None)
    parser.add_argument("--timeout", type=int, default=int(os.environ.get("WF_GATE_TIMEOUT", "900")))
    parser.add_argument("--require-commands", action="store_true", help="exit 3 when the card has no command gate")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    root = Path(args.project).resolve() if args.project else repo_root_from_here()
    try:
        payload = evaluate(root, args.step, args.action == "run", args.timeout)
    except (ValueError, OSError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
    else:
        print(
            f"step {payload['step']} · {payload['status']} · "
            f"{payload['command_gates']} command / {payload['gate_count']} gates · "
            f"risk {payload['risk']} · profile {payload['pipeline_profile']}"
        )
        for gate in payload["gates"]:  # type: ignore[union-attr]
            mark = "OK  " if gate.get("ok") is True else "FAIL" if gate.get("ok") is False else "----"
            label = gate.get("id") or "(no id)"
            detail = " && ".join(gate["commands"]) if gate["commands"] else gate["text"]
            print(f"{mark} {label} · {detail}")
            if gate.get("note"):
                print(f"     note: {gate['note']}")
    if payload["failed_commands"]:
        return 1
    if args.require_commands and not payload["command_gates"]:
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
