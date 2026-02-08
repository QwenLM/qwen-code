# 归档文档说明

本目录包含项目开发过程中的历史文档和过程性文档，已不再维护。

## 归档原因

这些文档是 AI 辅助开发过程中生成的中间产物，包括：

- 设计骨架文档（待补齐的模板）
- 实施计划和状态追踪（已完成）
- 一次性验证报告
- 未完成的设计草稿

项目的**最终产品文档**位于 `docs/` 目录。

---

## 归档内容

### design/ - 设计骨架文档（13个）

- `DESIGN_DOCS_ARCHITECTURE.md` - 文档架构规划（元文档）
- `00-overview.md` - 概览骨架（26行）
- `01-requirements.md` - 需求骨架（20行，标注"待补齐"）
- `02-system-context.md` - 系统上下文骨架
- `04-dataflow.md` - 数据流骨架（11行）
- `05-protocols.md` - 协议骨架
- `06-extension-design.md` - 扩展设计草稿
- `07-native-server-design.md` - Native Server 设计草稿
- `09-security-permissions.md` - 安全设计骨架
- `10-build-release.md` - 构建发布骨架
- `11-migration-compat.md` - 迁移兼容性骨架
- `12-observability.md` - 可观测性骨架
- `13-open-questions.md` - 未决问题列表（已过期）

### status/ - 状态追踪文档（4个）

- `implementation-plan.md` - 实施计划（2026-01初，基于 hangwin/mcp-chrome 的集成方案）
- `implementation-summary.md` - 阶段性实施总结
- `integration-status.md` - 集成状态追踪
- `native-messaging-adaptation.md` - Native Messaging 适配完成报告

### reports/ - 一次性报告（2个）

- `dependency-installation.md` - 依赖安装报告
- `validation-report.md` - hangwin/mcp-chrome 验证报告

### ops/ - 运维文档（1个）

- `deployment.md` - 部署流程草稿

---

## 最终文档位置

项目的当前文档结构位于：

- **根目录**：`packages/mcp-chrome-integration/README.md`
- **架构设计**：`docs/architecture.md`
- **工具参考**：`docs/tools-reference.md` (27个工具的完整文档)
- **用户指南**：`docs/guides/`
- **测试文档**：`docs/testing/`
- **ADR**：`docs/adr/`

---

**归档日期**: 2026-02-08
**归档原因**: 清理过程性文档，保留最终产品文档
