# Context Economy Experiment

This policy is an experimental overlay on Pavan's Workflow v3.1.4. It reduces
Main-session prompt growth without changing canonical workflow authority,
worker scopes, or verification gates.

## Authority

`workflow_context`, dashboard state, compaction summaries, and conversation
history are derived navigation aids. They never replace:

1. authoritative plan files named by `PROJECT_CONTEXT.md`;
2. `STATE.yaml`;
3. `STEPS.md` and `DECISIONS.md`;
4. relevant feedback/reports;
5. repository source, status, diff, tests, and artifacts.

## Full versus targeted reconciliation

Perform full reconciliation at:

- initial startup or resume;
- `/workflow status`;
- Human interruption or steering;
- Alt+Q Main-model switch;
- compaction recovery when the anchor is incomplete or contradictory;
- canonical hash drift;
- active-worker/runtime disagreement;
- ambiguous evidence or gate transition;
- experiment install, update, rollback, or OMP restart.

For an ordinary transition, call `workflow_context` first. Then read only:

- the active step and stable work-item IDs;
- exact target/changed source files;
- exact Objective/Judgment gate evidence;
- canonical files whose hash changed or whose detail is required;
- exact `agent://` fields or artifact ranges needed to verify the result.

Escalate to full reconciliation immediately when targeted evidence is
insufficient. Economy never outranks correctness.

## Floating 23-28% compaction window

The project config sets OMP's native threshold to 28%. The extension adds an
opportunistic soft boundary at 23%:

```text
below 23%        normal operation
23% to 28%       armed; compact at first safe idle boundary
28% and above    native OMP threshold maintenance owns recovery
18% or below     re-arm latch resets
```

A safe boundary requires:

- interactive Main session;
- Main idle;
- no running/pending workflow worker;
- no queued Human messages;
- no compaction already running;
- cooldown expired.

The configured method order is:

```text
shake -> soft
```

`shake` removes recoverable heavy content locally. `soft` creates a portable
text summary suitable for switching between providers. Provider-native remote
compaction, speculative async compaction, idle timers, and context promotion are
disabled for this experiment.

Manual `/compact` aborts the current Main operation before compaction. Never run
it while a worker is active. The floating controller calls OMP only from a safe
idle boundary and does not interrupt workers.

## Compaction anchor

`session.compacting` injects a bounded derived anchor containing:

- canonical and live step;
- current work item and next actor;
- open Do/Objective/Judgment items;
- active worker and model/tool counters;
- last Human instruction;
- context percentage and controller phase;
- canonical file hashes;
- capped git status paths.

After compaction, Main must verify the anchor against canonical files and real
repository evidence before changing gates or routing.

## Main model toggle

The experiment config limits role cycling to:

```yaml
cycleOrder:
  - workflow_orchestrator
  - workflow_orchestrator_backup
```

The installer adds Alt+Q to OMP's built-in `app.model.cycleForward` action while
preserving Ctrl+P and existing custom chords. Because built-in role cycling is
used, role-specific thinking/routing suffixes continue to apply.

Alt+Q is explicit Human authorization to switch Main. It does not change a
running worker model or count as a product attempt. Reconcile before the next
routing decision.

## Evidence economy

- Read exact `agent://` structured fields before opening a full transcript.
- Use full `history://` only for recovery, contradiction, or Human inspection.
- Keep retry memory to verified facts, not narrative history.
- Put large logs/diffs/captures in artifacts and return path, hash, command,
  result, and a bounded excerpt.
- Use OMP checkpoint/rewind for long Main-only research when available.
- Use `/fresh` only for provider-side session trouble; it does not reduce local
  conversation context.

## Observability

Alt+W and `/workflow-context-economy` expose:

- current tokens/window/percentage;
- 23-28% floating window;
- controller phase and wait reason;
- method order;
- last before/after token counts;
- last error when present.

`/workflow-context` prints the complete compact navigation snapshot.
