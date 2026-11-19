# VS Code ACP graceful shutdown E2E plan

## Scenario

1. Start a VS Code Companion chat that launches an MCP stdio child.
2. Close or reload the companion while the chat is idle.
3. Confirm the ACP CLI exits normally and its MCP child does not remain alive.
4. Repeat with an intentionally unresponsive ACP child and confirm the host escalates only after the graceful deadline.
5. Reopen the companion during teardown and confirm the replacement connection remains usable after the old child exits.

## Expected result

- Ordinary teardown reaches the CLI cleanup path before the host uses a forced termination.
- No old child exit, notification, or response clears the replacement connection.
- POSIX escalation targets the ACP process group; Windows escalation targets the process tree.

## Automated coverage

The focused companion and CLI tests cover the shutdown ladder, replacement races, overlapping shutdown phases, and hook deadline. Native Windows process-tree behavior and a real VS Code host remain manual validation boundaries.

The global `qwen` CLI cannot reproduce the companion-owned child lifecycle, so a standalone CLI dry run is not a faithful baseline for this scenario.
