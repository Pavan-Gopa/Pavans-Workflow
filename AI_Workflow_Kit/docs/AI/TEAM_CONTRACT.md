# Team Contract — canonical rules

This file is the single statement of the workflow's rules. Every other
document (`.omp/AGENTS.md`, `ORCHESTRATOR.md`, `PIPELINE.md`, role files,
commands) refers to these rule IDs instead of restating them. When documents
disagree, this file wins.

**Enforced by** says what actually stops a violation:
**code** — a script or the workflow extension refuses or flags it on real
repository state; **config** — OMP settings; **Main** — Main's procedure
(`ORCHESTRATOR.md`), no code check; **prompt** — role instructions only.

## Authority

| ID | Rule | Enforced by |
|---|---|---|
| R1 | Main is the only control plane: it routes, writes canonical workflow memory (`STATE.yaml`, `STEPS.md` checkboxes, `DECISIONS.md`, feedback and reports), creates checkpoints, and commits. | code: worker guard blocks worker edits of workflow files |
| R2 | Source-of-truth order: plan files named in `PROJECT_CONTEXT.md` > `STATE.yaml` > `STEPS.md` > `DECISIONS.md` > `PROJECT_CONTEXT.md` > `PIPELINE.md`. Conversation history and worker reports are never authoritative. | Main |
| R3 | Workers never route, spawn workers, commit, tag, push, switch branches, or edit workflow files; their output returns only to Main. | code: guard blocks git state changes and workflow-file edits in workers · config: `task.maxRecursionDepth: 1` |
| R4 | One specialized worker at a time. Every run and retry is a fresh session with a compact, self-contained assignment — never a transcript or hidden reasoning. | config: `task.maxConcurrency: 1` · Main |
| R5 | Main does not implement product code unless the Human authorizes it for that task. | Main |

## Write scope

| ID | Rule | Enforced by |
|---|---|---|
| R6 | Coder and Designer may change only `STATE.yaml target_files`; Tester only test/QA paths or `target_files`; Reviewer, Architect, Security, and Design Advisor change nothing. Main records `target_files` before every Coder/Designer dispatch; an empty list makes the verdict `unscoped`. | code: the `workflow-guard` extension blocks out-of-scope edits in every workflow worker before they run; `workflow_guard.py` verifies what the worker edited |
| R7 | A guard `violation` — a change the worker itself made outside its scope — rejects the worker result. Main records it, restores or quarantines the listed changes with the Human, records the Human's decision (`workflow_guard.py resolve --id <id> --note "…"`), and dispatches a fresh worker. A violation stays open until resolved; a later clean run never masks it. Changes by Main, the Human, or parallel sessions during a run are never a violation. Guard notes are information, not a rejection. | code: the verdict is injected into Main's context; `workflow_close.py` returns `reject_worker_result` while any violation for the step is open |

## State

| ID | Rule | Enforced by |
|---|---|---|
| R8 | Transitions are transactions. Before dispatch: write `current_step` (exact card ID), `current_work_item_id` (an existing stable ID), `pipeline.profile`, and `target_files`; persist and re-read; then Todo; then dispatch. After a result: verify evidence, update checklist/gates/status, persist, re-read, then route. | Main · Alt+W shows drift |
| R9 | Stable checklist IDs `<step>.D<n>` / `.O<n>` / `.J<n>` are unique and never change. Only Main checks or reopens them, after verification. Runtime Todo items carry the parent ID and never check `STEPS.md`. | Main · `workflow_migrate.sh check` |
| R10 | A finished worker proves only that a session ended. Main verifies every claim against real source, diff, and command output before writing canonical state. | Main · guard for scope |

## Gates and closing a step

| ID | Rule | Enforced by |
|---|---|---|
| R11 | Objective Gates are deterministic commands in the card's `### Objective gates` section (`` `$ cmd` `` or a recognised runner). Main re-runs them itself; a worker's "tests pass" is not evidence. | code: `workflow_gates.py` (inside `workflow_close.py`) |
| R12 | Reviewer owns Judgment Gates; the Human owns final aesthetic acceptance after a direct redesign. `waiting_review` is not completion. | Main |
| R13 | The close decision comes from `workflow_close.py check`. `close_quick` requires a `quick` card, risk not high, at least one command gate with all command gates green, every manual Objective gate already checked by Main, a clean Coder/Designer guard verdict with no open violation or unscoped run, and no blast-radius hit (security, secrets, contracts, infra, dependencies, control plane). Anything else continues with Reviewer and Tester. Main never closes a step as `quick` without a `close_quick` decision. | code: decision · Main: follows it |
| R14 | Reviewer runs unless the Human skips it; Tester is recommended unless the Human opts out; every skip is recorded with its reason. Security is offered once near release, or when the close check reports `offer_scoped_security`. | Main |

## Failure and models

| ID | Rule | Enforced by |
|---|---|---|
| R15 | Retry memory keeps only approach → observed result → verified reason. Stop after three materially identical no-progress failures; a new approach, new evidence, or a different failure is progress. Runtime interruption and provider/model failure are not product attempts. | Main |
| R16 | Automatic backup failover. On a primary worker model/provider failure, Main immediately records `omp.model_failure` (`status: backup_authorized`, `authorized_by: auto`), metrics `model_failure` (`status: auto_failover`), and dispatches the role's `-backup` agent with a fresh context, passing `backup_failover` and the failure evidence in the assignment. Two exceptions: the Fast Coder has no backup — its failure goes directly to the strong Coder (`workflow-coder`); and any other role fails over only to a backup that resolves to a model distinct from the failed primary. Main asks the Human only when that backup is unconfigured or aliases the primary, or the backup run also fails. | code: `before_subagent_spawn` blocks unauthorized backups · config: `retry.modelFallback: false` |
| R17 | Independent review: the Reviewer must not share a model with the Coder primary or backup, and backups should be spread across providers. | code: doctor warning (`workflow_model_diversity.py`) |

## Optional roles and skills

| ID | Rule | Enforced by |
|---|---|---|
| R18 | Design Advisor and Designer run only after explicit Human visual feedback or request — never automatically. They never change backend behavior, API/schema, persistence, auth/security, business logic, routing, localization meaning, or unrelated screens; new UI frameworks or dependencies need authorization. A direct redesign ends with Human visual acceptance. | Main · guard (`target_files`) |
| R19 | Ponytail autoloads only for Coder and its backup and never outranks requirements, gates, validation, security, accessibility, compatibility, or data integrity. The Reviewer blocks complexity only with a concrete behavior-preserving replacement. No other role trims its coverage for brevity. | doctor (autoload check) · prompt |
| R20 | Graphify is navigation evidence, never truth: Graphify for non-trivial discovery and blast radius, focused LSP/grep/read for a known symbol, real source verified in both cases. Main owns graph freshness; workers report staleness. A Graphify failure never blocks work. | prompt |

## Observability and control

| ID | Rule | Enforced by |
|---|---|---|
| R21 | Passive metrics, OMP Stats, and the Alt+W dashboard (including the leaderboard) never control routing or gates; dashboard live-step recovery is display-only and never writes state. The one exception is the deterministic Fast Coder health window in `workflow_route.py`, which may stop routing first attempts to a fast model whose last ten resolved attempts have fewer than five first-pass successes. | code: read-only dashboard · `workflow_route.py` is the only consumer that may steer routing |
| R22 | The Human may interrupt or redirect at any time. After any intervention Main re-reads repository and workflow state before continuing. | Main |

## Known limits of enforcement

- The guard attributes a change to a worker only when the worker made it with
  its own edit/write tools (or an `lsp` rename / applied code action on the
  named file). It blocks literal `git` commands that change repository state,
  but it cannot see what a worker's `bash` writes (a formatter, a generator,
  `sed -i`, a script that commits): such files are listed as `shell_suspects`,
  and commits made meanwhile as `suspect_commits` — for Main to check, never a
  violation. The Reviewer and Main's diff check are the backstop.
- A git command is blocked only when git confirms it targets the project's own
  repository. Fixture repositories — elsewhere (`cd /tmp/x`, `git -C /tmp/x`,
  the bash tool's `cwd`), nested inside the project, or created by the same
  command line with `git init` — are not blocked, and neither are `--help`
  and dry runs. A place the guard cannot know statically (`cd "$TMP"`) is
  left alone.
- Changes made while a worker runs by Main, the Human, a parallel OMP session,
  or OMP itself (settings rewrites of `.omp/config.yml`) are never blamed on
  the worker, and a HEAD move during a run is not the worker's unless it ran
  the git command — which the guard blocks.
- The guard sees what git sees: files ignored by `.gitignore` (for example a
  local `.env`) are invisible to it — neither blocked nor judged, except
  workflow files, which stay protected — and test caches (`__pycache__`,
  `.pytest_cache`, `*.pyc`, …) are deliberately ignored.
- Guard mode and verdicts are kept per workflow project, so two workflow
  projects in one monorepo do not share them.
- The in-worker checks need OMP to run project extensions inside subagent
  sessions (OMP 18.x does). If the guard script cannot run, the extension
  fails open and warns once: a broken guard never blocks work.
- `workflow_guard.py mode report|off` (or `WF_GUARD_MODE`) relaxes the guard
  for a repository; it is the Human's decision.
- Rules marked **Main** or **prompt** depend on the model following them; the
  dashboard's consistency warnings and the Reviewer are the backstop.
