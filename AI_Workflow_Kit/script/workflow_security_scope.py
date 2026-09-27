#!/usr/bin/env python3
"""Classify a verified diff by blast radius: security, contracts, infra, deps, control plane.

  workflow_security_scope.py [--json] [--base REF|auto|none] [--step S1] [paths ...]

Without explicit paths it reads the repository diff: working tree + index +
untracked files, compared with --base. `--base auto` (default) uses the
checkpoint tag `<prefix>/pre-<step>` for the current step when it exists, so
changes a worker already committed are still visible.

Matching is token based (path segments, file-name parts, camelCase words), so
`src/login.ts`, `rbac.go`, or `stripeWebhook.ts` hit while `authors.ts`,
`urls.ts`, or `lessons/` do not.

Output keys (stable): offer_scoped, forbid_quick, hits, forbid_hits, checked;
plus categories {path: [category, ...]}, reasons, and base.
Exit code is always 0 unless arguments are invalid (2).
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath

SECURITY_TOKENS = {
    "auth", "authn", "authz", "authentication", "authenticate", "authenticator", "authorization",
    "authorize", "authorizer", "oauth", "oauth2", "openid", "oidc", "saml", "sso", "login", "logout",
    "signin", "signout", "signup", "session", "sessions", "token", "tokens", "jwt", "jwk", "jwks",
    "apikey", "apikeys", "password", "passwords", "passwd", "passphrase", "secret", "secrets",
    "credential", "credentials", "creds", "crypto", "cryptography", "encrypt", "encryption", "decrypt",
    "cipher", "hmac", "cert", "certs", "certificate", "certificates", "tls", "ssl", "keychain",
    "keystore", "vault", "kms", "cookie", "cookies", "csrf", "xss", "cors", "csp", "sanitize",
    "sanitizer", "permission", "permissions", "acl", "rbac", "abac", "guard", "guards", "middleware",
    "admin", "sudo", "privilege", "privileges", "impersonate", "impersonation", "rls", "ipc", "sandbox",
    "upload", "uploads", "download", "downloads", "webhook", "webhooks", "payment", "payments",
    "billing", "checkout", "stripe", "paypal", "sql", "injection", "ssrf", "mfa", "totp", "otp", "2fa",
    "captcha", "ratelimit", "ratelimiter",
}
SECURITY_BIGRAMS = {("api", "key"), ("api", "keys"), ("access", "control"), ("rate", "limit"), ("sign", "in")}
DESIGN_CONTEXT = {"theme", "themes", "design", "style", "styles", "css", "tailwind", "color", "colors", "typography", "ui"}
CONTRACT_TOKENS = {
    "schema", "schemas", "migration", "migrations", "migrate", "openapi", "swagger", "graphql", "gql",
    "proto", "protobuf", "grpc", "api", "apis", "contract", "contracts", "prisma", "ddl", "avro",
    "thrift", "idl",
}
CONTRACT_SUFFIXES = (".proto", ".graphql", ".gql", ".avsc", ".thrift", ".sql", ".prisma")
SECRET_FILE_GLOBS = (
    ".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore", "id_rsa*", "id_ed25519*",
    ".netrc", ".npmrc", ".pypirc", "credentials*.json", "service-account*.json",
)
SECRET_FILE_EXCEPTIONS = (".env.example", ".env.sample", ".env.template", ".env.dist")
DEPENDENCY_FILES = {
    "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
    "yarn.lock", "bun.lock", "bun.lockb", "requirements.txt", "constraints.txt", "pyproject.toml",
    "poetry.lock", "pipfile", "pipfile.lock", "uv.lock", "setup.py", "setup.cfg", "cargo.toml", "cargo.lock",
    "go.mod", "go.sum", "gemfile", "gemfile.lock", "composer.json", "composer.lock", "build.gradle",
    "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "pom.xml", "package.swift",
    "package.resolved", "podfile", "podfile.lock", "pubspec.yaml", "pubspec.lock", "deno.json",
    "deno.lock", "mix.exs", "mix.lock", "packages.lock.json", "directory.packages.props",
}
DEPENDENCY_GLOBS = ("requirements*.txt", "requirements/*.txt", "*.csproj", "*.fsproj")
INFRA_GLOBS = (
    ".github/workflows/*", ".github/actions/*", ".gitlab-ci.yml", ".circleci/*", "Jenkinsfile",
    "azure-pipelines.yml", "bitbucket-pipelines.yml", ".buildkite/*", "Dockerfile", "Dockerfile.*",
    "*.dockerfile", "docker-compose*.yml", "docker-compose*.yaml", "compose.yml", "compose.yaml",
    "*.tf", "*.tfvars", "*.hcl", "serverless.yml", "serverless.yaml", "vercel.json", "netlify.toml",
    "fly.toml", "Procfile", "nginx.conf", "*.service",
)
INFRA_SEGMENTS = {"terraform", "k8s", "kubernetes", "helm", "charts", "infra", "ansible", "deploy", "deployment", ".github"}
CONTROL_PLANE_PREFIXES = (
    ".omp/", "AI_Workflow_Kit/script/", "AI_Workflow_Kit/templates/", "AI_Workflow_Kit/vendor/",
    "AI_Workflow_Kit/docs/AI/", "grilling/", "ponytail/", "ponytail-review/", "ponytail-audit/",
    "ponytail-debt/", "ui-designer/",
)
CONTROL_PLANE_FILES = {
    "AI_Workflow_Kit/framework.manifest", "AI_Workflow_Kit/installed.manifest", "AI_Workflow_Kit/VERSION",
    "PIPELINE.md", "ORCHESTRATOR_FIRST_PROMPT.md", ".graphifyignore",
}
IGNORED_PREFIXES = ("graphify-out/",)
# Main-owned durable memory (mirrors the `state` entries of framework.manifest).
DEFAULT_STATE_FILES = {
    "AI_Workflow_Kit/docs/PROJECT_CONTEXT.md", "AI_Workflow_Kit/docs/STEPS.md", "AI_Workflow_Kit/docs/DECISIONS.md",
    "AI_Workflow_Kit/docs/AI/STATE.yaml", "AI_Workflow_Kit/docs/AI/FEEDBACK.md", "AI_Workflow_Kit/docs/AI/REPORT.md",
    "AI_Workflow_Kit/docs/AI/BUG_REPORT.md", "AI_Workflow_Kit/docs/AI/SECURITY_REPORT.md",
    "AI_Workflow_Kit/docs/AI/COVERAGE.md",
}
FORBID_CATEGORIES = {"security", "secrets", "contract", "infra", "dependencies", "control_plane"}
OFFER_CATEGORIES = {"security", "secrets", "infra", "control_plane"}
CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")
CURRENT_STEP = re.compile(r"^current_step:\s*[\"']?([^\"'#\s]+)", re.M)


def repo_root_from_here() -> Path:
    return Path(__file__).resolve().parents[2]


def normalize(path: str) -> str:
    text = path.replace("\\", "/").strip()
    return text[2:] if text.startswith("./") else text


def tokens(path: str) -> list[str]:
    words: list[str] = []
    for part in re.split(r"[/._\-\s]+", path):
        if not part:
            continue
        for word in CAMEL.split(part):
            if word:
                words.append(word.lower())
    return words


def state_files(root: Path) -> set[str]:
    manifest = root / "AI_Workflow_Kit" / "framework.manifest"
    try:
        entries = [line.split("#", 1)[0].split() for line in manifest.read_text(encoding="utf-8").splitlines()]
    except OSError:
        return set(DEFAULT_STATE_FILES)
    found = {fields[1] for fields in entries if len(fields) == 2 and fields[0] == "state"}
    return found or set(DEFAULT_STATE_FILES)


def matches_any(path: str, patterns: tuple[str, ...]) -> bool:
    name = PurePosixPath(path).name
    return any(fnmatch.fnmatchcase(path, pattern) or fnmatch.fnmatchcase(name, pattern) for pattern in patterns)


def classify(path: str, state: set[str]) -> list[str]:
    path = normalize(path)
    if not path or path.startswith(IGNORED_PREFIXES) or path in state:
        return []
    categories: list[str] = []
    name = PurePosixPath(path).name
    lower_name = name.lower()
    words = tokens(path)
    word_set = set(words)

    if path in CONTROL_PLANE_FILES or path.startswith(CONTROL_PLANE_PREFIXES):
        categories.append("control_plane")
    if matches_any(path, SECRET_FILE_GLOBS) and lower_name not in SECRET_FILE_EXCEPTIONS:
        categories.append("secrets")
    security_words = word_set & SECURITY_TOKENS
    if security_words <= {"token", "tokens"} and security_words and word_set & DESIGN_CONTEXT:
        security_words = set()  # design tokens, not credentials
    bigrams = set(zip(words, words[1:]))
    if security_words or bigrams & SECURITY_BIGRAMS:
        categories.append("security")
    if word_set & CONTRACT_TOKENS or lower_name.endswith(CONTRACT_SUFFIXES):
        categories.append("contract")
    if lower_name in DEPENDENCY_FILES or matches_any(path, DEPENDENCY_GLOBS):
        categories.append("dependencies")
    segments = {segment.lower() for segment in PurePosixPath(path).parts[:-1]}
    if matches_any(path, INFRA_GLOBS) or segments & INFRA_SEGMENTS:
        categories.append("infra")
    return categories


def _git_lines(root: Path, *args: str) -> list[str] | None:
    try:
        completed = subprocess.run(["git", "-C", str(root), *args], check=False, capture_output=True, text=True)
    except OSError:
        return None
    if completed.returncode != 0:
        return None
    return [line.strip() for line in completed.stdout.splitlines() if line.strip()]


def resolve_base(root: Path, base: str, step: str | None) -> str | None:
    if base == "none":
        return None
    if base != "auto":
        return base
    if not step:
        state = root / "AI_Workflow_Kit" / "docs" / "AI" / "STATE.yaml"
        try:
            match = CURRENT_STEP.search(state.read_text(encoding="utf-8"))
            step = match.group(1) if match else None
        except OSError:
            step = None
    if not step:
        return None
    tags = _git_lines(root, "tag", "--list", f"*/pre-{step}") or []
    return tags[0] if len(tags) == 1 else None


def git_paths(root: Path, base: str | None) -> list[str]:
    commands = [("diff", "--name-only"), ("diff", "--cached", "--name-only"), ("ls-files", "--others", "--exclude-standard")]
    if base:
        commands.insert(0, ("diff", "--name-only", base))
    names: list[str] = []
    seen: set[str] = set()
    for command in commands:
        for path in _git_lines(root, *command) or []:
            path = normalize(path)
            if path not in seen:
                seen.add(path)
                names.append(path)
    return names


def scope(paths: list[str], root: Path, base: str | None = None) -> dict[str, object]:
    state = state_files(root)
    categories = {normalize(path): classify(path, state) for path in paths}
    categories = {path: found for path, found in categories.items() if found}
    offer = [path for path, found in categories.items() if set(found) & OFFER_CATEGORIES]
    forbid = [path for path, found in categories.items() if set(found) & FORBID_CATEGORIES]
    reasons = sorted({category for found in categories.values() for category in found})
    return {
        "offer_scoped": bool(offer),
        "forbid_quick": bool(forbid),
        "hits": offer,
        "forbid_hits": forbid,
        "categories": categories,
        "reasons": reasons,
        "checked": len(paths),
        "base": base,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("paths", nargs="*")
    parser.add_argument("--project", default=None)
    parser.add_argument("--base", default="auto", help="git ref to diff against, 'auto' (pre-step tag) or 'none'")
    parser.add_argument("--step", default=None)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    root = Path(args.project).resolve() if args.project else repo_root_from_here()
    base = None if args.paths else resolve_base(root, args.base, args.step)
    paths = list(args.paths) if args.paths else git_paths(root, base)
    payload = scope(paths, root, base)
    if args.json:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
    elif payload["forbid_quick"]:
        print("offer_scoped" if payload["offer_scoped"] else "forbid_quick")
        for path in payload["forbid_hits"]:  # type: ignore[union-attr]
            print(f"{path}\t{','.join(payload['categories'][path])}")  # type: ignore[index]
    else:
        print("none")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
