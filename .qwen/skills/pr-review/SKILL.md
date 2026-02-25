---
name: pr-review
description: Reviews pull requests with code analysis and terminal smoke testing. Applies when examining code changes, running CLI tests, or when 'PR review', 'code review', 'terminal screenshot', 'visual test' is mentioned.
---

# PR Review — Code Review + Terminal Smoke Testing

## Workflow

### 1. Fetch PR Information

```bash
# List open PRs
gh pr list

# View PR details
gh pr view <number>

# Get diff
gh pr diff <number>
```

### 2. Code Review

Analyze changes across the following dimensions:

- **Correctness** — Is the logic correct? Are edge cases handled?
- **Code Style** — Does it follow existing code style and conventions?
- **Performance** — Are there any performance concerns?
- **Test Coverage** — Are there corresponding tests for the changes?
- **Security** — Does it introduce any security risks?

Output format:

- 🔴 **Critical** — Must fix
- 🟡 **Suggestion** — Suggested improvement
- 🟢 **Nice to have** — Optional optimization

### 3. Terminal Smoke Testing (Run for Every PR)

**Run terminal-capture for every PR review**, not just UI changes. Reasons:

- **Smoke Test** — Verify the CLI starts correctly and responds to user input, ensuring the PR didn't break anything
- **Visual Verification** — If there are UI changes, screenshots provide the most intuitive review evidence
- **Documentation** — Attach screenshots to the PR comments so reviewers can see the results without building locally

```bash
# Checkout branch & build
gh pr checkout <number>
npm run build
```

#### Scenario Selection Strategy

Choose appropriate scenarios based on the PR's scope of changes:

| PR Type                               | Recommended Scenarios                                        | Description                       |
| ------------------------------------- | ------------------------------------------------------------ | --------------------------------- |
| **Any PR** (default)                  | smoke test: send `hi`, verify startup & response             | Minimal-cost smoke validation     |
| Slash command changes                 | Corresponding command scenarios (`/about`, `/context`, etc.) | Verify command output correctness |
| Ink component / layout changes        | Multiple scenarios + full-flow long screenshot               | Verify visual effects             |
| Large refactors / dependency upgrades | Run `scenarios/all.ts` fully                                 | Full regression                   |

#### Running Screenshots

```bash
# Write scenario config to integration-tests/terminal-capture/scenarios/
# See terminal-capture skill for FlowStep API reference

# Single scenario
npx tsx integration-tests/terminal-capture/run.ts integration-tests/terminal-capture/scenarios/<scenario>.ts


# Check output in screenshots/ directory
```

#### Minimal Smoke Test Example

No need to write a new scenario file — just use the existing `about.ts`. It sends "hi" then runs `/about`, covering startup + input + command response:

```bash
npx tsx integration-tests/terminal-capture/run.ts integration-tests/terminal-capture/scenarios/about.ts
```

### 4. Upload Screenshots to PR

Use Playwright MCP browser to upload screenshots to the PR comments (images hosted at `github.com/user-attachments/assets/`, zero side effects):

1. Open the PR page with Playwright: `https://github.com/<repo>/pull/<number>`
2. Click the comment text box and enter a comment title (e.g., `## 📷 Terminal Smoke Test Screenshots`)
3. Click the "Paste, drop, or click to add files" button to trigger the file picker
4. Upload screenshot PNG files via `browser_file_upload` (can upload multiple one by one)
5. Wait for GitHub to process (about 2-3 seconds) — image links auto-insert into the comment box
6. Click the "Comment" button to submit

> **Prerequisite**: Playwright MCP needs `--user-data-dir` configured to persist GitHub login session. First time use requires manually logging into GitHub in the Playwright browser.

### 5. Submit Review

Submit code review comments via `gh pr review`:

```bash
gh pr review <number> --comment --body "review content"
```
