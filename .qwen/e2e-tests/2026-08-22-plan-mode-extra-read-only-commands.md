# E2E test plan: Plan mode extra read-only commands (issue #9694)

Verifies `permissions.planMode.extraReadOnlyCommands` — a user-extensible set of
read-only root commands for Plan mode.

## Setup

Create a scratch workspace with a fake read-only CLI on `PATH`, and a scratch
Qwen home so the vouch does not touch your real settings:

```bash
mkdir -p /tmp/ib-e2e/bin /tmp/ib-e2e/home /tmp/ib-e2e/.qwen
printf '#!/bin/sh\necho ok\n' > /tmp/ib-e2e/bin/ib
chmod +x /tmp/ib-e2e/bin/ib
export PATH="/tmp/ib-e2e/bin:$PATH"
export QWEN_HOME=/tmp/ib-e2e/home
cd /tmp/ib-e2e
```

`extraReadOnlyCommands` is honoured only from user, system and system-default
scopes — a workspace `.qwen/settings.json` is stripped during the merge — so
the vouch goes in `$QWEN_HOME/settings.json`, which `QWEN_HOME` has redirected
to the scratch directory:

```json
{
  "permissions": {
    "planMode": {
      "extraReadOnlyCommands": ["ib"]
    }
  }
}
```

Auth state lives under `QWEN_HOME` too (`oauth_creds.json`), so the scratch
home starts with no credentials: complete the login flow on first launch, or
export your API-key environment variable in this shell before starting the
CLI.

**Launch from `/tmp/ib-e2e`, not from the repo**, with `QWEN_HOME` exported in
the same shell. `npm run dev` runs the CLI with cwd set to the package root,
so it cannot be used here. Use either:

```bash
node /path/to/qwen-code/scripts/dev.js       # derives repo paths from its own location
# or, after `npm run build && npm run bundle` in the repo:
node /path/to/qwen-code/dist/cli.js
```

Dry-run the baseline against the globally installed `qwen` first — the setting
does not exist there, so expect the unknown-read cases to prompt and the
state-modifying cases to be blocked, exactly as they are after the change.
Only cases 1, 5b, 6c, 7, 8, and 9 change behavior with the setting present;
every other case behaves identically with and without it. (Case 6c's startup
warning names a key the baseline build does not have, so it cannot appear
there at all.)

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
- **Expect**: the `unknown` confirmation prompt, with "Always allow" hidden.
  The approval is `ProceedOnce`, so it does not stick — repeating the same
  invocation prompts again, as in case 1.

### 4. Environment-assignment prefix still prompts

- Ask for `IB_TOKEN=x ib domain list`.
- **Expect**: the `unknown` confirmation prompt, again re-firing on every
  identical invocation.

### 5a. A pipe into an unknown command still prompts

- Ask for `ib domain list | badcmd`.
- **Expect**: the `unknown` confirmation prompt, re-firing per invocation —
  unchanged from baseline.

### 5b. A pipe into a known read-only command runs

- Ask for `ib domain list | wc -l`.
- **Expect**: runs without a prompt (`wc` is a built-in read-only root).
  Baseline prompts, because the vouched half of the pipe is unknown there.

### 6. The safety net cannot be switched off from settings

Add `"bash"`, `"time"`, `"hash"`, `"python3"`, `"make"`, `"rm"`, and `"git"`
to `extraReadOnlyCommands` and restart.

- Ask for `bash -c 'echo hi'`.
  **Expect**: still prompts — the classifier refuses to let any caller vouch a
  shell interpreter.
- Ask for `time rm -rf tmp`.
  **Expect**: still prompts — `time` is a launcher, so vouching it is not a
  vouch for what it wraps.
- Ask for `hash -p ./bin/git git && git status`.
  **Expect**: still prompts — `hash` re-binds how the later `git` resolves.
- Ask for `python3 -c "print(1)"`.
  **Expect**: still prompts — an interpreter's payload is a code string, so
  vouching one says nothing about what it runs.
- Ask for `make`.
  **Expect**: still prompts — the recipe is not in the command line.
- Ask for `rm -rf tmp`.
  **Expect**: still blocked as state-modifying — `rm` keeps its built-in write
  classification.
- Ask for `git push origin main`.
  **Expect**: still blocked as state-modifying. `git` is listed, so this is
  the case that shows a vouch cannot override a command the classifier
  dispatches on before consulting the vouch.

### 6b. An unrecognised launcher fails closed too

With `ib` vouched — the case-6 entries are still present and do not affect
these outcomes, since each refusal happens at the argument layer — ask for:

- `ib exec rm -rf tmp` — **expect** a prompt. A vouched root handed a command
  the classifier recognises (`rm`) is refused on shape, without `ib` needing to
  be known as a launcher.
- `ib exec r\m -rf tmp` and `ib exec $CMD` — **expect** prompts. An argument
  that is not a plain literal word is refused too, because bash rewrites it
  before `ib` sees it.

This is what keeps the guarantee from depending on an exhaustive list of
launcher names.

### 6b-2. Payload-executing tools fail closed under their own names

Add `"uv"`, `"gradle"`, `"ninja"`, `"c++"`, and `"run0"` to
`extraReadOnlyCommands` and restart. Each of these takes its payload from a
file, a manifest, or a downloaded package rather than from argv, so no
argument inspection can see what it runs.

- `uv run ./probe.py`, `gradle build`, `ninja`, `c++ -fplugin=./probe.so x.cpp`,
  `run0 ./probe` — **expect** a prompt for each.
- `luajit-2.1.0-beta3 probe.lua` and `python3.7m probe.py`, with those exact
  names vouched — **expect** prompts. Versioned spellings are matched by shape,
  not listed release by release.

### 6d. A vouched git frontend gets git's planted-config gate

`git diff` and `git status` are downgraded when a repository's own
`.git/config` sets `diff.external` or `core.fsmonitor`, because git then runs a
script the command line never names. A vouched wrapper must not escape that.

```bash
cd /tmp/ib-e2e && git init -q hostile && cd hostile
git config core.fsmonitor example-fsmonitor
printf '#!/bin/sh\nexec git "$@"\n' > /tmp/ib-e2e/bin/gitw
chmod +x /tmp/ib-e2e/bin/gitw
```

With `"gitw"` vouched, launch the CLI from `/tmp/ib-e2e/hostile`:

- Ask for `gitw status`. **Expect**: a prompt, the same one literal
  `git status` gets here.
- Return to `/tmp/ib-e2e` (no planted config) and ask again. **Expect**: no
  prompt. The gate is keyed to the repository's risk, not to the vouch, so an
  ordinary checkout is unaffected.

### 6c. A workspace cannot vouch for itself

Move the vouch into the repository's own settings:

```bash
mv "$QWEN_HOME/settings.json" /tmp/ib-e2e/.qwen/settings.json
```

- Restart and ask for `ib domain list` in Plan mode.
- **Expect**: the prompt is back — the workspace value is stripped during the
  merge — and a startup warning names `permissions.planMode`. Move the file
  back to `$QWEN_HOME/settings.json` **and restart** before continuing: the
  key is `requiresRestart`, so nothing picks the vouch back up on its own and
  cases 7 and 8 would fail spuriously.

### 7. The vouch is scoped to Plan mode

- Leave Plan mode: `/approval-mode default`.
- Ask for `ib domain list`.
- **Expect**: the normal shell confirmation prompt appears. The Plan-mode vouch
  must not auto-approve here.
- Switch back to Plan mode (`/plan`) and repeat case 1 — it stops prompting
  again, without a restart.

### 8. Monitor tool parity

- In Plan mode, ask the model to start a monitor on `ib domain list`.
- **Expect**: no confirmation prompt (the monitor tool shares the plan-mode
  shell policy).
- Ask for a monitor on `ib domain watch`.
- **Expect**: prompts, deliberately — `watch` names a real command, so the
  vouch is refused on shape. This is the documented cost of the launcher
  defence, not a bug; do not "fix" the classifier to silence it.

### 9. Invalid entries are ignored, not fatal

Set `extraReadOnlyCommands` to
`["", "   ", "ib list", "/usr/local/bin/ib", "ib;rm", "IB"]` and restart.

- **Expect**: the CLI starts normally. `ib domain list` runs without a prompt
  (from the `"IB"` entry, which normalizes to `ib`); the malformed entries are
  silently dropped.

## Cleanup

```bash
rm -rf /tmp/ib-e2e
unset QWEN_HOME
```
