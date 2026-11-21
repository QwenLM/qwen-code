# macOS 上 Bun 的文件监听后端

[English](2026-11-16-bun-darwin-file-watchers.md) | [简体中文](2026-11-16-bun-darwin-file-watchers.zh-CN.md)

## 问题与状态

macOS 上的 Bun 1.4.4 在注册或关闭文件监听时可能阻塞 JavaScript 线程。保存的应用
CPU profile 含有原生 watch 注册调用栈；独立双 watcher 对照观测到一次同步注册约
305 ms。这些事实尚未定位应用 OS SIGINT 时限失败的原因，原失败保留。

精确 Bun 1.4.4 源码在 CF 线程重建 FSEvents stream 时持有共享注册表锁，注册和
移除也获取同一锁。本变更使用已有公开轮询 API，保持 Bun 1.4.4 与 OpenTUI 0.5.10。
实现尚待验证和维护者审查。

## 运行时策略与消费者

共享 `shouldPollFileWatchers()` 策略仅选择 macOS 上的 Bun。所有平台的 Node 和
Linux 上的 Bun 保留原后端，不新增用户开关或环境配置。

CLI settings、LSP 配置与 extension watcher 将策略结果作为 Chokidar 的
`usePolling`，包含 settings 与 extension 的 bootstrap watcher。原路径、忽略谓词、
事件分类、debounce、mutation suppression、代际检查和关闭逻辑保持。extension store
已有的 30 秒 generation 检查只是补充，不能替代内容热更新。

worktree sidecar hook 仅在选定运行时对精确 sidecar 路径使用 `fs.watchFile`，间隔
500 ms、`persistent: false`。保持原初始读取，允许文件不存在，并以精确 callback
退订。卸载后的 callback 不再启动新轮询读取；进行中的读取保留原取消检查。其它
运行时保留目录 watcher 及原目录替换限制。本后端变更不夹带独立 Common owner 状态修复。

Core Skills 与 file-change hooks 选择同一 Chokidar 后端，保持原 roots、depth、
排除规则、generation 与 abort 处理。reflog 订阅继续按解析后的 Git 目录在 UI branch
hook 和 workspace Git-state service 之间共享。Bun/macOS 以 500 ms 轮询已验证的
reflog 路径，保留原 persistent 订阅，直到最后一个订阅者或 cache cleanup 移除精确
callback。初始 symlink 拒绝与安全 HEAD 读取保留；之后的路径替换不具备原子 confinement
保证，stat 轮询可能跟随替换后的 symlink。
UI 保留原五秒 branch refresh 兜底；workspace Git-state service 没有对应的周期刷新。

Durable cron 以 500 ms、`persistent: false` 轮询精确 tasks 文件，保留原 debounce
和多 session owner。stop 拒绝排队的旧 callback，只移除自己的 listener。sidecar 与
cron 的轮询不持有进程 keepalive；共享 reflog 保留原 keepalive 策略。全部 Core 路径及其
下游 UI/service 消费者需要维护者审查。本设计不资格所有命令路径或真实生命周期。

## 成本与边界

轮询增加周期 stat 和通知延迟。Chokidar 保持原 interval、binary interval 默认值；
sidecar 沿用已有 Common 设计的 500 ms 合同。两次轮询之间的短暂变化可能合并或遗漏。
atomic replacement、创建、删除、symlink 和根目录恢复需逐消费者验证，不能假定完全
等价。FileChanged 逐条 FIFO 投递 hook 事件，不只是 latest-state snapshot。原写入稳定
过滤已抑制部分短命文件，但 polling 仍可能增加发现盲窗。维护者必须明确裁决该取舍
是否可接受，或该消费者是否应保留其它后端；默认 session 的 SIGINT 通过不能资格
hook 事件能力对等。原有 Chokidar 环境覆盖保持库定义的优先级；验收使用干净的默认环境。轮询设置
不改变原交互与退出时限。

## 验证与验收

执行受影响 settings、LSP、extension 与 worktree hook 的完整单文件测试，然后执行
正常 build、typecheck、lint、format 与 bundle。路由测试需覆盖策略两种结果、target/
bootstrap watcher 与未变的原生路径。sidecar 测试保留 session 换代、迟到读取、同路径
独立订阅、cleanup、sandbox 隔离、读取失败恢复，以及真实创建、删除与 atomic replacement。

使用 owned 真实文件系统及公开应用夹具验证新产物热更新与普通退出。历史失败或未资格
的生命周期和 OS SIGINT 观测保留。局部轮询通过不证明 FSEvents 根因、全平台稳定性或
完整迁移就绪；合并或宣称 production readiness 前，运行时策略与全部 Core 消费者均需
维护者审查。
