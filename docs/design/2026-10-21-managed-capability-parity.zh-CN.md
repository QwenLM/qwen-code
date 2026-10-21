# Managed Agent 能力对照矩阵

[English](2026-10-21-managed-capability-parity.md)

## 动机

仓库维护两条服务端路径：旧 `qwen serve` 守护进程与 Managed Agent 控制面。两条路径共享同一个 TypeScript Agent 核心。两条路径的控制面、隔离模型与运维形态不同。当前没有单一位置说明某个能力属于哪条路径。用户无法判断某功能是否两条路径都有。贡献者新增旧路径能力时，收不到「Managed 路径已不同步」的信号。

Issue #15075 要求一个持续校验的矩阵。矩阵只报告差异。矩阵不要求消除差异。

## 数据来源

| 侧           | 来源                                                                                         | 读取方                 |
| ------------ | -------------------------------------------------------------------------------------------- | ---------------------- |
| 旧路径标签   | `packages/cli/src/serve/capabilities.ts` 的 `SERVE_CAPABILITY_REGISTRY`                      | TypeScript 测试        |
| Managed 工具 | `hosted-workspace-tool-turn.ts` 与 `hosted-team-session.ts` 的 Hosted Workspace profile 声明 | TypeScript 测试        |
| Managed 路由 | `SurfaceRegistry`（Java 枚举）                                                               | 提交副本，由 Java 校验 |

## 设计

### 每个旧标签一行

`packages/cli/src/serve/capability-parity.ts` 中的 `CAPABILITY_PARITY` 为每个旧标签保存一行。类型为 `Record<ServeFeature, ParityRow>`。因此新增旧标签若没有对应行，编译失败。每行声明三种归属之一：

- `managed`：Managed 路径支持该标签。该行给出依据。
- `legacy`：属于旧守护进程的职责。Managed 控制面不承担。该行说明原因。
- `absent`：Managed 的缺口。该行说明为何不提供。

`capabilityParityMatrix()` 把各行投影为三列：`legacy only`、`both`、`managed only`。

### 依据必须在代码中存在

`managed` 行给出依据标记。测试逐个标记对照代码：

- `tool:<name>`：某个 Hosted Workspace profile 声明该工具。
- `surface:<CAPABILITY>`：存在属于该 `SurfaceRegistry.Capability` 的路由。
- `route:<prefix>`：存在该前缀的路由。
- `docs:<path>`：文件存在。

依据已失效的行会让测试失败。纯文字声明做不到这一点。

### Java 路由集合

TypeScript 测试不能读取 Java 枚举。提交文件 `packages/managed-agent-server/src/test/resources/capability-parity/managed-surface.txt` 是 `SurfaceRegistry` 的副本。每行为 `label method template`。文件头部记录排序后路由行的 SHA-256 摘要。

两项 Java 校验保证副本正确：

- `ManagedSurfaceCaptureTest` 把文件与枚举对比。重新生成命令：`mvn -Dtest=ManagedSurfaceCaptureTest#capture test`。
- `SurfaceRegistryApiTest` 双向对比 public 与 WebShell 路由和已发布的 OpenAPI 文档。

TypeScript 测试解析 `SurfaceRegistry.java` 获取路由集合。副本与枚举不一致时两侧都会失败。

## 边界

- 矩阵不判断某条路径是否应复制另一条路径。
- internal writer 路由不在 OpenAPI 文档中。只有注册表列出它们。
- `managed only` 列列出没有旧标签的 Managed 能力。初始内容为 tail events 路由。

## 验收

- `cd packages/cli && npx vitest run src/serve/capability-parity.test.ts` 通过。
- `cd packages/managed-agent-server && mvn -Dtest=ManagedSurfaceCaptureTest test` 通过。
- 向 `SERVE_CAPABILITY_REGISTRY` 新增标签但不加行：TypeScript 测试编译失败。
- 改动某 Managed 依据指向：TypeScript 测试失败并指出该标记。
- 改动 `SurfaceRegistry` 但不重新生成：Java 测试失败。
