# E2E test plan: Plan mode extra read-only commands (issue #9694)

Verifies `permissions.planMode.extraReadOnlyCommands` — a user-extensible set of
read-only root commands for Plan mode.

## Setup

Create a scratch workspace with a fake read-only CLI on `PATH`:

```bash
mkdir -p /tmp/ib-e2e/bin /tmp/ib-e2e/.qwen
printf '#!/bin/sh\necho ok\n' > /tmp/ib-e2e/bin/ib
chmod +x /tmp/ib-e2e/bin/ib
export PATH="/tmp/ib-e2e/bin:$PATH"
cd /tmp/ib-e2e
```

`/tmp/ib-e2e/.qwen/settings.json`:

```json
{
  "permissions": {
    "planMode": {
      "extraReadOnlyCommands": ["ib"]
    }
  }
}
```

**Launch from `/tmp/ib-e2e`, not from the repo.** Workspace settings resolve
from the process cwd with no upward search, so a CLI started in the repo root
never loads the scratch workspace's `.qwen/settings.json` and every case below
silently behaves as if the vouch were absent. `npm run dev` runs the CLI with
cwd set to the package root, so it cannot be used here. Use either:

```bash
node /path/to/qwen-code/scripts/dev.js       # derives repo paths from its own location
# or, after `npm run build && npm run bundle` in the repo:
node /path/to/qwen-code/bundle/qwen.js
```

Dry-run the baseline against the globally installed `qwen` first — the setting
does not exist there, so expect the unknown-read cases to prompt and the
state-modifying cases to be blocked, exactly as they are after the change.
Only cases 1, 5b, 7, 8, and 9 change behavior with the setting present.

## Cases

### 1. The vouched root stops prompting

- Enter Plan mode (`/plan`).
- Ask the model to run `ib domain list`.
- **Expect**: the command runs with no confirmation prompt, and Plan mode stays
  active.
- **Before the change / with the settings key removed**: the "Plan mode could
  not determine whether this shell command is read-only" prompt appears, and
  appears again on every subsequent identical invocation.

### 2. Redirection is still blocked

- Still in Plan mode, ask for `ib domain list > out.txt`.
- **Expect**: rejected with the plan-mode write-block message ("classified as
  state-modifying"). No prompt, no file created.

### 3. Command substitution still prompts

- Ask for `ib domain list $(whoami)`.
- **Expect**: the one-time `unknown` confirmation prompt, with "Always allow"
  hidden.

### 4. Environment-assignment prefix still prompts

- Ask for `IB_TOKEN=x ib domain list`.
- **Expect**: the one-time `unknown` confirmation prompt.

### 5. A pipe into an unknown command still prompts

- Ask for `ib domain list | badcmd`.
- **Expect**: the one-time `unknown` confirmation prompt.
- Ask for `ib domain list | wc -l`.
- **Expect**: runs without a prompt (`wc` is a built-in read-only root).

### 6. The safety net cannot be switched off from settings

Add `"bash"`, `"time"`, `"hash"`, and `"rm"` to `extraReadOnlyCommands` and
restart.

- Ask for `bash -c 'echo hi'`.
  **Expect**: still prompts — the classifier refuses to let any caller vouch a
  shell interpreter.
- Ask for `time rm -rf tmp`.
  **Expect**: still prompts — `time` is a launcher, so vouching it is not a
  vouch for what it wraps.
- Ask for `hash -p ./bin/git git && git status`.
  **Expect**: still prompts — `hash` re-binds how the later `git` resolves.
- Ask for `rm -rf tmp`.
  **Expect**: still blocked as state-modifying — `rm` keeps its built-in write
  classification.
- Ask for `git push origin main` with `"git"` also listed.
  **Expect**: still blocked as state-modifying.

### 6b. An unrecognised launcher fails closed too

With only `"ib"` vouched, ask for `ib exec rm -rf tmp`.

- **Expect**: prompts. A vouched root that is handed a command the classifier
  recognises (`rm`) is refused on shape, without `ib` needing to be known as a
  launcher. This is what keeps the guarantee from depending on an exhaustive
  list of launcher names.

### 7. The vouch is scoped to Plan mode

- Leave Plan mode: `/approval-mode default`.
- Ask for `ib domain list`.
- **Expect**: the normal shell confirmation prompt appears. The Plan-mode vouch
  must not auto-approve here.
- Switch back to Plan mode (`/plan`) and repeat case 1 — it stops prompting
  again, without a restart.

### 8. Monitor tool parity

- In Plan mode, ask the model to start a monitor on `ib domain watch`.
- **Expect**: no confirmation prompt (the monitor tool shares the plan-mode
  shell policy).

### 9. Invalid entries are ignored, not fatal

Set `extraReadOnlyCommands` to
`["", "   ", "ib list", "/usr/local/bin/ib", "ib;rm", "IB"]` and restart.

- **Expect**: the CLI starts normally. `ib domain list` runs without a prompt
  (from the `"IB"` entry, which normalizes to `ib`); the malformed entries are
  silently dropped.

## Cleanup

```bash
rm -rf /tmp/ib-e2e
```
