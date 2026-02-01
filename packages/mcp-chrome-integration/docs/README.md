# MCP Chrome Integration 文档索引

本目录包含 MCP Chrome Integration 的设计文档、指南、运维、状态与报告。

## 📌 快速入口

- **设计架构（文档结构）**: [DESIGN_DOCS_ARCHITECTURE.md](DESIGN_DOCS_ARCHITECTURE.md)
- **快速开始**: [guides/quick-start.md](guides/quick-start.md)
- **安装指南**: [guides/installation.md](guides/installation.md)
- **集成状态**: [status/integration-status.md](status/integration-status.md)

---

## 🧭 文档导航（按类型）

### 设计文档（Design）
- [design/00-overview.md](design/00-overview.md) - 目标/范围/非目标
- [design/01-requirements.md](design/01-requirements.md) - 需求与约束
- [design/02-system-context.md](design/02-system-context.md) - 系统上下文
- [design/03-architecture.md](design/03-architecture.md) - 总体架构
- [design/04-dataflow.md](design/04-dataflow.md) - 关键数据流
- [design/05-protocols.md](design/05-protocols.md) - 协议与消息模型
- [design/06-extension-design.md](design/06-extension-design.md) - 扩展设计
- [design/07-native-server-design.md](design/07-native-server-design.md) - MCP Server 设计
- [design/08-tools-catalog.md](design/08-tools-catalog.md) - 工具目录与能力
- [design/09-security-permissions.md](design/09-security-permissions.md) - 安全与权限
- [design/10-build-release.md](design/10-build-release.md) - 构建与发布（设计视角）
- [design/11-migration-compat.md](design/11-migration-compat.md) - 迁移与兼容策略
- [design/12-observability.md](design/12-observability.md) - 可观测性与诊断
- [design/13-open-questions.md](design/13-open-questions.md) - 未决问题
- [design/adr/README.md](design/adr/README.md) - ADR 索引

### 使用与开发指南（Guides）
- [guides/quick-start.md](guides/quick-start.md) - 快速上手
- [guides/installation.md](guides/installation.md) - 安装与配置
- [guides/development.md](guides/development.md) - 开发指南
- [guides/mcp-usage.md](guides/mcp-usage.md) - MCP 使用指南
- [guides/customization.md](guides/customization.md) - 定制指南（占位）

### 运维与发布（Ops）
- [ops/deployment.md](ops/deployment.md) - 部署与发布

### 状态与里程碑（Status）
- [status/integration-status.md](status/integration-status.md) - 当前集成状态（滚动更新）
- [status/implementation-summary.md](status/implementation-summary.md) - 实施总结（里程碑）
- [status/implementation-plan.md](status/implementation-plan.md) - 实施计划（历史参考）
- [status/native-messaging-adaptation.md](status/native-messaging-adaptation.md) - 适配记录（待核验）

### 报告（Reports）
- [reports/dependency-installation.md](reports/dependency-installation.md) - 依赖安装报告
- [reports/validation-report.md](reports/validation-report.md) - 验证报告

### 归档（Archive）
- [archive/](archive/) - 历史/过时文档（仅供参考）

---

## 📝 文档维护规则

1. 设计文档为单一真相来源（SSOT），状态/报告不得覆盖设计。
2. 新增文档需放在对应分类目录，并更新本索引。
3. 过时文档必须移入 `archive/`，并在正文顶部标注“历史”。

---

**最后更新**: 2026-02-01
**维护者**: Qwen Code Team
