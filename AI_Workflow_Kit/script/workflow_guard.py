#!/usr/bin/env python3
"""Worker boundary guard: stop out-of-scope worker actions, and prove what a worker changed.

  workflow_guard.py allow    --agent NAME [--id ID] [--base DIR] [--tool T] [--path P]... [--command CMD]
  workflow_guard.py snapshot --role ROLE [--agent NAME] [--step S] [--target PATH]... [--id ID]
  workflow_guard.py verify   [--id ID] [--exempt PATH]... [--window START_MS:END_MS]... [--whole-repo]
  workflow_guard.py status   [--step S] [--all]
  workflow_guard.py resolve  --id ID --note "Human decision"
  workflow_guard.py mode     [enforce|report|off] [--note TEXT]
  workflow_guard.py policy   --role ROLE

The workflow-guard OMP extension drives this script, so nothing depends on a
model remembering to check:

  * Inside every workflow worker session it calls `allow` before each
    edit/write tool call and before each git command that changes repository
    state. An out-of-scope action is BLOCKED before it runs: the worker gets a
    tool error and carries on; nothing is changed and the step is not stopped.
    Every allowed edit is recorded in the run's ledger.
  * Around every workflow worker run it calls `snapshot` (spawn) and `verify`
    (finish). The verdict judges only what the worker itself changed: files in
    its ledger that really changed. Everything else that changed meanwhile —
    Main's own commits and edits, the Human, a parallel OMP session, a
    formatter — is listed as unattributed and never makes a violation. Files
    changed while one of the worker's shell commands ran are listed as
    shell_suspects for Main to look at, also without a violation.
  * OMP's own agents (scout, explore, task, ...) are not workflow workers and
    are not guarded.

Policy:
  * No worker edits workflow files (.omp/, AI_Workflow_Kit/, skills,
    PIPELINE.md, ORCHESTRATOR_FIRST_PROMPT.md, .graphifyignore) or runs git
    commands that change repository state (commit, branch, tag, stash, reset,
    checkout/switch/restore, add/rm/mv, merge/rebase, push/pull, clean, ...).
  * reviewer, architect, security, design_advisor: read-only.
  * coder, designer: only STATE.yaml target_files (or --target); an empty list
    allows the edit and makes the verdict `unscoped`.
  * tester: test/QA paths or target_files only.

Modes (`mode`, or env WF_GUARD_MODE, which wins): enforce (default) blocks as
above; report blocks nothing and lists what enforce would have blocked; off
disables the boundary guard (backup authorization stays on).

Verdicts: clean | violation | unscoped. A violation stays open until Main
records the Human's decision with `resolve`; workflow_close.py refuses to close
a step while one is open. `verify --whole-repo` restores the pre-3.6 judgement
(every change in the repository is the worker's, HEAD moves included) for a
manual audit in a repository nobody else touches.
Paths are judged relative to the project directory (the folder holding
AI_Workflow_Kit/), so a workflow inside a monorepo subfolder works too. Caches
(__pycache__, .pytest_cache, *.pyc, ...), OMP's .omp/config.yml.lock, and files
git ignores are not changes.
Records live under <git-common-dir>/pavans-workflow/guard/.
Exit codes: verify → 0 clean/unscoped, 1 violation; allow → 0 allowed, 1
blocked; 2 usage/git error.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import posixpath
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
TEST_DIR = re.compile(
    r"(^|/)(tests?|__tests__|__mocks__|__snapshots__|__fixtures__|spec|specs|e2e|integration|fixtures?|testdata|"
    r"test-data|test-utils|test_utils|testing|qa|cypress|androidTest|(?-i:[^/]*Tests))/",
    re.I,
)
TEST_FILE = re.compile(
    r"(^test_.+\.py$|^conftest\.py$|^tests\.py$|_test\.[A-Za-z0-9]+$|\.test\.[A-Za-z0-9]+$|\.spec\.[A-Za-z0-9]+$|"
    r"Tests?\.(swift|java|kt|cs|php|m|mm)$|_spec\.rb$|\.snap$|^setupTests\.[cm]?[jt]sx?$|^test[-_]utils\.[A-Za-z0-9]+$|"
    r"^(jest|vitest)\.setup\.[cm]?[jt]s$)"
)
DELETED = "<deleted>"
STATE_REL = "AI_Workflow_Kit/docs/AI/STATE.yaml"
GENERATED_DIRS = {"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".nox", ".turbo", ".DS_Store"}
GENERATED_SUFFIXES = (".pyc", ".pyo")
MIGRATION_BACKUP = re.compile(r"^AI_Workflow_Kit/.*\.bak-[^/]*$")
# OMP holds a flock on `<config>.lock` while it saves settings and leaves it behind.
HOST_LOCK = ".omp/config.yml.lock"
SCHEMA = 2
MODES = ("enforce", "report", "off")
MODE_ENV = "WF_GUARD_MODE"
GIT_STATE_REASON = (
    "workers never change git state (commit, branch, tag, stash, reset, checkout/switch/restore, "
    "add/rm/mv, merge/rebase, push/pull, clean); Main owns version control"
)
URL_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*://")
LIST_CAP = 100
# mtime tolerance around a shell window (filesystem timestamp granularity, clock reads).
WINDOW_SLACK_MS = 1500


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


def is_generated(path: str) -> bool:
    parts = path.split("/")
    return (
        any(part in GENERATED_DIRS for part in parts)
        or path.endswith(GENERATED_SUFFIXES)
        or path == HOST_LOCK
        or bool(MIGRATION_BACKUP.match(path))
    )


def to_project(path: str, prefix: str) -> str:
    """Root-relative git path -> project-relative path ('../../x' when outside the project)."""
    if not prefix:
        return path
    if path.startswith(prefix):
        return path[len(prefix):]
    return posixpath.relpath(path, prefix.rstrip("/"))


def glob_regex(pattern: str) -> re.Pattern[str]:
    """Glob with `**` (any depth) as a regex; a match on a folder covers everything below it."""
    pattern = pattern.rstrip("/")
    out = ""
    index = 0
    while index < len(pattern):
        if pattern.startswith("**/", index):
            out += "(?:.*/)?"
            index += 3
            continue
        if pattern.startswith("**", index):
            out += ".*"
            index += 2
            continue
        char = pattern[index]
        if char == "*":
            out += "[^/]*"
        elif char == "?":
            out += "[^/]"
        elif char == "[" and pattern.find("]", index + 2) > index:
            end = pattern.find("]", index + 2)
            body = pattern[index + 1:end]
            body = "^" + body[1:] if body.startswith("!") else body
            out += "[" + body.replace("\\", "\\\\") + "]"
            index = end + 1
            continue
        else:
            out += re.escape(char)
        index += 1
    return re.compile(out.rstrip("/") + r"(?:/.*)?$")


def matches_target(path: str, targets: list[str]) -> bool:
    for raw in targets:
        target = clean_path(raw)
        literal = target.rstrip("/")
        if not literal:
            continue
        # Folder names may contain glob characters (Next.js `app/[slug]/`): literal first.
        if path == literal or path.startswith(literal + "/"):
            return True
        if any(ch in target for ch in "*?["):
            try:
                if glob_regex(target).match(path):
                    return True
            except re.error:
                continue
    return False


def path_violation(role: str, path: str, targets: list[str]) -> str | None:
    """Why `role` may not change `path` (project-relative), or None when it may."""
    if is_protected(path):
        return "workflow file (Main owns workflow state)"
    if role in READ_ONLY_ROLES or role == "unknown":
        label = role if role != "unknown" else "unrecognised agent"
        return f"{label} is read-only"
    if role in SCOPED_ROLES and targets and not matches_target(path, targets):
        return f"outside target_files for {role}"
    if role in TEST_ROLES and not (is_test_path(path) or matches_target(path, targets)):
        return "tester may change test/QA paths or target_files only"
    return None


def judge(role: str, changed: list[str], targets: list[str], head_moved: bool = False) -> tuple[str, list[dict[str, str]], list[str]]:
    violations: list[dict[str, str]] = []
    notes: list[str] = []
    if head_moved:
        violations.append({"path": "HEAD", "reason": "workers never commit, tag, or switch branches"})
    for path in changed:
        reason = path_violation(role, path, targets)
        if reason:
            violations.append({"path": path, "reason": reason})
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


def ignored(root: Path, paths: list[str]) -> set[str]:
    """Repository-relative paths git ignores (untracked and matched by an ignore rule)."""
    if not paths:
        return set()
    output = git(root, "check-ignore", "-z", "--stdin", input_text="\0".join(paths) + "\0", check=False)
    return {item for item in output.split("\0") if item}


def _hash_text(root: Path, text: str) -> str:
    return git(root, "hash-object", "--stdin", input_text=text).strip()


def _special_blob(root: Path, path: str) -> str:
    """Blob-comparable id for symlinks, submodules, and nested repositories."""
    full = root / path.rstrip("/")
    if full.is_symlink():
        # git stores a symlink as a blob holding its target text.
        return _hash_text(root, os.readlink(full))
    if full.is_dir():
        commit = git(full, "rev-parse", "-q", "--verify", "HEAD", check=False).strip() if (full / ".git").exists() else ""
        return f"<commit:{commit}>" if commit else "<directory>"
    return DELETED


def worktree_blobs(root: Path, paths: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    regular: list[str] = []
    for path in paths:
        full = root / path.rstrip("/")
        if full.is_symlink() or full.is_dir():
            try:
                result[path] = _special_blob(root, path)
            except (GuardError, OSError):
                result[path] = "<unhashable>"
        elif full.is_file():
            regular.append(path)
        else:
            result[path] = DELETED
    if regular:
        try:
            output = git(root, "hash-object", "--stdin-paths", input_text="\n".join(regular) + "\n")
            for path, blob in zip(regular, output.split()):
                result[path] = blob
        except GuardError:
            for path in regular:
                try:
                    result[path] = git(root, "hash-object", "--", path).strip()
                except GuardError:
                    result[path] = "<unhashable>"
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
            kind, object_id = meta.split()[1], meta.split()[2]
            result[path] = f"<commit:{object_id}>" if kind == "commit" else object_id
    return result


# ---------------------------------------------------------------------------
# state helpers


def state_value(project: Path, key: str) -> str | None:
    try:
        text = (project / STATE_REL).read_text(encoding="utf-8")
    except OSError:
        return None
    match = re.search(rf"^{re.escape(key)}:[ \t]*(.*?)\s*$", text, re.M)
    if not match:
        return None
    value = re.sub(r"\s+#.*$", "", match.group(1)).strip().strip("\"'")
    return value if value not in {"", "null", "~", "-"} else None


def state_targets(project: Path) -> list[str]:
    try:
        lines = (project / STATE_REL).read_text(encoding="utf-8").splitlines()
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


def mode_file(root: Path, prefix: str) -> Path:
    """Per project: two workflow projects in one monorepo keep their own mode."""
    slug = re.sub(r"[^A-Za-z0-9._-]+", "--", prefix.strip("/"))
    return guard_dir(root) / (f"mode--{slug}.json" if slug else "mode.json")


def current_mode(root: Path, prefix: str = "") -> tuple[str, str]:
    """(mode, source): env WF_GUARD_MODE wins over the stored mode; default enforce."""
    env = os.environ.get(MODE_ENV, "").strip().lower()
    if env in MODES:
        return env, f"env {MODE_ENV}"
    try:
        stored = json.loads(mode_file(root, prefix).read_text(encoding="utf-8")).get("mode")
    except (OSError, ValueError, AttributeError):
        stored = None
    if stored in MODES:
        return str(stored), "workflow_guard.py mode"
    return "enforce", "default"


def union(*lists: list[str]) -> list[str]:
    seen: list[str] = []
    for values in lists:
        for value in values:
            if value not in seen:
                seen.append(value)
    return seen


def ledger_path(directory: Path, snapshot_id: str) -> Path:
    return directory / f"{snapshot_id}.ledger.jsonl"


def read_ledger(directory: Path, snapshot_id: str) -> list[dict[str, object]]:
    try:
        lines = ledger_path(directory, snapshot_id).read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    entries: list[dict[str, object]] = []
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict):
            entries.append(entry)
    return entries


def describe(entry: dict[str, object]) -> str:
    subject = entry.get("path") or f"`{entry.get('command')}`"
    return f"{subject} ({entry.get('reason')})"


# ---------------------------------------------------------------------------
# commands


def project_prefix(root: Path, project: Path) -> str:
    try:
        rel = project.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        raise GuardError(f"project {project} is not inside git repository {root}")
    return "" if rel in ("", ".") else rel.rstrip("/") + "/"


def cmd_snapshot(root: Path, project: Path, role_input: str, agent: str | None, step: str | None, targets: list[str], snapshot_id: str | None) -> dict[str, object]:
    role = normalize_role(role_input or agent)
    mode, _source = current_mode(root, project_prefix(root, project))
    if mode == "off":
        return {"id": None, "skipped": True, "mode": mode, "role": role, "agent": agent}
    directory = guard_dir(root)
    # Microsecond stamps keep ids in chronological order for status/verify lookups.
    stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    identifier = snapshot_id or f"{stamp}-{role}-{secrets.token_hex(2)}"
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,120}", identifier):
        raise GuardError(f"invalid snapshot id: {identifier}")
    dirty = dirty_paths(root)
    payload: dict[str, object] = {
        "schema": SCHEMA,
        "id": identifier,
        "mode": mode,
        "role": role,
        "agent": agent,
        "step": step or state_value(project, "current_step"),
        "targets": targets or state_targets(project),
        "project_prefix": project_prefix(root, project),
        "head": head(root),
        "branch": branch(root),
        "dirty": worktree_blobs(root, dirty),
        "created_at": now_iso(),
    }
    write_json(directory / f"{identifier}.snapshot.json", payload)
    return payload


OPEN_SNAPSHOT_MAX_AGE = _dt.timedelta(hours=6)  # OMP's hard wall for a worker is four hours


def open_snapshot(directory: Path, agent: str | None = None, prefix: str | None = None) -> Path | None:
    """Newest snapshot without a verdict (optionally of one agent in one project, and recent)."""
    snapshots = sorted(directory.glob("*.snapshot.json"))
    oldest = _dt.datetime.now(_dt.timezone.utc) - OPEN_SNAPSHOT_MAX_AGE
    for path in reversed(snapshots):
        if (directory / path.name.replace(".snapshot.json", ".verdict.json")).exists():
            continue
        if agent is None and prefix is None:
            return path
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            created = _dt.datetime.strptime(str(record.get("created_at")), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=_dt.timezone.utc)
        except (OSError, ValueError):
            continue
        if agent is not None and (record.get("agent") != agent or created < oldest):
            continue
        if prefix is not None and str(record.get("project_prefix") or "") != prefix:
            continue
        return path
    return None


def relative_to_root(root: Path, base: Path, value: str) -> str | None:
    """Repository-relative form of a path given absolute or relative to `base`."""
    text = value.strip()
    if not text or URL_SCHEME.match(text):
        return None
    candidate = Path(os.path.expanduser(text))
    absolute = candidate if candidate.is_absolute() else (base / candidate)
    try:
        return absolute.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return None


def cmd_allow(
    root: Path,
    project: Path,
    agent: str,
    snapshot_id: str | None,
    base: Path,
    tool: str,
    paths: list[str],
    command: str | None,
    action: str | None = None,
) -> dict[str, object]:
    """Decide one worker tool call before it runs, and record it in the run's ledger."""
    role = normalize_role(agent)
    prefix = project_prefix(root, project)
    mode, _source = current_mode(root, prefix)
    result: dict[str, object] = {"allowed": True, "mode": mode, "role": role, "agent": agent, "id": None, "blocked": []}
    if mode == "off" or role == "unknown":
        # OMP's own agents (scout, explore, task, ...) are not workflow workers.
        return result
    directory = guard_dir(root)
    snapshot_file = directory / f"{snapshot_id}.snapshot.json" if snapshot_id else None
    if snapshot_file is None or not snapshot_file.is_file():
        snapshot_file = open_snapshot(directory, agent, prefix)
    snapshot: dict[str, object] = {}
    if snapshot_file is not None:
        try:
            snapshot = json.loads(snapshot_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            snapshot = {}
    # Main may widen target_files while a worker runs; both lists count.
    targets = union(list(snapshot.get("targets") or []), state_targets(project))  # type: ignore[arg-type]
    stamp = now_iso()
    outcome_for_bad = "blocked" if mode == "enforce" else "reported"
    entries: list[dict[str, object]] = []
    offending: list[dict[str, object]] = []
    if command:
        entry = {"at": stamp, "tool": tool, "command": command[:200], "outcome": outcome_for_bad, "reason": GIT_STATE_REASON}
        entries.append(entry)
        offending.append(entry)
    if action and role in READ_ONLY_ROLES:
        entry = {"at": stamp, "tool": tool, "command": action[:200], "outcome": outcome_for_bad, "reason": f"{role} is read-only ({action} edits files)"}
        entries.append(entry)
        offending.append(entry)
    inside = [(raw, rel_root) for raw in paths if (rel_root := relative_to_root(root, base, raw)) is not None]
    # Outside the repository (temp files, local:// scratch) is not guarded;
    # git-ignored files are invisible to verify too, so they are not judged here.
    skipped = ignored(root, [rel_root for _raw, rel_root in inside])
    for _raw, rel_root in inside:
        rel = to_project(rel_root, prefix)
        if is_generated(rel) or (rel_root in skipped and not is_protected(rel)):
            continue
        reason = path_violation(role, rel, targets)
        entry = {"at": stamp, "tool": tool, "path": rel, "outcome": outcome_for_bad if reason else "allowed"}
        if reason:
            entry["reason"] = reason
            offending.append(entry)
        elif role in SCOPED_ROLES and not targets:
            entry["unscoped"] = True  # allowed only because target_files was empty
        entries.append(entry)
    if snapshot.get("id") and entries:
        with ledger_path(directory, str(snapshot["id"])).open("a", encoding="utf-8") as handle:
            for entry in entries:
                handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    result["id"] = snapshot.get("id")
    result["blocked"] = [{key: item[key] for key in ("path", "command", "reason") if key in item} for item in offending]
    result["allowed"] = not (offending and mode == "enforce")
    return result


def in_windows(mtime_ms: float, windows: list[tuple[float, float]]) -> bool:
    return any(start - WINDOW_SLACK_MS <= mtime_ms <= end + WINDOW_SLACK_MS for start, end in windows)


def parse_windows(values: list[str]) -> list[tuple[float, float]]:
    windows: list[tuple[float, float]] = []
    for value in values:
        try:
            start, end = (float(part) for part in value.split(":", 1))
        except ValueError:
            continue
        windows.append((min(start, end), max(start, end)))
    return windows


def cmd_verify(
    root: Path,
    snapshot_id: str | None,
    exempt: list[str],
    base: Path | None = None,
    windows: list[tuple[float, float]] | None = None,
    whole_repo: bool = False,
) -> dict[str, object]:
    directory = guard_dir(root)
    path = directory / f"{snapshot_id}.snapshot.json" if snapshot_id else open_snapshot(directory)
    if path is None or not path.is_file():
        raise GuardError("no open guard snapshot to verify" if not snapshot_id else f"unknown snapshot: {snapshot_id}")
    snapshot = json.loads(path.read_text(encoding="utf-8"))
    prefix = str(snapshot.get("project_prefix") or "")
    before_head = snapshot.get("head")
    current_head = head(root)
    head_moved = before_head != current_head or snapshot.get("branch") != branch(root)
    before_dirty: dict[str, str] = snapshot.get("dirty") or {}
    candidates = set(dirty_paths(root)) | set(before_dirty)
    if head_moved and before_head and current_head:
        candidates |= {line for line in git(root, "diff", "--name-only", before_head, current_head).splitlines() if line}
    candidates = sorted(candidates)
    now = worktree_blobs(root, candidates)
    at_head = tree_blobs(root, before_head, [item for item in candidates if item not in before_dirty])
    before = {item: before_dirty.get(item, at_head.get(item, DELETED)) for item in candidates}
    exempt_set = {rel for rel in (relative_to_root(root, base or root, item) for item in exempt) if rel}
    changed_root = [
        item
        for item in candidates
        if now[item] != before[item] and item not in exempt_set and not is_generated(to_project(item, prefix))
    ]
    changed = [to_project(item, prefix) for item in changed_root]

    project = base or root
    ledger = read_ledger(directory, str(snapshot["id"]))
    touched = {str(entry["path"]) for entry in ledger if entry.get("path") and entry.get("outcome") in ("allowed", "reported")}
    blocked = [entry for entry in ledger if entry.get("outcome") == "blocked"]
    reported = [entry for entry in ledger if entry.get("outcome") == "reported"]
    if whole_repo:
        attributed, rest = changed, []
    else:
        attributed = [item for item in changed if item in touched]
        rest = [item for item in changed if item not in touched]
    shell_suspects: list[str] = []
    unattributed: list[str] = []
    for item in rest:
        full = project / item
        try:
            mtime_ms = full.lstat().st_mtime * 1000
        except OSError:
            mtime_ms = None
        if windows and mtime_ms is not None and in_windows(mtime_ms, windows):
            shell_suspects.append(item)
        else:
            unattributed.append(item)

    role = str(snapshot.get("role"))
    mode = str(snapshot.get("mode") or current_mode(root, prefix)[0])
    targets = union(list(snapshot.get("targets") or []), [] if whole_repo else state_targets(project))
    if whole_repo:
        verdict, violations, notes = judge(role, attributed, targets, head_moved)
    else:
        # Every attributed edit was decided before it ran; re-judging it against
        # today's target_files could only invent violations. What `enforce` would
        # have blocked (report mode, or a mode switched mid-run) is a note.
        violations, notes = [], []
        changed_set = set(attributed)
        for item in reported:
            if item.get("command") or item.get("path") in changed_set:
                notes.append(f"report mode — enforce would have blocked {describe(item)}")
        unscoped = sorted({str(entry["path"]) for entry in ledger if entry.get("unscoped") and entry.get("path") in changed_set})
        if unscoped:
            notes.append("STATE.yaml target_files was empty: the Coder/Designer scope could not be verified (" + ", ".join(unscoped[:10]) + ")")
        verdict = "unscoped" if unscoped else "clean"
    suspect_commits: list[dict[str, str]] = []
    if head_moved and windows and before_head and current_head:
        log = git(root, "log", "--format=%H%x09%ct%x09%s", f"{before_head}..{current_head}", check=False)
        for line in log.splitlines():
            parts = line.split("\t", 2)
            if len(parts) == 3 and parts[1].isdigit() and in_windows(int(parts[1]) * 1000, windows):
                suspect_commits.append({"sha": parts[0][:12], "subject": parts[2][:120]})
    if blocked:
        listed = "; ".join(describe(item) for item in blocked[:5])
        more = f" and {len(blocked) - 5} more" if len(blocked) > 5 else ""
        notes.append(f"blocked {len(blocked)} out-of-scope action(s) before they ran, nothing was changed: {listed}{more}")
    payload: dict[str, object] = {
        "schema": SCHEMA,
        "id": snapshot["id"],
        "mode": mode,
        "role": snapshot.get("role"),
        "agent": snapshot.get("agent"),
        "step": snapshot.get("step"),
        "targets": targets,
        "verdict": verdict,
        "violations": violations,
        "notes": notes,
        "changed": attributed,
        "blocked": [{key: item[key] for key in ("path", "command", "reason") if key in item} for item in blocked[:LIST_CAP]],
        "shell_suspects": shell_suspects[:LIST_CAP],
        "suspect_commits": suspect_commits[:LIST_CAP],
        "project_prefix": prefix,
        "unattributed": unattributed[:LIST_CAP],
        "unattributed_count": len(unattributed),
        "whole_repo": whole_repo,
        "exempt": sorted(exempt_set),
        "head_moved": head_moved,
        "head_before": before_head,
        "head_after": current_head,
        "snapshot_at": snapshot.get("created_at"),
        "verified_at": now_iso(),
    }
    write_json(directory / f"{snapshot['id']}.verdict.json", payload)
    write_json(directory / "latest.json", payload)
    with (directory / "history.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({key: payload[key] for key in ("id", "role", "agent", "step", "verdict", "verified_at")}) + "\n")
    # The dirty-file map is only needed until the run is verified; keep the record small.
    snapshot["dirty_count"] = len(before_dirty)
    snapshot.pop("dirty", None)
    write_json(path, snapshot)
    return payload


def cmd_mode(root: Path, value: str | None, note: str | None, prefix: str = "") -> dict[str, object]:
    if value is not None:
        if value not in MODES:
            raise GuardError(f"mode must be one of: {', '.join(MODES)}")
        write_json(mode_file(root, prefix), {"mode": value, "note": (note or "").strip(), "set_at": now_iso()})
    mode, source = current_mode(root, prefix)
    return {"mode": mode, "source": source}


def step_verdicts(root: Path, step: str | None, prefix: str | None = None) -> list[dict[str, object]]:
    """All verdicts (oldest first) for a step of one project (None: all), each with its resolution if any."""
    directory = guard_dir(root)
    verdicts: list[dict[str, object]] = []
    for path in sorted(directory.glob("*.verdict.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        if step is not None and payload.get("step") != step:
            continue
        if prefix is not None and "project_prefix" in payload and payload.get("project_prefix") != prefix:
            continue  # another workflow project in the same repository
        resolution = directory / path.name.replace(".verdict.json", ".resolved.json")
        if resolution.is_file():
            payload["resolution"] = json.loads(resolution.read_text(encoding="utf-8"))
        verdicts.append(payload)
    return verdicts


def cmd_status(root: Path, step: str | None, prefix: str | None = None) -> dict[str, object]:
    verdicts = step_verdicts(root, step, prefix)
    return verdicts[-1] if verdicts else {"verdict": "missing", "step": step}


def cmd_resolve(root: Path, snapshot_id: str, note: str) -> dict[str, object]:
    directory = guard_dir(root)
    verdict_path = directory / f"{snapshot_id}.verdict.json"
    if not verdict_path.is_file():
        raise GuardError(f"unknown verdict: {snapshot_id}")
    if not note.strip():
        raise GuardError("--note must record the Human's decision")
    verdict = json.loads(verdict_path.read_text(encoding="utf-8"))
    resolution = {"id": snapshot_id, "note": note.strip(), "resolved_at": now_iso(), "verdict": verdict.get("verdict")}
    write_json(directory / f"{snapshot_id}.resolved.json", resolution)
    return resolution


def legacy(payload: dict[str, object]) -> bool:
    """A 3.5.x verdict: judged on the whole-repository diff, so nothing in it is attributable."""
    return int(payload.get("schema") or 1) < SCHEMA and not payload.get("whole_repo")


def format_verdict(payload: dict[str, object]) -> str:
    tag = " (3.5.x whole-repo verdict, not attributable)" if payload.get("verdict") not in (None, "missing") and legacy(payload) else ""
    lines = [f"guard {payload.get('verdict')}{tag} · {payload.get('role')} · {payload.get('agent') or '-'} · step {payload.get('step') or '-'} · {payload.get('id') or '-'}"]
    for item in payload.get("violations") or []:  # type: ignore[union-attr]
        lines.append(f"  VIOLATION {item['path']}: {item['reason']}")
    for note in payload.get("notes") or []:  # type: ignore[union-attr]
        lines.append(f"  NOTE {note}")
    if payload.get("resolution"):
        lines.append(f"  RESOLVED {payload['resolution'].get('note')}")  # type: ignore[union-attr]
    changed = payload.get("changed") or []
    if changed and payload.get("verdict") != "violation":
        lines.append("  changed by the worker: " + ", ".join(changed))  # type: ignore[arg-type]
    for commit in payload.get("suspect_commits") or []:  # type: ignore[union-attr]
        lines.append(f"  commit made while the worker's shell ran (check it): {commit.get('sha')} {commit.get('subject')}")
    suspects = payload.get("shell_suspects") or []
    if suspects:
        lines.append("  changed while the worker's shell ran (check the diff): " + ", ".join(suspects))  # type: ignore[arg-type]
    count = int(payload.get("unattributed_count") or 0)
    if count:
        shown = ", ".join(payload.get("unattributed") or [])  # type: ignore[arg-type]
        lines.append(f"  changed by others meanwhile (Main, Human, parallel sessions; not the worker's): {count} — {shown}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", default=None, help="project directory (default: the folder holding AI_Workflow_Kit/)")
    sub = parser.add_subparsers(dest="command", required=True)
    allow = sub.add_parser("allow")
    allow.add_argument("--agent", required=True)
    allow.add_argument("--id", default=None)
    allow.add_argument("--base", default=None, help="directory relative paths are resolved against (default: project)")
    allow.add_argument("--tool", default="edit")
    allow.add_argument("--path", action="append", default=[])
    allow.add_argument("--command", dest="git_command", default=None, help="a git command that changes repository state")
    allow.add_argument("--action", default=None, help="a tool action that edits files (lsp rename, ...)")
    allow.add_argument("--json", action="store_true")
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
    verify.add_argument("--window", action="append", default=[], help="START_MS:END_MS of a worker shell command")
    verify.add_argument("--whole-repo", action="store_true", help="attribute every change to the worker (manual audit)")
    verify.add_argument("--json", action="store_true")
    status = sub.add_parser("status")
    status.add_argument("--step", default=None)
    status.add_argument("--all", action="store_true")
    status.add_argument("--json", action="store_true")
    resolve = sub.add_parser("resolve")
    resolve.add_argument("--id", required=True)
    resolve.add_argument("--note", required=True)
    resolve.add_argument("--json", action="store_true")
    mode = sub.add_parser("mode")
    mode.add_argument("value", nargs="?", choices=MODES)
    mode.add_argument("--note", default=None)
    mode.add_argument("--json", action="store_true")
    policy = sub.add_parser("policy")
    policy.add_argument("--role", required=True)
    args = parser.parse_args(argv)

    project = Path(args.project).resolve() if args.project else Path(__file__).resolve().parents[2]
    try:
        if args.command == "policy":
            role = normalize_role(args.role)
            if role == "unknown":
                print("unknown: not a workflow worker (OMP's own agents are not guarded); manual snapshots judge it read-only")
                return 0
            kind = "read-only" if role in READ_ONLY_ROLES else "target_files" if role in SCOPED_ROLES else "tests + target_files"
            print(f"{role}: {kind}; never workflow files or git state changes (blocked before they run)")
            return 0
        root = repo_root(project)
        if args.command == "allow":
            base = Path(args.base).resolve() if args.base else project
            payload = cmd_allow(root, project, args.agent, args.id, base, args.tool, args.path, args.git_command, args.action)
            if args.json:
                print(json.dumps(payload, indent=2, ensure_ascii=False))
            else:
                print("allowed" if payload["allowed"] else "blocked: " + "; ".join(describe(item) for item in payload["blocked"]))  # type: ignore[union-attr]
            return 0 if payload["allowed"] else 1
        if args.command == "snapshot":
            payload = cmd_snapshot(root, project, args.role, args.agent, args.step, args.target, args.id)
            label = "skipped (guard mode off)" if payload.get("skipped") else str(payload["id"])
            print(json.dumps(payload, indent=2) if args.json else f"guard snapshot {label} ({payload['role']})")
            return 0
        if args.command == "verify":
            payload = cmd_verify(root, args.id, args.exempt, project, parse_windows(args.window), args.whole_repo)
            print(json.dumps(payload, indent=2, ensure_ascii=False) if args.json else format_verdict(payload))
            return 1 if payload["verdict"] == "violation" else 0
        if args.command == "resolve":
            payload = cmd_resolve(root, args.id, args.note)
            print(json.dumps(payload, indent=2, ensure_ascii=False) if args.json else f"resolved {args.id}: {payload['note']}")
            return 0
        prefix = project_prefix(root, project)
        if args.command == "mode":
            payload = cmd_mode(root, args.value, args.note, prefix)
            print(json.dumps(payload) if args.json else f"guard mode: {payload['mode']} ({payload['source']})")
            return 0
        if args.all:
            verdicts = step_verdicts(root, args.step, prefix)
            print(json.dumps(verdicts, indent=2, ensure_ascii=False) if args.json else "\n".join(format_verdict(item) for item in verdicts) or "no verdicts")
            return 0
        payload = cmd_status(root, args.step, prefix)
        print(json.dumps(payload, indent=2, ensure_ascii=False) if args.json else format_verdict(payload))
        return 0
    except GuardError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
