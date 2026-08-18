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

The design rests on one inversion:

> **Pull is the contract. Push is an optimization available only to agents we wrote.**

This follows from a physical limit rather than a preference: nothing can push into a process
it did not launch and whose stdin it does not hold (§1.8). A Codex or any other vendor's CLI
can therefore never be a delivery target — but it can run a command. So the operation every
participant shares is _fetching_, and anything built on delivery excludes, by construction,
every agent we did not write.

Written the other way round — delivery first, fetching as the fallback for foreigners — the
design acquires sockets, a receive-side gate, wake frames, and an assignment protocol that
must decay when undelivered. Every one of those exists to make _push_ safe. Invert the
baseline and they become optional, later, and Qwen-only.

The second relocation still holds and is what makes the first possible: the source of truth
moves from `TeamManager`'s in-memory state to the files under `~/.qwen/`. A board on disk is
the one medium every participant can reach, whoever started it and whoever wrote it.

### 0.1 Three layers, and one optimization

| Layer         | Medium                       | v1?          | Without it                          |
| ------------- | ---------------------------- | ------------ | ----------------------------------- |
| **Board**     | Files + `proper-lockfile`    | **Required** | Nothing is shared                   |
| **Access**    | A CLI over the board         | **Required** | Only Qwen can participate           |
| **Authority** | The human, via `decision`    | **Required** | Agents adjudicate each other        |
| _Push_        | _UDS wake frame per session_ | _Later_      | _Slower; nothing becomes incorrect_ |

The access layer is what admits heterogeneous agents, and it is required rather than
optional precisely because of that: **a capability reachable only through Qwen's in-process
tools does not exist for anything else.** Discovery
([#8969](https://github.com/QwenLM/qwen-code/pull/8969), merged) is useful but not a layer —
addressing works on names the board carries; liveness only makes staleness visible sooner.

Push is listed to be explicit that it is _not_ v1. Its absence costs latency: an idle
session learns about work when it next looks. It costs no correctness, which is the property
that lets it be deferred.

### 0.2 Settled product decisions

| Decision            | Choice                                                                                                             | Rejected alternative and why                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| **Topology**        | Peer, with **no leader in the routing path** (§2.4). Information goes to a peer, authority to the human            | Leader-as-router: it becomes the bottleneck and spends its context coordinating instead of working                          |
| **Membership**      | **None.** A session is addressable because it registered, not because it joined (§2.2)                             | Any join step: it makes an already-running session ask permission to be talked to, which is the case this design exists for |
| **Consent**         | Receiver-side gate with approval-mode parity, fail-closed ([#8730](https://github.com/QwenLM/qwen-code/pull/8730)) | Sender-side authorization: `from` is unauthenticatable on this transport (§2.5), so only the receiver can decide safely     |
| **Write conflicts** | Out of scope by construction: peers collaborate **across** workspaces                                              | Path-claim protocol: a peer's permissions were fixed by whoever started it, so no participant can demote another            |
| **Heterogeneity**   | Format stays vendor-neutral (it already is), but **v1 publishes no compatibility promise**                         | Either designing _for_ foreign agents (premature) or actively excluding them (costs work, buys nothing)                     |

Two consequences worth stating plainly:

- [#8730](https://github.com/QwenLM/qwen-code/pull/8730)'s receive-before-send argument is
  adopted, not dropped: it says a gate must precede a push path. v1 has no push path, so the
  gate arrives with one (§2.5). What must not happen is push landing first.
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

That series builds a terminal and supervisor layer, which §4 lists as out of scope **for
this design**. The two do not overlap: #7800, #7801 and #7803 touch no file under
`packages/core`, #7802 touches three unrelated utilities, and none of the four touches
`agents/team/`, `send-message.ts`, `tasks.ts` or `mailbox.ts` — the entire surface this
design changes. Whether Qwen hosts terminals natively is orthogonal to whether two sessions
can ask each other a question; both can be true.

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

### 1.8 Push requires stdin you do not have

The constraint the design inverts around, stated once so nothing downstream re-derives it.

To push into an agent you must either **hold its stdin** or have it **voluntarily open a
door**. There is no third option; OS-level tty injection (`TIOCSTI`) is disabled on modern
systems precisely because it was one.

herdr holds stdin, which is why it can drive unmodified agents at all: it launched them into
its panes and writes bytes as though a user were typing. The integration in
[#9047](https://github.com/QwenLM/qwen-code/pull/9047) shows the mechanism from the other
side — `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_BIN_PATH`, and `spawn(binary, args)`. No SDK, no
protocol library, and no requirement on the hosted agent.

That gives a 2×2 with one impossible cell:

|                     | Qwen                                    | Foreign agent (Codex, …)   |
| ------------------- | --------------------------------------- | -------------------------- |
| **We launched it**  | push — semantic channel                 | push — write its stdin     |
| **Already running** | push — it registered a door voluntarily | **impossible, for anyone** |

The bottom-right cell is not a gap in our implementation. herdr cannot reach it either: a
Codex already running in your own terminal is not in herdr's panes.

Two consequences the rest of the document depends on. First, an already-running Qwen session
is reachable only because it _chooses_ to register — voluntary registration is what replaces
holding stdin. Second, and decisively for scope: **if heterogeneous participation is a
requirement, the shared operation cannot be delivery.** It has to be fetching, because that is
the only verb available in every cell of the table.

## 2. Target architecture

### 2.1 The shape

```
                     ┌──────────────────────────────┐
                     │            HUMAN             │   resolves `decision`
                     └──────────────▲───────────────┘   no agent resolves one
                                    │
  ┌─────────────────────────────────┴─────────────────────────────────┐
  │                      BOARD — source of truth                      │
  │      ~/.qwen/    `task` · `ask` · `decision`                      │
  │            files + proper-lockfile + atomic write                 │
  └───────────────────────────▲───────────────────────────────────────┘
                              │
                    ┌─────────┴──────────┐
                    │   qwen <noun> <verb>│   ACCESS — the only contract
                    └─────────▲──────────┘
                              │  everyone fetches; nobody is delivered to
      ┌──────────────┬────────┴───────┬────────────────┐
      │              │                │                │
 ┌────┴─────┐  ┌─────┴────┐    ┌──────┴─────┐   ┌──────┴──────┐
 │ session A │  │ session B │    │   Codex    │   │  scheduled  │
 │  (Qwen)   │  │  (Qwen)   │    │            │   │    agent    │
 └───────────┘  └───────────┘    └────────────┘   └─────────────┘
      └───── UDS wake ─────┘
        push — later, Qwen-only, latency only
```

Three claims the picture makes:

1. **Every participant reaches the board the same way.** There is no privileged path, so a
   Codex column and a Qwen column differ in convenience, never in capability. This is the
   whole reason the access layer is a required layer rather than a late convenience.
2. **Only the human resolves a `decision`.** No arrow returns from a participant to that box.
3. **The push arrow spans only the two Qwen boxes, and only sideways.** It never crosses the
   board, because it carries no truth — losing it costs latency and nothing else.

A participant is anything that can read and write the board under the lock protocol. That is
the entire membership test (§2.2): not vendor, not who launched it, not whether it can be
reached.

### 2.2 Vocabulary

Four nouns. Everything the system can express is one of them; anything that is none of them
is out of scope by construction.

| Noun       | Is                                           | Terminal states                   |
| ---------- | -------------------------------------------- | --------------------------------- |
| `session`  | A registered, addressable running instance   | registered / gone                 |
| `task`     | A unit of work — owner, status, deps         | pending / in_progress / completed |
| `ask`      | A question to a session, expecting an answer | **answered / timeout / declined** |
| `decision` | An item awaiting human authority             | approved / rejected               |

**There is no membership.** A session is addressable because it registered, not because it
joined something. This removes `team_join`, the member record, and the `team` namespace: you
do not enter a group in order to talk to a peer, you address it. The address space is
whatever registered — vendor is not the criterion, registration is.

**`ask`, not `send`.** When B needs something from A, B is blocked; it should block on the
answer rather than emit a message and guess. The three terminal states are the whole reason
this is not `message`: a plain message has no failure mode, so a sender cannot distinguish
"parked" from "ignored". Explicit terminal states also make deadlock _detectable_ — who
waits on whom becomes state rather than intent — which is the one thing a cross-session view
can see that no single session can.

**`decision` is the noun this design was missing.** Approving a dangerous operation,
accepting a finished result, and adjudicating two conflicting results are the same act: each
needs _authority_, and no agent has more of it than another. Unifying them gives the default
view something to show — the exception list is a `decision` list. Without this noun the
design could not say what belongs on the first screen.

**`ask` and `decision` stay separate**, though structurally alike — both are "I am blocked,
I need an answer". Merging them behind a `kind: info | authority` field would reintroduce
exactly the anti-pattern that
[#9276](https://github.com/QwenLM/qwen-code/issues/9276) was: an optional discriminator on a
shared surface, which models fill wrongly and which then routes the payload somewhere it was
never meant to go.

**No generic message.** `task` carries status and context, `ask` carries questions,
`decision` carries authority. A general-purpose message is the path of least resistance and
would cannibalise all three — Claude Code's prompt fights this after the fact (_"Don't send
structured JSON status messages — use TaskUpdate"_). It is cheaper not to offer it. Context
that must travel attaches to a **task**, never to a session: there is no agent-to-agent chat
channel.

The omissions matter as much as the verbs:

| Noun       | Does not                                                             |
| ---------- | -------------------------------------------------------------------- |
| `session`  | read a screen, attach, or manage lifecycle — we never hold its stdin |
| `task`     | carry conversation; a note explains work, it is not a chat log       |
| `ask`      | broadcast — deciding _whom_ to ask is itself worth forcing           |
| `decision` | get resolved by an agent; that would defeat the point of the noun    |

Grammar is `<noun> <verb>`, matching herdr's shape (`herdr pane split-right`) without
borrowing its words (§8). One verb is ceded deliberately: **`read` belongs to herdr**, where
it means screen capture. We never scrape a screen, so we never use it.

```
qwen session  list
qwen task     list | create | claim <id> | update <id> [--status …] [--note …]
qwen ask      <session> "<q>" | list [--wait] | answer <id> "<a>"
qwen decision list [--wait] | raise --kind … --about <task> | resolve <id> --approve|--reject
```

Every push has a pull equivalent — `ask list --wait`, `task list --mine`,
`decision list --wait`. That is the sole condition for heterogeneous participation (§2.6),
and it doubles as a standing design check: **a capability with no pull form permanently
excludes every agent we did not write.**

### 2.3 Identity

`identity.ts` resolves identity from AsyncLocalStorage, with the predicate literally named
`isInProcessTeammate()`. An independently started session has no such ambient context.
Identity becomes: registry record (pid, sessionId, cwd) + self-declared name, written at
registration.

This is a **claim, not an authentication** — see §2.5. It is adequate because authorization
is enforced at the receiver, never derived from the sender's assertion.

### 2.4 No leader in the routing path

The fleet plan's single-leader lock is rejected — and so is the softer version this document
first proposed, a transferable `leader` field. Neither is needed once `decision` exists.

Routing splits by what an answer _requires_, not by rank:

| Need            | Goes to        | Why                                                            |
| --------------- | -------------- | -------------------------------------------------------------- |
| **Information** | A peer, direct | No authority implied; a wrong answer is correctable next turn  |
| **Authority**   | The human      | Approval, acceptance, adjudication — no agent outranks another |

A leader agent used as router is precisely what makes the leader a bottleneck and spends its
context on coordination instead of work. Removing it is why `decision` had to become a
first-class noun: the escalation path needs a destination that is not another agent.

Synthesis and acceptance remain real jobs — they are the human's, or a role a session takes
on for one goal. Never an ownership lock over the board.

### 2.5 Consent — required with push, not before it

[#8730](https://github.com/QwenLM/qwen-code/pull/8730) argued receive-before-send: a session
must be able to refuse before anything can be sent to it. That argument is adopted in full.
Its scope is what changed — it constrains a **push** path, and v1 has none.

Fetching does not need a gate. A participant that runs `qwen ask list` has chosen the moment,
is at a boundary of its own turn, and can simply not run it. There is no arriving item to
hold, deny or expire, so the entire hold/receipt machinery has nothing to act on. A gate here
would guard a door nobody can open.

When push lands, the gate lands with it, and #8730's design is adopted as written:
approval-mode parity, the three agreeing anti-forgery defences, receipts, and `/peers`. In
particular the classifier rule — a request to perform something the sender says it was denied
is blocked outright — targets the cheapest bypass in any multi-agent system, and that bypass
opens the moment delivery does.

Two properties hold in v1 without a gate, and both should be read as reasons the deferral is
safe rather than as reasons a gate is unnecessary later:

- **The board is data, not instruction.** A `task` describes work; it does not arrive inside
  anyone's turn claiming to be their user. Prompt-injection surface exists (a fetched task
  description is still text a model reads) but it is the same surface as reading a file, not
  the sharper one of an unsolicited user-role message.
- **Same-uid is the boundary either way.** Directory `0700` is the whole access model, exactly
  as in Claude Code's cross-session messaging, which ships with no inbound gate at all.

### 2.6 Format neutrality

`SwarmTask` — `id`, `subject`, `description`, `owner`, `status`, `blocks`, `blockedBy`,
`metadata` — contains nothing vendor-specific. Dependencies are already modelled.

This is an observation, not a goal. The position for v1:

- Do not add anything Qwen-specific to the task schema.
- Do not document the format as an external contract, and make no compatibility promise.
- Ship the board operations behind a CLI surface (Stage 2) because Qwen's own daemon
  sessions and scheduled agents need a non-in-process way to touch the board anyway.

Heterogeneous participation then costs nothing extra and requires no permission. The four
prior rulings against heterogeneity (fleet §6, #8718, `coordinate/SKILL.md`, the 8/13
closure) all target **hosting other vendors' CLI processes and terminals** — becoming
herdr. Publishing a format is not that: we host nothing, own no lifecycle, and grant no
permissions.

## 3. Flows

### 3.1 Joining the board

There is nothing to join (§2.2). A participant writes to the board and is a participant.
Names are declared, not granted; collisions are the declarer's problem, and the board records
who wrote what.

A Qwen session additionally registers itself (`~/.qwen/sessions/<pid>.json`, shipped by
#8969). That is for liveness and for the later push path — it is not a precondition for
participating.

### 3.2 Work

Unchanged from today, and that is the point: `claimTask` already serialises across processes.
A `task` is created with an optional owner and claimed by whoever takes it.

Assignment is a **proposal**, and in a fetch-based world it needs no protocol to stay one.
Nobody is delivered a task, so a task can never sit in the state that would require one —
"assigned and silently undelivered". It is simply on the board with an owner named, and every
participant can see both facts. **Visibility replaces delivery guarantees**, which is why the
offer-and-decay mechanism an earlier revision proposed is not in this design: it existed to
repair a failure mode that only push creates.

If a named owner never picks the work up, that is visible rather than inferred. Compelling
them is not something a peer can do — it needs authority, so it becomes a `decision` (§2.4).

### 3.3 Questions

```
A: qwen ask <name> "…"          → written to the board, state `open`
B: qwen ask list                → sees it whenever B next looks
B: qwen ask answer <id> "…"     → state `answered`; A sees the answer when A next looks
```

`ask`'s three terminal states carry the whole value: `answered`, `declined`, and `timeout`
for a participant that never looked. A sender always learns which, and can then wait, route
elsewhere, or escalate. That is what a plain message cannot offer, and it works identically
whether B is a Qwen session or a shell loop running the CLI.

Deadlock is detectable for the same reason: A waiting on B while B waits on A is two `open`
asks on the board, not two stalled intentions. No participant can see this about itself.

### 3.4 Authority

Anything needing authority is raised as a `decision` and resolved by the human (§2.4).
Approval, acceptance of a result, and adjudication of conflicting results are one act with
one destination. `qwen decision list` is the exception view — the thing worth putting on a
screen, because it is the only category that stalls until a person acts.

### 3.5 Reporting

Completion is a board state transition, so nobody has to be told. What a task record cannot
express splits by what it needs: a question is an `ask`, anything needing authority is a
`decision`, and interim findings are notes on the task. With no general-purpose message,
"just report it" has nowhere to go except the right place.

### 3.6 Departure and crash

Clean exit: release owned tasks, unlink the registry record.

Crash: the record goes stale and liveness fails, so the session stops appearing as live.
Owned tasks release after the 5 s lock stale window. Any `ask` outstanding against it reaches
`timeout` rather than hanging. Nothing else in the system waits on it, because nothing was
ever delivered to it.

## 4. Explicit non-goals

Scope: what **this design** does not build. Not a ruling on what the project should build —
other work may cover any of these, and §1.6 records a series that covers the first two.

| Not building                             | Because                                                                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PTY attach, terminal multiplexing, panes | herdr does this for 17+ CLIs, Apache-2.0, and measured faster (§8)                                                                                         |
| Hosting other vendors' processes         | That is becoming herdr. We publish a format; we host nothing                                                                                               |
| A new roster UI                          | This design reuses `ui/components/agent-view/`                                                                                                             |
| Push delivery in v1                      | Nothing can push to a foreign agent (§1.8), so a design built on delivery excludes them. Push arrives later, with #8730's gate, as a Qwen-only latency win |
| Remote / SSH / cross-machine             | Same-uid filesystem permissions **are** the security model. Off-machine voids it                                                                           |
| Broadcast (`to: "*"`)                    | #8724 removes it rather than extending it to N processes                                                                                                   |
| Same-checkout multi-writer               | A peer's permissions were fixed by whoever started it; no participant can demote another                                                                   |
| Central completion guarantee             | Peers decide what to claim. Unclaimed work stays visible on the board, not forced                                                                          |
| Windows in the first cut                 | Follows #8724. The IPC path is abstracted so named pipes can be added                                                                                      |

## 5. Build plan

Sized against demonstrated review capacity here: #8804 merged at 775 lines; #8859 (~1,300)
and #8869 (4,465) both died unreviewed.

| Stage | Scope                                           | Est. prod LOC | Depends on | Delivers                               |
| ----- | ----------------------------------------------- | ------------- | ---------- | -------------------------------------- |
| **0** | Cleanup and the #9276 fix                       | ~150          | —          | Unblocks the only supported path today |
| **1** | `ask` + `decision` as board items               | ~400          | —          | The vocabulary exists                  |
| **2** | The CLI over the board                          | ~350          | 1          | **Heterogeneous participation**        |
| **3** | Qwen-native surfaces mapped onto the same items | ~300          | 1          | Qwen agents stop shelling out          |
| _4_   | _Push + #8730's gate_                           | _~1,100_      | _2, 3_     | _Latency only — deliberately last_     |

The ordering is the inversion made concrete. **Stage 2 is where the requirement is met**: the
moment the board has a command-line surface, a Codex, a shell script, a scheduled job and a
Qwen session are participants on identical terms. Everything after it is convenience for the
subset we wrote.

Stage 3 is not a prerequisite for anything — it exists so a Qwen agent uses a tool rather than
a subprocess, with identical semantics. Building it _first_ would be the old mistake: the
native path would set the contract, and the CLI would inherit whatever the tools happened to
need.

Stage 4 stays last on #8730's own argument (§2.5): a gate must precede a push path, so the
cheapest way to keep that ordering is not to have a push path yet.

### Stage 0 — cleanup and unblock

Unchanged and already underway: [#9401](https://github.com/QwenLM/qwen-code/pull/9401)
(structural fix for #9276) and [#9403](https://github.com/QwenLM/qwen-code/pull/9403)
(teammate cap subordinated to the configured limit). Independent of everything below.

### Stage 1 — `ask` and `decision` as board items

The board holds `task` today. Add the other two as peers of it, under the same lock and
atomic-write discipline: `ask` with `open` / `answered` / `declined` / `timeout`, `decision`
with `kind` ∈ approval | acceptance | adjudication and `open` / `approved` / `rejected`.

No transport, no delivery, no gate. Items are written and read.

### Stage 2 — the CLI over the board

```
qwen session  list
qwen task     list | create | claim <id> | update <id> [--status …] [--note …]
qwen ask      <name> "<q>" | list [--wait] | answer <id> "<a>"
qwen decision list [--wait] | raise --kind … --about <task> | resolve <id> --approve|--reject
```

`--json` everywhere for machine consumption. `--wait` blocks by polling — no socket involved.
Fail-open when there is no board, following #9047's herdr reporter: absent context is silence,
not an error.

This is the stage that satisfies the requirement, and it is worth stating why it is only ~350
lines: the board, the lock protocol and the claim semantics already exist (§1.1). What is new
is a surface over them.

### Stage 3 — Qwen-native surfaces

`send_message` collapses to scheme-based addressing (§3.2); Qwen's tools read and write the
same items the CLI does. Correlation IDs land here. Nothing a Qwen agent can do becomes
unavailable to a CLI caller — that invariant is the standing check from §0.1.

### Stage 4 — push, and the gate that must precede it

UDS wake frames, #8730's approval-mode parity gate, envelope defences, receipts, `/peers`.
Deferred, not dropped. It buys latency for Qwen-to-Qwen traffic and nothing else.

### Reuse ledger

| Reused unchanged                                                           | LOC    |
| -------------------------------------------------------------------------- | ------ |
| `tasks.ts` — claim, ownership, dependencies                                | 1,056  |
| `mailbox.ts` — inboxes, locks                                              | 361    |
| `teamHelpers.ts` — path and liveness helpers                               | 365    |
| `ui/components/agent-view/` — tabs, chat, composer                         | live   |
| `agentHistoryAdapter.ts`                                                   | ~180   |
| Daemon sub-session spawn + correlation                                     | ships  |
| **Written but unmerged** (#8730; #8728's registry half re-landed as #8969) | ~7,000 |

Genuinely new: the `ask` and `decision` items, the wake-path consolidation, correlation IDs,
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

## 7. Questions, and how they resolved

Recorded rather than deleted, so they are not relitigated.

**1. Split storage roots — consolidate before the CLI ships (Stage 2).**
Team config and inboxes live under `~/.qwen/teams/{team}/`, tasks under
`~/.qwen/tasks/{team}/` (`teamHelpers.ts:69`): one board's state across two roots. Ugly, but
consolidating is a data migration with no functional benefit while the layout is internal,
and §2.6 makes no format promise in v1, so nothing outside can observe the split. The
trigger is concrete rather than "someday": **consolidate before the board surface ships**
(Stage 2), because that is the moment the layout becomes something a foreign agent reads.
The merged registry already carries `schemaVersion`, so versioned layout change is
anticipated.

**2. Daemon sessions register — yes, and it needs a `kind` field.**
Today only `startInteractiveUI.tsx` calls `registerSession`, and the merged
`SessionRegistryRecord` (`schemaVersion`, `pid`, `procStart`, `pidNs`, `sessionId`, `cwd`,
`name`, `startedAt`, `qwenVersion`) has no `kind`. §2.1 already draws a daemon session as a
participant, and a participant that cannot be discovered cannot be addressed. `kind` is not
extra work: it is needed regardless to distinguish an interactive session from a daemon one
and from a wrapped foreign agent, all three of which register on the same terms (§3.2).
Lands with Stage 3.

**3. Sub-session residency — out of scope, deliberately.**
`create-sub-session.ts` states that a sub-session is **"NOT kept resident"** and is reaped
once idle. Making one resident would convert it into a long-lived agent — which is the
_spawn_ model this design is not about. Anyone who wants a resident participant starts a
session, and serving exactly that case is the point of the design. Leaving this alone keeps
the boundary sharp; it can be revisited daemon-side on its own merits.

**4. Remote join — dissolved twice over.**
There is no join to make remote (§2.2), and the question underneath it — may A give B work B
did not ask for? — stops being hard once nothing is delivered. A names an owner on a `task`;
B claims it or does not; both facts are visible to everyone. An earlier revision answered this
with an offer that expires, which was machinery invented to repair a failure mode only push
creates: work that looks assigned because it was sent, while nobody knows it never arrived.
**Fetching has no undelivered state**, so visibility does the whole job. Compelling B still
needs authority, so it is a `decision` — naming an owner is not the power to compel one, and
that is what keeps a peer model from quietly becoming a hierarchy.

**5. Re-engagement over #8724 — withdrawn; it was never a design question.**
It asked who should contact the author of the closed #8728/#8730. That is a process item,
not an unknown, and it is moot besides: #8969 landed the registry independently, and the
remaining code is public on an open branch. Nothing here needs anyone's agreement to
proceed. Recorded because the same category error — treating a social step as a technical
dependency — also produced the retracted conflict in §1.6.

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
| `agent-view/` (6,186 LOC)                                                       | **Leave in place.** Base of the open #7800–#7803 series, which this design does not touch                                                                                                                                              |
| #9276                                                                           | Fix in Stage 0. Blocks the only supported path today                                                                                                                                                                                   |
| #9287 / #9288                                                                   | Close as superseded by #9284 / #9289                                                                                                                                                                                                   |
| Fleet architecture doc ([#8719](https://github.com/QwenLM/qwen-code/pull/8719)) | Stays closed. Superseded by this document; it never landed in the repository                                                                                                                                                           |
