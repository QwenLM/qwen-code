# 拆分导出 transcript 渲染器内嵌的 CSS 为独立版本化资产

[English](2026-09-09-split-export-transcript-css.md) | [简体中文](2026-09-09-split-export-transcript-css.zh-CN.md)

状态：提议（已实现，待评审）。Issue：#11478。

## 问题陈述

每个 `/export html` 聊天文档在渲染前都要从 unpkg 加载唯一的渲染器资产
`export-transcript-document.js`。在 0.23.2 该资产为 4,134,210 字节（gzip 约
1.5 MB），其中超过一半不是代码：`injectCssModules` Vite 插件把 web-shell
transcript 组件样式表以 `const __qwenWebShellCss="…"` 字符串字面量的形式内联在
`packages/web-shell/dist/transcript.js` 顶部，导出构建
（`packages/web-templates/src/export-html/build.mjs`）又原样把该字面量打包进渲染器。

本分支改动前的实测：

| 组成                                               |                        字节数 |
| -------------------------------------------------- | ----------------------------: |
| `dist/transcript.js` 总量                          |                     3,531,656 |
| CSS 字符串字面量（`__qwenWebShellCss`）            | 2,305,152（解码后 2,302,457） |
| `export-transcript-document.js`（压缩后的 bundle） |                     4,136,297 |
| `document.html` 模板                               |                         6,606 |

后果：

- `build.mjs` 里的体积预算已经告警：警告线 4,100,000、硬上限 4,200,000，当前构建
  约 4,139,302 —— 只剩约 60 KB 余量，任何依赖增长都会让构建失败。
- 浏览器必须先完整下载、解析、编译约 4 MB 的 JS 才能渲染，而其中 56% 在解析期只是
  一段死字符串，到注入时才变成 CSS。

## 目标

在导出构建时，把 web-shell 组件样式表从 JS bundle 中抽离为独立的、版本固定、带 SRI
校验的 `export-transcript-document.css` 资产，与渲染器一起通过 unpkg 分发，并在导出
文档中用携带 nonce 的 `<link rel="stylesheet">` 引用。渲染器 JS 降到约 1.8 MB raw
（gzip 约 0.5 MB），CSS 作为独立资产并行加载、单独缓存。

## 范围边界

- **不改动 `@qwen-code/web-shell`** 的源码或运行时行为。web-shell 构建仍然为交互式
  应用和 `@qwen-code/web-shell/transcript` 的其他消费者内联样式表；只有导出构建把它
  剥离。
- 转换完全发生在导出构建中，通过 esbuild 的 `onLoad` 插件拦截
  `dist/transcript.js`，抽出 CSS 字面量并把剩余部分作为 stub 交给打包器。
- KaTeX、transcript 组件图、文档 CSP、`document-main.tsx` 渲染器都保持原样。
- 这**不会**减少导出文档的总下载字节 —— 只是把字节从 JS 里挪出去，让两层各自缓存和
  解析。更进一步的瘦身（#11100 组件图重构、KaTeX 的产品决策）不在本次范围。

## 已验证的可行性

- transcript 文档不使用 shadow DOM（`dist/transcript.js` 中无 `attachShadow` /
  `ShadowDomBoundary`），因此 `<head>` 中的 `<link>` 能覆盖导出渲染的全部样式。
- `style-src-elem 'nonce-…'` 天然覆盖带 nonce 的 `<link>`；逐次导出的 nonce 由
  `packages/cli/src/ui/utils/export/formatters/html.ts` 生成并替换每个
  `__EXPORT_NONCE__` 占位符，无需放宽 CSP。
- 注入结构稳定：`dist/transcript.js` 开头恰好是两行生成代码 ——
  `const __qwenWebShellCss=…;` 一行和 366 字节的
  `if(typeof document!=="undefined"…)}` 运行时注入行 —— 之后才是真正的 transcript
  代码。`client/build-artifact.test.ts` 已经在解析同一结构。

## 提议的改动

### 1. `packages/web-templates/src/export-html/build.mjs`

- 新增 esbuild `onLoad` 插件，读取解析后的文件，匹配
  `^const __qwenWebShellCss=("(?:[^"\\]|\\.)*");\n`，`JSON.parse` 出字面量，剥离
  CSS 常量行及其后紧跟的运行时注入行，把剩余部分作为 `{ contents, loader: 'js' }`
  返回。任一行缺失或移位就使构建失败。
- 该插件的 filter 位于新模块
  `packages/web-templates/src/export-html/transcript-css-entry.mjs`，由
  `build.mjs` 导入：

  ```js
  export const TRANSCRIPT_CSS_ENTRY_FILTER =
    /web-shell[\\/]dist[\\/]transcript\.js$/;
  ```

  抽出它的原因是 `build.mjs` 是一个带顶层 await、没有测试骨架的脚本，而「匹配决策」
  正是决定样式表是否会被抽出的那一环 —— 只有让它可以在不跑完整构建的前提下被
  import，`scripts/tests/transcript-css-entry-filter.test.js` 才能钉住它。
  字符类里同时包含两种分隔符，是因为 esbuild 交给插件回调的是平台原生的绝对路径；
  在 Windows 上它是 `C:\repo\packages\web-shell\dist\transcript.js`，因此只用正斜杠
  的模式在那里永远匹配不到：回调不会执行，抽出的 CSS 保持 `undefined`，下面那条强制
  守卫会中止每一次导出构建 —— 包括 `npm ci` 通过根 `prepare` 脚本运行的那一次。
  `transcript\.js$` 这个结尾同样是承重的：只写 `web-shell[\\/]dist[\\/]` 前缀会连带
  匹配到 `web-shell/dist/index.js`，而 `FORBIDDEN_DOCUMENT_INPUTS` 禁止它进入任何导出。

- 把解码后的 CSS 写入 `dist/export-transcript-document.css`。
- 按现有 JS 资产同样的方式推导 `export-transcript-document.css` 的 URL 和
  `sha384-` SRI，并把两个占位符加入模板替换链和残留占位符守卫。
- 针对「仅 JS bundle」（解析/编译关键资产）重新测量并收紧预算常量，CSS 资产体积单独
  打印。

### 2. `packages/web-templates/src/export-html/src/document-index.html`

- 在现有内联 `<style>` 之后新增
  `<link rel="stylesheet" nonce="__EXPORT_NONCE__" id="transcript-stylesheet" integrity="__DOCUMENT_RENDERER_CSS_INTEGRITY__" crossorigin="anonymous" href="__DOCUMENT_RENDERER_CSS_URL__" />`。
  `<link>` 必须放在内联 `<style>` **之后**，这样在文档顺序上组件样式表能赢下所有同特异性
  冲突（`:where(...)` 作用域化贡献的特异性为零）。
- 扩展 body 脚本中现有 fail-closed 的 `showLoadError` 监听器，把
  `event.target.id === 'transcript-stylesheet'` 也视为加载失败。
- **在 `<head>` 中、`<link>` 之前锁存样式表失败。** 只改 body 监听器是不够的：Chromium
  会因为 head 中挂起的样式表而阻塞 body 内联脚本的解析，因此在大文档上，一次先于解析器
  恢复而尘埃落定的 CSS 失败被派发时还没有任何监听器存在 —— 没有东西把渲染标记为失败，
  transcript 会完全无样式地渲染出来，同时把 `data-render-complete` 标成 `"true"`。
  所以在 `<link>` 紧前方放一个 `<script nonce="__EXPORT_NONCE__">`，注册一个**捕获阶段**
  的 `error` 监听器（资源错误事件不冒泡），当失败元素的 id 是 `transcript-stylesheet` 时
  置 `window.__transcriptStyleFailed = true`；既有 body IIFE 的结尾则是
  `if (window.__transcriptStyleFailed) { showLoadError(); }`。
  两个约束决定了它的形态：脚本必须带 nonce，因为 `script-src` 没有 `'unsafe-inline'`
  （而 `formatters/html.ts` 会替换每一个 `__EXPORT_NONCE__` 槽位）；它必须**只记录不行动**
  —— `showLoadError` 会写 `document.body.dataset` 和 `#app`，而解析器还在 `<head>` 时
  两者都不存在。锁存脚本位于 `<link>` 之前的这个**位置**就是整个修复的关键；
  `scripts/tests/export-transcript-document-template.test.js` 钉住了该位置、nonce、
  捕获阶段、「只记录」形态、body 侧的消费，以及两个监听器比较的 id 与 `<link>` 实际
  携带的 id 一致。

### 3. `packages/web-templates/src/export-html/src/document-main.tsx`

- 为渲染成功标记加保护，避免覆盖样式表加载失败：仅当
  `document.body.dataset.renderComplete` 还不是 `'error'` 时才置为 `'true'`。
- 在模块作用域为挂载本身加保护：只有当
  `document.body.dataset.renderComplete !== 'error'` 时才执行 `createRoot` /
  `root.render`。资产加载失败后，真正决定 transcript 是否渲染的是这条守卫 —— 它保留
  内联 `showLoadError` 的告警，而不是用一个无样式的 transcript 把它替换掉。

### 4. 打包脚本

- `scripts/copy_bundle_assets.js`：把
  `packages/web-templates/src/export-html/dist/export-transcript-document.css`
  拷贝进 `dist/`，与 JS 渲染器并列。
- `scripts/prepare-package.js`：在 `verifyBundleArtifacts` 中要求 CSS，并列入发布的
  `files`。
- `scripts/create-standalone-package.js`：把 CSS 加入
  `DIST_NPM_PACKAGE_ONLY_ENTRIES`（standalone 归档不携带渲染器，导出文件从 unpkg 加载）。

### 5. 测试与文档

- `packages/cli/src/ui/utils/export/formatters/html.test.ts`：断言 `<link>` 的 URL、
  integrity 和 nonce。
- `integration-tests/chat-transcript-document.test.ts`：用构建出的资产满足 CSS 请求，
  断言它是唯一样式表请求，并新增「样式表缺失时 fail-closed」用例。
- `scripts/tests/package-assets.test.js` / `scripts/tests/install-script.test.js`：
  覆盖 CSS 的拷贝 / 发布 / standalone 排除路径。
- `scripts/tests/transcript-css-entry-filter.test.js`：在不跑构建的前提下钉住 `onLoad`
  filter（两种路径分隔符，以及被禁止的 `web-shell/dist/index.js` 不匹配）。
- `scripts/tests/export-transcript-document-template.test.js`：钉住 `<head>` 锁存脚本 ——
  位于 `<link>` 之前的位置、nonce、捕获阶段、「只记录」形态、body 侧的消费，以及两个
  监听器比较的 id 与 `<link>` 携带的 id 一致。
- `docs/verification/export-html-runtime-size/README.md`：更新测量说明以覆盖两个资产。

## 涉及文件

- `packages/web-templates/src/export-html/build.mjs`
- `packages/web-templates/src/export-html/transcript-css-entry.mjs`
- `packages/web-templates/src/export-html/src/document-index.html`
- `packages/web-templates/src/export-html/src/document-main.tsx`
- `scripts/copy_bundle_assets.js`
- `scripts/prepare-package.js`
- `scripts/create-standalone-package.js`
- `packages/cli/src/ui/utils/export/formatters/html.test.ts`
- `integration-tests/chat-transcript-document.test.ts`
- `scripts/tests/package-assets.test.js`
- `scripts/tests/install-script.test.js`
- `scripts/tests/export-transcript-document-template.test.js`
- `scripts/tests/transcript-css-entry-filter.test.js`
- `docs/verification/export-html-runtime-size/README.md`

## 设计决策与理由

- **用 `onLoad` 剥离而非改动 web-shell 构建。** 本 issue 的约束是 web-shell 保持其运行
  时行为（它仍需要给交互式应用和其他消费者注入自己的样式表）。在导出构建边界剥离，让
  两个消费者相互独立，且不改动 web-shell 契约。
- **文档外壳自身的 `document-styles.css` 保持内联。** 它只有几 KB 且专属于导出外壳；
  本次目标只是约 2.3 MB 的 web-shell 组件样式表。
- **CSS 原样发布（已做作用域化）。** `injectCssModules` 已通过 `scopeComponentCss`
  做了作用域化和去重；导出构建只是原样抽出这段字符串，因此不引入重新压缩或重新作用域
  化的风险。
- **每个资产单独 SRI。** JS 和 CSS 是不同字节的发布物，各自有独立的 `sha384-` 摘要；
  CSS 通过与 JS 相同的 unpkg `@<version>` 路径固定版本。

## 验收标准

- `node src/export-html/build.mjs` 成功，打印渲染器 JS 体积（约 1.8 MB）和 CSS 资产
  体积（约 2.3 MB），并写出 `export-transcript-document.css`。
- `export-transcript-document.js` 不再包含 `__qwenWebShellCss` 字面量；
  `export-transcript-document.css` 包含作用域化样式表。
- 导出文档在真实浏览器中完整渲染（`integration-tests/chat-transcript-document.test.ts`
  通过），且 CSS 资产缺失时 fail-closed 显示加载错误页。
- 打包测试通过；CSS 随 npm 包发布，且被排除在 standalone 归档之外。

## 开放问题

无阻塞项。delegate 开关（`QWEN_EXPORT_RENDERER_IDENTITY` /
`QWEN_EXPORT_RENDERER_INTEGRITY`）新增并行的 `QWEN_EXPORT_RENDERER_CSS_INTEGRITY`，
使委托构建能把两个资产都指向同一已发布版本。
