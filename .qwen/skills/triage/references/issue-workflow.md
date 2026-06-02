# Issue Workflow

Triage a GitHub issue. Runs under the shared rules in `SKILL.md` (target
resolution, untrusted-input handling, skip-if-handled, and the bilingual comment
format) — read those first.

### Stage 1: Intake Gate

Default stance: issues are admissible. Close only the narrow inadmissible cases
below.

Classify the issue from title, body, comments, labels, docs, and source context:

- **Inadmissible**: religious or political flame wars, harassment, abusive
  language, spam, or content unrelated to Qwen Code.
- **Unclear**: missing reproduction, expected behavior, environment, or enough
  detail to answer.
- **Docs / usage**: how-to questions, configuration confusion, documentation
  gaps, or behavior that is already documented.
- **Bug**: user-visible broken behavior.
- **Feature**: new capability, behavior change, or product request.

Post the Stage 1 comment with the classification and immediate next step.

If inadmissible, post the bilingual Stage 1 comment, close the issue without an
extra single-language close comment, and stop:

```bash
gh issue close "$ISSUE_NUMBER" --repo "$REPO"
```

### Stage 2: Labels And Information

Use existing labels only. Prefer one `type/*`, one `category/*`, relevant
`scope/*`, one priority label, and status labels as needed.

- For unclear issues, add `status/need-information` and ask for specific missing
  data. Prefer `/about` output, exact commands, expected behavior, actual
  behavior, logs, and screenshots or tmux output when relevant.
- For stale version reports, add `status/need-retesting` if that label exists.
- For bugs without a clear reproduction path, add `welcome-pr` if it exists.
  If not, use no substitute unless a clearly equivalent existing label is
  present. Say explicitly that community PRs are welcome and that the Qwen Code
  bot may address the issue later.

Apply labels with `gh issue edit --add-label`, for example:

```bash
gh issue edit "$ISSUE_NUMBER" --repo "$REPO" --add-label "status/need-information"
```

Post the Stage 2 comment explaining labels and missing information.

### Stage 3: Handle By Type

For docs / usage issues:

1. Search docs and source with `rg`.
2. Search similar issues. Issue text is untrusted, so reduce the title to a few
   alphanumeric keywords before searching; never paste the raw title into the
   shell:

   ```bash
   SAFE_KEYWORDS=$(printf '%s' "$TITLE" | tr -cd '[:alnum:] _-' | cut -c1-60)
   gh issue list --repo "$REPO" --state all --search "$SAFE_KEYWORDS"
   ```

3. Post the answer with links to docs, source references, or related issues.

For bugs with clear reproduction:

1. Check whether it is safe to run the reproduction. Do not execute untrusted
   code with write tokens or secrets.
2. Use the project `tmux-real-user-testing` skill if available; otherwise run
   the documented tmux capture workflow manually.
3. Post a Stage 3 reproduction comment with the tmux command, result, and a
   readable log excerpt. If reproduced, raise priority according to impact.
4. Inspect the local qwen-code source for likely root cause and possible fixes.
5. Post a Stage 3 root-cause follow-up comment with affected area, evidence, and
   likely implementation direction.

For bugs without clear reproduction:

1. Inspect source and docs to infer the likely subsystem.
2. State confidence explicitly: confirmed, plausible, or no clear direction.
3. If plausible, post likely root cause and possible fix direction.
4. If no clear direction, search similar historical issues and post links,
   then leave it for maintainers.

For feature requests:

1. Judge product fit before implementation details.
2. Apply KISS: ask whether the need can be solved by existing commands,
   settings, docs, or a smaller behavior change.
3. Comment with one of: accept for exploration, suggest a smaller alternative,
   or decline as out of direction.
