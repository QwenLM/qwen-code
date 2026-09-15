# Web Shell 会话来源过滤

[English](web-shell-session-source-filter.md) | [简体中文](web-shell-session-source-filter.zh-CN.md)

## 问题

目前创建 Web Shell 会话时不携带来源元数据，所有会话列表请求也都不进行过滤。
因此，定时任务等其他功能创建的会话也会出现在 Web Shell 中。已有 Web Shell
会话同样缺少来源元数据，如果仅按来源精确匹配，就会隐藏历史数据。

## 设计

- 每个新建 Web Shell 会话都携带 `sourceType: 'default'`。
- Sidebar 的 Tasks 目录、Session Overview、Split View 选择器，以及工作空间的
  会话总数、运行数和待处理数，都使用 `sourceType: 'default'`。
- daemon 的公共 `sourceType=default` 过滤器包含 `sourceType: 'default'`、
  未设置 `sourceType` 的会话，以及 `qwen-live` 会话。其他来源过滤器仍然精确匹配。
  显式指定 `sourceId` 时，会在所选目录内进一步按标识符精确过滤。
- Sidebar 将定时任务运行会话（`sourceType: 'default'` 且 `sourceId` 以
  `scheduled_task_run:` 开头）放入专用分组。绑定的控制会话使用
  `sourceType: 'scheduled_task'`，不属于默认目录。
- 在支持组织结构的会话视图中提供来源过滤，避免过滤使分组、置顶或归档会话行为失效。
- 将组织视图的分页游标绑定到生成该游标时使用的来源过滤器。

## 兼容性

`default` 过滤器包含缺少来源元数据的会话，因此旧会话仍然可见。扩展后的目录统一
适用于 Sidebar 的 Tasks 视图、Session Overview、Split View 选择器和工作空间统计，
包括 `qwen-live` 会话的待处理数。持久化的来源元数据、定时任务资格判断、精确的
`channel` 过滤器，以及内部 Conversations 过滤器均保持不变。省略 `sourceType`
的调用方仍获得未过滤的结果。

Web Shell 对 `qwen-live` 侧栏行隐藏删除和归档操作，并将这些任务排除在永久删除
选择器之外。Session Overview 也禁用这些任务的单行和批量删除、归档。用户仍可打开任务，也可通过 Release 对话框显式释放其运行时。
这是 UI 策略，不是授权边界：客户端声明的来源元数据不授予 daemon 变更保护。
显式 REST 和 ACP close、delete、archive 保持既有行为，包括保护内置活动 Live
通话拥有的会话。外部客户端仍负责自身任务生命周期；这些 API 调用可以终止其工作。
