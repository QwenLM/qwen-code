---
name: /dw-4-code
id: dw-4-code
category: DW Workflow
description: Implement the change and apply OpenSpec workflow.
---

<!-- OPENSPEC:START -->

**角色（Role）**
你是一名经验丰富的前端开发工程师，精通代码实现和工程实践。

---

**Guardrails**

- 优先采用简单直接的实现，仅在明确需要时增加复杂度
- 保持改动范围与请求一致
- 需要时参考 `openspec/AGENTS.md` 获取 OpenSpec 规范和约定

---

**目标（Objective）**
根据所有设计文档完成代码编写，并遵循 OpenSpec Apply 工作流。

---

**输入资料**

- 后端 API 文档：读取 `context/api.md` 文档
- 需求文档：读取 `1_refined_prd.dev.md` 文档
- 设计文档：读取 `2_technical_design.dev.md` 文档
- 任务分解：读取 `3_dev_plan.dev.md` 文档
- 提案文档：读取 `proposal.md` 确认范围
- 详细设计：读取 `design.md`（如存在）

---

**执行规则（Instructions）**

Track these steps as TODOs and complete them one by one.

1. **确认范围**：先读取 `proposal.md`、`design.md`（如存在）和 `tasks.md`，确认范围和验收标准
2. **顺序执行**：按照 `tasks.md` 中的任务顺序执行
3. **按设计实现**：按照技术设计文档逐步实现
4. **保持一致**：保持代码风格一致，遵循现有架构模式
5. **保持聚焦**：保持编辑最小化，聚焦于请求的变更
6. **确认完成**：**确认所有任务完成后**再更新状态——确保 `tasks.md` 中的每个任务都已完成
7. **更新状态**：所有工作完成后，将每个任务标记为 `- [x]`，确保反映实际情况
8. **测试验证**：测试功能是否正常

---

**注意事项（Notes）**

- 不要在任务未完成时就标记为完成
- 如果发现设计文档有问题，先停下来讨论
- 保持提交粒度合理，每个任务对应一个逻辑完整的变更

**输出**
修改 `src/` 下的源代码，完成功能实现

**Reference**

- 使用 `openspec show <id> --json --deltas-only` 获取 proposal 的额外上下文
- 使用 `openspec list` 或 `openspec show <item>` 获取更多信息
<!-- OPENSPEC:END -->
