## TLDR

Enhanced the system prompt to emphasize a documentation-first approach and proper tool usage. The agent now prioritizes reading and understanding relevant documentation before planning or implementing tasks, and uses the appropriate tools (EditTool vs WriteFileTool) for file modifications.

## Dive Deeper

This PR significantly improves the agent's behavior by:

1. **Documentation-First Approach**: Added "Documentation First" as the first Core Mandate, requiring the agent to always read and understand relevant documentation (README.md, CONTRIBUTING.md, QWEN.md, and other project documentation) before planning or implementing any task.

2. **Improved Tool Usage Guidance**: Strengthened the File Modification Safety Core Mandate to always use EditTool for modifying existing files, clarifying that WriteFileTool should never be used to modify existing files as it will replace the entire content.

3. **Post-Task Documentation Updates**: Updated the Final Reminder section to instruct the agent to update project documentation (QWEN.md and files in the docs/ directory) after completing tasks when appropriate.

4. **Workflow Enhancements**: Enhanced both the Software Engineering Tasks and New Applications workflows to require documentation research before creating any plan.

These changes ensure that the agent follows a more disciplined approach to software development by prioritizing documentation reading and proper tool usage, which should lead to higher quality and more consistent results.

## Reviewer Test Plan

To validate these changes, reviewers should:

1. Test the agent with various tasks that involve file modifications to ensure it uses EditTool appropriately for existing files and WriteFileTool only for new files
2. Verify that the agent reads and references documentation when appropriate during task planning and execution
3. Confirm that the agent properly updates documentation files when making changes to the codebase
4. Check that the agent's behavior aligns with the updated prompts by examining its reasoning process in complex tasks

Example prompts to test:
- "Refactor the auth logic in src/auth.py to use the requests library instead of urllib" (should read existing documentation first)
- "Add a new feature to track user metrics" (should read documentation before proposing a plan)
- "Fix the bug in the file watcher" (should reference existing documentation)

## Testing Matrix

|          | 🍏  | 🪟  | 🐧  |
| -------- | --- | --- | --- |
| npm run  | ✅  | ✅  | ✅  |
| npx      | ✅  | ✅  | ✅  |
| Docker   | ✅  | ✅  | ✅  |
| Podman   | ✅  | -   | -   |
| Seatbelt | ✅  | -   | -   |

## Linked issues / bugs

Related to improving agent behavior and consistency in following project conventions.