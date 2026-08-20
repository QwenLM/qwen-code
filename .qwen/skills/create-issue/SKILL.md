---
name: create-issue
description: Draft and submit a GitHub issue from a user idea or bug description, with bilingual body and correct labels.
argument-hint: '<feature idea or bug description>'
allowedTools:
  - run_shell_command
  - read_file
  - write_file
  - glob
  - grep_search
---

# Create Issue

Take the user's idea or bug description, investigate the codebase for context,
draft an issue for review, and submit once approved.

## Input

The user provides a brief description of a feature request or bug report via
the skill argument.

## Steps

### 1. Classify

Determine whether the request is a **feature request** or a **bug report**.

### 2. Investigate the codebase

Search for relevant code, files, and existing behavior related to the request.
Build a thorough understanding of how the current system works. Note any related
existing issues found via `gh issue list --search`.

### 3. Read the template

- Feature request → read `.github/ISSUE_TEMPLATE/feature_request.yml`
- Bug report → read `.github/ISSUE_TEMPLATE/bug_report.yml`

Use the template's field labels and descriptions to structure the draft.

### 4. Draft the issue

Write a markdown draft to `.qwen/issues/draft-<slug>.md` for the user to review.

Rules:

- Write from the user's perspective — not as an implementation spec.
- Keep language clear and concise; **avoid internal implementation details**.
- Title stays in **English only**.
- **Bilingual body**: English content first, Chinese translation at the end
  wrapped in a collapsible block:

  ```markdown
  <details>
  <summary>中文</summary>

  (Chinese translation here)

  </details>
  ```

### 5. Review with user

Present the draft. Iterate on feedback until the user is satisfied.
**Do not submit until the user explicitly approves.**

### 6. Submit

When the user confirms, create the issue with `gh issue create`:

```bash
gh issue create --title "..." --body-file .qwen/issues/draft-<slug>.md
```

Apply labels based on type:

- Feature request → `type/feature-request`, `status/needs-triage`
- Bug report → `type/bug`, `status/needs-triage`

Report the issue URL back to the user.
