# Changelog

## 3.6.0 — 2026-09-29

The worker guard no longer stops the workflow over changes the worker did not
make.

### Why it kept interrupting

The 3.5 guard compared the whole repository before and after a worker and
charged every difference to that worker. In a real session much of that
difference is somebody else's: Main committing a checkpoint while an async
worker runs, the Human editing, a second OMP session working in the same
repository, OMP rewriting `.omp/config.yml`. Each of those became a "boundary
violation", Main was told not to accept the result, and `workflow_close.py`
refused to close the step until someone resolved it by hand. OMP's own helper
agents (scout, explore) were judged too, as read-only "unrecognised agents".

### Changed

- **Prevention instead of blame.** Inside every workflow worker session the
  guard now checks each edit/write call and each literal `git` command before
  it runs. An edit outside the role's scope, an edit to a workflow file, or a
  git command that changes repository state (commit, branch/tag, stash, reset,
  checkout/switch/restore, add/rm/mv, merge/rebase, push/pull, clean, ...) is
  blocked: the worker gets a tool error, nothing changes, the step keeps going.
  Main gets a short note listing what was blocked. A git command is blocked
  only when git confirms it targets the project's own repository; fixture
  repositories (elsewhere, nested, created by the same command, or named by
  the bash tool's `cwd`), `--help`, and dry runs are left alone. `lsp` renames
  and applied code actions count as edits (read-only roles cannot run them).
  If the guard itself cannot run (for example `python3` is missing), it warns
  once and lets work continue.
- **A verdict judges only the worker's own edits** (the run's ledger). Changes
  by anyone else during the run are listed as "changed by others meanwhile" and
  never become a violation or a message. Files changed while the worker's shell
  commands ran are listed as `shell_suspects`, and commits made meanwhile as
  `suspect_commits`, for Main to look at, without a verdict. A HEAD move
  during a run is no longer a violation by itself. An edit that was allowed
  when it ran is never judged again later (for example after Main moves
  `target_files` on to the next step).
- **OMP's own agents are not guarded** (scout, explore, task, `/tan` clones).
- **3.5.x verdicts stop blocking.** Violations recorded by 3.5.x came from the
  whole-repository diff and cannot be attributed; `workflow_close.py` lists them
  under `guard.info` as legacy and no longer returns `reject_worker_result` for
  them. Steps stuck on them close again after the update.
- **Guard notes are information.** Main's instructions now say that only a
  "boundary violation" rejects a worker result.
- **Modes:** `workflow_guard.py mode enforce|report|off` (or `WF_GUARD_MODE`).
  `report` blocks nothing and lists what `enforce` would have blocked; `off`
  disables the boundary guard. Backup authorization always stays on.
- `workflow_guard.py verify --whole-repo` keeps the old judgement for a manual
  audit in a repository nobody else touches.
- **Checkpoints work in a shared worktree.** `checkpoint.sh` commits exactly
  `WF_STAGE_PATHS` and leaves every other change — unstaged or staged by
  someone else — untouched, instead of refusing. `WF_CHECKPOINT_STRICT=1`
  restores the refusal. A scope entry with nothing to stage (never created,
  or ignored) is skipped instead of aborting the checkpoint halfway.
- `target_files` entries match folder names that contain glob characters
  (Next.js `app/[slug]/`) and `**` patterns; the Tester's test paths include
  `conftest.py`, `tests.py`, snapshots, test utilities, and setup files.
- Guard mode and verdicts are per workflow project, so two workflow projects
  in one monorepo no longer share them; paths outside the project are shown
  correctly relative to it (`../../libs/x.ts`).
- Worker prompts describe the new behaviour: a blocked call changes nothing;
  finish what is in scope and name what is still needed.
- Verified snapshots drop their dirty-file map, so the guard store stays small
  in repositories with many uncommitted files.
- Tested OMP is now 18.4.3 (type-checked against 18.3.5 and 18.4.3). CI also
  runs the guard inside a real OMP session with a scripted model
  (`ci/omp_runtime_guard.ts`).

### Known limits

- What a worker's `bash` writes (formatters, generators, `sed -i`, scripts)
  cannot be attributed; it shows up as `shell_suspects` or "changed by others",
  never as a violation. The Reviewer and Main's diff check are the backstop.
- The quick-close blast radius still looks at the whole worktree, so unrelated
  changes from a parallel session can route a quick step to review.

## 3.5.1 — 2026-09-28

Guard fixes found by running the 3.5.0 guard in live OMP sessions.

### Fixed

- **Model changes no longer count as worker violations.** OMP re-serializes the
  whole `.omp/config.yml` whenever the Human changes a model or setting (Alt+M)
  and creates `.omp/config.yml.lock` on its first settings save. If that
  happened while a worker ran, the guard recorded a boundary violation against
  the worker, and the step could not close until it was resolved by hand. The
  lock file is now ignored; a change to `.omp/config.yml` during a worker run is
  reported to Main as a note to confirm with the Human instead of a violation.
  Every other `.omp/` file stays protected.
- **Headless Main is recognised as Main.** The guard told Main apart from its
  workers by `hasUI`, so in print or RPC sessions without a UI, Main's own
  edit/write calls during a worker run were attributed to the worker. It now
  uses OMP's agent identity (`ctx.agent.kind`) and falls back to `hasUI` only
  on hosts without it.
- Notes on a clean guard verdict now reach Main; before, only violations and
  unscoped runs did.

### Changed

- CI and release workflows use `actions/checkout`, `actions/setup-node`, and
  `actions/setup-python` v7 (Node 24). GitHub deprecated the Node 20 runtime
  of the previous majors.

## 3.5.0 — 2026-09-27

Hardening release: the rules that used to live only in prompts are now checked
in code, installs no longer collide with product files, and updates are
transactional.

### Security and correctness

- **Template contamination removed.** `PROJECT_CONTEXT.md`, `FEEDBACK.md`, and
  `REPORT.md` shipped another project's real context and QA log since 3.1
  (commit `da3addf`). Project state now lives only as pristine templates in
  `AI_Workflow_Kit/templates/` and is rendered into a project when missing — a
  used checkout can never leak its memory into a new install. CI refuses
  committed project state.
- **`/workflow-update` and `/work-update` work again.** Since 3.2 they always
  called a removed experiment bridge and exited 2.
- **The updater no longer overwrites product files.** Pre-3.5 updates replaced
  the project's `README.md`, `INSTALL.md`, `CHANGELOG.md`, and `VERSION`, and
  the installer refused any repository that had a `CHANGELOG.md` or `VERSION`.
  The framework version now lives in `AI_Workflow_Kit/VERSION`. The first 3.5
  update restores root files a legacy updater just overwrote (from its backup)
  and points out leftovers.
- **Worker guard.** A new `workflow-guard` extension snapshots the repository
  before every worker spawn (keyed by OMP's spawn key, and on `started` for
  workers woken again via `agent://`) and verifies it when the worker finishes
  (`workflow_guard.py`): read-only roles may change nothing, Coder/Designer only
  `target_files`, Tester only test paths or `target_files`; no worker may commit
  or edit workflow files. Violations are injected into Main's context and stay
  open until Main records the Human's decision (`workflow_guard.py resolve`).
  Paths are judged relative to the project folder (monorepo subfolders work);
  test caches are ignored; Main's own edits are exempted in every OMP edit mode.
- **Backups need recorded Human authorization — enforced.** `-backup` agents are
  blocked at spawn unless `STATE.yaml` records `backup_authorized` for that role.
- **Deterministic close decision.** `workflow_close.py check` combines Objective
  Gates (manual ones must already be checked for `quick`), every guard verdict
  for the step (an open violation is never masked by a later clean run), card
  risk, and blast radius into `close_quick` / `review` / `reopen_coder` /
  `reject_worker_result`.
- **Objective Gates.** Backticked names (`README.md`, `maxRetries`) are no
  longer executed; `` `$ cmd` `` is the explicit marker; recognised runners
  include `cd dir && …` / `env …` prefixes and executables given by path; every
  command on a line runs; fenced examples and template cards are ignored;
  timeouts kill the whole process group; a card without command gates cannot
  close as `quick`.
- **Blast radius.** Token-based matching (`src/login.ts`, `rbac.go`,
  `stripeWebhook.ts` now hit; `authors.ts`, `urls.ts`, `lessons/` no longer
  do). New categories: secrets files, infra (CI, Docker, IaC), dependency
  manifests, and the workflow control plane (`.omp/`). The diff includes
  commits since the `pre-<step>` checkpoint tag.
- **OMP 18 compatibility.** The Main alias guard called `settings.get()`, which
  OMP 18 removed; it now reads the role storage safely. Quick Focus loads its
  InputController seam dynamically and disables itself instead of breaking
  input if OMP changes that internal.

### Updates and releases

- One manifest (`AI_Workflow_Kit/framework.manifest`) drives install, update,
  doctor, and CI. `AI_Workflow_Kit/installed.manifest` records what was
  installed, so files a release deletes are removed (unless locally modified),
  and project-added files are never touched.
- Updates are backed up and rolled back automatically on failure; the updater
  hands over to the downloaded release, so replacing itself is safe.
- `install.sh` and `workflow_update.sh` default to the newest `vX.Y.Z` tag
  (fallback `main`) and accept `--ref`. `install.sh --update` no longer leaves a
  temporary clone behind or clones twice. Installing into a repository that
  already has its own `.omp/config.yml` merges the workflow roles into it.
- Pre-3.5 in-project updaters (3.0–3.4) overwrite themselves while copying;
  the new `workflow_update.sh` carries a whitespace landing pad at the byte
  offsets where those old processes resume, so they hand over to the 3.5
  manager and finish the migration (checked in CI for 3.4.1 and 3.4.2). OMP
  warns at startup if `installed.manifest` is missing.
- Installing from a git checkout ships tracked files only, so untracked local
  files (private agents, backups) never reach another project.
- Only the framework step is transactional: migrate and doctor failures are
  reported, not rolled back (documented).

### Checks and tests

- CI: Python 3.9 and 3.12, shellcheck, `tsc` against the pinned OMP release
  (`dependencies.lock`), end-to-end install/update/legacy-migration on Linux
  and macOS (`/bin/bash` 3.2), and repository hygiene checks.
- New selftests: framework manager (install, update, rollback, legacy),
  guard, close decision, update command, Quick Focus seam, model diversity.
- The doctor warns when the Reviewer shares a model with the Coder primary or
  backup, or when one provider backs up most roles (`workflow_model_diversity.py`).
- The doctor warns on an OMP major version other than the tested one.
- Template default: `workflow_coder_backup` is now `nvidia/z-ai/glm-5.2:high`
  (it was the Reviewer's model, so a Coder failover removed review
  independence). Existing projects keep their own choice; the doctor warns.

### Changed

- `TEAM_CONTRACT.md` is the single rule set (R1–R22) with what enforces each
  rule; `AGENTS.md`, `ORCHESTRATOR.md`, `PIPELINE.md`, and the `/workflow`
  command reference rule IDs instead of repeating them. Main's core read set
  (those five files) went from about 36 KB to 22 KB and `.omp/AGENTS.md` alone
  from 10 KB to 2 KB. Release numbers were removed
  from contract docs.
- `checkpoint.sh rollback` needs explicit confirmation (`WF_CONFIRM_ROLLBACK`)
  and saves uncommitted tracked changes first.
- Graphify missing is a doctor warning, not a failure.

### Removed

- `AI_Workflow_Kit/experiments/` payloads (≈390 KB of unused base64 archives),
  the lean-pipeline overlay and its rollback, `workflow_experiment*.{sh,py}`,
  `EXPERIMENT_CONTEXT_ECONOMY.md` — context economy and the lean pipeline are
  core. Dead code: the unused Stats controller and the never-rendered model
  setup panel.

## 3.4.2 — 2026-09-01

### Fixed

- **Main model/effort picker crash.** The workflow's Main-model extension no
  longer polls role settings every 200 ms and no longer calls `setModel()` or
  `setThinkingLevel()` while OMP's native model hub is between its model and
  effort stages. OMP now owns the complete `DEFAULT` selection flow.
- **Conflicting Main slots.** `workflow_orchestrator` is a managed alias to
  `@default` and is hidden from Alt+M Roles. Users edit `DEFAULT` for the
  persistent Main model and effort, while `workflow_orchestrator_backup`
  remains independently configurable.
- **Safe upgrade migration.** An older direct Orchestrator selection is copied
  to `DEFAULT` only when an explicit `DEFAULT` is absent; an existing `DEFAULT`
  is never overwritten by a stale alias value.
- **Version drift.** Installer, updater, doctor, dependency lock, README, and
  INSTALL documentation now report the current release consistently. The
  incorrect v3.4.1 changelog date was corrected to its actual release date.

### Added

- Config validation for the hidden managed Orchestrator alias.
- A no-race regression test that rejects future polling, `setModel()`, or
  `setThinkingLevel()` calls in the Main alias guard.
- GitHub Actions CI for shell syntax, Python syntax/selftests, OMP-independent
  TypeScript selftests, shell selftests, and canonical config validation.

### Changed

- The Main alias extension is now a one-shot session-start/session-switch guard,
  not a live synchronization loop.
- README release highlights now cover v3.4.0, v3.4.1, and v3.4.2, with explicit
  instructions for permanent primary changes versus temporary backup switching.

## 3.4.1 — 2026-08-29

### Added

- `workflow_security_scope.py` reports `forbid_quick` for authentication/trust
  paths and public-contract paths such as `/api/`, schemas, OpenAPI, GraphQL,
  protobuf, and migrations. Main cannot close a `quick` card when the helper
  hits.
- Metrics group completed steps, Coder retries, and recorded tokens by
  `pipeline_profile` (`quick`, `standard`, `critical`, or unlabeled). No USD.

### Fixed

- Fresh-install README/INSTALL snippets preserve the installer exit code.

## 3.4.0 — 2026-08-25

Lean pipeline promoted to core from the `experiment/lean-pipeline` overlay.
Unlabeled steps keep the default Coder → Reviewer → Tester loop. The former
opt-in installer remains under `AI_Workflow_Kit/experiments/lean-pipeline/` for
pre-3.4.0 installations.

### Added

- Pipeline profiles on step cards (`quick`, `standard`, `critical`). `quick`
  skips Reviewer/Tester only after Main reruns Objective Gates; high-risk work
  ignores `quick`.
- Deterministic Objective Gate runner: `workflow_gates.py`.
- Scoped Security offers from path blast radius:
  `workflow_security_scope.py`.
- Assignment-first worker packets and `WORKER_INPUT_DIGEST.md`.
- Retry Ponytail: `lite` after review/QA, `off` after two identical failures.
- Tester writes a failing test before returning `bugs`.
- Reversible installer with timestamped framework backup.

### Changed

- Targeted Main reconciliation is the default for ordinary transitions.
- Alt+W token budget no longer hardcodes `0`; Designer/Advisor labels render.
- Context Economy documentation no longer describes itself as a v3.1.4
  experiment.

## 3.3.1 — 2026-08-23

### Fixed

- **Quick Worker Focus on OMP 18.** Active-worker lookup now uses the Main
  session's async-job snapshot, with the dashboard tracker as fallback. The
  former isolated event-bus map caused every Tab decision to fall through.

### Added

- `[quick-focus] decision=...` trace lines for field diagnostics.

## 3.3.0 — 2026-08-22

### Added

- OMP native mid-turn compaction owns the 28% hard Main-context boundary.
- The extension soft window warns at 23% and runs `shake -> soft` only when Main
  is settled, rearming at 18%.
- Context Economy status in Alt+W and `/workflow-experiment` controls.
- Copy-paste remote updater support through `install.sh --update`.

### Fixed

- Alt+W expanded view renders every RUN TODO item instead of capping at eight.
- Main-model and Quick Focus selftests no longer import OMP-only runtime modules.
- Dashboard statistics tolerate a missing session usage snapshot.

### Changed

- Context Economy installation became a canonical-tree sync with managed config
  patching and stale monolith cleanup.

## 3.2.0 — 2026-08-21

### Added

- Main-only Context Economy, with workers excluded from Main compaction.
- Quick Worker Focus: empty-composer Tab moves between Main and the active
  worker while preserving native completion in every other context.
- Deterministic tests for Quick Focus and Main-only scope.

### Changed

- `DEFAULT` became the authoritative Main model slot and
  `workflow_orchestrator` became an `@default` alias.
- Worker/task sessions no longer inherit Main live-model reconciliation.
- Fresh install and normal update paths install/repair Context Economy.
- Workflow agents receive a minimum four-hour hard wall and no request-count
  forced-yield guard.

## 3.1.4 — 2026-08-20

- Switched manual OMP Stats to the official native sync/server implementation.
- Raised workflow task runtime to four hours and disabled the request-count
  forced-yield guard.
- Added additive config migration and deterministic policy tests.

## 3.1.3 — 2026-08-20

- Mounted Alt+W as a true fullscreen, mouse-tracked OMP overlay.
- Added regression coverage for focus, viewport sizing, and wheel routing.

## 3.1.2 — 2026-08-19

- Added one scrollable viewport for long plans, checklists, and native Todo.
- Added wheel, paging, fast scroll, top/bottom, and live-follow controls.

## 3.1.1 — 2026-08-19

- Quoted `@role` aliases for OMP's YAML parser.
- Added recovery from OMP `.broken-*` configs and workflow update backups.
- Preserved existing model choices while adding missing design aliases.

## 3.1.0 — 2026-08-19

- Added optional Design Advisor and Designer roles with independent backups.
- Added the project-local `ui-designer` skill and live-step recovery for Alt+W.
- Preserved the existing Graphify index by default during updates.

## 3.0.0 — 2026-08-18

- Added Coder-only Ponytail, conditional Graphify profiles, manual OMP Stats,
  dependency locking, safe updater/doctor coverage, and v3 documentation.

## 2.x

- Progressive onboarding, stable checklist IDs, dual Todo views, workflow
  dashboard, passive metrics, manual model failover, and Graphify-first
  navigation.
