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
from datetime import datetime, timezone
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
}
ROLES = {"coder", "reviewer", "tester", "architect", "security"}
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
INTERRUPTIONS = {
    "interrupted_no_changes",
    "interrupted_partial",
    "indeterminate",
}
RESULTS_BY_ROLE = {
    "coder": {"waiting_review", "blocked"},
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
}
SIMPLE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$")
SIMPLE_REF = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$")


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
    for key in ("model_role", "provider", "model"):
        if event.get(key) is not None:
            require_id(key, event[key])
    validate_ref(event.get("evidence_ref"))
    for key in ("attempt", "duration_ms", "repeat_count", "threshold"):
        value = event.get(key)
        if value is not None and (not isinstance(value, int) or value < 0):
            raise MetricsError(f"{key} must be a non-negative integer")

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
    if event_type == "model_failure" and event.get("status") != "awaiting_human":
        raise MetricsError("model_failure status must be awaiting_human")
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




def aggregate(events: list[dict[str, Any]], info: dict[str, Any]) -> dict[str, Any]:
    by_type: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for event in events:
        by_type[str(event["event"])].append(event)

    completed_steps = {str(event["step"]) for event in by_type["step_completed"]}
    coder_results = [event for event in by_type["worker_result"] if event.get("role") == "coder"]
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
    for run_id, started in starts_by_run.items():
        terminal = terminal_by_run.get(run_id)
        start_ts = parse_ts(started.get("ts"))
        end_ts = parse_ts(terminal.get("ts")) if terminal else None
        if start_ts is None or end_ts is None or end_ts < start_ts:
            continue
        duration_ms = int((end_ts - start_ts).total_seconds() * 1000)
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
        terminal = terminal_by_run.get(run_id)
        start_ts = parse_ts(started.get("ts"))
        end_ts = parse_ts(terminal.get("ts")) if terminal else None
        if start_ts and end_ts and end_ts >= start_ts:
            bucket["durations_ms"].append(int((end_ts - start_ts).total_seconds() * 1000))
        if role == "coder":
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
        for event in starts_by_role["coder"]
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
        if role == "coder":
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
    step_stats: dict[str, dict[str, Any]] = {}
    for step in step_ids:
        step_events = [event for event in events if str(event.get("step")) == step]
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

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": utc_now(),
        "storage": info,
        "summary": summary,
        "failure_categories": dict(sorted(failure_categories.items())),
        "detected_by": dict(sorted(detected_by.items())),
        "role_stats": role_stats,
        "step_stats": step_stats,
        "human_ratings": dict(sorted(ratings.items())),
        "model_samples": model_samples,
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
    lines = [
        "Pavan's Workflow Metrics",
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
    lines.append(f"Local store: {storage['events_path']}")
    return "\n".join(lines)


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
        print(f"metrics {status}: {args.event_key}")
    except Exception as error:  # observer failure must not control workflow
        print(f"WARN metrics unavailable: {error}", file=sys.stderr)
    return 0


def command_report(args: argparse.Namespace) -> int:
    try:
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
    add("step_started", "step_started:S1", 0, step="S1")
    add("worker_started", "worker_started:c1", 1, step="S1", run_id="c1", candidate_id="c1", role="coder", attempt=1, model_role="workflow_coder", provider="local", model="Luna")
    add("worker_result", "worker_result:c1", 2, step="S1", run_id="c1", role="coder", attempt=1, result="waiting_review", evidence_ref="AI_Workflow_Kit/docs/AI/FEEDBACK.md")
    add("worker_started", "worker_started:r1", 3, step="S1", run_id="r1", role="reviewer", attempt=1)
    add("worker_result", "worker_result:r1", 4, step="S1", run_id="r1", candidate_id="c1", role="reviewer", result="approved", review_kind="product", evidence_ref="AI_Workflow_Kit/docs/AI/FEEDBACK.md")
    add("worker_started", "worker_started:t1", 5, step="S1", run_id="t1", role="tester", attempt=1)
    add("worker_result", "worker_result:t1", 6, step="S1", run_id="t1", candidate_id="c1", role="tester", result="qa_green", evidence_ref="AI_Workflow_Kit/docs/AI/REPORT.md")
    add("step_completed", "step_completed:S1", 7, step="S1")

    # S2: Reviewer catches a bug; second Coder candidate passes. Includes advisory Architect.
    add("step_started", "step_started:S2", 8, step="S2")
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
    add("step_started", "step_started:S3", 23, step="S3")
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

        print(f"workflow metrics selftest: PASS ({len(cases)}/14)")
        for case in cases:
            print(f"  PASS {case}")
        print("\nSynthetic five-step report:\n")
        print(format_report(report))
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
    add_store_option(record)
    record.set_defaults(func=command_record)

    report = subparsers.add_parser("report", help="aggregate a read-only report")
    report.add_argument("--json", action="store_true")
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
