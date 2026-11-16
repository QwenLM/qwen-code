# 可配置的 Conversations 工作目录根路径

[English](conversations-working-directory-root.md) | [简体中文](conversations-working-directory-root.zh-CN.md)

## 状态与问题

这是 [#15298](https://github.com/QwenLM/qwen-code/issues/15298) 的本地实现设计，
基于 main `9dde2f657d3dfc9183bbe5534efcbaa39564758d`。自动 triage 建议进入探索阶段；
维护者尚未批准具体接口。

容器部署需要独立于操作系统 home 的持久化工作文件位置。现有根路径是
`<home>/Documents/Qwen Code/Conversations`。在该位置挂卷或调整进程 home 都是
有效替代方案。`QWEN_HOME`、`QWEN_RUNTIME_DIR` 和 `advanced.runtimeOutputDir`
不负责选择这个工作根目录。

## 配置与生命周期

提供 `QWEN_CONVERSATIONS_DIR`，并为 `qwen serve` 和 `qwen daemon start` 增加
`--conversations-dir` 参数。嵌入调用者通过 `ServeOptions.conversationsDir` 使用
同样的启动方配置。选择顺序为：

1. 显式 CLI/API 参数。
2. 启动环境或用户级 `.env` 中的 `QWEN_CONVERSATIONS_DIR`。
3. 现有基于 home 的默认路径。

沿用现有项目环境变量硬编码排除规则，在项目 `.env`、所有作用域的 `settings.env`
以及环境重载时拒绝此键。不增加项目设置或浏览器/会话请求字段。在 daemon 启动时
解析一次选定路径，传给现有 `ConversationWorkspace`。后续环境重载不能重定向该对象。

显式值必须是非空、不含 NUL 的完全限定绝对文件路径。拒绝相对路径、未展开的 `~`
以及依赖当前驱动器的 Windows 路径，并给出明确配置错误。不裁剪路径字符串，也不在
无效时静默回退。高优先级来源胜出；有效 CLI 参数可以覆盖无效环境变量。

监听前检查路径语法。显式路径和默认路径的目录创建及文件系统身份接受都保持惰性。
未使用 Conversations 的 daemon 不应创建默认目录树。首次使用时的既有文件系统
失败仍是错误，不得改选其他根目录。

## Runtime 与存储契约

Standalone 和 Live 继续使用同一个 daemon 所有的 Conversations runtime 和共享
ACP 子进程。仅改变根目录选择。每个会话继续将确定性的
`conversation-<sha256(normalized session ID)>` 直接子目录用作工具/shell cwd。
ACP 重定位已经使用 daemon 选定的根目录与固定身份，不需要新 ACP 参数或 core 存储策略。

保留根目录/子目录所有者、POSIX 私有权限、规范身份、可用的 device/inode 检查、
直接子目录和 link/reparse 检查、writer lease 及删除恢复机制。保留已记录的 Windows
和 inode 可验证性限制。现有检查继续禁止普通工作区注册使用选定目录树；不增加
一般工作区根目录限制，也不声称提供操作系统级隔离。

| 数据                  | 位置与职责                                                                          |
| --------------------- | ----------------------------------------------------------------------------------- |
| 会话工作文件          | 选定 Conversations 根目录的私有子目录                                               |
| 共享根配置            | 选定根目录下的用户编写配置，不是会话私有配置                                        |
| Transcript 和 sidecar | 按规范 Conversations runtime cwd 定位的现有 runtime-base 存储                       |
| 删除恢复日志          | 现有稳定的 `<home>/.qwen/conversations/deletions` 命名空间                          |
| Live 发现状态         | 现有稳定的 `<home>/.qwen/live/daemon.json`，以及适用时 daemon runtime base 下的副本 |

本选项不移动后三类数据，也不消除部署保存相关 home 恢复状态的需求。

## 启动与重启行为

保持普通 serve 解析和 serve fast path 一致。通过 `daemon start` 显式构造的 serve
参数列表传递新参数。仅使用环境变量的启动仍沿用正常进程继承。桌面启动器可以提供
环境变量；新增桌面设置不在范围内。

在本地 daemon 发现记录增加可选且经过验证的 `conversationsDir`，发布解析后的配置
路径，包括默认路径。`daemon restart` 通过 `daemon start --conversations-dir`
重放该路径，防止变化的 shell 环境静默选择新根目录。旧记录缺少此字段，沿用此前的
环境/默认路径解析行为。自动更新重启也必须保留选定根目录。记录保存的是配置路径，
不是跨重启 inode 证明；重启后仍执行正常文件系统接受检查。

有意重配置采用先 stop 再带新值 start；`daemon restart` 保留记录中的选择。继续使用
同一根目录时，保持 runtime base 和必要控制状态一致。更换根目录前，应针对原根目录
完成未结束的删除恢复，并停止所有使用该根目录的 writer。不得通过删除恢复证据强行
接受目录。如果原根目录恢复无法完成，更改此选项不能作为修复机制。

新的规范根目录会改变历史存储/发现与共享根配置。不自动迁移文件、会话记录、配置或
发现状态，也不承诺全部旧历史继续可见。未完成的既有 journal 遇到身份不匹配时继续
失败关闭。

## 涉及层次与验证

- Conversations 根目录解析、workspace 构造和 daemon 启动接线。
- Serve 类型、普通/快速 CLI 解析、daemon start/restart 与本地发现记录。
- 共享环境变量排除规则及两条加载路径的回归测试。
- 用户配置/serve 文档和相邻单元测试。

端到端计划位于 `.qwen/e2e-tests/conversations-working-directory-root.md`。使用隔离
的 home、配置、runtime 和工作目录。验证默认路径惰性、环境变量与 CLI 优先级、无效
输入、项目注入拒绝、standalone shell cwd 与文件、同根目录重启/历史、普通工作区
隔离，以及未改变的链接/权限/身份检查。现有共享 runtime 测试覆盖 Live/standalone
一致性。不带 prompt 的会话创建和 session-shell 测试无需真实模型调用。

运行仓库构建、类型检查、bundle、定向单元和端到端测试、格式/引用检查、两轮干净的
自审及独立审查。明确记录平台或运行时覆盖限制，不声称完成未执行的检查。当前环境
没有全局 `qwen`，基线测试必须记录此限制并改用未修改 checkout 的可执行入口。

## 范围与后续审阅事项

不包含迁移、可配置锁位置、目录浏览/创建 API、按会话选择、新工作区策略或 UI。
公开名称及受支持接口仍待维护者审阅。本设计选择启动时语法检查、惰性文件系统接受
和重启保留配置，作为具体可审阅行为。
