# Hosted Java OSS capture 准入接线

[English](2026-10-13-hosted-oss-capture-wiring.md) | [简体中文](2026-10-13-hosted-oss-capture-wiring.zh-CN.md)

状态：已实现。历史真实 bucket 验收基于 `main` commit `ec37cec0f3a44c6928a23498de6dd845e3852823` 加本改动，在单 Linux 主机上完成，未使用 admission relay。Rebase 后的验证结果在下文单独记录。

## 问题与当前行为

Hosted Harness 的私有创建请求已经接受 `captureBytes`。对于 Shell profile，该字段选择 remote tool-publication producer，通过 Java 与 OSS 持久保存输出；省略时选择现有内联 producer。本改动之前，Java SDK 创建请求与 Java connector 均未传该字段，即使启用 `qwen.managed-agent.tool-publication.enabled=true`。

真实 bucket 验收复现了缺口：Shell 执行与取消已结算，但没有 publication 记录，公开工具结果投影为 `UNSUPPORTED / unsupported_receipt_producer`。测试用可信 admission relay 加入 1 MiB 预算后，现有 OSS 发布、公开下载、关闭和回收链路通过。本改动使该转发层不再成为必要条件。

## 改动方案

在 Java SDK `CreateHarnessSession` 中新增可选的 `captureBytes(long)` builder 字段，仅在调用方提供时序列化，拒绝 Harness 合同闭区间 1 至 `2^41` 之外的值。已有 SDK 请求保持原格式。

对于已解析的 `hosted-workspace-shell/1`、`/2` 与现有内部 `hosted-workspace-team-lead/1` Shell-family Session，Java connector 在启用 tool-publication 时传入 `qwen.managed-agent.tool-publication.execution-bytes`。这是现有原始 capture 上限，不增加配置键或默认值。Files、MCP 和无工具 profile 均省略该字段。AgentDefinition 保持其已解析 profile 和审批模式；公共 Shell 的 child-agent 抑制仍是独立条件，内部 team-lead profile 保持现有工具与准入规则。

`execution-bytes` 只覆盖原始 capture。Publication 会另将 producer 与 admission 开销计入现有 Session/tenant 配额；部署方须给这些开销与已保留 publication 留出聚合容量。本改动不自动压低预算或绕过配额拒绝。

## 恢复与边界

Harness 将选定预算持久保存到 managed Session definition。Java load 请求继续省略当前部署预算，使常驻与冷加载恢复原 definition。显式冲突预算仍由 Harness 拒绝。已有内联 Session 在配置改变后仍保持内联，新建 Session 才选择已启用的 producer。

不新增路由、公开 API 请求字段、schema、凭证传递或 Runtime fallback。Tool-publication 仍默认关闭；公开原始 artifact 与垃圾回收保持各自独立开关。云凭证由 Java 现有 OSS client 使用，不加入 Harness 请求。

现有依赖 publication 的 Monitor 与后台路径继续遵守其准入、审批与 Linux cgroup 委派要求。启用 publication 的生命周期测试现使用前台 Shell，通过内存 OSS 装置验证不可变对象字节与回收。Remote-publication 装置验证前台生命周期行为，没有为已启用的 Monitor/后台准入配置所需的 Linux cgroup 委派；这些已启用路径需要单独验收。关闭 publication 的审批测试保留原有 Monitor 与后台命令拒绝断言。

四种进程恢复故障场景也使用 remote producer，配置 1 MiB 原始预算及 1 GiB 聚合容量。测试专用对象存储在本次装置根目录下保存不可变文件，使字节能够跨 Spring SIGKILL/重启场景保留。测试读取当前 publication catalog，在删除前验证原始输出长度和 SHA-256，删除后要求 SQL 回收状态和对象物理消失同时成立。原有 writer、claim、binding generation、drain receipt、worker 退出、副作用恰好一次及 companion Session 断言均保留。存储注册前，装置保留 main 的确定性初始化根目录 mtime 准备，使其与真实 Linux birth time 不同；生产身份读取器及其防歧义校验继承 main。

## 验证与验收

- SDK HTTP 测试覆盖省略、最小/最大值、常用 1 MiB 预算及非法边界。
- Connector 测试覆盖 Shell `/1` 与 `/2` 的 publication 启用/关闭、非 Shell profile、create 冲突后 load、配置漂移，以及恢复 load 不传当前预算。
- 现有 Harness 合同测试验证原预算恢复及显式冲突 load。相关 SDK/server 测试、完整仓库 build/typecheck/bundle 和静态检查均须通过。
- Linux 验收使用用户指定的 `oauth-data-govermence` profile、北京 `cn-beijing` 的私有无版本控制 bucket `qwencode-test`、独立 MySQL schema，以及不含 admission relay 的生产 Java 创建路径。设置 `execution-bytes=1048576`，聚合容量为额外开销留足空间。
- 要求真实 OSS 输出记录、公开 REST/WebShell metadata 及完整/范围字节一致、取消、同 Session 下一个 Shell/Read Turn、worker 物理关闭、关闭后下载与仅回收本次对象的生产 GC。读回测试前缀为空并恢复环境。

验收范围为受控模型、单 Linux 主机与指定 bucket。本接线不新增跨主机恢复、真实模型服务、完整 O4 权限故障矩阵或 100 MiB/1 GiB 负载门禁。

## 历史真实 bucket 验证结果

- macOS build、typecheck 与 bundle 通过；SDK 75 个测试、server 115 个测试、选定的 Harness 恢复合同 11 个用例通过，Checkstyle 违规与 SpotBugs finding 均为零。
- Linux build、使用 6 GiB Node 堆的 typecheck、bundle、同一组 SDK/server 测试与静态检查在 Ubuntu 26.04 arm64、Node 22.22.1、Java 21.0.12.1、MySQL 8.4.11 上通过。公开 Workspace 集成测试 8 个用例全部通过，无跳过。
- 真实 OSS 验收确认 Java 直连 Harness，保存的 definition 与 grant 预算均为 1 MiB，产生 2 个 publication、4 个公开原始输出 Artifact、8 个唯一对象，共 1,201,297 字节。完整/范围下载、取消、下一个 Shell/Read Turn、worker 物理关闭及关闭后下载通过。公开 DELETE 回收两个 publication 并删除全部 8 个对象；独立 CLI 列举确认本次专属前缀对象数为零。
- 预算恢复与冲突 load 在 Java 请求层及现有 Harness 合同层完成验证。本改动未新增真实部署预算切换或 VM 重启验收。

## Rebase 后回归验证

本改动已 rebase 到包含当前持久化 catalog 的 `main` commit `bb9d7957991ef93761bfbbb9c93806a0701b4e47`。macOS 与 Linux 的 build/typecheck/bundle、75 个 SDK 测试、118 个 server 测试、Checkstyle 与 SpotBugs 均通过；macOS 上选定的 11 个 Harness 恢复合同用例通过。最终原生 Linux 门禁使用新的 MySQL 8.4 schema，选定的 16 个用例全部通过、无跳过：四种进程恢复故障、全部 11 个公开 Workspace 用例，以及内部覆盖四种故障的共用输出探针调用路径。四个原 worker 均退出、binding 均释放，副作用保持恰好一次，publication 状态及对象物理回收均已验证；companion Session 保持 active。

回归装置将 canonical storage alias 解析为物理 owner，并将远程 manifest 身份与 `deferred_v3` reference 的前缀 `argsDigest` 比较。公开装置在模型/relay listener 绑定期间同时预留各服务端口。Spring 重启后，现有 retirement-ledger 扫描与 capture-GC 重试各自可能需要一分钟；进程装置为回收提供有界的 150 秒等待，保持总体 240 秒超时及全部物理断言。这些都是测试适配，生产身份校验与调度保持不变；此前失败运行单独保留。

本次新门禁使用本地测试对象存储。上文历史真实 bucket、公开下载及取消证据没有在本次 rebase 后的持久化基线上重跑。完整 GitHub CI、新的云验收、已启用 Monitor/后台的 cgroup、VM 重启及跨主机恢复仍是独立验证边界。

## 当前 main rebase

当前源码已 rebase 到包含 #14131 Hosted 装置修复的 `main` commit `97fb4a547d`。Main 的 canonical alias 到 physical owner 查询替代本 PR 等价的共用 probe 改动，根目录准备替代之前的 sentinel 文件。公开装置端口预留、跨重启不可变对象、原始 capture 预算、物理回收及原围栏断言均保留，生产 capture 补丁不变。

在该基线上，macOS 与 Linux 各自通过完整仓库 build/typecheck/bundle、75 个 SDK 测试、118 个 server 测试、零违规的 Checkstyle 和零 finding 的 SpotBugs。macOS 上选定的 11 个 Harness 恢复合同用例通过。原生 Linux 使用新的 MySQL schema，28 个用例全部通过，失败、错误及跳过均为零：四种 Shell 生命周期恢复故障、11 个公开 Workspace 用例、9 个 Workspace 工具轮次用例、3 个内部 TeamLead 用例及内部覆盖六种故障的 1 个进程崩溃用例。其中包含此前 main 失败的七个装置用例。四种生命周期故障均验证原 worker 退出证明、binding 释放、副作用恰好一次、publication 回收及对象物理消失，同时 companion Session 保持 active。测试使用安装到隔离 Maven 缓存的当前 SDK/runtime-broker 产物。

本次门禁使用本地测试对象存储。历史云证据和此前 GitHub CI 结果仍仅对应各自记录的版本；新的云验收及新 head 的完整 CI 是独立门禁。
