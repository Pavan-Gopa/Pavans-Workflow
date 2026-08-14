# Feature QA Report

> **Owner:** Main Orchestrator.  
> Written from verified Tester output. Green feature gate only.

---

## Meta

| Field | Value |
|-------|-------|
| Step | S1 |
| Date | 2026-08-11 |
| Status | qa_green |
| Suite | Dust provider login and routing smoke |

---

## 1. Gate results

| Command / scenario | Result |
|--------------------|--------|
| `omp models find dust --json` without credential | Exit 0; extension loaded; empty model list expected |
| Encoded v1 credential conversation | Exit 0; `Dust repair smoke OK` |
| Legacy raw key + workspace/base environment | Exit 0; `Dust repair smoke OK` |
| Invalid synthetic key | Exit 1; direct `Dust API 401 Unauthorized`; no key in output |
| Missing encoded workspace | Exit 1; exhausted 404 names workspace and fixture host; no key in output |
| Interactive mock login | Default workspace 404 → corrected workspace prompt → success |
| Dynamic model discovery | Found `dust/mock-agent` |

---

## 2. Gap-hunt mapping

| Requirement (from STEPS / plan) | Coverage | Result |
|---------------------------------|----------|--------|
| Correct a wrong default workspace at login | Interactive local fixture | Pass |
| Persist validated region/workspace | Encoded credential with conflicting legacy environment | Pass |
| Preserve legacy raw-key credentials | Raw key with `DUST_WORKSPACE_ID` and `DUST_BASE_URL` | Pass |
| Preserve non-404 authentication failures | Invalid-key fixture response | Pass |
| Explain exhausted 404 without secret leakage | Missing-workspace fixture response | Pass |
| Discover and invoke a Dust agent | Dynamic discovery + conversation POST | Pass |

---

## 3. New tests added

- none — the global extension has no approved repository test tree; QA used
  isolated temporary fixtures that were removed.

---

## 4. Notes

- 5 independent Tester checks passed, 0 failed, 0 open reproducible bugs.
- The Human's live key was never requested, printed, or stored during QA.
