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
- `docs:<path>`：该文件存在（目录不算）。

依据已失效的行会让测试失败。纯文字声明做不到这一点。

### Java 路由集合

TypeScript 测试不能读取 Java 枚举。提交文件 `packages/managed-agent-server/src/test/resources/capability-parity/managed-surface.txt` 是 `SurfaceRegistry` 的副本。每行为 `label method template surface`。文件头部记录排序后路由行的 SHA-256 摘要。

`ManagedSurfaceCaptureTest` 把文件与枚举对比，常规运行绝不写入。重新生成需要显式开启，因为会改写自身基准的测试，会让第二次运行在已被第一次改过的数据上变绿：

```bash
mvn -Dtest=ManagedSurfaceCaptureTest -Dcapability.parity.capture=true test
```

`ManagedSurfaceCaptureTest` 是权威：它把副本与 `render()` 逐字节比对，覆盖 label、method、template、surface 四列。TypeScript 侧不再解析枚举——读取 Java 源码的解析器对无法识别的形态会失明，而正确重放反而变红，这正是第二轮评审证实的。它改为断言副本的内部一致性：每行四个字段、每条路由只出现一次、头部摘要与自身路由行匹配。

## 边界

- 矩阵不判断某条路径是否应复制另一条路径。
- internal writer 路由不在 OpenAPI 文档中。只有注册表列出它们。
- `managed only` 列由推导得出：列出副本中没有任何 `managed` 行引用的路由标签。排除集合记录某个标签为何不算缺口，且其中每一项都必须指向副本真实记录的标签。新挂载且没有旧标签、也没有排除理由的路由会出现在该列，这正是 #15075 要求的信号。剩余标签由 `MANAGED_ONLY_REPORTED` 固定，因此新增项会使测试失败，直到有人记录其记账方式。该列目前报告十二个标签：九个 `EXTENSION_*` 标签描述包发布、archive 访问、设置、操作查询及 Session 配置。它们按 Session 固定版本的合同与守护进程的扩展 API 不同；登记这些标签不代表旧 API 兼容或平台验收。`SESSION_CONTEXT_COMPRESSION` 压缩会话上下文，`SESSION_RECOVERY_QUERY` 读取会话恢复状态，`SESSION_RECOVERY_RECHECK` 重跑会话恢复检查。

## 验收

- `cd packages/cli && npx vitest run src/serve/capability-parity.test.ts` 通过。
- `cd packages/managed-agent-server && mvn -Dtest=ManagedSurfaceCaptureTest,SurfaceRegistryGateTest,ManagedAgentApiContractTest test` 通过。
- 向 `SERVE_CAPABILITY_REGISTRY` 新增标签但不加行：TypeScript 测试编译失败。
- 改动某 Managed 依据指向：TypeScript 测试失败并指出该标记。
- 改动 `SurfaceRegistry` 但不重新生成：Java 测试失败。
- 模块的 Checkstyle 门禁保持通过：
  `mvn --batch-mode --no-transfer-progress checkstyle:check checkstyle:check@runtime-broker-checkstyle`。
