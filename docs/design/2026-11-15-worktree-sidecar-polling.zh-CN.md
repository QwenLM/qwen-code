# worktree sidecar 精确文件轮询

[English](2026-11-15-worktree-sidecar-polling.md) | [简体中文](2026-11-15-worktree-sidecar-polling.zh-CN.md)

## 有界后续修正——2026-11-16

同 owner 读取失败回归现在先加载有效 worktree，再通过订阅通知触发失败读取并确认清空为 null，最后验证下一次通知恢复。互链的[退出策略后续修正](2026-11-15-cli-final-watcher-exit-chain.zh-CN.md)将 launcher 预检及 catch 的恢复范围限定为已知不可用路径和可捕获 JavaScript 异常，原生系统调用及 TOCTOU 失败仍不在保证范围内。有限本地验证已记录于互链的退出策略后续修正，下述旧结果保留各自源码的历史范围。

## 已验证独立 Common/POLL checkpoint——2026-11-16

固定 `main` 的 `88e3f19c01d5` 上的独立 12 路径候选现已通过七 normal 阶段及七 CLI whole/181 项，包含原 2 秒 oracle 下全部六个真实文件系统 case；build/type/完整零 warning lint/format/bundle 通过。已测树 `8ed483a558fa7b7d04d5cbce4b7d1791170d271b`，source-bundle entry `9aa3e3ef3544c47e007a2785894eb5b6f1180efa9ee8915ed116c3d715aac222`，共 1,455 文件。
short-fit 公开流程通过 Node+Ink、Bun+Ink、strict Bun+OpenTUI，helper 前 3 次自然退出 0 及 18 个已关闭 loopback model 请求。每次都在一物理行完整显示 87-cell ASCII 删除命令、默认焦点 Yes 且恰一次 CR，两次当前 footer 变化均满足原 2 秒期限。这只授予声明的 sidecar 流程，不授予长命令换行、所有 signal 路径或 Trust 重启行为。
本四文档 checkpoint 仅记录验证结果；八个已测源码/测试与编译 bundle 保持不变，出版记录包含文档格式、双语引用与精确源码对应核验。下文保留旧 checkpoint（含当时 pending/Trust 组合文字），不描述本 12 路径范围。既有 signal 5 通过 / 1 失败 / clean-main Native 首次提示失败及另案 Bun+Ink Trust 重启失败仍开；旧 filesystem 失败与新 polling 通过分层保留。仅更新现有 Draft #17334，CI/Ready/维护者审查与平台/稳定性资格独立。

## Common/POLL 逻辑候选提案——2026-11-16

计划仅更新既有 Draft #17334，在固定 `main` 的 `88e3f19c01d5` 上合并 Common 退出/重启接线与 worktree sidecar 精确文件轮询，共 12 路径；不含原生 Trust、Stats、exec 确认或 CI 路由改动，尚无独立 12 路径产物验收。下文旧 `MAIN39` 组合状态与结果仅作为历史；其中 Trust 组合/Trust CI 描述不属于本逻辑候选。保留这些记录及原失败，不把 39 路径结果继承为 12 路径资格。仍需新 owned 候选、normal 检查及有限 sidecar 验收；既定 exec 失败 terminal 42/手动重启政策不变。

## 状态与已复现问题

已形成源码 checkpoint，`main04bb` 加冻结 Trust/Common 组合上的验证仍待执行。真实文件系统删除在 67096 的原 2 秒断言内失败，随后单独补跑的创建案例在 63675 失败。独立 Node/Core watch 对照 77513 也在删除后没有观测到 callback。早期 trace 显示 watch 已返回、sidecar 确实不存在，但 oracle 窗口内没有 callback；这不定位 Darwin/Bun 根因。全部旧失败保留；此处不宣称新源码测试、构建或公共产品通过。

## 最小改动与所有权

只将本 hook 的目录 `fs.watch` 替换为 `fs.watchFile(exactSidecarPath, { persistent: false, interval: 500 }, listener)`。先订阅再初次真实读取，不 mkdir 父目录、不保留目录 watch/fallback 或可配置 timer。仓库已有消费者使用此公开 stat 轮询模式。仅用既有校验 reader 读取捕获的 Config/session sidecar，读取失败仍为 null。

loaded 值同时捕获 Config 身份和 session ID，避免另一个 Config 恰好使用相同 session ID 时在加载期间显示前任 worktree。cleanup 先标记 effect cancelled，再调用 `unwatchFile(path, sameListener)`；保留旧 callback 不能开始新读，在途读取不能在撤销后发布。同文件两个订阅必须独立。sandbox 挂载不读文件、不订阅。不引入通用 owner 框架、不改 Core 或政策。

两个生产消费者仍为 Ink AppContainer 与 native AppShell。普通替换/卸载及最终退出都取消该 stat listener 订阅。现在没有目录 FSWatcher 交给 `closeFileWatcher`；独立公开 helper 的 Darwin 最终退出政策不变，并保留独立控制测试。common 退出增量的 signal/relaunch 准备不变。这不证明修复 Trust 重启或原生启动/退出。

## 语义与限制

500 ms 非 persistent 轮询约为每活动 hook 每秒两次 stat，不是实际墙钟期限保证。通知与初次加载才读取内容。初始缺失文件后创建、删除、原子替换沿精确路径，不绑定旧父目录 inode。metadata 轮询可能合并快速变化，不能保证看到每个中间态或相同 metadata 改写。选择该间隔并不授予远端/慢文件系统延迟或 Bun 实现资格。

## 验证

五项原真实文件系统测试逐字保留，尤其创建/删除的 2 秒期限；新增通过公开 writer 执行真实原子替换，仍用 2 秒 oracle。将既有 owner 及最终退出套件适配公开 watchFile/unwatchFile 合同，不删除撤销/owner/sandbox 覆盖。增加同 ID Config 替换、同 path 独立 listener、保留回调、迟到读取、初始缺失及失败恢复。原异步 mkdir 案例改为初读前订阅覆盖，因为该文件系统写操作已移除。

Root 需运行 build/type、三个同目录整文件、AppContainer/AppShell 受影响消费者、lint/format/bundle 及真实公共 worktree 进入/退出路由。Trust 两次 r 案例独立，不能证明 live sidecar 刷新。公共路由须显式请求真实 enter_worktree/exit_worktree 工具，观察实际持久 tuple/缺失及有界当前 footer，遵循既有权限并保留只读 map 与自然 quit，不注入 private pending 或操作全局 flag。原 RED 来源及 Root 单独执行范围见 `.qwen/e2e-tests/worktree-sidecar-polling-20261115.md`。不延长期限/增加重试，不切默认、不宣平台或整体迁移通过。
