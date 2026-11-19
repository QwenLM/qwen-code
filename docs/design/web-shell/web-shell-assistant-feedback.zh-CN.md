# Web Shell 助手回答的满意/不满意标记

[English](web-shell-assistant-feedback.md) | [简体中文](web-shell-assistant-feedback.zh-CN.md)

状态：本次改动已实现。

## 问题

读完一条回答后，读者没有办法告诉 Web Shell 这条回答是否令人满意。CLI 的 TUI 已有
一个反馈弹窗，但它问的是整个会话、而不是某一轮，且任何其他客户端都无法记录"针对某一条
具体回答"的态度。

嵌入 Web Shell 的宿主也没有地方挂这个信号：既有的回答底部扩展点只能把宿主内容渲染到
操作行**上方**的独立块里，宿主没法把控件放到内置"复制"按钮旁边。

## 目标

- 让读者能在回答自己的操作行里、紧挨复制的右侧，把这一轮标记为满意或不满意。
- 标记之后一直可见，读者能看见自己选了什么。
- 让宿主能得知每一次标记，同时不让宿主成为界面状态的来源。
- 其他所有客户端与 daemon 协议零改动。

## 非目标

- 不做服务端持久化。标记不写入会话记录，别的浏览器、设备或客户端读不到。
- 不发遥测。标记不会发出 `UserFeedbackEvent` 或任何分析事件，也不受使用统计开关约束。
- 不引入 `promptId` 锚点、不新增 daemon 路由、不改 daemon 的 transcript 投影与线格式。
- 不接受宿主传入初始状态：宿主无法预置或覆盖标记。
- 不做逐轮可见性控制：宿主只能整体开或关。

## 设计

### 位置

标记渲染在"已完成助手轮次"的操作行里，紧跟复制按钮之后，位于分叉按钮、来源与时间戳
之前。它们出现的位置与复制按钮完全相同——已完成、不在流式中、且是该轮最终回答的那条，
且只在可交互的 transcript 中。

### 交互

| 当前标记 | 点击   | 结果               | 回调里的 `rating` |
| -------- | ------ | ------------------ | ----------------- |
| 无       | 满意   | 满意亮             | `up`              |
| 满意     | 不满意 | 满意熄灭、不满意亮 | `down`            |
| 不满意   | 不满意 | 熄灭，回到未评     | `null`            |

两个标记互斥。每一次变化都回调宿主一次，**包括回到未评**这一次。宿主是"监听者"：标记
先落到界面上，回调随后执行，宿主在回调里做什么——抛错、拒绝、弹出一个读者最终没提交的
对话框——都不改变这个标记。

被标记的那一轮按方向着色——满意为蓝色，不满意为红色——图标尺寸调成与内置的复制、分叉
同一视觉重量。颜色在 hover 与键盘聚焦下都保持：这行只在 hover 时出现，若鼠标一停上去
颜色就被盖回灰色，方向色实际上永远读不到。

操作行保持原有的 hover 行为：标记不会让它常显。这一点需要额外一步——指针点击会给按钮
留下焦点，而该行的 `:focus-within` 规则会因此在指针移开后仍把它撑开。指针点击会主动释放
焦点；键盘激活则保留，这样不用鼠标也能继续操作这一行。

### 状态与存储

标记归 Web Shell 所有。状态放在消息列表**里**、而不是每一行里，因为 transcript 会虚拟滚动，
滚出视野的行会被卸载。

- 存储键：`qwen-web-shell-assistant-feedback`，单条带版本的 JSON：
  `{ v: 1, <sessionId>: { <promptId>: 'up' | 'down' } }`。
- 键用的是该轮**准入时的 prompt id**，不是 transcript 块 id。原因与"拿不到时怎么办"见
  下面的"轮次身份"。
- 最多保留 `MAX_ASSISTANT_FEEDBACK_SESSIONS`（10）个会话，最先丢弃最旧的；编辑某个会话
  会把它移到最新位置，避免"正在使用的会话被邻居挤掉"。
- 清掉某会话的最后一个标记时，该会话的条目一并删除。

存储是尽力而为。隐私模式或嵌入环境可能完全拒绝 `localStorage`，手改过或未来版本的载荷
也可能解析不出来：写入永不抛错，读取在解析不了时退化为"没有任何标记"，而不是猜。所有
失败模式下，点击照常生效、宿主照常收到回调，丢掉的只是"刷新之后的记忆"。

### 轮次身份

块 id 不是身份：transcript reducer 按 `<kind>-<序号>` 发号，序号是每次投影从 1 开始的
计数器，所以块 id 取决于"这份记录是怎么加载的"，而不是它承载了什么。因此标记以 daemon 的
`promptId` 为键——那是 daemon 在 prompt 准入时铸的 uuid，同时会被持久化到该轮的
`turn_result` 记录里，也是 daemon 寻址一轮用的值（`GET /session/:id/turns/:promptId`）。

这个值落在哪些块上，取决于 transcript 走哪条路来——这两条路是**端到端实测**过的，不是推断：

- **live**：assistant 块带它，值等于 prompt 准入时返回的 id。
- **重放**（打开会话、刷新、翻页——daemon 的 `historyPageSize` 路径）：assistant 块**完全
  没有** `promptId`，只有 `user_message_chunk` 带，且它等于该轮落盘的记录。
- 若刷新命中的是 daemon 的内存快照而非持久化重放，assistant 块又会重新带上它——所以到底
  来哪一种并不固定。

客户端因此取 `answer.promptId ?? headUserMessage.promptId`：只要有一侧存在，两侧就是同一个
值；两侧都没有的轮次干脆不提供标记。另一个推论是**标记不随分叉携带**：分叉会刻意排除
`turn_result` 记录，避免新会话继承来源的 prompt 身份。

### 宿主 API

```ts
customization.assistantFeedback?: {
  enabled?: boolean;             // 置 false 可再次隐藏标记
  onRate?: (info: {
    rating: 'up' | 'down' | null;         // 取消标记时为 null
    previousRating?: 'up' | 'down';
    sessionId?: string;                   // 哪一次会话
    promptId: string;                     // 会话里的哪一轮
    userMessage: {
      text: string;                       // prompt 的尾部，或它携带了什么
      timestamp?: number;                 // prompt 的时间（epoch 毫秒）
    };
  }) => void;
};
```

`sessionId` 定位会话、`promptId` 定位会话内的一轮——与 daemon 自己的轮次路由所需的是同一
对；只给其中一个都不够。

`userMessage.text` 是该 prompt **最新的 100 个字符**（先 trim），因为在一份标记列表里，
区分两条 prompt 靠的是尾部。当这条 prompt 完全没有文字时，改为报告它携带了什么：有图片
就是 `[图片]`，有附件就是 `[附件]`，两者都有则用空格连接。这两个占位符是字面量、**不随
界面语言变化**，因为宿主是把它当数据消费的。shell 轮的 prompt 就是它的命令，因此这些轮次
的 `text` 是那条命令。

宿主把它作为 `assistantFeedback` prop 传给嵌入的 `WebShell`，由后者转发进 customization
上下文。传入这个对象即显示标记；不传则回答底部与今天完全一致，这正是老宿主零变化的原因。
载荷类型已从包的入口导出，宿主可以给它们命名。本仓库自己的独立应用**不**开启它，所以标记
只在宿主传入配置项时出现——这是刻意的，因为独立应用没有宿主可通知。

只有在**有会话 id 的可交互 transcript** 中才会提供标记，因此只读与嵌入的 transcript 渲染
永远不显示它们——冻结的历史视口也一样，它会丢掉会话 id，于是在"复制"仍在的回答上不显示
标记。

## 决策与理由

- **内建在回答操作行，而不是交给宿主渲染。** 既有的 `renderAssistantTurnFooter` 渲染在
  操作行**上方**的独立块里，无法把控件放到复制旁边；而且会让每个宿主各自重做点亮、互斥、
  hover 这些行为。内建路径只有一份实现，宿主用一个对象即可开启。
- **宿主只被通知，不被询问。** 若宿主能否决或回滚标记，图标状态就会依赖一次网络往返，
  也会把"读者选了什么"的记录推到客户端之外。只通知，才能让点击即时且终局。
- **用本地存储而不是会话记录。** 服务端持久化需要新增 daemon 写入路由、在所有客户端都读
  的会话文件里新增记录类型、再加一条读回投影——远超本功能的量级，并且会重新打开"用户数据"
  与"遥测开关口径"的问题。刻意做成局部的标记，先拿到可见行为，同时把升级路径留着。
- **不复用 TUI 的 `UserFeedbackEvent`。** 那个事件是会话级、三值（`bad`/`fine`/`good`）、
  没有"已取消"状态，且它的写入函数同时向遥测出口发送。复用它会把一个界面开关绑到分析出口上，
  而且仍然表达不了"每轮一个标记"。

## 约束

- 标记以会话 + 轮次为键，两者都必须有。没有会话 id 的 transcript 不提供标记，而不是接受
  一次存不下来的点击。
- 两个标签页、或分屏的两个 pane，不会实时同步，而且每次写入都会替换整份存储：各自按挂载
  时读到的存储渲染，一个实例里的标记可能被另一个实例的写入抹掉。
- 会话被删除、回退或分叉后，它的标记会留到被"10 个会话"上限挤掉为止，且绝不会显示在
  别的会话里。

## 风险

- 若宿主自己也持久化了一份标记，两份记录可能不一致——例如宿主删掉或迁移了自己的那份。
  客户端这份是展示状态，永远不读宿主那份。
- 取消标记会删除存储条目，因此不保留"读者改过主意"的历史。

## 涉及文件

| 文件                                                                        | 改动                                                                                |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `packages/web-shell/client/adapters/messageTypes.ts`                        | 声明渲染用消息上的 `promptId` 字段。                                                |
| `packages/web-shell/client/adapters/transcriptToMessages.ts`                | 一趟后处理：把贡献块的 id 复制到由它们构建出的消息上。                              |
| `packages/web-shell/client/utils/assistantFeedback.ts`                      | 存储形态、裁剪、容错读取、尽力写入、是否提供标记的判定、prompt 摘要、宿主通知封装。 |
| `packages/web-shell/client/hooks/useAssistantFeedback.ts`                   | 持有一个会话的标记并持久化。                                                        |
| `packages/web-shell/client/components/messages/AssistantMessage.tsx`        | 在回答操作行渲染两个标记。                                                          |
| `packages/web-shell/client/components/messages/AssistantMessage.module.css` | 标记图标的按方向着色，以及与相邻图标对齐的字形尺寸。                                |
| `packages/web-shell/client/components/MessageItem.tsx`                      | 把某一行绑定到它的轮次与 prompt id。                                                |
| `packages/web-shell/client/components/MessageList.tsx`                      | 承载状态、解析每轮的 prompt id、组装宿主载荷。                                      |
| `packages/web-shell/client/customization.tsx`                               | `assistantFeedback` 配置项及其载荷类型。                                            |
| `packages/web-shell/client/i18n.tsx`                                        | `assistant.satisfied` 与 `assistant.dissatisfied`。                                 |
| `packages/web-shell/client/index.tsx`                                       | 从包的入口导出载荷类型。                                                            |
| `packages/web-shell/client/App.tsx`                                         | 把宿主的配置项转发进 customization 上下文。                                         |

## 验证

单元测试：

- `utils/assistantFeedback.test.ts`：往返读写、容错读取（非 JSON、未知取值、版本不符、
  `localStorage` 抛错且带正向控制）、写入永不抛错、裁剪与重排、标记/切换/取消、判定函数的
  五个分支、prompt 摘要（尾部长度、trim、附件与图片占位符、未知 prompt）、通知封装的抛错隔离。
- `adapters/transcriptToMessages.test.ts`：prompt id 后处理会把带戳块上的值盖到消息上，
  且不会给没有戳的块编造一个。
- `hooks/useAssistantFeedback.test.tsx`：没有宿主动调时标记即刻生效、回调带
  `previousRating`、重复点击取消、重新挂载后标记恢复、标记按会话隔离。
- `components/messages/AssistantMessage.test.tsx`：未开启时不渲染、`aria-pressed` 投影、
  按方向的着色类名、指针点击与键盘激活的焦点差异、点击回调载荷、中英标题。

"轮次身份"一节里 live 与重放的差异，是**对着真实 daemon 与真实浏览器端到端实测**出来的，
不是从 reducer 推的：同一轮的 assistant 块在流式时带准入 id，走持久化重放后则不带；而
prompt 自己的块在两种情况下都带落盘值。正因如此，键才回退到 prompt 的块而不是回答的块。

门禁：`prettier`、`eslint --max-warnings 0`、`tsc --noEmit`，以及 `packages/web-shell`
全量套件全部通过。

人工：视觉效果由使用者本人在运行中的开发页面确认。新增文案为英文
`Satisfied` / `Not satisfied`，中文 `满意` / `不满意`，同时用作 tooltip 与无障碍名称。

## 验收标准

- 传入配置项且存在会话 id 时，标记只出现在可交互轮次里那条最终、已完成、不在流式中的回答上，
  不出现在任何其他行。
- 点击标记会点亮它并回调宿主一次，`previousRating` 是点击之前的值；再次点击点亮的标记会取消
  它，并以 `rating: null` 回调。
- 同一会话刷新后标记仍在，且绝不会显示在别的会话里。
- 不传配置项，或渲染只读 / document transcript，都不显示标记，回答底部的其他部分不变。

## 后续事项

- 服务端持久化仍未实现：标记只存在这个浏览器里。将来要做，需要新增一条 daemon 路由写入、
  再通过投影读回——键（`sessionId` + `promptId`）与本文档里的载荷已经带齐了这样的记录所需
  的内容。
- TUI 的反馈弹窗把选项编号为 `GOOD: 1, BAD: 2, FINE: 3`，而遥测枚举是
  `BAD = 1, FINE = 2, GOOD = 3`，中间是裸强转、没有重映射，因此记录下来的 rating 是错位
  的。这是遥测路径上一个既有缺陷，与本功能无关，本次刻意不予改动。
