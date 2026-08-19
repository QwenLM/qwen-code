# Agent Board

Run several agents side by side and let them share work — including agents that
are not Qwen Code.

A board is a small set of files under `~/.qwen/boards/{board}/`. Anything that
can run a shell command can read and write it, so a Codex session, a shell
script, a scheduled job and a Qwen session all participate on the same terms.

> Experimental. The on-disk format may change between releases and carries no
> compatibility promise yet.

## Start a board

```bash
qwen fleet up "find the /v2/orders contract mismatch" --agents 2 --with codex
```

This opens a tmux window: a board pane on the left, then one pane per agent.

```
┌────────────────────────────┬──────────────────────┐
│ board: orders-contract     │ agent-1              │
│ ──────────────────────     ├──────────────────────┤
│ ⚠ d-1  approval (t-2)  1m  │ agent-2              │
│      write src/client.ts   ├──────────────────────┤
│ ? a-1  agent-1 → agent-2   │ ext-1  (codex)       │
│      is status a string?   │                      │
│ · t-1  investigate api     │                      │
└────────────────────────────┴──────────────────────┘
```

Switching, zooming and detaching are tmux's: `Ctrl-b` then `h/j/k/l` to move,
`z` to zoom a pane, `d` to detach. `tmux attach -t qwen-fleet` brings it back —
the agents keep running while you are away.

If tmux is not installed, start the agents yourself in separate terminals. They
only need `QWEN_BOARD` set to the same value.

## What the panel shows

The order is deliberate: **what needs you**, then **what is blocked on someone
else**, then **work in flight**. Anything already settled disappears.

| Prefix | Meaning                                              |
| ------ | ---------------------------------------------------- |
| `⚠ d-` | A decision waiting on you — nothing else unblocks it |
| `? a-` | An open question from one participant to another     |
| `· t-` | A task someone is working on                         |

## Working on a board

Every participant uses the same commands.

```bash
qwen board show                       # what is on the board right now
qwen board watch                      # the same, refreshed until you stop it

qwen board task "investigate the api contract"
qwen board claim t-1                  # take it before starting
qwen board done t-1 --note "status is an int, not a string"
```

### Asking another participant

Use this when you are genuinely blocked on something only they can answer.

```bash
qwen board ask agent-2 "does the client depend on status being a string?" --wait
```

`--wait` blocks until the question settles, then prints the answer. It always
settles — `answered`, `declined`, or `timeout` — so a caller never hangs
indefinitely. Exit status distinguishes them, and the default timeout is 30
seconds.

On the other side:

```bash
qwen board answer a-1 "yes, it parses it as a string"
qwen board decline a-1 "not my area"
```

### Asking _you_

Anything needing authority — approving a risky change, accepting a result,
settling a disagreement between two agents — becomes a decision. No agent can
resolve one:

```bash
qwen board raise "write src/client.ts?" --kind approval --about t-2
```

You resolve it:

```bash
qwen board resolve d-1 --approve
qwen board resolve d-1 --reject --note "use the existing adapter instead"
```

## Bringing in another tool

`--with` runs any command in its own pane:

```bash
qwen fleet up "audit the auth flow" --agents 1 --with codex --with "claude"
```

That pane gets `QWEN_BOARD` and `QWEN_BOARD_AS` in its environment — but a tool
that is not Qwen Code never reads them, and nothing can reach its prompt from
outside. Hand it the protocol yourself:

```bash
qwen board protocol --board orders
```

That prints the same instructions a Qwen session receives, filled in with the
real board and participant name. Paste it into the other agent once and it can
use every command below. Add `--json` for machine consumption:

```bash
qwen board show --json
qwen board ask reviewer "…" --wait --json
```

Nothing is pushed to any participant. Items sit on the board until someone
looks, which is exactly why a tool we did not write can take part — running a
command is the one thing every agent can do.

## Working across repositories

The board defaults to a name derived from the current directory, so a single
project needs no setup. Name it explicitly to span more than one:

```bash
cd ~/work/api && qwen board --board orders task "confirm the response shape"
cd ~/work/web && qwen board --board orders claim t-1
```

Two sessions in different repositories now share one board. The board is not the
directory, which is what makes this possible.

## Options

| Flag               | Applies to | Meaning                                                |
| ------------------ | ---------- | ------------------------------------------------------ |
| `--board <name>`   | all        | Board to use. Defaults to the project directory name   |
| `--as <name>`      | all        | Participant name to act as                             |
| `--json`           | all        | Emit JSON instead of text                              |
| `--wait`           | `ask`      | Block until the question settles                       |
| `--timeout <s>`    | `ask`      | Seconds to block. Default 30                           |
| `--ttl <m>`        | `ask`      | Minutes before the ask lapses to `timeout`. Default 15 |
| `--mine`           | `show`     | Only what is addressed to or owned by you              |
| `--agents <n>`     | `fleet up` | Qwen panes to open. Default 2                          |
| `--with <cmd>`     | `fleet up` | Run another command in its own pane. Repeatable        |
| `--session <name>` | `fleet up` | tmux session name. Default `qwen-fleet`                |

`QWEN_BOARD` and `QWEN_BOARD_AS` set the first two for a whole shell, which is
how each pane inherits them.

## Limits

- **Same machine, same user.** The board is a directory owned by your account;
  that is the whole access boundary. Nothing crosses machines.
- **Participation is cooperative.** A board cannot force an agent to claim work
  or answer a question. Agents that are not Qwen Code need `qwen board protocol`
  pasted into them; setting the environment variables is not enough on its own.
- **A running session cannot join yet.** Board awareness is decided when a
  session starts, from `QWEN_BOARD`. To bring an already-running Qwen session
  in, paste `qwen board protocol` into it — it can then use the commands, but it
  will not check the board on its own.
- **A named owner is a proposal.** Naming someone on a task records who is
  expected to take it; only claiming it makes it theirs.
- **There is no chat.** Everything is a task, a question, or a decision. Text
  that fits none of those belongs in a note on the task it concerns.

## Related

- [Multi-Agent Coordination](./multi-agent-coordination.md) — leader-and-teammates
  inside one session, when you want one agent to direct the others
- [Agent Arena](./arena.md) — several agents competing on the same task
