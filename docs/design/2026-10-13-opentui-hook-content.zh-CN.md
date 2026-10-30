# OpenTUI hooks 内容与区域预算（MYWO-3 / MYWO-13）

[English](2026-10-13-opentui-hook-content.md) | [简体中文](2026-10-13-opentui-hook-content.zh-CN.md)

## 状态与基线

作为[迁移交付方案](2026-10-20-opentui-migration-delivery.zh-CN.md)的 U1，在 main 基线 `2b5c4deadb9e9dd0d9d740a52ae42f28ad14bf92` 恢复本修复。候选验证与实现状态分别记录。

来源：[#14044](https://github.com/QwenLM/qwen-code/pull/14044)，提交 `10a98a72ee2c78323c902f7d01f2a05db371a5d0` 与 `7cb0a86fbf709da0da24f6acb0a14465e59b9c36`，作者为 gary.gq，合作作者为 multica-agent。该 PR 合并到了 `fix/MYWO-7-short-dialog-budgets`，没有进入 main。只恢复它相对 `e16490eccc5aeffbb680da7c0935b5aebfe82f1b` 的八文件差异，保留 main 后续变化。历史通过结果不代表本候选已验收。

## 复现

恢复的原生测试脚本在未修改的 main `2b5c4deadb`、Bun 1.4.0、OpenTUI 0.5.10 上失败：空 Hooks 页面在宽 20 / region 1 时向区域外多绘制五行边框。退出原因是业务断言，不是导入或编译失败。测试在此停止，这轮基线没有执行到详情与 Diff。

#14044 在旧 stacked base 上的历史观察：sandboxed Diff 在宽20时高12行，region1–6越界绘制；非sandboxed Diff能容纳。hooks detail 宽40时高102行，长literal头可见，中尾不可达，没有scrollbox。matchers也在region1–6越界。观察使用captureCharFrame和原生几何、mock键盘输入，非PTY。11列正文可达性仍属需要独立证据的限制。

## 决策

复用已有scrollDialogLayout预算，保留内容行，预算不足时隐藏可选chrome；sandboxed Diff与hooks共用策略。hooks详情用原生scrollbox限制高度，保留literal换行，把每个物理文本行独立渲染，使其可滚动，避开原生多行Text尾部限制。窄列付不起标签列时采用上下排列的标签和值。详情支持滚轮、方向/翻页键、Home/End；Esc保持逐级返回。Diff 聚焦既有 scrollbox，使原生键盘滚动能够到达 sandbox 提示尾部。viewport变化时重置详情滚动到头部，viewport不变时保留偏移与全部内容。列表保留选中项并使用已有regionListWindow箭头预算。不改变hooks配置、权限或异步资源行为。

## 验证与验收

B2-1：绘制长literal头中尾、后续字段及全部中间行。B2-2：sandboxed true/false在正常、region1–6、窄列及resize中，区域外无绘制字符。B2-3：带region到达matchers，测试返回路径，六项chrome线索先逐项测量再修改。B2-4：原生mutation必须触发正文/越界断言失败；相关OpenTUI、Ink测试及build、bundle、typecheck、lint、format均记录原始退出码。B2-5：同步双语设计、独立PR、准确head/base及需求矩阵。实际结果见下方需求矩阵与交付日志。

## 机制与历史审计

紧凑模式隐藏标题/数量、notice/banner、说明性header、footer提示与纵向padding；region1–2还隐藏边框。正文仍在限高scrollbox内，空列表说明也完整保留。18列标签会使值剩余不到2列时，详情采用上下排列以容纳宽字符。预包行支付原生滚动条占用的一列，在独立物理行节点中保留literal空白/换行。默认按词边界换行，仅当词长超过实际正文宽度时硬折（`hard: true`、`trim: false`）。原生扫描宽29详情与宽40空态的可达帧，断言完整的`settings.json`与`event`。标题改为同一文本内的彩色span，使实际包行与合并测量一致。

宽度、正文预算或紧凑边框发生变化时，重新挂载只读scrollbox并回到头部；viewport不变的resize保留偏移。两种策略通过原生滚动位置与正文绘制测试，而非节点identity。提示隐藏时Esc仍可用。原生边框可能绘出父级文本clip，因此同时断言几何和字符帧。

紧凑详情省略标题，使第一行直接包含hook字段。词边界证据保留实际看到该词的帧，literal语料包含汉字、假名和韩文。两档chrome阈值仍是明确的取舍：更大的区域可能恢复说明文字，从而减少可见列表行数。全局禁用Hooks仍需单独对齐：Ink显示禁用状态页，而当前OpenTUI紧凑视图可能隐藏banner。该缺口保留在能力清单中，阻断最终完整对齐验收。

在POSIX上，评审加固保留HUP作为PTY关闭的首个信号，给产品五秒清理预算留出十秒，再终止自有进程组并最多等待五秒确认退出。Windows通过PTY后端终止子进程。强制清理仍判测试失败，调用方仍需释放其他夹具。CI证据名称和目录包含run attempt；构建前隔离夹具设置和运行时目录，失败后也回收。新增验收命令在所有runner上显式将未处理异常判为失败。这些改动必须在最终提交上重新验证，早先验收只保留为历史证据。

| 历史线索               | #14044源码与终端20 / 40 / 100列原生run行数 | 历史处理结论     |
| ---------------------- | ------------------------------------------ | ---------------- |
| C1 extensions提示/状态 | 已测量runs；提示8/3/1，样例状态10/4/2      | 未复现旧少计预算 |
| C2 MCP步骤header       | 已测量header runs；样例6/2/1               | 未复现旧少计预算 |
| C3 theme/scope footer  | 已测量runs；theme5/2/1，scope4/2/1         | 未复现旧少计预算 |
| C4 theme标题           | 实际标题列宽3/12/39，行数5/2/1             | 未复现旧少计预算 |
| C5 theme列表标签       | 名称/类型按剩余列裁剪；1/1/1               | 未复现旧少计预算 |
| C6 auth Shell标题      | shellBodyChromeRows测量标题；样例5/2/1     | 未复现旧少计预算 |

这些是历史代表性run的测量，charge = native height = painted rows，不是当前候选验收，也不是六个完整dialog的极短区域认证。U1 不修改对应模块。

## 候选验收

| 需求 | 必要证据                                                                                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B2-1 | 原生长literal头中尾、全部80个中间glyph、CJK（中日韩）及后续字段；20/28/29/40/100列，region1–6/15/40、键盘及resize。11列仍不在本轮验收范围。                           |
| B2-2 | Sandboxed true/false几何和区域外字符帧，以及End/Home到达sandbox提示尾部。Sandbox不得启动Git。原生非sandbox用例在空临时cwd运行；大型工作区Diff归产品测试覆盖。         |
| B2-3 | 原生matcher region、选择与Enter、逐级Esc返回、空matchers/handlers，且分组和gate不变。                                                                                 |
| B2-4 | 精确候选上的相关OpenTUI/Ink测试、native component parity、build、bundle、typecheck、lint与format；保留失败及重跑。产品测试比较Node+Ink、Bun+Ink与Bun+strict OpenTUI。 |
| B2-5 | 同步双语设计、保留来源、准确候选/base及独立报告的验收结果。                                                                                                           |

当前候选结果记录在它的测试报告和PR证据中。执行前均为 `NOT_RUN`；#14044 的结果表只作为历史证据。

历史证据纠错（MYWO-17）：作者旧证据中的`detail-cap`实际移除了空态`renderEmpty`的高度上限；其日志及ZIP应映射为`empty-cap`，不能证明详情高度上限。后续`true-detail-cap` mutation才用detail key与height唯一定位详情。复用测试时保留这一区别，不把旧mutation结果或静态key/identity-only断言复制为当前业务验收。

## 限制与后续

Windows、Linux、tmux与辅助技术需要独立验证。原生headless renderer及mock键盘帧不是PTY录像；产品PTY证据由U1迁移验收方案跟踪。本片段不关闭#13758/#12612或#8662，confirmation、transcript等复合子项仍在。本改动不切默认renderer，不改Bun运行时、剪贴板通知、confirmation架构或上游FFI。六项历史chrome线索需要当前测量才能继续修改。
