# Graphify Integration Contract

This skill does not reimplement Graphify. Use the project's installed Graphify
skill, CLI, MCP tools, hooks, and update procedure as their own source of truth.

## When Graphify is available

### Deep mode

Before the Architect begins project exploration, the Orchestrator should:

1. determine whether the graph is current enough for the task;
2. refresh/update it through the installed Graphify workflow when needed;
3. hand the Architect concrete task-specific graph questions, not a generic
   "read the graph" instruction;
4. record `Graphify status: FRESH` in the handoff when successful.

The Architect should then:

1. query the smallest relevant subgraph first;
2. use relationships/paths to identify affected components and likely blast
   radius;
3. use the graph to locate existing patterns and constraints;
4. verify high-impact or ambiguous claims against targeted source/docs when
   needed;
5. cite or record the basis of material EXPLORED items in the Unknowns Tracker.

### Quick mode

Do not refresh Graphify mechanically for every tiny task. Query it when project
context is needed; refresh only when the relevant graph state may be stale or
the task depends on recently changed code.

## Freshness and uncertainty

Treat the graph as a snapshot of the project.

If Graphify reports or appears stale for relevant files:

- refresh it if the installed workflow can do so safely;
- otherwise mark the graph status STALE and use targeted source inspection for
  the affected facts.

If a graph edge is inferred, low-confidence, ambiguous, or surprising, do not
promote it to a hard architectural fact without verification when the decision
is consequential.

## When Graphify is unavailable

Set `Graphify status: UNAVAILABLE` and continue with targeted project discovery:

1. governing project docs/instructions;
2. focused search for named components and interfaces;
3. relevant tests/contracts/configuration;
4. only the source slices needed to resolve the current decision frontier.

Never fail the entire grilling workflow merely because Graphify is absent.

## Anti-patterns

- reading the full graph report when a focused query is enough;
- copying graph output wholesale into the Architect handoff;
- treating Graphify as fresher than the code without checking;
- refusing to inspect targeted source after graph orientation;
- bypassing Graphify entirely when it is available and clearly useful;
- rebuilding or refreshing the graph repeatedly with no freshness reason.
