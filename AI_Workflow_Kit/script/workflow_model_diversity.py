#!/usr/bin/env python3
"""Static model-independence check for .omp/config.yml (no OMP call needed).

  workflow_model_diversity.py [--config .omp/config.yml] [--json] [--strict]

Independent review is the point of a multi-model pipeline. This reports
assignments that quietly remove it:

  * Reviewer runs the same model as the Coder primary or the Coder backup
    (after a failover the Reviewer would grade its own model's output).
  * A role's backup sits on the same provider as its primary (a provider
    outage takes out both).
  * One provider backs up more than half of the core roles AND runs a core
    primary (a single outage disables the primary and most fallbacks at once).

Advisory: exit 0, or 1 with --strict when anything is reported.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

CORE = ("coder", "reviewer", "tester", "architect", "security")
ALL_MAIN = ("orchestrator", *CORE)
ROLE_LINE = re.compile(r"^(?P<indent>[ \t]+)(?P<key>[A-Za-z0-9_.-]+):[ \t]*(?P<value>[^#]*?)[ \t]*(?:#.*)?$")
EFFORT = re.compile(r":(minimal|low|medium|high|xhigh|max|auto)$")


def read_roles(text: str) -> dict[str, str]:
    roles: dict[str, str] = {}
    inside = False
    for line in text.splitlines():
        if re.match(r"^modelRoles:[ \t]*(#.*)?$", line):
            inside = True
            continue
        if inside:
            if line.strip() and not line.startswith((" ", "\t")):
                break
            match = ROLE_LINE.match(line)
            if match and match.group("value"):
                roles[match.group("key")] = match.group("value").strip().strip("\"'")
    return roles


def resolve(roles: dict[str, str], key: str, seen: tuple[str, ...] = ()) -> str | None:
    value = roles.get(key)
    if not value:
        return None
    if value.startswith("@"):
        target = value[1:].split(":", 1)[0]
        if target in seen or target == "default":
            return None if target in seen else "@default"
        return resolve(roles, target, (*seen, key))
    return value


def model_id(selector: str | None) -> str | None:
    return EFFORT.sub("", selector) if selector else None


def provider(selector: str | None) -> str | None:
    return selector.split("/", 1)[0] if selector and "/" in selector else None


def analyse(roles: dict[str, str]) -> list[dict[str, str]]:
    def primary(role: str) -> str | None:
        return resolve(roles, f"workflow_{role}") if role != "orchestrator" else resolve(roles, "default") or resolve(roles, "workflow_orchestrator")

    def backup(role: str) -> str | None:
        return resolve(roles, f"workflow_{role}_backup")

    findings: list[dict[str, str]] = []
    reviewer = model_id(primary("reviewer"))
    for label, selector in (("Coder primary", primary("coder")), ("Coder backup", backup("coder"))):
        if reviewer and reviewer != "@default" and reviewer == model_id(selector):
            findings.append({
                "code": "reviewer_not_independent",
                "message": f"Reviewer and {label} both use {reviewer}; the Reviewer would grade its own model's work. "
                "Assign workflow_reviewer (or the Coder backup) to a different model family.",
            })
    fast_coder_sel = resolve(roles, "workflow_coder_fast")
    coder_sel = primary("coder")
    fast_coder_mid = model_id(fast_coder_sel)
    coder_mid = model_id(coder_sel)
    if reviewer and fast_coder_mid and fast_coder_mid != "@default" and fast_coder_mid != coder_mid and fast_coder_mid == reviewer:
        findings.append({
            "code": "reviewer_not_independent",
            "message": f"Reviewer and Fast Coder both use {reviewer}; the Reviewer would grade its own model's work. "
            "Assign workflow_reviewer (or Fast Coder) to a different model family.",
        })
    for role in ALL_MAIN:
        p, b = primary(role), backup(role)
        if provider(p) and provider(p) == provider(b) and p != "@default":
            findings.append({
                "code": "backup_same_provider",
                "message": f"{role}: primary and backup are both on provider '{provider(p)}'; a provider outage disables both.",
            })
    backups = Counter(provider(backup(role)) for role in ALL_MAIN if provider(backup(role)))
    primaries = {provider(primary(role)) for role in ALL_MAIN if provider(primary(role))}
    for name, count in backups.items():
        if count * 2 > len(ALL_MAIN) and name in primaries:
            users = [role for role in ALL_MAIN if provider(primary(role)) == name]
            findings.append({
                "code": "backup_concentration",
                "message": f"provider '{name}' backs up {count}/{len(ALL_MAIN)} core roles and also runs the "
                f"{', '.join(users)} primary; one outage removes the primary and most fallbacks together.",
            })
    return findings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", default=str(Path(__file__).resolve().parents[2] / ".omp" / "config.yml"))
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args(argv)
    try:
        roles = read_roles(Path(args.config).read_text(encoding="utf-8"))
    except OSError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2
    findings = analyse(roles)
    if args.json:
        print(json.dumps({"findings": findings}, indent=2))
    elif findings:
        for item in findings:
            print(f"WARN model diversity: {item['message']}")
    else:
        print("OK   model diversity: Reviewer is independent of Coder; backups are spread across providers")
    return 1 if findings and args.strict else 0


if __name__ == "__main__":
    raise SystemExit(main())
