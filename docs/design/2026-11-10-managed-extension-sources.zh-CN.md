# 业务方持有的 Managed 扩展来源

[English](2026-11-10-managed-extension-sources.md) | [简体中文](2026-11-10-managed-extension-sources.zh-CN.md)

## 状态与范围

仓内实现候选，部署验收待完成。业务方保留资产 CRUD、业务表、权限、版本选择和原始归档。Managed 通过 Java SPI 接受明确版本的 Skill 或扩展引用，编译不可变执行包并保存安装收据。独立 MCP 目录、HTTP Provider、WebShell 浏览、业务实例策略和生命周期迁移不在本次范围。静态 Session Skills 继续独立支持。

## 契约与归属

`ManagedExtensionSource` 提供稳定 Provider ID、授权后的 `resolve(Context, Reference)` 和 `open(Context, Resolved)`。引用包含 Provider、类型、资源 ID 和明确版本。上下文由可信租户、Actor 和 Workspace 身份构造，并携带请求 ID 和截止时间。Provider 负责业务授权与规范身份。不存在和无权限均返回未找到；临时故障不得变成空目录或普通本地包回退。解析出的归档句柄是适配器私有状态，不持久化也不对外返回。

`ExtensionArchiveStorage` 提供原子不可覆盖的 `putIfAbsent`、流式 `open` 和配置校验。存在业务 Bean 时默认目录实现自动退让，自定义存储无需本地持久包目录。所有副本使用同一私有命名空间，存储 Key 包含租户与 Workspace 作用域。Managed 校验字节、限制临时存储，并在 HTTP 流或 Runtime 异步上传实际结束后释放文件租约。执行包继续保留，本次不增加 GC。

## 导入与持久化

`POST /v1/agents/workspaces/{workspaceId}/extensions/source-imports` 接受明确引用、目标平台与幂等请求头。Managed 检查 Workspace/部署权限，查询原收据，解析并流式读取来源，计算实际字节摘要，然后复用 Hosted `managed-package-preparation/1`。准备期间不创建 Session、模型、Hook、MCP 连接或安装。沿用现有归档、容量和截止时间限制，不支持的内容明确失败。

编译后的包通过存储 SPI 保存。`ma_extension_package.source_json` 保存规范引用、原始包摘要和导入请求指纹。同一逻辑来源在 Workspace 中保持稳定扩展身份。业务版本、包版本和 Session 配置版本相互独立，原始包和编译包摘要相互独立。同 Key 重试返回原收据，不同请求冲突。普通上传不能替换来源绑定身份。CSI 清单与 Schema 校验保留来源信息。业务表不迁移，Managed 保持独立 Schema。

## 授权与恢复

`ma_extension_source_import` 在任何外部 I/O 前，以 Actor 作用域导入 Key 保存原始引用/目标平台指纹。业务源可能在编译包产生前失败，因此需要这张小型 Managed 收据表。`GET .../source-imports/{operationId}` 或携带原幂等请求头的 `GET .../source-imports` 在 Provider 故障时仍可返回原导入意图。准备前返回 `operationId`、`state=pending`、`reference`；准备后补充 `operation`、`source`，仅发布完成后返回 `pin`。嵌套操作沿用现有 `kind=publish` 协议。CSI 同时保留此表和包的 `source_json`，业务 Schema 无需修改。

目录读取、包详情、独立下载、检查、设置访问、新建 Session 和新的 apply 都重新检查业务权限。授权发生在 Managed SQL 事务之外，准入事务根据本地记录核对冻结选择。已完成创建的重放和已准入 apply 的继续沿用原操作，保留 Session/Workspace 和 Actor 检查。Provider 故障不阻断收据查询或已准入 Session 的恢复，能力查询不读取业务目录。

撤权阻止新选用和独立取包。既有已准入 Session 保留固定内容，直接从执行包存储恢复，不重新解析当前业务来源。执行包缺失或损坏时明确失败，不替换为最新内容或静默重新编译。默认启用和强制选择继续由受信业务应用负责。凭据继续走现有加密设置，不进入来源信息或归档句柄。

公共 v2 Session close/delete 在生命周期 effects 完成后，终态释放 Hook 与 MCP owner。普通 Harness detach 保持确定性 owner 可重新获取。生命周期 claim、身份、generation、未决执行与最终 Worker 停止校验仍必须通过，detach 回执不能代替终态 close 证据。

## 业务接入与验收

DataAgent 适配器留在业务仓，仅依赖 Managed contracts。复用 Skill 与专家套件的现有精确版本和权限规则，不使用吞掉归档错误的对客 DTO 或仅支持当前版本的票据。不根据历史 DTO 字段推断发布资格，不给明确版本增加仅已发布限制。原始 ZIP 摘要兼容由适配器处理，Managed 计算实际字节摘要。

验证自定义 Bean 退让、重复 Provider、严格引用、流清理、不可变存储、同 Key 冲突、并发导入和未知写入；所有新使用/读取路径的来源权限；更新、撤权和进程替换后的固定版本；来源故障期间的原操作重放；CSI 来源恢复。执行 API/SurfaceRegistry、嵌入契约、真实 MySQL 并发/恢复和 Hosted 执行。遵守模块共享十分钟本地 Java 预算，完整 CI 和真实 DataAgent 部署验收分别记录。本设计不声明已经部署。

本地证据包括定向 Java/API 测试、真实 MySQL 8.4 导入并发和 CSI 来源往返、自定义存储 Spring 退让，以及 Boot 3.5.3 来源导入/Session 准入。DataAgent 独立 `managed-extension-sources / pinned-versions` 集合需要候选部署和自有历史 Skill/脚本、专家套件测试资源，当前未在部署环境执行。来源撤权、Provider 故障、进程替换和执行包损坏的部署故障矩阵仍待单独执行。既有 daemon/Muster 旅程不能证明 Managed 验收。较早 DataAgent 候选曾记录 ACP 协议 IT 失败，原失败报告继续保留。当前内网宿主候选已通过完整本地门禁（3,222 项单测、墙钟 20.123 秒、聚合行覆盖率 86.93%）、Boot 3.5.3 嵌入装配及 320 项一次性 MySQL 8.4.11 测试。这些检查不代表部署或 Hosted 执行验收通过。
