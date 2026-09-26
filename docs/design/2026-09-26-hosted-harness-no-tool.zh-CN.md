# Hosted Harness 无工具回合

[English](2026-09-26-hosted-harness-no-tool.md) | [简体中文](2026-09-26-hosted-harness-no-tool.zh-CN.md)

## 问题与范围

Spring 控制面已经能创建 Managed Session 并调用私有 Hosted Harness 客户端，但 `qwen serve --profile hosted-harness` 目前拒绝启动。本切片基于 #12693 的持久化 Managed Session 权威，打通一个仅含文本、无工具的端到端回合。本切片不启用 Runtime 工具、依赖审批的工作、worker 生命周期或自动崩溃恢复。

## 设计

- Java 控制面提供唯一的 RFC UUID Session ID 和限定 tenant/workspace 范围的私有存储连接。Hosted Harness 必须在 Session、transcript、Prompt 和事件流中使用同一 ID；不能产生第二个公开身份，也不能回退到 Legacy Session。存储服务认证仍是独立的部署门槛。
- 该 profile 要求 HTTP bridge 模式，仅绑定回环地址，要求 bearer token 和 capability digest，隐藏浏览器及普通 daemon 界面，并在开启监听前拒绝 channel、shell 和 WebSocket 隧道选项。其私有 API 服务于 Java 客户端；创建、加载和提交回合均需持有 bearer token。
- 打开 Session 时通过 #12693 的存储装配取得一个持久 writer 和 activation。已接受的 Prompt 保留调用方的 Prompt 身份和 payload digest。模型循环先记录输出，私有流随后才能公开；Java 沿现有的提交后链路持久化并转发事件。
- 本切片不附加 Runtime provider。工具调用或其他尚未支持的续接必须在任何本地工具副作用前失败关闭。无工具回合达到持久终态并保留可供重新加载的历史；attachment 持有 writer 和 activation，直到 detach 或 close。
- 初始化允许跳过无法构造的工具，因为该 profile 有意跳过了其依赖的子系统，并在推理前移除所有本地工具。失败或取消的回合仍保留在持久化 journal 中，但未得到回答的 Prompt 不再传给下一次模型请求。意外的回合失败会在 daemon 日志中记录原因，对外错误仍保持通用信息。
- 使用相同 Session 和 Prompt 身份的重试不得再次执行模型推理。payload 冲突、归属不确定、过期 generation、存储故障和不支持的工具都返回明确错误，不回退到 Legacy 或本地工具。

## 验证与验收

运行仓库构建与类型检查、定向 Managed Session 和 Hosted Harness 测试，以及使用 Java、MySQL 和真实 `qwen serve` 进程的测试。进程测试必须证明唯一 Session ID、成功的无工具文本回合、重连后的已提交事件回放，以及普通 daemon 行为不变。负例覆盖缺失认证、冲突的 Prompt 身份、存储失败、工具请求没有本地副作用。一个或多个回合失败或取消后，下一次模型请求必须包含新 Prompt 并保留已完成的对话历史，不重新提交未得到回答的 Prompt，包括失败回合之后已有成功回合的情况。本切片不宣称完成 #12380 的完整 Hosted Runtime 或崩溃恢复门槛。
