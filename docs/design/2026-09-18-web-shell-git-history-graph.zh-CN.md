# Web Shell 提交历史：泳道图与搜索

[English](2026-09-18-web-shell-git-history-graph.md) | [简体中文](2026-09-18-web-shell-git-history-graph.zh-CN.md)

状态：已实现。属于 [#11941](https://github.com/QwenLM/qwen-code/issues/11941)；同一 issue 中的 worktree 管理器是独立设计。

## 问题

Web Shell 的历史标签页把 `HEAD` 可达的提交列成一条扁平列表。合并提交有标记，但分支结构不可见；其它分支上的提交不切换检出就看不到；除了滚动之外，没有办法按提交信息、作者或哈希找到某个提交。

## 现状

- `GET /workspaces/:workspace/git/log` 接受 `limit`、`skip` 和单个 `range`；`packages/core/src/utils/gitDiff.ts` 中的 `fetchGitLog` 拒绝以 `-` 或 `..` 开头的 `range`，因此多 ref 参数无法借道传入。
- 响应已为每条记录携带 `parents` 与 `refs`。
- `packages/web-shell/client/components/dialogs/GitLogDialog.tsx` 中的 `GitLogContent` 渲染列表，并作为 `GitDialog` 的 `log` 标签页嵌入。

## 目标

- 把提交历史画成泳道图：每条并行的开发线一列，分叉与合并处用曲线连接。
- 允许用户把遍历范围从 `HEAD` 扩大到所有本地分支、远程分支和标签。
- 在同一标签页内按提交信息、作者或哈希过滤历史。
- 在分支 chip 上、紧邻现有的「查看变更」和「提交」动作旁打开历史。

## 非目标

- 不渲染 daemon 遍历未返回的提交（客户端不会在已加载页面之外重建图）。
- 不新增 daemon 路由；现有 log 路由只增加两个可选查询参数。
- 不改动提交详情接口和 diff 标签页。

## 设计

### Daemon 与 core

`fetchGitLog` 新增两个选项：

- `all`：遍历 `HEAD --branches --tags --remotes` 而非仅 `HEAD`。stash、notes、replace ref 仍被排除。
- `search`：大小写不敏感的固定字符串过滤。git 对 `--grep` 与 `--author` 取 AND，因此信息匹配与作者匹配是两次遍历，取并集后分页；4 到 40 位十六进制查询还会经 `git rev-parse --verify <query>^{commit}` 按提交哈希前缀解析。并集按作者日期排序，作者日期与提交日期不一致时页边界可能偏移一条；客户端按 sha 去重。

所有遍历现在都带 `--date-order`，父提交绝不早于其任何子提交出现，泳道布局只需要 `parents`。路由读取 `all=1` 与 `search=<text>`（去空白、上限 200 字符）。SDK 在绑定工作区与限定工作区两个客户端的 `workspaceGitLog` 上以尾部 `options` 参数暴露它们。

### 泳道布局

`packages/web-shell/client/utils/commitGraph.ts` 中的 `layoutCommitGraph` 是对遍历顺序的 `{ sha, parents }[]` 的纯函数。每条泳道等待一个提交：

- 提交占用等待它的最低泳道；没有则开一条新泳道。其它等待同一提交的泳道都汇入该节点。
- 第一父提交延续该泳道；若已有别的泳道在等待这个父提交，则线条并入那条泳道而不是并行下去。
- 其余每个父提交占用已在等待它的泳道，或新开一条。

每次翻页后都对累积的整份列表重新布局，分页不会打断泳道。搜索结果不是连续历史，查询激活期间隐藏图。

### 渲染

每一行绘制自己的 SVG 并拉伸到行高（`preserveAspectRatio="none"`）：穿行泳道画成竖线，进入和离开的换道画成 S 形曲线，节点是定位的圆点（合并提交为空心）。展开的行在其详情块中把仍然打开的泳道直线画穿，线条不会断。泳道颜色循环使用固定的 8 色调色板；第 20 条之后的泳道共用最后一列，繁忙的全部分支视图不会把标题挤出去。

### 工具栏与入口

历史标签页增加一条工具栏：搜索框（300 ms 防抖）和「全部分支」开关。两者都从偏移 0 重新拉取。`BranchPickerPopover` 增加 `onOpenLog` 动作，渲染为「提交历史」，位于「查看变更」旁；`ChatEditor` 与 `EnvironmentPanel` 从 `App` 透传，`App` 以 `log` 视图打开 `GitDialog`，有会话 worktree 时带上其 cwd。

## 约束

- `range`、`all`、`search` 可组合：`all` 优先于 `range`；`search` 过滤前两者选定的遍历。
- 哈希前缀命中即使不在所选遍历可达范围内也会返回；用户明确要的就是那个提交。
- 图列硬上限 20 条泳道。有数百个未合并分支尖端的仓库会把溢出画在最后一条泳道里，而不是撑宽对话框。

## 验证

- `packages/core/src/utils/gitDiff.test.ts`：`all` 遍历到侧分支和标签，不安全的 `range` 被忽略，搜索对信息、作者、哈希取并集且按固定字符串匹配，搜索分页带 `hasMore`。
- `packages/cli/src/serve/routes/workspace-git-log.test.ts`：路由透传 `all` 与 `search`。
- `packages/web-shell/client/utils/commitGraph.test.ts`：线性历史、合并泳道、泳道复用、未见父提交的新泳道。
- `packages/web-shell/client/components/dialogs/GitLogDialog.test.tsx`：开关与搜索以正确选项重新拉取，匹配结果隐藏图，合并布局为两列且泳道穿过展开行。
- `packages/web-shell/client/components/BranchPickerPopover.test.tsx`：「提交历史」条目回调并关闭。

## 验收标准

- 历史标签页默认在当前分支上，每个提交一个节点，每处分叉与合并有曲线。
- 「全部分支」列出所有分支和标签上的提交并带 ref 标签。
- 在搜索框输入后列表收窄为信息、作者或哈希匹配的提交，清空后恢复完整历史。
- 分支 chip 提供「提交历史」并打开该标签页。
