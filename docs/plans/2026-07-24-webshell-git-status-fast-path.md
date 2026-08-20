# 实施计划：Web Shell git chip 快速显示

日期：2026-07-24
设计文档：`docs/design/2026-07-24-webshell-git-status-fast-path.md`

## Goal

新建会话/首屏时 composer git chip 以 branch 立即出现，计数器经 SSE 补齐；
daemon 端消除重复 `git status` 子进程（缓存 + in-flight 去重 + 2s 节流）。

## Architecture

daemon `WorkspaceGitState` 增加 per-workspace status 缓存与后台刷新
（stale-while-revalidate），路由默认 fast、`?wait=1` 阻塞；SDK 新增
`git_status_changed` 事件与 `workspaceGit({cwd, wait})` options；
webui 把 SSE status 存入 connection.gitStatus；web-shell App 消费它补齐 chip，
侧栏显式走 `wait: true` 保持现状语义。

## Tech Stack

TypeScript ESM monorepo（cli / sdk-typescript / webui / web-shell），vitest。

## File Structure

| 包        | 文件                                             | 改动                                                                              |
| --------- | ------------------------------------------------ | --------------------------------------------------------------------------------- |
| cli       | `src/serve/workspace-git-state.ts`               | 缓存 + 去重 + 节流 + 后台刷新 + SSE publish + `getStatus` opts                    |
| cli       | `src/serve/routes/workspace-git.ts`              | 解析 `?wait=1` 透传（两条路由；worktree `?cwd=` 不变）                            |
| cli       | `src/serve/workspace-git-state.test.ts`          | 新增 fast/cache/dedup/throttle/wait/dispose 用例                                  |
| cli       | `src/serve/routes/workspace-git.test.ts`         | `?wait=1` 透传、worktree 不进缓存                                                 |
| sdk       | `src/daemon/events.ts`                           | known types 增加 `git_status_changed`                                             |
| sdk       | `src/daemon/ui/normalizer.ts`                    | case → `return []`                                                                |
| sdk       | `src/daemon/DaemonClient.ts`                     | `workspaceGit(opts?: {cwd?, wait?})` options 对象                                 |
| sdk       | `test/unit/DaemonClient.test.ts`                 | query 拼接用例                                                                    |
| webui     | `src/daemon/session/types.ts`                    | `DaemonConnectionState.gitStatus?`                                                |
| webui     | `src/daemon/session/mappers.ts`                  | `case 'git_status_changed'`（workspaceCwd 守卫）                                  |
| webui     | `src/daemon/session/mappers.test.ts`             | 匹配/不匹配两分支                                                                 |
| web-shell | `client/App.tsx`                                 | options 迁移 + fast/fresh 双发（fresh 不依赖 SSE，覆盖无会话态）+ SSE 同步 effect |
| web-shell | `client/components/sidebar/WorkspaceSection.tsx` | `workspaceGit({ wait: true })`                                                    |

## Tasks

- [x] 1. daemon：`WorkspaceGitState` 缓存/去重/节流/后台刷新/SSE + `getStatus` opts
- [x] 2. daemon：路由 `?wait=1` 透传
- [x] 3. daemon：单测（state + route）
- [x] 4. sdk：事件类型 + normalizer + `workspaceGit` options 对象 + 单测
- [x] 5. webui：connection.gitStatus + mapper + 单测
- [x] 6. web-shell：App.tsx（options 迁移 + fast/fresh 双发 + SSE 同步 effect）+ WorkspaceSection `wait: true`
- [x] 7. `npm run build && npm run typecheck` + 各包目标单测全绿
- [x] 8. E2E 测试计划写入 `.qwen/e2e-tests/`，test-engineer 实测验证（协议级 6/6 通过，记录见计划文件）
- [x] 9. 自审 diff（两轮）+ `/review`（medium local：无遗留发现；评审中补了 2 个 App 用例）

## 备注

- P2（前端请求去重）经价值重评估后不做——daemon 去重已消除重复子进程，
  前端再合并只剩一次毫秒级本地 HTTP，不抵跨层耦合成本。设计文档已记录。
- worktree `?cwd=` 路径维持直接计算，不进缓存（避免 watcher 泄漏）。
