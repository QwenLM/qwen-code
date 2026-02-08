# MCP Chrome Integration 设计文档架构（建议版）

> 目标：把当前 docs 里分散、重复、部分过时的设计资料整理成一套“单一真相来源”的设计文档体系，覆盖两个应用（Chrome 扩展 + QwenCode MCP Server）以及它们的协议与集成点。

## 1) 适用范围与受众

- 范围：系统设计与实现边界、协议与数据流、两个应用的内部设计、与 Qwen CLI/MCP 的集成方式。
- 不包含：纯执行脚本的使用说明、一次性的安装/验证报告（这些放在 guides/reports）。
- 受众：维护者、核心开发者、需要做二次开发/集成的人。

## 2) 组织原则

- 单一真相来源（SSOT）：每类信息只在一个地方完整描述，其它文档引用它。
- 设计、状态、运维、报告分层：防止状态文档污染设计文档。
- 可追踪：关键决策用 ADR 记录（Why + What + Tradeoffs）。
- 版本一致：设计文档顶端写明“适配的版本/日期/状态”。

## 3) 推荐的文档信息架构（IA）

> 说明：这是“最终结构”。实际迁移时可以先建立骨架文件，再把旧文档内容逐步合并。

```
docs/
  README.md                      # 文档入口（索引 + 导航）

  design/
    00-overview.md               # 目标/范围/非目标/用户场景
    01-requirements.md           # 功能/非功能需求与约束
    02-system-context.md         # 系统上下文、依赖、边界
    03-architecture.md           # 总体架构与组件分解
    04-dataflow.md               # 关键业务流、序列图、错误流
    05-protocols.md              # Native Messaging、MCP、内部消息
    06-extension-design.md       # MV3 扩展设计（SW/CS/SidePanel）
    07-native-server-design.md   # MCP Server 设计（工具注册/传输/生命周期）
    08-tools-catalog.md          # MCP 工具目录、映射、能力矩阵
    09-security-permissions.md   # 权限、CSP、信任边界、威胁模型
    10-build-release.md          # 构建/打包/发布流程（设计视角）
    11-migration-compat.md       # 旧架构 → 新架构迁移策略
    12-observability.md          # 日志、诊断、监控、排障入口
    13-open-questions.md         # 未决问题与待验证项
    adr/
      0001-native-messaging.md   # 关键决策记录
      0002-react-ui.md

  guides/
    quick-start.md               # 3-5 分钟快速上手
    installation.md              # 完整安装/配置指南
    development.md               # 开发环境与常见工作流
    mcp-usage.md                 # Qwen CLI 使用 MCP 指南
    troubleshooting.md           # 常见故障排查

  ops/
    deployment.md                # 发布/部署流程
    release-checklist.md         # 发布清单
    runbooks.md                  # 运维操作手册（可选）

  status/
    integration-status.md        # 当前集成状态（滚动更新）
    implementation-summary.md    # 历史实施总结（里程碑）

  reports/
    dependency-installation.md   # 依赖安装报告
    validation-report.md         # 验证/评测报告

  archive/                        # 历史/过时文档
```

## 4) 现有文档的归并建议（映射表）

> 仅列出 docs 目录下的现有文件。目标是“保留有价值信息、消除冲突”。

| 现有文件                                  | 建议归档位置                                                       | 处理方式     | 备注                                      |
| ----------------------------------------- | ------------------------------------------------------------------ | ------------ | ----------------------------------------- |
| `architecture.md`                         | `design/03-architecture.md`                                        | 保留并更新   | 作为总体架构主文档                        |
| `implementation-plan.md`                  | `status/implementation-plan.md` 或 `design/11-migration-compat.md` | 拆分合并     | 设计内容并入 design，进度/计划并入 status |
| `IMPLEMENTATION_SUMMARY.md`               | `status/implementation-summary.md`                                 | 迁移         | 保留里程碑信息                            |
| `INTEGRATION_STATUS.md`                   | `status/integration-status.md`                                     | 迁移         | 作为唯一“当前状态”来源                    |
| `NATIVE_MESSAGING_ADAPTATION_COMPLETE.md` | `status/` 或 `archive/`                                            | 先迁移后验证 | 与当前状态冲突需验证                      |
| `api-reference.md`                        | `design/05-protocols.md`                                           | 合并重写     | 当前内容偏旧协议，需统一                  |
| `MCP_NOTES.md`                            | `archive/` 或 `design/08-tools-catalog.md`                         | 甄别后迁移   | 描述旧 HTTP 路径，谨慎使用                |
| `migration-guide.md`                      | `design/11-migration-compat.md`                                    | 保留         | 适配新版工具映射                          |
| `QUICK_START.md`                          | `guides/quick-start.md`                                            | 保留/修订    | 统一主机名/路径                           |
| `INSTALLATION.md`                         | `guides/installation.md`                                           | 保留/修订    | 修正与实现不一致内容                      |
| `development.md`                          | `guides/development.md`                                            | 保留         | 补齐 dev workflow                         |
| `MCP_USAGE_GUIDE.md`                      | `guides/mcp-usage.md`                                              | 保留         | 修正路径/命令差异                         |
| `DEPLOYMENT.md`                           | `ops/deployment.md`                                                | 保留         | 生产发布流程                              |
| `DEPENDENCY_INSTALLATION_REPORT.md`       | `reports/dependency-installation.md`                               | 迁移         | 报告归档                                  |
| `hangwin-mcp-chrome-validation-report.md` | `reports/validation-report.md`                                     | 迁移         | 报告归档                                  |
| `docs/archive/*`                          | `archive/`                                                         | 保持         | 只做索引                                  |

## 5) 当前文档冲突点（已裁决）

> 以下冲突已在统一设计中裁决并落地（2026-02-01）。

- Native host 统一为：`com.chromemcp.nativehost`。
- MCP server 入口统一为：`dist/mcp/mcp-server-stdio.js`（Qwen CLI 配置使用）。
- 工具命名统一为 `chrome_*`，`browser_*` 仅作为历史别名。
- 旧 HTTP 架构描述仅保留在历史/归档文档中。
- 以 `docs/status/integration-status.md` 作为唯一“当前状态”来源。

## 6) 交付物（本次整理的产物）

- 本文档作为“设计文档架构”的单一入口。
- 待确认后，再按上面的 IA 创建/迁移具体文档。

---

**状态**: 已确认（执行中）
**最后更新**: 2026-02-01
