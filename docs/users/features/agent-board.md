# Agent Board

Agent Board lets independently started agents share work through files on the
same machine. It does not start, join, monitor, or send input to agent processes.

It is a low-level interoperability surface, not the Qwen Agent Team scheduler or
the cross-session messaging transport. A task owner is only a recorded label;
it does not start or wake a Qwen Code, Codex, or other agent process.

> Experimental. The on-disk format may change between releases.

## Use a board

Every command names the board explicitly. Every command that changes the board
also declares the actor with `--as`.

```bash
qwen board task "check the API response" --board orders --as api
qwen board show --board orders
```

The first command prints a task id. Another agent can claim and complete it:

```bash
qwen board claim <task-id> --board orders --as web
qwen board done <task-id> --board orders --as web --note "status is numeric"
```

`--as` is a label recorded with the action, not authentication. There is no
membership list, join command, heartbeat, or reserved participant name.

## Ask a question

```bash
qwen board ask web "does the client parse status as text?" \
  --board orders --as api --wait
```

The receiver uses the same label when answering or declining:

```bash
qwen board answer <ask-id> "yes" --board orders --as web
qwen board decline <ask-id> "not my area" --board orders --as web
```

With `--wait`, exit code `0` means answered, `2` declined, `3` the ask's TTL
expired, and `4` the local wait ended while the ask was still open. `--timeout`
sets the local wait in seconds; `--ttl` sets the ask lifetime in seconds.

## Machine-readable output

Add `--json` to receive JSON without ANSI formatting:

```bash
qwen board show --board orders --as web --json
```

Passing `--as` to `show` filters tasks to that owner and asks to or from that
actor.

## Housekeeping

Settled records remain until explicitly pruned:

```bash
qwen board prune --board orders --as human --older-than 7
```

The cutoff is in days. Pruning rechecks each record while holding its lock, so
an item changed after the scan is not deleted from stale information.

## Limits

- Boards live under `~/.qwen/boards/` and are scoped to the current OS user.
- Nothing is pushed into an agent. Each participant chooses when to read.
- Board text is untrusted data and is never automatically executed.
- Multiple agents writing the same checkout is not supported.
- Slash commands, footer polling, fleet/tmux orchestration, and remote boards
  are not part of this first version.
