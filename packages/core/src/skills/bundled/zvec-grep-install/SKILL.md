---
name: zvec-grep-install
description: Install zvec-grep (zg) and connect it to Qwen Code. Use when the user asks to install or set up zg, or asks to use zg when its MCP integration is unavailable. Do not use for ordinary workspace search when the zg MCP integration is already available.
---

# Install zvec-grep

If the user invokes `/zvec-grep-install` directly, treat that invocation as an
explicit request to perform the installation and begin with step 1. Do not ask
for another request or invoke this skill again.

If the user asks how to install zg, explain the commands without running them.
Only perform the installation when the user explicitly asks you to install or
set up zg.

1. Check whether `zg` is available on `PATH`.
2. If it is unavailable, install it:

   ```bash
   npm install -g @zvec/zvec-grep
   ```

3. Connect zg to Qwen Code:

   ```bash
   zg install --target qwen --yes
   ```

4. Tell the user to start a new Qwen Code session, then stop.

Do not edit Qwen Code configuration or instruction files manually. After the
installer succeeds, do not run additional zg commands.
