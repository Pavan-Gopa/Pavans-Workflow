#!/usr/bin/env python3
"""List or run the Objective Gate commands of the current (or named) step card.

  workflow_gates.py list [--step S1] [--for all|coder] [--json]
  workflow_gates.py run  [--step S1] [--for all|coder] [--json] [--require-commands] [--timeout 900]
                         [--log-dir DIR]

A gate runs when its line contains a backticked command:

  - [ ] [S1.O1] `$ npm test -- --run` exits 0        explicit marker (always runs)
  - [ ] [S1.O2] `pytest -q tests/unit` exits 0        recognised runner (npm, pytest, …)
  - [ ] [S1.O3] `./script/check.sh` exits 0           executable path
  - [ ] [S1.O4] (close-only) `$ npm test` exits 0     run by the close check, not the Coder

Backticked names that are not commands (`README.md`, `maxRetries`) stay manual
evidence. Every command on a line must pass. Fenced code blocks and template
cards are ignored, exactly like the Alt+W dashboard.

`--for coder` leaves `(close-only)` gates out: the Coder runs the build and the
step's own checks, and `workflow_close.py check` runs every gate once on the
final tree. Each command's full output is kept in
<git-common-dir>/pavans-workflow/gate-logs/<step>/ (or --log-dir); a failed
command also reports `failure_excerpt`, the failing lines found anywhere in it.

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
import urllib.parse
import signal
import subprocess
import shutil
import sys
from pathlib import Path

STEP_HEADING = re.compile(r"^##[ \t]+([A-Za-z0-9][A-Za-z0-9._/-]*)[ \t]+(?:—|-)[ \t]+(.+?)\s*$", re.M)
# A `**Tester:**` line is card metadata, never a section end (it may sit among the gates).
SECTION_HEADING = re.compile(r"^(?:#{3,}[ \t]+(?P<hash>[^\n]+?)|\*\*(?!(?i:tester):)(?P<bold>[A-Za-z][^:\n]{0,40}):\*\*[^\n]*)[ \t]*$", re.M)
OBJECTIVE_NAMES = ("objective gates", "done when")
GATE_LINE = re.compile(r"^\s*(?:[-*]|\d+[.)])\s*\[(?P<done>[ xX])\]\s*(?:\[(?P<id>[^\]]+)\]\s*)?(?P<body>.+?)\s*$")
BACKTICK = re.compile(r"`([^`\n]+)`")
CURRENT_STEP = re.compile(r"^current_step:\s*(.+?)\s*$", re.M)
RISK = re.compile(r"\*\*Risk:\*\*\s*(low|normal|high)", re.I)
PROFILE = re.compile(r"\*\*Pipeline(?:\s+profile)?:\*\*\s*(quick|standard|critical)", re.I)
TEMPLATE_TITLES = {"title", "short title", "step title", "placeholder"}
# `(close-only)` outside the backticks: the close check runs the gate, the Coder does not.
CLOSE_ONLY = re.compile(r"\(close-only\)", re.I)
# `**Tester:** skip — <reason>`: the only reasons a behaviour step may go without the Tester (R14).
TESTER_LINE = re.compile(r"^\*\*Tester:\*\*[ \t]*(?P<value>[^\n]*)$", re.M | re.I)
TESTER_SKIP_REASONS = ("human_opt_out", "presentation_only", "docs_only", "mechanical_rename")
# The whole value: `skip`, a dash or colon, one reason, optionally a parenthesised note.
TESTER_SKIP = re.compile(
    r"^skip\s*[—–:-]+\s*(?P<reason>" + "|".join(TESTER_SKIP_REASONS) + r")\s*(?:\([^()\n]*\))?\s*\.?\s*$", re.I
)
# Lines that name a failure in common runners' output (XCTest, Swift Testing,
# pytest, Jest/Vitest, cargo, go, tsc, generic `error:`).
FAILURE_LINE = re.compile(
    r"error[:\[]|\bfail(?:ed|ure|ures|ing)?\b|\bFAIL\b|✘|✕|✗|Traceback|AssertionError|panicked at|^\s*not ok\b",
    re.I,
)
# The runner's own failure lines, listed first. Each pattern is runner syntax, not a bare
# word: logs also carry warnings that merely mention "failures" (objc duplicate-class
# notices), tests that print `ERROR:`, and names such as `FAIL-safe`.
RUNNER_FAILURE = re.compile(
    r"^.*?\S:\d+:(?:\d+:)? (?:fatal )?error: "  # Swift/clang/gcc diagnostics, XCTest assertions
    r"|\berror TS\d+: "  # tsc
    r"|^error(?:\[E\d+\])?: |panicked at "  # cargo/rustc
    r"|^\S+\.go:\d+:\d+: "  # go build/vet
    r"|^--- FAIL: |^FAIL\t"  # go test
    r"|^Test Case '.+' failed \(\d"  # XCTest
    r"|^\s*✘ "  # Swift Testing
    r"|^(?:FAILED|ERROR) \S+(?:\.py\b|::)"  # pytest summary
    r"|^\s*FAIL\s+\S+\.(?:[cm]?[jt]sx?)\b|^\s*[✕✗] "  # Jest/Vitest
    r"|^\s*not ok \d|^Traceback \(most recent call last\)"  # TAP, Python
)
NOT_A_FAILURE = re.compile(r"\b0 (?:failures?|failed|errors?)\b|with 0 failures|\bno failures\b|failures?: 0\b", re.I)
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
EXCERPT_LINES = 40
EXCERPT_LINE_CHARS = 300
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
            "close_only": bool(CLOSE_ONLY.search(BACKTICK.sub("", text))),
        }
        if spans and not commands:
            gate["note"] = "backticked text is not a recognised command; write `$ <command>` to run it"
        gates.append(gate)
    return gates


def tester_facts(body: str) -> dict[str, object]:
    """Exactly `**Tester:** skip — <reason>` skips the Tester; anything else keeps it required (R14)."""
    values = [match.group("value").strip() for match in TESTER_LINE.finditer(body)]
    if len(values) > 1:
        return {"tester_skip_reason": None, "tester_note": "more than one **Tester:** line; the Tester stays required (R14)"}
    value = values[0] if values else ""
    skip = TESTER_SKIP.match(value)
    if skip:
        return {"tester_skip_reason": skip.group("reason").lower(), "tester_note": None}
    if not value or re.fullmatch(r"(?:required|on)\.?", value, re.I):
        return {"tester_skip_reason": None, "tester_note": None}
    return {
        "tester_skip_reason": None,
        "tester_note": f"**Tester:** {value!r} is not `skip — "
        + "|".join(TESTER_SKIP_REASONS)
        + "`; the Tester stays required (R14)",
    }


def card_facts(card: dict[str, str]) -> dict[str, object]:
    body = card["body"]
    risk = RISK.search(body)
    profile = PROFILE.search(body)
    return {
        "title": card["title"],
        "risk": risk.group(1).lower() if risk else "normal",
        "pipeline_profile": profile.group(1).lower() if profile else "standard",
        "card_sha256": hashlib.sha256(body.strip().encode("utf-8")).hexdigest(),
        **tester_facts(body),
    }


def _tail(value: object) -> str:
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    return (value or "")[-2000:] if isinstance(value, str) else ""


def common_git_dir(root: Path) -> Path | None:
    try:
        output = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--git-common-dir"], capture_output=True, text=True, check=True
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None
    path = Path(output)
    return path if path.is_absolute() else (root / path).resolve()


def safe_name(value: str) -> str:
    """An injective file-system name for an ID (percent-encoding; `.`/`..` never stay path parts)."""
    name = urllib.parse.quote(value, safe="-_.")
    return name.replace(".", "%2E") if name.strip(".") == "" else name


def prune_gate_logs(current: Path, keep: int = 20) -> None:
    """Keep the logs of the `keep` most recent steps (a full-suite log can be ~0.5 MB)."""
    try:
        others = [
            path for path in current.parent.iterdir()
            if path != current and path.is_dir() and not path.is_symlink()
        ]
    except OSError:
        return
    others.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    for stale in others[keep - 1 :]:
        shutil.rmtree(stale, ignore_errors=True)


def gate_log_dir(root: Path, step: str) -> Path | None:
    """`<git-common-dir>/pavans-workflow/gate-logs/<step>`, touched for retention; None when unsafe or unavailable."""
    common = common_git_dir(root)
    if common is None:
        return None
    store = common / "pavans-workflow" / "gate-logs"
    logs = store / safe_name(step)
    try:
        # A symlinked store would let logs and pruning reach outside the git dir.
        if any(path.is_symlink() for path in (store.parent, store, logs)):
            return None
        logs.mkdir(parents=True, exist_ok=True)
        os.utime(logs)  # rewriting a log does not touch the directory; recency decides retention
    except OSError:
        return None
    prune_gate_logs(logs)
    return logs


def failure_excerpt(*outputs: str) -> list[str]:
    """Failing lines from anywhere in the output (the tail alone often holds only the summary).

    Runner failure lines come first — the first and the last 20, so an early flood
    never hides the real failure — then other lines that mention a failure.
    """
    half = EXCERPT_LINES // 2
    head: list[str] = []
    tail: list[str] = []
    other: list[str] = []
    for output in outputs:
        for raw in (output or "").splitlines():
            line = ANSI.sub("", raw)
            is_runner = bool(RUNNER_FAILURE.search(line))
            if not (is_runner or FAILURE_LINE.search(line)) or NOT_A_FAILURE.search(line):
                continue
            text = line.strip()[:EXCERPT_LINE_CHARS]
            if not text:
                continue
            if is_runner:
                if text in head or text in tail:
                    continue
                if len(head) < half:
                    head.append(text)
                else:
                    tail.append(text)
                    del tail[:-half]
            elif text not in other and len(other) < EXCERPT_LINES:
                other.append(text)
    return (head + tail + other)[:EXCERPT_LINES]


def write_log(path: Path, command: str, exit_code: int, stdout: str, stderr: str) -> str | None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            f"$ {command}\nexit {exit_code}\n--- stdout ---\n{stdout or ''}\n--- stderr ---\n{stderr or ''}\n",
            encoding="utf-8",
        )
    except OSError:
        return None
    return str(path)


def run_command(command: str, cwd: Path, timeout: int, log_path: Path | None = None) -> dict[str, object]:
    process = subprocess.Popen(
        command,
        shell=True,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    timed_out = False
    try:
        stdout, stderr = process.communicate(timeout=timeout)
        exit_code = process.returncode
    except subprocess.TimeoutExpired:
        timed_out, exit_code = True, 124
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
        stderr = ((stderr or "") + f"\ntimed out after {timeout}s").strip()
    result: dict[str, object] = {
        "exit_code": exit_code,
        "timed_out": timed_out,
        "stdout_tail": _tail(stdout),
        "stderr_tail": _tail(stderr),
    }
    if log_path is not None:
        result["log"] = write_log(log_path, command, exit_code, stdout, stderr)
    if exit_code != 0:
        result["failure_excerpt"] = failure_excerpt(stdout, stderr)
    return result


def evaluate(
    root: Path,
    step: str | None,
    run: bool,
    timeout: int,
    scope: str = "all",
    log_dir: Path | str | None = "auto",
) -> dict[str, object]:
    """`scope="coder"` leaves `(close-only)` gates out; `log_dir="auto"` keeps full logs in the git common dir."""
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
    all_gates = extract_gates(cards[step]["body"], root)
    gates = [gate for gate in all_gates if not (scope == "coder" and gate["close_only"])]
    logs: Path | None = None
    if run and log_dir == "auto":
        logs = gate_log_dir(root, step)
    elif run and log_dir:
        logs = Path(log_dir)
    failed = 0
    for index, gate in enumerate(gates, 1):
        gate["ok"] = None
        if not run or gate["kind"] != "command":
            continue
        label = safe_name(str(gate["id"] or f"gate{index}"))
        commands: list[str] = gate["commands"]  # type: ignore[assignment]
        runs = [
            dict(
                run_command(
                    command,
                    root,
                    timeout,
                    logs / (f"{label}.log" if len(commands) == 1 else f"{label}-{number}.log") if logs else None,
                ),
                command=command,
            )
            for number, command in enumerate(commands, 1)
        ]
        gate["runs"] = runs
        gate["ok"] = all(item["exit_code"] == 0 for item in runs)
        # Backward-compatible single-command fields.
        gate["exit_code"] = next((item["exit_code"] for item in runs if item["exit_code"] != 0), 0)
        gate["timed_out"] = any(item["timed_out"] for item in runs)
        if not gate["ok"]:
            failed += 1
    command_gates = sum(1 for gate in gates if gate["kind"] == "command")
    close_only = sum(1 for gate in all_gates if gate["kind"] == "command" and gate["close_only"])
    if failed:
        failing_gates = [g for g in gates if g.get("ok") is False]
        all_timeouts = all(
            all(r.get("timed_out") is True for r in g.get("runs", []) if r.get("exit_code") != 0 or r.get("timed_out"))
            for g in failing_gates
        )
        status = "timeout" if (failing_gates and all_timeouts) else "fail"
    else:
        status = "pass" if command_gates else "no_commands"
    if not run:
        status = "listed" if command_gates else "no_commands"
    notes: list[str] = []
    if scope == "coder" and close_only and not command_gates:
        notes.append(
            "every command gate is (close-only): give the Coder a step-scoped command gate (build + the step's own tests)"
        )
    return {
        "step": step,
        **card_facts(cards[step]),
        "scope": scope,
        "gate_count": len(gates),
        "command_gates": command_gates,
        "close_only_gates": close_only,
        "failed_commands": failed,
        "status": status,
        "timeout_seconds": timeout,
        "notes": notes,
        "gates": gates,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("action", nargs="?", default="run", choices=["run", "list"])
    parser.add_argument("--step", default=None)
    parser.add_argument("--project", default=None)
    parser.add_argument("--timeout", type=int, default=int(os.environ.get("WF_GATE_TIMEOUT", "900")))
    parser.add_argument(
        "--for", dest="scope", choices=["all", "coder"], default="all",
        help="coder: leave out (close-only) gates — the close check runs them on the final tree",
    )
    parser.add_argument("--log-dir", default="auto", help="full command logs (default: <git-common-dir>/pavans-workflow/gate-logs/<step>)")
    parser.add_argument("--require-commands", action="store_true", help="exit 3 when the card has no command gate")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    root = Path(args.project).resolve() if args.project else repo_root_from_here()
    try:
        payload = evaluate(root, args.step, args.action == "run", args.timeout, args.scope, args.log_dir)
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
            + (f" · for coder ({payload['close_only_gates']} close-only left to the close check)" if args.scope == "coder" else "")
        )
        for gate in payload["gates"]:  # type: ignore[union-attr]
            mark = "OK  " if gate.get("ok") is True else "FAIL" if gate.get("ok") is False else "----"
            label = gate.get("id") or "(no id)"
            detail = " && ".join(gate["commands"]) if gate["commands"] else gate["text"]
            print(f"{mark} {label}{' (close-only)' if gate.get('close_only') else ''} · {detail}")
            if gate.get("note"):
                print(f"     note: {gate['note']}")
            for item in gate.get("runs") or []:
                if item.get("exit_code") == 0:
                    continue
                if item.get("log"):
                    print(f"     log: {item['log']}")
                for line in (item.get("failure_excerpt") or [])[:10]:
                    print(f"     | {line}")
        for note in payload["notes"]:  # type: ignore[union-attr]
            print(f"note: {note}")
    if payload["failed_commands"]:
        return 1
    if args.require_commands and not payload["command_gates"]:
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
