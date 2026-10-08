#!/usr/bin/env python3
"""Local append-only observer for Pavan's Workflow.

This module records bounded metadata only. It never mutates workflow state and
never sends telemetry over the network.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

SCHEMA_VERSION = 1
METRICS_ENV = "PAVAN_WORKFLOW_METRICS_PATH"
EVENTS_RELATIVE_PATH = Path("pavans-workflow/metrics/events.jsonl")

EVENT_TYPES = {
    "step_started",
    "step_completed",
    "worker_started",
    "worker_result",
    "failure",
    "runtime_interruption",
    "model_failure",
    "gate_skipped",
    "retry_safeguard_triggered",
    "human_rating",
    "human_turn",
    "orchestrator_model",
}
ROLES = {"coder", "coder_fast", "reviewer", "tester", "architect", "security"}
FAILURE_CATEGORIES = {
    "missed_requirement",
    "incorrect_implementation",
    "scope_violation",
    "architecture_mismatch",
    "objective_gate_failure",
    "regression",
    "ambiguous_requirement",
    "other",
}
DETECTED_BY = {"main", "reviewer", "tester", "architect"}
REVIEW_KINDS = {"product", "test_diff"}
ARCHITECT_MODES = {"advisory", "design", "grilling"}
GATES = {"reviewer", "qa", "security"}
RATINGS = {"good", "overkill", "underchecked"}
PIPELINE_PROFILES = {"quick", "standard", "critical"}
INTERRUPTIONS = {
    "interrupted_no_changes",
    "interrupted_partial",
    "indeterminate",
}
RESULTS_BY_ROLE = {
    "coder": {"waiting_review", "blocked"},
    "coder_fast": {"waiting_review", "blocked"},
    "reviewer": {"approved", "changes_requested", "blocked"},
    "tester": {"qa_green", "bugs", "blocked"},
    "architect": {"advice_ready", "design_ready", "needs_human_input", "blocked"},
    "security": {"security_clean", "findings_open", "blocked"},
}
ALLOWED_FIELDS = {
    "schema_version",
    "ts",
    "event",
    "event_key",
    "step",
    "run_id",
    "candidate_id",
    "role",
    "attempt",
    "result",
    "model_role",
    "provider",
    "model",
    "evidence_ref",
    "duration_ms",
    "mode",
    "review_kind",
    "gate",
    "failure_category",
    "detected_by",
    "classification",
    "status",
    "repeat_count",
    "threshold",
    "human_rating",
    "pipeline_profile",
    "tokens",
}
SIMPLE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$")
SIMPLE_REF = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$")
THINKING_SUFFIX = re.compile(r":(?:off|minimal|low|medium|high|xhigh|max|auto|inherit)$")
# Model ids may carry a vendor revision such as claude-sonnet-4@20250514 or a +suffix.
MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,159}$")


class MetricsError(Exception):
    """A user-facing validation or storage error."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_ts(value: Any) -> Optional[datetime]:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo is not None else None
    except ValueError:
        return None


def is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def git_path(args: list[str], cwd: Path) -> Path:
    completed = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode != 0:
        raise MetricsError(completed.stderr.strip() or "Git repository is unavailable")
    raw = completed.stdout.strip()
    if not raw:
        raise MetricsError("Git returned an empty path")
    path = Path(raw).expanduser()
    return (cwd / path).resolve() if not path.is_absolute() else path.resolve()


def resolve_store(cwd: Optional[Path] = None, override: Optional[str] = None) -> tuple[Path, Path]:
    root = (cwd or Path.cwd()).resolve()
    common_dir = git_path(["rev-parse", "--git-common-dir"], root)
    worktree = git_path(["rev-parse", "--show-toplevel"], root)
    configured = override if override is not None else os.environ.get(METRICS_ENV)
    if configured:
        events_path = Path(configured).expanduser()
        events_path = (root / events_path).resolve() if not events_path.is_absolute() else events_path.resolve()
        if is_relative_to(events_path, worktree) and not is_relative_to(events_path, common_dir):
            raise MetricsError(
                f"{METRICS_ENV} must be outside the worktree or inside Git's common directory; got {events_path}"
            )
    else:
        events_path = (common_dir / EVENTS_RELATIVE_PATH).resolve()
    metadata_path = events_path.with_suffix(events_path.suffix + ".meta.json")
    return events_path, metadata_path


def empty_store_info(events_path: Path, metadata_path: Path) -> dict[str, Any]:
    return {
        "events_path": str(events_path),
        "metadata_path": str(metadata_path),
        "valid_events": 0,
        "malformed_lines": 0,
        "unknown_events": 0,
        "future_schema_events": 0,
        "data_since": None,
    }


def semantic_payload(event: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in event.items() if key != "ts"}


def read_events(events_path: Path) -> tuple[list[dict[str, Any]], dict[str, Any], list[str]]:
    metadata_path = events_path.with_suffix(events_path.suffix + ".meta.json")
    info = empty_store_info(events_path, metadata_path)
    warnings: list[str] = []
    if not events_path.exists():
        return [], info, warnings

    valid: list[dict[str, Any]] = []
    seen: dict[str, dict[str, Any]] = {}
    with events_path.open("r", encoding="utf-8", errors="replace") as handle:
        for line_number, raw in enumerate(handle, 1):
            if not raw.strip():
                continue
            try:
                event = json.loads(raw)
            except json.JSONDecodeError as error:
                info["malformed_lines"] += 1
                warnings.append(f"line {line_number}: malformed JSON ({error.msg}); skipped")
                continue
            if not isinstance(event, dict) or not isinstance(event.get("event_key"), str):
                info["malformed_lines"] += 1
                warnings.append(f"line {line_number}: event object/event_key missing; skipped")
                continue
            key = event["event_key"]
            if key in seen:
                if semantic_payload(seen[key]) != semantic_payload(event):
                    warnings.append(f"line {line_number}: conflicting duplicate event_key {key!r}; first event kept")
                continue
            if event.get("event") not in EVENT_TYPES:
                info["unknown_events"] += 1
                continue
            try:
                validate_event({field: value for field, value in event.items() if field in ALLOWED_FIELDS})
            except MetricsError as error:
                info["malformed_lines"] += 1
                warnings.append(f"line {line_number}: invalid event ({error}); skipped")
                continue
            version = event.get("schema_version")
            if isinstance(version, int) and version > SCHEMA_VERSION:
                info["future_schema_events"] += 1
            seen[key] = event
            valid.append(event)

    valid.sort(key=lambda item: (item.get("ts", ""), item.get("event_key", "")))
    info["valid_events"] = len(valid)
    info["data_since"] = valid[0].get("ts") if valid else None
    return valid, info, warnings


def ensure_metadata(metadata_path: Path, first_event_ts: str) -> None:
    if metadata_path.exists():
        return
    metadata_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": SCHEMA_VERSION,
        "metrics_started_at": first_event_ts,
        "data_since": first_event_ts,
    }
    try:
        descriptor = os.open(str(metadata_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=True, sort_keys=True, indent=2)
            handle.write("\n")
    except FileExistsError:
        pass


def require_id(name: str, value: Optional[str]) -> str:
    if value is None or not SIMPLE_ID.fullmatch(value):
        raise MetricsError(f"{name} must match {SIMPLE_ID.pattern}")
    return value


def validate_ref(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    if not SIMPLE_REF.fullmatch(value):
        raise MetricsError("evidence_ref must be a bounded canonical path/reference, not prose")
    return value


def require_enum(name: str, value: Optional[str], allowed: set[str]) -> str:
    if value not in allowed:
        raise MetricsError(f"{name} must be one of: {', '.join(sorted(allowed))}")
    return str(value)


def validate_event(event: dict[str, Any]) -> None:
    unexpected = set(event) - ALLOWED_FIELDS
    if unexpected:
        raise MetricsError(f"unsupported fields: {', '.join(sorted(unexpected))}")
    version = event.get("schema_version")
    if not isinstance(version, int) or version < 1:
        raise MetricsError("schema_version must be a positive integer")
    event_type = require_enum("event", event.get("event"), EVENT_TYPES)
    require_id("event_key", event.get("event_key"))
    if parse_ts(event.get("ts")) is None:
        raise MetricsError("ts must be an ISO-8601 timestamp")
    if event.get("step") is not None:
        require_id("step", event["step"])
    if event.get("run_id") is not None:
        require_id("run_id", event["run_id"])
    if event.get("candidate_id") is not None:
        require_id("candidate_id", event["candidate_id"])
    if event.get("role") is not None:
        require_enum("role", event["role"], ROLES)
    for key in ("model_role", "provider"):
        if event.get(key) is not None:
            require_id(key, event[key])
    if event.get("model") is not None and (
        not isinstance(event["model"], str) or not MODEL_ID.fullmatch(event["model"])
    ):
        raise MetricsError(f"model must match {MODEL_ID.pattern}")
    validate_ref(event.get("evidence_ref"))
    for key in ("attempt", "duration_ms", "repeat_count", "threshold", "tokens"):
        value = event.get(key)
        if value is not None and (not isinstance(value, int) or value < 0):
            raise MetricsError(f"{key} must be a non-negative integer")
    if event.get("pipeline_profile") is not None:
        require_enum("pipeline_profile", event.get("pipeline_profile"), PIPELINE_PROFILES)

    required: dict[str, tuple[str, ...]] = {
        "step_started": ("step",),
        "step_completed": ("step",),
        "worker_started": ("step", "run_id", "role"),
        "worker_result": ("step", "run_id", "role", "result"),
        "failure": ("step", "failure_category", "detected_by", "evidence_ref"),
        "runtime_interruption": ("run_id", "role", "classification"),
        "model_failure": ("run_id", "role", "status"),
        "gate_skipped": ("step", "gate"),
        "retry_safeguard_triggered": ("step", "repeat_count", "threshold"),
        "human_rating": ("step", "human_rating"),
        "human_turn": ("step", "model"),
        "orchestrator_model": ("step", "model"),
    }
    missing = [field for field in required[event_type] if event.get(field) is None]
    if missing:
        raise MetricsError(f"{event_type} requires: {', '.join(missing)}")

    role = event.get("role")
    if event_type == "worker_result":
        require_enum("result", event.get("result"), RESULTS_BY_ROLE[str(role)])
        if role == "reviewer":
            require_enum("review_kind", event.get("review_kind"), REVIEW_KINDS)
        if role in {"reviewer", "tester"} and not event.get("candidate_id"):
            raise MetricsError(f"{role} worker_result requires candidate_id for candidate linkage")
    if event_type == "worker_started" and role == "architect":
        require_enum("mode", event.get("mode"), ARCHITECT_MODES)
    if event_type == "failure":
        require_enum("failure_category", event.get("failure_category"), FAILURE_CATEGORIES)
        require_enum("detected_by", event.get("detected_by"), DETECTED_BY)
    if event_type == "runtime_interruption":
        require_enum("classification", event.get("classification"), INTERRUPTIONS)
    if event_type == "model_failure" and event.get("status") not in {"awaiting_human", "auto_failover"}:
        raise MetricsError("model_failure status must be awaiting_human or auto_failover")
    if event_type == "gate_skipped":
        require_enum("gate", event.get("gate"), GATES)
    if event_type == "retry_safeguard_triggered":
        if event["threshold"] < 1 or event["repeat_count"] < event["threshold"]:
            raise MetricsError("retry safeguard requires threshold >= 1 and repeat_count >= threshold")
    if event_type == "human_rating":
        require_enum("human_rating", event.get("human_rating"), RATINGS)


def append_event(events_path: Path, event: dict[str, Any]) -> tuple[str, list[str]]:
    validate_event(event)
    existing, _info, warnings = read_events(events_path)
    same_key = next((item for item in existing if item["event_key"] == event["event_key"]), None)
    if same_key is not None:
        if semantic_payload(same_key) == semantic_payload(event):
            return "duplicate_noop", warnings
        warnings.append(f"conflicting duplicate event_key {event['event_key']!r}; existing event kept")
        return "duplicate_conflict", warnings

    events_path.parent.mkdir(parents=True, exist_ok=True)
    ensure_metadata(events_path.with_suffix(events_path.suffix + ".meta.json"), event["ts"])
    encoded = json.dumps(event, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n"
    descriptor = os.open(str(events_path), os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        os.write(descriptor, encoded.encode("utf-8"))
    finally:
        os.close(descriptor)
    return "recorded", warnings


def pct(count: int, total: int) -> Optional[float]:
    return round(100.0 * count / total, 1) if total else None


def ratio(count: int, total: int) -> dict[str, Any]:
    return {"count": count, "total": total, "rate_pct": pct(count, total)}


def median_or_none(values: Iterable[float]) -> Optional[int]:
    materialized = list(values)
    return int(round(statistics.median(materialized))) if materialized else None


MIN_RANK_SAMPLES = 5
UNKNOWN_MODEL = "unknown"
CODER_ROLES = ("coder", "coder_fast")
LEADERBOARD_ROLES = ("orchestrator", "coder", "coder_fast", "reviewer", "tester", "architect", "security")
# role -> (primary metric, better direction); roles without an entry are shown but never ranked.
ROLE_PRIMARY = {
    "orchestrator": ("human_messages_per_step", "lower"),
    "coder": ("first_review_approval", "higher"),
    "coder_fast": ("first_review_approval", "higher"),
    "reviewer": ("qa_escape", "lower"),
}
ROLE_LABELS = {
    "orchestrator": "Orchestrator (Main)",
    "coder": "Coder",
    "coder_fast": "Fast Coder",
    "reviewer": "Reviewer",
    "tester": "Tester",
    "architect": "Architect",
    "security": "Security",
}
METRIC_LABELS = {
    "human_messages_per_step": "Human messages per step",
    "first_review_approval": "first-review approval",
    "qa_escape": "QA escape rate",
}
REGISTRY_RELATIVE_PATH = Path("pavans-workflow/projects.json")


def model_key(event: dict[str, Any]) -> str:
    """Canonical model identity for every leaderboard: `provider/id`, effort suffix stripped, else `unknown`."""
    model = event.get("model")
    if not model:
        return UNKNOWN_MODEL
    model = THINKING_SUFFIX.sub("", str(model)).strip()
    if not model:
        return UNKNOWN_MODEL
    provider = event.get("provider")
    return f"{provider}/{model}" if provider and not model.startswith(f"{provider}/") else model


def primary_metric(metric: str, better: str, unit: str, count: int, total: int) -> dict[str, Any]:
    if unit == "pct":
        value = pct(count, total)
    else:
        value = round(count / total, 2) if total else None
    return {"metric": metric, "better": better, "unit": unit, "value": value, "count": count, "total": total}


def finish_model_table(entries: list[dict[str, Any]], primary: Optional[tuple[str, str]]) -> list[dict[str, Any]]:
    """Rank (needs >= MIN_RANK_SAMPLES primary samples), flag low samples, and order the table."""
    for entry in entries:
        entry["rank"] = None
        entry["n"] = entry["primary"]["total"] if entry.get("primary") else entry.get("runs", 0)
        entry["low_sample"] = bool(entry.get("primary")) and entry["n"] < MIN_RANK_SAMPLES
    if primary:
        sign = 1 if primary[1] == "lower" else -1
        eligible = [
            entry
            for entry in entries
            if entry["primary"]["value"] is not None and entry["primary"]["total"] >= MIN_RANK_SAMPLES
        ]
        eligible.sort(key=lambda entry: (sign * entry["primary"]["value"], -entry["primary"]["total"], entry["model"]))
        for position, entry in enumerate(eligible, 1):
            entry["rank"] = position
    return sorted(
        entries,
        key=lambda entry: (entry["rank"] is None, entry["rank"] or 0, -entry["n"], entry["model"]),
    )


def orchestrator_table(
    events_by_type: dict[str, list[dict[str, Any]]], step_stats: dict[str, dict[str, Any]]
) -> Optional[dict[str, Any]]:
    """Main attribution: each completed step belongs to exactly one Main model, else `mixed`/unattributed."""
    if not events_by_type["human_turn"] and not events_by_type["orchestrator_model"]:
        return None
    models_by_step: dict[str, set[str]] = defaultdict(set)
    human_by_step: Counter[str] = Counter()
    for event in events_by_type["orchestrator_model"]:
        models_by_step[str(event.get("step"))].add(model_key(event))
    for event in events_by_type["human_turn"]:
        models_by_step[str(event.get("step"))].add(model_key(event))
        human_by_step[str(event.get("step"))] += 1
    missed_by_step: Counter[str] = Counter(
        str(event.get("step"))
        for event in events_by_type["failure"]
        if event.get("failure_category") == "missed_requirement"
    )
    steps_by_model: dict[str, list[str]] = defaultdict(list)
    mixed = unattributed = 0
    for step, stats in step_stats.items():
        if stats["status"] != "completed":
            continue
        models = models_by_step.get(step, set())
        if not models:
            unattributed += 1
        elif len(models) > 1:
            mixed += 1
        else:
            steps_by_model[next(iter(models))].append(step)
    metric, better = ROLE_PRIMARY["orchestrator"]
    entries: list[dict[str, Any]] = []
    for model, steps in sorted(steps_by_model.items()):
        count = len(steps)
        human = sum(human_by_step[step] for step in steps)
        retries = sum(max(0, step_stats[step]["coder_attempts"] - 1) for step in steps)
        missed = sum(missed_by_step[step] for step in steps)
        ratings = Counter(step_stats[step]["human_rating"] for step in steps if step_stats[step].get("human_rating"))
        entries.append(
            {
                "model": model,
                "steps": count,
                "human_messages": human,
                "coder_retries": retries,
                "coder_retries_per_step": round(retries / count, 2),
                "missed_requirements": missed,
                "missed_requirements_per_step": round(missed / count, 2),
                "median_step_duration_ms": median_or_none(
                    step_stats[step]["duration_ms"] for step in steps if isinstance(step_stats[step].get("duration_ms"), int)
                ),
                "human_ratings": dict(sorted(ratings.items())),
                "primary": primary_metric(metric, better, "per_step", human, count),
            }
        )
    return {
        "metric": metric,
        "better": better,
        "attributed_steps": sum(len(steps) for steps in steps_by_model.values()),
        "mixed_steps": mixed,
        "unattributed_steps": unattributed,
        "models": finish_model_table(entries, (metric, better)),
    }


def build_leaderboard(
    *,
    events_by_type: dict[str, list[dict[str, Any]]],
    step_stats: dict[str, dict[str, Any]],
    starts_by_run: dict[str, dict[str, Any]],
    duration_by_run: dict[str, int],
    product_reviews: list[dict[str, Any]],
    product_review_by_candidate: dict[str, dict[str, Any]],
    tester_candidates: dict[str, dict[str, Any]],
    tester_results: list[dict[str, Any]],
    fast_coder: dict[str, Any],
) -> dict[str, Any]:
    """Per (role, model) effectiveness. Every metric reuses the definitions aggregate() already applies."""
    result_by_run: dict[str, dict[str, Any]] = {}
    for event in events_by_type["worker_result"]:
        result_by_run.setdefault(str(event.get("run_id")), event)
    failure_events = events_by_type["model_failure"]
    failure_by_run: dict[str, dict[str, Any]] = {}
    for event in failure_events:
        failure_by_run.setdefault(str(event.get("run_id")), event)

    # One attribution per dispatched run: its recorded start model, else the failure event's model.
    run_identity: dict[str, tuple[str, str]] = {}
    for run_id, started in starts_by_run.items():
        model = model_key(started)
        if model == UNKNOWN_MODEL and run_id in failure_by_run:
            model = model_key(failure_by_run[run_id])
        run_identity[run_id] = (str(started.get("role", "unknown")), model)
    for run_id, failure in failure_by_run.items():
        run_identity.setdefault(run_id, (str(failure.get("role", "unknown")), model_key(failure)))

    def new_bucket() -> dict[str, Any]:
        return {
            "runs": 0, "durations": [], "tokens": [], "failures": 0,
            "first_review_total": 0, "first_review_approved": 0,
            "fast_resolved": 0, "fast_first_pass": 0,
            "approved": 0, "escapes": 0, "green": 0, "bugs": 0,
        }

    buckets: dict[str, dict[str, dict[str, Any]]] = defaultdict(lambda: defaultdict(new_bucket))
    for run_id, (role, model) in run_identity.items():
        bucket = buckets[role][model]
        bucket["runs"] += 1
        if run_id in duration_by_run:
            bucket["durations"].append(duration_by_run[run_id])
        started = starts_by_run.get(run_id)
        for source in (result_by_run.get(run_id), started):
            if source is not None and isinstance(source.get("tokens"), int):
                bucket["tokens"].append(source["tokens"])
                break
        if role in CODER_ROLES and started is not None:
            review = product_review_by_candidate.get(str(started.get("candidate_id") or run_id))
            if review:
                bucket["first_review_total"] += 1
                if review.get("result") == "approved":
                    bucket["first_review_approved"] += 1
    for failure in failure_events:
        role, model = run_identity[str(failure.get("run_id"))]
        buckets[role][model]["failures"] += 1

    approved_seen: set[str] = set()
    for review in product_reviews:
        candidate = review.get("candidate_id")
        if review.get("result") != "approved" or not candidate or str(candidate) in approved_seen:
            continue
        approved_seen.add(str(candidate))
        verdict = tester_candidates.get(str(candidate))
        if verdict is None:
            continue
        identity = run_identity.get(str(review.get("run_id")))
        bucket = buckets["reviewer"][identity[1] if identity else model_key(review)]
        bucket["approved"] += 1
        if verdict.get("result") == "bugs":
            bucket["escapes"] += 1
    for result in tester_results:
        identity = run_identity.get(str(result.get("run_id")))
        bucket = buckets["tester"][identity[1] if identity else model_key(result)]
        bucket["bugs" if result.get("result") == "bugs" else "green"] += 1
    for attempt in fast_coder.get("attempts", []):
        identity = run_identity.get(str(attempt.get("run_id")))
        if identity is None or attempt.get("outcome") == "pending":
            continue
        buckets["coder_fast"][identity[1]]["fast_resolved"] += 1
        if attempt.get("outcome") == "resolved_success":
            buckets["coder_fast"][identity[1]]["fast_first_pass"] += 1

    roles: dict[str, Any] = {}
    orchestrator = orchestrator_table(events_by_type, step_stats)
    if orchestrator is not None:
        roles["orchestrator"] = orchestrator
    for role in LEADERBOARD_ROLES[1:]:
        models = buckets.get(role)
        if not models:
            continue
        primary = ROLE_PRIMARY.get(role)
        entries: list[dict[str, Any]] = []
        for model, bucket in sorted(models.items()):
            entry: dict[str, Any] = {
                "model": model,
                "runs": bucket["runs"],
                "median_duration_ms": median_or_none(bucket["durations"]),
                "tokens_per_run": round(sum(bucket["tokens"]) / len(bucket["tokens"])) if bucket["tokens"] else None,
                "token_runs": len(bucket["tokens"]),
                "model_failure": ratio(bucket["failures"], bucket["runs"]),
                "primary": None,
            }
            if role in CODER_ROLES:
                entry["primary"] = primary_metric(
                    primary[0], primary[1], "pct", bucket["first_review_approved"], bucket["first_review_total"]
                )
            if role == "coder_fast":
                entry["first_pass"] = ratio(bucket["fast_first_pass"], bucket["fast_resolved"])
            elif role == "reviewer":
                entry["primary"] = primary_metric(primary[0], primary[1], "pct", bucket["escapes"], bucket["approved"])
            elif role == "tester":
                entry["bugs_found"] = ratio(bucket["bugs"], bucket["bugs"] + bucket["green"])
            entries.append(entry)
        roles[role] = {
            "metric": primary[0] if primary else None,
            "better": primary[1] if primary else None,
            "models": finish_model_table(entries, primary),
        }
    return {"min_samples": MIN_RANK_SAMPLES, "roles": roles}


def format_leaderboard(leaderboard: dict[str, Any], label: str) -> list[str]:
    roles = leaderboard.get("roles") or {}
    if not roles:
        return []
    minimum = leaderboard.get("min_samples", MIN_RANK_SAMPLES)
    lines = [f"Model leaderboard · {label} (rank needs >= {minimum} samples; n = primary-metric samples)"]
    for role, block in roles.items():
        header = ROLE_LABELS.get(role, role)
        if block.get("metric"):
            header += f" — {METRIC_LABELS.get(block['metric'], block['metric'])}, {block['better']} is better"
        else:
            header += " — no ranking (no ground truth)"
        if role == "orchestrator":
            header += (
                f"; {block['attributed_steps']} steps attributed, {block['mixed_steps']} mixed (excluded), "
                f"{block['unattributed_steps']} unattributed"
            )
        lines.append(header)
        for entry in block["models"]:
            marker = f"{entry['rank']}." if entry["rank"] else "-"
            primary = entry.get("primary")
            parts: list[str] = []
            if primary:
                if primary["value"] is None:
                    parts.append(f"n/a ({primary['count']}/{primary['total']})")
                elif primary["unit"] == "pct":
                    parts.append(f"{primary['value']:.1f}% ({primary['count']}/{primary['total']})")
                else:
                    msgs, steps = primary["count"], primary["total"]
                    parts.append(
                        f"{primary['value']:.2f} msgs/step ({msgs} msg{'s' if msgs != 1 else ''}, "
                        f"{steps} step{'s' if steps != 1 else ''})"
                    )
            parts.append(f"n={entry['n']}")
            if entry["low_sample"]:
                parts.append("low sample")
            if role == "orchestrator":
                parts.append(f"retries {entry['coder_retries_per_step']:.2f}/step")
                parts.append(f"missed requirement {entry['missed_requirements_per_step']:.2f}/step")
                parts.append(f"median step {format_duration(entry['median_step_duration_ms'])}")
                if entry["human_ratings"]:
                    parts.append("ratings " + ",".join(f"{key}={value}" for key, value in entry["human_ratings"].items()))
            else:
                parts.append(f"runs {entry['runs']}")
                if "first_pass" in entry:
                    parts.append(f"first-pass {format_ratio(entry['first_pass'])}")
                if "bugs_found" in entry:
                    parts.append(f"bugs found {format_ratio(entry['bugs_found'])}")
                parts.append(f"median {format_duration(entry['median_duration_ms'])}")
                if entry["tokens_per_run"] is not None:
                    parts.append(f"tokens/run {entry['tokens_per_run']} ({entry['token_runs']} runs)")
                parts.append(f"model failure {format_ratio(entry['model_failure'])}")
            lines.append(f"  {marker} {entry['model']} · " + " · ".join(parts))
    return lines


def registry_path() -> Path:
    state_home = os.environ.get("XDG_STATE_HOME", "")
    base = Path(state_home) if state_home and Path(state_home).is_absolute() else Path.home() / ".local" / "state"
    return base / REGISTRY_RELATIVE_PATH


def project_identity(cwd: Optional[Path] = None) -> tuple[str, str]:
    """(name, root) of the checkout that owns the store; worktrees share their main checkout's identity."""
    root = (cwd or Path.cwd()).resolve()
    common_dir = git_path(["rev-parse", "--git-common-dir"], root)
    project_root = common_dir.parent if common_dir.name == ".git" else git_path(["rev-parse", "--show-toplevel"], root)
    return project_root.name or str(project_root), str(project_root)


def read_registry(path: Path) -> tuple[list[dict[str, str]], Optional[str]]:
    """Valid registry entries plus a note when the file exists but cannot be used."""
    if not path.exists():
        return [], None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return [], f"unreadable ({error})"
    if not isinstance(payload, list):
        return [], "not a JSON list"
    entries = [
        {
            "name": str(item.get("name") or "unnamed"),
            "root": str(item.get("root") or ""),
            "store": item["store"],
        }
        for item in payload
        if isinstance(item, dict) and isinstance(item.get("store"), str) and item["store"]
    ]
    return entries, None


def register_project(events_path: Path, cwd: Optional[Path] = None, registry: Optional[Path] = None) -> None:
    """Upsert this project in the global registry. Atomic, failure-silent: the registry never blocks recording."""
    try:
        name, root = project_identity(cwd)
        path = registry or registry_path()
        entries, problem = read_registry(path)
        entry = {"name": name, "root": root, "store": str(events_path)}
        if problem is None and entry in entries:
            return
        position = next((index for index, item in enumerate(entries) if item["store"] == entry["store"]), None)
        if position is None:
            entries.append(entry)
        else:
            entries[position] = entry
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temp_name = tempfile.mkstemp(dir=str(path.parent), prefix=".projects-", suffix=".tmp")
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(entries, handle, ensure_ascii=True, indent=2, sort_keys=True)
                handle.write("\n")
            os.replace(temp_name, path)
        except BaseException:
            try:
                os.unlink(temp_name)
            except OSError:
                pass
            raise
    except Exception:
        pass


def tag_events(project: str, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Copy events with the project name attached and every identifier namespaced, so steps/runs never collide."""
    tagged: list[dict[str, Any]] = []
    for event in events:
        copy = dict(event)
        copy["project"] = project
        for field in ("step", "run_id", "candidate_id", "event_key"):
            if copy.get(field) is not None:
                copy[field] = f"{project}:{copy[field]}"
        tagged.append(copy)
    return tagged


def collect_all_events(
    registry: Path,
) -> tuple[list[dict[str, Any]], dict[str, Any], list[str], list[dict[str, Any]]]:
    """Read-only merge of every registered store that still exists."""
    entries, problem = read_registry(registry)
    notes = [f"registry {registry}: {problem}"] if problem else []
    if not entries and problem is None:
        notes.append(f"no projects registered yet ({registry}); a project registers on its first successful record")
    info = empty_store_info(registry, registry)
    info["metadata_path"] = None
    merged: list[dict[str, Any]] = []
    projects: list[dict[str, Any]] = []
    name_counts: Counter[str] = Counter()
    seen_stores: set[str] = set()
    for entry in entries:
        if entry["store"] in seen_stores:
            continue
        seen_stores.add(entry["store"])
        store = Path(entry["store"])
        if not store.is_file():
            notes.append(f"skipped {entry['name']}: store missing ({store})")
            continue
        try:
            events, store_info, _warnings = read_events(store)
        except OSError as error:
            notes.append(f"skipped {entry['name']}: store unreadable ({error})")
            continue
        if not events and store_info["malformed_lines"]:
            notes.append(f"skipped {entry['name']}: store corrupt ({store_info['malformed_lines']} malformed line(s), no valid events)")
            continue
        name_counts[entry["name"]] += 1
        name = entry["name"] if name_counts[entry["name"]] == 1 else f"{entry['name']}#{name_counts[entry['name']]}"
        for key in ("malformed_lines", "unknown_events", "future_schema_events"):
            info[key] += store_info[key]
        merged.extend(tag_events(name, events))
        projects.append({"name": name, "events": len(events)})
    merged.sort(key=lambda item: (item.get("ts", ""), item.get("event_key", "")))
    info["valid_events"] = len(merged)
    info["data_since"] = merged[0].get("ts") if merged else None
    return merged, info, notes, projects


def aggregate_all(registry: Optional[Path] = None) -> dict[str, Any]:
    events, info, notes, projects = collect_all_events(registry or registry_path())
    report = aggregate(events, info)
    report.pop("step_stats", None)  # per-step detail of N projects would only bloat the payload
    report["scope"] = "all"
    report["projects"] = projects
    report["notes"] = notes
    return report




def aggregate(events: list[dict[str, Any]], info: dict[str, Any]) -> dict[str, Any]:
    by_type: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for event in events:
        by_type[str(event["event"])].append(event)

    completed_steps = {str(event["step"]) for event in by_type["step_completed"]}
    coder_results = [event for event in by_type["worker_result"] if event.get("role") in {"coder", "coder_fast"}]
    coder_runs_by_step: dict[str, set[str]] = defaultdict(set)
    for event in coder_results:
        coder_runs_by_step[str(event.get("step"))].add(str(event.get("run_id")))
    product_steps = {step for step in completed_steps if coder_runs_by_step.get(step)}

    product_reviews = [
        event
        for event in by_type["worker_result"]
        if event.get("role") == "reviewer"
        and event.get("review_kind") == "product"
        and event.get("result") in {"approved", "changes_requested"}
    ]
    reviewer_rejections = [event for event in product_reviews if event.get("result") == "changes_requested"]
    tester_results = [
        event
        for event in by_type["worker_result"]
        if event.get("role") == "tester" and event.get("result") in {"qa_green", "bugs"}
    ]

    rejected_steps = {str(event.get("step")) for event in reviewer_rejections}
    bug_steps = {str(event.get("step")) for event in tester_results if event.get("result") == "bugs"}
    first_pass_steps = {
        step
        for step in product_steps
        if len(coder_runs_by_step[step]) == 1 and step not in rejected_steps and step not in bug_steps
    }

    approved_candidates = {
        str(event.get("candidate_id"))
        for event in product_reviews
        if event.get("result") == "approved" and event.get("candidate_id")
    }
    tester_candidates = {
        str(event.get("candidate_id")): event
        for event in tester_results
        if event.get("candidate_id") in approved_candidates
    }
    qa_escapes = [event for event in tester_candidates.values() if event.get("result") == "bugs"]

    architect_starts = [event for event in by_type["worker_started"] if event.get("role") == "architect"]
    escalated_steps = {
        str(event.get("step")) for event in architect_starts if event.get("mode") in {"design", "grilling"}
    } & product_steps
    advised_steps = {
        str(event.get("step")) for event in architect_starts if event.get("mode") == "advisory"
    } & product_steps

    starts_by_run = {str(event.get("run_id")): event for event in by_type["worker_started"] if event.get("run_id")}
    terminal_by_run: dict[str, dict[str, Any]] = {}
    for event_type in ("worker_result", "runtime_interruption", "model_failure"):
        for event in by_type[event_type]:
            run_id = event.get("run_id")
            if run_id and str(run_id) not in terminal_by_run:
                terminal_by_run[str(run_id)] = event

    worker_durations: list[int] = []
    worker_durations_by_role: dict[str, list[int]] = defaultdict(list)
    duration_by_run: dict[str, int] = {}
    for run_id, started in starts_by_run.items():
        terminal = terminal_by_run.get(run_id)
        start_ts = parse_ts(started.get("ts"))
        end_ts = parse_ts(terminal.get("ts")) if terminal else None
        if start_ts is None or end_ts is None or end_ts < start_ts:
            continue
        duration_ms = int((end_ts - start_ts).total_seconds() * 1000)
        duration_by_run[run_id] = duration_ms
        worker_durations.append(duration_ms)
        worker_durations_by_role[str(started.get("role", "unknown"))].append(duration_ms)

    step_starts: dict[str, datetime] = {}
    for event in by_type["step_started"]:
        parsed = parse_ts(event.get("ts"))
        step = str(event.get("step"))
        if parsed is not None and (step not in step_starts or parsed < step_starts[step]):
            step_starts[step] = parsed
    step_durations: list[int] = []
    for event in by_type["step_completed"]:
        step = str(event.get("step"))
        start = step_starts.get(step)
        end = parse_ts(event.get("ts"))
        if start is not None and end is not None and end >= start:
            step_durations.append(int((end - start).total_seconds() * 1000))

    failures = by_type["failure"]
    failure_categories = Counter(str(event.get("failure_category", "other")) for event in failures)
    detected_by = Counter(str(event.get("detected_by", "unknown")) for event in failures)
    repeated_incidents = len(by_type["retry_safeguard_triggered"])
    interruptions = by_type["runtime_interruption"]
    model_failures = by_type["model_failure"]
    dispatch_run_ids = set(starts_by_run) | {
        str(event.get("run_id")) for event in model_failures if event.get("run_id")
    }

    model_groups: dict[tuple[str, str, str], dict[str, Any]] = {}
    product_review_by_candidate: dict[str, dict[str, Any]] = {}
    for event in product_reviews:
        candidate_id = event.get("candidate_id")
        if candidate_id:
            product_review_by_candidate.setdefault(str(candidate_id), event)
    for run_id, started in starts_by_run.items():
        provider = started.get("provider")
        model = started.get("model")
        role = str(started.get("role", "unknown"))
        if not provider or not model:
            continue
        key = (role, str(provider), str(model))
        bucket = model_groups.setdefault(
            key,
            {"role": role, "provider": provider, "model": model, "runs": 0, "durations_ms": [], "first_review_approved": 0, "first_review_total": 0},
        )
        bucket["runs"] += 1
        if run_id in duration_by_run:
            bucket["durations_ms"].append(duration_by_run[run_id])
        if role in {"coder", "coder_fast"}:
            candidate = started.get("candidate_id") or run_id
            review = product_review_by_candidate.get(str(candidate))
            if review:
                bucket["first_review_total"] += 1
                if review.get("result") == "approved":
                    bucket["first_review_approved"] += 1
    model_samples: list[dict[str, Any]] = []
    for bucket in sorted(model_groups.values(), key=lambda item: (item["role"], item["provider"], item["model"])):
        durations = bucket.pop("durations_ms")
        total = bucket.pop("first_review_total")
        approved = bucket.pop("first_review_approved")
        bucket["median_duration_ms"] = median_or_none(durations)
        bucket["first_review_approval"] = ratio(approved, total)
        bucket["sample_warning"] = "small sample" if bucket["runs"] < 5 else None
        model_samples.append(bucket)

    latest_rating_by_step: dict[str, str] = {}
    for event in by_type["human_rating"]:
        latest_rating_by_step[str(event.get("step"))] = str(event.get("human_rating"))
    ratings = Counter(latest_rating_by_step.values())
    total_coder_attempts = sum(len(coder_runs_by_step[step]) for step in product_steps)
    summary = {
        "completed_steps": len(completed_steps),
        "completed_product_steps": len(product_steps),
        "first_pass_step_success": ratio(len(first_pass_steps), len(product_steps)),
        "average_coder_attempts": round(total_coder_attempts / len(product_steps), 2) if product_steps else None,
        "reviewer_rejection": ratio(len(reviewer_rejections), len(product_reviews)),
        "qa_escape": ratio(len(qa_escapes), len(tester_candidates)),
        "architect_escalation": ratio(len(escalated_steps), len(product_steps)),
        "advisor_usage": ratio(len(advised_steps), len(product_steps)),
        "repeated_failure_incidents": repeated_incidents,
        "runtime_interruption": ratio(len(interruptions), len(starts_by_run)),
        "model_failure": ratio(len(model_failures), len(dispatch_run_ids)),
        "median_step_duration_ms": median_or_none(step_durations),
        "median_worker_duration_ms": median_or_none(worker_durations),
    }

    starts_by_role: dict[str, list[dict[str, Any]]] = defaultdict(list)
    results_by_role: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for event in starts_by_run.values():
        starts_by_role[str(event.get("role", "unknown"))].append(event)
    for event in by_type["worker_result"]:
        results_by_role[str(event.get("role", "unknown"))].append(event)

    coder_candidate_ids = {
        str(event.get("candidate_id") or event.get("run_id"))
        for role_name in ("coder", "coder_fast")
        for event in starts_by_role[role_name]
        if event.get("candidate_id") or event.get("run_id")
    }
    coder_first_reviews = [
        review for candidate, review in product_review_by_candidate.items() if candidate in coder_candidate_ids
    ]
    role_stats: dict[str, dict[str, Any]] = {}
    for role in sorted(ROLES):
        starts = starts_by_role[role]
        results = results_by_role[role]
        if not starts and not results:
            continue
        result_counts = Counter(str(event.get("result")) for event in results if event.get("result"))
        stats: dict[str, Any] = {
            "runs": len(starts),
            "verified_results": len(results),
            "results": dict(sorted(result_counts.items())),
            "median_duration_ms": median_or_none(worker_durations_by_role.get(role, [])),
        }
        if role in {"coder", "coder_fast"}:
            stats["first_review_approval"] = ratio(
                sum(1 for event in coder_first_reviews if event.get("result") == "approved"),
                len(coder_first_reviews),
            )
        elif role == "reviewer":
            stats["product_rejection"] = summary["reviewer_rejection"]
        elif role == "tester":
            stats["qa_escape"] = summary["qa_escape"]
        elif role == "architect":
            stats["modes"] = dict(
                sorted(Counter(str(event.get("mode")) for event in starts if event.get("mode")).items())
            )
        role_stats[role] = stats

    step_ids = sorted(
        {
            str(event["step"])
            for event in events
            if event.get("step") is not None
        }
    )
    events_by_step: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for event in events:
        if event.get("step") is not None:
            events_by_step[str(event["step"])].append(event)
    step_stats: dict[str, dict[str, Any]] = {}
    for step in step_ids:
        step_events = events_by_step.get(step, [])
        started_events = [event for event in step_events if event.get("event") == "step_started"]
        completed_events = [event for event in step_events if event.get("event") == "step_completed"]
        started_event = started_events[0] if started_events else None
        completed_event = completed_events[-1] if completed_events else None
        start_ts = parse_ts(started_event.get("ts")) if started_event else None
        end_ts = parse_ts(completed_event.get("ts")) if completed_event else None
        step_duration_ms = (
            int((end_ts - start_ts).total_seconds() * 1000)
            if start_ts is not None and end_ts is not None and end_ts >= start_ts
            else None
        )

        step_reviews = [
            event
            for event in step_events
            if event.get("event") == "worker_result"
            and event.get("role") == "reviewer"
            and event.get("review_kind") == "product"
        ]
        step_qa = [
            event
            for event in step_events
            if event.get("event") == "worker_result" and event.get("role") == "tester"
        ]
        step_architect_starts = [
            event
            for event in step_events
            if event.get("event") == "worker_started" and event.get("role") == "architect"
        ]
        model_counts = Counter(
            (str(event.get("role")), str(event.get("provider")), str(event.get("model")))
            for event in step_events
            if event.get("event") == "worker_started"
            and event.get("role")
            and event.get("provider")
            and event.get("model")
        )
        step_stats[step] = {
            "status": "completed" if completed_event else ("in_progress" if started_event else "observed"),
            "started_at": started_event.get("ts") if started_event else None,
            "completed_at": completed_event.get("ts") if completed_event else None,
            "duration_ms": step_duration_ms,
            "coder_attempts": len(coder_runs_by_step.get(step, set())),
            "product_reviews": {
                "runs": len(step_reviews),
                "approved": sum(1 for event in step_reviews if event.get("result") == "approved"),
                "changes_requested": sum(
                    1 for event in step_reviews if event.get("result") == "changes_requested"
                ),
            },
            "qa_runs": {
                "runs": len(step_qa),
                "qa_green": sum(1 for event in step_qa if event.get("result") == "qa_green"),
                "bugs": sum(1 for event in step_qa if event.get("result") == "bugs"),
            },
            "architect_modes": dict(
                sorted(
                    Counter(
                        str(event.get("mode")) for event in step_architect_starts if event.get("mode")
                    ).items()
                )
            ),
            "failure_count": sum(1 for event in step_events if event.get("event") == "failure"),
            "runtime_interruptions": sum(
                1 for event in step_events if event.get("event") == "runtime_interruption"
            ),
            "gate_skips": dict(
                sorted(
                    Counter(
                        str(event.get("gate"))
                        for event in step_events
                        if event.get("event") == "gate_skipped" and event.get("gate")
                    ).items()
                )
            ),
            "human_rating": latest_rating_by_step.get(step),
            "models": [
                {"role": role, "provider": provider, "model": model, "runs": runs}
                for (role, provider, model), runs in sorted(model_counts.items())
            ],
        }

    by_profile: dict[str, dict[str, Any]] = {}
    for name in ("quick", "standard", "critical", "unlabeled"):
        by_profile[name] = {
            "completed_steps": 0,
            "coder_attempts": 0,
            "coder_retries": 0,
            "review_changes_requested": 0,
            "qa_bugs": 0,
            "median_step_duration_ms": None,
            "tokens": None,
            "worker_runs": 0,
        }
    profile_durations: dict[str, list[int]] = defaultdict(list)
    profile_tokens: dict[str, int] = defaultdict(int)
    profile_token_seen: dict[str, bool] = defaultdict(bool)
    for step, stats in step_stats.items():
        step_events = events_by_step.get(step, [])
        profile = "unlabeled"
        for event in step_events:
            if event.get("event") == "step_started" and event.get("pipeline_profile") in PIPELINE_PROFILES:
                profile = str(event["pipeline_profile"])
                break
        else:
            for event in step_events:
                if event.get("pipeline_profile") in PIPELINE_PROFILES:
                    profile = str(event["pipeline_profile"])
                    break
        bucket = by_profile[profile]
        if stats["status"] == "completed":
            bucket["completed_steps"] += 1
        bucket["coder_attempts"] += stats["coder_attempts"]
        bucket["coder_retries"] += max(0, stats["coder_attempts"] - 1)
        bucket["review_changes_requested"] += stats["product_reviews"]["changes_requested"]
        bucket["qa_bugs"] += stats["qa_runs"]["bugs"]
        bucket["worker_runs"] += sum(1 for event in step_events if event.get("event") == "worker_started")
        if isinstance(stats.get("duration_ms"), int):
            profile_durations[profile].append(stats["duration_ms"])
        for event in step_events:
            if isinstance(event.get("tokens"), int):
                profile_tokens[profile] += event["tokens"]
                profile_token_seen[profile] = True
        stats["pipeline_profile"] = profile
    for name, bucket in by_profile.items():
        bucket["median_step_duration_ms"] = median_or_none(profile_durations.get(name, []))
        bucket["tokens"] = profile_tokens[name] if profile_token_seen[name] else None

    fast_coder_analysis = analyze_fast_coder_attempts(events)
    leaderboard = build_leaderboard(
        events_by_type=by_type,
        step_stats=step_stats,
        starts_by_run=starts_by_run,
        duration_by_run=duration_by_run,
        product_reviews=product_reviews,
        product_review_by_candidate=product_review_by_candidate,
        tester_candidates=tester_candidates,
        tester_results=tester_results,
        fast_coder=fast_coder_analysis,
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": utc_now(),
        "scope": "project",
        "storage": info,
        "summary": summary,
        "failure_categories": dict(sorted(failure_categories.items())),
        "detected_by": dict(sorted(detected_by.items())),
        "role_stats": role_stats,
        "by_profile": by_profile,
        "step_stats": step_stats,
        "human_ratings": dict(sorted(ratings.items())),
        "model_samples": model_samples,
        "fast_coder": fast_coder_analysis,
        "leaderboard": leaderboard,
    }


def format_duration(value: Optional[int]) -> str:
    if value is None:
        return "n/a"
    seconds = value / 1000
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes = int(seconds // 60)
    return f"{minutes}m {seconds - minutes * 60:.1f}s"


def format_ratio(value: dict[str, Any]) -> str:
    rate = value.get("rate_pct")
    return f"n/a ({value['count']}/{value['total']})" if rate is None else f"{rate:.1f}% ({value['count']}/{value['total']})"


def format_report(report: dict[str, Any]) -> str:
    summary = report["summary"]
    storage = report["storage"]
    is_all = report.get("scope") == "all"
    projects = report.get("projects") or []
    lines = [
        f"Pavan's Workflow Metrics · All projects ({len(projects)} projects)" if is_all else "Pavan's Workflow Metrics",
    ]
    if is_all:
        lines.append("Projects: " + (", ".join(f"{item['name']} ({item['events']} events)" for item in projects) or "none"))
        lines.extend(f"Note: {note}" for note in report.get("notes") or [])
    lines += [
        f"Data since: {storage.get('data_since') or 'no events yet'}",
        f"Completed steps: {summary['completed_steps']} ({summary['completed_product_steps']} product)",
        f"First-pass step success: {format_ratio(summary['first_pass_step_success'])}",
        f"Average Coder attempts: {summary['average_coder_attempts'] if summary['average_coder_attempts'] is not None else 'n/a'}",
        f"Reviewer rejection: {format_ratio(summary['reviewer_rejection'])}",
        f"QA escape: {format_ratio(summary['qa_escape'])}",
        f"Architect escalation: {format_ratio(summary['architect_escalation'])}",
        f"Advisor usage: {format_ratio(summary['advisor_usage'])}",
        f"Repeated-failure incidents: {summary['repeated_failure_incidents']}",
        f"Runtime interruption: {format_ratio(summary['runtime_interruption'])}",
        f"Model/provider failure: {format_ratio(summary['model_failure'])}",
        f"Median step duration: {format_duration(summary['median_step_duration_ms'])}",
        f"Median worker duration: {format_duration(summary['median_worker_duration_ms'])}",
    ]
    categories = report["failure_categories"]
    lines.append("Failure categories: " + (", ".join(f"{key}={value}" for key, value in categories.items()) or "none"))
    detectors = report["detected_by"]
    lines.append("Detected by: " + (", ".join(f"{key}={value}" for key, value in detectors.items()) or "none"))
    ratings = report["human_ratings"]
    if ratings:
        lines.append("Human ratings: " + ", ".join(f"{key}={value}" for key, value in ratings.items()))
    if storage.get("malformed_lines"):
        lines.append(f"Warning: skipped {storage['malformed_lines']} malformed JSONL line(s)")
    if storage.get("unknown_events"):
        lines.append(f"Warning: ignored {storage['unknown_events']} unknown event type(s)")
    if storage.get("future_schema_events"):
        lines.append(f"Notice: read {storage['future_schema_events']} future-schema event(s) using known fields")
    lines.append(f"{'Registry' if is_all else 'Local store'}: {storage['events_path']}")
    profiles = report.get("by_profile") or {}
    profile_lines = []
    for name in ("quick", "standard", "critical", "unlabeled"):
        stats = profiles.get(name) or {}
        if not stats.get("completed_steps") and not stats.get("worker_runs"):
            continue
        tokens = "n/a tok" if stats.get("tokens") is None else f"{stats['tokens']} tok"
        profile_lines.append(
            f"{name}: {stats.get('completed_steps', 0)} steps, "
            f"{stats.get('coder_retries', 0)} retries, "
            f"{format_duration(stats.get('median_step_duration_ms'))}, {tokens}"
        )
    if profile_lines:
        lines.append("By pipeline profile: " + "; ".join(profile_lines))
    fast_coder = report.get("fast_coder") or {}
    by_model = fast_coder.get("by_model") or {}
    if by_model:
        items = []
        for model_name, stats in sorted(by_model.items()):
            rate = pct(stats["first_pass"], stats["resolved"])
            rate_text = f"{rate:.0f}%" if rate is not None else "n/a"
            items.append(
                f"{model_name}: {stats['first_pass']}/{stats['resolved']} first-pass "
                f"({rate_text}, {stats['attempts']} attempts, {stats['pending']} pending)"
            )
        lines.append("Fast Coder (by model): " + "; ".join(items))
    label = f"All projects · {len(report.get('projects') or [])} projects" if is_all else "This project"
    board = format_leaderboard(report.get("leaderboard") or {}, label)
    if board:
        lines.extend(["", *board])
    return "\n".join(lines)


def resolve_config_model(model_role: str, project_dir: Path | None = None) -> tuple[str | None, str | None]:
    try:
        if project_dir is None:
            project_dir = Path.cwd()
        config_path = project_dir / ".omp" / "config.yml"
        if not config_path.is_file():
            for parent in project_dir.parents:
                if (parent / ".omp" / "config.yml").is_file():
                    config_path = parent / ".omp" / "config.yml"
                    break
        if not config_path.is_file():
            return None, None

        text = config_path.read_text(encoding="utf-8")
        roles = {}
        inside = False
        for line in text.splitlines():
            if re.match(r"^modelRoles:[ \t]*(#.*)?$", line):
                inside = True
                continue
            if inside:
                if line.strip() and not line.startswith((" ", "\t")):
                    break
                m = re.match(r"^(?P<indent>[ \t]+)(?P<key>[A-Za-z0-9_.-]+):[ \t]*(?P<value>[^#]*?)[ \t]*(?:#.*)?$", line)
                if m and m.group("value"):
                    roles[m.group("key")] = m.group("value").strip().strip("\"'")

        curr = model_role
        seen = set()
        depth = 0
        val = roles.get(curr)
        while val and val.startswith("@") and depth < 5:
            depth += 1
            target = val[1:].split(":", 1)[0].strip()
            if target in seen:
                val = None
                break
            seen.add(target)
            curr = target
            val = roles.get(curr)

        if not val or val.startswith("@"):
            return None, None

        val = THINKING_SUFFIX.sub("", val).strip()
        if not val:
            return None, None
        provider = val.split("/", 1)[0] if "/" in val else None
        return val, provider
    except Exception:
        return None, None


def analyze_fast_coder_attempts(events: list[dict[str, Any]]) -> dict[str, Any]:
    attempts = []
    by_model: dict[str, dict[str, int]] = defaultdict(lambda: {"attempts": 0, "resolved": 0, "first_pass": 0, "pending": 0})
    totals = {"attempts": 0, "resolved": 0, "first_pass": 0, "pending": 0}

    fast_starts = [
        (idx, e) for idx, e in enumerate(events)
        if e.get("event") == "worker_started" and e.get("role") == "coder_fast"
    ]

    for idx, event in fast_starts:
        step = str(event.get("step"))
        run_id = str(event.get("run_id"))
        model = str(event.get("model") or "unknown")

        later_events = events[idx + 1:]
        has_later_coder_start = any(
            le.get("event") == "worker_started" and le.get("role") in {"coder", "coder_fast"} and str(le.get("step")) == step
            for le in later_events
        )
        has_step_completed = any(
            le.get("event") == "step_completed" and str(le.get("step")) == step
            for le in later_events
        )

        if has_later_coder_start:
            outcome = "resolved_failure"
        elif has_step_completed:
            outcome = "resolved_success"
        else:
            outcome = "pending"

        rec = {
            "step": step,
            "run_id": run_id,
            "model": model,
            "outcome": outcome,
            "ts": event.get("ts"),
        }
        attempts.append(rec)

        by_model[model]["attempts"] += 1
        totals["attempts"] += 1

        if outcome == "resolved_success":
            by_model[model]["resolved"] += 1
            by_model[model]["first_pass"] += 1
            totals["resolved"] += 1
            totals["first_pass"] += 1
        elif outcome == "resolved_failure":
            by_model[model]["resolved"] += 1
            totals["resolved"] += 1
        else:
            by_model[model]["pending"] += 1
            totals["pending"] += 1

    return {
        "by_model": dict(by_model),
        "totals": totals,
        "attempts": attempts,
    }


def event_from_args(args: argparse.Namespace) -> dict[str, Any]:
    event: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "ts": utc_now(),
        "event": args.event,
        "event_key": args.event_key,
    }
    for field in ALLOWED_FIELDS - {"schema_version", "ts", "event", "event_key"}:
        value = getattr(args, field, None)
        if value is not None:
            event[field] = value
    if event["event"] == "worker_started":
        role = event.get("role")
        if not event.get("model_role") and role:
            event["model_role"] = f"workflow_{role}"
        if not event.get("model") and event.get("model_role"):
            model_val, prov_val = resolve_config_model(event["model_role"])
            if model_val:
                event["model"] = model_val
            if prov_val and not event.get("provider"):
                event["provider"] = prov_val
    return event


def emit_warnings(warnings: Iterable[str]) -> None:
    for warning in warnings:
        print(f"WARN metrics: {warning}", file=sys.stderr)


def safe_store(args: argparse.Namespace) -> tuple[Path, Path]:
    return resolve_store(override=getattr(args, "path", None))


def command_record(args: argparse.Namespace) -> int:
    try:
        events_path, _metadata_path = safe_store(args)
        status, warnings = append_event(events_path, event_from_args(args))
        emit_warnings(warnings)
        if status in {"recorded", "duplicate_noop"}:
            register_project(events_path)
        print(f"metrics {status}: {args.event_key}")
    except Exception as error:  # observer failure must not control workflow
        print(f"WARN metrics unavailable: {error}", file=sys.stderr)
    return 0


def command_report(args: argparse.Namespace) -> int:
    try:
        if args.scope == "all":
            if args.path:
                raise MetricsError("--path applies to --scope project only")
            report = aggregate_all()
        else:
            events_path, _metadata_path = safe_store(args)
            events, info, warnings = read_events(events_path)
            emit_warnings(warnings)
            report = aggregate(events, info)
        print(json.dumps(report, ensure_ascii=True, sort_keys=True) if args.json else format_report(report))
    except Exception as error:
        print(f"WARN metrics unavailable: {error}", file=sys.stderr)
        if args.json:
            print(json.dumps({"schema_version": SCHEMA_VERSION, "available": False, "error": str(error)}))
        else:
            print("Pavan's Workflow Metrics\nMetrics unavailable; workflow execution is unaffected.")
    return 0


def command_validate(args: argparse.Namespace) -> int:
    try:
        events_path, _metadata_path = safe_store(args)
        events, info, warnings = read_events(events_path)
        emit_warnings(warnings)
        aggregate(events, info)
        print(
            f"metrics validate: OK valid={info['valid_events']} malformed={info['malformed_lines']} "
            f"future_schema={info['future_schema_events']} path={events_path}"
        )
        return 1 if args.strict and info["malformed_lines"] else 0
    except Exception as error:
        print(f"metrics validate: FAIL {error}", file=sys.stderr)
        return 1


def verify_reset_marker(metadata_path: Path) -> None:
    if not metadata_path.exists():
        raise MetricsError(f"refusing reset because telemetry metadata is missing: {metadata_path}")
    try:
        payload = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise MetricsError(f"refusing reset because telemetry metadata is invalid: {error}") from error
    if (
        not isinstance(payload, dict)
        or payload.get("schema_version") != SCHEMA_VERSION
        or parse_ts(payload.get("metrics_started_at")) is None
    ):
        raise MetricsError("refusing reset because the companion file is not recognized metrics metadata")


def command_reset(args: argparse.Namespace) -> int:
    if not args.yes:
        print("Refusing reset without --yes; only events.jsonl and its metrics metadata would be deleted.", file=sys.stderr)
        return 2
    try:
        events_path, metadata_path = safe_store(args)
        if not events_path.exists() and not metadata_path.exists():
            print("metrics reset: removed nothing (store already absent)")
            return 0
        verify_reset_marker(metadata_path)
        removed: list[str] = []
        for path in (events_path, metadata_path):
            if path.exists() or path.is_symlink():
                path.unlink()
                removed.append(str(path))
        print("metrics reset: removed " + ", ".join(removed))
        return 0
    except Exception as error:
        print(f"metrics reset: FAIL {error}", file=sys.stderr)
        return 1


def command_rate(args: argparse.Namespace) -> int:
    try:
        events_path, _metadata_path = safe_store(args)
        events, _info, _warnings = read_events(events_path)
        step = args.step
        if step is None:
            completed = [event for event in events if event.get("event") == "step_completed"]
            if not completed:
                raise MetricsError("no completed step is available; pass --step")
            step = str(completed[-1]["step"])
        event = {
            "schema_version": SCHEMA_VERSION,
            "ts": utc_now(),
            "event": "human_rating",
            "event_key": f"human_rating:{step}:{utc_now()}",
            "step": step,
            "human_rating": args.rating,
        }
        status, warnings = append_event(events_path, event)
        emit_warnings(warnings)
        if status in {"recorded", "duplicate_noop"}:
            register_project(events_path)
        print(f"metrics {status}: {args.rating} for {step}")
        return 0
    except Exception as error:
        print(f"WARN metrics unavailable: {error}", file=sys.stderr)
        return 0


def make_event(ts: str, event: str, key: str, **fields: Any) -> dict[str, Any]:
    value = {"schema_version": SCHEMA_VERSION, "ts": ts, "event": event, "event_key": key, **fields}
    validate_event(value)
    return value


def iso_at(minute: int, second: int = 0) -> str:
    return f"2026-08-10T10:{minute:02d}:{second:02d}.000Z"


def synthetic_events() -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    def add(event: str, key: str, minute: int, **fields: Any) -> None:
        events.append(make_event(iso_at(minute), event, key, **fields))

    # S1: perfect first pass.
    add("step_started", "step_started:S1", 0, step="S1", pipeline_profile="quick")
    add("worker_started", "worker_started:c1", 1, step="S1", run_id="c1", candidate_id="c1", role="coder", attempt=1, model_role="workflow_coder", provider="local", model="Luna", tokens=1200)
    add("worker_result", "worker_result:c1", 2, step="S1", run_id="c1", role="coder", attempt=1, result="waiting_review", evidence_ref="AI_Workflow_Kit/docs/AI/FEEDBACK.md")
    add("worker_started", "worker_started:r1", 3, step="S1", run_id="r1", role="reviewer", attempt=1)
    add("worker_result", "worker_result:r1", 4, step="S1", run_id="r1", candidate_id="c1", role="reviewer", result="approved", review_kind="product", evidence_ref="AI_Workflow_Kit/docs/AI/FEEDBACK.md")
    add("worker_started", "worker_started:t1", 5, step="S1", run_id="t1", role="tester", attempt=1)
    add("worker_result", "worker_result:t1", 6, step="S1", run_id="t1", candidate_id="c1", role="tester", result="qa_green", evidence_ref="AI_Workflow_Kit/docs/AI/REPORT.md")
    add("step_completed", "step_completed:S1", 7, step="S1")

    # S2: Reviewer catches a bug; second Coder candidate passes. Includes advisory Architect.
    add("step_started", "step_started:S2", 8, step="S2", pipeline_profile="standard")
    add("worker_started", "worker_started:a2", 9, step="S2", run_id="a2", role="architect", mode="advisory")
    add("worker_result", "worker_result:a2", 10, step="S2", run_id="a2", role="architect", result="advice_ready", evidence_ref="AI_Workflow_Kit/docs/AI/FEEDBACK.md")
    add("worker_started", "worker_started:c2a", 11, step="S2", run_id="c2a", candidate_id="c2a", role="coder", attempt=1)
    add("worker_result", "worker_result:c2a", 12, step="S2", run_id="c2a", role="coder", attempt=1, result="waiting_review", evidence_ref="AI_Workflow_Kit/docs/AI/FEEDBACK.md")
    add("worker_started", "worker_started:r2a", 13, step="S2", run_id="r2a", role="reviewer")
    add("worker_result", "worker_result:r2a", 14, step="S2", run_id="r2a", candidate_id="c2a", role="reviewer", result="changes_requested", review_kind="product", evidence_ref="AI_Workflow_Kit/docs/AI/FEEDBACK.md")
    add("failure", "failure:S2:c2a:reviewer", 15, step="S2", candidate_id="c2a", failure_category="incorrect_implementation", detected_by="reviewer", evidence_ref="AI_Workflow_Kit/docs/AI/FEEDBACK.md")
    add("worker_started", "worker_started:c2b", 16, step="S2", run_id="c2b", candidate_id="c2b", role="coder", attempt=2)
    add("worker_result", "worker_result:c2b", 17, step="S2", run_id="c2b", role="coder", attempt=2, result="waiting_review", evidence_ref="AI_Workflow_Kit/docs/AI/FEEDBACK.md")
    add("worker_started", "worker_started:r2b", 18, step="S2", run_id="r2b", role="reviewer")
    add("worker_result", "worker_result:r2b", 19, step="S2", run_id="r2b", candidate_id="c2b", role="reviewer", result="approved", review_kind="product", evidence_ref="AI_Workflow_Kit/docs/AI/FEEDBACK.md")
    add("worker_started", "worker_started:t2", 20, step="S2", run_id="t2", role="tester")
    add("worker_result", "worker_result:t2", 21, step="S2", run_id="t2", candidate_id="c2b", role="tester", result="qa_green", evidence_ref="AI_Workflow_Kit/docs/AI/REPORT.md")
    add("step_completed", "step_completed:S2", 22, step="S2")

    # S3: Reviewer-approved candidate escapes to QA, then a fixed candidate passes.
    add("step_started", "step_started:S3", 23, step="S3", pipeline_profile="critical")
    add("worker_started", "worker_started:c3a", 24, step="S3", run_id="c3a", candidate_id="c3a", role="coder", attempt=1)
    add("worker_result", "worker_result:c3a", 25, step="S3", run_id="c3a", role="coder", result="waiting_review", evidence_ref="AI_Workflow_Kit/docs/AI/FEEDBACK.md")
    add("worker_started", "worker_started:r3a", 26, step="S3", run_id="r3a", role="reviewer")
    add("worker_result", "worker_result:r3a", 27, step="S3", run_id="r3a", candidate_id="c3a", role="reviewer", result="approved", review_kind="product", evidence_ref="AI_Workflow_Kit/docs/AI/FEEDBACK.md")
    add("worker_started", "worker_started:t3a", 28, step="S3", run_id="t3a", role="tester")
    add("worker_result", "worker_result:t3a", 29, step="S3", run_id="t3a", candidate_id="c3a", role="tester", result="bugs", evidence_ref="AI_Workflow_Kit/docs/AI/BUG_REPORT.md")
    add("failure", "failure:S3:c3a:tester", 30, step="S3", candidate_id="c3a", failure_category="regression", detected_by="tester", evidence_ref="AI_Workflow_Kit/docs/AI/BUG_REPORT.md")
    add("worker_started", "worker_started:c3b", 31, step="S3", run_id="c3b", candidate_id="c3b", role="coder", attempt=2)
    add("worker_result", "worker_result:c3b", 32, step="S3", run_id="c3b", role="coder", attempt=2, result="waiting_review", evidence_ref="AI_Workflow_Kit/docs/AI/FEEDBACK.md")
    add("worker_started", "worker_started:r3b", 33, step="S3", run_id="r3b", role="reviewer")
    add("worker_result", "worker_result:r3b", 34, step="S3", run_id="r3b", candidate_id="c3b", role="reviewer", result="approved", review_kind="product", evidence_ref="AI_Workflow_Kit/docs/AI/FEEDBACK.md")
    add("worker_started", "worker_started:t3b", 35, step="S3", run_id="t3b", role="tester")
    add("worker_result", "worker_result:t3b", 36, step="S3", run_id="t3b", candidate_id="c3b", role="tester", result="qa_green", evidence_ref="AI_Workflow_Kit/docs/AI/REPORT.md")
    add("step_completed", "step_completed:S3", 37, step="S3")

    # S4: explicit Reviewer and QA skips do not enter either denominator.
    add("step_started", "step_started:S4", 38, step="S4")
    add("worker_started", "worker_started:c4", 39, step="S4", run_id="c4", candidate_id="c4", role="coder", attempt=1)
    add("worker_result", "worker_result:c4", 40, step="S4", run_id="c4", role="coder", result="waiting_review", evidence_ref="AI_Workflow_Kit/docs/AI/FEEDBACK.md")
    add("gate_skipped", "gate_skipped:S4:reviewer", 41, step="S4", gate="reviewer", evidence_ref="AI_Workflow_Kit/docs/AI/STATE.yaml")
    add("gate_skipped", "gate_skipped:S4:qa", 42, step="S4", gate="qa", evidence_ref="AI_Workflow_Kit/docs/AI/STATE.yaml")
    add("step_completed", "step_completed:S4", 43, step="S4")

    # S5: deep Architect, runtime interruption, model failure, targeted review, retry safeguard.
    add("step_started", "step_started:S5", 44, step="S5")
    add("worker_started", "worker_started:a5", 45, step="S5", run_id="a5", role="architect", mode="grilling")
    add("worker_result", "worker_result:a5", 46, step="S5", run_id="a5", role="architect", result="design_ready", evidence_ref="AI_Workflow_Kit/docs/DECISIONS.md")
    add("worker_started", "worker_started:c5dead", 47, step="S5", run_id="c5dead", role="coder", attempt=1)
    add("runtime_interruption", "runtime_interruption:c5dead:partial", 48, step="S5", run_id="c5dead", role="coder", classification="interrupted_partial", evidence_ref="AI_Workflow_Kit/docs/AI/FEEDBACK.md")
    add("model_failure", "model_failure:r5dead", 49, step="S5", run_id="r5dead", role="reviewer", status="awaiting_human", provider="example", model="offline", evidence_ref="AI_Workflow_Kit/docs/AI/STATE.yaml")
    add("worker_started", "worker_started:c5", 50, step="S5", run_id="c5", candidate_id="c5", role="coder", attempt=1)
    add("worker_result", "worker_result:c5", 51, step="S5", run_id="c5", role="coder", result="waiting_review", evidence_ref="AI_Workflow_Kit/docs/AI/FEEDBACK.md")
    add("worker_started", "worker_started:r5", 52, step="S5", run_id="r5", role="reviewer")
    add("worker_result", "worker_result:r5", 53, step="S5", run_id="r5", candidate_id="c5", role="reviewer", result="approved", review_kind="product", evidence_ref="AI_Workflow_Kit/docs/AI/FEEDBACK.md")
    add("worker_started", "worker_started:t5", 54, step="S5", run_id="t5", role="tester")
    add("worker_result", "worker_result:t5", 55, step="S5", run_id="t5", candidate_id="c5", role="tester", result="qa_green", evidence_ref="AI_Workflow_Kit/docs/AI/REPORT.md")
    add("worker_started", "worker_started:r5targeted", 56, step="S5", run_id="r5targeted", role="reviewer")
    add("worker_result", "worker_result:r5targeted", 57, step="S5", run_id="r5targeted", candidate_id="c5", role="reviewer", result="changes_requested", review_kind="test_diff", evidence_ref="AI_Workflow_Kit/docs/AI/FEEDBACK.md")
    add("retry_safeguard_triggered", "retry_safeguard:S5:signature1", 58, step="S5", repeat_count=3, threshold=3, evidence_ref="AI_Workflow_Kit/docs/AI/FEEDBACK.md")
    add("step_completed", "step_completed:S5", 59, step="S5")
    return events


def assert_equal(label: str, actual: Any, expected: Any) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")



LB_OPUS = "anthropic/claude-opus-5"
LB_GROK = "xai/grok-4"
LB_GEMINI = "google/gemini-3-pro"
LB_SONNET = "anthropic/claude-sonnet-5"
LB_FLASH = "google/gemini-flash"
LB_REVIEWER = "openai/gpt-5"
LB_TESTER = "deepseek/deepseek-v4"
LB_FEEDBACK = "AI_Workflow_Kit/docs/AI/FEEDBACK.md"
LB_REPORT = "AI_Workflow_Kit/docs/AI/REPORT.md"


def lb_iso(seconds: int) -> str:
    moment = datetime(2026, 8, 11, tzinfo=timezone.utc) + timedelta(seconds=seconds)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def lb_attempt(
    model: Optional[str], review: Optional[str], qa: Optional[str] = None,
    secs: int = 40, tokens: Optional[int] = None, role: str = "coder",
) -> dict[str, Any]:
    return {"model": model, "review": review, "qa": qa, "secs": secs, "tokens": tokens, "role": role}


def lb_model(model: Optional[str]) -> dict[str, Any]:
    return {"provider": model.split("/", 1)[0], "model": model} if model else {}


def lb_step(
    step: str, t0: int, *, orchestrator: Iterable[str] = (), humans: Iterable[str] = (),
    attempts: Iterable[dict[str, Any]] = (), failure: Optional[str] = None, rating: Optional[str] = None,
    reviewer_failure: bool = False, length: Optional[int] = None,
) -> list[dict[str, Any]]:
    """One synthetic step. Attempt k starts at t0+10+90k: Coder, Reviewer at +45 (15 s), Tester at +65 (20 s)."""
    events: list[dict[str, Any]] = []
    attempts = list(attempts)

    def add(offset: int, event: str, key: str, **fields: Any) -> None:
        events.append(make_event(lb_iso(t0 + offset), event, key, **fields))

    add(0, "step_started", f"step_started:{step}", step=step)
    for index, model in enumerate(orchestrator):
        add(1 + index, "orchestrator_model", f"orchestrator_model:{step}:{model}", step=step, model=model)
    for index, model in enumerate(humans):
        add(3 + index, "human_turn", f"human_turn:{step}:{index}", step=step, model=model)
    for index, attempt in enumerate(attempts):
        base = 10 + 90 * index
        run = f"{step}c{index}"
        role = attempt["role"]
        add(base, "worker_started", f"worker_started:{run}", step=step, run_id=run, candidate_id=run, role=role, attempt=index + 1, **lb_model(attempt["model"]))
        result_fields = {"tokens": attempt["tokens"]} if attempt["tokens"] is not None else {}
        add(base + attempt["secs"], "worker_result", f"worker_result:{run}", step=step, run_id=run, role=role, attempt=index + 1, result="waiting_review", evidence_ref=LB_FEEDBACK, **result_fields)
        if attempt["review"]:
            reviewer_run = f"{step}r{index}"
            add(base + 45, "worker_started", f"worker_started:{reviewer_run}", step=step, run_id=reviewer_run, role="reviewer", **lb_model(LB_REVIEWER))
            add(base + 60, "worker_result", f"worker_result:{reviewer_run}", step=step, run_id=reviewer_run, candidate_id=run, role="reviewer", result=attempt["review"], review_kind="product", evidence_ref=LB_FEEDBACK)
            if attempt["review"] == "approved" and attempt["qa"]:
                tester_run = f"{step}t{index}"
                add(base + 65, "worker_started", f"worker_started:{tester_run}", step=step, run_id=tester_run, role="tester", **lb_model(LB_TESTER))
                add(base + 85, "worker_result", f"worker_result:{tester_run}", step=step, run_id=tester_run, candidate_id=run, role="tester", result=attempt["qa"], evidence_ref=LB_REPORT)
    end = length if length is not None else 10 + 90 * len(attempts) + 10
    if reviewer_failure:
        failed_run = f"{step}rx"
        add(end - 12, "worker_started", f"worker_started:{failed_run}", step=step, run_id=failed_run, role="reviewer", **lb_model(LB_REVIEWER))
        add(end - 7, "model_failure", f"model_failure:{failed_run}", step=step, run_id=failed_run, role="reviewer", status="auto_failover", **lb_model(LB_REVIEWER))
    if failure:
        add(end - 2, "failure", f"failure:{step}", step=step, failure_category=failure, detected_by="reviewer", evidence_ref=LB_FEEDBACK)
    add(end, "step_completed", f"step_completed:{step}", step=step)
    if rating:
        add(end + 1, "human_rating", f"human_rating:{step}", step=step, human_rating=rating)
    return events


def lb_alpha_events() -> list[dict[str, Any]]:
    sonnet = lambda review, qa=None, **kw: lb_attempt(LB_SONNET, review, qa, **kw)  # noqa: E731
    return [
        *lb_step("S1", 0, orchestrator=[LB_OPUS], humans=[LB_OPUS], attempts=[sonnet("approved", "qa_green", tokens=1000)], rating="good"),
        *lb_step("S2", 1000, orchestrator=[LB_OPUS], humans=[LB_OPUS], attempts=[sonnet("approved", "qa_green", tokens=3000)], reviewer_failure=True, rating="good"),
        *lb_step("S3", 2000, orchestrator=[LB_OPUS], humans=[LB_OPUS], attempts=[sonnet("approved", "bugs"), sonnet("approved", "qa_green")], failure="regression"),
        *lb_step("S4", 3000, orchestrator=[LB_OPUS], humans=[LB_OPUS, LB_OPUS], attempts=[sonnet("approved", "qa_green", secs=44)], rating="overkill"),
        *lb_step("S5", 4000, orchestrator=[LB_OPUS], attempts=[sonnet("changes_requested"), sonnet("approved", "qa_green")], failure="missed_requirement"),
        *lb_step("MIX1", 5000, orchestrator=[LB_OPUS, LB_GROK], humans=[LB_OPUS, LB_GROK], length=100),
        *lb_step("UN1", 6000, attempts=[lb_attempt(None, None)]),
    ]


def lb_beta_events() -> list[dict[str, Any]]:
    fast = lambda review, qa=None: lb_attempt(LB_FLASH, review, qa, secs=20, role="coder_fast")  # noqa: E731
    return [
        # Same step ids as alpha on purpose: --scope all must namespace them per project.
        *lb_step("S1", 0, orchestrator=[LB_GROK], humans=[LB_GROK, LB_GROK], attempts=[fast("approved", "qa_green")]),
        *lb_step("S2", 1000, orchestrator=[LB_GROK], humans=[LB_GROK], attempts=[fast("changes_requested"), lb_attempt(LB_SONNET, "approved", "qa_green", secs=44)]),
        *lb_step("S3", 2000, orchestrator=[LB_GROK], humans=[LB_GROK, LB_GROK], attempts=[fast("approved", "qa_green")]),
        *lb_step("S4", 3000, orchestrator=[LB_GROK], humans=[LB_GROK], attempts=[fast("approved", "qa_green")]),
        *lb_step("S5", 4000, orchestrator=[LB_GROK], humans=[LB_GROK, LB_GROK], attempts=[fast("approved", "qa_green")]),
        *lb_step("LOW1", 5000, orchestrator=[LB_GEMINI], humans=[LB_GEMINI], length=100),
    ]


def lb_model_entry(report: dict[str, Any], role: str, model: str) -> dict[str, Any]:
    return next(entry for entry in report["leaderboard"]["roles"][role]["models"] if entry["model"] == model)


def lb_init_repo(path: Path) -> Path:
    path.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(path)], check=True, stdout=subprocess.DEVNULL)
    events_path, _metadata = resolve_store(path)
    return events_path


def leaderboard_selftest(cases: list[str]) -> str:
    # Event types, validation, identity helpers.
    for bad, fields in (("human_turn", {"step": "S1"}), ("orchestrator_model", {"model": LB_OPUS})):
        try:
            make_event(iso_at(0), bad, f"{bad}:bad", **fields)
        except MetricsError:
            pass
        else:
            raise AssertionError(f"Q {bad} without its required fields was accepted")
    make_event(iso_at(0), "human_turn", "human_turn:ok", step="S1", model="anthropic/claude-sonnet-4@20250514:high")
    assert_equal("Q model_key strips effort", model_key({"model": "anthropic/claude-opus-5:high"}), "anthropic/claude-opus-5")
    assert_equal("Q model_key provider prefix", model_key({"provider": "local", "model": "Luna"}), "local/Luna")
    assert_equal("Q model_key unknown", model_key({}), "unknown")
    cases.append("Q human_turn/orchestrator_model validation and model identity")

    def table(better: str) -> list[dict[str, Any]]:
        return finish_model_table(
            [
                {"model": "m-90", "runs": 10, "primary": primary_metric("x", better, "pct", 9, 10)},
                {"model": "m-100-low", "runs": 2, "primary": primary_metric("x", better, "pct", 2, 2)},
                {"model": "m-80", "runs": 10, "primary": primary_metric("x", better, "pct", 8, 10)},
                {"model": "m-90-big", "runs": 20, "primary": primary_metric("x", better, "pct", 18, 20)},
            ],
            ("x", better),
        )

    higher = table("higher")
    assert_equal("R higher-is-better order", [(entry["model"], entry["rank"]) for entry in higher], [("m-90-big", 1), ("m-90", 2), ("m-80", 3), ("m-100-low", None)])
    assert_equal("R low-sample flag", [entry["low_sample"] for entry in higher], [False, False, False, True])
    lower = table("lower")
    assert_equal("R lower-is-better order", [(entry["model"], entry["rank"]) for entry in lower], [("m-80", 1), ("m-90-big", 2), ("m-90", 3), ("m-100-low", None)])
    cases.append("R ranking direction, tie-break by samples, low-sample exclusion")

    with tempfile.TemporaryDirectory(prefix="pavans-workflow-leaderboard-") as temp_dir:
        root = Path(temp_dir)
        state_home = root / "state"
        alpha_events, beta_events = lb_alpha_events(), lb_beta_events()
        previous_state = os.environ.get("XDG_STATE_HOME")
        os.environ["XDG_STATE_HOME"] = str(state_home)
        try:
            repos = {name: root / "repos" / name for name in ("alpha", "beta")}
            stores = {name: lb_init_repo(path) for name, path in repos.items()}
            for name, fixture in (("alpha", alpha_events), ("beta", beta_events)):
                for event in fixture:
                    assert_equal("S fixture append", append_event(stores[name], event)[0], "recorded")
                register_project(stores[name], repos[name])
            registry = state_home / "pavans-workflow" / "projects.json"
            assert_equal("S registry path", registry_path(), registry)
            before = registry.read_bytes()
            register_project(stores["alpha"], repos["alpha"])
            assert_equal("S registry upsert is idempotent", registry.read_bytes(), before)
            assert_equal("S registry entries", [(item["name"], item["store"]) for item in json.loads(before)], [("alpha", str(stores["alpha"])), ("beta", str(stores["beta"]))])
            cases.append("S project registry upsert under temp XDG_STATE_HOME")

            # Project scope: alpha alone.
            events, info, _warnings = read_events(stores["alpha"])
            alpha = aggregate(events, info)
            assert_equal("T alpha scope", alpha["scope"], "project")
            orchestrator = alpha["leaderboard"]["roles"]["orchestrator"]
            assert_equal("T mixed steps counted", (orchestrator["attributed_steps"], orchestrator["mixed_steps"], orchestrator["unattributed_steps"]), (5, 1, 1))
            assert_equal("T mixed model not listed", [entry["model"] for entry in orchestrator["models"]], [LB_OPUS])
            opus = lb_model_entry(alpha, "orchestrator", LB_OPUS)
            assert_equal("T opus human msgs/step", (opus["primary"]["value"], opus["primary"]["count"], opus["primary"]["total"], opus["rank"]), (1.0, 5, 5, 1))
            assert_equal("T opus retries/step", opus["coder_retries_per_step"], 0.4)
            assert_equal("T opus missed requirement/step", opus["missed_requirements_per_step"], 0.2)
            assert_equal("T opus median step", opus["median_step_duration_ms"], 110_000)
            assert_equal("T opus ratings", opus["human_ratings"], {"good": 2, "overkill": 1})
            cases.append("T orchestrator attribution: single Main model per step, mixed/unattributed counted, five metrics")

            sonnet = lb_model_entry(alpha, "coder", LB_SONNET)
            assert_equal("U coder first-review", (sonnet["primary"]["count"], sonnet["primary"]["total"], sonnet["primary"]["value"], sonnet["rank"]), (6, 7, 85.7, 1))
            assert_equal("U coder tokens/run", (sonnet["tokens_per_run"], sonnet["token_runs"]), (2000, 2))
            assert_equal("U coder median", sonnet["median_duration_ms"], 40_000)
            unknown_coder = lb_model_entry(alpha, "coder", "unknown")
            assert_equal("U unmodelled coder", (unknown_coder["runs"], unknown_coder["n"], unknown_coder["rank"], unknown_coder["low_sample"]), (1, 0, None, True))
            reviewer = lb_model_entry(alpha, "reviewer", LB_REVIEWER)
            assert_equal("U reviewer QA escape", (reviewer["primary"]["count"], reviewer["primary"]["total"], reviewer["primary"]["value"], reviewer["rank"]), (1, 6, 16.7, 1))
            assert_equal("U reviewer median", reviewer["median_duration_ms"], 15_000)
            assert_equal("U reviewer model failure", reviewer["model_failure"], ratio(1, 8))
            tester = lb_model_entry(alpha, "tester", LB_TESTER)
            assert_equal("U tester", (tester["runs"], tester["bugs_found"], tester["median_duration_ms"], tester["rank"], tester["primary"]), (6, ratio(1, 6), 20_000, None, None))
            assert_equal("U matches summary QA escape", alpha["summary"]["qa_escape"], ratio(1, 6))
            cases.append("U coder first-review, reviewer QA escape, tester bugs-found, tokens, medians, reliability")

            # Project scope: beta alone shows low-sample handling.
            events, info, _warnings = read_events(stores["beta"])
            beta = aggregate(events, info)
            gemini = lb_model_entry(beta, "orchestrator", LB_GEMINI)
            assert_equal("V low-sample orchestrator", (gemini["n"], gemini["low_sample"], gemini["rank"]), (1, True, None))
            assert_equal("V low-sample coder", (lb_model_entry(beta, "coder", LB_SONNET)["rank"], lb_model_entry(beta, "coder", LB_SONNET)["low_sample"]), (None, True))
            flash = lb_model_entry(beta, "coder_fast", LB_FLASH)
            assert_equal("V fast coder first-review", (flash["primary"]["count"], flash["primary"]["total"], flash["rank"]), (4, 5, 1))
            assert_equal("V fast coder first-pass", flash["first_pass"], ratio(4, 5))
            assert_equal("V fast coder median", flash["median_duration_ms"], 20_000)
            assert_equal("V beta fast_coder section agrees", beta["fast_coder"]["totals"]["first_pass"], 4)
            assert_equal("V beta reviewer", (lb_model_entry(beta, "reviewer", LB_REVIEWER)["primary"]["value"], lb_model_entry(beta, "reviewer", LB_REVIEWER)["rank"]), (0.0, 1))
            assert "Fast Coder (by model)" in format_report(beta)
            cases.append("V low-sample models shown with n but not ranked; fast first-pass")

            # Scope all: same step/run ids in both projects must not collide.
            combined = aggregate_all()
            assert_equal("W scope", combined["scope"], "all")
            assert_equal("W projects", combined["projects"], [{"name": "alpha", "events": len(alpha_events)}, {"name": "beta", "events": len(beta_events)}])
            assert_equal("W notes", combined["notes"], [])
            assert_equal("W no per-step payload", "step_stats" in combined, False)
            assert_equal("W completed steps", combined["summary"]["completed_steps"], 13)
            all_orchestrator = combined["leaderboard"]["roles"]["orchestrator"]
            assert_equal("W orchestrator counts", (all_orchestrator["attributed_steps"], all_orchestrator["mixed_steps"], all_orchestrator["unattributed_steps"]), (11, 1, 1))
            assert_equal("W orchestrator ranking", [(entry["model"], entry["rank"], entry["primary"]["value"]) for entry in all_orchestrator["models"]], [(LB_OPUS, 1, 1.0), (LB_GROK, 2, 1.6), (LB_GEMINI, None, 1.0)])
            assert_equal("W grok retries/missed", (lb_model_entry(combined, "orchestrator", LB_GROK)["coder_retries_per_step"], lb_model_entry(combined, "orchestrator", LB_GROK)["missed_requirements_per_step"]), (0.2, 0.0))
            all_sonnet = lb_model_entry(combined, "coder", LB_SONNET)
            assert_equal("W coder summed", (all_sonnet["runs"], all_sonnet["primary"]["count"], all_sonnet["primary"]["total"], all_sonnet["primary"]["value"]), (8, 7, 8, 87.5))
            all_reviewer = lb_model_entry(combined, "reviewer", LB_REVIEWER)
            assert_equal("W reviewer summed", (all_reviewer["runs"], all_reviewer["primary"]["count"], all_reviewer["primary"]["total"], all_reviewer["primary"]["value"], all_reviewer["model_failure"]), (14, 1, 11, 9.1, ratio(1, 14)))
            all_tester = lb_model_entry(combined, "tester", LB_TESTER)
            assert_equal("W tester summed", (all_tester["runs"], all_tester["bugs_found"]), (11, ratio(1, 11)))
            assert_equal("W flash unchanged", lb_model_entry(combined, "coder_fast", LB_FLASH)["first_pass"], ratio(4, 5))
            assert_equal("W summary QA escape", combined["summary"]["qa_escape"], ratio(1, 11))
            text = format_report(combined)
            for expected in (
                "All projects · 2 projects",
                "Projects: alpha (", "beta (",
                f"1. {LB_OPUS} · 1.00 msgs/step (5 msgs, 5 steps)",
                f"2. {LB_GROK} · 1.60 msgs/step (8 msgs, 5 steps)",
                f"- {LB_GEMINI} · 1.00 msgs/step (1 msg, 1 step) · n=1 · low sample",
                "11 steps attributed, 1 mixed (excluded), 1 unattributed",
            ):
                assert expected in text, f"W text report lacks {expected!r}"
            cli = subprocess.run(
                [sys.executable, str(Path(__file__).resolve()), "report", "--scope", "all", "--json"],
                env={**os.environ, "XDG_STATE_HOME": str(state_home)}, capture_output=True, text=True, check=True,
            )
            assert_equal("W CLI projects", [item["name"] for item in json.loads(cli.stdout)["projects"]], ["alpha", "beta"])
            cases.append("W report --scope all: two temp stores + registry, ids namespaced, sums and ranks match")

            # Recorder CLI registers its project and accepts the new events (non-blocking on invalid input).
            gamma = root / "repos" / "gamma"
            lb_init_repo(gamma)
            recorder = [sys.executable, str(Path(__file__).resolve()), "record"]
            env = {**os.environ, "XDG_STATE_HOME": str(state_home)}
            done = subprocess.run([*recorder, "human_turn", "--event-key", "human_turn:S1:1", "--step", "S1", "--model", f"{LB_OPUS}:high"], cwd=gamma, env=env, capture_output=True, text=True, check=True)
            assert "recorded" in done.stdout, done.stdout
            bad = subprocess.run([*recorder, "orchestrator_model", "--event-key", "orchestrator_model:bad", "--model", LB_OPUS], cwd=gamma, env=env, capture_output=True, text=True)
            assert_equal("X invalid event never fails the recorder", bad.returncode, 0)
            assert "WARN metrics unavailable" in bad.stderr, bad.stderr
            names = [item["name"] for item in read_registry(registry)[0]]
            assert_equal("X recorder upserts project", names, ["alpha", "beta", "gamma"])
            gamma_events, _info, _warnings = read_events(resolve_store(gamma)[0])
            assert_equal("X one valid event stored", [(item["event"], item["model"]) for item in gamma_events], [("human_turn", f"{LB_OPUS}:high")])
            cases.append("X recorder registers the project; new events record, invalid ones warn and exit 0")

            # Missing/corrupt stores are skipped with a note; same-named projects stay distinct.
            corrupt = root / "repos" / "corrupt"
            corrupt_store = lb_init_repo(corrupt)
            corrupt_store.parent.mkdir(parents=True, exist_ok=True)
            corrupt_store.write_text("not json\n{broken\n", encoding="utf-8")
            register_project(corrupt_store, corrupt)
            vanished = root / "repos" / "vanished"
            vanished_store = lb_init_repo(vanished)
            register_project(vanished_store, vanished)
            twin_store = lb_init_repo(root / "other" / "alpha")
            append_event(twin_store, make_event(lb_iso(0), "step_started", "step_started:T1", step="T1"))
            register_project(twin_store, root / "other" / "alpha")
            skipped = aggregate_all()
            assert_equal("Y projects", [item["name"] for item in skipped["projects"]], ["alpha", "beta", "gamma", "alpha#2"])
            assert_equal("Y notes", [note.split(":")[0] for note in skipped["notes"]], ["skipped corrupt", "skipped vanished"])
            assert_equal("Y leaderboard unaffected by skips", lb_model_entry(skipped, "reviewer", LB_REVIEWER)["primary"]["total"], 11)
            registry.write_text("{not json", encoding="utf-8")
            broken = aggregate_all()
            assert_equal("Y corrupt registry", (broken["projects"], "unreadable" in broken["notes"][0]), ([], True))
            register_project(stores["alpha"], repos["alpha"])
            assert_equal("Y registry heals on next record", [item["name"] for item in read_registry(registry)[0]], ["alpha"])
            cases.append("Y missing/corrupt stores and registry skipped with notes; duplicate names disambiguated")
        finally:
            if previous_state is None:
                os.environ.pop("XDG_STATE_HOME", None)
            else:
                os.environ["XDG_STATE_HOME"] = previous_state
        return text


def command_selftest(_args: argparse.Namespace) -> int:
    cases: list[str] = []
    with tempfile.TemporaryDirectory(prefix="pavans-workflow-metrics-") as temp_dir:
        events_path = Path(temp_dir) / "events.jsonl"
        fixture = synthetic_events()
        for event in fixture:
            status, _warnings = append_event(events_path, event)
            assert_equal("fixture append", status, "recorded")
        events, info, _warnings = read_events(events_path)
        report = aggregate(events, info)
        summary = report["summary"]

        assert_equal("A first-pass count", summary["first_pass_step_success"], ratio(3, 5))
        cases.append("A perfect first pass")
        assert_equal("B reviewer rejection", summary["reviewer_rejection"], ratio(1, 6))
        cases.append("B Reviewer catches bug")
        assert_equal("C QA escape", summary["qa_escape"], ratio(1, 5))
        cases.append("C Reviewer escape to Tester")
        assert_equal("D Reviewer skip denominator", summary["reviewer_rejection"]["total"], 6)
        cases.append("D Reviewer skip excluded")
        assert_equal("E QA skip denominator", summary["qa_escape"]["total"], 5)
        cases.append("E QA skip excluded")
        assert_equal("F runtime interruption", summary["runtime_interruption"]["count"], 1)
        assert_equal("F coder attempts", summary["average_coder_attempts"], 1.4)
        cases.append("F runtime interruption isolated")
        assert_equal("G model failure", summary["model_failure"]["count"], 1)
        assert_equal("G failure taxonomy", sum(report["failure_categories"].values()), 2)
        cases.append("G model failure isolated")
        assert_equal("H advisor", summary["advisor_usage"], ratio(1, 5))
        cases.append("H advisory Architect")
        assert_equal("I deep Architect", summary["architect_escalation"], ratio(1, 5))
        cases.append("I deep Architect")
        assert_equal("J targeted review excluded", summary["reviewer_rejection"]["count"], 1)
        cases.append("J targeted test-diff review excluded")

        assert_equal("M Coder runs", report["role_stats"]["coder"]["runs"], 8)
        assert_equal("M Coder verified results", report["role_stats"]["coder"]["verified_results"], 7)
        assert_equal("M Coder first review", report["role_stats"]["coder"]["first_review_approval"], ratio(5, 6))
        assert_equal("M Reviewer product rejection", report["role_stats"]["reviewer"]["product_rejection"], ratio(1, 6))
        cases.append("M canonical per-role statistics")

        assert_equal("N S3 coder attempts", report["step_stats"]["S3"]["coder_attempts"], 2)
        assert_equal("N S3 reviews", report["step_stats"]["S3"]["product_reviews"]["runs"], 2)
        assert_equal("N S3 QA bugs", report["step_stats"]["S3"]["qa_runs"]["bugs"], 1)
        assert_equal("N S3 failures", report["step_stats"]["S3"]["failure_count"], 1)
        assert_equal("N S4 QA skip", report["step_stats"]["S4"]["gate_skips"]["qa"], 1)
        cases.append("N canonical per-step statistics")

        assert_equal("P quick completed", report["by_profile"]["quick"]["completed_steps"], 1)
        assert_equal("P quick retries", report["by_profile"]["quick"]["coder_retries"], 0)
        assert_equal("P quick tokens", report["by_profile"]["quick"]["tokens"], 1200)
        assert_equal("P standard retries", report["by_profile"]["standard"]["coder_retries"], 1)
        assert_equal("P critical retries", report["by_profile"]["critical"]["coder_retries"], 1)
        assert_equal("P unlabeled completed", report["by_profile"]["unlabeled"]["completed_steps"], 2)
        cases.append("P pipeline profile grouping")

        duplicate = dict(fixture[0])
        duplicate["ts"] = iso_at(59, 30)
        duplicate_status, _ = append_event(events_path, duplicate)
        assert_equal("K duplicate status", duplicate_status, "duplicate_noop")
        reread, _reread_info, _warnings = read_events(events_path)
        assert_equal("K duplicate count", len(reread), len(fixture))
        cases.append("K duplicate event idempotent")

        conflicting = dict(fixture[0])
        conflicting["step"] = "S-CONFLICT"
        conflict_status, conflict_warnings = append_event(events_path, conflicting)
        assert_equal("K conflicting duplicate status", conflict_status, "duplicate_conflict")
        if not conflict_warnings:
            raise AssertionError("K conflicting duplicate did not produce a warning")

        future = make_event(iso_at(59, 40), "step_started", "step_started:S-FUTURE", step="S-FUTURE")
        future["schema_version"] = 2
        future["future_optional_field"] = "ignored"
        with events_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(future, separators=(",", ":")) + "\n")
        future_events, future_info, _warnings = read_events(events_path)
        assert_equal("K future event accepted", len(future_events), len(fixture) + 1)
        assert_equal("K future schema count", future_info["future_schema_events"], 1)

        with events_path.open("a", encoding="utf-8") as handle:
            handle.write('{"schema_version":1,"event":"broken"\n')
        recovered, recovered_info, recovered_warnings = read_events(events_path)
        assert_equal("L valid recovery", len(recovered), len(fixture) + 1)
        assert_equal("L malformed count", recovered_info["malformed_lines"], 1)
        if not recovered_warnings:
            raise AssertionError("L malformed line did not produce a warning")
        cases.append("L malformed trailing JSONL recovered")

        leaderboard_text = leaderboard_selftest(cases)

        print(f"workflow metrics selftest: PASS ({len(cases)} cases)")
        for case in cases:
            print(f"  PASS {case}")
        print("\nSynthetic five-step report:\n")
        print(format_report(report))
        print("\nTwo-project leaderboard report (report --scope all):\n")
        print(leaderboard_text)
    return 0


def command_self_check(args: argparse.Namespace) -> int:
    try:
        events_path, metadata_path = safe_store(args)
        print(f"metrics runtime: python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")
        print(f"metrics storage: {events_path}")
        print(f"metrics metadata: {metadata_path}")
        print("metrics self-check: OK (no store created)")
        return 0
    except Exception as error:
        print(f"metrics self-check: FAIL {error}", file=sys.stderr)
        return 1


def add_store_option(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--path", help=f"override {METRICS_ENV} for this invocation")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Passive local metrics for Pavan's Workflow")
    subparsers = parser.add_subparsers(dest="command", required=True)

    record = subparsers.add_parser("record", help="append one validated event; failures are non-blocking")
    record.add_argument("event", choices=sorted(EVENT_TYPES - {"human_rating"}))
    record.add_argument("--event-key", required=True)
    record.add_argument("--step")
    record.add_argument("--run-id")
    record.add_argument("--candidate-id")
    record.add_argument("--role", choices=sorted(ROLES))
    record.add_argument("--attempt", type=int)
    record.add_argument("--result")
    record.add_argument("--model-role")
    record.add_argument("--provider")
    record.add_argument("--model")
    record.add_argument("--evidence-ref")
    record.add_argument("--duration-ms", type=int)
    record.add_argument("--mode", choices=sorted(ARCHITECT_MODES))
    record.add_argument("--review-kind", choices=sorted(REVIEW_KINDS))
    record.add_argument("--gate", choices=sorted(GATES))
    record.add_argument("--failure-category", choices=sorted(FAILURE_CATEGORIES))
    record.add_argument("--detected-by", choices=sorted(DETECTED_BY))
    record.add_argument("--classification", choices=sorted(INTERRUPTIONS))
    record.add_argument("--status")
    record.add_argument("--repeat-count", type=int)
    record.add_argument("--threshold", type=int)
    record.add_argument("--pipeline-profile", dest="pipeline_profile", choices=sorted(PIPELINE_PROFILES))
    record.add_argument("--tokens", type=int)
    add_store_option(record)
    record.set_defaults(func=command_record)

    report = subparsers.add_parser("report", help="aggregate a read-only report")
    report.add_argument("--json", action="store_true")
    report.add_argument(
        "--scope",
        choices=("project", "all"),
        default="project",
        help="project (default): this repository's store; all: every registered project's store, read-only",
    )
    add_store_option(report)
    report.set_defaults(func=command_report)

    validate = subparsers.add_parser("validate", help="validate readable events without changing them")
    validate.add_argument("--strict", action="store_true", help="fail when malformed lines exist")
    add_store_option(validate)
    validate.set_defaults(func=command_validate)

    reset = subparsers.add_parser("reset", help="delete only the local event and metadata files")
    reset.add_argument("--yes", action="store_true")
    add_store_option(reset)
    reset.set_defaults(func=command_reset)

    rate = subparsers.add_parser("rate", help="rate the latest completed step")
    rate.add_argument("rating", choices=sorted(RATINGS))
    rate.add_argument("--step")
    add_store_option(rate)
    rate.set_defaults(func=command_rate)

    selftest = subparsers.add_parser("selftest", help="run deterministic A-L scenarios in a temporary store")
    selftest.set_defaults(func=command_selftest)

    self_check = subparsers.add_parser("self-check", help="check runtime and path resolution without creating data")
    add_store_option(self_check)
    self_check.set_defaults(func=command_self_check)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
