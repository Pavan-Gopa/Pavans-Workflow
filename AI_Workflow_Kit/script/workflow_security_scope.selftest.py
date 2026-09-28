#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "AI_Workflow_Kit" / "script" / "workflow_security_scope.py"


def run(*args: str, project: Path | None = None) -> dict:
    command = [sys.executable, str(SCRIPT), "--json", *args]
    if project is not None:
        command += ["--project", str(project)]
    completed = subprocess.run(command, check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


def categories(path: str) -> list[str]:
    return run(path)["categories"].get(path, [])


def git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True, text=True)


def main() -> int:
    expected = {
        # previously missed (v3.4.x false negatives)
        "src/login.ts": {"security"},
        "src/middleware.ts": {"security"},
        "internal/rbac.go": {"security"},
        "src/routes/admin.ts": {"security"},
        "src/crypto/encrypt.ts": {"security"},
        "upload/handler.ts": {"security"},
        "src/stripeWebhook.ts": {"security"},
        "lib/OAuthClient.swift": {"security"},
        "src/apiKeyStore.ts": {"security", "contract"},
        ".env.production": {"secrets"},
        "certs/server.pem": {"secrets", "security"},
        "Dockerfile": {"infra"},
        ".github/workflows/deploy.yml": {"infra"},
        "infra/main.tf": {"infra"},
        "package.json": {"dependencies"},
        "services/api/poetry.lock": {"dependencies", "contract"},
        ".omp/extensions/evil.ts": {"control_plane"},
        ".omp/agents/workflow-reviewer.md": {"control_plane"},
        "AI_Workflow_Kit/script/workflow_gates.py": {"control_plane"},
        # contracts
        "src/db/migrations/001_users.py": {"contract"},
        "packages/api/openapi.yaml": {"contract"},
        "proto/user.proto": {"contract"},
        # previously flagged by substring accident (false positives) -> now clean
        "src/authors.ts": set(),
        "src/urls.ts": set(),
        "content/lessons/intro.md": set(),
        "src/image_processor.ts": set(),
        "src/capital.ts": set(),
        "src/settings/panel.tsx": set(),
        "README.md": set(),
        "src/theme/tokens.ts": set(),
        ".env.example": set(),
        # Main-owned durable state never counts as a worker blast radius
        "AI_Workflow_Kit/docs/AI/STATE.yaml": set(),
        "AI_Workflow_Kit/docs/STEPS.md": set(),
        "AI_Workflow_Kit/docs/AI/FEEDBACK.md": set(),
        "graphify-out/graph.json": set(),
    }
    failures = []
    for path, want in expected.items():
        got = set(categories(path))
        if got != want:
            failures.append(f"{path}: expected {sorted(want)}, got {sorted(got)}")
    assert not failures, "\n".join(failures)

    miss = run("src/settings/panel.tsx", "README.md")
    assert miss["offer_scoped"] is False and miss["forbid_quick"] is False

    hit = run("src/auth/session.ts", "lib/oauth/client.ts", "src/capital.ts")
    assert hit["offer_scoped"] is True and hit["forbid_quick"] is True
    assert hit["hits"] == ["src/auth/session.ts", "lib/oauth/client.ts"]

    contract = run("src/db/migrations/001_users.py", "src/capital.ts")
    assert contract["offer_scoped"] is False and contract["forbid_quick"] is True
    assert contract["reasons"] == ["contract"]

    deps = run("package-lock.json")
    assert deps["forbid_quick"] is True and deps["offer_scoped"] is False

    # --base auto: changes a worker already COMMITTED stay visible via the pre-step tag.
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        git(root, "init", "-q")
        git(root, "config", "user.email", "t@example.com")
        git(root, "config", "user.name", "t")
        (root / "AI_Workflow_Kit/docs/AI").mkdir(parents=True)
        (root / "AI_Workflow_Kit/docs/AI/STATE.yaml").write_text("current_step: S7\n", encoding="utf-8")
        (root / "src").mkdir()
        (root / "src/app.ts").write_text("export {}\n", encoding="utf-8")
        git(root, "add", "-A")
        git(root, "commit", "-qm", "base")
        git(root, "tag", "proj/pre-S7")
        (root / "src/login.ts").write_text("export const login = 1\n", encoding="utf-8")
        git(root, "add", "-A")
        git(root, "commit", "-qm", "worker commit")
        committed = run(project=root)
        assert committed["base"] == "proj/pre-S7", committed
        assert committed["forbid_hits"] == ["src/login.ts"], committed
        working_only = run("--base", "none", project=root)
        assert working_only["forbid_quick"] is False, "without a base only the working tree is visible"

    print("workflow_security_scope.selftest: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
