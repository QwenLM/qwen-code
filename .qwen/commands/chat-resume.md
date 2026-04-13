Same rules as `chat-save.md`:

- Regex: `^[a-zA-Z0-9_.-]+$`
- Reserved: `.`, `..`, `__proto__`, `constructor`, `prototype`
- Length: ≤ 128
- Read `.qwen/chat-index.json`
- Find the value for key `{{name}}`
- If not found: display the list of saved sessions (run `/chat -l` logic), then show a usage hint.
- Check: `~/.qwen/projects/<hash>/chats/<sessionId>.jsonl`
- If the file is missing: display saved sessions list + warn that session data may have been deleted.
  The command to open a new terminal differs by OS. Use the OS detected in Step 1 of `chat.md`:
  | OS | Terminal | Command |
  | Windows | PowerShell | `start pwsh -NoExit -Command "qwen --resume <sessionId>"` |
  | Windows | CMD | `start cmd /k "qwen --resume <sessionId>"` |
  | macOS | Terminal.app | `osascript -e 'tell app "Terminal" to do script "qwen --resume <sessionId>"'` |
  | Linux (GNOME) | gnome-terminal | `gnome-terminal -- qwen --resume <sessionId>` |
  | Linux (other) | xterm | `xterm -e "qwen --resume <sessionId>"` |
  Output: `Session "{{name}}" resumed in new window. (ID: <sessionId>)`
