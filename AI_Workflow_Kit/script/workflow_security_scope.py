#!/usr/bin/env python3
"""Detect credential/auth/trust-boundary and public-contract paths in a verified diff."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

SECURITY_HINTS = (
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
CONTRACT_HINTS = (
    "schema",
    "migration",
    "migrate",
    "openapi",
    "graphql",
    "protobuf",
    "grpc",
)
SECURITY_HINT = re.compile("|".join(re.escape(item) for item in SECURITY_HINTS), re.I)
CONTRACT_HINT = re.compile("|".join(re.escape(item) for item in CONTRACT_HINTS), re.I)
API_SEGMENT = re.compile(r"(^|/)api(/|$|\.)", re.I)
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


def normalize(path: str) -> str:
    return path.replace("\\", "/")


def security_hit(path: str) -> bool:
    return bool(SECURITY_HINT.search(normalize(path)))


def contract_hit(path: str) -> bool:
    text = normalize(path)
    return bool(CONTRACT_HINT.search(text) or API_SEGMENT.search(text))


def hits_for(paths: list[str]) -> list[str]:
    return [path for path in paths if is_product_path(path) and security_hit(path)]


def forbid_hits_for(paths: list[str]) -> list[str]:
    return [path for path in paths if is_product_path(path) and (security_hit(path) or contract_hit(path))]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*")
    parser.add_argument("--project", default=None)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    root = Path(args.project).resolve() if args.project else repo_root_from_here()
    paths = list(args.paths) if args.paths else git_paths(root)
    security = hits_for(paths)
    forbid = forbid_hits_for(paths)
    payload = {
        "offer_scoped": bool(security),
        "forbid_quick": bool(forbid),
        "hits": security,
        "forbid_hits": forbid,
        "checked": len(paths),
    }
    if args.json:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
    elif forbid:
        print("forbid_quick" if forbid and not security else "offer_scoped")
        for path in forbid:
            print(path)
    else:
        print("none")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
