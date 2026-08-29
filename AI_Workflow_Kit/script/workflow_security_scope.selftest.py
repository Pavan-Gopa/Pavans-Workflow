#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "AI_Workflow_Kit" / "script" / "workflow_security_scope.py"


def run(*paths: str) -> dict:
    completed = subprocess.run(
        [sys.executable, str(SCRIPT), "--json", *paths],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def main() -> int:
    miss = run("src/settings/panel.tsx", "README.md")
    assert miss["offer_scoped"] is False
    assert miss["forbid_quick"] is False

    hit = run("src/auth/session.ts", "lib/oauth/client.ts", "AI_Workflow_Kit/docs/AI/SECURITY.md")
    assert hit["offer_scoped"] is True
    assert hit["forbid_quick"] is True
    assert "src/auth/session.ts" in hit["hits"]
    assert "lib/oauth/client.ts" in hit["hits"]
    assert "AI_Workflow_Kit/docs/AI/SECURITY.md" not in hit["hits"]
    assert "AI_Workflow_Kit/docs/AI/SECURITY.md" not in hit["forbid_hits"]

    contract = run("src/db/migrations/001_users.py", "packages/api/openapi.yaml", "src/capital.ts")
    assert contract["offer_scoped"] is False
    assert contract["forbid_quick"] is True
    assert "src/db/migrations/001_users.py" in contract["forbid_hits"]
    assert "packages/api/openapi.yaml" in contract["forbid_hits"]
    assert "src/capital.ts" not in contract["forbid_hits"]

    print("workflow_security_scope.selftest: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
