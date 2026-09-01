# Changelog

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
