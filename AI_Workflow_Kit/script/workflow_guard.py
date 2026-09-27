#!/usr/bin/env python3
"""Worker boundary guard: prove what a worker changed, and whether it was allowed to.

  workflow_guard.py snapshot --role ROLE [--agent NAME] [--step S] [--target PATH]... [--id ID]
  workflow_guard.py verify   [--id ID] [--exempt PATH]...
  workflow_guard.py status   [--step S]
  workflow_guard.py policy   --role ROLE

The workflow-guard OMP extension calls `snapshot` before every workflow worker
spawn and `verify` when the worker finishes, so the verdict never depends on a
model remembering to check. Main can run the same commands by hand.

Policy (enforced on the real repository state, not on the worker's report):
  * No worker commits, switches branches, or edits workflow files
    (.omp/, AI_Workflow_Kit/, skills, PIPELINE.md, ORCHESTRATOR_FIRST_PROMPT.md).
  * reviewer, architect, security, design_advisor: read-only — any change is a violation.
  * coder, designer: only STATE.yaml target_files (or --target) may change.
  * tester: test/QA paths or target_files only.
  * unknown agents are treated as read-only.

Verdicts: clean | violation | unscoped (coder/designer ran without target_files).
Records live under <git-common-dir>/pavans-workflow/guard/.
Exit codes: verify → 0 clean/unscoped, 1 violation, 2 usage/git error.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import fnmatch
import json
import os
import re
import secrets
import subprocess
import sys
from pathlib import Path, PurePosixPath

READ_ONLY_ROLES = {"reviewer", "architect", "security", "design_advisor"}
SCOPED_ROLES = {"coder", "designer"}
TEST_ROLES = {"tester"}
KNOWN_ROLES = READ_ONLY_ROLES | SCOPED_ROLES | TEST_ROLES
PROTECTED_PREFIXES = (
    ".omp/", "AI_Workflow_Kit/", "grilling/", "ponytail/", "ponytail-review/", "ponytail-audit/",
    "ponytail-debt/", "ui-designer/",
)
PROTECTED_FILES = {"PIPELINE.md", "ORCHESTRATOR_FIRST_PROMPT.md", ".graphifyignore"}
TEST_DIR = re.compile(r"(^|/)(tests?|__tests__|__mocks__|spec|specs|e2e|integration|fixtures?|testdata|test-data|qa)/", re.I)
TEST_FILE = re.compile(
    r"(^test_.+\.py$|_test\.[A-Za-z0-9]+$|\.test\.[A-Za-z0-9]+$|\.spec\.[A-Za-z0-9]+$|Tests?\.(swift|java|kt|cs)$|_spec\.rb$)"
)
DELETED = "<deleted>"
STATE_REL = "AI_Workflow_Kit/docs/AI/STATE.yaml"


class GuardError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# roles and policy


def normalize_role(value: str | None) -> str:
    role = (value or "").strip().lower()
    role = re.sub(r"^workflow[-_]", "", role)
    role = re.sub(r"[-_]backup$", "", role)
    role = role.replace("-", "_")
    if role == "code_reviewer":
        role = "reviewer"
    return role if role in KNOWN_ROLES else "unknown"


def is_protected(path: str) -> bool:
    return path in PROTECTED_FILES or path.startswith(PROTECTED_PREFIXES)


def is_test_path(path: str) -> bool:
    return bool(TEST_DIR.search(path) or TEST_FILE.search(PurePosixPath(path).name))


def clean_path(value: str) -> str:
    text = value.strip().replace("\\", "/")
    while text.startswith("./"):
        text = text[2:]
    return text


def matches_target(path: str, targets: list[str]) -> bool:
    for raw in targets:
        target = clean_path(raw)
        if not any(ch in target for ch in "*?["):
            target = target.rstrip("/")
        if not target:
            continue
        if path == target or path.startswith(target + "/"):
            return True
        if any(ch in target for ch in "*?[") and (fnmatch.fnmatchcase(path, target) or fnmatch.fnmatchcase(path, target.rstrip("/") + "/*")):
            return True
    return False


def judge(role: str, changed: list[str], targets: list[str], head_moved: bool) -> tuple[str, list[dict[str, str]], list[str]]:
    violations: list[dict[str, str]] = []
    notes: list[str] = []
    if head_moved:
        violations.append({"path": "HEAD", "reason": "workers never commit, tag, or switch branches"})
    for path in changed:
        if is_protected(path):
            violations.append({"path": path, "reason": "workflow file changed by a worker (Main owns workflow state)"})
        elif role in READ_ONLY_ROLES or role == "unknown":
            label = role if role != "unknown" else "unrecognised agent"
            violations.append({"path": path, "reason": f"{label} is read-only"})
        elif role in SCOPED_ROLES:
            if targets and not matches_target(path, targets):
                violations.append({"path": path, "reason": f"outside target_files for {role}"})
        elif role in TEST_ROLES:
            if not (is_test_path(path) or matches_target(path, targets)):
                violations.append({"path": path, "reason": "tester may change test/QA paths or target_files only"})
    product_changes = [path for path in changed if not is_protected(path)]
    if role in SCOPED_ROLES and not targets and product_changes:
        notes.append("STATE.yaml target_files is empty: the Coder/Designer scope could not be verified")
    if violations:
        return "violation", violations, notes
    if notes:
        return "unscoped", violations, notes
    return "clean", violations, notes


# ---------------------------------------------------------------------------
# git plumbing


def git(root: Path, *args: str, input_text: str | None = None, check: bool = True) -> str:
    try:
        completed = subprocess.run(
            ["git", "-C", str(root), *args],
            input=input_text,
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError as error:
        raise GuardError(f"git unavailable: {error}") from error
    if check and completed.returncode != 0:
        raise GuardError(f"git {' '.join(args)} failed: {completed.stderr.strip()}")
    return completed.stdout


def repo_root(start: Path) -> Path:
    return Path(git(start, "rev-parse", "--show-toplevel").strip())


def guard_dir(root: Path) -> Path:
    common = Path(git(root, "rev-parse", "--git-common-dir").strip())
    common = common if common.is_absolute() else (root / common).resolve()
    path = common / "pavans-workflow" / "guard"
    path.mkdir(parents=True, exist_ok=True)
    return path


def head(root: Path) -> str | None:
    value = git(root, "rev-parse", "-q", "--verify", "HEAD", check=False).strip()
    return value or None


def branch(root: Path) -> str | None:
    return git(root, "symbolic-ref", "-q", "HEAD", check=False).strip() or None


def dirty_paths(root: Path) -> list[str]:
    raw = git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    entries = raw.split("\0")
    paths: list[str] = []
    index = 0
    while index < len(entries):
        entry = entries[index]
        index += 1
        if len(entry) < 4:
            continue
        status, path = entry[:2], entry[3:]
        paths.append(path)
        if "R" in status or "C" in status:
            # -z rename/copy: the source path follows as its own NUL field.
            if index < len(entries) and entries[index]:
                paths.append(entries[index])
            index += 1
    return sorted(set(paths))


def worktree_blobs(root: Path, paths: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    existing = [path for path in paths if (root / path).is_file() or (root / path).is_symlink()]
    for path in paths:
        if path not in existing:
            result[path] = DELETED
    if existing:
        output = git(root, "hash-object", "--stdin-paths", input_text="\n".join(existing) + "\n")
        for path, blob in zip(existing, output.split()):
            result[path] = blob
    return result


def tree_blobs(root: Path, commit: str | None, paths: list[str]) -> dict[str, str]:
    result = {path: DELETED for path in paths}
    if not commit or not paths:
        return result
    for start in range(0, len(paths), 200):
        chunk = paths[start:start + 200]
        output = git(root, "ls-tree", "-z", "-r", commit, "--", *chunk)
        for entry in output.split("\0"):
            if not entry or "\t" not in entry:
                continue
            meta, path = entry.split("\t", 1)
            result[path] = meta.split()[2]
    return result


# ---------------------------------------------------------------------------
# state helpers


def state_value(root: Path, key: str) -> str | None:
    try:
        text = (root / STATE_REL).read_text(encoding="utf-8")
    except OSError:
        return None
    match = re.search(rf"^{re.escape(key)}:[ \t]*(.*?)\s*$", text, re.M)
    if not match:
        return None
    value = re.sub(r"\s+#.*$", "", match.group(1)).strip().strip("\"'")
    return value if value not in {"", "null", "~", "-"} else None


def state_targets(root: Path) -> list[str]:
    try:
        lines = (root / STATE_REL).read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    for index, line in enumerate(lines):
        match = re.match(r"^target_files:[ \t]*(.*?)\s*$", line)
        if not match:
            continue
        inline = re.sub(r"\s+#.*$", "", match.group(1)).strip()
        if inline.startswith("["):
            return [item.strip().strip("\"'") for item in inline.strip("[]").split(",") if item.strip().strip("\"'")]
        values: list[str] = []
        for follow in lines[index + 1:]:
            item = re.match(r"^\s*-\s+(.+?)\s*$", follow)
            if item:
                values.append(re.sub(r"\s+#.*$", "", item.group(1)).strip().strip("\"'"))
                continue
            if follow.strip() and not follow.startswith((" ", "\t")):
                break
        return [value for value in values if value]
    return []


def now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_json(path: Path, payload: dict[str, object]) -> None:
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temporary.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)


# ---------------------------------------------------------------------------
# commands


def cmd_snapshot(root: Path, role_input: str, agent: str | None, step: str | None, targets: list[str], snapshot_id: str | None) -> dict[str, object]:
    role = normalize_role(role_input or agent)
    directory = guard_dir(root)
    # Microsecond stamps keep ids in chronological order for status/verify lookups.
    stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    identifier = snapshot_id or f"{stamp}-{role}-{secrets.token_hex(2)}"
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,120}", identifier):
        raise GuardError(f"invalid snapshot id: {identifier}")
    dirty = dirty_paths(root)
    payload: dict[str, object] = {
        "id": identifier,
        "role": role,
        "agent": agent,
        "step": step or state_value(root, "current_step"),
        "targets": targets or state_targets(root),
        "head": head(root),
        "branch": branch(root),
        "dirty": worktree_blobs(root, dirty),
        "created_at": now_iso(),
    }
    write_json(directory / f"{identifier}.snapshot.json", payload)
    return payload


def open_snapshot(directory: Path) -> Path | None:
    snapshots = sorted(directory.glob("*.snapshot.json"))
    for path in reversed(snapshots):
        if not (directory / path.name.replace(".snapshot.json", ".verdict.json")).exists():
            return path
    return None


def relative_to_root(root: Path, base: Path, value: str) -> str | None:
    """Repository-relative form of a path given absolute or relative to `base`."""
    text = value.strip()
    if not text:
        return None
    candidate = Path(text)
    absolute = candidate if candidate.is_absolute() else (base / candidate)
    try:
        return absolute.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return None


def cmd_verify(root: Path, snapshot_id: str | None, exempt: list[str], base: Path | None = None) -> dict[str, object]:
    directory = guard_dir(root)
    path = directory / f"{snapshot_id}.snapshot.json" if snapshot_id else open_snapshot(directory)
    if path is None or not path.is_file():
        raise GuardError("no open guard snapshot to verify" if not snapshot_id else f"unknown snapshot: {snapshot_id}")
    snapshot = json.loads(path.read_text(encoding="utf-8"))
    before_head = snapshot.get("head")
    current_head = head(root)
    head_moved = before_head != current_head or snapshot.get("branch") != branch(root)
    before_dirty: dict[str, str] = snapshot.get("dirty") or {}
    candidates = set(dirty_paths(root)) | set(before_dirty)
    if head_moved and before_head and current_head:
        candidates |= {line for line in git(root, "diff", "--name-only", before_head, current_head).splitlines() if line}
    candidates = sorted(candidates)
    now = worktree_blobs(root, candidates)
    at_head = tree_blobs(root, before_head, [path for path in candidates if path not in before_dirty])
    before = {path: before_dirty.get(path, at_head.get(path, DELETED)) for path in candidates}
    exempt_set = {rel for rel in (relative_to_root(root, base or root, item) for item in exempt) if rel}
    changed = [path for path in candidates if now[path] != before[path] and path not in exempt_set]
    verdict, violations, notes = judge(str(snapshot.get("role")), changed, list(snapshot.get("targets") or []), head_moved)
    payload: dict[str, object] = {
        "id": snapshot["id"],
        "role": snapshot.get("role"),
        "agent": snapshot.get("agent"),
        "step": snapshot.get("step"),
        "targets": snapshot.get("targets") or [],
        "verdict": verdict,
        "violations": violations,
        "notes": notes,
        "changed": changed,
        "exempt": sorted(exempt_set),
        "head_before": before_head,
        "head_after": current_head,
        "snapshot_at": snapshot.get("created_at"),
        "verified_at": now_iso(),
    }
    write_json(directory / f"{snapshot['id']}.verdict.json", payload)
    write_json(directory / "latest.json", payload)
    with (directory / "history.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({key: payload[key] for key in ("id", "role", "agent", "step", "verdict", "verified_at")}) + "\n")
    return payload


def cmd_status(root: Path, step: str | None) -> dict[str, object]:
    directory = guard_dir(root)
    verdicts = sorted(directory.glob("*.verdict.json"))
    for path in reversed(verdicts):
        payload = json.loads(path.read_text(encoding="utf-8"))
        if step is None or payload.get("step") == step:
            return payload
    return {"verdict": "missing", "step": step}


def format_verdict(payload: dict[str, object]) -> str:
    lines = [f"guard {payload.get('verdict')} · {payload.get('role')} · {payload.get('agent') or '-'} · step {payload.get('step') or '-'}"]
    for item in payload.get("violations") or []:  # type: ignore[union-attr]
        lines.append(f"  VIOLATION {item['path']}: {item['reason']}")
    for note in payload.get("notes") or []:  # type: ignore[union-attr]
        lines.append(f"  NOTE {note}")
    changed = payload.get("changed") or []
    if changed and payload.get("verdict") != "violation":
        lines.append("  changed: " + ", ".join(changed))  # type: ignore[arg-type]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", default=None)
    sub = parser.add_subparsers(dest="command", required=True)
    snapshot = sub.add_parser("snapshot")
    snapshot.add_argument("--role", default="")
    snapshot.add_argument("--agent", default=None)
    snapshot.add_argument("--step", default=None)
    snapshot.add_argument("--target", action="append", default=[])
    snapshot.add_argument("--id", default=None)
    snapshot.add_argument("--json", action="store_true")
    verify = sub.add_parser("verify")
    verify.add_argument("--id", default=None)
    verify.add_argument("--exempt", action="append", default=[])
    verify.add_argument("--json", action="store_true")
    status = sub.add_parser("status")
    status.add_argument("--step", default=None)
    status.add_argument("--json", action="store_true")
    policy = sub.add_parser("policy")
    policy.add_argument("--role", required=True)
    args = parser.parse_args(argv)

    start = Path(args.project).resolve() if args.project else Path.cwd()
    try:
        root = repo_root(start)
        if args.command == "policy":
            role = normalize_role(args.role)
            kind = "read-only" if role in READ_ONLY_ROLES or role == "unknown" else "target_files" if role in SCOPED_ROLES else "tests + target_files"
            print(f"{role}: {kind}; never workflow files, commits, or branch changes")
            return 0
        if args.command == "snapshot":
            payload = cmd_snapshot(root, args.role, args.agent, args.step, args.target, args.id)
            print(json.dumps(payload, indent=2) if args.json else f"guard snapshot {payload['id']} ({payload['role']})")
            return 0
        if args.command == "verify":
            payload = cmd_verify(root, args.id, args.exempt, start)
            print(json.dumps(payload, indent=2, ensure_ascii=False) if args.json else format_verdict(payload))
            return 1 if payload["verdict"] == "violation" else 0
        payload = cmd_status(root, args.step)
        print(json.dumps(payload, indent=2, ensure_ascii=False) if args.json else format_verdict(payload))
        return 0
    except GuardError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
