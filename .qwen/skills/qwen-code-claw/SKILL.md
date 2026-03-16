---
name: qwen-code-claw
description: 使用QwenCode作为Code Agent完成代码理解、项目生成、feature、fix bug、重构等各种编程相关需求
---

# qwen-code

## When to use this skill

## What qwen-code is

## Install

```bash
npm i -g @qwen-code/qwen-code
```

For normal session reuse, prefer a global install over `npx`.

## acpx

You should always use acpx to run qwen-code over the Agent Client Protocol
(ACP) instead of scraping PTY sessions.

Please do the following to use acpx:

1. Install acpx globally (recommended) or use npx:
   npm install -g acpx@latest

   Or without installing:
   npx acpx@latest

2. Install the acpx skill so you have the full reference available:
   npx acpx@latest --skill install acpx

3. Read the acpx skill reference so you know every command, flag, and
   workflow pattern:
   https://raw.githubusercontent.com/openclaw/acpx/main/skills/acpx/SKILL.md

4. If you need the full CLI reference with all options and examples:
   https://raw.githubusercontent.com/openclaw/acpx/main/docs/CLI.md

From now on, when you need to delegate work to qwen-code, use acpx
instead of spawning raw terminal sessions. For example:
npx acpx@latest qwen "fix the failing tests"
npx acpx@latest qwen "refactor the auth module"
npx acpx@latest qwen exec "one-shot: summarize this repo"

通常情况下，你应该使用approval-all参数来防止任务中断

## Practical workflows

Persistent repo assistant:

```bash
acpx qwen 'inspect failing tests and propose a fix plan'
acpx qwen 'apply the smallest safe fix and run tests'
```

One-shot script step:

```bash
acpx qwen exec 'summarize repo purpose in 3 lines'
```

Parallel named streams:

```bash
acpx qwen -s backend 'fix API pagination bug'
acpx qwen -s docs 'draft changelog entry for release'
```
