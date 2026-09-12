# Unified VS Code session history E2E plan

## Scenario

1. In one workspace, create one session in the VS Code Companion sidebar and one from the terminal or browser Web Shell.
2. Open the sidebar's history dialog and confirm both conversations appear together, with no source selector.
3. Confirm both have rename and delete controls, except that deleting the current conversation remains disabled.
4. Open the terminal conversation, verify its transcript and continue it, then reload the extension host and verify the same conversation restores without changing its source metadata.
5. Create a new session from the VS Code header and confirm it appears in the same list with VS Code creation attribution.
6. Page through older conversations, including a page containing only child/background sessions; verify Load more stays available and a failed request can be retried without losing visible rows.

## Expected result

- Ordinary conversations from the same workspace appear together, including unattributed legacy sessions without an allowlist.
- Known child/background sessions stay out of the conversation list, and sparse pages remain navigable.
- Opening an existing session never supplies replacement creator attribution, including after the sidebar re-bootstraps.
- New VS Code sessions retain VS Code attribution.

## Automated coverage

The focused tests cover unified catalog requests, mixed-source rows and actions, terminal-session selection, reload and new-session attribution, and pagination retries. A real VS Code host remains a manual validation boundary.

The global `qwen` CLI has no companion history dialog, so a standalone CLI dry run is not a faithful baseline for this UI scenario.
