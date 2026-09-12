# OSWorld task05：本地 Codex 接入与 CUA 效率

[English](osworld-smoke05-efficiency.md) | [简体中文](osworld-smoke05-efficiency.zh-CN.md)

## 范围与状态

本文记录2026-09-11的初始冒烟阶段：当时已接通本地 Node REPL、JavaScript SDK
和 Rust 原生库，并修复下列热点。仅评估执行效率，不评价 task05 的数据、格式或得分。准备阶段的锁屏和
截图权限失败不纳入效率统计。

第三轮完整冒烟使用应用状态刷新修复后的 `28ffa1bb` 构建，在1200.242秒达到
预算上限，77次MCP调用、9次错误，未保存工作簿。PDF发现和读取已推进，但
整任务提速尚未成立。其后新增的换行修复 `d8ddc9ea` 已通过独立Excel的LF、CRLF及双LF夹具；
该补丁不属于这次20分钟运行，不能把两个版本的验证合并。

## 本地接入与产物来源

执行链为 Codex CLI app-server（stdio）→ 本地 Node REPL MCP → 本地SDK
JavaScript产物 → 本地N-API桥和Rust动态库。无需独立driver daemon。

1. 在 `packages/node-repl` 执行 `npm run build`，MCP指向 `dist/index.js`。
2. 在 `packages/cua-driver/typescript` 执行 `npm run build`，将 `dist`、
   `computer-use`、`package.json` 复制到已注册的隔离模块根。
3. 在 `packages/cua-driver/rust` 执行
   `DEVELOPER_DIR=/Library/Developer/CommandLineTools SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk cargo build --release -p cua-driver-sdk --locked`。
   本机默认Xcode SDK14.5无法编译Metal依赖，已安装的Command Line Tools提供
   SDK26.5/Swift6.3.3；只在构建进程内选择，不更改系统配置。
4. 使用 `packages/cua-driver/scripts/build-node-runtime.mjs --output` 构建N-API桥。
   将桥和 `libcua_driver_sdk.dylib` 放在显式的 `QWEN_CUA_SDK_NATIVE_DIR` 中。
5. benchmark的 `scripts/stage_local_cua_runtime.py` 暂存JS产物并记录源文件哈希。
   SDK入口必须位于已注册目录内；外部包symlink被Node REPL拒绝，保留此边界。

每轮使用独立目录，记录模型、CLI/Node版本、原任务与Skill、输入文件、实际
加载路径和散列。源码基于 `20ecdaf6b2fbbfbd276bf05294e7b672632087e4` 加各轮记录的
修复补丁；版本号本身不能唯一标识本地实现。原生库替换前归档旧文件及构建
记录，使用原子替换，避免改写仍被进程映射的文件。已运行目录不重复启动。

修改前的本地链路探测用47.732秒、4次MCP调用返回真实1568×743 Finder截图。
这只是连接验证，不是任务完成时间。

## 修复与证据

按本次工作流影响排列；不把恢复区间全部当成单一缺陷的净损失。

| 热点                              | 实现与证据                                                                                                                                  | 边界                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 持久MCP漏报新应用、退出和前台变化 | 使用实时Process Manager PID/前台查询替代时变AppKit数据源。同一长期MCP内的启动、切前台、退出无需驱动主循环即可正确反映。                     | AppKit名称/bundle/classification仍保留；动态activationPolicy仍受既有缓存影响。           |
| 前台快捷键未全选、Command丢失     | window-only hotkey采用现有精确窗口HID guard；普通带修饰键pressKey使用显式flags和物理修饰键切换。8个真实选区/替换用例通过，最终库另复验2例。 | 保留Screen Sharing的bare转发、无修饰单键的既有flags、网页坐标聚焦回退和后台拒绝。        |
| 多行Unicode合成没有Return语义     | LF/CR改为真实Return，CRLF合并；跨Return的读回不生成单字段partial retry offset。                                                             | 默认字符间隔、其他Unicode/Tab、原子AX写入及Screen Sharing物理路径不变；GUI复验单独记录。 |
| facade漏报不完整采集和原生上下文  | 优先读取嵌套 `observation_revision.capture_complete`，兼容旧顶层字段；保留截图几何、后台路由和降级原因等8个上下文字段。                     | 不完整采集最多重试一次，不能暴露可用token；不掩盖原生AX错误。                            |
| 应用目录每次大量plutil子进程      | 进程内CoreFoundation plist解析，支持XML/binary、Unicode和名称回退，不新增显式缓存。                                                         | 静态目录相等不证明动态状态新鲜；两类问题分别验证。                                       |
| 键名和AX动作别名不一致            | meta/super映射Command、Arrow\*兼容，组合键只能有一个主键；接受实际广告动作的树文本别名。                                                    | 歧义、未广告动作和错误组合仍拒绝，不添加猜测回退。                                       |
| 合法紧凑await转换错误             | 注入取消检查时保留空格，真实kernel可执行紧凑嵌套SDK导入。                                                                                   | 准备过程中发现，不冒充历史任务中的故障。                                                 |

应用枚举的同现场对照中，npm中位5839.898ms，本地首版17.738ms，118个应用的
静态字段完全一致。最终应用刷新版的6次采样为24.6–48.5ms；动态现场不同，
不把前一组329倍直接当成最终构建的严格倍率，更不代表整任务倍率。

原子AX全选后 `typeText('X')` 可正确替换，因此路径追加并不证明typeText清空
选区。键盘修复以真实AXSelectedTextRange及最终输入值验收，不能以committed
响应作为UI已改变的证据。

## 持久应用状态的根因

第二轮中Preview在约85秒的打开操作期间启动并拥有grf19.pdf窗口，原MCP后续
四次仍只列出Excel；新MCP立即看到Preview。Apple本机NSRunningApplication.h
明确说明运行列表和时变属性依赖主运行循环common mode更新，Node内嵌宿主
没有此保证。独立Calculator实验同时看到原AppKit值陈旧、实时PID查询正确；
手工驱动主循环能恢复旧实现，修复后不再需要该操作。

Process Manager API虽已弃用，本机仍可用，且无需接管宿主主线程。当前修复
只声明进程成员和前台状态实时，不宣称所有AppKit属性实时。此前“PDF未打开”
应改为“模型未发现或确认PDF”；被测SDK的列表不能作为独立打开失败证据。

## 冒烟轮次与多行输入

| 运行                       |      耗时 | MCP调用 / 错误 | 状态                                         |
| -------------------------- | --------: | -------------: | -------------------------------------------- |
| 权限正常后的npm对照        |  684.225s |         49 / 9 | 用户停止，模型未确认首份PDF正文              |
| 首轮本地修复               |  289.250s |         27 / 4 | 为隔离键盘路径追加而诊断停止                 |
| 键盘修复后                 |  615.033s |         49 / 5 | 为隔离持久应用漏报而诊断停止                 |
| 应用刷新修复后（28ffa1bb） | 1200.242s |         77 / 9 | 预算超时；已读取五年PDF，Excel重输和保存恢复 |

第三轮143秒发现Preview，157秒读取首份PDF，246秒取得五年材料。
1150字符TSV的cell区间为283.248–334.356秒，其中默认每字8+30ms固定等待可
解释43.7秒；51.108秒还含观察和REPL调度，不能全标为typeText精确耗时。

未改28ffa构建在独立空白Excel复现 `11\t12\n21\t22`：A1=11、B1含12和换行后的
21、C1=22，第二行为空。仅把行边界替换成显式Enter、保留相同Unicode Tab后，
得到相邻两行的2×2网格。实际截图与逐格AX读回隔离了LF问题。换行补丁发送
实际键码36；跨Return后单个AXValue无法证明完整投递，不再据它建议重发前缀。

新构建LF、CRLF和双LF三例各通过6格AX断言及截图检查。LF整段输入单次API
1758.872ms，对照中可工作的逐行输入加Enter三次合计4351.404ms；两者均不含
共同的末格Enter、初始定位与验证。这里只证明该夹具少了调用，不是整任务提速。
Finder单行ASCII和Unicode全选、替换、caret断言及截图也通过；五例夹具与
测试MCP进程均已清理。

## 剩余热点与归因边界

- **保存面板目标和截图区域。** 独立AXSheet的CGWindowID确为34138，但目标树
  只枚举顶层AXWindow。CG/AX/SCK/filter几何均为880×448，原生输出1760×896
  却含父Book1及留边，仍被判定几何有效。系统screencapture也包含父窗，直接
  返回2804×1684。因此不是SCK独有现象，也未证明resizeRegistry计算错误。
  此问题在初始冒烟阶段尚未解决。后续[附属面板修复](osworld-attached-panels.zh-CN.md)
  已加入精确sheet身份、祖先/焦点证明及按验证边界进行的选定窗口display裁剪；
  不复用父token、不仅裁父窗口图，也不放宽焦点守卫。
- **逐字等待成本。** 保留既有节奏；公开ComputerUse facade尚无批量粘贴接口。
  换行修复解决重输原因，不等于将43.7秒字符等待消除。
- **不完整AX采集。** Finder Help的 `_SC_SEARCH_FIELD` 声明支持AXChildren，
  独立读取却三次返回-25200；重启后曾暂时恢复。不能把错误静默解释为空树，
  也不能据此认定Excel空树和20秒walk timeout同根因。
- **动作返回和目标选择。** AXPress/AXOpen报错后UI可能已改变；前台动作会恢复
  原应用，Finder inactive本身不能证明动作失败。旧窗口、错误token和坐标
  使用需逐案判断，保持精确目标检查。

baseline也有路径、表格字符、剪贴板和保存对话框恢复，标为疑似环境问题；
相似症状不证明相同根因。历史机器和native二进制未完整对齐，早停耗时不是
完成时间，两个超时的几秒差异也不是提速证据。

## 验证与记录

在初始冒烟阶段，Node REPL构建、类型检查及63项测试，SDK构建、类型检查及46项facade测试已通过；
换行补丁后原生release构建及352项库测试通过。最新代码审查无findings，完整
diff按两轮审计。真实应用/输入复验与完整任务分别记录，不以mock代替UI效果。

复现报告：`.qwen/issues/osworld-smoke05.md`；测试计划：
`.qwen/e2e-tests/osworld-smoke05.md`；调查过程及原始JSON/PNG位于
`.qwen/investigations/`。benchmark中的 `OSWORLD_QWEN_SMOKE05_PATTERNS.md`
按版本记录完整冒烟、失败模式、历史环境标记及效率统计。
