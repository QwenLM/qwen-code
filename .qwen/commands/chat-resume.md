1. Validate `{{name}}` (Common rules).
2. Look up ID in index. Missing → show list, stop.
3. Verify `~/.qwen/projects/<hash>/chats/<id>.jsonl` exists. Missing → warn, stop.
4. Open new window (detect OS):
   - Windows: `start pwsh -NoExit -Command "qwen --resume <id>"`
   - macOS: `osascript -e 'tell app "Terminal" to do script "qwen --resume <id>"'`
   - Linux: `gnome-terminal -- qwen --resume <id>` (or `xterm -e ...`)
5. Output: `Session "{{name}}" resumed in new window. (ID: <id>)`
