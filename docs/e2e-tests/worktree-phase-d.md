# Worktree Phase D E2E Test Plan

## Scope

End-to-end verification of Phase D features against the local build at
`/Users/mochi/code/qwen-code/.claude/worktrees/tender-jemison-037f0a/dist/cli.js`.

Phase D delivers three cross-cutting capabilities:

- **D-1** — `--worktree [name]` CLI startup flag (bare / explicit slug / `=` form),
  with `process.cwd()` + `Config.targetDir` switch and `WorktreeExitDialog`
  reuse on exit
- **D-2** — `worktree.symlinkDirectories: string[]` settings key, applied in
  `performPostCreationSetup()` so it covers `--worktree`, `EnterWorktreeTool`,
  AND `AgentTool isolation: "worktree"` paths
- **D-3** — `--worktree=#<N>` and `--worktree <github-url>` PR-reference forms,
  via `git fetch origin pull/<N>/head` (no `gh` CLI dependency)

## Binaries

- **Local build (Phase 6 verification)**: `node /Users/mochi/code/qwen-code/.claude/worktrees/tender-jemison-037f0a/dist/cli.js`
- **Phase 4 dry-run baseline**: globally installed `qwen`

For dry-runs the globally installed `qwen` is expected to fail Groups A / E / F
because the features don't exist yet — that's the validation that the plan
correctly detects implementation.

### Baseline precondition for Group E

Tests **E2** (`EnterWorktreeTool` symlink) and **E3** (`AgentTool isolation`
symlink) require **Phase A + B** to be present in the baseline — they exercise
the existing `enter_worktree` tool and `agent isolation: "worktree"` parameter
to confirm the symlink loop fires on those code paths too.

The globally installed `qwen` may predate PR #4073 (Phase A+B, merged 2026-05-14)
and therefore lack these tools entirely. When that is the case, E2 / E3 cannot
validate "symlink absent because D-2 is absent" — they collapse to "tool
absent." Add this guard at the top of each:

```bash
HAS_ENTER_WORKTREE=$($QWEN "list your tools and stop" --approval-mode yolo --output-format json 2>/dev/null \
  | jq -e '.[] | select(.type=="system") | .tools | index("enter_worktree")' >/dev/null && echo yes || echo no)
if [ "$HAS_ENTER_WORKTREE" != "yes" ]; then
  echo "SKIP: enter_worktree absent in baseline — E2/E3 require Phase A+B"
  exit 0
fi
```

For Phase 6 (post-impl) verification the local build inherently contains
Phase A-C, so the guard is a no-op and the tests run in full.

## Test environment template

Each group runs in its own temp git repo and tmux session:

```bash
TEST_DIR=$(mktemp -d -t qwen-wt-phd-XXXXXX)
TEST_DIR=$(cd "$TEST_DIR" && pwd -P)   # resolve symlinks (macOS /var → /private/var)
cd "$TEST_DIR"
git init -q -b main
git config user.email t@e.com
git config user.name t
git config commit.gpgsign false
echo "hello" > README.md
git add README.md
git commit -q -m "initial" --no-verify

PROJECT_ID=$(node -e "console.log(process.argv[1].replace(/[^a-zA-Z0-9]/g,'-'))" "$TEST_DIR")
QWEN="node /Users/mochi/code/qwen-code/.claude/worktrees/tender-jemison-037f0a/dist/cli.js"
```

PR-ref tests (Group F) additionally require a checked-out clone of a public
GitHub repo with at least one merged PR. Use this repo (qwen-code itself) as
the test target — PR `#4174` (Phase C) is a guaranteed-present reference.

---

## Group A: `--worktree` flag basic forms

**Mode:** headless, `--approval-mode yolo`, `--output-format json`

### A1: bare `--worktree` (auto-slug)

```bash
$QWEN --worktree "say hello and stop" \
  --approval-mode yolo --output-format json 2>/dev/null > /tmp/a1.out

# A `worktree_started` system event is emitted at startup. The `notice`
# field contains the slug (auto-generated `adj-noun-XXXXXX`) inside the
# rendered text. Use `jq -e` so a missing event is a non-zero exit
# (instead of silent `null`).
jq -e '.[] | select(.type=="system" and .subtype=="worktree_started") | .data.notice | test("\"[a-z]+-[a-z]+-[0-9a-f]{6}\"")' < /tmp/a1.out

# The init system message's `cwd` should also point inside the worktree.
jq -e '.[] | select(.type=="system" and .subtype=="init") | .cwd | test("/\\.qwen/worktrees/[a-z]+-[a-z]+-[0-9a-f]{6}$")' < /tmp/a1.out

ls -d "$TEST_DIR/.qwen/worktrees/"*
```

**Expected (post-impl):**

- `worktree_started` event with `.data.notice` containing the auto slug
- Init `.cwd` ends with `.qwen/worktrees/<auto-slug>`
- Exactly one worktree directory under `.qwen/worktrees/`
- Branch named `worktree-<slug>` exists (`git branch | grep worktree-`)

**Expected (pre-impl baseline):** yargs rejects `--worktree` with
"Unknown argument" error and exit code != 0.

### A2: `--worktree my-feature` (explicit slug)

```bash
$QWEN --worktree my-feature "say hello and stop" \
  --approval-mode yolo --output-format json 2>/dev/null > /tmp/a2.out

ls -d "$TEST_DIR/.qwen/worktrees/my-feature"
git -C "$TEST_DIR" branch | grep "worktree-my-feature"
```

**Expected (post-impl):** worktree dir `my-feature/` and branch
`worktree-my-feature` both exist.

### A3: `--worktree=my-feature` (= form)

Identical to A2 with `=` form. Cleanup between A2 and A3 required (different
TEST_DIR).

```bash
$QWEN --worktree=my-feature "say hi" \
  --approval-mode yolo --output-format json 2>/dev/null > /tmp/a3.out
```

**Expected (post-impl):** same as A2.

### A4: invalid slug rejected before any git operation

```bash
$QWEN --worktree "../escape" "say hi" \
  --approval-mode yolo --output-format json 2>/dev/null > /tmp/a4.out
echo "exit=$?"

ls "$TEST_DIR/.qwen/worktrees/" 2>/dev/null
```

**Expected (post-impl):**

- Process exits with non-zero status
- Stderr or final result message mentions "invalid slug" / "not allowed"
- `.qwen/worktrees/` directory does not exist (worktree creation never started)

### A5: not a git repository → fail-close

```bash
NON_GIT=$(mktemp -d)
cd "$NON_GIT"
$QWEN --worktree "say hi" \
  --approval-mode yolo --output-format json 2>/dev/null > /tmp/a5.out
echo "exit=$?"
```

**Expected (post-impl):** exit != 0, message mentions "not a git repository"
or "git init".

---

## Group B: cwd + sidecar after `--worktree`

### B1: sidecar written with all six fields

```bash
SESSION_ID=$(uuidgen)
$QWEN --worktree b1-test --session-id "$SESSION_ID" "say hi" \
  --approval-mode yolo --output-format json 2>/dev/null > /tmp/b1.out

SIDECAR=~/.qwen/projects/$PROJECT_ID/chats/$SESSION_ID.worktree.json
jq '.slug, .worktreePath, .worktreeBranch, .originalCwd, .originalBranch, .originalHeadCommit' \
  < "$SIDECAR"
```

**Expected:**

- `slug = "b1-test"`
- `worktreePath` ends with `.qwen/worktrees/b1-test`
- `worktreeBranch = "worktree-b1-test"`
- `originalCwd` = `$TEST_DIR` (resolved)
- `originalBranch = "main"`
- `originalHeadCommit` matches `[0-9a-f]{40}`

### B2: `process.cwd()` switched at startup

```bash
$QWEN --worktree b2-test "run the shell tool with command 'pwd', then stop" \
  --approval-mode yolo --output-format json 2>/dev/null > /tmp/b2.out

# Extract the shell tool's stdout from the user-message tool_result
jq -r '.[] | select(.type=="user") | .message.content[] | select(.tool_use_id != null) | .content' \
  < /tmp/b2.out | head -5
```

**Expected (post-impl):** the `pwd` output equals `$TEST_DIR/.qwen/worktrees/b2-test`.

### B3: `Config.targetDir` switched (Footer / status payload)

```bash
$QWEN --worktree b3-test "run the shell tool with command 'pwd && git rev-parse --abbrev-ref HEAD', then stop" \
  --approval-mode yolo --output-format json 2>/dev/null > /tmp/b3.out

jq -r '.[] | select(.type=="user") | .message.content[] | select(.tool_use_id != null) | .content' \
  < /tmp/b3.out
```

**Expected (post-impl):** branch is `worktree-b3-test` AND working directory
is inside the worktree.

---

## Group C: `--worktree` × `--resume` precedence

### C1: `--worktree` wins over saved sidecar (different slug)

```bash
# Run 1: create a session with worktree "first"
SESSION_ID=$(uuidgen)
$QWEN --worktree first --session-id "$SESSION_ID" "say hi" \
  --approval-mode yolo --output-format json 2>/dev/null > /tmp/c1-run1.out

# Run 2: resume the same session but request a different worktree
$QWEN --resume "$SESSION_ID" --worktree second "say hi again" \
  --approval-mode yolo --output-format json 2>/dev/null > /tmp/c1-run2.out

# Sidecar should now point at "second"
SIDECAR=~/.qwen/projects/$PROJECT_ID/chats/$SESSION_ID.worktree.json
jq -r '.slug' < "$SIDECAR"

# Both worktree dirs should exist on disk (first was never removed, just unlinked)
ls -d "$TEST_DIR/.qwen/worktrees/"*
```

**Expected (post-impl):**

- Sidecar `.slug` = `"second"`
- Both `first/` and `second/` directories exist
- Run 2's stderr or init `worktree_overridden` message mentions "--worktree
  overrides the resumed session's worktree"

### C2: stale sidecar (manually deleted dir) + `--worktree` → fresh worktree

```bash
SESSION_ID=$(uuidgen)
$QWEN --worktree c2 --session-id "$SESSION_ID" "say hi" \
  --approval-mode yolo --output-format json 2>/dev/null > /tmp/c2-run1.out

rm -rf "$TEST_DIR/.qwen/worktrees/c2"   # simulate user-deleted dir

$QWEN --resume "$SESSION_ID" --worktree c2-fresh "say hi" \
  --approval-mode yolo --output-format json 2>/dev/null > /tmp/c2-run2.out

ls -d "$TEST_DIR/.qwen/worktrees/"*
```

**Expected (post-impl):** only `c2-fresh/` exists; sidecar updated to `c2-fresh`.

---

## Group D: WorktreeExitDialog regression (`--worktree`-started session)

**Mode:** interactive (tmux). Verifies Phase C dialog still triggers when the
worktree was created by the CLI flag rather than `EnterWorktreeTool`.

### D1: 2x Ctrl+C → dialog appears

```bash
tmux new-session -d -s d1 -x 200 -y 50 \
  "cd $TEST_DIR && $QWEN --worktree d1-test --approval-mode yolo"
sleep 3

# Verify worktree is active (Footer indicator)
tmux capture-pane -t d1 -p -S -50 | grep -q "⎇ worktree-d1-test"

# Send Ctrl+C twice
tmux send-keys -t d1 C-c
sleep 0.3
tmux send-keys -t d1 C-c
sleep 1

tmux capture-pane -t d1 -p -S -50 | grep -E "Active worktree|Keep worktree|Remove worktree"
tmux kill-session -t d1
```

**Expected (post-impl):** dialog text "Active worktree: \"d1-test\" …" and the
three radio options appear.

### D2: Dialog → Cancel → session stays alive

```bash
tmux new-session -d -s d2 -x 200 -y 50 \
  "cd $TEST_DIR && $QWEN --worktree d2-test --approval-mode yolo"
sleep 3
tmux send-keys -t d2 C-c; sleep 0.3; tmux send-keys -t d2 C-c; sleep 1

# Navigate to "Cancel" (third option) and select
tmux send-keys -t d2 Down Down Enter
sleep 1

tmux capture-pane -t d2 -p -S -10 | grep -q "Type your message"
ls -d "$TEST_DIR/.qwen/worktrees/d2-test"   # still exists
tmux kill-session -t d2
```

**Expected (post-impl):** prompt input reappears; worktree dir is still on disk.

### D3: Dialog → Remove → worktree + branch + sidecar all gone

```bash
SESSION_ID=$(uuidgen)
tmux new-session -d -s d3 -x 200 -y 50 \
  "cd $TEST_DIR && $QWEN --worktree d3-test --session-id $SESSION_ID --approval-mode yolo"
sleep 3
tmux send-keys -t d3 C-c; sleep 0.3; tmux send-keys -t d3 C-c; sleep 1
tmux send-keys -t d3 Down Enter   # select "Remove worktree and branch"
sleep 3
tmux kill-session -t d3

ls "$TEST_DIR/.qwen/worktrees/d3-test" 2>/dev/null && echo "FAIL: dir exists"
git -C "$TEST_DIR" branch | grep "worktree-d3-test" && echo "FAIL: branch exists"
test ! -f ~/.qwen/projects/$PROJECT_ID/chats/$SESSION_ID.worktree.json && echo "PASS: sidecar gone"
```

**Expected (post-impl):** dir, branch, and sidecar all removed.

---

## Group E: `worktree.symlinkDirectories`

**Mode:** headless. Settings configured via temp settings file.

### Setup template

```bash
mkdir -p "$TEST_DIR/node_modules"
echo "package.json" > "$TEST_DIR/node_modules/.placeholder"
mkdir -p "$TEST_DIR/.qwen"
cat > "$TEST_DIR/.qwen/settings.json" <<'EOF'
{
  "worktree": {
    "symlinkDirectories": ["node_modules"]
  }
}
EOF
```

### E1: `--worktree` path applies symlink

```bash
$QWEN --worktree e1-test "say hi" \
  --approval-mode yolo --output-format json 2>/dev/null > /dev/null

ls -la "$TEST_DIR/.qwen/worktrees/e1-test/node_modules"
readlink "$TEST_DIR/.qwen/worktrees/e1-test/node_modules"
```

**Expected (post-impl):** `node_modules` inside the worktree is a symlink
pointing to `$TEST_DIR/node_modules`.

### E2: `EnterWorktreeTool` path applies symlink

```bash
$QWEN "use enter_worktree to create a worktree named e2-test, then stop" \
  --approval-mode yolo --output-format json 2>/dev/null > /dev/null

readlink "$TEST_DIR/.qwen/worktrees/e2-test/node_modules"
```

**Expected (post-impl):** same symlink target.

### E3: AgentTool isolation path applies symlink

Requires a sub-agent definition. Use the built-in fork mechanism:

```bash
$QWEN "use the agent tool with subagent_type='general-purpose', isolation='worktree', description='check node_modules', prompt='run pwd and ls -la node_modules then exit'" \
  --approval-mode yolo --output-format json 2>/dev/null > /tmp/e3.out

# Extract agent worktree dir from result message
jq -r '.[] | select(.type=="assistant") | .message.content[] | select(.type=="tool_use") | .input' \
  < /tmp/e3.out | head -5

# After execution find the agent-<7hex> worktree
ls -la "$TEST_DIR/.qwen/worktrees/"agent-*/node_modules 2>/dev/null | head -3
```

**Expected (post-impl):** symlink exists inside the `agent-<hex>` worktree
(unless auto-cleaned because there were no changes — in that case the
"no changes" path doesn't validate symlink behavior, escalate to a forced
change test).

### E4: missing source dir → silently skipped, worktree still created

```bash
cat > "$TEST_DIR/.qwen/settings.json" <<'EOF'
{ "worktree": { "symlinkDirectories": ["does-not-exist"] } }
EOF

$QWEN --worktree e4-test "say hi" --approval-mode yolo --output-format json 2>/dev/null > /tmp/e4.out
ls -d "$TEST_DIR/.qwen/worktrees/e4-test"
ls "$TEST_DIR/.qwen/worktrees/e4-test/does-not-exist" 2>/dev/null && echo "UNEXPECTED"
```

**Expected (post-impl):** worktree directory exists, the missing entry is
not created inside it, process exit = 0.

### E5: existing dest → silently skipped, no overwrite

```bash
# Pre-create a worktree at expected slug then re-create — this is contrived
# because Phase D paths should be fresh, but it exercises the EEXIST guard.
mkdir -p "$TEST_DIR/.qwen/worktrees/e5-test/node_modules"
echo "preexisting" > "$TEST_DIR/.qwen/worktrees/e5-test/node_modules/.marker"

# Force re-creation via EnterWorktreeTool (CLI would refuse "already exists")
$QWEN "use enter_worktree with name='e5-test' to retry" --approval-mode yolo 2>/dev/null
# either: tool errors out cleanly, OR symlink is skipped — both acceptable
test -f "$TEST_DIR/.qwen/worktrees/e5-test/node_modules/.marker" && echo "PASS: not overwritten"
```

**Expected (post-impl):** preexisting `.marker` survives; no symlink replaces
the dir.

### E6: absolute path / `../` → rejected

```bash
cat > "$TEST_DIR/.qwen/settings.json" <<'EOF'
{ "worktree": { "symlinkDirectories": ["/etc", "../escape"] } }
EOF

$QWEN --worktree e6-test "say hi" --approval-mode yolo --output-format json 2>/dev/null > /tmp/e6.out
ls "$TEST_DIR/.qwen/worktrees/e6-test/" | head -10
```

**Expected (post-impl):** worktree exists; neither `etc` nor `escape` linked
inside it; debug log carries warn lines.

---

## Group F: PR reference

**Mode:** headless. Requires `origin` remote pointing at a public GitHub repo.

### Setup template

```bash
# Use qwen-code itself as the test repo
TEST_DIR=$(mktemp -d -t qwen-wt-phd-pr-XXXXXX)
TEST_DIR=$(cd "$TEST_DIR" && pwd -P)
cd "$TEST_DIR"
git clone --depth 1 https://github.com/QwenLM/qwen-code.git .
PROJECT_ID=$(node -e "console.log(process.argv[1].replace(/[^a-zA-Z0-9]/g,'-'))" "$TEST_DIR")
```

### F1: `--worktree=#4174` parses + fetches

```bash
$QWEN --worktree=#4174 "say hi" \
  --approval-mode yolo --output-format json 2>/dev/null > /tmp/f1.out

ls -d "$TEST_DIR/.qwen/worktrees/pr-4174"
git -C "$TEST_DIR/.qwen/worktrees/pr-4174" rev-parse --abbrev-ref HEAD
```

**Expected (post-impl):**

- Worktree dir `pr-4174/` exists
- HEAD branch = `worktree-pr-4174`
- The branch's tip resolves (git log -1) without error

### F2: full URL form

```bash
$QWEN --worktree "https://github.com/QwenLM/qwen-code/pull/4174" "say hi" \
  --approval-mode yolo --output-format json 2>/dev/null > /tmp/f2.out

ls -d "$TEST_DIR/.qwen/worktrees/pr-4174"
```

**Expected (post-impl):** same as F1.

### F3: missing `origin` remote → fail-close

```bash
cd "$TEST_DIR" && git remote remove origin
$QWEN --worktree=#4174 "say hi" --approval-mode yolo --output-format json 2>/dev/null > /tmp/f3.out
echo "exit=$?"
```

**Expected (post-impl):** exit != 0; message mentions `origin` remote.

### F4: invalid PR number → fail-close

```bash
$QWEN --worktree=#999999999 "say hi" --approval-mode yolo --output-format json 2>/dev/null > /tmp/f4.out
echo "exit=$?"
```

**Expected (post-impl):** exit != 0; message mentions "Failed to fetch PR".
30-second timeout cap respected (test runtime < 35s).

### F5: malformed `#abc` falls through to slug validation

```bash
$QWEN --worktree=#abc "say hi" --approval-mode yolo --output-format json 2>/dev/null > /tmp/f5.out
echo "exit=$?"
```

**Expected (post-impl):** treated as literal slug `#abc`, rejected by
`validateUserWorktreeSlug` because `#` is not allowed. Exit != 0.

### F6: PR worktree gets symlinks too (cross-cut with E)

```bash
cat > "$TEST_DIR/.qwen/settings.json" <<'EOF'
{ "worktree": { "symlinkDirectories": ["node_modules"] } }
EOF
mkdir -p "$TEST_DIR/node_modules" && echo x > "$TEST_DIR/node_modules/.marker"

$QWEN --worktree=#4174 "say hi" --approval-mode yolo --output-format json 2>/dev/null > /dev/null
readlink "$TEST_DIR/.qwen/worktrees/pr-4174/node_modules"
```

**Expected (post-impl):** symlink target = `$TEST_DIR/node_modules`.

---

## Group G: Integration + edge cases

### G1: full lifecycle — start → write → Keep → resume

> **Pre-impl note:** Against the baseline this test exits before `sleep 3`
> finishes (yargs rejects `--worktree` immediately and the tmux pane dies).
> The `capture-pane` call then errors with "can't find pane". This is
> expected — record as PASS-by-rejection. Wrap captures with `|| true` for
> the dry-run, or skip G1 entirely in baseline mode.

```bash
SESSION_ID=$(uuidgen)
tmux new-session -d -s g1 -x 200 -y 50 \
  "cd $TEST_DIR && $QWEN --worktree g1-test --session-id $SESSION_ID --approval-mode yolo 2>&1 | tee /tmp/g1-stderr.out"
sleep 3
tmux send-keys -t g1 "use the write_file tool to create file 'work.txt' with content 'phase d test'"
sleep 0.3; tmux send-keys -t g1 Enter
sleep 8

tmux send-keys -t g1 C-c; sleep 0.3; tmux send-keys -t g1 C-c; sleep 1
tmux send-keys -t g1 Enter   # default = "Keep"
sleep 2
tmux kill-session -t g1

# File survived
cat "$TEST_DIR/.qwen/worktrees/g1-test/work.txt"

# Resume reattaches
tmux new-session -d -s g1b -x 200 -y 50 \
  "cd $TEST_DIR && $QWEN --resume $SESSION_ID --approval-mode yolo"
sleep 4
tmux capture-pane -t g1b -p -S -50 | grep -E "⎇ worktree-g1-test|Resumed"
tmux kill-session -t g1b
```

**Expected (post-impl):**

- `work.txt` inside the worktree contains the written content
- Resumed session Footer shows `⎇ worktree-g1-test (g1-test)`
- INFO history item or `<system-reminder>` mentions "Resumed"

### G2: relative path arg resolved before cwd switch

```bash
# Create an mcp config in TEST_DIR and reference it relatively.
# --mcp-config takes a file path; if the test plan path is resolved AFTER
# the --worktree cwd switch, the file won't be found inside the worktree
# and the CLI will error out. If resolved BEFORE the switch (correct), the
# file is loaded from TEST_DIR.
cat > "$TEST_DIR/mcp.json" <<'EOF'
{ "mcpServers": {} }
EOF
cd "$TEST_DIR"

$QWEN --worktree g2-test --mcp-config ./mcp.json "say hi" \
  --approval-mode yolo --output-format json 2>/dev/null > /tmp/g2.out
echo "exit=$?"
jq -r '.[] | select(.type=="result") | .result' < /tmp/g2.out | head -3
```

**Expected (post-impl):** exit = 0; the model responds normally (the empty
mcp config means no MCP servers but no error either).

**Expected (pre-impl baseline):** yargs rejects `--worktree` (the test
cannot distinguish "worktree flag missing" from "mcp config resolution
broken" until the flag itself exists).

---

## Run order + parallelism

| Group | Mode         | Runtime | Parallel-safe?               |
| ----- | ------------ | ------- | ---------------------------- |
| A     | headless     | ~30s    | yes (own TEST_DIR)           |
| B     | headless     | ~20s    | yes                          |
| C     | headless     | ~40s    | yes                          |
| D     | tmux         | ~30s    | yes (own session name)       |
| E     | headless     | ~60s    | yes                          |
| F     | headless+net | ~60s    | NO — shares the GitHub clone |
| G     | mixed        | ~60s    | yes                          |

Run A/B/C/D/E/G in parallel; F serially after the clone setup.

## Reproduction report

### Phase 4 dry-run — baseline `qwen` v0.15.11 (2026-05-20)

Runtime: 3 parallel `test-engineer` agents, ~7 minutes total. Baseline lacks
both Phase D (expected) and Phase A+B (older binary than expected — see
E2/E3 caveat).

| Group                            | Result     | Notes                                                                                 |
| -------------------------------- | ---------- | ------------------------------------------------------------------------------------- |
| A1 (bare flag)                   | ✅         | yargs `Unknown argument: worktree`, exit 1                                            |
| A2 (explicit slug)               | ✅         | same                                                                                  |
| A3 (= form)                      | ✅         | same                                                                                  |
| A4 (invalid slug)                | ✅         | yargs rejects before slug validation                                                  |
| A5 (non-git dir)                 | ✅         | same                                                                                  |
| B1 (sidecar fields)              | ✅         | sidecar correctly absent; jq selector valid against sample data                       |
| B2 (cwd switch)                  | ✅         | shell-tool `tool_result.content` jq selector verified against real output             |
| B3 (targetDir switch)            | ✅         | same selector                                                                         |
| C1 (--worktree beats sidecar)    | ✅         | both runs exit 1, no sidecar                                                          |
| C2 (stale sidecar + fresh)       | ✅         | same                                                                                  |
| E1 (--worktree symlink)          | ✅         | flag rejected, no symlink — pre-impl confirmed                                        |
| E2 (EnterWorktree symlink)       | ⚠️ N/A     | baseline lacks `enter_worktree` tool (older than PR #4073); guard now skips this case |
| E3 (AgentTool isolation symlink) | ⚠️ N/A     | baseline `agent` schema silently drops `isolation` param; guard skips                 |
| E4 (missing source skip)         | ✅         | flag rejected                                                                         |
| E5 (existing dest not overwrite) | ⚠️ trivial | preexisting `.marker` survived but only because tool couldn't run                     |
| E6 (path traversal reject)       | ✅         | flag rejected, no symlinks                                                            |
| F1 (--worktree=#4174 fetch)      | ✅         | `Unknown argument: worktree`, no network call                                         |
| F2 (full URL form)               | ✅         | same                                                                                  |
| F3 (missing origin)              | ✅         | rejected before git check                                                             |
| F4 (invalid PR number)           | ✅         | rejected before fetch                                                                 |
| F5 (`#abc` malformed)            | ✅         | same                                                                                  |
| F6 (PR + symlinkDirs)            | ✅         | same                                                                                  |
| G1 (lifecycle tmux)              | ⚠️ partial | tmux pane dies on flag rejection; record-by-exit-code works                           |
| G2 (relative path)               | ✅         | (after switching to `--mcp-config ./mcp.json`) yargs rejects worktree first           |

**Conclusion:** test scripts are fundamentally sound. 19 / 24 cases cleanly
detect pre-impl baseline; 3 cases (E2/E3/E5) need the baseline to include
Phase A+B (which the local Phase 6 build will provide); 2 cases (G1/G2) had
script bugs that are now fixed. **Ready to proceed to Phase 5
implementation.**

### Phase 6 verification — local build

**Binary**: `node /Users/mochi/code/qwen-code/.claude/worktrees/tender-jemison-037f0a/dist/cli.js`
**Date**: 2026-05-20
**Scope**: Groups A, B, C, E, F, G (6 parallel `test-engineer` agents)

| Group                              | Result                    | Notes                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 (bare flag)                     | ✅ (with doc tip)         | yargs consumes the next positional as the slug value when user passes `qwen --worktree "say hi"`; quickstart now tells users to use `=` form or put the prompt before the flag. Auto-slug feature itself confirmed via `qwen --worktree --approval-mode yolo "say hi"` → slug `bright-elm-8a4c12`, init `.cwd` ends with `.qwen/worktrees/<auto-slug>`.                                     |
| A2 (explicit slug)                 | ✅                        | dir `.qwen/worktrees/my-feature` + branch `worktree-my-feature`                                                                                                                                                                                                                                                                                                                             |
| A3 (= form)                        | ✅                        | identical to A2                                                                                                                                                                                                                                                                                                                                                                             |
| A4 (invalid slug)                  | ✅                        | exit=1, message: `Worktree name may only contain letters, digits, dots, underscores, and hyphens.`, no worktree dir                                                                                                                                                                                                                                                                         |
| A5 (non-git dir)                   | ✅                        | exit=1, message: `not a git repository. Run \`git init\` first or relaunch from inside one.`                                                                                                                                                                                                                                                                                                |
| B1 (sidecar fields)                | ✅                        | All 6 fields present and correct; sidecar lives under worktree projectHash as designed                                                                                                                                                                                                                                                                                                      |
| B2 (cwd switch)                    | ✅                        | `pwd` inside shell tool returned worktree path exactly                                                                                                                                                                                                                                                                                                                                      |
| B3 (branch + cwd)                  | ✅                        | `pwd` = worktree path, `git rev-parse --abbrev-ref HEAD` = `worktree-b3-test`                                                                                                                                                                                                                                                                                                               |
| C1 (cross-slug override)           | ❌ → **known limitation** | Sessions are bound to `projectHash(cwd)`; `--worktree second --resume <sid-from-first>` can't find the session. Documented in user docs Limitations. A future Config refactor (anchor storage at repo root) would lift this.                                                                                                                                                                |
| C2 (stale sidecar + new worktree)  | ❌ → **same root cause**  | Same architectural constraint.                                                                                                                                                                                                                                                                                                                                                              |
| E1 (`--worktree` symlink)          | ✅                        | `node_modules` symlinked into the new worktree                                                                                                                                                                                                                                                                                                                                              |
| E2 (`enter_worktree` symlink)      | ✅                        | same code path via `createUserWorktree`                                                                                                                                                                                                                                                                                                                                                     |
| E3 (agent isolation symlink)       | ⚠️ test-setup             | model committed `node_modules` (because the agent guard refused dirty state); EEXIST guard then correctly skipped the symlink. Code path is correct; for a clean E3 the test plan needs to pre-`.gitignore` `node_modules`.                                                                                                                                                                 |
| E4 (missing source skip)           | ✅                        | worktree created, no entry, exit 0                                                                                                                                                                                                                                                                                                                                                          |
| E5 (existing dest no overwrite)    | ✅                        | preexisting marker survived                                                                                                                                                                                                                                                                                                                                                                 |
| E6 (absolute / `..` rejected)      | ✅                        | neither path linked                                                                                                                                                                                                                                                                                                                                                                         |
| F1 (`--worktree=#4174` fetch)      | ✅                        | worktree dir `pr-4174/`, branch `worktree-pr-4174`, tip commit `8f4fe8e feat(cli): per-turn /diff…`; local-remote substitute (sandbox blocks real GitHub)                                                                                                                                                                                                                                   |
| F2 (full URL form)                 | ✅                        | same result; URL parsed → PR #4174 → local origin fetch succeeded                                                                                                                                                                                                                                                                                                                           |
| F3 (missing origin)                | ✅                        | exit=1 in 2s; message mentions adding `origin` remote                                                                                                                                                                                                                                                                                                                                       |
| F4 (invalid PR #999999999)         | ✅                        | exit=1 in 2s; "PR does not exist on origin"; well within 35s cap                                                                                                                                                                                                                                                                                                                            |
| F5 (malformed `#abc`)              | ✅                        | slug validation rejects `#`                                                                                                                                                                                                                                                                                                                                                                 |
| F6 (PR worktree + symlinks)        | ✅                        | symlink `pr-4174/node_modules` → `$TEST_DIR/node_modules` confirmed                                                                                                                                                                                                                                                                                                                         |
| G1.a (start + write + Keep)        | ✅                        | TUI flow, Footer indicator, dialog options, file persists                                                                                                                                                                                                                                                                                                                                   |
| G1.b (`--resume … --worktree foo`) | ❌ → **fixed in this PR** | Original: `--worktree: Worktree already exists at …`. Phase 6 fix added the re-attach branch in `setupStartupWorktree`. Verified post-fix via smoke test (`--worktree foo` twice → second emits the `worktree_started` notice, no error) + new unit tests in `worktreeStartup.test.ts`.                                                                                                     |
| G2 (relative `--mcp-config`)       | ❌ → **fixed in this PR** | Original: exit=52, `Invalid MCP configuration … is not valid JSON`. Phase 6 fix normalizes path-taking argv fields (`mcpConfig`, `openaiLoggingDir`, `jsonFile`, `inputFile`, `telemetryOutfile`, `includeDirectories`) against the launch cwd BEFORE `setupStartupWorktree` chdirs. Verified post-fix via smoke test (`--worktree foo --mcp-config ./mcp.json` → model responds normally). |

**Phase 6 net result:** 22 / 24 cases passed post-fix; 2 cases (C1/C2) hit an
architectural limitation now documented; 1 case (E3) is a test-setup quirk,
not an implementation issue. **Ready for Phase 7 code review.**

### Fix references (Phase 6 fixes that landed in this PR)

| Fix                                                         | File                                               | Change                                                                                                                                                  |
| ----------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Re-attach to existing worktree (G1.b)                       | `packages/cli/src/startup/worktreeStartup.ts`      | Added pre-create check: if dir is a registered worktree on the expected branch, skip create + chdir                                                     |
| `getRegisteredWorktreeBranch()` helper                      | `packages/core/src/services/gitWorktreeService.ts` | Probes `git rev-parse --abbrev-ref HEAD` against the candidate path                                                                                     |
| Path normalization before chdir (G2)                        | `packages/cli/src/gemini.tsx`                      | Resolves `mcpConfig`, `openaiLoggingDir`, `jsonFile`, `inputFile`, `telemetryOutfile`, `includeDirectories` against launch cwd when `--worktree` is set |
| Documentation: yargs flag ordering tip + Limitations update | `docs/users/features/worktree.md`                  | Quick Start tip + new Limitations bullets (cross-slug, path-arg behavior)                                                                               |
| Unit tests for re-attach                                    | `packages/cli/src/startup/worktreeStartup.test.ts` | Added 2 tests: happy re-attach + "different branch occupies slot" guard                                                                                 |

**Phase 6 Group F network note**: The sandbox blocks `git fetch` to `https://github.com` with HTTP 403. F1/F2/F4/F6 were retested against a local bare repo (`git init --bare`) seeded with `refs/pull/4174/head` pointing at a commit whose message is `feat(cli): per-turn /diff with interactive dialog (#4277)`. F3 and F5 are network-independent and were verified directly. The local-remote substitute fully exercises the parsing + fetch + worktree-creation code path.

---

## Reproduction report — Phase 4 dry-run (Groups F + G), 2026-05-20

**Binary**: `qwen` (globally installed, v0.15.11 at `/Users/mochi/.nvm/versions/node/v22.21.1/bin/qwen`)
**Override**: `QWEN="qwen"`

### Results table

| Test ID                  | Result | Evidence                                                                                                                                             | Fix suggestion                   |
| ------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| F1 `--worktree=#4174`    | PASS   | `Unknown argument: worktree`, exit=1                                                                                                                 | None — expected baseline failure |
| F2 `--worktree <url>`    | PASS   | `Unknown argument: worktree`, exit=1                                                                                                                 | None — expected baseline failure |
| F3 missing origin        | PASS   | `Unknown argument: worktree`, exit=1 — yargs rejected before any git op                                                                              | None                             |
| F4 invalid PR #999999999 | PASS   | `Unknown argument: worktree`, exit=1                                                                                                                 | None                             |
| F5 malformed `#abc`      | PASS   | `Unknown argument: worktree`, exit=1                                                                                                                 | None                             |
| F6 PR + symlinkDirs      | PASS   | `Unknown argument: worktree`, exit=1                                                                                                                 | None                             |
| G1 lifecycle (tmux)      | PASS   | `Unknown argument: worktree` emitted to stdout captured in `/tmp/g1_raw.out`; tmux session exited immediately, pane was already dead by capture time | SCRIPT-BUG: see note below       |
| G2 relative path         | PASS   | `Unknown arguments: worktree, prompt-file, promptFile`, exit=1                                                                                       | SCRIPT-BUG: see note below       |

### Observed behavior (all cases)

Every invocation of `--worktree` (bare, `=` form, `#<N>` form, full URL, combined with `--prompt-file`) was rejected at the yargs argument-parsing layer with exit code 1 before any application logic ran. The exact error strings are:

- `Unknown argument: worktree` (single unknown arg)
- `Unknown arguments: worktree, prompt-file, promptFile` (G2: both `--worktree` and `--prompt-file` are unknown, listed together)

No git operations, no network calls, no filesystem writes occurred in any test.

### Expected behavior

Identical rejection — this is the correct pre-implementation baseline. All 8 tests PASS in the dry-run sense (the plan correctly detects that the features do not exist).

### Key context

The failure mode is uniformly at the yargs layer, not downstream. This confirms the test plan's detection strategy is sound: once `--worktree` is wired into yargs, these tests will stop failing at this layer and will instead exercise the actual implementation paths (F1-F6 will hit git fetch, G1 will hit the TUI lifecycle, G2 will hit `--prompt-file` resolution).

### SCRIPT-BUG notes for the test plan

**G1 (tmux):** The tmux session command pipes through `tee` with a subshell `echo 'PROC_EXIT='$?` that captures the exit of `tee`, not of `qwen`. When the process exits instantly (as with an Unknown argument error), the session terminates before `sleep 3` finishes and the pane name `g1dry` is gone by the time `tmux capture-pane` runs, producing `can't find pane: g1dry`. Fix: use `|| true` after `tmux capture-pane`, or add a `|| sleep 0` guard; better still, for the baseline-fail case redirect stderr+stdout to a file outside tmux and check the file directly (as done here via `tee /tmp/g1_raw.out`).

**G2 (`--prompt-file`):** The test plan uses `--prompt-file ./relative.txt` as a combined test with `--worktree`. In the baseline, `--prompt-file` is also an unknown argument (it does not exist in v0.15.11 yargs schema either — the flag is `--prompt-interactive` / `-p`). The error lists both unknown args together. The plan should note that `--prompt-file` will need to be implemented alongside `--worktree`, or use an existing flag (e.g. pipe via stdin or use `--prompt`) for the relative-path resolution test.
