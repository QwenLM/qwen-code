---
name: prepare-pr
description: Prepare GitHub pull request title and body files from the current branch diff, especially for non-interactive CI/autofix flows that must follow the repository PR template without pushing or creating the PR.
argument-hint: '<output-dir> [issue-number]'
allowedTools:
  - read_file
  - write_file
  - grep_search
  - glob
  - run_shell_command
---

# Prepare PR

Create PR metadata files only. Do not push, comment, or run `gh pr create`.

## Inputs

- Output directory: default `/tmp/autofix`
- Issue number: from the argument, `ISSUE`, or the current branch name

## Required Outputs

Write:

- `<output-dir>/pr-title.txt`
- `<output-dir>/pr-body.md`

## Workflow

1. Inspect the current branch diff with `git diff origin/main...HEAD` and recent commit message with `git log -1 --pretty=%B`.
2. Read `<output-dir>/e2e-report.md` if it exists.
3. Read `.github/pull_request_template.md`.
4. Write a Conventional Commit style title to `pr-title.txt`.
5. Fill the repository PR template in place and write it to `pr-body.md`.

## PR Body Rules

- Keep every template section heading exactly as written.
- Do not replace template headings with `Summary`, `Root Cause`, `Fix`, or `Tests`.
- Use prose for motivation and changes; avoid file-by-file implementation notes unless needed for reviewer clarity.
- Include a useful Reviewer Test Plan with concrete behavior to verify.
- Fill `Evidence (Before & After)` with concise before/after behavior or `N/A` for non-UI changes.
- Mark tested OS rows honestly. For Linux-only CI verification, mark Linux tested and macOS/Windows not tested.
- Include risk, out-of-scope, and breaking-change notes.
- Add `Fixes #<issue-number>` under `Linked Issues` when an issue number is known.
- Keep the `<details><summary>中文说明</summary>` section and translate the English body into Chinese there.
- Do not hard-wrap paragraphs or list items at a fixed column width.

## Common Mistakes

- Writing a free-form PR body instead of filling the template.
- Claiming checks passed when they were not run.
- Omitting the Chinese details section.
- Using closing keywords for unrelated issues.
