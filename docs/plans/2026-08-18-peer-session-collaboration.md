# Peer session collaboration for Qwen Code

> Status: Proposed — design only, no implementation
> Baseline: `179c8f80fd` (`origin/main`, 2026-08-18)
> Supersedes: the fleet architecture proposed in [#8719](https://github.com/QwenLM/qwen-code/pull/8719) (closed unmerged; never landed in the repository)
> Related: [#8724](https://github.com/QwenLM/qwen-code/issues/8724) (open umbrella),
> [#8728](https://github.com/QwenLM/qwen-code/pull/8728) / [#8730](https://github.com/QwenLM/qwen-code/pull/8730) (closed unmerged),
> [#8718](https://github.com/QwenLM/qwen-code/issues/8718) (closed not-planned), [#9276](https://github.com/QwenLM/qwen-code/issues/9276) (open)

## 0. Decision summary

Agents that are **already running** should be able to collaborate. Not "a leader spawns
workers" — that exists and works. The missing capability is: two sessions started
independently, by different people or at different times, in different working
directories, discover each other and share work.

The design rests on one relocation:

> **Authority moves from `TeamManager`'s in-memory state to the files under `~/.qwen/`.
> Sockets become an optimization, never a correctness requirement.**

Everything else follows. Once the durable board is authoritative rather than a mirror,
cross-process participation is not a feature that must be built — it is what remains when
the in-process bottleneck is removed. The file plane is already cross-process safe
(§1.1); only two code paths currently pin it to one process (§1.2).

### 0.1 Three planes

| Plane            | Medium                         | Authority                | If it is unavailable                 |
| ---------------- | ------------------------------ | ------------------------ | ------------------------------------ |
| **Coordination** | Files + `proper-lockfile`      | **Authoritative**        | Collaboration stops                  |
| **Discovery**    | `~/.qwen/sessions/<pid>.json`  | Advisory (liveness hint) | Peers must be named explicitly       |
| **Transport**    | UNIX domain socket per session | **Optimization only**    | Delivery falls back to inbox polling |

The transport tier being non-load-bearing is the property that makes this design safe to
ship incrementally, and it is inherited from a fact already true in the code: the leader
already polls its own inbox, so teammate→leader messaging needs no socket for correctness.

### 0.2 Settled product decisions

| Decision            | Choice                                                                                                             | Rejected alternative and why                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **Topology**        | Peer. `leader` is a **role** — transferable, and validly empty                                                     | Owner-leader: makes an independently started session a second-class observer, which is the exact case this design exists for |
| **Membership**      | Two entrances: `spawn` (existing) and `join` (new). Neither is privileged                                          | Spawn-only: the current `TeamManager.ts:325` constraint, and the reason no running session can ever participate              |
| **Consent**         | Receiver-side gate with approval-mode parity, fail-closed ([#8730](https://github.com/QwenLM/qwen-code/pull/8730)) | Sender-side authorization: `from` is unauthenticatable on this transport (§2.5), so only the receiver can decide safely      |
| **Write conflicts** | Out of scope by construction: peers collaborate **across** workspaces                                              | Path-claim protocol: a joined peer's permissions were fixed by whoever started it; no member can demote another              |
| **Heterogeneity**   | Format stays vendor-neutral (it already is), but **v1 publishes no compatibility promise**                         | Either designing _for_ foreign agents (premature) or actively excluding them (costs work, buys nothing)                      |

Two consequences worth stating plainly:

- The consent gate is **load-bearing, not polish**. Nothing may deliver a cross-session
  message before it lands. This is [#8730](https://github.com/QwenLM/qwen-code/pull/8730)'s own
  receive-before-send argument and it is adopted verbatim.
- Because peers collaborate across workspaces, the single-writer invariant that
  `/coordinate` relies on is **not inherited**. Peer collaboration is advisory and
  read-heavy by construction. Same-checkout multi-writer stays unsupported (§4).

### 0.3 Why this replaces the fleet plan

The fleet plan proposed building a bespoke supervisor to host independent Qwen processes.
Three of its findings survive and are reused here: the semantic/terminal channel split
(§8), turn correlation, and the verification that the file lock model already supports
multiple processes. Its conclusion does not survive, for three reasons found since:

1. **The infrastructure it proposed to build already exists twice.** The daemon spawns
   independent sub-sessions with correlation today, and a 9,595-line process supervisor
   ships for channel workers (§1.4). The plan budgeted ~2,480 new production LOC for
   capabilities the repository already has in production.
2. **Its topology is the wrong one anyway.** Fleet is keyed one-fleet-per-project with a
   single-leader lock, and explicitly demotes "a second Qwen in the same repo" to a
   read-only roster viewer — precisely the participant this design is about.
3. **The cheaper answer was already written.** [#8724](https://github.com/QwenLM/qwen-code/issues/8724)
   implemented discovery and consent in 7,018 lines and was closed for process reasons,
   not design ones (§1.5).

## 1. Current implementation, traced

All line references at `179c8f80fd`.

### 1.1 The coordination plane is already cross-process

`tasks.ts` (1,056 LOC) and `mailbox.ts` (361 LOC) persist under `~/.qwen/` behind a
deliberate two-tier lock: an in-process `async-mutex` serializing local writers, wrapping
a `proper-lockfile` **cross-process** file lock (`retries: 30`, randomized backoff
5→100 ms, `stale: 5000`, `onCompromised` handler), over `atomicWriteJSON`.

The in-source rationale names the multi-process case directly: the mutex exists so local
writers "don't stampede the file lock", which is retained "to still guard against writers
in other agent processes."

`claimTask` therefore already implements **distributed claim** correctly. A crashed
holder's lock self-clears after the 5 s stale window, which also bounds recovery.

**No lock upgrade is required by anything in this document.**

### 1.2 Exactly two code paths pin it to one process

| Site                  | What it does                                        | Consequence                                        |
| --------------------- | --------------------------------------------------- | -------------------------------------------------- |
| `send-message.ts:221` | Route 2 requires `this.config.getTeamManager()`     | Teammate addressing needs an in-process object     |
| `TeamManager.ts:325`  | `this.teamFile.members.push(member)` — inside spawn | **Membership is only obtainable by being spawned** |

Route 1 (`task_id`, background tasks) already does _not_ go through `TeamManager`. The
in-process binding is not architectural; it is two call sites.

### 1.3 Discovery exists for liveness only — not for messaging

- `list_agents` reads `config.getBackgroundTaskRegistry()` — process-local. Its own empty
  message says so: _"No background agents are available in **this session**."_
- `SessionService.listSessions()` enumerates **persisted transcripts** (mtime cursors,
  pagination, JSONL), not live processes. It is deliberately never deleted, so its
  presence carries no liveness signal.
- Since [#8969](https://github.com/QwenLM/qwen-code/pull/8969) (merged 2026-08-17),
  `qwen sessions ps` answers "which Qwen sessions are running right now": the
  live-session registry (`packages/core/src/services/session-registry.ts`) writes
  `~/.qwen/sessions/<pid>.json` records, accepting only `<digits>.json` names.

The registry is a liveness index only — nothing reads it to route a message, and it
carries no inbound channel. That gap, not discovery itself, is what remains open.

### 1.4 Multi-process agent hosting already ships, twice

| Component                                             | Provides                                                                                                                                                                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serve/create-sub-session.ts`                         | Daemon spawns a **fresh top-level sub-session**, runs a prompt, returns a result. `promptId` correlation on the event stream, concurrency slots, idle reaping, transcript persistence, abort via composed `AbortSignal` |
| `serve/channel-worker-*.ts` (9,595 LOC)               | `fork()`, heartbeats, startup timeout, kill/stop grace, token + workspace env isolation, external tool guard, delivery/webhook IPC, diagnostics, worker groups                                                          |
| `acp-bridge/spawnChannel.ts` + `child-heap-policy.ts` | Per-child `--max-old-space-size` derived from system memory (50 %, capped 16 GB), `ProcessRegistry`, stderr forwarding with credential redaction                                                                        |

The per-child heap budget also disposes of the "N teammates share one 4 GB heap" concern
that motivates in-process teammate caps: independent processes do not share a heap.

Note the limitation honestly: a sub-session today is fire-and-forget and single-result
oriented — its own header states it is **"NOT kept resident"** and is reaped once idle.
Residency and in-flight inbound messaging are genuinely new semantics, not wiring.

### 1.5 The cross-session stack was written, then lapsed

[#8724](https://github.com/QwenLM/qwen-code/issues/8724) — _"let Qwen Code sessions on the
same machine message each other"_ — is **open**. Its implementation is not.

| PR                                                     | Scope                                                                | Outcome                     |
| ------------------------------------------------------ | -------------------------------------------------------------------- | --------------------------- |
| [#8728](https://github.com/QwenLM/qwen-code/pull/8728) | Liveness registry `~/.qwen/sessions/<pid>.json` + `qwen sessions ps` | **Closed, not merged** 8/12 |
| [#8969](https://github.com/QwenLM/qwen-code/pull/8969) | Same scope, re-landed: live-session registry + `qwen sessions ps`    | **Merged** 8/17             |
| [#8730](https://github.com/QwenLM/qwen-code/pull/8730) | UDS inbox + inbound gate + `/peers` (+7,018/−74, 57 files)           | **Closed, not merged** 8/12 |
| PR 3, PR 4                                             | Send side; broadcast removal                                         | Never submitted             |

Neither closure was a design rejection:

- #8730 was closed **voluntarily** to shrink the review surface — _"Nothing here is
  abandoned and nothing is lost — the branch stays, and this PR gets reopened once #8728
  lands."_
- #8728 was then closed because automated fixes bloated it — `session-registry.ts` went
  **379 → 1,235 lines**, and _"several of the remaining Critical findings are in code
  those fixes added rather than in the original change. Patching further is not
  converging."_ The author stated it would return rebased at roughly its original size.

The branch `feat/cross-session-inbox` still exists. The registry half of #8728 is now in
the tree via #8969 (`session-registry.ts`, `sessions ps`, `utils/process-liveness.ts`);
the messaging half is not — `packages/core/src/ipc/` and `packages/cli/src/peerMessaging/`
remain absent.

### 1.6 A native supervisor and PTY layer is being built right now

`packages/cli/src/agent-view/` — `supervisor-server.ts`, `supervisor-client.ts`,
`supervisor-store.ts`, `supervisor-process.ts`, `supervisor-runner.ts`,
`terminal-bridge.ts`, `protocol.ts` — 6,186 lines, with **zero references elsewhere in
`main`**. That reads as dead code and is not. It landed in
[#7799](https://github.com/QwenLM/qwen-code/pull/7799) (2026-08-01) as the base of a
five-PR series whose remaining four are open, non-draft, and actively maintained:

| PR                                                                       | Files touched under `agent-view/` |
| ------------------------------------------------------------------------ | --------------------------------- |
| [#7800](https://github.com/QwenLM/qwen-code/pull/7800) PTY workers       | 11                                |
| [#7801](https://github.com/QwenLM/qwen-code/pull/7801) session lifecycle | 17, incl. `protocol.ts`           |
| [#7802](https://github.com/QwenLM/qwen-code/pull/7802) commands          | 6, incl. `supervisor-runner.ts`   |
| [#7803](https://github.com/QwenLM/qwen-code/pull/7803) roster UI         | 0 — depends on the stack          |

The consumers are in the pending PRs. A tree-only reachability check cannot see them, and
concluding "unreferenced in `main`" means "abandoned" is a mistake this document made in
its first revision.

**This is a live conflict with §4, not a detail.** That series builds natively the terminal
and supervisor layer §4 says to leave to herdr. Both positions cannot hold. See §7.6.

(Distinct from `packages/cli/src/ui/components/agent-view/` — `AgentTabBar`,
`AgentChatView`, `AgentComposer` — which is live in `main` and is reused unchanged here.)

### 1.7 One bug class, one root cause

| Issue                                                                     | Redundant paths for one semantic                                                                   |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [#9276](https://github.com/QwenLM/qwen-code/issues/9276) (open)           | Control and content share `send_message`, split by an optional single-value enum `type`            |
| [#9282](https://github.com/QwenLM/qwen-code/issues/9282) (fixed by #9289) | Assignment via auto-claim scan **or** explicit owner; only the first was delivered                 |
| [#9283](https://github.com/QwenLM/qwen-code/issues/9283) (fixed by #9284) | Reporting via runtime auto-forward **or** explicit `send_message`; prompts described the wrong one |

Each defect sits on a seam between two overlapping paths where neither is authoritative.
The in-memory `TeamManager` state is the redundant copy impersonating the authority.

**Relocating authority to the file plane closes this class, and makes cross-session
participation fall out for free. They are the same change.**

## 2. Target architecture

### 2.1 Authority

```
                       ┌──────────────────────────────────────┐
   discovery (hint)    │      COORDINATION  (authoritative)   │
   ~/.qwen/sessions/   │   tasks · inboxes · team config      │
        │              │   files + proper-lockfile + atomic   │
        │              └──────────────────────────────────────┘
        │                    ▲              ▲              ▲
        │           poll/write│     poll/write│    poll/write│
        ▼                     │              │              │
   ┌─────────┐         ┌──────────┐   ┌──────────┐   ┌──────────┐
   │ session │         │ session  │   │ daemon   │   │ scheduled│
   │   A     │◀───────▶│    B     │   │ session  │   │  agent   │
   └─────────┘  UDS    └──────────┘   └──────────┘   └──────────┘
                (wake signal only — never the source of truth)
```

A participant is anything that can (a) read and write the board under the lock protocol
and (b) be woken. (b) is optional: polling is a correct, if slower, substitute.

### 2.2 Membership

`TeamMember` already carries what a joined peer needs — `agentId`, `name`, `joinedAt`,
`cwd`, `sessionId`, `subscriptions`. Its Qwen-specific fields (`agentType`, `model`,
`prompt`, `backendType`, `tmuxPaneId`, `planModeRequired`) are **all spawn parameters** —
how to start an agent — and all optional. `tmuxPaneId` is already degenerate ("empty
string for in-process").

Those fields exist because membership currently implies spawn. Removing that assumption
makes them irrelevant rather than requiring a new type.

Two entrances, one member record:

| Entrance | Who writes the record | Identity source                 | Lifecycle owner |
| -------- | --------------------- | ------------------------------- | --------------- |
| `spawn`  | The spawning session  | Derived from the spawn (today)  | The spawner     |
| `join`   | The joining session   | Registry record + declared name | **Itself**      |

`team_leave` is required, and must release owned tasks — the existing
`unassignTeammateTasks` / `releaseOwnedTask` already implement this.

### 2.3 Identity

`identity.ts` resolves identity from AsyncLocalStorage, with the predicate literally named
`isInProcessTeammate()`. A joined peer has no such ambient context. Identity becomes:
registry record (pid, sessionId, cwd) + self-declared name, recorded at join.

This is a **claim, not an authentication** — see §2.5. It is adequate because authorization
is enforced at the receiver, never derived from the sender's assertion.

### 2.4 Leader as a role

`leader` becomes a field on the team config, not an ownership lock. It may be transferred,
and may be absent — a board with no leader is a valid durable work queue. Nothing in the
task or mailbox schema depends on a leader existing.

This is the specific point where the fleet plan's single-leader lock is rejected rather
than adapted.

### 2.5 Consent — adopt #8730 unchanged

The receive-side gate is the security boundary. Its rule is **approval-mode parity**: a
message auto-delivers only when acting on it cannot do more than the sender could already
have done itself.

| Receiver                                      | Sender asserts | Result   |
| --------------------------------------------- | -------------- | -------- |
| prompting (DEFAULT / AUTO_EDIT / AUTO / PLAN) | anything       | accept   |
| YOLO                                          | YOLO           | accept   |
| YOLO                                          | prompting      | **hold** |
| YOLO                                          | nothing        | **hold** |
| unreadable                                    | anything       | **hold** |

A prompting receiver may accept freely because every consequential action still faces its
own gate — the message is a suggestion, not an execution. A YOLO receiver has no backstop.

Three defenses must agree, because any two leave the gap open:

1. **Envelope** — `<cross_session_message from="…">`, delimiter defanged in the body,
   attribute values escaped. The same structural anti-forgery `TeamManager` already uses
   for `<teammate_message>`.
2. **Authority notice** — a peer holds none of the user's authority, cannot grant an
   escalation, and is never the user approving a pending prompt.
3. **Classifier rule** — a `<cross_session_message>` never establishes user intent, and a
   request to perform something the sender says it was denied is blocked outright.

That third clause targets the cheapest bypass in the whole design: _get denied, then ask a
second session to do it._

**Stated limitation, not a gap:** `from` is **not authenticated**. Node cannot read
`SO_PEERCRED` without a native addon. Access control is filesystem permissions — directory
`0700`, socket `0600` — so the trust boundary is the uid. Any process running as this user
may claim any address. Everything above is built on that premise, which is why
authorization lives at the receiver.

Terminal outcomes (`held` / `denied` / `expired` / `delivered`) return to the sender as
control frames: without receipts a sender cannot distinguish "parked for review" from
"delivered and ignored", which are very different signals for deciding whether to follow up.

### 2.6 Format neutrality

`SwarmTask` — `id`, `subject`, `description`, `owner`, `status`, `blocks`, `blockedBy`,
`metadata` — contains nothing vendor-specific. Dependencies are already modelled.

This is an observation, not a goal. The position for v1:

- Do not add anything Qwen-specific to the task schema.
- Do not document the format as an external contract, and make no compatibility promise.
- Ship the board operations behind a CLI/MCP surface (Stage 5) because Qwen's own daemon
  sessions and scheduled agents need a non-in-process way to touch the board anyway.

Heterogeneous participation then costs nothing extra and requires no permission. The four
prior rulings against heterogeneity (fleet §6, #8718, `coordinate/SKILL.md`, the 8/13
closure) all target **hosting other vendors' CLI processes and terminals** — becoming
herdr. Publishing a format is not that: we host nothing, own no lifecycle, and grant no
permissions.

## 3. Communication flows

### 3.1 Discovery

Session writes `~/.qwen/sessions/<pid>.json` at startup, unlinks at exit. Directory `0700`.
Filename matched strictly against `^\d+\.json$` — a lenient `parseInt` prefix match makes
an unrelated `notes-2026.md` parse as PID 2026. Liveness = record present **and**
`isPidAlive(pid)` **and** `procStart` matches, so a recycled PID is not a phantom peer.

`qwen sessions ps [--json] [--all]` reads it. `list_agents` gains live peers alongside
background tasks.

### 3.2 Join

`team_join(team, as)` → verify team exists → write member record → register in the board.
No spawner involved. `team_leave` releases owned tasks.

Consent applies to _messages_, not to joining: joining is self-initiated, so there is no
third party to authorize. What must be gated is a peer being able to _pull_ another
session in — so v1 has **no remote-join**. A session joins itself, or a human joins it.

### 3.3 Work

Unchanged from today, and this is the point: `claimTask` already serializes across
processes. Assignment is a board mutation; delivery is a **derived consequence** of that
mutation. Exactly one function translates "board changed" into "someone is woken", and
nothing else may enqueue work. That single-writer rule is what #9282 was missing.

### 3.4 Delivery

```
sender ──▶ write inbox file (authoritative, under lock)
       └─▶ if peer has ipcPath: send wake frame (best effort)
receiver ──▶ on wake OR on poll ──▶ drain inbox ──▶ gate ──▶ deliver | hold | deny | expire
```

Losing the wake signal costs latency, never a message. Held messages are settled, never
stranded: the buffer is bounded and evicts oldest as `expired`; shutdown expires the
remainder; a message arriving during teardown is expired rather than parked where nothing
can release it; and changing approval mode re-runs the backlog, so a message held only on
a mismatch is released without manual approval.

`/peers` lists held messages with sender, preview and cause; `/peers accept|deny <id|all>`
settles them. Held messages are invisible to the model by design, so without a review
surface holding and dropping are indistinguishable from outside.

### 3.5 Reporting

A teammate's completion is **already** a board state transition. The leader does not need
a message to learn it. `send_message` is therefore reserved for what a task record cannot
express: blockers, questions, material interim findings.

This is what #9284 landed as prompt wording. Here it becomes the architecture that makes
the wording true.

### 3.6 Departure and crash

Clean exit: `team_leave`, release tasks, unlink registry record.
Crash: registry record is stale → liveness check fails → membership reaped; owned tasks
released after the 5 s lock stale window. No peer's death blocks any other peer.

## 4. Explicit non-goals

| Not building                             | Because                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PTY attach, terminal multiplexing, panes | herdr does this for 17+ CLIs, Apache-2.0, and measured faster (§8). This is a position, not a settled fact: #7800 is building PTY workers natively — contested in §7.6         |
| Hosting other vendors' processes         | That is becoming herdr. We publish a format; we host nothing                                                                                                                   |
| A new roster UI                          | This design reuses `ui/components/agent-view/`. But #7803 is building a second one at `ui/agent-view/`, so "already exists" is not a settled reason — disposition follows §7.6 |
| Remote / SSH / cross-machine             | Same-uid filesystem permissions **are** the security model. Off-machine voids it                                                                                               |
| Broadcast (`to: "*"`)                    | #8724 removes it rather than extending it to N processes                                                                                                                       |
| Same-checkout multi-writer               | A joined peer's permissions were fixed by whoever started it; no member can demote another                                                                                     |
| Central completion guarantee             | Peers decide what to claim. Unclaimed work stays visible on the board, not forced                                                                                              |
| Windows in the first cut                 | Follows #8724. The IPC path is abstracted so named pipes can be added                                                                                                          |

## 5. Build plan

Sized against demonstrated review capacity in this repository: #8804 merged at 775 lines;
#8859 (~1,300) and #8869 (4,465) both died unreviewed.

| Stage | Scope                                       | Est. prod LOC | Depends on | Independently valuable          |
| ----- | ------------------------------------------- | ------------- | ---------- | ------------------------------- |
| **0** | Cleanup and the #9276 fix                   | ~150          | —          | Yes — fixes a live blocker      |
| **1** | Discovery — **shipped by #8969**; carry-forward hardening only | ~0–100 | — | Done — `sessions ps` ships |
| **2** | Relocate authority to the file plane        | ~450          | —          | Yes — closes the §1.7 bug class |
| **3** | `team_join` / `team_leave` / leader-as-role | ~350          | 1, 2       | Yes — the actual feature        |
| **4** | Consent gate + UDS transport + `/peers`     | ~1,100        | 3          | Yes — completes it              |
| **5** | CLI/MCP board surface                       | ~300          | 2          | Yes — daemon/cron need it       |

Stages 1 and 2 are independent and may run in parallel.

### Stage 0 — cleanup and unblock

- **Fix [#9276](https://github.com/QwenLM/qwen-code/issues/9276) structurally.** Remove
  `type` from the `send_message` schema; shutdown becomes a leader-only tool absent from a
  teammate's tool list. The correct fix makes the illegal state **unrepresentable**, not
  merely rejected — a single-value optional enum described as "structured message type for
  control flow" is something a model will reasonably fill in.
- Subordinate `coordinate/SKILL.md`'s teammate count to `agents.team.maxTeammates`
  (default `MAX_TEAMMATES = 10`, `types.ts:180`). Not the §1.7 bug class — a hard ceiling
  and a workflow recommendation are different kinds of statement, and recommending fewer
  than the ceiling allows is legitimate. The defect is narrower: the skill stated its
  number as a second absolute, so lowering the cap left it instructing a spawn that throws.
- Close [#9287](https://github.com/QwenLM/qwen-code/pull/9287) /
  [#9288](https://github.com/QwenLM/qwen-code/pull/9288) — superseded by merged #9284 / #9289.
- Close [#8869](https://github.com/QwenLM/qwen-code/pull/8869) (done). Not because
  independent sessions are rejected, but because that particular supervisor is a second
  implementation of infrastructure the daemon already ships.
- Do **not** touch `packages/cli/src/agent-view/`. It is the base of the open #7800–#7803
  series (§1.6), and its disposition is a product question (§7.6), not cleanup.

### Stage 1 — discovery (largely done by #8969)

[#8969](https://github.com/QwenLM/qwen-code/pull/8969) (merged 2026-08-17) landed the
core of the closed #8728: the live-session registry (`session-registry.ts`,
`~/.qwen/sessions/<pid>.json`), `qwen sessions ps`, and `isPidAlive` already moved out of
`teamHelpers` into `packages/core/src/utils/process-liveness.ts`. Do **not** revive #8728
or rebuild any of this. What remains is carrying forward the #8728 review findings that
were genuinely right and are not covered by #8969 — verify symlink-safe registry writes
and Windows guards on POSIX-only assertions against the merged implementation, and file
narrow follow-ups for any gap. Keep those follow-ups small: automated fixes tripled
`session-registry.ts` and are the documented reason #8728 was abandoned — that failure
mode is a process risk, not a code risk, and it will recur unless prevented.

Changes no session behaviour. Nothing reads the registry for messaging yet.

### Stage 2 — relocate authority

The highest-value stage, and it stands alone.

- `send-message.ts:221` Route 2 → file mailbox rather than `TeamManager`.
- Exactly one board-mutation → wake path; nothing else enqueues work.
- Identity resolvable without AsyncLocalStorage.
- Correlation IDs on messages and task transitions — the fleet plan's best idea, and it
  never required subprocesses. Without it a leader infers completion from `idle`, which is
  half of [#8097](https://github.com/QwenLM/qwen-code/issues/8097).

`TeamManager` becomes a cache and a UI feed over the board, not the source of truth.
`InProcessBackend` keeps working throughout.

### Stage 3 — join

`team_join` / `team_leave`; decouple `members.push` from the spawn path; leader as role.
Self-join only. This is the stage where the product capability becomes real.

### Stage 4 — consent and transport

Revive [#8730](https://github.com/QwenLM/qwen-code/pull/8730) — gate, envelope, authority
notice, classifier rule, receipts, `/peers`, UDS. Behind `agents.crossSessionMessaging`,
off by default.

**The gate ships with or before the transport, never after.** A socket that injects text
into a running session's input queue is not something to land "with the check next week".

### Stage 5 — board surface

Expose board operations as CLI + MCP. Motivated by Qwen's own needs — daemon sessions,
scheduled agents, and channel workers all need a non-in-process way to touch the board.
Heterogeneous participation becomes possible as a side effect, with no design concession
and no promise attached.

### Reuse ledger

| Reused unchanged                                   | LOC    |
| -------------------------------------------------- | ------ |
| `tasks.ts` — claim, ownership, dependencies        | 1,056  |
| `mailbox.ts` — inboxes, locks                      | 361    |
| `teamHelpers.ts` — path and liveness helpers       | 365    |
| `ui/components/agent-view/` — tabs, chat, composer | live   |
| `agentHistoryAdapter.ts`                           | ~180   |
| Daemon sub-session spawn + correlation             | ships  |
| **Written but unmerged** (#8730; #8728's registry half re-landed as #8969) | ~7,000 |

Genuinely new: `team_join` / `team_leave`, the wake-path consolidation, correlation IDs,
and the CLI/MCP surface.

## 6. Risks

| Risk                                                    | Mitigation                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Automated fixes bloat a PR until it is unreviewable** | The documented cause of #8728's death. `/takeover stop` early; keep every stage small                        |
| **The board format becomes a de-facto public contract** | Neutral by construction, but undocumented externally and unpromised in v1 (§2.6)                             |
| **Unauthenticated `from`**                              | Not solvable without a native addon. Stated in the module header; receiver-side authorization is built on it |
| **Prompt injection via peer message**                   | Three agreeing defenses (§2.5); the "denied elsewhere" clause is tested explicitly                           |
| **Peers writing the same checkout**                     | Out of scope by construction (§0.2). Cross-workspace is the supported shape                                  |
| **Stage 2 touches `TeamManager` broadly**               | `coordination-harness.test.ts` (1,456 LOC) is the existing regression net                                    |
| **Work stalls unclaimed**                               | Accepted. The board is durable and visible; no central scheduler is promised                                 |

## 7. Open questions

1. **Split storage roots.** Team config and inboxes live at `~/.qwen/teams/{team}/`, but
   tasks live at `~/.qwen/tasks/{team}/` (`teamHelpers.ts:69`). One team's state spans two
   roots. Consolidate before the layout is externally visible, or accept and document it?
2. **Does the daemon register?** Uniformity argues yes — a daemon session should be
   discoverable like any other. Confirm it does not conflict with the workspace runtime
   ownership work in [#7308](https://github.com/QwenLM/qwen-code/pull/7308).
3. **Sub-session residency.** Making a daemon sub-session a resident peer is new semantics
   (§1.4), not wiring. Does it belong in this design, or as a daemon-side follow-up?
4. **Remote join.** v1 forbids pulling another session in. Is self-join sufficient in
   practice, or does the workflow demand invitations — which would need an accept path?
5. **Re-engagement.** #8724's author stated the work would return. The fastest path is to
   ask rather than to reimplement. Who reaches out?
6. **The #7799–#7803 series versus §4.** This is the largest unresolved question here, and
   it is a product decision rather than a technical one. That series is building a native
   supervisor, PTY workers, session lifecycle and roster UI — precisely the terminal layer
   §4 argues to leave to herdr, on the grounds that herdr already covers 17+ CLIs and
   measured faster (§8). Four open PRs totalling roughly 24,000 additions are the strongest
   evidence that the project does not actually hold §4's position. Either §4 is wrong and
   this document should treat that series as the terminal plane it composes with, or the
   series should be reconsidered against §8. Deciding by attrition — letting the PRs age
   out — is the one outcome that costs the most and settles nothing.

## 8. Relationship to herdr

herdr is a **terminal multiplexer** hosting unmodified agents, inferring `working` /
`blocked` / `idle` by reading the screen. It provides persistence, detach/reattach, SSH,
and 17+ CLIs. It provides no task DAG, no ownership or claim, no reliable mailbox, and no
turn-level acknowledgement — its `wait` waits on lifecycle state, not a specific turn.

The split is clean and the two compose:

> **herdr owns terminals. This design owns semantics.**

The measured baseline supports exactly this division. On a two-worker research task, herdr
fanned out in **17.2 s** but needed a separate **66.9 s** aggregation invocation — an
estimated **84.1 s** joined pipeline — against **~177 s** for the native interactive run.
herdr is faster, and the native path's cost is not in the fan-out.

Two conclusions follow. First, **do not rebuild herdr** — it wins on that shape today.
Second, herdr's 66.9 s join exists because there is **no shared state to join on**; every
aggregation re-explains from scratch. That is the cost a durable board removes, and it is
the only place this design should be measured. The current 177 s says the implementation is
nowhere near realizing that yet.

[#9047](https://github.com/QwenLM/qwen-code/pull/9047) ("report TUI state to Herdr") is the
right shape of integration and is compatible with everything here.

## 9. Disposition of existing work

| Item                                                                            | Disposition                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #8724 (umbrella, open)                                                          | **Adopt as this design's tracking issue.** Extend scope from messaging to collaboration                                                                                                                                                |
| #8728                                                                           | Superseded by #8969 (merged). Stage 1 reduces to carry-forward hardening of the merged registry                                                                                                                                        |
| #8730                                                                           | Revive. Stage 4. Re-engage the author first                                                                                                                                                                                            |
| #8718 (closed not-planned)                                                      | Leave closed. Post a correction: the recorded rationale rebuts a position the fleet plan never held (it ruled heterogeneous CLIs permanently out of scope), and the real reasons were sequencing, review capacity, and no measured win |
| #8869 (Stage 1B draft)                                                          | Close. Superseded                                                                                                                                                                                                                      |
| `agent-view/` (6,186 LOC)                                                       | **Leave in place.** Base of the open #7800–#7803 series; disposition depends on §7.6                                                                                                                                                   |
| #9276                                                                           | Fix in Stage 0. Blocks the only supported path today                                                                                                                                                                                   |
| #9287 / #9288                                                                   | Close as superseded by #9284 / #9289                                                                                                                                                                                                   |
| Fleet architecture doc ([#8719](https://github.com/QwenLM/qwen-code/pull/8719)) | Stays closed. Superseded by this document; it never landed in the repository                                                                                                                                                           |
