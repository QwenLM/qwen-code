# OpenTUI 会话重放与回滚

[English](./2026-10-21-opentui-session-replay.md)

## 范围

基于 [#15283](https://github.com/QwenLM/qwen-code/pull/15283) 的完整交互所有权批次。恢复、重放和回滚复用既有记录历史、命令 host 与会话生命周期。保留此前取消、prepared Retry、shell 所有权、输入召回和退出行为。本设计定义完整批次；精确源码、产物与运行时的实际结果记录在该 PR 的验证报告中。

## 当前缺口与受影响层

本批之前，恢复后的显示和命令历史可能使用不同投影，OpenTUI rewind 缺少完整事务，普通 native 工具结果可能已发送给模型却未记入日志。改动限于 CLI 历史转换/投影、live turn 与命令 host、启动/logger 生命周期、native 结果 consumer、rewind selector 及共享 Ink 回滚事务，以及对应同目录和交互测试。不需要改变 core schema、运行时 launcher 或依赖。

## 重放与启动

恢复启动须先加入既有 Config 初始化 flight，再读取工具元数据，并重新读取 recording 激活后安装的权威恢复会话。新会话保持提前绘制；初始化失败保持既有清理及回退行为。

完整记录行经过既有 projector，文本、图像和工具 fanout 保留原 source identity；host 更新行时在原位置替换对应 transcript。零可见行保持隐藏，不能从格式化字符串合成残缺历史。host 与可见 transcript 使用同一启动 canonical 快照。展开只显示被抑制的行，不丢弃运行中的 turn 或结构化队列。

## 回滚所有权

两种 renderer 复用既有共享回滚事务，处理 API 历史、可见历史及文件回滚。真实内置 slash rewind 可以在自身命令造成的临时 responding 状态打开 selector；其他模型、shell 或同名替代命令不能借用该例外。保留 prompt identity、代码/会话/两者选项、文件失败及过期后继检查。

共享事务时保留 main 按原始身份回滚的契约：通过 `promptId` 或仅限会话的 `rewindId` 独立定位录制边界，按检查点的实际关联保留快照，不能按可见行数截取。录制边界缺失或检查点关联有歧义时，在改变文件或会话前拒绝。禁用录制仍可回退会话；恢复出的旧身份永远不能授权文件回退。Native 回退通过既有 canonical 历史行传递恢复出的键，两种 selector 都只提供具备身份的回合。这里只将上游已有修复承接到提取后的事务，不新增另一套回滚权威。

OpenTUI selector 消费真实可用区域。缩放、极小区域、窄到无法辨认的标签不能提交不可见目标。待完成恢复保持单一 owner；只有已提交回滚仍为当前 owner 才恢复 draft。恢复图像与 typed-file 显示使用原用户形式和已保存模型上下文，不能重新读取已变文件。

## 普通 native 日志

每个普通模型/native 工具的最终响应只记录一次，保留真实状态、显示、输出元数据及既有 Goal provenance。Mod 最终响应走同一路径，不再额外重复记录。旧 turn/session 不能向后继发布结果。这修复 issue #15326 涉及的 native 持久化 consumer；D 已加入的 retry/fallback pending 请求清理保持不变。

## 延后的 checkpoint 权威链

本批不加入 checkpoint 创建、完整 native snapshot getter、checkpoint writer、restore-response binding、前置 Read 权限或 durable restore branch 发布。这些保留为完整 AB 后继。本批 replay source retention 有真实 replay/host 消费者，不是新增共享框架或无人设置的 checkpoint option。

## 验收

在抽取后的实际基座执行正常 build/typecheck 与完整受影响 package 测试文件。Node+Ink、Bun+Ink 和 strict OpenTUI 执行既有专用会话 suite：保留 D 原案，加入图像/typed-file 冷恢复。实测 rewind 会话/API/文件边界与过期取消、selector 缩放/窄标签、权威启动元数据，以及普通 native 工具在自然退出和同会话冷重放前的真实日志结果。保全 aggregate 的证据不能代替本候选验收。安装/平台及完整 checkpoint 热/冷恢复仍是独立门禁。
