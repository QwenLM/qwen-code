# Banner 自定义区域设计方案

> 允许用户替换 QWEN ASCII Logo、替换品牌标题、整体隐藏 Banner ——
> 但不允许抹掉用于排障与可信度的运行时信息（版本号、鉴权方式、模型、
> 工作目录）。

## 概述

Qwen Code CLI 启动时会在终端顶部打印一个 Banner，包含 QWEN ASCII
Logo 和一个带边框的信息面板。多种真实场景需要对这一区域进行控制：

- **白标 / 第三方品牌集成**：将 Qwen Code 嵌入企业或团队自有产品时，
  需要展示自家品牌而非默认的 "Qwen Code"。
- **个性化**：个人用户希望让终端 Banner 与团队规范或个人审美一致。
- **多租户 / 多实例区分**：在共享环境下，不同团队希望快速辨认自己
  正在使用哪个实例。

设计立场十分简单：**品牌外观可替换；运行时信息不可替换**。
自定义只允许用户把自己的品牌叠在上面，**不允许**屏蔽用于排障的关键
信息。本文档后续每一处「可改 / 不可改」的判定都来自这一立场。

对应 issue：[#3005](https://github.com/QwenLM/qwen-code/issues/3005)。

## Banner 区域划分

当前 Banner 由 `Header`（由 `AppHeader` 挂载）渲染，整体可拆分如下：

```
  marginX=2                                                           marginX=2
  │                                                                          │
  ▼                                                                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   ┌──── Logo 列 ─────────┐  gap=2  ┌──── 信息面板 (带边框) ──────────────┐  │
│   │                      │         │                                     │  │
│   │  ███ QWEN ASCII ███  │         │  ① 标题：    >_ Qwen Code (vX.Y.Z)  │  │
│   │  ███   ART ART  ███  │         │  ② 副标题：  «空白行 / 自定义覆盖» │  │
│   │  ███ QWEN ASCII ███  │         │  ③ 状态：    Qwen OAuth | qwen-…    │  │
│   │                      │         │  ④ 路径：    ~/projects/example     │  │
│   └──────── A ───────────┘         └──────────────── B ──────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                              区域归属：AppHeader
                          │ Tips 组件渲染在下方（由 ui.hideTips 控制） │
```

两个顶级区块：

- **A. Logo 列** —— 单块带渐变色的 ASCII art。
  当前来源：`packages/cli/src/ui/components/AsciiArt.ts` 中的
  `shortAsciiLogo`。
- **B. 信息面板** —— 带边框的信息盒，共四行。第二行默认是空白视觉
  spacer，可选地切换为调用方提供的副标题：
  - **B①** 标题：`>_ Qwen Code (vX.Y.Z)` —— 品牌文字 + 版本号后缀。
  - **B②** 副标题 / spacer：默认是单空格行，设置 `ui.customBannerSubtitle`
    后渲染清洗后的单行副标题字符串（例如某个 fork 用
    `Built-in DataWorks Official Skills`）。
  - **B③** 状态：`<鉴权显示类型> | <模型> ( /model 切换)`。
  - **B④** 路径：经过 tildeify 与缩短的工作目录。

外层 `<AppHeader>` 已经基于 `showBanner = !config.getScreenReader()`
对 Banner 做了屏读模式下的整体隐藏处理（屏读模式下回退为纯文本输出）。

## 自定义规则 —— 哪些可改，哪些被锁定

| 区域                               | 当前来源                             | 自定义类别              | 锁定/开放原因                                                                                                                                            |
| ---------------------------------- | ------------------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Logo 列**                     | `shortAsciiLogo` (`AsciiArt.ts`)     | **可替换 + 可自动隐藏** | 纯品牌区域。白标场景需要完全控制视觉。窄终端下「自动隐藏 Logo」的现有行为保持不变。                                                                      |
| **B①. 标题文字**（`>_ Qwen Code`） | `Header.tsx` 硬编码                  | **可替换**              | 品牌区域。开头的 `>_` 字符是现有品牌的一部分；如不需要，用户在 `customBannerTitle` 中省略即可。                                                          |
| **B①. 版本号后缀**（`(vX.Y.Z)`）   | `version` prop                       | **锁定**                | 排障与支持必备。隐藏后只能通过 `--version` 才能回答「你用的什么版本？」，对支持流程是真实成本。我们以小幅白标体验损失换取支持可达性。                    |
| **B②. 副标题 / spacer 行**         | 默认空白                             | **可替换**              | 纯品牌 / 上下文区域。白标 fork 用它给构建版本打 tag（如 "Built-in DataWorks Official Skills"）。清洗规则与标题一致；只允许单行，不接受会破坏布局的换行。 |
| **B③. 状态行**（鉴权 + 模型）      | `formattedAuthType`、`model` prop    | **锁定**                | 运营与安全信号。用户必须看到当前使用的凭据以及实际消耗 token 的模型。任何隐藏/替换都是 footgun，即便在白标场景下也不应允许。                             |
| **B④. 路径行**（工作目录）         | `workingDirectory` prop              | **锁定**                | 运营信息。「我现在在哪个目录？」是高频问题；Banner 是其唯一权威答案。                                                                                    |
| **整个 Banner** (A + B)            | `AppHeader.tsx` 中 `<Header>` 挂载点 | **可隐藏**              | 一个 `ui.hideBanner: true` 同时跳过 A、B 两个区块 —— 形态与现有屏读模式开关一致。`<Tips>` 仍由独立的 `ui.hideTips` 控制。                                |

上述矩阵对应四个设置项，仅此而已：

| 设置                      | 默认值  | 效果                                                                                                 | 影响区域     |
| ------------------------- | ------- | ---------------------------------------------------------------------------------------------------- | ------------ |
| `ui.hideBanner`           | `false` | 隐藏整个 Banner（区域 A + B）。                                                                      | A + B        |
| `ui.customBannerTitle`    | 未设置  | 替换 B① 的品牌文字。版本号后缀照常追加。会被 trim；空字符串 = 使用默认。                             | B① 品牌文字  |
| `ui.customBannerSubtitle` | 未设置  | 用一行副标题替换 B② 的空白 spacer。会被清洗；上限 160 字符；空字符串 = 保留空白 spacer（向后兼容）。 | B② spacer 行 |
| `ui.customAsciiArt`       | 未设置  | 替换区域 A。支持三种数据形态（见下文）。任何错误均回退为默认。                                       | A            |

**有意不提供**的能力：

- 不提供「仅隐藏版本号后缀」的开关。
- 不提供「仅隐藏鉴权/模型行」的开关。
- 不提供「仅隐藏路径行」的开关。
- 不提供 Logo 渐变颜色的修改入口（颜色由 theme 负责）。
- 不提供调整信息面板顺序或结构的能力。

如果未来确有需求，应作为新字段单独走方案评估，而不是从上述三个字段
派生出来。

## 用户配置指南 —— 如何修改

### 限制总览

每次 banner 自定义都会受这几组上限约束。手写 art 前先看一遍，免得被
解析器静默截断或拒绝。

| 项目                         | 上限                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **标题字符数**               | **80 字符上限**（清洗后计数）。超出截断并打 `[BANNER]` warn。换行符与控制字符在计数前已被剥离。                |
| **副标题字符数**             | **160 字符上限**（清洗后计数）。清洗管线与标题一致；超出截断同样打 `[BANNER]` warn。                           |
| **ASCII art 块尺寸**         | **每档 200 行 × 200 列上限**。超出截断并打 `[BANNER]` warn。                                                   |
| **ASCII art 文件大小**       | **64 KB 上限**。文件大于上限时只读取上限以内的字节，剩余忽略。                                                 |
| **ASCII art 实际可渲染宽度** | 由启动时终端列数决定，**不是固定字符数**。具体公式与各种终端宽度下的可用值见下文「Logo 能多大？—— 宽度预算」。 |

ASCII art **没有固定的字符数上限** —— 只有上面这两组列/行硬上限以及
启动时按终端列数计算的宽度预算。同样 17 字符的品牌名，换字体后能不能
单行渲染下来，取决于视觉宽度而不是字母数。

### 配置存放位置

四个设置都位于 `settings.json` 的 `ui` 节点下。同时支持用户级
（`~/.qwen/settings.json`）和工作区级（项目根目录的
`.qwen/settings.json`），按标准合并优先级生效（workspace 覆盖
user，system 覆盖 workspace）。

`customAsciiArt` 是特例：解析器不把整个对象当成一个值由更高优先级的
scope 直接替换，而是按 tier 逐个穿越所有 scope。如果 user 设置定义
了 `{ small }`、workspace 设置定义了 `{ large }`，两边都会生效 ——
`small` 取自 user，`large` 取自 workspace。这样能同时满足两件事：

1. 每个 `{ path }` 项相对于声明它的那个文件解析（workspace `.qwen/`
   vs. user `~/.qwen/`）；只看 merged 视图就丢失了 scope 信息。
2. 用户可以把默认的 `large` tier 留在个人设置里，按工作区只覆盖
   `small`，而不必每次重写整个对象。

同一 tier 在多个 scope 都定义时，仍按正常优先级生效（system >
workspace > user）。在任意 scope 把 `customAsciiArt` 设为单条字符串
或 `{ path }` 时，仍然会同时填充该 scope 的两个 tier。

### 整体隐藏 Banner

```jsonc
{
  "ui": {
    "hideBanner": true,
  },
}
```

启动输出会跳过 Logo 列和信息面板。除非也设置了 `ui.hideTips`，否则
Tips 仍会显示。

### 替换品牌标题

```jsonc
{
  "ui": {
    "customBannerTitle": "Acme CLI",
  },
}
```

信息面板将渲染为 `Acme CLI (vX.Y.Z)`。设置自定义标题后默认不再带
`>_` 字符；如需保留，请自己写进去：
`"customBannerTitle": ">_ Acme CLI"`。

### 添加品牌副标题

```jsonc
{
  "ui": {
    "customBannerSubtitle": "Built-in DataWorks Official Skills",
  },
}
```

副标题会以次要文字色单独成一行，**取代**默认的空白 spacer 行（即原本
位于标题与鉴权 / 模型行之间那一行）：

```
┌─────────────────────────────────────────────────────────┐
│ DataWorks DataAgent (vX.Y.Z)                            │  ← B① 标题
│ Built-in DataWorks Official Skills                      │  ← B② 副标题
│ Qwen OAuth | qwen-coder ( /model 切换)                  │  ← B③ 状态
│ ~/projects/example                                      │  ← B④ 路径
└─────────────────────────────────────────────────────────┘
```

约束：

- 仅允许单行。换行符以及其他控制字节会被剥离 / 折叠为空格，避免
  粘贴事故撕坏信息面板布局。
- 清洗后上限 160 字符（比标题宽松一些 —— 副标语 / "powered by" 之
  类的文案常常会比品牌名长）。
- 留空（或设置为空字符串 / 全空白）= 保留默认的空白 spacer 行 ——
  向后兼容是默认行为。
- 副标题不会改变锁定行的行为；鉴权、模型与工作目录始终可见，与副
  标题状态无关。

### 替换 ASCII art —— 内联字符串

```jsonc
{
  "ui": {
    "customAsciiArt": "  ___  _    _  ____ \n / _ \\| |  / |/ _\\\n| |_| | |__| | __/\n \\___/|____|_|___|",
  },
}
```

JSON 字符串中用 `\n` 表示换行。该 ASCII art 会与默认 Logo 一样应用
当前主题的渐变色。

> **手头没有 ASCII art？** 任何外部生成器都行，把生成结果粘贴
> 进来即可。最简路径是 `figlet`：
> `npx figlet -f "ANSI Shadow" "xxxCode" > brand.txt`，然后把
> `customAsciiArt: { "path": "./brand.txt" }` 指向该文件。CLI **不会**
> 在运行时把文案渲染成 ASCII art —— 原因见下文「不在本设计范围内」。

### 替换 ASCII art —— 外部文件

```jsonc
{
  "ui": {
    "customAsciiArt": { "path": "./brand.txt" },
  },
}
```

避免在 JSON 中转义大段多行字符串。路径解析规则：

- **工作区级设置**：相对路径相对于 workspace 的 `.qwen/` 目录。
- **用户级设置**：相对路径相对于 `~/.qwen/`。
- 绝对路径直接使用。
- 文件**仅在启动时读取一次**，经过清洗后写入缓存。会话进行中修改
  文件不会重新渲染 —— 请重启 CLI。

### 替换 ASCII art —— 宽度自适应

```jsonc
{
  "ui": {
    "customAsciiArt": {
      "small": "  ACME\n  ----",
      "large": { "path": "./brand-wide.txt" },
    },
  },
}
```

终端足够宽时优先使用 `large`；否则使用 `small`；再否则隐藏 Logo 列
（沿用当前的双列回退策略）。`small` 与 `large` 各自既可以是字符串
也可以是 `{ path }`。任意一档可省略：缺失时直接进入下一档。

### Logo 能多大？—— 宽度预算

标题和 art 都没有"字符数硬上限"，只有由终端列数决定的**宽度预算**，
以及防止畸形输入冻结布局的绝对硬上限：

| 项                                 | 上限                                            |
| ---------------------------------- | ----------------------------------------------- |
| 启动时终端列数                     | 用户终端报告多少就是多少。                      |
| 容器外边距                         | 4 列（左 2 + 右 2）。                           |
| Logo 列与信息面板之间的间距        | 2 列。                                          |
| 信息面板最小宽度                   | 44 列（40 路径 + 边框 + 内边距）。              |
| **每档 art 在渲染时的可用宽度**    | `终端列数 − 4 − 2 − 44 = 终端列数 − 50`。       |
| 单档 art 清洗后的硬上限            | 200 列 × 200 行。超出截断并打 `[BANNER]` warn。 |
| `customBannerTitle` 清洗后的硬上限 | 80 字符。超出截断并打 `[BANNER]` warn。         |

常见终端宽度对应的 logo 上限：

| 终端列数 | 可渲染最大 logo 宽度 | 实际意味着什么                                          |
| -------- | -------------------- | ------------------------------------------------------- |
| 80       | 30                   | 大部分 figlet "ANSI Shadow" 字母 7–11 列，最多 3 个字。 |
| 100      | 50                   | ANSI Shadow 写一个短词（约 6 字母）或两个短词堆叠。     |
| 120      | 70                   | 多行单词堆叠的 art 完全够。                             |
| 200      | 150                  | 单行长串（例如完整产品名的 ANSI Shadow）也能装下。      |

设计 art 时的两条经验法则：

1. **多单词品牌名通常无法在多数终端上用一行 ANSI Shadow 渲染。**
   ANSI Shadow 每字母约 7–9 列，即便像 `Custom Agent` 这样 12 字符的
   品牌名，单行就要约 95 列 art —— 100 列的终端在装下信息面板后已经
   不够。要么把单词换行堆叠，要么换更窄的 figlet 字体，要么直接用
   紧凑的单行装饰，例如 `▶ Custom Agent ◀`。
2. **当单档既要"宽屏好看"又要"窄屏不死"时，用 `{ small, large }`
   宽度自适应形态**。下面这个例子里 `large` 是 ≥ 104 列终端用的堆叠
   多行 art，`small` 是 16 列的单行装饰，窄到装不下两者就直接隐藏
   logo 列。

```jsonc
{
  "ui": {
    "customBannerTitle": "Custom Agent",
    "customAsciiArt": {
      "small": "▶ Custom Agent ◀",
      "large": { "path": "./banner-large.txt" },
    },
  },
}
```

`banner-large.txt` 里放堆叠后的 ANSI Shadow 输出（约 54 列 × 12 行），
可以用下面的命令生成：

```bash
( npx figlet -f "ANSI Shadow" CUSTOM
  npx figlet -f "ANSI Shadow" AGENT ) > banner-large.txt
```

### 三项组合

```jsonc
{
  "ui": {
    "hideBanner": false,
    "customBannerTitle": "Acme CLI",
    "customAsciiArt": {
      "small": "  ACME\n  ----",
      "large": { "path": "./brand-wide.txt" },
    },
  },
}
```

### 如何验证

1. 保存 `settings.json`，重新启动 `qwen` —— Banner 解析仅在启动时
   运行一次。
2. 调整终端宽度，确认 `small` / `large` 切换符合预期，并且在极窄
   宽度下 Logo 列正确隐藏。
3. 若结果与预期不符，查看
   `~/.qwen/debug/<sessionId>.txt`（`latest.txt` 软链指向当前
   会话），grep `[BANNER]` —— 每一次软失败都会打印一行 warn
   说明原因。

## 解析流水线

```
   settings.json                              packages/cli/src/ui/components/
   ─────────────                              ──────────────────────────────
   {                                          AppHeader.tsx
     "ui": {                                    │
       "hideBanner": false,                     │  showBanner =
       "customBannerTitle": "Acme",             │      !screenReader
       "customBannerSubtitle": "Built-in …",    │   && !ui.hideBanner
       "customAsciiArt": …                      │
     }                                          │
   }                                            ▼
        │                              <Header
        ▼                                customAsciiArt={resolved.asciiArt}
   loadSettings()                        customBannerTitle={resolved.title}
   merge user / workspace                customBannerSubtitle={resolved.subtitle}
        │                                version=… model=… authType=…
        ▼                                workingDirectory=… />
   resolveCustomBanner(settings)                  │
   ┌─────────────────────────┐                    ▼
   │ 1. 归一化为              │         packages/cli/src/ui/components/
   │    { small, large }     │         Header.tsx
   │ 2. 解析每一档：          │           │
   │    string → 直接使用     │           │  按 availableTerminalWidth
   │    {path} → fs.read     │           │  挑选档位
   │      O_NOFOLLOW         │           ▼
   │      ≤ 64 KB            │         渲染 Logo 列
   │ 3. 清洗 art：            │         渲染信息面板：
   │    stripControlSeqs     │           Title    = customBannerTitle
   │    ≤ 200 行 × 200 列    │                   ?? '>_ Qwen Code'
   │ 4. 清洗 title +          │           Subtitle = customBannerSubtitle
   │    subtitle（单行，      │                   ?? 空白 spacer 行
   │    ≤ 80 / 160 字符）     │           Status   = 锁定
   │ 5. 按来源 memoize        │           Path     = 锁定
   └─────────────────────────┘
```

五步解析算法在加载设置时运行一次，仅在设置热重载事件触发时再次
运行：

1. **归一化**。裸 `string` 或 `{ path }` 转为
   `{ small: x, large: x }`。`{ small, large }` 对象原样通过。
2. **逐档解析**。对每个 `AsciiArtSource`：
   - 字符串：直接使用。
   - `{ path }`：同步读取，使用 `O_NOFOLLOW` 防御软链劫持
     （Windows 退化为普通只读读取 —— 该常量不暴露），
     上限 64 KB。相对路径相对于*所属设置文件的目录*：workspace
     设置相对 workspace `.qwen/`，user 设置相对 `~/.qwen/`。
     读取失败 → `[BANNER]` warn，该档回退默认。
3. **清洗**。Banner 专用 stripper：去掉 OSC / CSI / SS2 / SS3 引导
   字符，把其余 C0 / C1 控制字节（含 DEL）替换为空格，同时保留
   `\n` 让多行 ASCII art 存活。每行 trim 尾部空白后，截断至 200 行
   × 200 列，超出部分截断并打印 `[BANNER]` warn。
4. **渲染期挑档**。在 `Header.tsx` 中，给定解析后的 `small` 与
   `large`，根据现有宽度预算
   （`availableTerminalWidth ≥ logoWidth + logoGap + minInfoPanelWidth`）：
   - 若 `large` 容得下，优先 `large`。
   - 否则若 `small` 容得下，回退 `small`。
   - 再否则，**只要用户提供过 custom art**，就直接隐藏 Logo 列
     （沿用 `showLogo = false` 分支）—— 此时若退到内置 QWEN logo 会
     在窄终端上悄悄破坏白标部署。信息面板继续渲染。
   - 否则（用户完全没提供 custom art）退到 `shortAsciiLogo`，由
     默认 logo 的宽度闸门决定是否显示。
5. **兜底**。如果两档因为软失败（文件缺失、清洗后全空、配置畸形）
   都最终为空或非法，按未自定义渲染 `shortAsciiLogo`，并按默认
   logo 的宽度闸门处理。CLI **绝不能**因为 Banner 配置错误而崩溃。

挑档的伪代码：

```ts
function pickTier(
  small: string | undefined,
  large: string | undefined,
  availableWidth: number,
  logoGap: number,
  minInfoPanelWidth: number,
): string | undefined {
  for (const candidate of [large, small]) {
    if (!candidate) continue;
    const w = getAsciiArtWidth(candidate);
    if (availableWidth >= w + logoGap + minInfoPanelWidth) {
      return candidate;
    }
  }
  return undefined; // 隐藏 Logo 列
}
```

## Settings schema 新增

在 `packages/cli/src/config/settingsSchema.ts` 的 `ui` 对象中，
紧接 `shellOutputMaxLines` 追加四个属性：

```ts
hideBanner: {
  type: 'boolean',
  label: 'Hide Banner',
  category: 'UI',
  requiresRestart: false,
  default: false,
  description: 'Hide the startup ASCII banner and info panel.',
  showInDialog: true,
},
customBannerTitle: {
  type: 'string',
  label: 'Custom Banner Title',
  category: 'UI',
  requiresRestart: false,
  default: '' as string,
  description:
    'Replace the default ">_ Qwen Code" title shown in the banner info panel. The version suffix is always appended.',
  showInDialog: false,
},
customBannerSubtitle: {
  type: 'string',
  label: 'Custom Banner Subtitle',
  category: 'UI',
  requiresRestart: false,
  default: '' as string,
  description:
    'Optional subtitle line rendered between the banner title and the auth/model line. When unset, the info panel keeps its blank spacer row.',
  showInDialog: false,
},
customAsciiArt: {
  type: 'object',
  label: 'Custom ASCII Art',
  category: 'UI',
  requiresRestart: false,
  default: undefined,
  description:
    'Replace the default QWEN ASCII art. Accepts an inline string, {"path": "..."}, or {"small": ..., "large": ...} for width-aware selection.',
  showInDialog: false,
  // 运行时接受 SettingDefinition `type` 表达不出来的联合形态。
  // override 由 JSON-schema 生成器原样输出，让 VS Code 接受所有
  // 文档化的形态（string、{path}、{small,large}），不再把裸字符串
  // 标红。
  jsonSchemaOverride: { /* string | {path} | {small,large} oneOf … */ },
},
```

`hideBanner` 沿用现有 `hideTips` 的模式（`showInDialog: true`）；
其余三个自由文本字段（标题、副标题、art）不进入应用内设置对话框 ——
在 TUI 对话框里做多行 ASCII 编辑器是另一个项目，高级用户直接编辑
`settings.json` 即可。

## 代码改动点

实施改动很小。下面给出每处的文件与当前 `main` 分支上的行号范围。

`packages/cli/src/ui/components/AppHeader.tsx:53` —— 扩展
`showBanner`：

```ts
const showBanner = !config.getScreenReader() && !settings.merged.ui?.hideBanner;
```

`packages/cli/src/ui/components/AppHeader.tsx` —— 把解析后的
Banner 数据传入 `<Header>`：

```tsx
<Header
  version={version}
  authDisplayType={authDisplayType}
  model={model}
  workingDirectory={targetDir}
  customAsciiArt={resolvedBanner?.asciiArt /* { small?, large? } */}
  customBannerTitle={resolvedBanner?.title /* string | undefined */}
  customBannerSubtitle={resolvedBanner?.subtitle /* string | undefined */}
/>
```

`packages/cli/src/ui/components/Header.tsx` —— 扩展 `HeaderProps`：

```ts
interface HeaderProps {
  customAsciiArt?: { small?: string; large?: string };
  customBannerTitle?: string;
  customBannerSubtitle?: string;
  version: string;
  authDisplayType?: AuthDisplayType;
  model: string;
  workingDirectory: string;
}
```

`packages/cli/src/ui/components/Header.tsx:45-46` —— 在计算
`logoWidth` 之前先挑档，并以现有默认作为兜底：

```ts
const tier = pickTier(
  customAsciiArt?.small,
  customAsciiArt?.large,
  availableTerminalWidth,
  logoGap,
  minInfoPanelWidth,
);
const displayLogo = tier ?? shortAsciiLogo;
```

`packages/cli/src/ui/components/Header.tsx` —— 标题从 prop 渲染，
副标题在 prop 真值时取代原本的空白 spacer 行：

```tsx
<Text bold color={theme.text.accent}>
  {customBannerTitle ? customBannerTitle : '>_ Qwen Code'}
</Text>
…
{customBannerSubtitle ? (
  <Text color={theme.text.secondary}>{customBannerSubtitle}</Text>
) : (
  <Text> </Text>
)}
```

**新增文件**：`packages/cli/src/ui/utils/customBanner.ts` —— 解析器。
对外接口：

```ts
export interface ResolvedBanner {
  asciiArt: { small?: string; large?: string };
  title?: string;
  subtitle?: string;
}

export function resolveCustomBanner(settings: LoadedSettings): ResolvedBanner;
```

解析器负责上述「解析流水线」中描述的归一化、文件读取、清洗与缓存。
在 CLI 启动时调用一次，并在设置热重载事件中再次调用。每个 scope 的
文件路径直接来自 `settings.system.path` / `settings.workspace.path` /
`settings.user.path`，因此每个 `{ path }` 都相对于声明它的那个文件
解析；当 `settings.isTrusted` 为 false 时整个跳过 workspace scope。

## 备选方案对比

下面给出曾经评估过的 5 种形态，便于后续维护者了解设计空间，必要时
重新评估。

### 方案 1 —— 三个扁平字段（推荐，与 issue 完全一致）

```jsonc
{
  "ui": {
    "customAsciiArt": "...", // string | {path} | {small,large}
    "customBannerTitle": "Acme CLI",
    "hideBanner": false,
  },
}
```

- **效果**：用户面最小，与 issue 描述一一对应。
- **优点**：零学习成本；文档极易；与现有 `ui.*` 扁平字段一致
  （`hideTips`、`customWittyPhrases` 等）。
- **缺点**：三个语义相关的键散落在 `ui` 顶层；未来若新增 banner
  专属开关（渐变、副标题等）只能继续向 `ui` 加兄弟字段，不能
  天然分组。

### 方案 2 —— 嵌套 `ui.banner` 命名空间

```jsonc
{
  "ui": {
    "banner": {
      "hide": false,
      "title": "Acme CLI",
      "asciiArt": { "path": "./brand.txt" },
    },
  },
}
```

- **效果**：能力等同方案 1，按特性聚合。
- **优点**：未来 banner 专属开关有干净的命名空间；`/settings`
  发现性更好。
- **缺点**：与 issue 原文写法不完全一致；现有 UI 设置以扁平为主
  （仅 `ui.accessibility` 与 `ui.statusLine` 是嵌套的），一致性
  打折；多了一层让用户记忆。

### 方案 3 —— Banner profile 预设 + slot override

```jsonc
{
  "ui": {
    "bannerProfile": "minimal" | "default" | "branded" | "hidden",
    "banner": { /* 'branded' 下的 slot 覆盖 */ }
  }
}
```

- **效果**：用户从命名预设挑选；高级用户在所选预设上覆盖具体 slot。
- **优点**：onboarding 体验更好；预设可由 CLI 自带。
- **缺点**：复杂度显著上升；预设是长期维护承诺；issue 要求的是
  开放自定义而非内容策划。

### 方案 4 —— 整体 Banner 模板字符串

```jsonc
{
  "ui": {
    "bannerTemplate": "{{logo}}\n>_ {{title}} ({{version}})\n{{auth}} | {{model}}\n{{path}}",
  },
}
```

- **效果**：单条 freeform 模板，受锁字段做插值。
- **优点**：非标准布局的灵活度最高。
- **缺点**：把布局责任推给用户态；Ink 双列对终端宽度的鲁棒性失去；
  极易写出在窄终端下崩坏的模板；为这点收益打开很大的破坏面。

### 方案 5 —— 插件 / 钩子 API

通过扩展系统暴露一个 banner-renderer 钩子。

- **效果**：代码级自定义；扩展可以渲染任意内容。
- **优点**：能力上限最高；企业可以打包出整套封装的品牌插件。
- **缺点**：API 表面巨大；任意终端渲染需要安全评审；对该 issue
  完全过度设计。

### 推荐结论

**采用方案 1**。它直接满足 issue，契合现有 `ui.*` 风格，且不会在
我们尚未明确还有哪些 banner 专属开关之前就被命名空间锁死。如果未来
兄弟字段开始累积，迁移到方案 2 是叠加式的 —— `ui.banner.title` 与
`ui.customBannerTitle` 可以在弃用窗口期内并存。

## 安全与失败处理

自定义 Banner 内容会**逐字渲染到终端**，并且在 path 形态下还会
**从磁盘读取**。两条路径在加载到恶意或被篡改的 settings 时都是
可达的。Session-title 特性所应对的同一类威胁模型在此同样适用。

| 关注点                                                | 防护手段                                                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ASCII art / 标题 / 副标题中的 ANSI / OSC-8 / CSI 注入 | Banner 专用 stripper（`sanitizeArt` / `sanitizeSingleLine`）：剥离 OSC / CSI / SS2 / SS3 引导符，把其余 C0 / C1 控制字节（含 DEL）替换为空格。渲染与缓存写入前都过一遍。 |
| 超大文件冻结启动                                      | 文件读取硬上限 64 KB。                                                                                                                                                   |
| 病态 ASCII art 冻结布局                               | 每个解析结果上限 200 行 × 200 列；超出截断 + `[BANNER]` warn。                                                                                                           |
| 软链劫持 path 形态                                    | 文件读取使用 `O_NOFOLLOW`（Windows 下退化为只读；常量不暴露）。                                                                                                          |
| 文件缺失或不可读                                      | 捕获 → `[BANNER]` warn → 回退默认；绝不抛入 UI。                                                                                                                         |
| 标题 / 副标题包含换行或过长                           | 换行折叠为空格，截断至 80（标题）/ 160（副标题）字符。                                                                                                                   |
| 不可信工作区影响渲染或文件读取                        | `settings.isTrusted` 为 false 时，解析器整个跳过 `settings.workspace`（与 `settings.merged` 视图的信任闸门一致）。                                                       |
| 设置热重载竞态                                        | 解析结果在每次调用内按来源（path 或字符串）做 memoize；reload 重新跑一遍解析器并重新读受影响的文件。                                                                     |

失败模式总结：所有软失败最终都会落到 `shortAsciiLogo`（或锁定的
默认标题）+ 一行调试日志 warn。任何分支都不允许产生硬失败
（向上抛出异常）。

## 不在本设计范围内

下列项被有意排除。每一项都可以视用户反馈做后续单独提案。

| 项目                                              | 不做的理由                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文案转 ASCII art（`{ text: "xxxCode" }` 形态）    | v1 评估后**拒绝**。要么引入 `figlet` 运行时依赖（含一套可用字体后约 2–3 MB unpacked），要么自己 vendor 一份单字体渲染器（~200 行代码 + 一份 `.flf` 字体我们自己维护）。两条路都带来长期的维护面：字体选型、字体 license 审计、「我的字体在 X 终端渲染不对」类 issue、CJK / 全角字符处理。本特性的驱动用例（白标 / 多租户）几乎一定有设计师交付成品 ASCII art，不会依赖 figlet 默认字体。希望一行命令生成的用户今天就能 `npx figlet "xxxCode" > brand.txt` + `customAsciiArt: { "path": "./brand.txt" }` —— 等价效果、零新增依赖、零 Qwen Code 内部支持负担。如果未来诉求增多，这一形态是纯叠加：把 `AsciiArtSource` 扩展为 `string \| {path} \| {text, font?}`，不会破坏任何已有配置。 |
| `/banner` slash 命令在线编辑                      | 设置 UI 是规范化的编辑入口；多行 ASCII 在线编辑器是另一个项目。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 自定义渐变色 / 单行颜色                           | 颜色由 theme 拥有。如需扩展应另立提案，Banner 自定义不重复造该面。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| URL 加载 ASCII art                                | 启动期网络请求自带一堆问题：失败模式、缓存、安全评审。`{path}` 文件加载是低风险等价物。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 动画（旋转 Logo、跑马灯标题）                     | 增加渲染负担与无障碍问题；本特性的用例不需要。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| VSCode / Web UI banner 对齐                       | 这两个端目前不渲染 Ink Banner。若未来引入，本设计为参考。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 文件变更的动态 reload                             | 解析器仅在启动与设置 reload 时运行。会话中途换 art 的需求很少，「重启生效」是可以接受的折中。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 单独隐藏锁定区域（version / auth / model / path） | 这些是运行时信号；屏蔽它们对支持与安全姿态的损害，远大于白标场景的收益。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## 验证计划

后续实施 PR 应通过以下端到端检查：

1. `~/.qwen/settings.json` 设置 `customBannerTitle: "Acme CLI"`
   与一段内联 `customAsciiArt` → `qwen` 启动后展示新标题与新
   ASCII art；版本号后缀仍在。
2. 设置 `customBannerSubtitle: "Built-in Acme Skills"` → 副标题
   行以次要文字色出现在标题与鉴权 / 模型行之间；鉴权、模型、
   路径仍可见。取消设置后回到空白 spacer 行（向后兼容）。
3. 设置 `hideBanner: true` → `qwen` 启动无 Banner；Tips 与正文
   照常渲染。
4. workspace `settings.json` 设置
   `customAsciiArt: { "path": "./brand.txt" }`，`brand.txt` 与
   之同处 `.qwen/` 目录 → 打开工作区时从磁盘加载。
5. `customAsciiArt: { "small": "...", "large": "..." }` →
   在宽 / 中 / 窄三档下调整终端尺寸；宽时取 large、中时取
   small、窄时隐藏 Logo 列；信息面板始终可见。
6. `customBannerTitle` **与** `customBannerSubtitle` 中分别
   注入 `\x1b[31mhostile` → 两处都渲染为字面文本，不会被
   解释为红色。
7. `path` 指向不存在的文件 → CLI 正常启动；
   `~/.qwen/debug/<sessionId>.txt` 出现 `[BANNER]` warn；
   渲染默认 art。
8. 在工作区信任关闭的状态下打开 worktree → workspace 提供的
   `customAsciiArt`（含 `{ path }` 项）被静默忽略；user scope
   的设置仍然生效。
