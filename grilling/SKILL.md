---
name: grilling
description: >
  Human-in-the-loop discovery that turns ambiguous work into explicit decisions
  and an execution-ready plan before implementation. Use for architecture,
  feature design, refactors, bug-fix planning, requirement clarification, or
  whenever the user asks to "grill" a task or stress-test a plan. Supports a
  deep Architect-led mode (/grilling) and a quick Orchestrator-led mode
  (/grillme or equivalent quick-grilling intent).
compatibility: >
  Portable across Agent Skills-compatible coding agents. Graphify is optional
  but preferred for repository context. A separate Architect agent is preferred
  for deep mode; if unavailable, the current agent may emulate the role boundary.
metadata:
  version: "2.0"
---

# Grilling

## Purpose

Grilling is a structured human-in-the-loop discovery process. Its job is to
turn an incomplete or fuzzy task into an agreed set of decisions and a plan
that another agent can execute without guessing.

Grilling is not implementation. It ends at an approved plan and handoff.

It also is not documentation for documentation's sake. Persistent artifacts
exist only when they preserve information that would otherwise be lost or
prevent future agents from reopening settled decisions.

## Modes

### Deep mode — `/grilling`

Use for work with architectural or cross-cutting consequences: new subsystems,
large refactors, data-model changes, integrations, migrations, security or
reliability trade-offs, or high uncertainty.

Preferred role flow:

`User -> Orchestrator -> Architect <-> User -> Orchestrator`

The Orchestrator prepares the ground. The Architect performs the deep discovery
and interview. The Orchestrator receives the approved package and owns the next
workflow step.

### Quick mode — `/grillme`

Use for bounded local work: a bug fix, a small feature, a limited refactor, or a
task where only a few decisions block a safe plan.

Role flow:

`User <-> Orchestrator`

The Orchestrator performs the discovery itself and returns a concise execution
plan.

### Invocation portability

The open Agent Skills format defines one skill name, not portable multi-command
aliases. Treat `/grilling` as the canonical skill entry point. If the host
supports aliases, `/grillme` may map to quick mode. Otherwise, requests such as
"grill me", "quick grilling", or an explicit request for quick mode select the
same behavior.

Honor an explicit mode choice. If quick mode reveals a genuinely cross-cutting
or hard-to-reverse decision, recommend switching to deep mode; do not silently
change modes.

## Role Contract

### Orchestrator

In deep mode the Orchestrator:

1. captures the task as stated by the user;
2. loads applicable project-level governing constraints;
3. refreshes Graphify when Graphify is available;
4. creates a small, purpose-built Architect handoff with concrete search
   directions;
5. transfers control to the Architect;
6. does not proxy the grilling conversation unless the harness requires it;
7. receives the approved Architecture Package afterward;
8. is the only role that persists approved project-document or workflow
   changes and performs downstream decomposition.

Do not turn the handoff into a repository dump. The Architect should receive
facts already known from the task plus directions for finding project context,
not the Orchestrator's whole conversation history.

In quick mode the Orchestrator performs the full grilling loop itself.

### Architect

In deep mode the Architect:

1. receives a clean, task-focused handoff;
2. gathers the required project context, Graphify-first when available;
3. builds and maintains the decision tree and Unknowns Tracker;
4. interviews the user directly;
5. drafts consequential ADR and glossary proposals when justified;
6. runs the consistency and coverage checks;
7. obtains explicit confirmation;
8. returns the approved Architecture Package to the Orchestrator.

The Architect does not implement code and does not persist project files. It
may maintain session-local working state and proposed artifacts during the
interview.

### Single-agent fallback

If the harness cannot spawn a separate Architect, the current agent may run the
Architect phase itself. Preserve the same boundaries and explicitly return to
an Orchestrator phase before persisting anything. Do not claim to have a clean
context if the host cannot provide one.

### Headless task-agent adapter

When the Architect cannot access an interactive user tool, including an OMP
task-agent run, preserve deep mode through explicit relay iterations:

```text
Human <-> Orchestrator <-> fresh Architect iterations
```

Treat the Orchestrator as a transparent relay during the interview:

- do not answer Architect questions on the Human's behalf;
- do not reinterpret the available choices or silently choose a recommendation;
- relay only the current material question frontier;
- return exact Human answers plus the latest grilling checkpoint to a fresh
  Architect run;
- keep workflow state blocked until the Confirmation Gate passes.

Before yielding for Human input, the Architect returns the material questions
and an Interrupted-Session Checkpoint from `references/FORMATS.md`. The next
fresh Architect continues from that checkpoint rather than repeating discovery.
The final Architecture Package still returns only after explicit Human
confirmation.

## Language

The skill instructions are English for portability.

User-facing dialogue follows the user's language, inferred from the current
conversation without asking when it is obvious. In deep mode, the Orchestrator
passes the language in the handoff.

Persistent project artifacts follow the project's existing documentation
language and conventions. If the project has no established documentation
language, default to English.

## Governing Project Context

Before the first question, load any applicable non-negotiable project guidance:
project constitution, AGENTS.md/CLAUDE.md-style instructions, architecture
principles, legal or security constraints, brand rules, or equivalent files.

Do not re-ask decisions that are already fixed by governing context.

If the user's requested decision conflicts with a governing constraint, surface
the conflict explicitly and stop that branch for human resolution. Do not
silently override either side.

If no governing project context exists, continue normally.

## Context Acquisition

### Graphify-first, not Graphify-only

If Graphify is installed for the project, use it as the primary navigation and
relationship layer.

In deep mode, the Orchestrator MUST refresh Graphify using the installed
Graphify workflow before handing off to the Architect, unless the graph is
already demonstrably current. The Architect then uses focused graph queries to
orient itself around the task.

Graphify is an index and reasoning aid, not a prohibition on source inspection.
After graph orientation, inspect the smallest relevant source/document slice
when needed to verify a high-impact claim, resolve ambiguity, investigate a
stale/inferred edge, or obtain implementation-level evidence.

Never read the whole repository merely to feel informed.

If Graphify is unavailable, stale and cannot be refreshed, or does not cover the
needed material, degrade gracefully to targeted repository/document exploration.
Record the limitation; do not block grilling and do not pretend Graphify was
used.

See `references/GRAPHIFY.md` for the integration contract.

## The Grilling Engine

### 1. Build a decision tree

Represent the task as dependent decisions. Each node is one of:

- resolved by project evidence;
- decided by the human;
- accepted as an explicit assumption;
- pending;
- immaterial to the plan.

Rebuild the tree after every answer or meaningful discovery. New information
may invalidate or eliminate downstream questions.

The tree is working state. Do not print the full tree after every turn unless it
helps resolve confusion or the user asks for status.

### 2. Ask only available questions

A question is available only when its prerequisites are settled.

Do not ask the user for:

- facts already present in governing context;
- facts already established by Graphify, code, tests, docs, or prior answers;
- questions that can be answered by targeted investigation;
- implementation trivia that does not affect the plan;
- decisions whose prerequisites are still unresolved.

The human should spend attention on judgment, intent, priorities, trade-offs,
and genuinely ambiguous product or architecture choices.

### 3. Work the frontier adaptively

The **frontier** is the set of currently available unresolved decision nodes.

Do not use a fixed number of rounds as a completion target. Convergence, not
ceremony, ends the interview.

- Ask one question when it is high-impact, nuanced, or likely to reshape the
  rest of the tree.
- Batch a small set of independent frontier questions when their answers cannot
  affect one another. Keep the batch easy to scan; normally 2-4 questions.
- Quick mode should be especially compact and stop as soon as the blockers are
  gone.
- Never dump future questions whose prerequisites are unresolved.

### 4. Every human decision gets actionable options

Prefer 2-4 concrete options plus a free-form escape hatch. Mark one option as
**recommended** when the evidence supports a recommendation and state the basis
briefly.

A good recommendation is grounded in at least one of:

- the user's stated goal;
- project constraints;
- existing project patterns;
- Graphify/code/document evidence;
- a clearly explained engineering trade-off.

If the evidence is insufficient, investigate first when possible. If it still
isn't sufficient, say that there is no responsible recommendation yet.

Do not manufacture a recommendation merely to satisfy the format.

### 5. Scale explanation to consequence

For a trivial local choice, keep the question compact.

For a consequential choice, include why it matters, trade-offs, and the main
risk of choosing incorrectly. Do not attach a full risk essay to every small
question.

See `references/FORMATS.md` for question templates.

## Unknowns Tracker

Maintain an Unknowns Tracker throughout the session.

Statuses:

- **EXPLORED** — resolved by project evidence rather than human choice.
- **ANSWERED** — explicitly decided by the human.
- **ASSUMPTION** — an assumption is being carried deliberately and has been
  explicitly accepted; it remains labeled as an assumption, not a fact.
- **PENDING** — unresolved and blocks the final plan.
- **IMMATERIAL** — unresolved but safely irrelevant to this plan.

Every EXPLORED item must retain a compact basis/source. For high-impact facts,
record enough provenance for the Orchestrator or a later agent to verify them.

Do not create an Unknowns Tracker entry for every minor detail. Track only
uncertainty that can change scope, behavior, architecture, sequencing, risk, or
acceptance criteria.

## Decision Log

For each material human decision, preserve:

- the question/decision;
- chosen option;
- rationale or basis;
- relevant rejected alternatives;
- downstream consequences, when material.

Rejected options matter because they prevent later agents from reopening a
settled branch without new evidence.

## ADR and Glossary Discipline

These are primarily deep-mode artifacts.

### ADR threshold

Draft an ADR only when the decision is all three:

1. meaningfully hard or costly to reverse;
2. non-obvious enough that a future engineer would reasonably ask why;
3. a genuine trade-off among viable alternatives.

If any condition is missing, keep the decision in the Decision Log instead.
Do not turn ADRs into a diary.

Draft ADRs as decisions crystallize, but do not persist them from the Architect
role. The Orchestrator persists approved ADRs after the handoff.

### Glossary threshold

Add a glossary proposal only when a term is project-specific, overloaded,
ambiguous, or needs a canonical meaning to prevent future confusion.

Do not document ordinary vocabulary. Keep glossary entries free of unnecessary
implementation detail unless the project's glossary convention says otherwise.

## Consistency and Coverage Check

Before the Confirmation Gate, inspect the current state for:

1. contradictions among accepted decisions;
2. conflicts with governing project context;
3. conflicts with Graphify/code/docs evidence;
4. stale or weak evidence behind high-impact EXPLORED items;
5. missing scope boundaries;
6. missing success/acceptance criteria;
7. unexamined failure, migration, security, data-integrity, compatibility, or
   rollback concerns when relevant to the task;
8. steps in the proposed solution that depend on an unresolved PENDING item.

Surface material problems and return to grilling. Do not hide them in the final
plan.

## Confirmation Gate

A final plan may be produced only when BOTH are true:

1. no blocking PENDING items remain;
2. the human explicitly confirms the agreed-understanding summary.

Non-blocking uncertainty must be labeled IMMATERIAL or explicitly deferred; it
must not masquerade as resolved.

Use the gate format in `references/FORMATS.md`.

## Outputs

### Quick mode

Return an **Execution Plan**: agreed scope, decisions, implementation steps,
dependencies, verification/done-when criteria, risks, and any accepted
assumptions.

### Deep mode

Return an **Architecture Package** to the Orchestrator: agreed scope and success
criteria, relevant project evidence, decisions, proposed ADR/glossary updates,
solution structure, implementation phases, risks, assumptions, and explicitly
deferred non-blocking items.

The package is for orchestration and decomposition. It should be precise enough
that downstream agents do not need to repeat the grilling interview.

Formats are in `references/FORMATS.md`.

## Stop and Checkpoint

If the user stops before confirmation, do not fabricate a plan. Produce a
checkpoint containing the current task, decisions, rejected alternatives,
Unknowns Tracker, evidence references, and the next available frontier.

## Anti-Patterns

- asking the human something the project can answer;
- treating Graphify as infallible or forbidding targeted source verification;
- wandering through the whole repository before asking anything;
- batching dependent questions together;
- forcing a fixed number of rounds after the task has converged;
- generating a recommendation without evidence;
- treating assumptions as facts;
- creating ADRs for routine choices;
- dumping the decision tree or trackers into every reply;
- allowing the Architect to persist project files or start implementation;
- letting the Orchestrator pass a vague "figure it out" handoff;
- generating a plan before explicit confirmation;
- continuing to grill after all material uncertainty is resolved.

## Reference Files

- `references/FORMATS.md` — handoff, question, tracker, gate, output, ADR,
  glossary, and checkpoint formats.
- `references/GRAPHIFY.md` — Graphify integration and fallback rules.
