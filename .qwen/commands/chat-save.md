---
description: Save the current session with a name. Usage: /chat-save <name>
---

Please save the current session with the name "{{args}}".

Follow these steps:

1. Validate the session name "{{args}}":
   - Must match: `^[a-zA-Z0-9_.-]+$`
   - Must NOT be: `.`, `..`, `__proto__`, `constructor`, `prototype`
   - Must be 128 characters or fewer
   - If invalid, output an error message explaining the rules and stop.

2. Check if the name already exists in the index:
   - Read `.qwen/chat-index.json` from the project root (current working directory)
   - If the file doesn't exist, treat as empty index `{}`
   - If "{{args}}" is already in the index, warn the user and ask for confirmation before overwriting. **Do NOT proceed without explicit user confirmation.**

3. Get the current session ID:
   - The session ID is tracked internally by the application. You should know the current session ID from the conversation context.

4. Write to the index:
   - Add or update the entry: `"{{args}}": "<sessionId>"`
   - Write back to `.qwen/chat-index.json` with formatted JSON (2-space indent)
   - Ensure the `.qwen` directory exists first

5. Confirm success:
   - Show the user the saved mapping: `Saved: {{args}} -> <sessionId>`
