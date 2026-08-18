# Changelog

## 3.0.0 — 2026-08-18

### Added

- Project-local Ponytail implementation policy, pinned to upstream 4.9.0.
- Automatic Ponytail loading for primary and backup Coder agents only.
- Explicit `ponytail-review`, `ponytail-audit`, and `ponytail-debt` one-shot skills.
- Graphify dependency lock, fast/deep/semantic/force rebuild profiles, graph validation, and last-good recovery.
- `.graphifyignore` defaults that keep workflow control-plane files out of product graphs.

### Changed

- Graphify is required for non-trivial discovery, but no longer a ritual for a known local symbol.
- Reviewer remains correctness-first and now performs a bounded material-complexity check.
- Architect prefers the smallest reversible design that satisfies confirmed constraints.
- OMP Stats is manual: no startup process, persistent below-editor widget, startup warning, or automatic lifecycle sync.
- `Alt+W` always displays the local Stats URL. Pressing `o` or running `/workflow-stats` starts and opens Stats explicitly.

### Compatibility

- Live project state, model mappings, step cards, decisions, feedback, and reports remain preserved by updates.
- Existing schema-v2 step IDs remain unchanged.

## 2.x

- Progressive onboarding, stable checklist IDs, dual Todo views, workflow dashboard, passive metrics, manual model failover, and Graphify-first navigation.
