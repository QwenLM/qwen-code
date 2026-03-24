---
description: Create a pull request based on staged code changes
---

# Create PR

## Overview

Create a well-structured pull request with proper description and title.

## Steps

1. **Review staged changes**
   - Review all staged changes to understand what has been done
   - Do not touch unstaged changes

2. **Prepare branch**
   - Create a new branch with proper name if current branch is main
   - Ensure all changes are committed
   - Push branch to remote

3. **Write PR description**
   - Use PR Template below
   - Summarize changes clearly
   - Include context and motivation
   - List any breaking changes
   - Link related issues if provided, or use "No linked issues"
   - Leave the "Screenshots / Video Demo" section empty for the author to fill in manually
   - Add this line at the end of PR body: "🤖 Generated with [Qwen Code](https://github.com/QwenLM/qwen-code)", with a line separator

4. **Set up PR**
   - Create PR title and body
   - Submit PR with gh command

## PR Template

@{.github/pull_request_template.md}
