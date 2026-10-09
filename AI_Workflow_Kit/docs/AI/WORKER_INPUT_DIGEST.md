# Worker input digest

Main pastes only the matching role block into the assignment. Workers do not
reload TEAM_CONTRACT, KICK_*, or PROJECT_CONTEXT when the packet is complete.
Every role: query Graphify with `graphify query "<question>" --graph graphify-out/graph.json --budget 1500`
(or `path`/`explain`); never load `skill://graphify` and never run `graphify update`
or a rebuild — Main owns graph freshness (R20).

## Backup variant (any `workflow-<role>-backup` agent)

Add to the role block below, built by Main under R16 (ORCHESTRATOR §7):

```text
backup_failover: auto | human      # auto = Main's automatic failover; human = the Human directed the backup
failure_evidence: <failed model, provider error excerpt, authorized_at; for human also the Human's exact words>
```

A backup agent returns `blocked` without both fields. The Fast Coder has no backup variant.

## Coder

```text
role: coder
writes: assignment target_files only
never: workflow files, commit, push, route, spawn
ponytail_mode: <full|lite|off>
navigation: Graphify for unknown blast radius; LSP/grep/read for a named local symbol; always verify real source
gates: run `python3 AI_Workflow_Kit/script/workflow_gates.py run --for coder --step <step>`; never run `(close-only)` gates — the close check runs them on the final tree
blocked: if a required path is outside target_files
result: waiting_review | blocked; changed_files; objective_gate_ids; commands+results only, no diff paste
```

## Reviewer

```text
role: reviewer
writes: nothing
order: Judgment Gates → scope → contracts/failure/trust → gate meaningfulness → secrets → material complexity
complexity block: only with a concrete behavior-preserving replacement
result: approved | changes_requested | blocked; each issue has file, location, required_change, affected_ids
```

## Tester

```text
role: tester
writes: approved test/QA paths only
never: product source, workflow files, commit, route
on bugs: add a failing test first, then return bugs with that path and reproduction
result: qa_green | bugs | blocked; pass/fail counts; new_tests; short error excerpts
```

## Architect

```text
role: architect
writes: nothing
modes: advisory | design | grilling
Graphify then real source. Smallest reversible design. Main persists anything accepted.
result: advice_ready | design_ready | needs_human_input | blocked
```

## Security

```text
role: security
writes: nothing
scope: assignment attack surface only; find and describe, do not patch
result: security_clean | findings_open | blocked; severity, evidence, suspect_files, fix_direction
```

## Design Advisor

```text
role: design_advisor
writes: nothing
mode: advisory
return: file/component changes, preserve-list, visual acceptance, non-goals
```

## Designer

```text
role: designer
writes: assigned presentation/UI/test files only
never: backend, API/schema, persistence, auth, routing, unrelated screens
mode: implementation
result: waiting_review | blocked; visual_evidence from render/capture, not tests alone
```
