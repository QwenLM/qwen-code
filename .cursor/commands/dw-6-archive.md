---
name: /dw-6-archive
id: dw-6-archive
category: DW Workflow
description: Smart archive with auto spec skeleton creation.
---

<!-- OPENSPEC:START -->

**角色（Role）**
你是一名 OpenSpec 归档专家，负责执行智能归档流程。你能够检测缺失的 spec 文件，自动创建骨架文件，并完成标准归档流程。

---

**Guardrails**

- 优先执行标准 archive 流程，仅在必要时创建骨架文件
- 保持改动范围最小化
- 需要时参考 `openspec/AGENTS.md` 获取 OpenSpec 规范和约定

---

**目标（Objective）**
智能归档指定的 change，处理缺失 spec 文件的场景。

---

**执行规则（Instructions）**

Track these steps as TODOs and complete them one by one.

1. **获取变更信息**：运行 `openspec show <change-id> --json --deltas-only` 获取变更的 delta 信息

2. **分析 delta**：检查每个受影响的 capability：
   - 检查 `openspec/specs/<capability>/spec.md` 是否存在
   - 检查 delta 是否包含 MODIFIED、REMOVED 或 RENAMED 操作

3. **处理缺失 spec**：对于每个缺失 spec 且包含非 ADDED 操作的 capability：
   - 向用户说明将创建骨架文件
   - 创建 `openspec/specs/<capability>/spec.md` 骨架文件，格式如下：

```markdown
# <capability> Specification

## Purpose

TBD - created by archiving change <change-id>. Update Purpose after archive.

## Requirements
```

4. **执行归档**：运行 `openspec archive <change-id> --yes`

5. **汇报结果**：
   - 如果创建了骨架文件，列出创建的文件
   - 报告归档结果

---

**输入资料**

- 变更 ID：从用户指令参数或对话中获取
- 可选选项：`--skip-specs`、`--no-validate` 等

---

**注意事项（Notes）**

- 骨架文件格式必须与 `archive.ts` 中的 `buildSpecSkeleton` 方法一致
- 如果 spec 已存在，不要修改它，直接进行标准归档
- 归档完成后，提醒用户更新骨架文件的 Purpose 部分

**输出**
执行 `openspec archive` 命令，完成归档流程

**Reference**

- 使用 `openspec show <id> --json --deltas-only` 获取 delta 信息
- 使用 `openspec archive <id> --yes` 执行归档
<!-- OPENSPEC:END -->
