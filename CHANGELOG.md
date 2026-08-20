# Changelog

## 3.1.4 — 2026-08-20

### Fixed

- Manual OMP Stats now uses the official `@oh-my-pi/omp-stats` sync/server implementation after an explicit Human action instead of duplicating OMP's private dashboard security-header version. This fixes the case where the browser shell opened but every card failed to fetch after OMP advanced its dashboard security contract.
- Long-running workflow agents are no longer killed by the old 30-minute default. The hard task wall-clock ceiling is now four hours (`maxRuntimeMs: 14400000`).
- OMP's request-count forced-yield guard is disabled for workflow roles (`softRequestBudget: 0`) so large repositories, long test suites, or tool-heavy Coder runs are not stopped early by request count while still inside the four-hour wall.

### Changed

- Existing project `.omp/config.yml` files are migrated additively: model mappings and unrelated settings are preserved, while the two workflow-owned task guards are normalized to the v3.1.4 policy.
- `workflow_doctor.sh` now fails when the four-hour runtime policy is missing or when Stats falls back to the copied legacy header/probe path.

### Added

- Deterministic config-repair coverage for upgrading old 30-minute / 120-request project configs to the v3.1.4 runtime policy.
- Updated Stats wiring selftest for the explicit native OMP Stats launcher path.

### Compatibility

- Stats remains fully manual: nothing probes, syncs, starts, or installs a widget at OMP startup.
- Human abort through Agent Hub remains available, and the workflow's own retry/stall controls remain unchanged.
- Existing model selections, durable workflow state, project code, reports, Graphify output, Designer roles, Ponytail policy, and Alt+W behavior are preserved by update.

## 3.1.3 — 2026-08-20

### Fixed

- Alt+W now mounts as a true fullscreen OMP overlay instead of ordinary custom editor content.
- Fullscreen mouse tracking is explicitly enabled, so terminal wheel events reach the dashboard `ScrollView` instead of leaving a non-interactive scrollbar on screen.
- The dashboard viewport height is now derived from the fullscreen terminal surface rather than the smaller editor-area mount.

### Added

- Deterministic regression coverage that guards the fullscreen overlay, mouse tracking, wheel routing, and ScrollView wiring.
- `workflow_doctor.sh` now fails if Alt+W loses its fullscreen mouse-tracked mount contract.

### Compatibility

- Existing Up/Down step selection, PageUp/PageDown, Shift+Up/Down, `g`/`G`, `c` live-follow, Todo views, live cursor recovery, Designer roles, config recovery, and manual OMP Stats remain unchanged.
- The dashboard remains read-only and closing Alt+W restores the normal OMP screen.

## 3.1.2 — 2026-08-19

### Fixed

- Alt+W no longer hides long step checklists or native OMP Todo content behind `N more detail lines` placeholders.
- Long plans are expanded before display so every step remains reachable instead of being permanently clipped to one terminal height.

### Added

- One vertical ScrollView around the complete Alt+W dashboard. A scrollbar appears only when the logical dashboard is taller than the terminal.
- Mouse-wheel scrolling, PageUp/PageDown paging, Shift+Up/Down fast scrolling, and `g`/`G` top/bottom navigation.
- Manual vertical scrolling pauses live-follow so the dashboard does not jump while the Human is inspecting history; `c` returns to the live step and resumes follow.
- Deterministic regression coverage with a 48-step plan, 60-item step checklist, and 44-item native OMP Todo fixture.

### Compatibility

- Up/Down and Home/End retain their existing step-selection behavior.
- Short dashboards remain compact and do not show a scrollbar when all content fits.
- The dashboard remains read-only; workflow state, Todo state, and metrics are not modified by scrolling.

## 3.1.1 — 2026-08-19

### Fixed

- Quoted project model-role aliases such as `"@workflow_architect"` so OMP's YAML parser accepts the v3.1 Designer defaults.
- Added automatic recovery when OMP already moved an invalid `.omp/config.yml` to `.omp/config.yml.broken-*`.
- Updater now prefers the newest recoverable project config, then workflow update backups, and only falls back to template defaults when no project-specific mapping can be recovered.
- Existing custom model selections are preserved while missing Designer/Design Advisor aliases are added safely.
- Update `check` reports a config repair before mutating anything, and `workflow_doctor.sh` validates the model-role config before launch.
- Added deterministic regression coverage for both broken-config recovery and workflow-backup recovery.

### Recovery

Existing projects affected by v3.1.0 can simply run the normal fresh updater again. v3.1.1 restores the project model-role map before the final doctor runs; no manual editing of `.broken-*` files is required.

## 3.1.0 — 2026-08-19

### Added

- Optional read-only `workflow-design-advisor` for lower-cost, implementation-ready UI/UX briefs.
- Optional edit-capable `workflow-designer` for Human-requested presentation-layer redesigns.
- Primary/backup model aliases for both design paths; existing projects receive them additively without overwriting model selections.
- Project-local `ui-designer` skill with progressive references for hierarchy, interaction states, responsive layout, accessibility, and visual verification.
- Designer role contracts, assignment templates, doctor checks, and update/install support.
- Read-only live-step resolver and deterministic regression tests for Alt+W.

### Fixed

- Alt+W no longer remains pinned to a stale `STATE.yaml.current_step` when a current work-item ID, active OMP Todo, or active worker proves a newer live step.
- Plan follow mode once again moves automatically with active work; arrow navigation pauses follow and `c` returns to the live step.
- Runtime-derived recovery is visible as state drift rather than silently rewriting canonical workflow files.

### Changed

- Designer is never an automatic pipeline stage. Human intent chooses advisory or implementation mode.
- Direct Designer output still passes Main verification, Reviewer, enabled Tester, and final Human visual acceptance.
- Workflow updates add missing optional design aliases to `.omp/config.yml` while preserving every existing assignment.
- Workflow updates preserve the existing Graphify index and defer refresh by default; `--refresh-graphify` opts into a portable bounded refresh.
- Update diagnostics now validate the live cursor, Designer skills/agents, role scoping, and eight model-role pairs.

### Compatibility

- The default Coder → Reviewer → Tester flow is unchanged.
- Existing `STATE.yaml`, `STEPS.md`, project context, decisions, feedback, reports, model selections, and schema-v2 IDs remain preserved.
- OMP Stats remains manual and never installs a startup widget.

## 3.0.0 — 2026-08-18

- Added Coder-only Ponytail, conditional Graphify profiles, manual OMP Stats, dependency locking, safe updater/doctor coverage, and v3 documentation.

## 2.x

- Progressive onboarding, stable checklist IDs, dual Todo views, workflow dashboard, passive metrics, manual model failover, and Graphify-first navigation.
