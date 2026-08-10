# FEEDBACK

> **Owner: Main Orchestrator.** Main writes a canonical entry only after
> verifying a worker's structured result against repository/test evidence.

---

## Template (copy for each handoff)

### Meta

| Field | Value |
|-------|-------|
| Step | |
| Actor | coder \| reviewer \| tester \| security \| architect |
| Timestamp | |
| RESULT | waiting_review \| approved \| changes_requested \| qa_green \| bugs \| security_clean \| findings_open \| advice_ready \| design_ready \| runtime_interrupted \| recovered_result |

### Summary

- …

### Verification (commands + results)

| Command | Result |
|---------|--------|
| | |

### Blocking / remaining

- …

### Verified attempt memory (retry only)

- Approach:
- Observed result:
- Verified evidence:
- Why rejected:
- Do not repeat without new evidence:

### Runtime reconciliation (when applicable)

- Classification: `still_active` | `recovered_result` | `interrupted_no_changes` | `interrupted_partial` | `indeterminate`
- Runtime evidence:
- Repository evidence:
- Recovered changed files:
- Unverified remainder:

### Review section (Reviewer only)

Verdict: `APPROVED` | `CHANGES_REQUESTED`

Blocking:

1. …

Non-blocking:

1. …

---

## Log

_(empty — first worker entry goes above)_
