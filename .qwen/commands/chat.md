---
description: Chat session management. Usage: /chat [--save|--list|--resume|--delete|--help] [name]
---

You are the chat session manager. Parse the arguments "{{args}}" and route accordingly.

## Argument Parsing

Split "{{args}}" by spaces. The first token is the flag, the rest is the session name.

**Supported flags:**

- `--save`, `-s` → Save current session (requires name)
- `--list`, `-l` → List all saved sessions
- `--resume`, `-r` → Resume a saved session (requires name)
- `--delete`, `-d` → Delete a saved session (requires name)
- `--help`, `-h`, `help` → Show help message
- No flag or unrecognized flag → Show help message

## Routing Rules

### If flag is --save or -s:

1. If name is empty, show: "Usage: /chat --save <name>\nExample: /chat --save my-session"
2. Otherwise, execute `/chat-save <name>` logic:
   - Validate name: `^[a-zA-Z0-9_.-]+$`, not `.`, `..`, `__proto__`, `constructor`, `prototype`, max 128 chars
   - If invalid, show error with rules and stop.
   - Read `.qwen/chat-index.json` from the project root (current working directory)
   - **If the name already exists in the index:**
     - Warn the user: 'Session "{{name}}" already exists. Do you want to overwrite it? (yes/no)'
     - **Do NOT proceed without explicit "yes" confirmation.** If user says anything other than "yes", stop and confirm cancellation.
   - **If the name does NOT exist in the index:** Proceed directly to save without asking for confirmation.
   - **Get the current session ID:**
     - You are the AI running inside the current session. **You MUST know your own session ID from the conversation context.**
     - If you can determine the current session ID from context (e.g., it was mentioned in the system prompt, visible in the URL/title, or you can infer it from recent conversation history), use that real UUID.
     - **If you truly cannot determine the session ID:** Do NOT generate a fake one. Instead, tell the user: "I cannot determine the current session ID from context. Please provide the session ID manually, or use the application's built-in save feature."
   - Write to index: `"{{name}}": "<actual-session-id>"` (ensure `.qwen` directory exists first, format JSON with 2-space indent)
   - If new: Confirm: `Saved: {{name}} -> <sessionId>`
   - If overwrite: Confirm: `Overwritten: {{name}} -> <sessionId>`

### If flag is --list or -l:

1. Read `.qwen/chat-index.json`
2. If empty/missing: "No saved sessions found."
3. Otherwise display: `• name (ID: first8chars...)` sorted alphabetically

### If flag is --resume or -r:

1. If name is empty, execute `/chat-list` then show usage
2. If name looks like UUID, treat as session ID directly
3. Otherwise validate name format
4. Look up session ID from `.qwen/chat-index.json`
5. If not found, execute `/chat-list` then show usage
6. Verify session file exists in `.qwen/projects/<project-hash>/chats/<sessionId>.jsonl`
7. If missing, execute `/chat-list` and warn
8. If all checks pass, launch: `start pwsh -NoExit -Command "qwen --resume <sessionId>"`
9. Tell user: `Session "name" is being resumed in a new window. (ID: sessionId)`

### If flag is --delete or -d:

1. If name is empty, execute `/chat-list` then show usage
2. Validate name format
3. Look up session ID from `.qwen/chat-index.json`
4. If not found, execute `/chat-list` then show usage
5. Ask for confirmation: "Are you sure you want to delete session "name"? This will remove it from the saved sessions index."
6. Do NOT proceed without explicit "yes" confirmation
7. Remove from index, write back to `.qwen/chat-index.json`
8. Confirm: `Session "name" removed from saved sessions index.`
9. Add note: "This only removes the saved name reference. The actual session history file is NOT deleted."

### If flag is --help or -h or help:

Show:

```
Chat Session Manager

Usage: /chat <flag> [name]

Flags:
  --save, -s <name>     Save current session with a name
  --list, -l            List all saved sessions
  --resume, -r <name>   Resume a saved session
  --delete, -d <name>   Delete a saved session from index
  --help, -h            Show this help message

Examples:
  /chat --save my-session
  /chat --list
  /chat --resume my-session
  /chat --delete my-session
```

### If no flag or unrecognized flag:

Show the same help message as --help.
