# OpenTUI 历史统计对齐

[English](2026-11-15-opentui-stats-history.md) | [简体中文](2026-11-15-opentui-stats-history.zh-CN.md)

## 验证记录——2026-11-19（切换范围重置月份）

本轮合入`origin/main`（`a8f43b92`）并修复评审的Critical：循环`r`会重置月份索引，因此切换范围不会让Activity热力图停在新范围按键无法离开的月份。tab栏冲突的解决保留本移植的compact换行header，宽视图按tab逐个渲染text节点，从而把main的screen-reader选中/未选中tab id保留在presentation实际读取的节点上；历史hook fixture补上main新增的必填`userPromptCount`字段。合并后的树上构建、类型检查、lint、i18n语言包门禁与格式检查均通过。相关CLI套件通过140项测试（stats服务、原生历史、历史hook、对话框frame、对话框挂载、Settings），第二批通过125项（i18n、Ink stats标签页）。六个变异见证在各自守卫被移除时变红：切换范围重置、热力图坐标标签前缀、两处本地化调用点（`peak {{value}}`、`{{count}} more`），以及宽视图按tab与compact的screen-reader id。

Ink参照实现带有同样的陈旧偏移机制与同样的窄宽度热力图超宽（共享`buildHeatmapData`列数）；两者均延后到follow-up队列，不在本移植内单独分叉。A–D组公开leg与几何重放本轮未重跑，OpenTUI集成leg需要本runner不具备的bun；合入验收前需重跑。

## 验证记录——2026-11-16（评审修复）

评审修复的源码树为 PR head 分支上的提交 `e87a0ab90c60fd7c3231f2eae6a655f713c6a01f`；本记录提交仅更新文档。该树上构建、类型检查、lint 与格式检查均通过。相关 CLI 套件通过 45 项测试（stats 服务、原生历史组件与历史 hook 三个文件）、164 项测试（对话框 frame、对话框挂载与 i18n 文件）以及 59 项 core usage-history 测试。新增与替换的回归用例在各自修复被还原时均变红（共九个变异见证，含幻影提示行与翻页方向、步长、重置）。区间基准用例现固定 TZ=UTC：修复前在 TZ=Etc/GMT+12 下失败，修复后通过。九语言包探针确认新键 `peak {{value}}` 与 `Statistics owner is unavailable.` 在每个语言包中均可加载并插值。

下文此前记录中的 A–D 组公开 leg、原生几何重放与 workflow 测试计数未在本轮重跑；该记录的中间候选树已不可拉取，其 bundle 身份无法复核。公开交互验收断言的是内容包含（总量、月份标题、项目名）而非精确帧字节；合入验收前需重跑。

## 验证记录——2026-11-16

本实现已基于固定提交 `88e3f19c01d52110353ed1013e5d750c45e0cb0d` 独立验证。下文此前的记录描述中间候选，作为历史保留。当时已测的源码树是一个中间候选，在基础仓库与 head fork 中均已不可拉取；记录的 bundle 文件数（1,454）与入口哈希仅作为历史保留，无法复核。当前已测树为上文引用的评审修复提交。

构建、类型检查、lint、格式检查和 bundle 均通过。相关完整文件测试通过 220 项 CLI 测试、59 项既有 usage-history 测试和 424 项 workflow 测试，另有 4 项 workflow 测试跳过。迁入的八个公共测试及配置文件也通过了类型检查。

A–D 组均通过 Node24 + Ink、Bun1.4.4 + Ink 和严格 Bun1.4.4 + OpenTUI0.5.10 对照。13 个公开验证 leg 包含 16 次用例执行、helper 清理前 22 次自然退出和 3 个正常关闭的模型请求。D 组将四条历史会话与 8,100 个实时 token 合为 5 个会话及可见的 `10.0k`，重开不膨胀。当前会话 summary 首次在自然退出后的磁盘快照中出现，因此该公共用例没有动态覆盖磁盘已存在同 ID 记录时的替换分支。C 组验证空历史不追加、旧历史只迁移一条 summary，热冷重开保持稳定。

原生几何通过 120×40、80×18、40×18、20×15 和 40×12。独立复核重放全部 61 帧及 80 个输入，检查选中 tab、完整边框和已测的 PageUp/PageDown 转换；这不代表每个长值或每个滚动位置都已验证可达。

该记录当时仅更新文档，源码、测试及 workflow 文件在该步骤未变更；文档格式和引用检查单独记录。这些检查不授予安装分发、Windows/Linux、GUI、IME、全部 Unicode、面板持续打开时刷新或长期稳定性资格。另案 Bun + Ink Trust 重启失败仍未解决。默认切换、移除 Ink 和整体迁移验收分别需要对应批准与证据。

## 状态与问题

Group A真实基线已完成：global0.23公开场景通过（85377，0model HTTP、自然退出0）；当前strict Native在all-time断言失败（97112），Session-live-zero此前已通过，帧实际只有Activity(this session)及0指标。只Group A已运行，B/C及新实现三profile仍待验证。

本次仅CLI实现位于独立feature工作树，基于固定main04bb3c64473eb6f2c980434e6e612a180c65055f。新候选的build、unit及新产物公共验收仍待运行，不依赖Trust/Common或sidecar polling候选。

`/stats`实际进入原生统计面板。Session显示实时指标，但Activity和Efficiency仍只是另一份当前session汇总。Ink会读取持久历史加实时session，支持All time / Last 30 days / Last 7 days / Today，并可在All-time Activity中按月份导航。同一个原生组件也嵌入Settings → Stats，因此这是实际挂载的用户能力差距，不是无消费者导出。

## 范围与用户行为

沿既有聚合语义恢复历史Activity和Efficiency。Activity包含session/时长/token汇总及差值、heatmap/streak、按月token趋势和项目；Efficiency包含cache命中率、工具成功率、延迟、工具榜单、模型明细与代码影响。保留已有Session数值和实时生成指标，不重写dashboard或历史存储。

Tab / Shift+Tab在Session、Activity、Efficiency间循环。`r`沿既有范围定义循环`all → month → week → today → all`；尽管Ink原错误提示如此描述，它并不是新增的同范围retry命令。All-time Activity中Left/h移向较早实际月份，Right/l返回最新月份，边界由真实月份夹紧。循环`r`会把月份索引重置到最新月份，因此切换范围不会让热力图停在新范围按键无法离开的月份。复用既有文案及翻译key。加载、空历史、缺延迟字段、损坏/不可读历史及加载失败均遵循现有reader/service合同；必须区分成功空报告和真实reject。

Settings嵌入宿主保留原焦点所有权：tab bar持焦时仅外层导航，进入内容后统计键才生效，Up/Escape按当前接线返回宿主。不重复处理或写设置。长表格及标签须能在实际传入高度中通过原生换行/滚动完整访问，适用时显示真实隐藏行数量；不固定裁断或虚构新导航键。

## 原生窄屏框架后续修正

main88首次五尺寸公开几何场景在40×18 Session失败：上边框位于第5行，提示移至第16行，底边超出18行viewport。此前120×40及80×18的tab/滚动阶段通过，20×15及40×12尚未到达。这是真实裁切，不能因此削弱完整框架识别。原先固定扣八/十行chrome，没有包含自然tab bar、范围及提示换行占用。

仅原生Stats模块适配。通过公开BoxRenderable ref/onSizeChange读取外框宽度，compact判据将其与正常padding及完整正常chrome比较，因而compact自身padding变化不会反向振荡判据。宽视图保留三tab及全部范围标签；窄/短视图保留完整选中tab、当前范围及简短Tab/r/月份/PgUp/PgDn/Escape提示，并缩小padding和可选margin。compact滚动正文同时去除额外右padding，让20列下的十一格Session ID标签在既有scrollbar旁仍可完整显示。范围、提示与compact header仍为真实word-wrap文本与既有styled span，并用既有wrappedRows对实际相同字符串计行。宽视图header按tab逐个渲染text节点，使main的screen-reader选中/未选中tab id落在presentation实际读取的节点上。保留header/body之间一行分隔，滚动正文获得region剩余高度。

十四处Row及五处SubRow消费者全部是本地Session指标。compact时完整标签和值上下堆叠；带颜色的工具/代码/时间/模型值采用可换行文本流，避免固定28列label或多box横排在20列终端隐藏值。独立Stats与Settings嵌入保留既有session、焦点和高度输入，不改共享Frame、region预留或Core。

结构单测seam覆盖五种声明的frame/body预算，以及compact不受scrollbar viewport宽度反馈影响。它们不授予实际绘制边界、完整Unicode换行、所有极小嵌入region或真实滚动资格。原五尺寸公开场景、既有180秒test/12秒condition/240秒outer预算及原label/frame/导航断言必须绑定新产物运行。原几何失败及所有旧候选结果独立保留；此后续修正尚未build或执行。

## 数据复用与所有权

复用CLI `loadStatsData`、`computeSessionStats`、`computeGenerationRates`及既有Core `metricsToUsageRecord`。真实本地启动经Entry、AppShell至OpenTuiDialogMount传入同一个Config；mount向直接Stats及Settings传入host.sessionStats，Settings保留焦点合同并转发。不新增foreign/daemon历史store路由。历史仍来自现有进程全局QWEN_HOME usage_record.jsonl，不能因为捕获selected Config就擅自按项目过滤。实时record使用该Config/session/project及其指标；service已有加入实时record前按同session ID去重的逻辑。不新增网络/model调用、持久化机制、schema、Core聚合或Core API改动。现有loadUsageHistory在没有有效缓存记录时默认允许从既有session journal重建并持久化迁移；这是原Ink语义，不得宣称整个历史API绝对只读。预置四条有效record的Group A须保持store逐字不变；Group C空/损坏场景按真实迁移路径和精确写入资格单独分类。

每次请求捕获selected Config身份、session ID和project身份。范围切换创建新请求revision；关闭/卸载、观测到owner替换或更新请求均使旧结果失效，包括迟到成功/失败及A→B→A。不能因每次telemetry tick或metadata刷新重建整个dialog。沿现有范围/session变化时重读历史的节奏，不每次指标更新都读磁盘。同owner Session telemetry仍实时更新，异步历史不得画到另一owner。

只复用实际纯格式化/chart投影。Ink React组件及混合Ink组件的stats-helpers模块不能作为原生renderable导入；只有确有两个消费者需要时才共享很小的纯范围/文案/投影。优先既有ascii chart builder及原生基础组件。新进入的Core值导入改为实际leaf，并仅同步相关legacy allowlist/mock，不新增Core barrel豁免。

## 受影响CLI文件

当前原生统计位于`ui/opentui/dialogs-stats-skills.tsx`；若能保持Skills字节及行为不变，可提取聚焦的原生统计文件。两个真实消费者是dialog mount和Settings。添加同目录状态/交互测试及公共交互验收，复用`ui/utils/statsDataService.ts`、`computeStats.ts`及chart helpers。若抽取很小纯helper，必须服务两个实际renderer、保留Ink行为并覆盖其消费者。CI接入须同步真实full/targeted列表和全部parser测试，适用时包括动态runner-checkout测试。精确文件在基线后确定，不先写推测性stub。

## 验证与验收

先用显式绝对命令及owned HOME/runtime/TMP运行真实已安装global Ink基线；旧版本缺功能必须保留为失败或未支持范围，不削弱oracle。然后对当前strict native运行同一公共场景捕获缺口。Root消费两者前不实施生产代码。复用InteractiveSession、renderer-matrix及零请求fake server，不用private import、时间mock、伪造渲染统计或模型调用。

用真实日期创建四个持久session：Today、2、14、60天前，配唯一汇总、多model/project/tool及至少两个日历月份。冻结fixture参考时间并写golden manifest；若跨日期边界则标setup不合格，不改应用时钟。断言精确聚合和可见范围/月份，不只看tab名。覆盖热重开、冷重建、空/错误处理、嵌入焦点、store/settings/workspace只读map、零model HTTP及自然退出。Node+Ink、Bun+Ink、strict Bun+OpenTUI三leg必须绑定新源码/产物身份。公共1.9k token显示只证明舍入格式；精确1920汇总由service单测及fixture golden验证。单测seam覆盖公共交互不能人为制造的实时record去重及异步撤销/ABA。

声明完成前需build/type、受影响整文件测试、实际workflow meta、零warning lint、format、bundle、真实原生几何及全部三profile公共验收。旧Trust/Common或通用stats frame通过不授本功能资格。tracked Group A用例保留已校准业务，默认沿正常renderer/runtime矩阵运行built product，同时保留global基线可用的显式绝对命令override。fixture与应用都使用UTC，不mock时间。详见ignored E2E计划`opentui-stats-history-20261115.md`；上述基线观测不授新实现资格。Group B/C与CI接入仍是独立待完成工作。

## 边界与待定问题

不改Core生产、usage收集、历史修复/export/delete，不新增范围、不切默认renderer或移除Ink。现有history reader可能把读取错误归为空；基线必须固定真实公开结果，不能虚构错误。更强存储语义需维护者分诊。Windows、installed distribution、GUI/device及整体迁移资格独立保留。04bb是固定实现基线，不代表后续最新main。公共只读保证适用于Group A有效历史fixture，不是所有reader迁移路径。
