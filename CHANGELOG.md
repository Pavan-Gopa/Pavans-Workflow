# Changelog

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
