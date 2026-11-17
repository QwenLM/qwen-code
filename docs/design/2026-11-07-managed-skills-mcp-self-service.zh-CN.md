# Managed Skills 与 MCP 自助配置

[English](2026-11-07-managed-skills-mcp-self-service.md) | [简体中文](2026-11-07-managed-skills-mcp-self-service.zh-CN.md)

## 状态与交付范围

方案于 2026-11-07 确认，2026-11-08 更新拆分方式。PR #16500 交付归档上传、普通 MCP 配置表单，以及 Session 的显式安装、更新和恢复。Runtime Skill 快照和个人 HTTP MCP OAuth 分别作为依赖此基础的独立交付。代码实现不等于运行环境已经验收。

拆分前的完整实现保留在 `4736349cbe5d60f39251a148ef17df5f764a03bb`。拆分保留已确认设计和适用的评审修复。每个拆分后的 head 都需要自己的验证；原整包检查仅作为参考证据。三个交付继续共用已经耗尽的本地 Java 验证预算。

## 问题与现有基础

Managed 用户应能在没有本地 daemon 的情况下安装携带脚本和资源文件的 Skill，并配置 MCP 连接。现有扩展包已经提供资源、加密 Workspace settings、不可变版本及 `config_install`。复用这些权威入口，避免增加另一套安装器或配置历史。

原始静态 Session 快照中的 Skill 保持不可变。安装扩展不会改写该快照，也不会将仅文件 Session 升级为 Shell。原生自动发现、目录监听、Git/npm 获取、依赖安装及 setup 脚本不属于本次交付。

## 包模型与规范化

独立 Skill 归档恰好包含一个 `SKILL.md`，位于根目录或一层包裹目录中。规范化为 `qwen-extension.json` 与 `skills/<name>/...`，保留受支持的元数据、脚本和资源。多 Skill 分发使用普通扩展归档。沿用限定名及冲突规则，不静默替换同名静态 Skill。

准备和执行阶段共用 Skill 兼容性解析器及 MCP recipe 校验。对不支持的 hooks、权限声明、参数处理、模型覆盖、未知 MCP 字段、混合传输和非法参数明确报错，不丢弃后继续。支持 stdio、Streamable HTTP 和 SSE；可执行程序与参数分别输入，不将命令字符串隐式解释为 Shell 程序。

一个独立 MCP 连接对应一个最小扩展，包含一个 authored server 和 settings 声明。身份保持为 `extensionId:authoredName`。编辑发布同一扩展的新 revision。复合扩展按整包管理，组件视图提供跳转。

包和编译器版本保持为 1。输入和发布归档不包含个人 OAuth 声明。资源继续使用 `extension://` 与 `$QWEN_EXTENSION_ROOT`；执行保留 Session 工作目录，不安装依赖。

## 无 Session 准备

暴露进程级 Hosted 能力 `managed-package-preparation/1`。Java 认证 actor、校验 Workspace 权限和部署 allowlist、限制输入，再将解析、规范化及编译委托给 TypeScript。Java 主机不需要 Node.js，也不要求与 Hosted 共享文件系统。

池模式选择支持能力且 accepting 的实例，不申请 Session placement。准备不创建 Session，不初始化模型，不连接 MCP server，不执行 Hook 或用户 setup。临时归档绑定所选实例及 boot ID；仅控制面读取内部句柄，将产物流式交给现有发布服务。

沿用 100 MiB 压缩输入、1 GiB 展开内容和 100,000 个归档条目的限制。拒绝链接、特殊文件和路径穿越。限制并发准备及临时磁盘总量，准备最多运行十分钟，临时产物十五分钟后到期。异步工作和清理结束前保持显式 in-flight operation，包括 HTTP 响应断开后的情况。

相同输入、目标平台和编译器版本产生可重复的包字节。使用 `sourceType: snapshot`，来源摘要写入 `sourceRevision`；规范化内容不包含临时名称和时间戳。更新保持原 `extensionId` 和命名空间。

## 凭据与 inspection

MCP 秘密字段使用 settings 占位符。实际值通过现有加密 settings API 保存，并标注为 **Workspace 服务凭据**：获授权的 Workspace 执行可以使用。归档、浏览器持久化、回执、日志和指标不包含秘密值。

凭据不变时沿用精确的 `settingsRevision`。修改时提交完整 settings 集合，必需值需要重新填写。inspection 按精确 digest 检查，仅对有操作权限者开放，返回组件、文件及可编辑的非秘密配置，不扩大普通 MCP inventory 的可见性。

## 公共契约

Workspace 基路径为 `/v1/agents/workspaces/{workspaceId}/extensions`；Session 基路径为 `/v1/agents/sessions/{sessionId}/extensions`。

| 范围与操作                                                           | 权威入口                                                  |
| -------------------------------------------------------------------- | --------------------------------------------------------- |
| Workspace `POST /imports/preview`                                    | 确认前执行纯规范化和 inspection                           |
| Workspace `POST /imports`                                            | 流式接收原始输入，规范化后通过现有 package operation 发布 |
| Workspace `GET /{extensionId}/packages/{packageRevision}/inspection` | 检查精确的已发布 digest                                   |
| Workspace `POST /operations/lookup`                                  | 按种类和幂等键查发布/settings 回执                        |
| Session `POST /operations/lookup`                                    | 按幂等键查原 apply operation                              |
| 现有 settings、apply、query、continue 和 recover-previous            | 继续作为凭据及 Session 配置的权威入口                     |

元数据绑定来源种类、目标、摘要和编译器版本，可指定更新目标 `extensionId`。MCP 表单输入为不含秘密的 JSON。不接受任意下载 URL 或控制面文件系统路径。catalog 与 Session query 区分服务支持、发布权限和当前应用资格；服务端每次操作都重新检查。

公共 apply 保留 `expectedConfigRevision` 和完整 `extensions` pin 选择。同步维护 OpenAPI、WebShell provider/生成类型、Java SDK、SurfaceRegistry 与契约证据。个人绑定字段和新 apply 协议留到独立 OAuth 交付。

## 一次确认安装与恢复

1. 读取当前配置，检查权限、profile、空闲状态及目标兼容性。
2. 预览名称、来源、资源、组件、连接配置、凭据用途及受影响 Session。
3. 用户一次确认“安装到当前 Session”。
4. 发布包，并在需要时保存 settings。
5. 将新 pin 合并到已确认的完整选择，携带 `expectedConfigRevision` 应用。
6. 精确选择得到 `active` 回执后才显示已安装。

各阶段使用固定幂等键。仅在 actor 作用域持久化标识、阶段、公开 pins、键及预期 revision。上传字节、草稿和秘密只留在内存。发布前刷新需要重新提供原输入；发布响应丢失时先查询原回执，不创建第二个 revision。

settings 失败时显示包已保存、凭据未完成。Session 变忙或 revision 改变时保留发布结果，要求用户重新确认差异，不排队自动应用。配置提交前失败时，原 active 配置继续可用。

已提交 apply 的结果未知时保持原 operation 屏障。查询或继续原 operation 和原 owner，不在其他 worker 重放。确定失败的 apply 或已证明发生于准入前的 `invalid_request` / `extension_config_revision_conflict`，只有查过原幂等键并读取新的已稳定 Session 快照后，才能显式重新确认。仅轮换 apply key，保留发布/settings 回执和键。

发布 v2 不更新固定在 v1 的 Session。用户对符合条件的空闲 Session 显式应用更新。恢复旧包/settings pins 时新增配置 revision，不倒退配置历史。更新 Session A 不影响 Session B。恢复针对扩展配置，不撤销先前外部工具效果。

## 验证与发布

覆盖无 daemon、无 Session placement 的 ZIP/tar.gz 确定性准备、资源使用、普通 MCP 调用、加密 settings 及可安全重试的回执查询。覆盖两个 Session 固定不同包版本、仅更新其中一个、恢复旧内容，并保留无关扩展、独立 MCP 连接和基础 Hooks。

覆盖准备、stage、commit、drain、enable、响应丢失及 worker 替换。拒绝不支持的 provider、静态快照替换、仅文件 profile 升级和只读子 Session 变更。运行受影响的 TypeScript build/typecheck/测试及公共 API 契约门禁。真实 MySQL、browser→Java→Runtime 和进程故障验收需要独立证据。本次拆分不恢复本地 Java 验证预算，剩余 Java 门禁由 CI 执行。

自助安装通过 `qwen.managed-agent.extensions.self-service-enabled` 默认关闭。池成员能力契约必须一致。关闭安装入口保留已安装包。复用 tracing 记录 operation、阶段、结果、耗时、容量拒绝及恢复冲突，不记录来源内容和凭据。

## 独立后续交付

**Runtime Skill 导入**依赖本次安装链路，增加所选 Workspace 的候选发现、原 owner/generation 校验、来源变化检测和不可变快照导入，不增加 watcher 或自动 Session 更新。

**个人 HTTP MCP OAuth**也依赖本次链路，与 Runtime 发现相互独立。加密 grants/attempts、PKCE 授权、版本化个人绑定、执行 actor 检查及 HTTP token/刷新/撤销 adapter 一起交付。部署隔离和身份/恢复验收得到证明前默认关闭。Workspace 对历史及结果的阅读权限保持不变。
