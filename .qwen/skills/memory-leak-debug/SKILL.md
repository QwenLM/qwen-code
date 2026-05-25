---
name: memory-leak-debug
description: Diagnose memory leaks in the Qwen Code CLI using heap snapshots and
  the chrome-devtools CLI. Use when investigating high memory usage, unbounded
  growth, or suspected object retention issues.
---

# Memory Leak Debugging

Diagnose memory leaks in the Qwen Code Node.js CLI by capturing heap snapshots
and analyzing retained object sizes via `chrome-devtools` CLI tooling.

## Prerequisites

- `chrome-devtools` CLI (from `chrome-devtools-mcp` package). If not found,
  install with: `npm i chrome-devtools-mcp@latest -g` after user confirmation.
  See https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/cli.md
- Node.js 22+ (for `--heapsnapshot-signal` support)

## Step 1: Start the CLI with Snapshot Signal

Use tmux so you can interact with the TUI and trigger snapshots from another
pane. Use the tmux-real-user-testing helper script:

```bash
HELPER=.qwen/skills/tmux-real-user-testing/scripts/tmux-real-user-log.sh
eval "$(bash "$HELPER" start memleak . \
  env QWEN_CODE_NO_RELAUNCH=true NODE_OPTIONS=--heapsnapshot-signal=SIGUSR2 \
  npm run dev)"
echo "SESSION=$SESSION OUTDIR=$OUTDIR"
```

The `eval` exports `SESSION` and `OUTDIR`. Note: shell environment does not
persist across separate tool calls — save the session name from the output and
use it explicitly in subsequent commands.

Notes:

- `npm run dev` runs from TypeScript source via tsx — no build step needed and
  changes to core/cli are reflected immediately.
- `QWEN_CODE_NO_RELAUNCH=true` prevents the CLI from spawning a child process,
  so PID management is simpler.
- `NODE_OPTIONS` propagates the flag through npm → tsx → node.

Get the PID of the actual node process. With `npm run dev`, there's a process
chain (npm → node scripts/dev.js → tsx → node CLI), so walk the tree to the
innermost node child:

```bash
NODE_PID=$(bash .qwen/skills/memory-leak-debug/scripts/find-leaf-node.sh "<session-name>")
```

To profile the production bundle instead (e.g., verifying tree-shaking):
`npm run bundle` first, then use
`env QWEN_CODE_NO_RELAUNCH=true node --heapsnapshot-signal=SIGUSR2 dist/cli.js`
as the command. Since node is the direct pane process, PID discovery is simpler:

```bash
NODE_PID=$(tmux list-panes -t "<session-name>" -F '#{pane_pid}')
```

## Step 2: Exercise the Suspected Leak

Drive the TUI via tmux (see tmux-real-user-testing skill for patterns). Take
snapshots at intervals to compare:

```bash
kill -USR2 $NODE_PID   # snapshot 1 (baseline)
# ... use the CLI via tmux send-keys ...
kill -USR2 $NODE_PID   # snapshot 2 (after activity)
# ... more activity ...
kill -USR2 $NODE_PID   # snapshot 3 (confirm growth trend)
```

Snapshots are written to the CLI's working directory as
`Heap.<timestamp>.<pid>.<seq>.heapsnapshot`.

## Step 3: Start chrome-devtools Daemon

```bash
chrome-devtools start --experimentalMemory --headless --no-usage-statistics
```

This starts the daemon in file-analysis mode — no browser or live Node
connection is needed. The memory tools work entirely on `.heapsnapshot` files.

## Step 4: Identify the Leak

### Load and summarize

```bash
chrome-devtools load_memory_snapshot /abs/path/to/snapshot.heapsnapshot
```

Returns total heap size, V8 heap breakdown, node count.

### Get class-level aggregates with retained sizes

```bash
chrome-devtools get_memory_snapshot_details /abs/path/to/snapshot.heapsnapshot
```

Output is CSV: `uid, className, count, selfSize, maxRetainedSize`.

Compare across snapshots to find classes whose count or retained size grows
unboundedly.

### Inspect instances of a leaking class

```bash
chrome-devtools get_nodes_by_class /abs/path/to/snapshot.heapsnapshot <uid>
```

Where `<uid>` is from the `get_memory_snapshot_details` output. Returns
individual instances with their `id`, `retainedSize`, and `nodeIndex`.

### Trace retainer chains

```bash
chrome-devtools get_node_retainers /abs/path/to/snapshot.heapsnapshot <nodeId>
```

Where `<nodeId>` is the `id` field from `get_nodes_by_class`. Shows what holds
the object alive — follow the chain to find the root retention path.

## Step 5: Identify Root Cause

Common patterns:

- **Unbounded buffer/array**: An array that accumulates entries without eviction
  (e.g., `performance.measure()` → `measureEntryBuffer`).
- **Event listener leak**: Listeners registered on long-lived emitters without
  cleanup.
- **Closure capture**: A closure inadvertently captures a large object that
  outlives its intended scope.
- **Module-level cache**: A Map/Set at module scope that grows with usage.

The retainer chain tells you _what_ holds the object; the class aggregate
growth rate tells you _how fast_ it leaks.

## Step 6: Verify Fix

After applying the fix:

1. Rebuild: `npm run bundle`
2. Repeat Steps 1-4 with the same workload.
3. Confirm the leaking class count stabilizes (no longer grows with activity).

## Cleanup

```bash
HELPER=.qwen/skills/tmux-real-user-testing/scripts/tmux-real-user-log.sh
bash "$HELPER" finish "<session-name>" "<outdir>"
chrome-devtools stop
rm *.heapsnapshot  # if no longer needed
```

## Worked Example

See `examples/react-reconciler-performance-measure-leak.md` for the ink 7
upgrade leak that caused ~143 MB retention from `PerformanceMeasure` objects.
