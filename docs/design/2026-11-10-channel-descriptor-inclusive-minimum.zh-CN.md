# 渠道配置描述符：包含式下界

[English](2026-11-10-channel-descriptor-inclusive-minimum.md) | [简体中文](2026-11-10-channel-descriptor-inclusive-minimum.zh-CN.md)

状态：提案。闭合 #16690 验证轮留下的最后一条非阻塞项。

## 问题陈述

真实下界是 **0** 的数字字段无法这样表达。描述符词汇表只提供 `exclusiveMinimum`，因此 GitHub channel 的 `prWatchBudgetReserve` 写成 `exclusiveMinimum: -1` 来放行 0 —— 而这同时放行了 `(-1, 0)` 区间内的一切。

于是两层对 `-0.5` 的判断不一致：

| 层                                     | 判据                              | `-0.5`   |
| -------------------------------------- | --------------------------------- | -------- |
| 编辑器（`channel-editor-state.ts`）    | `parsed <= exclusiveMinimum` 才拒 | **放行** |
| 适配器（`validateBoundSessionConfig`） | `reserve < 0` 就拒                | **拒绝** |

操作者输入 `-0.5`，表单不报错，保存却失败。范围文案还加剧了这一点：它把下界报成 `-1` —— 一个校验器并不强制的界，且措辞让 `-0.5` 读起来像合法值。

## 现状

- `ChannelConfigNumberFieldDescriptor` 声明了 `exclusiveMinimum` 与 `maximum`，没有包含式下界。
- 编辑器用 `parsed <= exclusiveMinimum` 校验，并把同一个数字插值进 `channels.editor.validation.outOfRange`。
- 适配器的 `reserve < 0` 检查是当初为补偿这个词汇缺口而刻意加的，其注释也这样写着。

## 方案

给数字描述符加可选的 `minimum`，在编辑器校验与范围文案中尊重它，并把 `prWatchBudgetReserve` 声明为 `minimum: 0`。

适配器检查**保留**。它并不冗余：配置也会来自手改的 `settings.json` 与 daemon API 调用，两者都不经过编辑器。删掉它会把一次词汇修复变成那些路径上的校验回归。

## 设计决定与理由

**增量词汇，而非替换。** `exclusiveMinimum` 含义不变，既有描述符一处不动。`minimum` 是可选的，因此对发布到 npm 的包向后兼容 —— 不改导出形状，不强迫任何消费者迁移。

**两个下界可以同时声明，边界处取更严者。** 校验拒绝 `parsed <= exclusiveMinimum` **或** `parsed < minimum`，无需优先级规则即可正确复合。文案报出更严的那个下界；相等时取排他界，因为它连等值也拒绝。

**文案不得凭空造出下界。** 既有三分支形状逐字保留：只声明 maximum 的字段仍只说「不超过 N」，不带下界子句。新的包含式措辞是并列新增，而不是揉进一次会开始对未声明下界的字段断言「大于 0」的重写。

## 涉及文件

| 文件                                                                    | 改动                                      |
| ----------------------------------------------------------------------- | ----------------------------------------- |
| `packages/channels/base/src/types.ts`                                   | 数字描述符上的可选 `minimum`。            |
| `packages/sdk-typescript/src/daemon/types.ts`                           | SDK 线上镜像类型上的同一可选字段。        |
| `packages/cli/src/commands/channel/channel-registry.ts`                 | 注册期守卫校验这个新下界。                |
| `packages/cli/src/serve/channel-settings-store.ts`                      | daemon 基于描述符的校验尊重该下界。       |
| `packages/web-shell/client/components/channels/channel-editor-state.ts` | 拒绝低于包含式下界的值。                  |
| `packages/web-shell/client/components/channels/ChannelEditorDialog.tsx` | 报出生效的下界。                          |
| `packages/web-shell/client/i18n.tsx`                                    | 包含式措辞，中英双版。                    |
| `packages/channels/github/src/index.ts`                                 | 预留字段改为 `minimum: 0`；更正要求子句。 |
| `packages/channels/github/src/GithubAdapter.ts`                         | 注释：该检查现在是兜底，而非补偿。        |

## 约束与风险

- 适配器的负值检查对不经编辑器的路径是承重的，不得以「现在冗余了」为由删除。
- 其它 channel 在真实下界确为排他处仍保留 `exclusiveMinimum: 0`；本改动不迁移它们。
- 同时声明两个下界的描述符合法但少见；复合规则由用例钉住，而不是留给阅读顺序去推断。

## 验证计划

- daemon 存储：低于包含式下界的值在 upsert 时被拒，下界本身被放行。这个消费者是靠枚举下界的读取方找到的，不是原始报告点名的——不补它，把字段从 `exclusiveMinimum: -1` 改成 `minimum: 0` 会静默丢掉 daemon 描述符级的下界。
- 编辑器状态：低于包含式下界的值被拒，下界本身与正分数被放行。
- 编辑器状态：两个下界都声明时，由更严者裁决。
- 对话框：包含式下界措辞为「不小于 N」，且不出现排他式措辞。
- 描述符：预留字段声明 `minimum: 0` 且不带 `exclusiveMinimum`。
- 适配器：负值、非数字与 NaN 仍被拒；0 与正分数仍通过。
- 注册期：非有限的 `minimum`、非数字字段上的 `minimum`、以及低于包含式下界的 `maximum`，各自在注册时被拒。

五处运行时修复站点各有变异见证：去掉 daemon 分支、去掉编辑器分支、强制排他式措辞、退回 `exclusiveMinimum: -1`、停用注册守卫，各自恰好让对应用例变红。SDK 类型镜像没有可变异的行为，由类型检查钉住——而缺失的镜像正是这样被发现的：单元套件会剥掉类型，没有它照样全绿。

### 靠枚举而非报告找到的消费者

原始发现只点名了编辑器与适配器。逐个走查消费者又找出三个读取方，其中两个会成为静默回归：

- **daemon 存储**独立于编辑器、按描述符校验。把字段改成 `minimum: 0` 却不教会它这个下界，会让该层的下界整个消失。
- **注册期守卫**本会放行非有限或放错位置的 `minimum`，以及低于它的 `maximum`。
- **SDK 线上镜像**是另一份手写接口。没有它 web-shell 无法编译——这是 `npm run build` 抓到的，任何测试都没抓到。

## 验收标准

- `-0.5` 在保存前就被编辑器拒绝，与适配器一致。
- `0` 仍能禁用该门，且两层都接受。
- 范围文案报出的是校验器真正强制的下界。
- 既有描述符含义不变；已发布的导出形状不变。
