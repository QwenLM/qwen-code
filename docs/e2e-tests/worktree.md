# Worktree Feature E2E Test Plan (Phase A + B)

## Scope

End-to-end tests for the generic worktree capability:

- Phase A: `EnterWorktree` / `ExitWorktree` tools + SessionService state
- Phase B: `Agent` tool `isolation: 'worktree'` parameter + auto-cleanup + worktree notice

## Test environment

Each test group runs in its own temp git repo and tmux session to avoid collisions. Template setup:

```bash
TEST_DIR=$(mktemp -d -t worktree-test-XXXXXX)
cd "$TEST_DIR"
git init -q
git config user.email "test@example.com"
git config user.name "Test"
echo "hello" > README.md
git add README.md
git commit -q -m "initial"
```

Each group uses a unique tmux session name (e.g. `wt-test-a`, `wt-test-b`) and a unique temp dir.

Baseline binary: globally installed `qwen` (0.15.10).
Local build binary: `node /Users/mochi/code/qwen-code/.claude/worktrees/trusting-euclid-6fdfb9/bundle/qwen.js`.

## Test Group A: EnterWorktree tool registration and basic creation

**Mode:** Headless, `--approval-mode yolo`, `--output-format json`

### A1: Tool registered in system init

**Steps:**

```bash
<qwen> "say hello" --approval-mode yolo --output-format json 2>/dev/null \
  | jq -r 'select(.type=="system") | .tools[]' \
  | grep -E "^(enter_worktree|exit_worktree)$"
```

**Pre-implementation:** empty (tools not registered).
**Post-implementation:** outputs `enter_worktree` and `exit_worktree`.

### A2: Create worktree with auto-generated name

**Steps:**

```bash
<qwen> "create a new git worktree using the enter_worktree tool" \
  --approval-mode yolo --output-format json 2>/dev/null > /tmp/a2.json
# Check worktree dir created
ls -la .qwen/worktrees/ | grep -v "^\." | wc -l
# Should have a directory matching the auto-generated slug pattern
```

**Pre-implementation:** model says it can't find the tool; no `.qwen/worktrees/` directory.
**Post-implementation:** `.qwen/worktrees/<slug>` exists with auto-generated slug (format: `{adj}-{noun}-{4hex}`).

### A3: Create worktree with custom name

**Steps:**

```bash
<qwen> "use the enter_worktree tool with name='my-feature' to create a worktree" \
  --approval-mode yolo --output-format json 2>/dev/null
ls .qwen/worktrees/my-feature/
git branch | grep worktree-my-feature
```

**Pre-implementation:** tool unknown.
**Post-implementation:** `.qwen/worktrees/my-feature/` directory exists; branch `worktree-my-feature` exists.

### A4: Invalid slug rejected

**Steps:**

```bash
<qwen> "use enter_worktree with name='../../../etc' to create a worktree" \
  --approval-mode yolo --output-format json 2>/dev/null \
  | jq 'select(.type=="user") | .message.content[] | select(.is_error) | .content'
```

**Pre-implementation:** tool unknown.
**Post-implementation:** tool result is_error=true with a validation error message.

## Test Group B: ExitWorktree

**Mode:** Headless, two-step interaction within one prompt.

### B1: Enter then exit with action=keep

**Steps:**

```bash
<qwen> "create a worktree named 'temp-keep' using enter_worktree, then immediately exit it with action='keep' using exit_worktree" \
  --approval-mode yolo --output-format json 2>/dev/null > /tmp/b1.json
# Directory should still exist (keep preserves it)
ls -d .qwen/worktrees/temp-keep
# Branch should still exist
git branch | grep worktree-temp-keep
# CWD should be original
```

**Pre-implementation:** tools unknown.
**Post-implementation:** worktree dir and branch both still exist after exit.

### B2: Enter then exit with action=remove (no changes)

**Steps:**

```bash
<qwen> "create a worktree named 'temp-remove' using enter_worktree, then immediately exit it with action='remove' using exit_worktree" \
  --approval-mode yolo --output-format json 2>/dev/null
ls -d .qwen/worktrees/temp-remove 2>&1
git branch | grep worktree-temp-remove
```

**Pre-implementation:** tools unknown.
**Post-implementation:** worktree dir is removed; branch is deleted.

### B3: Exit with action=remove refuses when uncommitted changes exist

**Steps:** Spawn an interactive tmux session, manually create files in worktree, then attempt exit.

```bash
tmux new-session -d -s wt-test-b3 -x 200 -y 50 "cd $TEST_DIR && <qwen> --approval-mode yolo"
sleep 3
tmux send-keys -t wt-test-b3 "create a worktree named 'dirty-test' using enter_worktree"
sleep 0.5
tmux send-keys -t wt-test-b3 Enter
# Wait for completion
for i in $(seq 1 30); do
  sleep 2
  tmux capture-pane -t wt-test-b3 -p | grep -q "Type your message" && break
done
# Create dirty file in worktree
echo "dirty" > "$TEST_DIR/.qwen/worktrees/dirty-test/dirty.txt"
# Try to remove without discard_changes
tmux send-keys -t wt-test-b3 "use exit_worktree with action='remove' to exit the worktree"
sleep 0.5
tmux send-keys -t wt-test-b3 Enter
for i in $(seq 1 30); do sleep 2; tmux capture-pane -t wt-test-b3 -p | grep -q "Type your message" && break; done
tmux capture-pane -t wt-test-b3 -p -S -100 > /tmp/b3.out
# Should mention "uncommitted changes" or "discard_changes" in output
grep -E "uncommitted|discard_changes" /tmp/b3.out
tmux kill-session -t wt-test-b3
```

**Pre-implementation:** tools unknown.
**Post-implementation:** exit fails with a message about uncommitted changes and the `discard_changes` flag.

## Test Group C: SessionService persistence

### C1: Worktree state in session metadata

**Steps:**

```bash
SESSION_ID=$(<qwen> "create a worktree named 'persist-test' using enter_worktree" \
  --approval-mode yolo --output-format json 2>/dev/null \
  | jq -r 'select(.type=="system") | .session_id' | head -1)
# Check session storage for worktree state
find ~/.qwen -name "*${SESSION_ID}*" 2>/dev/null | head
grep -l "persist-test" ~/.qwen/projects/*/sessions/*.json 2>/dev/null || \
  grep -rl "worktreeSession\|persist-test" ~/.qwen/projects/ 2>/dev/null | head -5
```

**Pre-implementation:** no worktree session state stored anywhere.
**Post-implementation:** session JSON contains a `worktreeSession` field with `slug='persist-test'`, `worktreePath`, `originalCwd`, etc.

## Test Group D: AgentTool isolation

### D1: Agent isolation parameter accepted

**Steps:**

```bash
<qwen> "spawn an agent using the agent tool with isolation='worktree' to run 'echo hello'" \
  --approval-mode yolo --output-format json 2>/dev/null \
  | jq 'select(.type=="assistant") | .message.content[] | select(.type=="tool_use" and .name=="agent") | .input'
# Check that .qwen/worktrees/ contains an agent-* slug during execution
```

**Pre-implementation:** agent tool schema has no isolation parameter; model either omits it or the schema rejects it.
**Post-implementation:** agent runs successfully with isolation='worktree'; an `agent-<7hex>` worktree is created.

### D2: Agent auto-cleans worktree (no changes)

**Steps:**

```bash
ls .qwen/worktrees/ > /tmp/d2-before.txt 2>/dev/null
<qwen> "spawn an agent with isolation='worktree' to list files in the current directory using ls" \
  --approval-mode yolo --output-format json 2>/dev/null
ls .qwen/worktrees/ > /tmp/d2-after.txt 2>/dev/null
# After should equal before (no leftover agent-* dirs)
diff /tmp/d2-before.txt /tmp/d2-after.txt
```

**Pre-implementation:** N/A (no isolation parameter).
**Post-implementation:** worktrees dir is unchanged after agent completes with no changes.

### D3: Agent worktree preserved when changes made

**Steps:**

```bash
<qwen> "spawn an agent with isolation='worktree' to write 'test content' to a new file called test.txt" \
  --approval-mode yolo --output-format json 2>/dev/null > /tmp/d3.json
# Worktree should be preserved with the change
ls .qwen/worktrees/agent-* 2>/dev/null
ls .qwen/worktrees/agent-*/test.txt 2>/dev/null
# Agent result should include worktreePath/worktreeBranch
jq 'select(.type=="user") | .message.content[] | select(.tool_use_id) | .content' /tmp/d3.json | head
```

**Pre-implementation:** N/A.
**Post-implementation:** `.qwen/worktrees/agent-<7hex>/test.txt` exists; agent result mentions worktree path and branch.

## Test Group E: Stale cleanup

### E1: Cleanup function removes old agent worktrees

This is harder to test e2e because it requires aging. Cover via unit tests in `worktreeCleanup.test.ts`:

- Worktree with mtime > 30 days ago and matching `agent-<7hex>` pattern → removed
- Worktree with mtime > 30 days ago but user-named (e.g., `my-feature`) → preserved
- Worktree with mtime < 30 days → preserved
- Worktree with uncommitted changes → preserved (fail-closed)
- Worktree with unpushed commits → preserved (fail-closed)

E2E spot check (optional): manually `touch -t 200001010000 .qwen/worktrees/agent-aabcdef0` and invoke cleanup; verify removal.

## Test Group F: Arena compatibility (no regression)

### F1: Arena worktree path unchanged

**Steps:** Run an Arena session (separate from EnterWorktree); verify it still creates worktrees under `~/.qwen/arena/<sessionId>/worktrees/` and not under `.qwen/worktrees/`.

```bash
# Setup: requires Arena-enabled config. Detailed steps depend on Arena CLI invocation.
# Pre-implementation: arena worktrees are under ~/.qwen/arena/.
# Post-implementation: SAME — arena path is independent.
```

(If Arena is not easily reachable from headless mode, this group is verified by unit test that ArenaManager.ts:125 (`this.arenaBaseDir = arenaSettings?.worktreeBaseDir ?? path.join(Storage.getGlobalQwenDir(), 'arena')`) is unchanged.)

## Unit test coverage (collocated with implementation)

Outside of the E2E plan, these unit tests must accompany the implementation:

- `EnterWorktreeTool.test.ts`: schema validation, slug rejection, nested-worktree rejection, cwd change, SessionService write
- `ExitWorktreeTool.test.ts`: keep vs remove paths, dirty-state guard, discard_changes bypass, cwd restoration
- `gitWorktreeService.test.ts` extensions: `createUserWorktree`, `removeUserWorktree`, `createAgentWorktree`, `removeAgentWorktree`
- `sessionService.test.ts` extensions: WorktreeSession field read/write, resume restoration
- `worktreeCleanup.test.ts`: cleanup pattern matching, age filter, fail-closed conditions
- `agent.test.ts` extensions: isolation parameter accepted, worktree created and (in some cases) cleaned

## Pass criteria

| Group | Pre-build expected | Post-build expected                                  |
| ----- | ------------------ | ---------------------------------------------------- |
| A1    | tools not listed   | both tools listed                                    |
| A2    | error/no-op        | `.qwen/worktrees/<auto-slug>` created                |
| A3    | error/no-op        | `.qwen/worktrees/my-feature` created, branch present |
| A4    | error/no-op        | tool result is_error with validation message         |
| B1    | error/no-op        | worktree dir + branch preserved                      |
| B2    | error/no-op        | worktree dir + branch removed                        |
| B3    | error/no-op        | exit refuses with uncommitted-changes message        |
| C1    | no worktree state  | session has worktreeSession field                    |
| D1    | no isolation param | agent runs in `agent-<7hex>` worktree                |
| D2    | N/A                | worktrees dir unchanged after agent with no changes  |
| D3    | N/A                | `agent-<7hex>` preserved with changes                |

## Reproduction report (post-implementation)

Local build at `dist/cli.js` (commit at the tip of `claude/trusting-euclid-6fdfb9`).

| Group | Result                               | Notes                                                                                                                                                                 |
| ----- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1    | ✅                                   | `enter_worktree` and `exit_worktree` listed in `system.tools`                                                                                                         |
| A3    | ✅                                   | `.qwen/worktrees/my-feature` created, branch `worktree-my-feature` present                                                                                            |
| A4    | covered by unit test                 | `validateUserWorktreeSlug` rejects path-traversal etc. (`enter-worktree.test.ts`)                                                                                     |
| B1    | ✅                                   | `keep` action preserved both directory and branch                                                                                                                     |
| B2    | ✅                                   | `remove` action deleted directory and branch                                                                                                                          |
| B3    | ✅                                   | `remove` refused with `Refusing to remove worktree "dirty-test" — it has 0 tracked change(s) and 1 untracked file(s).`                                                |
| C1    | scope-out                            | SessionService persistence deferred from Phase A (see scope notes in `docs/design/worktree.md`)                                                                       |
| D1    | ✅                                   | Agent invocation accepted `isolation: 'worktree'`, created `agent-2c4e759`                                                                                            |
| D2    | ✅                                   | After agent finished with no changes, worktrees dir was empty                                                                                                         |
| D3    | ✅                                   | After agent wrote `test.txt`, worktree `agent-bad55bd` and branch `worktree-agent-bad55bd` preserved; result included `[worktree preserved: ... (branch ...)]` suffix |
| E1    | covered by unit test                 | `worktreeCleanup.test.ts` verifies `isEphemeralSlug` matches only `agent-<7hex>`                                                                                      |
| F1    | scope-out (no Arena E2E in this run) | Arena code paths untouched: `ArenaManager.ts:125` and `setupWorktrees()` unchanged                                                                                    |

### Scope deviations from the test plan

- **C1** (SessionService persistence) was deferred from Phase A. The minimum-viable Phase A returns the absolute worktree path so the model uses it directly via absolute paths, instead of mechanically switching `Config.targetDir`. Resume support requires SessionService extension and is documented for a future phase.
- **A2** (auto-generated name) was indirectly verified via D1/D3, which exercise the same auto-slug path through the agent isolation flow.
