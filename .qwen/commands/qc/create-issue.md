---
description: Draft and submit a GitHub issue based on a user-provided idea
---

# Create Issue

## Overview
Take the user's idea or bug description, investigate the codebase to understand the full context, draft a GitHub issue for review, and submit it once approved.

## Input
The user provides a brief description of a feature request or bug report: {{args}}

## Steps

1. **Understand the request**
   - Read the user's description carefully
   - Determine whether this is a feature request or a bug report

2. **Investigate the codebase**
   - Search for relevant code, files, and existing behavior related to the request
   - Build a thorough understanding of how the current system works
   - Identify any related issues or prior art if mentioned

3. **Draft the issue**
   - Write a markdown file for the user to review
   - Use the appropriate template:
     - Feature request: follow @.github/ISSUE_TEMPLATE/feature_request.yml
     - Bug report: follow @.github/ISSUE_TEMPLATE/bug_report.yml
   - Write from the user's perspective, not as an implementation spec
   - Keep the language clear and concise, AVOID internal implementation details

4. **Review with user**
   - Present the draft file to the user
   - Iterate on feedback until the user is satisfied
   - Do NOT submit until the user explicitly asks to

5. **Submit the issue**
   - When the user confirms, create the issue using `gh issue create`
   - Apply the appropriate labels:
     - Feature request: `type/feature-request`, `status/needs-triage`
     - Bug report: `type/bug`, `status/needs-triage`
   - Report back the issue URL
