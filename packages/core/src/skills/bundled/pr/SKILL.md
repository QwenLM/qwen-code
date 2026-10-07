---
name: pr
description: Draft, push and open (or update) the pull request for the current branch, following the repository's own PR template and conventions. Invoke explicitly with /pr.
argument-hint: '[prepare] | create [--draft] [--base <branch>]'
disable-model-invocation: true
allowedTools:
  - read_file
  - glob
  - grep_search
  - Bash(gh auth status)
  - Bash(gh repo view)
  - Bash(gh pr view)
  - Bash(gh pr list)
  - Bash(git config --get)
  - Write(/.qwen/tmp/**)
---

# /pr — draft and open the pull request for this branch

Draft a PR title and body that follow the current repository's own conventions, then (for `create`) push the branch and open or update the PR with `gh`. Every command that changes state (`git switch -c`, `git push`, `gh pr create`, `gh pr edit`) goes through normal user confirmation; this skill pre-approves read-only commands only.

## Subcommands

- **`prepare`** (also the default for empty input) — draft the title and body, show them, write the body file. Push and publish nothing.
- **`create [--draft] [--base <branch>]`** — everything in `prepare`, then push, then create the PR or update the existing one.

## Parsing

Parse the input after removing the `/pr` prefix:

1. Empty input or `prepare` → `prepare`.
2. First token `create` → `create`. Accept `--draft` and `--base <branch>` in any order.
3. Anything else (unknown subcommand, unknown flag, `--base` without a value) → print the usage line `/pr [prepare] | create [--draft] [--base <branch>]` and stop.

## Requirements

For `create`, check before any mutation: `gh` is installed, `gh auth status` succeeds, and the push remote is a GitHub repository. If not, say what is wrong and how to fix it (for example `gh auth login`, or install `gh`), then stop. There is no fallback without `gh`. For `prepare`, a failing `gh` only means the base branch and existing-PR lookups are skipped; say so and continue with `git` data.

This skill is unavailable when `tools.executionSandbox` is enabled: the CLI refuses skill commands there.

## Step 1 — Gather context (one parallel batch, read-only)

Run these together, then work only from their output. Do not read or explore code beyond what is gathered here.

Run every command exactly as written, from the current directory: no `cd <dir> &&` prefix and no extra `echo` separators. A bare read-only command runs without a prompt; a `cd` in front of it turns it into one that asks the user every time.

- `git status --porcelain=v1 -b -uall` (`-uall` lists untracked files one by one, so a wholly untracked `.qwen/` does not hide what is inside it)
- `git rev-parse --abbrev-ref HEAD`
- `git rev-parse --abbrev-ref @{u}` and `git log @{u}..` (the upstream may not exist; that is fine)
- `git remote -v`
- `gh auth status`
- `gh repo view --json nameWithOwner,isFork,defaultBranchRef,parent`

For `create`, handle the working tree now (Step 4, item 1) before drafting anything. If `git status` shows a detached HEAD or a merge, rebase or cherry-pick in progress, report it and stop.

Then resolve the **base branch**, in this order:

1. `--base <branch>` from the input.
2. `baseRefName` of the existing PR for this branch (`gh pr view --json baseRefName`).
3. For a fork, the parent's default branch (`parent` in the `gh repo view` output; use the upstream remote that points at the parent if one exists); otherwise `defaultBranchRef.name`.
4. If `gh` is unavailable: the remote's `HEAD` (`git rev-parse --abbrev-ref <remote>/HEAD`), else ask.

Use the remote-tracking ref `<remote>/<base>` as the diff ref; never hardcode `origin/main`. Then gather, in one more parallel batch:

- `git log <remote>/<base>..HEAD` — ALL commits in range; describe all of them, not just the latest.
- `git diff <remote>/<base>...HEAD` (use `--stat` first if the diff is very large, then read only the key hunks).
- `git log -n 30 --format=%s <remote>/<base>` — to infer the title style.

If there are no commits ahead of the base, say so and stop. If the range contains commits that are clearly not the user's (for example merge subjects of other PRs), the remote-tracking ref is probably stale: say so and suggest `git fetch <remote>` instead of drafting from it.

## Step 2 — Find the repository's conventions

Use `glob` and `read_file`:

- PR template, case-insensitive: `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/PULL_REQUEST_TEMPLATE/` (if several, pick the one that fits the change or ask), `docs/pull_request_template.md`, and the repository root.
- `CONTRIBUTING*`, `AGENTS.md`, `CLAUDE.md` — read only the PR, commit and title sections.
- Title style from the base branch's recent subjects (for example Conventional Commits with scopes, ticket prefixes, plain sentences). Follow what the history actually does.

## Step 3 — Draft

- Title: short, in the repository's style; details belong in the body.
- Body: if a template exists, fill it in, keeping every section heading verbatim and in order; leave inapplicable sections in place with a short "N/A". If there is no template, write a short prose description (what changed and why). Do not impose a format of your own.
- Cover every commit in the range, not only the latest.
- Never claim tests or checks that were not run in this session. If you did not run them, say they were not run, or leave the template's checklist item unchecked.
- Link issues only when the commits, branch name or user mention them.

Write the body to `.qwen/tmp/qwen-pr-body.md` with `write_file` (it creates the directory; do not run `mkdir`). Print the title and body in chat.

For `prepare`, stop here and tell the user to run `/pr create` to push and open the PR.

## Step 4 — `create`

Run the steps in order; stop at the first failure and report it.

1. **Dirty working tree** (checked right after Step 1). Ignore untracked files under `.qwen/tmp/` (the CLI's own scratch). If anything else is modified or untracked, list those files and ask the user to choose:
   - **(a) Commit first.** Stop. Print one plain-text line the user can copy, for example `/commit <suggested message>`, and tell them to re-run `/pr create` afterwards. Never commit inside `/pr` and do not restate `/commit`'s rules.
   - **(b) Continue without them.** Proceed, and state explicitly which files will not be in the PR.
2. **Default branch.** If the current branch is the base/default branch, propose a branch name that follows the repository's conventions (from Step 2 and recent branch names) and run `git switch -c <name>` after confirmation. Never reset or move the local default branch; tell the user it still holds these commits locally.
3. **Push.** Resolve the remote: `git config --get branch.<branch>.pushRemote` → `git config --get remote.pushDefault` → the remote of the upstream → the only remote → otherwise ask. Run `git push -u <remote> <branch>` as its own command, never with `--force`, `--force-with-lease` or `--no-verify`. If a pre-push hook or the push fails, show the output and stop; never bypass hooks or amend. Offer a fix only as a new commit, and only if the user asks.
4. **Look up an existing PR.** Run `gh pr view --json number,url,state,title,body,baseRefName` for the branch (for a fork, a branch pushed to your fork may need `gh pr view <owner>:<branch>`).
   - Output with a PR → use it.
   - Error output containing "no pull requests found" → proved absence, no PR exists.
   - Any other error (network, auth, rate limit) → stop and report; do not create a PR, to avoid duplicates.
5. **No PR yet.** Reuse the Step 3 draft if `HEAD` has not changed since it was written, otherwise draft again and rewrite the body file. Then run, as its own plain foreground command:

   `gh pr create --title '<title>' --body-file .qwen/tmp/qwen-pr-body.md [--base <base>] [--draft]`

   Single-quote the title (write an embedded `'` as `'\''`) so backticks and `$` in it are not expanded by the shell.

   Run it exactly like that: no `bash -c`, no `timeout`, no subshell, no background, and no `&&` chain with other commands. Running it directly is what lets the CLI bind the new PR to this session. Add `--head <owner>:<branch>` or `--repo` only when truly needed (for example a fork whose push remote differs from the PR target), and say why when you do.

6. **PR already exists.**
   - `OPEN` → show its URL and how its title and body differ from the new draft. Ask before changing anything; on approval run `gh pr edit <number> --title '<title>' --body-file .qwen/tmp/qwen-pr-body.md` (also `--base` if it changed).
   - `CLOSED` or `MERGED` → report that, and ask whether to create a new PR; if yes, continue with step 5.
7. **Report.** Print the PR URL, the title, the base branch, and anything left out of the PR (files from step 1b).
