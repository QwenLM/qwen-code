# Workflow planned phases

[English](2026-11-18-workflow-planned-phases.md) | [简体中文](2026-11-18-workflow-planned-phases.zh-CN.md)

Status: proposed, implemented in the same change.

## Problem

A workflow script fixes its plan before it runs, but the execution view only
learns about a phase when the script reaches it. Until then the user sees
nothing past the current phase. A run that has not dispatched its first agent
shows only "Waiting for the first agent dispatch…".

The agents themselves cannot be listed in advance. `agent()` calls happen at
run time, and how many there are depends on earlier results. In the
`workflow-authoring` example, the Verify phase runs one agent per finding a
reviewer returns. Loops, branches, budgets and resume all change the set too.
What is known in advance is the phase plan: scripts declare it in
`export const meta = { phases: [{ title, detail? }] }`, and the approval
prompt already prints it.

## Current state

- `workflowPreLaunchGate` parses `meta` before the script starts, but the run
  registers with `meta: null`. `meta` is filled in only when the run settles.
- The task snapshot sent to clients carries `meta.name` and
  `meta.description` (as `label` and `description`), not `meta.phases`.
- The Web Shell execution view draws one lane per phase visit, so a phase has
  no lane until the script calls `phase()` with its title.

## Goals

- Show every declared phase from the start of a run, including the ones the
  script has not reached, with its `detail`.
- Never invent agents or counts for a phase that has not started.

Non-goals: predicting agents from the script source, changing the TUI, and
changing the execution view's layout beyond the new lanes.

## Design

1. **Core.** The runner registers the run with the meta the pre-launch gate
   already parsed, instead of `null`. The entry's label and description then
   use `meta.name` from the start of the run instead of only after it settles.
2. **Wire.** Live and saved workflow task snapshots gain an optional
   `plannedPhases: { title, detail? }[]`, copied from `meta.phases` in order.
   It is absent when the script declares no phases. The phase `model` stays
   off the wire, because the execution view does not use it. The field is
   added to `ServeSessionWorkflowTaskStatus` (acp-bridge) and
   `DaemonSessionWorkflowTaskStatus` (SDK) as `ServeWorkflowPlannedPhase` /
   `DaemonWorkflowPlannedPhase`. An older daemon simply does not send it, so
   no capability flag is needed.
3. **Web Shell.**
   - While a live run is `running`, `paused` or `pausing`, every declared phase
     whose title no phase visit carries yet gets a lane after the visited
     ones, in declaration order.
   - A planned lane has a dashed heading, reads "Not started" instead of a
     dispatch count, and shows its `detail`.
   - When the script reaches the phase, the visit's lane replaces it.
   - A run with planned lanes but no dispatches shows those lanes instead of
     the waiting text.
   - Planned lanes count toward the existing lane render limit.

## Decisions

- **Match by exact title.** The authoring guidance asks scripts to pass
  `phase()` the declared title, and the registry records the title it is
  given, so exact equality is the rule clients can rely on. A phase called
  with a title the meta does not declare still gets its own lane, as today.
- **Only while the run can still reach the phase.** A finished, failed or
  cancelled run, and any saved run, does not show unreached phases. The
  script did not reach them, and "Not started" would suggest it still might.
- **No placeholder agents.** A planned lane stays empty: an agent count before
  the phase runs would be a guess.

## Risks

- Labels change earlier: the TUI pill and dialogs show `meta.name` during the
  run instead of the run id. This is the same value they show once the run
  settles.
- A script whose `phase()` titles differ from its declared titles shows both
  the planned lane and the visited lane until the run ends.

## Validation

- Core: registering a run puts the script's meta on the entry before the first
  phase starts.
- CLI: live and saved snapshots carry `plannedPhases` (title and detail only)
  and omit it when no phases are declared.
- Web Shell: layout adds planned lanes after the visited phases, skips reached
  titles, and drops them for terminal or saved runs. A run with no dispatches
  renders planned lanes instead of the waiting text.
- E2E: a real daemon run of a three-phase script shows all three lanes before
  the second phase starts, and the planned lanes disappear once the run ends.

## Acceptance criteria

- A running workflow with `meta.phases` shows every declared phase from its
  first snapshot.
- No lane shows a count or an agent for a phase that has not started.
- Runs without `meta.phases`, finished runs and older daemons look as before.

## Follow-up

- Show planned phases in the TUI workflow detail.
- Carry planned phases into whichever main form the execution view redesign
  adopts.
