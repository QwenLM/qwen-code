# CLI 最终退出 watcher 策略接线

[English](2026-11-15-cli-final-watcher-exit-chain.md) | [简体中文](2026-11-15-cli-final-watcher-exit-chain.zh-CN.md)

## 基于源码的真实子进程验证——2026-11-16

下述此前 185 项及 20 项测试 checkpoint 的真实子进程导入已构建 CLI 模块，其证据仅属于那些精确构建树。当前测试按模块相对 URL 将当前 CLI 源码打包为一个所属临时 ESM 产物；合成入口仅 re-export 重启函数和清理注册，共享一个真实 cleanup 模块。不加载旧 CLI dist，也不把生产函数体复制到测试中。
保持不变的纯 Core watcher-cleanup 和 text utilities 被别名到当前 TypeScript 源码，仅依赖 Node builtin。对未使用的 deferred Core runtime 导入只做 external 处理以避免遍历其 barrel，输出产物不得残留该引用。不 mock 或替换实际使用的实现。仍需已安装的根 esbuild 依赖，以及套件其余部分所需的普通 workspace 前置产物。
新的完整类型检查、process utility 整文件（20 项通过）、定向测试 lint、格式、双语引用与 actionlint 已通过。直接 no-AK meta 整套 15 项通过、四项平台跳过；另七项选定的变更 job/邻接合同通过，193 项无关测试被过滤。这些定向合同不计整文件通过。
不重新构建的源码绑定反证临时移除 launcher 预检：旧构建模块测试仍以子进程退出 42 通过，而当前源码测试按预期因原生 ENOENT/SIGABRT 失败。随后源码、测试及全部 1,455 个 bundle 文件均精确恢复。这证明该回归观察当前源码，而非陈旧 CLI 构建；不使所有原生 exec 失败可恢复。真实 owned Node 副本删除、execve 检查、core dump 限制、清理 marker、终态 42 oracle 和既有 15 秒子进程/20 秒测试上限均不变。不宣称 Core 或产品行为改动、平台资格或新的公开应用通过。

## 有界 launcher 后续修正——2026-11-16

在既有 supervised exec 的 try 内、watcher 准备及清理之后检查已知 launcher 失败：当前可执行路径须解析为普通文件并通过 X_OK，合法符号链接会被跟随。已知预检失败与可捕获的 JavaScript exec 异常沿用既有安全错误报告并最终以代码 42 退出；没有 supervisor 时用户必须手动重启。成功路径的 PID、argv、GC 参数及清理顺序不变。原生系统调用失败可能直接终止运行时而非抛错，ENOEXEC、E2BIG 及检查后的文件或权限变化不在保证范围内；检查不是原子操作，不能消除 TOCTOU。受控 Node 副本删除自身 launcher 的基线已复现清理后出现原生 ENOENT/SIGABRT，而不是预期的 42；新增真实子进程回归现已记录清理并无终止信号地退出 42。此前通过的 exec 控制测试仅证明可捕获 JavaScript 异常行为，不证明全部原生失败都可恢复。下述旧结果保留各自精确源码的历史范围，本后续修正已有有限本地验证，应用、平台及最终 main 资格仍独立。

Root 已验证 build/type、七个完整 CLI 文件共 185 项通过、完整 lint、格式及 bundle。补充测试 capability skip 后，改动的 process 整文件在 Node 24 上再次通过全部 20 项，并完成新的 build/type、定向 lint、格式及 bundle；另六个测试 blob 不变。独立 owned 副本删除见证也已退出 42。验证树为 `8eab19b07e7a47bd030eb591a77b2e309114f7a1`，其后的本 checkpoint 仅改这四份设计文档。既有构建和 listener 警告、此前 ESM mock 夹具失败均保留记录。Windows 及不提供 execve 的运行时跳过本 native-exec 夹具，不计平台通过。

## 已验证独立 Common/POLL checkpoint——2026-11-16

固定 `main` 的 `88e3f19c01d5` 上的独立 12 路径候选现已通过七 normal 阶段及七 CLI whole/181 项，包含原 2 秒 oracle 下全部六个真实文件系统 case；build/type/完整零 warning lint/format/bundle 通过。已测树 `8ed483a558fa7b7d04d5cbce4b7d1791170d271b`，source-bundle entry `9aa3e3ef3544c47e007a2785894eb5b6f1180efa9ee8915ed116c3d715aac222`，共 1,455 文件。
short-fit 公开流程通过 Node+Ink、Bun+Ink、strict Bun+OpenTUI，helper 前 3 次自然退出 0 及 18 个已关闭 loopback model 请求。每次都在一物理行完整显示 87-cell ASCII 删除命令、默认焦点 Yes 且恰一次 CR，两次当前 footer 变化均满足原 2 秒期限。这只授予声明的 sidecar 流程，不授予长命令换行、所有 signal 路径或 Trust 重启行为。
本四文档 checkpoint 仅记录验证结果；八个已测源码/测试与编译 bundle 保持不变，出版记录包含文档格式、双语引用与精确源码对应核验。下文保留旧 checkpoint（含当时 pending/Trust 组合文字），不描述本 12 路径范围。既有 signal 5 通过 / 1 失败 / clean-main Native 首次提示失败及另案 Bun+Ink Trust 重启失败仍开；旧 filesystem 失败与新 polling 通过分层保留。仅更新现有 Draft #17334，CI/Ready/维护者审查与平台/稳定性资格独立。

## Common/POLL 逻辑候选提案——2026-11-16

计划仅更新既有 Draft #17334，在固定 `main` 的 `88e3f19c01d5` 上合并 Common 退出/重启接线与 worktree sidecar 精确文件轮询，共 12 路径；不含原生 Trust、Stats、exec 确认或 CI 路由改动，尚无独立 12 路径产物验收。下文旧 `MAIN39` 组合状态与结果仅作为历史；其中 Trust 组合/Trust CI 描述不属于本逻辑候选。保留这些记录及原失败，不把 39 路径结果继承为 12 路径资格。仍需新 owned 候选、normal 检查及有限 sidecar 验收；既定 exec 失败 terminal 42/手动重启政策不变。

## 状态与问题

当前组合基于 main `04bb3c64473eb6f2c980434e6e612a180c65055f`，尚未验证。它合并本已发布退出接线与已解决冲突的原生 Trust 路由；共享 relaunch 保留 cleanup 前 prepare、安全 terminal 42 报告及全部回归案例。无 supervisor 时 exec 失败仍需手动重启，不是自动恢复。保留当前 main 的 CI checkout 重建和全部既有案例，仅增量接入 Trust。新 build/type、受影响测试、几何及完整三 profile Trust 重启均待执行。后续 sidecar 轮询改动还需单独通过原真实文件系统及 live 刷新验证。下述历史结果不授予本组合产物资格。

固定 `main90be` 上的有限构建与受影响测试已完成：七个 whole 共 176 项以及 build/type/full lint/format/bundle 通过。公开 signal 验收仍为部分完成，5 通过、1 失败。既有真实文件系统失败及 native 首次提示 bug 仍开；两项 terminal 42 回退回归已通过。本候选供维护者 Draft 审查。这是 signal、relaunch 和 worktree sidecar watcher 共享最终退出意图的有限接线，不证明退出链已完整覆盖或必定成功。它不修复 Bun exec 后的启动，也不定位 native 锁。原独立退出增量不包含 Trust 界面、Source、Width、Skill 或诊断日志。

## 既有策略与所有权

既有公开 Core prepareFileWatchersForProcessExit 在 Darwin 标记最终进程退出。该状态下 closeFileWatcher 移除 change/all 监听，资源留待进程退出回收；其他情况正常 close。Core 实现、阈值及 API 不改。标记属于进程全局，直到成功 exec 或进程退出前均保持 sticky。这些调用者意图最终退出，但错误可能阻止终止，所选 exec 失败 terminal 42 路径已有控制回归覆盖；catch 之外的其他错误不因此获得新的终止保证。worktree watcher 仍归选中 Config/session 及既有 sidecar 目录所有，不新增其他 runtime 或文件系统 fallback。

## 改动与消费者

交互 signal 共享 beginExit 在 cleanupStarted 锁存后、runExitCleanup 前仅调用一次 prepare。首次未确认 SIGINT 和忽略的重抛不 prepare；确认 SIGINT、SIGTERM、SIGHUP 仍为 130/143/129。raw 恢复、重复 signal 处理及清理顺序不变。handler 仍在交互启动安装，既有 ACP 最终退出 prepare 不动。

relaunchApp 在 cleanup 前 prepare，保留原 execve 参数，以及未选择 execve 时的 exit 42 回退。清理后的有界预检与 catch 仅覆盖已知不可用 launcher 及可捕获 JavaScript 异常，通过既有不抛错 stderr helper 尽力报告后以代码 42 退出；原生系统调用失败并非通常可捕获。不重试、不 spawn supervisor，不声称重启成功；无 supervisor 时用户必须手动重启。prepare、cleanup 及原 re-exec 参数不变，cleanup 错误不在此 catch 范围。当前 main 调用者是 Ink TrustDialog、FolderTrustDialog、IdeTrustChangeDialog 和 native folder-trust-gate；原独立退出增量不新增 native Trust 功能；当前组合还包含另份设计所述 Trust 路由。原独立 worktree hook 增量将 watcher.close 换成公开 closeFileWatcher。当前新组合改用精确文件 stat 轮询及 listener 专属 unwatchFile，详见[sidecar 轮询](2026-11-15-worktree-sidecar-polling.zh-CN.md)；本 hook 不再创建目录 FSWatcher。消费者仍为 AppContainer 和 native AppShell。signal/relaunch 准备政策及下述历史验证不变，但不能授予新订阅实现资格。

## 证据与验证

Signal 已有 Dab RED 54840 及 whole 146 项通过 验证 48753，两个原 baseline 文件与 `90be` 逐字节相同，但不继承通过结果。hook 已有真实公开策略控制后的 RED 89259：普通对照通过、最终退出 raw close 违反策略。Root 现已真实复现原 relaunch 实现对新增顺序断言失败：prepare 预期 1、实际 0。这取代此前仅静态证据状态，后续受影响验证覆盖所选 terminal 42 实现，但不表示整应用或全部出口验收。

Root 已完成当前回退候选的 build、type、full 零 warning lint、format 和 bundle，七个 whole 共 176 项通过。两项新控制案例核单次 prepare/cleanup/exec、保留参数、尽力错误报告，以及 stderr.write 抛错也 exit 42。既有公开策略测试保留普通/替换 watcher 关闭和最终退出行为；这些检查不证明 native close 耗时、全部平台或 exec 后启动成功。

本回退提案之前的接线候选，Root 已完成 build、type、格式、六个改动源码/测试文件零 warning lint、bundle 及六整文件 168 项通过。独立真实文件系统 hook 文件仍在原 2 秒期限内删除/clear 断言失败：3 通过、1 失败、bail 后 1 未执行。受控 execve 抛错见证通过，确认 reject、未调用 process.exit、prepared watcher 策略仍保持；这是回退前缺口的证据，不是本回退的新验证或批准。没有重试或放宽断言。

当前未加日志的公开 signal 矩阵为 5 通过、1 失败、0 未执行：Node+Ink 和 Bun+Ink 均通过确认 SIGINT exit 130/signal 0 及 SIGTERM exit 143/signal 0；Bun+OpenTUI 通过 SIGTERM exit 143/signal 0。Native SIGINT 在原 1 秒首次提示期限失败，当时只发一个 signal，未发送第二个 SIGINT，清理前也无退出。之后 helper 清理的 exit 129 不是成功。六案均观测 0 model HTTP。

独立干净 `90be` 基线也在 1 秒、仅一个 SIGINT 后实际一次复现该首次提示失败；无第二个 signal 及清理前退出，之后 signal 9 清理并有 grace error。因此症状已存在于未改基线，并非只在本 patch 出现。这不抹去原候选失败，也不证明时序或根因相同。独立带日志诊断通过不能替代任一未加日志失败。真实文件系统 3 通过 / 1 失败 / 1 未执行结果继续独立保留。

## 边界

不加 flag、期限、重试，不改 Core、默认或发布。既有 2 秒/5 秒清理上限及首次 SIGINT 仅警告语义保留。此前独立的六个 code/test blob 已完成受影响验证与独审；其出版过渡仅更新那两个设计文档。Root 须完成文档格式、引用和精确 tree/readback 守卫后再提交 Draft；Draft 审查不授予 Ready、可发布或整体迁移验收。

本增量未覆盖其他最终退出路径：update relaunch、supervisor 断连、确实最终退出的错误 helper、fatal-render 期限及部分 headless/非法调用路径仍需各自检查所有权与失败语义。一些错误分支仅 rethrow 而不保证进程终止，不能无差别写全局标记。既有 ACP 最终 prepare 不是新推断的缺口。不宣称全部出口覆盖或 Core 全局置信。

## 已选择的 exec 失败回退（回归已验证）

原控制见证保留为 baseline 证据：确认在 exit 42 前 reject 及 final 策略残留。已实现回退的两项控制回归均通过：可捕获 JavaScript exec 异常后恰一次 terminal 42，即使 stderr.write 抛错，也只 prepare、cleanup、exec 各一次。关闭输出流可能使报告丢失，但不得阻止退出。这是终止行为，不是 UI 恢复、重启成功、Bun 启动修复或最终验收。Root 依据真实 70928 见证应用最小回退；该见证已证实不应发生的 reject/未退出行为。独立 expected 42 探针 83181 因收集范围与子进程 receipt 未建立而 AUDITOR_NQ，不是 RED。两项新增回归均包含在 176 项受影响验证通过之中；不宣称真实进程重启成功或修复 native 首提示 bug。Draft 与维护者审查门槛保留。
