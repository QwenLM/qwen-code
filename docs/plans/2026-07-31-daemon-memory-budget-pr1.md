# 实施计划：daemon 内存预算 —— 解析与观测（PR A）

日期：2026-07-31
设计文档：`docs/design/2026-07-31-daemon-capacity-model-and-memory-bounds.md`
关联：#8051（方向讨论）、#8182（缺陷）；替代 #8093 的第一个 PR

## Goal

把 daemon 的内存分母解析出来并如实上报，**不改变任何子进程的启动参数**。目的是让后续的 child-capacity 策略有一个可设计的依据，而不是自己再发明一个分母。

## Architecture

acp-bridge 新增 `daemon-memory-budget.ts`（纯算术，无 I/O，宿主内存可注入）产出 `DaemonMemoryBudget`。`runQwenServe` 在解析完 workspace 输入后调用一次并挂到 `opts.daemonMemoryBudget`，仅供状态面读取。`daemon-status` 把静态事实放 `limits.memory`、动态计数放 `runtime.memory`。`spawnChannel.ts` 完全不动。

## Global Constraints

- **不划分、不应用、不拒绝。** 见设计文档「Why the share is not applied」：按注册数划分在 32 GB / 25 注册 / 仅 primary 存活时，会把那个子进程从 16384 砍到 614 MB（26.7 倍）；而且因为有 512 MB 下限，8 GB 宿主上 25 个子进程仍会授权 12800 MB 对 3687 MB 的池子。代价大，且拿不到聚合上界。
- **configured 与 effective 必须分离。** effective 封顶在解析出的 cgroup/宿主内存。派生预算低于最小值时**不向上钳位**——之前那版这么做，768 MB 宿主报出 1024 MB 预算，会污染观测层的一切比值。改报 `insufficientMemory`。
- **`--max-old-space-size` 不是 RSS 边界**（不含 Buffer / native / young gen / channel worker / MCP 子孙）。任何基于它的策略都是子进程**堆**策略。
- **应用份额是兼容性变更**，即使不拒绝任何请求——它改变子进程的 GC 与 OOM 行为，不能当作 "reporting only" 交付。
- 不加 capability tag：`daemon_status` 已是 baseline，新增可选字段不属于 `CONDITIONAL_SERVE_FEATURES`。
- 不引入 core 依赖：`computeEffectiveMemoryLimit()` 是 `MemoryPressureMonitor` 的 private 方法，抽取会触发 maintainer 门禁。

## File Structure

| 包         | 文件                                          | 改动                                                                                        |
| ---------- | --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| acp-bridge | `src/daemon-memory-budget.ts`                 | **新增**：`DaemonMemoryBudget`、resolver、`legacyChildCeilingMb`、`recommendedChildShareMb` |
| acp-bridge | `src/daemon-memory-budget.test.ts`            | **新增**：算术表、effective 封顶、insufficientMemory、建议份额上界                          |
| acp-bridge | `package.json`                                | `./daemonMemoryBudget` subpath export                                                       |
| acp-bridge | `src/spawnChannel.ts`                         | **不改动**                                                                                  |
| cli        | `src/commands/serve.ts`                       | `--memory-budget-mb` 声明 + 范围校验 + 透传                                                 |
| cli        | `src/serve/fast-path.ts`                      | `NUMBER_OPTIONS` 一行（与 yargs 的 parity 有契约测试强制）                                  |
| cli        | `src/serve/types.ts`                          | `memoryBudgetMb` / `daemonMemoryBudget`；修订 `maxSessions` 文档段                          |
| cli        | `src/serve/run-qwen-serve.ts`                 | boot 解析 + 面包屑；bootstrap 占位状态补 `memory: null`                                     |
| cli        | `src/serve/daemon-status.ts`                  | `limits.memory` 静态事实 + `runtime.memory` 活跃计数与建议份额                              |
| cli        | 三个 `*.test.ts`                              | 预算上报、live 计数、flag 解析、boot 校验                                                   |
| sdk        | `src/daemon/types.ts`                         | `DaemonStatusReport.limits.memory?`（**:610-624**）                                         |
| docs       | daemon 17/20、`users/qwen-serve.md`、protocol | flag 行 + `limits.memory` / `runtime.memory` 字段说明                                       |

## 关键锚点

| 位置                          | 用途                                              |
| ----------------------------- | ------------------------------------------------- |
| `run-qwen-serve.ts:2326-2330` | 显式 workspace 上限校验 → 预算解析插在其后        |
| `run-qwen-serve.ts:~1541`     | bootstrap 占位状态的第二处 `DaemonStatusLimits`   |
| `run-qwen-serve.ts:481-492`   | `--mcp-client-budget` 面包屑风格                  |
| `daemon-status.ts:~365`       | `workspaceSnapshots` → `channelLive` 即活跃子进程 |
| `commands/serve.ts` ~`:310`   | flag 声明位（`--mcp-client-budget` 旁）           |

## 算术

```
availableMemoryMb        = cgroup limit, else os.totalmem()      （封顶在宿主总量）
configuredBudgetMb  = --memory-budget-mb ?? floor(availableMemoryMb * 0.5)
effectiveBudgetMb   = min(configuredBudgetMb, availableMemoryMb)
rootReserveMb       = min(clamp(floor(effectiveBudgetMb * 0.1), 256, 1024), effectiveBudgetMb)
childPoolMb         = effectiveBudgetMb - rootReserveMb
legacyChildCeilingMb     = min(floor(availableMemoryMb * 0.5), 16384)
insufficientMemory  = effectiveBudgetMb < 1024
```

`recommendedChildShareMb(budget, n)` = `min(clamp(floor(childPoolMb / n), 512, 16384), legacyChildCeilingMb)` —— **只上报，不应用**。

## Tasks

- [x] 1. acp-bridge：`daemon-memory-budget.ts` + 单测
- [x] 2. acp-bridge：`package.json` subpath export
- [x] 3. cli：flag 声明/校验/透传 + `fast-path.ts` 一行 + `ServeOptions` 两个字段
- [x] 4. cli：boot 解析 + 面包屑 + bootstrap 占位状态补字段
- [x] 5. cli + sdk：`limits.memory` / `runtime.memory` 与 SDK mirror
- [x] 6. 文档：flag 行、字段说明、protocol
- [x] 7. `lint` + `typecheck` + 目标单测全绿
- [x] 8. E2E：已落为自动化测试（`run-qwen-serve.test.ts` 里真实启动 daemon 并 GET `/daemon/status`），断言 effective 不超过宿主、pool 小于 effective、`runtime.memory` 计数存在。真实输出确认了封顶：3.4 GB 机器上传 `--memory-budget-mb 4096` 降到 3494 并打出说明
- [x] 9. 自审 diff：三轮，共修 5 处（残留注释、面包屑位置、状态面重复取值、**SDK 漏了 `runtime.memory` 镜像**、极小宿主上保留额大于预算）；最后一轮无发现
- [ ] 10. `/review`（等 #8051 对字段集有反馈后再跑，避免字段还会变）

## 后续（不在本 PR）

1. **聚合 child RSS 与压力分级** —— 目前只采样 primary 子进程；覆盖全部 workspace 子进程与 channel worker 需要扩展 metrics sampler。
2. **child-capacity 策略** —— 按**并发存活**子进程数、在 spawn 期准入，并明确「下一个子进程会超出池子时怎么办」（已在运行的子进程堆降不下来）。实现时注意 `spawnChannel.ts:27-34` 的 raise-only 判断会把偏小的份额整个丢掉，回归测试必须断言低于测试进程自身堆上限的值仍会输出 flag。
3. **聚合配额** —— 见设计文档 Part 4。

## 备注

- 早先版本曾在 workspace 数超预算时 boot 失败并在注册处返回 409，跑既有测试套件当场被推翻（**注册不等于分配**）。随后改成「划分份额但不拒绝」，在 #8051 上被进一步指出仍是同一个分母错误，且划分本身就已是行为变更。当前形态是这两轮的结果。
- `spawnChannel.ts` 上一版曾加过一个可选 `maxOldSpaceSizeMB` 参数和 C1 回归测试，本 PR 已整体回退——没有消费者的参数就是未接线基础设施。该陷阱记录在设计文档和 #8182。
