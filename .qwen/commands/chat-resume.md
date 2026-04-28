# chat-resume.md — Resume a Saved Session

1. Validate `{{name}}` (Common rules): `^[a-zA-Z0-9_.-]+$`, ≤128, ≠ `.`/`..`/`__proto__`/`constructor`/`prototype`.
2. Look up ID in index (`.qwen/chat-index.json` in project root, NOT `~/.qwen/`). Missing/not found → show list + "Session not found", stop.
3. Verify `~/.qwen/projects/<hash>/chats/<id>.jsonl` exists. Missing → warn "Session file missing", stop.
4. **Execute a shell command** to launch a NEW terminal window. Run the command below using your shell tool. **DO NOT read the .jsonl file content.**
   - Windows: run `start pwsh -NoExit -Command "qwen --resume <id>"`. If it fails, run `start cmd /k "qwen --resume <id>"`
   - macOS: run `osascript -e 'tell app "Terminal" to do script "qwen --resume <id>"'`
   - Linux: use `command -v` to detect terminal (gnome-terminal, xterm, alacritty, kitty in order), then run it with `qwen --resume <id>`
5. Output: `Session "{{name}}" resumed in new window. (ID: <id>)`
