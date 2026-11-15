# worktree sidecar 精确文件轮询

[English](2026-11-15-worktree-sidecar-polling.md) | [简体中文](2026-11-15-worktree-sidecar-polling.zh-CN.md)

## 已验证独立Common/POLL checkpoint——2026-11-16

固定main88e3上的独立12路径候选现已通过七normal阶段及七CLI whole/181项，包含原2秒oracle下全部六个真实文件系统case；build/type/完整零warning lint/format/bundle通过。已测树8ed483a558fa7b7d04d5cbce4b7d1791170d271b，source-bundle entry9aa3e3ef3544c47e007a2785894eb5b6f1180efa9ee8915ed116c3d715aac222，共1,455文件。
short-fit公开流程通过Node+Ink、Bun+Ink、strict Bun+OpenTUI，helper前3次自然退出0及18个已关闭loopback model请求。每次都在一物理行完整显示87-cell ASCII删除命令、默认焦点Yes且恰一次CR，两次当前footer变化均满足原2秒期限。这只授予声明的sidecar流程，不授予长命令换行、所有signal路径或Trust重启行为。
本四文档checkpoint仅记录验证结果；八个已测源码/测试与编译bundle保持不变，出版记录包含文档格式、双语引用与精确源码对应核验。下文保留旧checkpoint（含当时pending/Trust组合文字），不描述本12路径范围。既有signal5P1F/clean-main Native首次提示失败及另案Bun+Ink Trust重启失败仍开；旧filesystem失败与新polling通过分层保留。仅更新现有Draft17334，CI/Ready/维护者审查与平台/稳定性资格独立。

## Common/POLL逻辑候选提案——2026-11-16

计划仅更新既有Draft17334，在固定main88e3上合并Common退出/重启接线与worktree sidecar精确文件轮询，共12路径；不含原生Trust、Stats、exec确认或CI路由改动，尚无独立12路径产物验收。下文旧MAIN39组合状态与结果仅作为历史；其中Trust组合/Trust CI描述不属于本逻辑候选。保留这些记录及原失败，不把39路径结果继承为12路径资格。仍需新owned候选、normal检查及有限sidecar验收；既定exec失败terminal42/手动重启政策不变。

## 状态与已复现问题

已形成源码checkpoint，main04bb加冻结Trust/Common组合上的验证仍待执行。真实文件系统删除在67096的原2秒断言内失败，随后单独补跑的创建案例在63675失败。独立Node/Core watch对照77513也在删除后没有观测到callback。早期trace显示watch已返回、sidecar确实不存在，但oracle窗口内没有callback；这不定位Darwin/Bun根因。全部旧失败保留；此处不宣称新源码测试、构建或公共产品通过。

## 最小改动与所有权

只将本hook的目录`fs.watch`替换为`fs.watchFile(exactSidecarPath, { persistent: false, interval: 500 }, listener)`。先订阅再初次真实读取，不mkdir父目录、不保留目录watch/fallback或可配置timer。仓库已有消费者使用此公开stat轮询模式。仅用既有校验reader读取捕获的Config/session sidecar，读取失败仍为null。

loaded值同时捕获Config身份和session ID，避免另一个Config恰好使用相同session ID时在加载期间显示前任worktree。cleanup先标记effect cancelled，再调用`unwatchFile(path, sameListener)`；保留旧callback不能开始新读，在途读取不能在撤销后发布。同文件两个订阅必须独立。sandbox挂载不读文件、不订阅。不引入通用owner框架、不改Core或政策。

两个生产消费者仍为Ink AppContainer与native AppShell。普通替换/卸载及最终退出都取消该stat listener订阅。现在没有目录FSWatcher交给`closeFileWatcher`；独立公开helper的Darwin最终退出政策不变，并保留独立控制测试。common退出增量的signal/relaunch准备不变。这不证明修复Trust重启或原生启动/退出。

## 语义与限制

500ms非persistent轮询约为每活动hook每秒两次stat，不是实际墙钟期限保证。通知与初次加载才读取内容。初始缺失文件后创建、删除、原子替换沿精确路径，不绑定旧父目录inode。metadata轮询可能合并快速变化，不能保证看到每个中间态或相同metadata改写。选择该间隔并不授予远端/慢文件系统延迟或Bun实现资格。

## 验证

五项原真实文件系统测试逐字保留，尤其创建/删除的2秒期限；新增通过公开writer执行真实原子替换，仍用2秒oracle。将既有owner及最终退出套件适配公开watchFile/unwatchFile合同，不删除撤销/owner/sandbox覆盖。增加同ID Config替换、同path独立listener、保留回调、迟到读取、初始缺失及失败恢复。原异步mkdir案例改为初读前订阅覆盖，因为该文件系统写操作已移除。

Root需运行build/type、三个同目录整文件、AppContainer/AppShell受影响消费者、lint/format/bundle及真实公共worktree进入/退出路由。Trust两次r案例独立，不能证明live sidecar刷新。公共路由须显式请求真实enter_worktree/exit_worktree工具，观察实际持久tuple/缺失及有界当前footer，遵循既有权限并保留只读map与自然quit，不注入private pending或操作全局flag。原RED来源及Root单独执行范围见`.qwen/e2e-tests/worktree-sidecar-polling-20261115.md`。不延长期限/增加重试，不切默认、不宣平台或整体迁移通过。
