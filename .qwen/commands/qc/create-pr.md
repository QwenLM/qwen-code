---
description: Create a pull request based on staged code changes
---

# Create PR

## Overview

Create a well-structured pull request with proper description and title.

## Steps

1.  **Review staged changes**

- Review all staged changes to understand what has been done
- Do not touch unstaged changes

2.  **Prepare branch**

- Create a new branch with proper name if current branch is main
- Ensure all changes are committed
- Push branch to remote

3.  **Write PR description**

- Fill in the PR template below — each section's HTML comment explains what
  to write. PR title stays in English.
- Append at the end of the PR body, with a line separator: "🤖 Generated
  with [Qwen Code](https://github.com/QwenLM/qwen-code)"

4.  **Set up PR**

- Create PR title and body
- Submit PR with gh command
- **If a GitHub token is provided in the user's message**, use it by setting
  the `GH_TOKEN` environment variable:
  ```bash
  GH_TOKEN=<provided_token> gh pr create --title "..." --body "..."
  ```
- If no token is provided, use the default `gh` authentication

## PR Template

@{.github/pull_request_template.md}
