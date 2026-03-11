---
description: Commit staged changes with an AI-generated commit message and push
---

# Commit and Push

## Overview
Generate a clear, concise commit message based on staged changes, confirm with the user, then commit and push.

## Steps

### 1. Check repository status
- Run `git status` to check:
  - Are there any staged changes?
  - Are there unstaged changes?
  - What is the current branch?

### 2. Handle unstaged changes
- If there are unstaged changes, notify the user and list them
- Do NOT add or commit unstaged changes
- Proceed only with staged changes

### 3. Review staged changes
- Run `git diff --staged` to see all staged changes
- Analyze the changes in depth to understand:
  - What files were modified/added/deleted
  - The nature of the changes (feature, fix, refactor, docs, etc.)
  - The scope and impact of the changes

### 4. Handle branch logic
- Get current branch name with `git branch --show-current`
- **If current branch is `main` or `master`:**
  - Generate a proper branch name based on the changes
  - Create and switch to the new branch: `git checkout -b <branch-name>`
- **If current branch is NOT main/master:**
  - Check if branch name matches the staged changes
  - If branch name doesn't match changes, ask user:
    - "Current branch `<branch>` doesn't seem to match these changes."
    - "Options: (1) Create and switch to a new branch, (2) Commit directly on current branch"
    - Wait for user decision

### 5. Generate commit message
- Types: feat, fix, docs, style, refactor, test, chore
- Guidelines:
  - Be clear and concise
  - Reference issues if mentioned in changes
  - Include scope in parentheses when applicable (e.g., `fix(insight):`, `feat(auth):`)
  - Add bullet points for detailed changes if it addes more value, otherwise do not use bullets
  - Include a footer explaining the purpose/impact of the changes

**Format:**
```
<type>(<scope>): <short description>
- <detail point 1> (optional)
- <detail point 2> (optional)
- ...

This <explains the why/impact of the changes>.
```

### 6. Present the result and confirm with user
- Present the generated commit message
- Show which branch will be used
- Ask for confirmation: "Proceed with commit and push?"
- Wait for user approval

### 7. Commit and push
- After user confirms:
  - `git commit -m "<commit-message>"`
  - `git push -u origin <branch-name>` (use `-u` for new branches)
