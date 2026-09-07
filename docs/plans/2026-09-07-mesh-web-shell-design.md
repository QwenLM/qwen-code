# Mesh in Web Shell — design direction

> For §5.2 step 9, written before any UI exists so the build does not start from a blank page or from whichever list component was nearest to hand.
> Grounded in Multica's shipped UI, read at `multica-ai/multica@7a438bd5b`: `packages/views/issues/components/{issue-detail,execution-log-section,comment-trigger-chips,thread-nav-panel}.tsx` and `packages/views/issues/blocked-trigger-copy.ts`. Where this design diverges from theirs, the reason is stated.
> Companion to [`2026-09-06-multi-agent-board-collaboration.md`](./2026-09-06-multi-agent-board-collaboration.md) and [`2026-09-07-mesh-implementation-acceptance.md`](./2026-09-07-mesh-implementation-acceptance.md).
> The live demo path was rendered on 2026-09-07 through a real daemon and Web Shell. It covers roster/create/list/detail, reply routing preview, live dispatch, parent-report continuation, final review, blocked questions, cancellation, per-run transcript slices, tombstoned names, inline children, and the first-class sidebar entry. Branch CI visual evidence remains step 9 work.

## 1. Who this is for

One developer supervising two to five persistent agents, returning to a machine they walked away from. In priority order:

1. **What needs me?**
2. **What is running, and on what?**
3. **What is stuck, and why?**

History, transcripts and budgets are evidence for those three and stay subordinate to them.

## 2. What to take from Multica, and what it cannot give us

Multica has shipped this product shape, and four of its decisions are worth adopting outright rather than rediscovering.

**Runs belong in a side panel, active first.** `execution-log-section.tsx` lists every agent run for an issue: active runs pinned at top, terminal runs collapsed behind a _Show past runs (N)_ toggle. Each row is agent, then the **trigger** — why this run exists — flexing and truncating, then status in a fixed right column that is _replaced in place_ by actions on hover rather than covered. Their note is worth keeping verbatim in spirit: the row carries no agent-availability dot, because availability is not the story on a run row; the run's own status is.

**The live signal belongs in the header, not the body.** They moved "an agent is working" out of an in-body card into a header chip. A body card competes with the content for the reader's eye and scrolls away.

**Preview routing before sending, not after.** `comment-trigger-chips.tsx` shows, while you type, which agents this comment will wake — lit for will-trigger, dimmed for suppressed — and names each mention that will _not_ fire, with its reason. This is the single best idea in their UI and it transfers exactly, because `decideDispatch` is a pure function: the composer can run the real rules against a draft and show the true outcome before a token is spent.

**A list beats a rail for finding.** Their `ThreadNavPanel` replaced a minimap rail for jumping between comment threads: a tick carries no text, so finding a specific one costs a hover per candidate. They kept the rail for position and added a list for finding, and deliberately did not mark "currently on screen" because on-screen is a set, not a point.

**What Multica cannot give us.** Its issue status is set by a person and its runs are per-`(agent, issue)` tasks, so it never has to answer "one agent submitted a summary while another is still working". Ours does: `resolveThreadStatus` derives the thread's state from every run's outstanding obligation, and three of the round-two defects were threads stuck in a state nobody could explain. That is the one place this UI has to invent rather than adopt, and §4 spends its design budget there.

## 3. The idea this design rests on

**The thread view is a ledger of outstanding obligations; the conversation is the evidence underneath it.**

A chat log with a status badge is what Slack, Linear and Multica's issue view all look like, and built here it would hide the thing this system knows that they do not: who owes what, and what the thread is waiting on. A badge reading `blocked` above twelve messages makes the reader scroll to find out why. Three consequences:

- The thread header is a **sentence**, not a badge. `resolveThreadStatus` already returns a `reason` — _"run rn_7 asked a question and is waiting for a person"_, _"2 runs still queued, running, finishing or cancelling"_. Render it. The UI must not derive a second, shorter status vocabulary; the resolver is the only place a thread's state is decided.
- Every run row carries its **close obligation** where Multica carries a task status. Same shape, more information: _asked a question_, _submitted for review_, _waiting on a sub-thread_, _ended without a hand-off_, _failed at launch_.
- **System triggers are not chat messages.** An assignment and a child report are `authorKind: 'system'` carrying the run that caused them. They are ledger entries and must not be dressed as someone talking.

## 4. Surfaces

### 4.1 Roster, inside the existing Agents page

Rows, not cards: a roster's job is comparison, and cards break the columns that make comparison free.

```
Agents

  ● alice          reads CI logs           working  Investigate flake     2 waiting
  ● bob            reads code              idle                                  —
  ○ retired        old log reader          disabled                              —

  + Add an agent
```

The dot carries `MeshAgent.color`. A disabled agent's dot is hollow and its row drops to `--muted-foreground` but is never hidden: disabling keeps identity and history, and a roster that hides it contradicts the model. The working column names the thread, because "which thread is my agent on" is what the owner of a queued thread is actually asking. The backlog reads _waiting_, matching `queueLimit`'s meaning of pending runs only.

Empty: **No agents yet. An agent is a persistent identity built on one of your agent definitions — it keeps what it learned across threads.**

### 4.2 Thread list, grouped by what they need

Recency sorting is the default and it buries the two threads that need you under twenty that do not.

```
Threads

  Needs you  2
  ┃ Investigate the web-shell smoke-test flake
  ┃ alice asked a question · 4m                                  th_4f2
  ┃ Retry-path audit
  ┃ bob submitted a summary for review · 1h                      th_91c

  Running  1
    Trace the daemon restart loop
    2 runs in flight · started 12m                               th_a03

  Idle  1
    Notes on channel workers · nobody assigned                   th_77b

  Done  14   ›
```

`blocked` and `in_review` share one attention treatment — a 2px left edge in `--status-attention-fg`, carried by nothing else on the page. They are opposite in valence but they are the same query for the reader: _this is waiting on me_. Two colours would split that scan in two. They are told apart by the sentence, which is where the difference actually lives. Done collapses behind its count; finished work is evidence, not a task.

### 4.3 Thread view

Two columns, following Multica's proportions: content left, runs right.

```
Investigate the web-shell smoke-test flake              th_4f2   [alice working]

┌──────────────────────────────────────────────┐  ┌───────────────────────────┐
│ alice asked a question and is waiting for    │  │ Runs                      │
│ a person                                     │  │                           │
└──────────────────────────────────────────────┘  │ ▎bob      working         │
                                                   │  read the retry helper    │
  The web-shell smoke test is flaky. Find out       │  6m · transcript          │
  why.                                             │                           │
                                                   │ ▎alice    asked a question│
  3  you                                  10:02    │  assigned by you          │
     The web-shell smoke test is flaky.             │  4m · transcript          │
     Find out why.                                  │                           │
                                                   │ Show past runs (3)      › │
  4  assigned alice                       10:02    │                           │
                                                   │ Budget                    │
  5  alice                                10:14    │ 4 of 12 unattended turns  │
     The failure is in the retry path, not          │ 31.2k of 200k tokens      │
     the fixture. @bob can you read the             │ across this thread tree   │
     retry helper?                                  └───────────────────────────┘

  6  alice asked                          10:15
     Should I treat a leaked temp dir as a
     failure, or just log it?

  ┌────────────────────────────────────────────┐
  │ Reply to this thread                       │
  │ ─────────────────────────────────────────  │
  │ will wake  ● bob      mentioned            │
  │ won't wake ○ carol    assignee, superseded │
  │            ⚠ @dave    no agent by that name│
  └────────────────────────────────────────────┘
```

- **Header sentence.** The resolver's `reason`, in a block wide enough for a full sentence. It is the only element allowed to change while the page is open, and the only place motion is spent: a 150ms cross-fade when it changes, removed under `prefers-reduced-motion`. Nothing else animates — no per-section entrances, no hover transitions on rows.
- **Working chip** beside the title, from Multica: the live signal in the header, never a body card.
- **Runs panel.** Multica's shape with our obligation in the status column, and the 2px identity bar from `MeshAgent.color`. Active runs pinned, past runs collapsed behind their count. The second line is the run's trigger — _assigned by you_, _mentioned by alice_, _sub-thread reported back_ — because "why does this run exist" is what a reader asks first. `transcript` opens the run's slice.
- **Budget** is a line, not a bar. It is a limit you want to notice before it trips, not a goal you are filling. "across this thread tree" is stated because sub-threads share it and that surprises people.
- **Posts** carry the message sequence in mono at the left: sequence is how a person and an agent refer to the same post and how a duplicate after a replay is recognised, so it is data, not ornament. System triggers render as a verb phrase with no body — `assigned alice`, `sub-thread th_91c ready for review` — so they read as ledger entries.
- **Sub-threads** appear inline where they were created, indented one level, with their own status sentence. A parent whose child is blocked shows that without a click.
- **Composer preview**, adapted from `comment-trigger-chips`. As the draft changes, run `parseMentions` and `decideDispatch` against it and show the true outcome: who will be woken, who will not, and why. Lit versus dimmed carries will-trigger versus suppressed, exactly as Multica does it, and an unknown mention is a named warning rather than a silent no-op after sending. Our rules give this more to say than theirs: a mention that will hit `queue_full`, or a thread whose turn budget is spent, is visible before the post rather than after.

### 4.4 Run transcript slice

Opened from a run row into a side panel, not a modal: it is reading material and the thread must stay visible beside it. The header states what is being read — **run rn_7 · alice · this thread only** — because the underlying file is that agent's whole cross-thread transcript and the slice is a window into it. Byte offsets are plumbing and are not shown.

## 5. Tokens, type, and what not to add

Inherit `App.module.css`; add no colour and no typeface. A downloaded display face would cost startup, break offline use in a local-first tool, and clash with every neighbouring panel.

| Role                                    | Token                                                                 |
| --------------------------------------- | --------------------------------------------------------------------- |
| Running                                 | `--status-running-fg` / `--status-running-bg`                         |
| Needs a person (`blocked`, `in_review`) | `--status-attention-fg` / `--status-attention-bg`                     |
| Done                                    | `--status-done-fg` / `--status-done-bg`                               |
| Idle, open                              | `--status-idle-fg` / `--status-idle-bg`                               |
| Agent identity bar                      | `MeshAgent.color`, falling back to `--accent-red/orange/yellow/green` |

Two existing families, split by function rather than hierarchy. `--font-sans` for prose: the header sentence, post bodies, descriptions, empty states. `--font-mono` only where characters must align in a column or be copied exactly — message sequences, run and thread ids, token counts. Run rows need tabular figures to line up; that is information, not texture. Mono never appears on labels, headings or status words.

From the shell's 14px base: 20px/1.3 semibold thread title, 15px/1.5 header sentence, 14px/1.6 post bodies capped at 72 characters, 13px run rows, 12px sequences and metadata.

**Not to be used, because they are template chrome rather than decisions:** tracked-out all-caps eyebrows above sections; metadata joined with middle dots; `→` appended to link text; one border-radius and one soft grey shadow around every block regardless of what it holds; `01 / 02 / 03` markers on anything that is not a real sequence.

## 6. Copy rules, and one borrowed law

Multica's `blocked-trigger-copy.ts` carries a rule this design adopts wholesale: **a label must not assert a cause the reason code does not carry.** They keep `runtime_offline`, `agent_runtime_required` and `runtime_unusable` apart because the _fix_ differs, and copy that conflated them sent people to reconnect a machine that was already connected. The same discipline applies to our eight admission skip reasons, each of which has a different fix:

| Reason                   | What the reader is told                    | The fix it points at                        |
| ------------------------ | ------------------------------------------ | ------------------------------------------- |
| `agent_unknown`          | no agent named "dave" in this workspace    | check the spelling, or add the agent        |
| `agent_disabled`         | alice is disabled and cannot take work     | enable alice                                |
| `no_target`              | your reply reached nobody                  | mention an agent, or set an assignee        |
| `queue_full`             | alice already has 5 runs waiting           | wait, or give the work to another agent     |
| `turn_budget_exhausted`  | 12 unattended turns spent on this thread   | reply yourself to continue                  |
| `token_budget_exhausted` | 200k tokens spent across this thread tree  | this one is never reset                     |
| `thread_done`            | this thread is done and takes no new work  | open a new thread                           |
| `self_trigger`           | an agent cannot wake itself                | mention someone else                        |

The composer preview and the post-send result share this table, so a reason reads the same in both places. Missing or invalid agent definitions are not admission reasons: only the runtime loader can know them, and they appear as a typed launch failure on the run row.

A mutation may be durable even when the immediate dispatcher wake fails. The UI says **the change was saved, but the agent could not start**, includes the typed dispatcher error, and keeps that action error visible across background refreshes. It must not report the whole mutation as failed or silently leave a queued run looking merely slow.

Everything else follows from naming the actor and the act: _alice asked a question_, never _Blocked_. One vocabulary end to end — the button that says **Mark done** produces a thread that reads **done**, and `thread_review` surfaces as _submitted for review_ everywhere. Failures state the stage and the fix in the interface's voice and never apologise: **alice's run failed at launch: agent definition "log-reader" is unavailable.** Refusals name the alternative and link it: **this thread has 1 sub-thread that is not done. Finish or close th_91c first.**

## 7. What step 9 must not do

- Do not add a second status vocabulary. Render `resolveThreadStatus`'s `status` and `reason`; derive nothing.
- Do not render an agent's whole transcript as a thread's log. A run is a slice and the rest of that file belongs to other threads.
- Do not sort threads by recency at the top level.
- Do not show a quiescent thread with nothing runnable as idle. That is `blocked`, and it has a reason attached.
- Do not put the live working signal in the body. Multica moved it to the header for a reason.

## 8. Accessibility floor

Attention is never carried by colour alone: the left edge is paired with the sentence, the identity dot with the name, the composer preview's lit/dimmed state with its label. Visible focus on every row and link using `--ring`. Thread list and run rows keyboard-navigable in reading order. `prefers-reduced-motion` removes the header cross-fade. Contrast checked against both themes, since `App.module.css` ships light and dark.

<details>
<summary>中文说明</summary>

**这份文档做什么**：在第 9 步动工前定下 mesh 在 Web Shell 的设计方向，并且对着 Multica 已上线的实现（`issue-detail`、`execution-log-section`、`comment-trigger-chips`、`thread-nav-panel`、`blocked-trigger-copy`）来定，而不是凭想象。

**从 Multica 直接采用四点**：运行记录放右侧面板，活跃在上、历史折叠在「Show past runs (N)」后面，行内不放 agent 在线点（在线与否不是这一行的主题，run 的状态才是）；「某 agent 正在工作」的实时信号放页头而不是正文卡片；**发送前预览路由**——边打字边显示这条会唤醒谁、谁被跳过及原因，亮=会触发、暗=被抑制，未知 @ 显示具名警告；查找用列表而不是右侧缩略轴。

**Multica 给不了的一点**：它的 issue 状态是人设的，run 是 (agent, issue) 维度，所以它从不需要回答「一个 agent 交了总结但另一个还在跑」。我们需要，`resolveThreadStatus` 就是为此存在的，上一轮三个缺陷都是「线程卡在没人能解释的状态」。所以设计预算花在这里：页头是解析器返回的那句 `reason` 而不是徽章，每一行 run 在 Multica 放状态的位置放我们的「未结义务」，system 触发是账目条不是有人说话。

**借来的一条法则**：`blocked-trigger-copy.ts` 写着「标签不能断言 reason code 没有携带的原因」，并且当修复动作不同时相近原因必须分开——他们把 offline / 未绑定 / 不可用分开，因为混为一谈会让人去重连一台本来就连着的机器。我们九个 skip 原因照此各配一句话和一个明确的修复动作，且组件预览与发送结果共用同一张表。

**不新造设计语言**：沿用 `App.module.css` 的 token，不加颜色不加字体。等宽只用于需要对齐或精确复制的字符。动效只花在页头那句话变化时的 150ms 交叉淡入。

</details>
