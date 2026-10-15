# Web Shell 侧边栏中的渠道会话

[English](2026-08-03-web-shell-channel-session-sidebar.md) | [简体中文](2026-08-03-web-shell-channel-session-sidebar.zh-CN.md)

## 动机

daemon 管理的渠道会创建 `sourceType: "channel"` 的普通工作空间会话，但 Web Shell
侧边栏有意只请求 `default` 会话目录。因此，即使钉钉、飞书或其他渠道发起的会话
已经存储在选中的工作空间中，也无法从侧边栏打开。

## 设计

在侧边栏的项目会话列表上方增加包含两个选项的来源切换控件：

- **Tasks** 请求 `sourceType: "default"`，并保持为初始选项。daemon 目录包含
  default、旧版无来源会话和 `qwen-live` 会话。定时任务运行会话（`sourceType: 'default'`
  且 `sourceId` 以 `scheduled_task_run:` 开头）放入专用分组。绑定的控制会话使用
  `sourceType: 'scheduled_task'`，不属于这个目录。
- **Channels** 列出 `sourceType: "channel"` 的会话。

只有 daemon 声明支持 `session_source_metadata` 时才显示切换控件。较旧的 daemon
继续使用现有的未过滤请求，不展示其无法支持的控件。

所选来源一致应用于活动、置顶、归档和次要工作空间的会话请求。复用现有会话行、
工作空间区块、分组、搜索、轮询和打开会话操作。渠道会话可以由外部消息创建，
而不触发 Web Shell 变更事件，因此展开的 Channels 列表使用活动会话轮询间隔，
而非 30 秒的空闲间隔。

当所选工作空间还声明支持 `channel_management` 时，Channels 目录使用每个会话
不可变的渠道实例名称（`sourceId`）关联当前渠道配置，并按 `config.type` 分组。
类型目录提供平台标签，使同一平台的多个实例共用一个可折叠区块。实例已不存在的
会话仍显示在 Other channels 下。如果目录不可用，列表保留现有回退行为，不隐藏
会话。在 Channels 视图中，渠道类型分组优先于用户自定义会话分组；Tasks 保留现有
组织行为。次要工作空间解析其自身工作空间范围内的渠道目录。

渠道适配器仍会在消息前附加面向模型的指令和上下文历史。daemon 提示请求通过单独的
转录显示元数据携带用户撰写的文本，因此实时和回放的 Web Shell 消息均不会暴露这些
隐藏上下文，渠道会话标题也由相同的可见文本生成。

## 边界

- 渠道配置和运行时管理不变。
- 持久化的会话来源元数据不变。daemon 的公共 `default` 过滤器现在也匹配
  `qwen-live`；其他来源过滤器仍精确匹配，显式指定的 `sourceId` 仍在所选目录内
  进行精确限制。内部 Conversations 过滤器不变。
- Session Overview、Split View 选择器，以及工作空间的会话总数、运行数和待处理数
  共用扩展后的默认目录，其中包含 `qwen-live`。定时任务资格判断不变。Web Shell 对
  `qwen-live` 侧栏行隐藏删除和归档操作，并将其排除在删除选择器之外。Session Overview 也禁用
  这些任务的单行和批量删除、归档。仍可打开任务
  或显式释放其运行时。来源元数据只用于归属，不是 daemon 授权依据；REST 和 ACP
  变更保留内置 Live 通话保护，可以终止外部 Live 任务。
- 切换选项保存在内存中的 UI 状态里，页面重新加载后重置为 Tasks。
- 渠道类型分类反映工作空间当前配置；会话不持久化历史平台类型。

## 验证

- 断言来源切换控件受 `session_source_metadata` 能力控制。
- 断言初始选中 Tasks，且请求 `sourceType: "default"`。
- 断言选择 Channels 后，主工作空间列表和工作空间限定列表均请求
  `sourceType: "channel"`。
- 断言 Channels 列表按活动会话间隔轮询。
- 断言同一平台的多个实例共用一个可折叠类型区块，其他平台会话仍分开展示，置顶会话
  保留在所属类型区块内，无法匹配的会话保留在 Other channels 下。
- 断言渠道提示请求保留完整模型上下文，同时只记录用户撰写的文本用于转录显示。
- 运行侧边栏和工作空间区块单元测试、Web Shell 构建以及 TypeScript 类型检查。
