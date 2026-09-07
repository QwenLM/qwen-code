# Mesh in Web Shell — design direction

> For §5.2 step 9. Written before any UI exists, so step 9 does not start from a blank page or from whatever list component was nearest to hand.
> Companion to [`2026-09-06-multi-agent-board-collaboration.md`](./2026-09-06-multi-agent-board-collaboration.md) and [`2026-09-07-mesh-implementation-acceptance.md`](./2026-09-07-mesh-implementation-acceptance.md).
> Nothing here has been rendered. Every screenshot claim belongs to step 9's own evidence.

## 1. Who this is for, and what it has to answer

One developer, supervising two to five persistent agents, coming back to a machine they walked away from. In priority order the surface answers:

1. **What needs me?**
2. **What is running, and on what?**
3. **What is stuck, and why?**

Everything else — history, transcripts, budgets — is evidence for those three, and is subordinate to them.

## 2. The idea this design rests on

Thread status here is an **aggregate over outstanding obligations**, not a state somebody set. That is the whole reason `thread-status.ts` exists: one agent posting a summary does not mean the thread is ready, and one agent's clean exit must not erase another's question.

The obvious UI for "several people discussing a work item" is a chat log with a status pill, which is what Slack, Linear and GitHub all look like. Built here it would hide the one thing this system knows that those do not: **who owes what, and what the thread is waiting on**. A pill saying `blocked` next to twelve messages makes the reader scroll to find out why.

So: **the thread view is a ledger of obligations, and the conversation is the evidence underneath it.** Concretely, three consequences that shape every screen below.

- The thread header is a **sentence**, not a badge. `resolveThreadStatus` already returns a `reason` — "run rn_7 asked a question and is waiting for a person", "2 runs still queued, running, finishing or cancelling". Render that. Do not re-derive a shorter label from the status enum; the resolver is the single source of the answer and the UI's job is to show it, not to summarise it away.
- Each agent working a thread gets a **lane**. `outstandingCloseObligations(thread)` is the data; a lane makes "alice submitted for review but bob is still running" legible without reading the log. Without lanes, the aggregate rule is invisible and users will read the thread status as though one agent set it.
- **System triggers are not chat messages.** An assignment and a child report are `authorKind: 'system'` carrying the run that caused them. They are ledger entries and must not be dressed as someone talking.

## 3. Tokens — inherit, do not invent

This is a working surface inside Web Shell, not a landing page. It uses `App.module.css`'s existing variables and adds none of its own colours. No new webfont: the shell is a local-first developer tool, and a downloaded display face would cost startup, break offline use, and clash with every neighbouring panel.

| Role           | Token                                                                 | Why                                                                                                           |
| -------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Running        | `--status-running-fg` / `--status-running-bg`                         | Same blue the plan graph and cockpit already use for in-flight work                                           |
| Needs a person | `--status-attention-fg` / `--status-attention-bg`                     | Both `blocked` and `in_review` — see below                                                                    |
| Done           | `--status-done-fg` / `--status-done-bg`                               | Green means finished and never in flight, per the existing comment in `App.module.css`                        |
| Idle / open    | `--status-idle-fg` / `--status-idle-bg`                               | Sits on `--secondary` so it stays visible on a card                                                           |
| Agent identity | `MeshAgent.color`, falling back to `--accent-red/orange/yellow/green` | The roster already carries a per-agent colour; use it as a 2px identity bar on a lane, never as a text colour |

**`blocked` and `in_review` share one attention treatment.** They are opposite in valence — one is a question, one is a finished piece of work — but they are the same query for the reader: _this is waiting on me_. Giving them two colours splits that scan into two. They are told apart by the sentence, not the hue: "Alice asked a question" versus "Bob submitted a summary for review". This is the one place the design deliberately spends less colour than it could.

**Type.** Two existing families, split by function rather than by hierarchy:

- `--font-sans` for everything a person reads as prose: the header sentence, post bodies, descriptions, empty states.
- `--font-mono` **only** where characters must align in a column or be copied exactly: message sequence numbers, run ids, thread ids, token counts, and agent handles in lanes. Lane alignment depends on tabular figures; this is information, not texture. Mono must not appear on labels, headings, or status words.

Scale, from the shell's 14px base: 20px/1.3 semibold for the thread title, 15px/1.5 for the header sentence, 14px/1.6 for post bodies, 13px for lane rows, 12px for sequence numbers and metadata. Line length capped at 72 characters for post bodies.

**Forbidden, because they read as template chrome rather than as decisions:** tracked-out all-caps eyebrow labels above sections; metadata strings joined with middle dots; `→` appended to link or button text; a rounded card with the same radius and the same soft grey shadow around every block regardless of what it contains; `01 / 02 / 03` markers on anything that is not a real sequence.

## 4. Surfaces

### 4.1 Roster — inside the existing Agents page

Rows, not cards. A roster's job is comparison, and cards defeat comparison by breaking the columns.

```
Agents

  ● alice          reads CI logs                  working  th_4f2 · Investigate flake   2 waiting
  ● bob            reads code                     idle                                  —
  ○ retired        old log reader                 disabled                              —

  + Add an agent
```

The identity dot carries `MeshAgent.color`; a disabled agent's dot is hollow and its row drops to `--muted-foreground` without being hidden — disabling keeps identity and history, and the roster must show that rather than making the agent vanish.

The "working" column names the thread, because "which thread is my agent on" is the question a queued thread's owner is actually asking. The backlog count uses the word _waiting_, matching `queueLimit`'s meaning of pending runs only.

Empty state: **No agents yet. An agent is a persistent identity built on one of your agent definitions — it keeps what it learned across threads.** Then the add action. An empty screen is an invitation, not a shrug.

### 4.2 Thread list — grouped by what they need

Sorting by date is the default and it buries the two threads that need you under twenty that do not.

```
Threads

  Needs you  2
  ┃ Investigate the web-shell smoke-test flake
  ┃ alice asked a question · 4m ago                             th_4f2
  ┃ Retry-path audit
  ┃ bob submitted a summary for review · 1h ago                 th_91c

  Running  1
    Trace the daemon restart loop
    2 runs in flight · started 12m ago                          th_a03

  Idle  1
    Notes on channel workers
    no assignee                                                 th_77b

  Done  14   ›
```

The attention group carries a 2px left edge in `--status-attention-fg`; nothing else does. One visual signal for "this is yours", differentiated by the sentence beneath the title. `Done` is collapsed by default with its count, because finished work is evidence rather than a task.

A blocked thread whose cause was a gate or a failure says so plainly: **turn budget spent — 12 unattended deliveries** or **alice's run failed at launch: agent definition "log-reader" is unavailable**. Never "an error occurred".

### 4.3 Thread view — obligations first, conversation as evidence

```
Investigate the web-shell smoke-test flake                      th_4f2
The web-shell smoke test is flaky. Find out why.

┌────────────────────────────────────────────────────────────────────┐
│ alice asked a question and is waiting for a person                 │
└────────────────────────────────────────────────────────────────────┘

  ▎alice     asked a question          run rn_7 · 4m ago      transcript
  ▎bob       working                   run rn_9 · since 6m    transcript
  ▎carol     nothing outstanding                              transcript

  Budget   4 of 12 unattended turns · 31.2k of 200k tokens (this tree)

────────────────────────────────────────────────────────────────────────

  3  you                                              10:02
     The web-shell smoke test is flaky. Find out why.

  4  assigned alice                                   10:02

  5  alice                                            10:14
     The failure is in the retry path, not the fixture. Two runs
     out of forty retried and both left the temp dir behind.
     @bob can you read the retry helper?

  6  alice asked                                      10:15
     Should I treat a leaked temp dir as a failure, or just log it?

  [ Reply to this thread                                          ]
```

Reading the layout:

- The **header sentence** is the resolver's `reason`, in a bordered block wide enough to hold a full sentence. It is the only element in the design allowed to change while the page is open, and it is the one place motion is spent: when a run finishes and the sentence changes, cross-fade it over 150ms and respect `prefers-reduced-motion`. Nothing else animates — no fade-and-slide entrances, no hover transitions on rows.
- **Lanes** are one row per agent that has worked this thread. The 2px left bar is the agent's colour. The middle column is the obligation in the user's words: _asked a question_, _submitted for review_, _waiting on a sub-thread_, _ended without a hand-off_, _failed at launch_, _nothing outstanding_. A lane's transcript link opens that run's slice, bounded by `transcriptStartOffset`/`transcriptEndOffset` — never the agent's whole cross-thread memory, which belongs to other threads and other people's work.
- **Budget** is one line, not a progress bar. It is a limit you want to notice before it trips, not a goal you are filling.
- **Posts** carry the message sequence in mono at the left. Sequence is how a person and an agent refer to the same post, and how a duplicate after a replay is recognised — so it is data, not ornament. Author kinds render differently: a person as their name, an agent as its name, a system trigger as a verb phrase with no body (`assigned alice`, `sub-thread th_91c ready for review`) so it reads as a ledger entry rather than as something that spoke.
- Sub-threads appear inline at the point they were created, indented one level, with their own status sentence. A parent thread whose child is blocked must show that without a click.

Composer copy: **Reply to this thread**. Its result is a post, so the placeholder says what will happen. If the reply books nothing — no assignee, no mention — the thread's status becomes `blocked` and the header sentence says **your reply reached nobody: mention an agent or set an assignee**. That is the case round two found the system silently swallowing, and it must be the loudest thing on the screen when it happens.

### 4.4 Run transcript slice

Opened from a lane. Its own panel, not a modal: it is reading material, and the thread must stay visible beside it. The header states what the reader is looking at — **run rn_7 · alice · this thread only** — because the underlying file is one agent's whole cross-thread transcript and the slice is a window into it. Byte offsets are not shown; they are plumbing.

## 5. Writing rules for this surface

- Name the actor and the act: _alice asked a question_, not _Blocked_. The status enum is the system's word; the sentence is the user's.
- One vocabulary end to end. The button that says **Mark done** produces a thread that reads **done**; the tool called `thread_review` surfaces as _submitted for review_ everywhere.
- Failures state the stage and the fix, in the interface's voice, and never apologise: **alice's run failed at launch: agent definition "log-reader" is unavailable. Point the agent at a definition that exists, or disable it.**
- Refusals explain the alternative. Marking a parent done with a live child says **this thread has 1 sub-thread that is not done. Finish or close th_91c first.** and names it as a link.
- Empty states invite. An unassigned thread reads **Nobody is assigned. Mention an agent to start work.**

## 6. What step 9 must not do

- Do not add a second status vocabulary. `resolveThreadStatus` is the only place a thread's state is decided; the UI renders its `status` and `reason` and adds nothing.
- Do not render an agent's whole transcript as a thread's log. A run is a slice, and the rest of that file belongs to other threads.
- Do not sort threads by recency at the top level. Group by what they need first.
- Do not show a thread as idle when it is quiescent with nothing runnable. That state is `blocked` and it has a reason attached.

## 7. Accessibility floor

Attention is never carried by colour alone — the left edge is paired with the sentence, and the identity dot with the name. Focus is visible on every row, lane and link, using the shell's `--ring`. The thread list and lanes are keyboard-navigable in reading order. `prefers-reduced-motion` removes the header cross-fade. Contrast is checked against both themes' `--background`, since `App.module.css` ships light and dark.

<details>
<summary>中文说明</summary>

**这份文档做什么**：在第 9 步动工之前定下 mesh 在 Web Shell 里的设计方向，避免从空白页或手边最近的列表组件开始。

**核心判断**：线程状态是「所有 run 的未结义务」的聚合，不是谁设的一个值。照搬聊天记录加状态徽章的通用做法，恰好会把这套系统唯一比 Slack/Linear 多知道的东西藏起来——谁欠什么、线程在等什么。所以线程页是一本义务账，对话是它下面的证据。三个后果：页头是 `resolveThreadStatus` 返回的那句 `reason`，不是徽章；每个参与过的 agent 一条泳道，让「alice 交了评审但 bob 还在跑」不用读日志就看得见；system 触发（指派、子线程回报）是账目条，不能打扮成有人说话。

**不新造设计语言**：沿用 `App.module.css` 既有的 token，不加新颜色，不引入新字体（本地优先的开发者工具，下载字体会拖慢启动、破坏离线、并与相邻面板冲突）。等宽字体只用在需要对齐或需要精确复制的地方：消息序号、run id、线程 id、token 数、泳道里的 agent 名。

**一个刻意的克制**：`blocked` 和 `in_review` 共用同一个「需要你」的视觉信号，靠句子区分（「alice 提了一个问题」对「bob 交了一份总结待验收」），而不是靠第二种颜色。因为对读者来说它们是同一个查询。

**动效只花在一处**：页头那句话在你看着的时候变了，交叉淡入 150ms，并尊重 `prefers-reduced-motion`。其余一律静态。

</details>
