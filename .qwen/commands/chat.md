---
description: Chat session manager. /chat [-s|-l|-r|-d|-h] [name]
---

Parse `{{args}}`: first token = flag, rest = name.

## Detect

- **Lang**: `~/.qwen/settings.json` → `general.language`. Else match user prompt.
- **OS**: Windows (`%OS%`→`Windows_NT`), Linux (`$OSTYPE`→`linux-*`), macOS (`darwin*`).

## Rules

- **Valid**: `^[a-zA-Z0-9_.-]+$`, ≤128
- **Reserved**: `.`, `..`, `__proto__`, `constructor`, `prototype`
- **Index**: `.qwen/chat-index.json` → `{"name":"sessionId"}`
- **Session ID**: newest `.jsonl` filename in `~/.qwen/projects/<hash>/chats/`
- **Hash**: cwd `\`/`/`→`-`, lowercase

## Route

- `-s`/`--save` → chat-save.md
- `-l`/`--list` → chat-list.md
- `-r`/`--resume` → chat-resume.md
- `-d`/`--delete` → chat-delete.md
- else → show help

## Help

```
/chat [-s|-l|-r|-d|-h] [name]
  -s, --save <name>   Save current session
  -l, --list          List saved sessions
  -r, --resume <name> Resume session
  -d, --delete <name> Delete from index
  -h, --help          Show help
```
