#!/usr/bin/env python3
"""Detect credential/auth/trust-boundary paths in a verified diff."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

PATH_HINTS = (
    "auth",
    "credential",
    "secret",
    "token",
    "session",
    "password",
    "oauth",
    "jwt",
    "ipc",
    "download",
    "sql",
    "crypto",
    "cookie",
    "cors",
    "csrf",
    "permission",
    "vault",
    "rls",
    "sso",
    "saml",
    "oidc",
    "kms",
)
HINT = re.compile("|".join(re.escape(item) for item in PATH_HINTS), re.I)
SKIP_PREFIXES = (
    "AI_Workflow_Kit/docs/",
    ".omp/",
    "graphify-out/",
    "ponytail/",
    "ui-designer/",
    "grilling/",
)


def repo_root_from_here() -> Path:
    return Path(__file__).resolve().parents[2]


def git_paths(root: Path) -> list[str]:
    commands = (
        ["git", "-C", str(root), "diff", "--name-only"],
        ["git", "-C", str(root), "diff", "--cached", "--name-only"],
        ["git", "-C", str(root), "ls-files", "--others", "--exclude-standard"],
    )
    names: list[str] = []
    seen: set[str] = set()
    for command in commands:
        try:
            completed = subprocess.run(command, check=False, capture_output=True, text=True)
        except OSError:
            continue
        if completed.returncode != 0:
            continue
        for line in completed.stdout.splitlines():
            path = line.strip()
            if path and path not in seen:
                seen.add(path)
                names.append(path)
    return names


def is_product_path(path: str) -> bool:
    normalized = path.replace("\\", "/")
    return not any(normalized.startswith(prefix) for prefix in SKIP_PREFIXES)


def hits_for(paths: list[str]) -> list[str]:
    return [path for path in paths if is_product_path(path) and HINT.search(path)]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*")
    parser.add_argument("--project", default=None)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    root = Path(args.project).resolve() if args.project else repo_root_from_here()
    paths = list(args.paths) if args.paths else git_paths(root)
    hits = hits_for(paths)
    payload = {
        "offer_scoped": bool(hits),
        "hits": hits,
        "checked": len(paths),
    }
    if args.json:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
    elif hits:
        print("offer_scoped")
        for path in hits:
            print(path)
    else:
        print("none")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
