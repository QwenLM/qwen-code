# OpenTUI hooks 内容与区域预算（MYWO-3 / MYWO-13）

[English](2026-10-13-opentui-hook-content.md) | [简体中文](2026-10-13-opentui-hook-content.zh-CN.md)

## 状态与基线

已在独立 stacked PR 实现；本地原生及相关单测通过，最终仓库门禁与 Leader 验收状态随交付记录。已检查最新 main：`83ffe4540c7df15c46a8893f8919801fac58295b`。独立 stacked 分支从 PR #14034 head `e16490eccc5aeffbb680da7c0935b5aebfe82f1b` 起步；其改动是依赖，不计作第二批贡献。main 没有修复本批目标。不合并任一 PR，不切换默认 renderer。

## 复现

独立 macOS 原生 renderer 在 stacked base 上观察：sandboxed Diff 在宽20时高12行，region1–6越界绘制；非sandboxed Diff能容纳。hooks detail 宽40时高102行，长literal头可见，中尾不可达，没有scrollbox。matchers也在region1–6越界。观察使用captureCharFrame和原生几何、mock键盘输入，非PTY。11列正文可达性仍属独立上游限制。

## 决策

复用已有scrollDialogLayout预算，保留内容行，预算不足时隐藏可选chrome；sandboxed Diff与hooks共用策略。hooks详情用原生scrollbox限制高度，保留literal换行，把每个物理文本行独立渲染，使其可滚动，避开原生多行Text尾部限制。窄列付不起标签列时采用上下排列的标签和值。详情支持滚轮、方向/翻页键、Home/End；Esc保持逐级返回。viewport变化时重置详情滚动到头部，viewport不变时保留偏移与全部内容。列表保留选中项并使用已有regionListWindow箭头预算。不改变hooks配置、权限或异步资源行为。

## 验证与验收

B2-1：绘制长literal头中尾、后续字段及全部中间行。B2-2：sandboxed true/false在正常、region1–6、窄列及resize中，区域外无绘制字符。B2-3：带region到达matchers，测试返回路径，六项chrome线索先逐项测量再修改。B2-4：原生mutation必须触发正文/越界断言失败；相关OpenTUI、Ink测试及build、bundle、typecheck、lint、format均记录原始退出码。B2-5：同步双语设计、独立PR、准确head/base及需求矩阵。实际结果见下方需求矩阵与交付日志。

## 已验证机制与审计

紧凑模式隐藏标题/数量、notice/banner、说明性header、footer提示与纵向padding；region1–2还隐藏边框。正文仍在限高scrollbox内，空列表说明也完整保留。18列标签会使值剩余不到2列时，详情采用上下排列以容纳宽字符。预包行支付原生滚动条占用的一列，在独立物理行节点中保留literal空白/换行。默认按词边界换行，仅当词长超过实际正文宽度时硬折（`hard: true`、`trim: false`）。原生扫描宽29详情与宽40空态的可达帧，断言完整的`settings.json`与`event`。标题改为同一文本内的彩色span，使实际包行与合并测量一致。

宽度、正文预算或紧凑边框发生变化时，重新挂载只读scrollbox并回到头部；viewport不变的resize保留偏移。两种策略通过原生滚动位置与正文绘制测试，而非节点identity。提示隐藏时Esc仍可用。原生边框可能绘出父级文本clip，因此同时断言几何和字符帧。

| 历史线索               | 当前源码与终端20 / 40 / 100列原生run行数 | 处理结论         |
| ---------------------- | ---------------------------------------- | ---------------- |
| C1 extensions提示/状态 | 已测量runs；提示8/3/1，样例状态10/4/2    | 未复现旧少计预算 |
| C2 MCP步骤header       | 已测量header runs；样例6/2/1             | 未复现旧少计预算 |
| C3 theme/scope footer  | 已测量runs；theme5/2/1，scope4/2/1       | 未复现旧少计预算 |
| C4 theme标题           | 实际标题列宽3/12/39，行数5/2/1           | 未复现旧少计预算 |
| C5 theme列表标签       | 名称/类型按剩余列裁剪；1/1/1             | 未复现旧少计预算 |
| C6 auth Shell标题      | shellBodyChromeRows测量标题；样例5/2/1   | 未复现旧少计预算 |

这些是代表性run的测量，charge = native height = painted rows，不是六个完整dialog的极短区域认证。未修改对应模块。

## 需求结果

| 需求 | 本地结果        | 证据及剩余验收                                                                                                                                                               |
| ---- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B2-1 | 通过            | 原生长literal头中尾、80个中间glyph、汉字、后续status/timeout/options与修改提示尾部；20/28/29/40/100列，region1–6/15/40、键盘及resize。排除11列正文。                         |
| B2-2 | 通过            | sandboxed true/false几何、画布留出余量后region外实际字符帧，窄/正常/resize；sandbox仍不启动Git。                                                                             |
| B2-3 | 范围内通过      | 原生matcher region、末匹配项真实active绘制、Enter及Esc返回、空matchers/handlers；六线索按上表分类。已有分组、权限gate与异步行为不变。                                        |
| B2-4 | 本地vehicle通过 | 相关OpenTUI/Ink suites及原生component parity；八个精准行为mutation变红，恢复源码变绿。build/typecheck/lint/format/bundle命令、原始退出码及开发失败尝试均保留在交付日志附件。 |
| B2-5 | 交付时通过      | 独立stacked PR、双语设计、准确冻结head/base、需求矩阵及原始日志。Leader随后安排冻结head测试与双独立审查；实施者不自批。                                                      |

纠错（MYWO-17）：作者旧证据中的`detail-cap`实际移除了空态`renderEmpty`的高度上限；旧日志及ZIP原样保留，并映射为`empty-cap`，不能证明详情高度上限。新增作者证据用detail key与height唯一定位`true-detail-cap`，与`empty-cap`分开执行。八项mutation分别移除sandbox布局、空态高度上限、真实详情高度上限、literal后缀、滚动条列预算、matcher header预算、共享标题包行，或重新引入强制按字符包行（`wordWrap: false`），均触发正文/glyph可达性/几何断言失败。不使用静态key或identity-only mutant声称业务反例。

## 限制与后续

Windows、Linux、tmux、真实PTY、辅助技术验证待执行。macOS证据为原生headless renderer及mock键盘输入，非PTY录像。不关闭#13758/#12612或#8662，confirmation、transcript等复合子项仍在。不改Bun S2、剪贴板通知、confirmation架构或上游FFI。六项历史chrome线索在实测前均未确认，已有测量helper可能已处理。
