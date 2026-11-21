# Managed /loop 分类器：执行判定，而非扫描它

- 状态：提案
- 日期：2026-11-20
- 关联：[延后评审钉子](2026-11-17-managed-loop-deferred-pins.zh-CN.md)（#17594，已合入）、跟踪 issue #17673 第 1 项
- English version: [2026-11-20-managed-loop-classifier-executed-seam.md](2026-11-20-managed-loop-classifier-executed-seam.md)

## 问题陈述

managed-agent E2E runner 在每个 fake 模型回调内部回答 `cron_create` 的准入侧查询。接缝画在 `blockProperties`：schema 查找、收窄、门与 answer 站点全部内联在 fake 里，故快速测试唯一能断言的是它们的**形态**。一个手写 AST 扫描器为该形态做库存，而 #17594 的十四轮评审大部分花在「新实测出一个兄弟形状绕过扫描器之后再扩展扫描器」上。

该 evasion 面按构造就是无界的。任何「写同一个值、或发同一个答案，但不按扫描器寻找的拼写来写」的方式都能击败它。第 13、14 轮实测出八个这样的兄弟并逐个关闭——shorthand 的 `toolCalls` 键、shorthand 的 allow 键、值为「曾初始化为 `false` 的绑定」的 allow、rest 解构写入、带括号与带类型转换的赋值目标、for-of / for-in 初始化器——而每次关闭都是又一份以另一种拼写为键的库存。残留已有记录：以 `!true` 或 `Boolean(false)` 算出的 allow 不拼写 `false`，任何拼写库存都看不见它。

同一根因还带来两项代价。两条臂携带**除 call id 外逐字节相同的判定块**，故对一条臂的修复可能静默漏掉另一条。而扫描器自身的「非空转」必须靠一个敌意控制来证明，该控制已长到 21 种写入形态、5 个 allow 站点、7 个 answer 站点、13 个工具名站点与 5 次 helper 调用——这份夹具的唯一用途就是显示扫描器没有闲着。

## 现状

在 `768cad5fcc` 上实测：

| 站点                                                          | 作用                                                                                                                                                                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/run-managed-agent-server-e2e.ts:2718`                | `classifierBlockAnswer(blockProperties)`——已是顶层纯函数、已被元测试执行。收窄 block schema：阶段 1 给出 `{ shouldBlock: false }`，阶段 2 追加 `thinking`/`reason`，非 block schema 给出 `undefined`。             |
| 同文件 `:3067`–`:3092`                                        | skill 臂的内联判定：tools 提取 → `respond_in_schema` 查找 → `blockProperties` → helper → `!== undefined` 门 → `{ toolCalls: [fakeToolCall('respond_in_schema', blockAnswer, 'loop-classifier')] }`，否则继续往下。 |
| 同文件 `:3167`–`:3191`                                        | fire 臂的内联判定——除 call id `'loop-fire-classifier'` 外完全相同。                                                                                                                                                |
| `integration-tests/fake-openai-server.ts:115`                 | `fakeToolCall(name, args, id)` → `{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }`。第三参即 tool-call id。                                                                          |
| `scripts/tests/managed-agent-server-e2e.test.js:710` / `:741` | `extracted(names)` 从 runner 切出**顶层**声明并转译；`load(names, returns, ...params)` 构造注入依赖的 `new Function`。这是既有的执行机制，`:4095` 已用它执行 `classifierBlockAnswer`。                             |
| 同文件 `:157` / `:509`                                        | `loopClassifierWiring` / `loopClassifierScope`——扫描器及其 loop 回调域限定，产出十份库存。                                                                                                                         |
| 同文件 `:3890`                                                | 钉测试。既断言这十份分类器库存，**也**断言无关契约（arm 终端、body 域、caller-import 标记、sidecar 判别、union 标记）。                                                                                            |
| 同文件 `:4269` / `:4414`                                      | 被执行的敌意控制与隔离 allow 站点用例——两者都只为证明扫描器非空转而存在。                                                                                                                                          |

扫描器在本元测试之外没有消费者；其它引用只有 #17594 的历史设计记录。

## 拟议改动

### Runner：一个被执行的判定，两条委托的臂

在 `classifierBlockAnswer` 旁新增顶层纯函数：

`loopClassifierResponse(body, callId)` 对 block-schema 侧查询返回整个 fake 响应，请求不是该查询时返回 `undefined`。它执行 tools 提取、`respond_in_schema` 查找、properties 读取、经 `classifierBlockAnswer` 的收窄与门，并用 `fakeToolCall` 构造响应。两个 fake 把各自的内联块替换为委托：函数结果有定义就返回它，否则完全按今天的方式继续往下。

该函数为顶层，故既有 `extracted`/`load` 机制无需改动即可触达；`fakeToolCall` 作为依赖注入，与 `waitUntil` 注入 `inspect` 的方式相同。

### 元测试：执行判定，退役形态库存

新增一个被执行的测试，用敌意 body 驱动 `loopClassifierResponse`，断言**整个响应**——工具名、call id 与 arguments 载荷一起——或 `undefined`。敌意方向：阶段 1 与阶段 2 的 block schema；三种非 block 侧查询（title、tool-use summary、next speaker）；缺失、非数组与畸形的 `tools`；名字不是 `respond_in_schema` 的 schema 工具；多个 schema 工具而非 block schema 排在 block schema 之前，故首匹配胜出、后面的 block schema 不会补救；畸形的 `tools` 元素与非对象的 `properties`，必须落穿而非抛错；以及两个 call id，使一条臂无法在另一条的 id 下作答。

退役 `loopClassifierWiring`、`loopClassifierScope`、写入者名集与目标包装集、钉测试里的十条分类器断言、敌意控制与隔离 allow 站点用例。保留钉测试中一切与分类器判定无关的内容，并保留独立的 minted-id 面（`mintedIdWiring`、`mintedScheduleId`、fake-createdId 钉）不动。

以一条有界的委托钉取代被退役的库存，由一个逐子句命名的判据裁定，并由一个敌意源控制逐子句执行见证。该钉要求：恰好两次调用、带两个臂的 call id；两次调用位于**互异**的回调；每次调用都在 `startFakeOpenAIServer` 回调内而非死代码 helper 里；结果被绑定；被绑定的结果在同一回调的 `!== undefined` 门**分支里**返回，且分支内 return 的收集**在函数边界止步**，故分支里声明的闭包不能冒充；以及整个 runner 中恰好一处 `respond_in_schema` 应答构造、且位于 `loopClassifierResponse` 自身内，故回调里的旁路兄弟无法用 schema 无效的 allow 应答非 block 侧查询。每条子句的存在都因为有一个实测 evasion 满足了它所取代的更弱形态，控制用例携带这些形态各一以及一个正向对照。

有一项限度是披露而非追逐：应答站点库存以字面量 `'respond_in_schema'` 首参为键，故计算型工具名仍能绕过它。这与被执行判定为判定本身消除的那类无界拼写家族同源；此处剩下的只是一个有界的站点计数，行为由打包臂覆盖。

## 关键设计决策

- **一个按 call id 参数化的函数，而非两份副本。** 两个块除 id 外已经相同；复制它们正是「修复到达一条臂而漏掉另一条」的成因。参数化还让「一条臂在另一条的 id 下作答」成为被执行测试可断言的方向。
- **返回整个响应，而非只返回 answer。** 只断言 answer 会让工具名与 call id 无钉，而分别钉它们又会重演分散断言此前暴露过的映射弱点。对响应做一次深比较即钉住映射。
- **保留委托钉，去掉判定库存。** 快速套件跑不了打包臂，故「fake 确实委托了」需要一条廉价断言。无界家族住在判定**内部**；单个委托调用没有可比的 evasion 面，而完全不委托会被打包臂从行为上抓住。
- **退役扫描器，而非留作「第二意见」。** 一个行为两套守卫会互相漂移，而扫描器的维护成本正是本次要移除的东西。其历史记录留在 #17594 设计文档里。
- **`undefined` 保持其确切含义。** 它表示「不是 block 侧查询，继续走 fake 的其余部分」。委托不得把它转成响应，也不得吞掉继续往下的路径。

## 涉及文件

| 文件                                                                            | 改动                                                                                                        |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `scripts/run-managed-agent-server-e2e.ts`                                       | 新增 `loopClassifierResponse`；两个 fake 委托给它                                                           |
| `scripts/tests/managed-agent-server-e2e.test.js`                                | 新增被执行的判定测试；有界委托钉；退役扫描器、其两个辅助集合、十条分类器断言、敌意控制与隔离 allow 站点用例 |
| `docs/design/2026-11-20-managed-loop-classifier-executed-seam.md` / `.zh-CN.md` | 本记录                                                                                                      |

不改任何生产运行时模块、契约、sidecar 或 Java 文件。runner 属 E2E 基础设施。

## 范围边界

只做 #17673 第 1 项。第 2–6 项（派生退化阈值、跨语言 fixture 绑定、形态无关的 Java 路由断言、唯一导出的 Parsing 语法、机读 creator 声明）不动，minted-id 面与同一测试里所有非分类器钉也不动。打包臂作为验证重跑，不被修改。

## 验证

本改动只涉及测试基础设施，故承重证据是：被执行的判定测试在变异下对每个敌意方向打红（additive fallback、伪造 schema、错误 call id、去掉门）；委托钉在某条臂停止委托或使用另一条臂的 id 时打红；退役那些库存不削弱任何存活钉子；以及重建后两条打包臂仍通过，fire 臂的 scheduled/fired/completed 见证完好。

## 开放问题

无阻塞项。函数留在 runner 而非移到共享模块，因为 `extracted` 从该文件切顶层声明，移走会需要一个新的 loader 而无收益。
