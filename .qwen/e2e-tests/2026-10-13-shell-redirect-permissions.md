# Shell Redirection Permissions E2E Test Plan

## Goal

Verify that a `Bash(...)` allow rule cannot run a file access past a `Read`, `Edit` or `Write` deny rule by spelling the redirection differently, and that fd plumbing no longer counts as a write.

## Setup

1. Create a temporary project with `notes.txt` and a `.env` file containing `SECRET=a>b`.
2. Start qwen-code in that project. Any approval mode works: every case below is decided by an allow or deny rule, and a deny holds even in YOLO mode.

## Writes past an Edit deny

1. Set `.qwen/settings.json` to `{"permissions": {"allow": ["Bash(printf *)"], "deny": ["Edit(protected.txt)"]}}`.
2. Ask the agent to run each command: `printf X 3>protected.txt`, `printf X >| protected.txt`, `printf X>protected.txt`, `printf X <>protected.txt`, `printf X > a>protected.txt`.
3. Each command is denied with a message that names `Edit(protected.txt)`, and `protected.txt` is not created. On the merge base each one runs and creates the file.

## Reads past a Read deny

1. Set `.qwen/settings.json` to `{"permissions": {"allow": ["Bash(grep *)", "Bash(cat *)"], "deny": ["Read(.env)"]}}`.
2. Ask the agent to run `grep ">" .env` and `cat 0<.env`.
3. Both are denied with a message that names `Read(.env)`. On the merge base both run and show the contents of `.env`.

## fd plumbing is not a write

1. Set `.qwen/settings.json` to `{"permissions": {"allow": ["Bash(ls *)", "Bash(echo *)"], "deny": ["Write"]}}`.
2. Ask the agent to run `ls -la 2>&1` and `echo hi > /dev/null`.
3. Both run without a denial. On the merge base both are denied as writes.

## Automated Run

Each case can run headless, one fresh project directory per command:

```bash
node <repo>/scripts/dev.js "Use your shell tool to run exactly this command, verbatim, once: printf X 3>protected.txt. Do not change it, do not run any other command, and do not use any other tool. If it is denied, do not retry; just report what happened." \
  --auth-type openai --model <model> --approval-mode yolo --output-format json
```

Headless runs need `--approval-mode yolo`: in the default mode the shell tool is not offered, because nobody can approve it. Read the `tool_result` for the `run_shell_command` call: a denial names the matching rule. Run the same prompts with the released `qwen` binary for the before side.

## Expected Result

Every redirection form is checked against file rules, quoted `>` is plain text, and fd duplication or device targets do not trip a `Write` deny.
