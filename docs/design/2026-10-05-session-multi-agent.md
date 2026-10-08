# Session multi-agent collaboration

[English](2026-10-05-session-multi-agent.md) | [简体中文](2026-10-05-session-multi-agent.zh-CN.md)

## Status and scope

- **Status:** implemented in PR #13467, behind `experimental.agentCollaboration` (default off).
- **Section numbers:** code comments cite sections of this document as `session-multi-agent design §N`.
- **Decisions:** the product decisions are dated 2026-10-05 and listed in §8.
- **Squads:** the squad decisions are dated 2026-10-06 and listed in §11.

**In scope:**

- @-mentioning agents inside an ordinary chat session.
- Local and remote agents running Qwen Code, Claude Code or Codex.
- Agent-to-agent mentions.
- In-session approvals.
- Joining a coordinator without a restart.
- Squads.

**Out of scope:**

- **Removing the earlier thread-based collaboration backend.** It is kept, with no UI. Its removal is a follow-up PR (§6).
- **Moving A2A onto sessions.** Also in that follow-up PR (§6).
- **Attachments on mentions.** Refused for now (§8-6).
- **Managed (hosted) sessions.**

## 0. Goals

- @-mention an agent in an ordinary chat session, and it answers in that session, streaming. Nothing creates a thread or navigates away.
- An agent is its own process, on this machine or a remote one. Its program is Qwen Code, Claude Code or Codex.
- Agents can @-mention each other in the session, both by text and by tool (`session_send`).
- A remote agent has every capability a local one has: streaming, tool approvals, and the same states (queued, running, awaiting approval, stalled, offline, failed).
- An already-running `qwen serve` can join another instance as a runtime, without a restart or an extra process.
- Repeated mentions of the same agent in one session resume its native session. Different sessions stay independent.

## 1. Background

The earlier design routed a mention into a separate collaboration thread:

1. it created a ticket-like thread, with status, priority, acceptance and budgets;
2. it copied the last few messages into that thread as context;
3. it moved the person to a thread page.

Remote Hosts were also limited. They ran Qwen only, read-only, refused every approval, and reported folded progress snapshots instead of a live stream.

That model did not match the product intent: the conversation the person is having _is_ the place agents collaborate. This design replaces it with session-native records and a per-(session, agent) orchestrator.

## 2. Non-goals

- No project boards, tickets or work-item state machines.
- No copying of context into another container. An agent reads the session itself, through its read cursor (§9.1).
- No auto-approval. Every approval an agent needs is put to the person (§3.3).

## 3. Target shape

### 3.1 Layers

```
WebShell ──HTTP/SSE──▶ coordinator `qwen serve` ◀──outbound HTTP── remote `qwen serve` (runtime / Host)
                         │ orchestrator, per (session, agent)       │
                         │ session event stream, approvals          │
                     local adapters                            local adapters
               qwen (ACP) · claude (stdio) · codex (stdio)   qwen (ACP) · claude (stdio) · codex (stdio)
```

- **Session.** An ordinary chat session. Its participants are the person, the session's own Qwen, and any mentioned agents.
- **Binding.** One per (session, agent). It holds the native session id, the runtime and program that own it, the read cursor, and the run state.
- **Orchestrator (daemon).** Queues and coalesces runs, starts them, publishes live events and state, relays approvals, and recovers after a restart.
- **ACP child of the session.** The only writer of the session's records. It persists the `agent_mention` and `agent_message` records and adds them to Qwen's model history.
- **Transcript projection (`transcript-replay`).** Rebuilds authored agent messages on reload, `/resume` and export.

### 3.2 One mention, end to end

1. The person sends `@claude-b look at this bug`. The message is recorded as an `agent_mention`. When only agents are mentioned, Qwen does not answer this turn.
2. For each mentioned agent, the orchestrator starts a run if the agent is idle. If it is busy, the mention coalesces into the agent's single queued run.
3. The input is the session content after the agent's read cursor, within a budget, plus the triggering message. If the binding has a native session id, the run resumes it.
4. A local agent runs through its adapter. A remote agent's turn is leased to its Host, whose own adapter runs it and streams the events back over HTTP.
5. The orchestrator publishes the events to the session's event stream: author, state, steps and tokens. The web shell shows them as an authored message in progress.
6. At the end, the orchestrator asks the session's ACP child to write an `agent_message` record through the `qwen/control/session/external_record` extension method. The record is durable and enters Qwen's history, but it starts no Qwen turn. While a Qwen turn is running, the write is deferred until that turn ends.
7. A reply that @-mentions another agent, or a `session_send` call that names one, goes back to step 2, subject to the chain budget (§8-7).

### 3.3 Approvals

An agent's permission request becomes an approval card on its own message in the session. It is owned by the agent's run, not by a Qwen turn. The person's vote is sent back to the local adapter, or down to the Host for a remote run.

| Program | How it asks                                                                                                                                                                                                                                            | Options offered                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Qwen    | ACP permission requests. Overlapping requests are put to the person one at a time.                                                                                                                                                                     | Allow, Reject. No "always": the hidden session is pinned to the default approval mode, so an "always" grant cannot take effect there. |
| Claude  | `--permission-prompt-tool stdio`. Each `control_request` `can_use_tool` waits for the person.                                                                                                                                                          | Allow, Deny. The preview shows the input that will actually run: a background flag is forced off before it is shown.                  |
| Codex   | `codex app-server` with `approvalPolicy: on-request` and `sandbox: read-only`, re-sent on every `thread/resume`. Every write, and every command that must leave the read-only sandbox, asks. Read-only commands run inside the sandbox without asking. | Allow, Allow for the rest of this chat, Deny.                                                                                         |

- Inactivity timeouts pause while a run awaits approval.
- A stop answers pending and late requests as cancelled.
- A restart that loses a pending approval fails the run as retryable.

### 3.4 States

An agent's message shows one of these states:

- queued (with its position)
- running (with live steps)
- awaiting approval
- stalled
- completed
- failed (with a reason)
- offline (its Host lease expired)

Live state is not in the transcript. After a reload, the web shell fetches the current run snapshot from the orchestrator. Failed and offline runs, and runs whose reply never reached the transcript, can be retried or dismissed.

### 3.5 Joining

| Situation                     | How the runtime joins                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| The remote is already running | From its web shell ("Join a coordinator") or `qwen agents join <link>`. Both call the remote's own `/hosts/connect`. |
| The remote is not running     | `qwen serve --join <link>`.                                                                                          |

- The runtime routes do not depend on the boot-time collaboration flag; only authentication is required (§8-5).
- Connections persist and reconnect after a restart.
- After joining, the Host probes for the local CLIs. The coordinator creates one agent per available program, named like `claude-<machine>` (§8-4).
- The Host protocol is v2:
  - enroll, heartbeat, pickup;
  - ordered event batches;
  - result;
  - a long-poll for decisions.
- Leases are 60 s, keyed by lease id and attempt.
- A v1 Host is refused at heartbeat with an upgrade hint.

## 4. Changes by layer

### 4.1 core

- **Session records:** chat-record subtypes `agent_mention` and `agent_message`. Each carries an author, display text, status, steps, tokens, and squad fields where relevant. They are excluded from turn counting, titles, resume trimming and orphan cleanup.
- **Model-facing envelope:** the envelope wraps agent messages for the model. It marks the source, escapes tags, states the authority boundary, and truncates. This text needs an eval before release (§10).
- **Session-agent store:** a per-session binding file, plus an index of the sessions that have live runs.
- **`session_send` tool:** built in for Qwen. Claude and Codex get it as a stdio MCP server.
- **Personas:** Qwen session agents enforce the definition's tool restrictions, behind approval (§8-1). Native Claude/Codex runtimes cannot enforce Qwen tool allowlists or denylists, so a linked definition with tool restrictions is refused before starting a turn; use Qwen for that definition. Omitted or empty `tools`, and `tools: ['*']` without a denylist, inherit the native runtime's tools.

### 4.2 acp-bridge and the ACP child

- **Record writes:** the `external_record` extension method writes a record without starting a turn. It defers the write while a turn is running.
- **Projection:** `transcript-replay` projects agent records as authored messages. They use the live stream's segment ids (`agent:<runId>`, `mention:<recordUuid>`), so a reload does not duplicate them.

### 4.3 daemon (`packages/cli/src/serve`)

- **Orchestrator:**
  - one live run per (session, agent), coalescing;
  - read cursors;
  - native-session reuse only when the runtime and program match;
  - the chain budget;
  - restart recovery.
- **Adapters:** `qwen-acp`, `claude-cli` and `codex-app-server`. A remote Host runs the same adapters.
- **Routes:**
  - mention;
  - runs snapshot;
  - stop and retry;
  - squads;
  - Host v2;
  - join.

### 4.4 SDK

Typed `qwenAgentMessage` metadata and the session-agent views.

### 4.5 Web shell

- Mentions post inline. There is no navigation and no context copy.
- Agent messages render with their author, state, steps, tokens and approvals.
- A session-wide "Stop all agents" button.
- The Agents page has three views: Agents, Squads and Runtimes.

## 5. Risks

- **Write ownership.** Only the session's ACP child writes records, so a record for an unloaded session must load that session first.
- **Turn boundaries.** Writing into history during a Qwen turn would break turn structure, so those writes are deferred.
- **Agent output in Qwen's history.** It costs context budget and is a prompt-injection surface. Hence the envelope, and the eval it needs.
- **Shared working directory.** A local agent with write access shares the session's working directory. Approval mitigates this, but does not remove it.

## 6. Rollout

- **This PR:** the session-native collaboration. The thread backend is kept with no UI, and A2A stays on threads.
- **Transitional limit:** a thread run assigned to a remote agent cannot run until A2A moves to sessions, because Host v1 is replaced by v2. A2A refuses such a request as `unsupported`.
- **Follow-up PR:** remove the thread backend and move A2A onto sessions. One A2A task becomes one agent turn in a session, with `contextId` set to that session.

## 7. Acceptance

The acceptance runs on two real machines:

1. A runtime joins without a restart, and its programs appear as agents.
2. Several agents answer inline in one session, and Qwen stays quiet.
3. Agent-to-agent handoff works, both by text and by `session_send`.
4. Remote writes ask for approval, and the decision is honoured.
5. Agent messages survive reload, `/resume` and export, and a resumed agent remembers earlier turns.
6. Sessions stay independent.
7. Stop and retry work.
8. Offline recovery and restart recovery work.

## 8. Decisions (2026-10-05)

1. **Tools.** A session agent may use every tool. Writes and execution go through in-session approval.
2. **Programs.** Claude and Codex run through their native CLI interfaces (§3.3).
3. **One process per turn.** Each turn starts a new process and resumes the agent's native session through its id. A native session never has two processes at once: per (session, agent) there is at most one executing run and one queued run, and later mentions coalesce into the queued one.
4. **Agents for joined runtimes.** Joining creates one agent per available program on the runtime.
5. **Joining without the boot flag.** Being joined as a runtime does not depend on the boot-time collaboration flag.
6. **Attachments.** Attachments on mentions are refused for now.
7. **Chain length.**
   - The chain limit is a setting, `experimental.agentChainLimit`. Its default is 0, which means unlimited.
   - Runaway loops are bounded by the session token budget, `experimental.agentTokenBudget` (default 1,000,000; 0 means unlimited). The budget resets when the person posts.
   - A turn that reports no tokens is charged 10,000, so a loop without usage data still ends.
   - Every agent message shows its token use.
   - "Stop all agents" is visible whenever an agent is running.

## 9. Gaps closed during design

### 9.1 Read cursor

- **Anchor.** The read cursor is anchored on a chat-record id. Compression rewrites model history, not records, so the anchor is stable.
- **What the agent receives:**
  - user text;
  - Qwen's reply text;
  - other agents' messages.

  Tool inputs and outputs are not included. The content is truncated to a budget, keeping the opening and the most recent part.

- **Reset.** The cursor resets when the native session cannot be reused, for example after a Host or program change, or when a resume is rejected.

### 9.2 Mention-only messages

A message that mentions only agents is recorded without starting a Qwen turn. Qwen answers only when it is addressed too.

### 9.3 `session_send` for remote Claude and Codex

The MCP server runs on the Host. It forwards calls over a loopback relay to the Host daemon, which forwards them to the coordinator. The relay refuses text the record writer would refuse, so the model is never told a dropped post was sent.

### 9.4 Approval protocol probe

These were verified against the real CLIs during acceptance:

- **Claude:** `can_use_tool` arrives, and allow and deny are honoured.
- **Codex:** `on-request` with the read-only sandbox asks for writes, and the person's choice is honoured.

### 9.5 Shared working directory

See §5.

## 10. Known limits and follow-ups

- **Model-facing text needs an eval before release.** This covers:
  - the envelopes;
  - agent identity;
  - the squad leader briefing;
  - the `session_send` description.
- **Hidden agent sessions skip managed-memory extraction.** An agent turn is not the person's conversation.
- **Removing the thread backend and moving A2A onto sessions.** This is the follow-up PR (§6).

## 11. Squads (2026-10-06)

A squad is a leader agent plus member agents, each member with an optional role.

- `@squad` wakes only the leader.
- The leader coordinates rather than doing the work itself. It @-mentions members, then ends its turn.
- Each member's reply wakes the leader again, to decide the next step or report.

### 11.1 Data

- **Storage.** Squads live in `squads.json`, next to the agent roster and under the same lock: `{id, name, description?, instructions?, leaderAgentId, members: [{agentId, role?}], createdAt, retiredAt?}`.
- **Names.** Squad names share the agent namespace and follow the same naming rules.
- **Members.** Members are agents only, local or remote, running any program.

### 11.2 Engagement

- **Start.** A mention of a squad opens an engagement in the session and queues a leader turn that includes the squad briefing.
- **Members the leader mentions.** They become outstanding runs. The member's run records its squad, so its reply shows the squad label.
- **Member replies.** Each one wakes the leader:
  - wakes that arrive together coalesce into one leader turn;
  - a wake owed across a daemon restart is persisted and restored;
  - retrying a member carries its owed wake to the new run.
- **End.** The engagement ends when the leader finishes with no new delegation and nothing outstanding.
- **Concurrency.** A session may have several engagements at once.
- **Cost.** Every leader wake is a hop and counts against the session token budget.

### 11.3 Leader briefing

The briefing goes at the start of the leader's turn input, the same for every program. It includes:

- the squad's name and instructions;
- the members, with roles, program and runtime, all escaped;
- the coordination rules: delegate with `@member`, keep it short, end the turn after delegating, and reply with nothing when no action is needed.

This is model-facing text and needs an eval.

### 11.4 No action

A leader reply that is empty (whitespace or invisible characters only) is recorded with `squadOutcome: 'no_action'`. It renders as one muted line, not a bubble.

### 11.5 UI

- **Agents page, Squads view:** a card per squad that shows the chain of command (the leader, with members on a rail and their roles in one column), plus create, edit and retire.
- **@ picker:** lists squads.
- **In chat:**
  - a squad tag on leader and member replies;
  - a status bar for each running engagement, with one status per participant.

### 11.6 Relation to task acceptance

The leader naturally confirms the goal and reports back. No new state machine is added.

### 11.7 A2A and remote

- A2A does not expose squads.
- Leaders and members can be remote agents, with no protocol change.

### 11.8 Decisions

1. Members are agents only.
2. Every member reply wakes the leader.
3. With no action needed, the leader stays silent (the muted line).
4. Several engagements may run in one session at once.
