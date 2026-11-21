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
| 同文件 `:3068`–`:3092`                                        | skill 臂的内联判定：tools 提取 → `respond_in_schema` 查找 → `blockProperties` → helper → `!== undefined` 门 → `{ toolCalls: [fakeToolCall('respond_in_schema', blockAnswer, 'loop-classifier')] }`，否则继续往下。 |
| 同文件 `:3167`–`:3191`                                        | fire 臂的内联判定——除 call id `'loop-fire-classifier'` 外完全相同。                                                                                                                                                |
| `integration-tests/fake-openai-server.ts:115`                 | `fakeToolCall(name, args, id)` → `{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }`。第三参即 tool-call id。                                                                          |
| `scripts/tests/managed-agent-server-e2e.test.js:710` / `:741` | `extracted(names)` 从 runner 切出**顶层**声明并转译；`load(names, returns, ...params)` 构造注入依赖的 `new Function`。这是既有的执行机制，`:4096` 已用它执行 `classifierBlockAnswer`。                             |
| 同文件 `:157` / `:509`                                        | `loopClassifierWiring` / `loopClassifierScope`——扫描器及其 loop 回调域限定，产出十份库存。                                                                                                                         |
| 同文件 `:3890`                                                | 钉测试。既断言这十份分类器库存，**也**断言无关契约（arm 终端、body 域、caller-import 标记、sidecar 判别、union 标记）。                                                                                            |
| 同文件 `:4153` / `:4413`                                      | 被执行的敌意控制与隔离 allow 站点用例——两者都只为证明扫描器非空转而存在。                                                                                                                                          |

扫描器在本元测试之外没有消费者；其它引用只有 #17594 的历史设计记录。

## 拟议改动

### Runner：一个被执行的判定，两条委托的臂

在 `classifierBlockAnswer` 旁新增顶层纯函数：

`loopClassifierResponse(body, callId)` 对 block-schema 侧查询返回整个 fake 响应，请求不是该查询时返回 `undefined`。它执行 tools 提取、`respond_in_schema` 查找、properties 读取、经 `classifierBlockAnswer` 的收窄与门，并用 `fakeToolCall` 构造响应。两个 fake 把各自的内联块替换为委托：函数结果有定义就返回它，否则完全按今天的方式继续往下。

该函数为顶层，故既有 `extracted`/`load` 机制无需改动即可触达；`fakeToolCall` 作为依赖注入，与 `waitUntil` 注入 `inspect` 的方式相同。

### 元测试：执行判定，退役形态库存

新增一个被执行的测试，用敌意 body 驱动 `loopClassifierResponse`，断言**整个响应**——工具名、call id 与 arguments 载荷一起——或 `undefined`。敌意方向：阶段 1 与阶段 2 的 block schema；三种非 block 侧查询（title、tool-use summary、next speaker）；缺失、非数组与畸形的 `tools`；名字不是 `respond_in_schema` 的 schema 工具；多个 schema 工具而非 block schema 排在 block schema 之前，故首匹配胜出、后面的 block schema 不会补救；畸形的 `tools` 元素与非对象的 `properties`，必须落穿而非抛错；以及两个 call id，使一条臂无法在另一条的 id 下作答。

退役 `loopClassifierWiring`、`loopClassifierScope`、写入者名集与目标包装集、钉测试里的十条分类器断言、敌意控制与隔离 allow 站点用例。保留钉测试中一切与分类器判定无关的内容，并保留独立的 minted-id 面（`mintedIdWiring`、`mintedScheduleId`、fake-createdId 钉）不动。

以一条有界的委托钉取代被退役的库存，由一个逐子句命名的判据裁定，并由一个敌意源控制逐子句执行见证。该钉裁定的是**性质而非拼写**——它的第一版并非如此，评审第 1 轮把两个方向的失败都实测了出来（见下）。它要求：两次委托的 call id 按**集合**比较；两个**互异**的回调；每条 loop 臂自己的 fake 里恰有一次委托，以臂 flag 而非 id 为键，故委托被挪进 durable failover fake 或兄弟臂会被抓住，而把两个 id 在臂之间互换不会；首参是回调自身的 `body`；结果要么被直接返回（含 `??` 兜底），要么被绑定并在同一回调里针对该绑定的门分支内返回——`undefined` 测试的两种极性皆可，分支内 return 的收集**在每个函数边界止步**（函数、方法、访问器、构造器），且必须是该绑定、不得是别的；回调自身的函数体里不得有对该绑定的重写；门分支之外的 return，其表达式不得**读取**该绑定，否则无论怎么拼写都会吞掉继续往下的路径——裸标识符、`??` 兜底、展开与 shorthand 键都算读取，而只是同名的属性键不算；以及限定在这两个 loop 回调内，不得有 `respond_in_schema` 应答，也不得有「不是带字面量工具名的 `fakeToolCall`」的应答元素。应答库存按**元素**而非按 `toolCalls` 属性裁定，因为两条臂都为 cron 夹具合法地构造 `toolCalls`。每条子句的存在都因为有一个实测形状满足了它所取代的更弱形态，控制用例携带这些形态各一，并把等价改写作为正向对照。

有三项限度是披露而非追逐。该钉是**结构性**的：它是打包臂从行为上证明之事在快速通道上的近似，不是判定的第二份副本；它漏掉的接线回归仍由打包臂抓住。从「确实被调用的嵌套函数」里对绑定名的写入不在 `no-rebinding` 覆盖内，后者以回调自身的函数体为键。而从回调内调用的 helper 返回的响应，在调用点没有 `toolCalls` 属性，故应答库存看不见它——被退役的全文件计数看得见这一种，但也会把合法的第三条臂判红；限定库存范围正是用这份触达面换取「不把正确的 fake 判成缺陷」。三项残留都在已提交的 runner 上实测过，不是推断。

## 关键设计决策

- **一个按 call id 参数化的函数，而非两份副本。** 两个块除 id 外已经相同；复制它们正是「修复到达一条臂而漏掉另一条」的成因。参数化还让「一条臂在另一条的 id 下作答」成为被执行测试可断言的方向。
- **返回整个响应，而非只返回 answer。** 只断言 answer 会让工具名与 call id 无钉，而分别钉它们又会重演分散断言此前暴露过的映射弱点。对响应做一次深比较即钉住映射。
- **保留委托钉，去掉判定库存。** 快速套件跑不了打包臂，故「fake 确实委托了」需要一条廉价断言。无界家族住在判定**内部**，执行判定把这一家族直接消除。围绕它的接线是一个更小但仍然真实的 evasion 面——第 1 轮对第一版钉实测出两个方向的失败，见下表——故该钉保持小、按性质裁定，并明确从属于打包臂，而不被宣称为完备。
- **退役扫描器，而非留作「第二意见」。** 一个行为两套守卫会互相漂移，而扫描器的维护成本正是本次要移除的东西。其历史记录留在 #17594 设计文档里。
- **`undefined` 保持其确切含义。** 它表示「不是 block 侧查询，继续走 fake 的其余部分」。委托不得把它转成响应，也不得吞掉继续往下的路径。

## 评审第 1 轮：第一版委托钉本身就是形态钉

替换钉的第一版以拼写与源码顺序为键，于是它重演了自己要终结的那台跑步机——两个方向都是。下表每个形状都用「已提交的判据」与「修正后的判据」在同一份 runner 文本上实测，已提交的 runner 在两者下都读作 `[]`。

| 方向 | 形状                                                           | 第一版钉                   | 修正后                   |
| ---- | -------------------------------------------------------------- | -------------------------- | ------------------------ |
| 漏判 | loop 回调里手搭的 `toolCalls` 元素                             | `[]`                       | `no-loop-hand-built`     |
| 漏判 | 非内联数组的 `toolCalls` 源（及其 shorthand 形式）             | `[]`                       | `no-loop-hand-built`     |
| 漏判 | `fakeToolCall` 元素上的计算型工具名                            | `[]`                       | `no-loop-hand-built`     |
| 漏判 | 伪造的 body 实参，或 `body` 之外的绑定                         | `[]`                       | `argument-provenance`    |
| 漏判 | 绑定与门之间的重写                                             | `[]`                       | `no-rebinding`           |
| 漏判 | 门分支里类方法或 getter 的 return                              | `[]`                       | `result-returned`        |
| 漏判 | 委托被放进回调内一个死类成员                                   | `[]`                       | `arm-scoping`            |
| 漏判 | 委托被挪进 durable failover fake                               | `[]`                       | `arm-scoping`            |
| 漏判 | 门之后的 return 吞掉继续往下的路径                             | `[]`                       | `fall-through-preserved` |
| 漏判 | 同一吞掉写成 `classified ?? fixture` 或 `{ ...classified }`    | `[]`                       | `fall-through-preserved` |
| 误红 | `if (loopFire)` 块移到 `if (loopSkill)` 之前                   | `call-ids`                 | `[]`                     |
| 误红 | 两个 call id 在臂之间互换                                      | `call-ids`                 | `[]`                     |
| 误红 | `return loopClassifierResponse(...) ?? { content: 'fixture' }` | `result-bound`             | `[]`                     |
| 误红 | `=== undefined` 门从 else 分支返回                             | `returned-under-own-guard` | `[]`                     |
| 误红 | 判定写成箭头常量                                               | `single-answer-site`       | `[]`                     |
| 误红 | 合法的第三个 fake 应答 title 侧查询                            | `single-answer-site`       | `[]`                     |

处置是按性质而非拼写裁定——id 按集合、臂按「以臂 flag 为键的多重集」、门的两种极性、直接返回的调用表达式、限定在 loop 回调内且按元素裁定的应答库存——并为每个实测漏判补一条有界子句。不是合法 TypeScript 的形状按实测排除：setter 返回值是 `TS2408`，构造器返回委托值是 `TS2322`/`TS2409`，故两者都不作夹具；setter 的函数边界析取项改由「来自 setter 的写入」见证，该写入**不得**算作对回调绑定的重写。

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

本改动只涉及测试基础设施，故承重证据是：被执行的判定测试在变异下对每个敌意方向打红（additive fallback、伪造 schema、错误 call id、去掉门）；委托钉的每条子句在「单独删掉它」或「把它收窄回去」时打红，接受等价改写的那些子句也一样；退役那些库存不削弱任何存活钉子；以及重建后两条打包臂仍通过，fire 臂的 scheduled/fired/completed 见证完好。

委托钉的子句逐条见证，而非整块见证：整条删除可能被兄弟子句杀掉，而对它做一处记号的收窄却仍能全绿——第一版钉的 `guard.returns.includes(...)` 与 `guard.name` 检查正是这样躲过评审第 1 轮自己的变异的。

## 开放问题

无阻塞项。函数留在 runner 而非移到共享模块，因为 `extracted` 从该文件切顶层声明，移走会需要一个新的 loader 而无收益。
