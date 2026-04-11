---
description: List all saved session names and their IDs. Usage: /chat-list
---

Please list all saved sessions for this project.

Follow these steps:

1. Read the session index from `.qwen/chat-index.json` in the project root (current working directory).
2. If the file doesn't exist or is empty, tell the user: "No saved sessions found."
3. If the file exists, display each session in a readable format:
   - One line per session
   - Show the name and a truncated version of the session ID (first 8 characters + "...")
   - Example format: `• <name> (ID: <short-id>...)`

Present the list sorted alphabetically by name.
