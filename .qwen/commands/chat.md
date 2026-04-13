---
description: Chat session manager. /chat [-s|-l|-r|-d|-h] [name]
---

Parse "{{args}}": first token = flag, rest = name.

1. **Lang**: `~/.qwen/settings.json` → `general.language`. Match user prompt if missing.
2. **OS**: Windows (`%OS%` → `Windows_NT`), Linux (`$OSTYPE` → `linux-*`), macOS (`darwin*`).

- **Valid**: `^[a-zA-Z0-9_.-]+$`, ≤128 chars
- **Reserved**: `.`, `..`, `__proto__`, `constructor`, `prototype`
- **Index**: `.qwen/chat-index.json` → `{"name": "sessionId"}`
- **Session ID**: newest `.jsonl` filename in `~/.qwen/projects/<hash>/chats/`
- **<hash>**: cwd with `\`/`/`→`-`, lowercase
  | Flag | Action |
  | `-s`/`--save` `<name>` | Read `chat-save.md`, exec |
  | `-l`/`--list` | Read `chat-list.md`, exec |
  | `-r`/`--resume` `<name>` | Read `chat-resume.md`, exec |
  | `-d`/`--delete` `<name>` | Read `chat-delete.md`, exec |
  | `-h`/`--help`/empty | Show help below |

```
/chat [-s|-l|-r|-d|-h] [name]
  -s, --save <name>   Save current session
  -l, --list          List saved sessions
  -r, --resume <name> Resume session
  -d, --delete <name> Delete from index
  -h, --help          Show help
```
