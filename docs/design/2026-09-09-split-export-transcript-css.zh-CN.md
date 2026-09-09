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

- 新增 esbuild `onLoad` 插件（`filter: /web-shell\/dist\/transcript\.js$/`），读取
  解析后的文件，匹配 `^const __qwenWebShellCss=("(?:[^"\\]|\\.)*");\n`，
  `JSON.parse` 出字面量，剥离 CSS 常量行及其后紧跟的运行时注入行，把剩余部分作为
  `{ contents, loader: 'js' }` 返回。任一行缺失或移位就使构建失败。
- 把解码后的 CSS 写入 `dist/export-transcript-document.css`。
- 按现有 JS 资产同样的方式推导 `export-transcript-document.css` 的 URL 和
  `sha384-` SRI，并把两个占位符加入模板替换链和残留占位符守卫。
- 针对「仅 JS bundle」（解析/编译关键资产）重新测量并收紧预算常量，CSS 资产体积单独
  打印。

### 2. `packages/web-templates/src/export-html/src/document-index.html`

- 在现有内联 `<style>` 之后新增
  `<link rel="stylesheet" nonce="__EXPORT_NONCE__" id="transcript-stylesheet" integrity="__DOCUMENT_RENDERER_CSS_INTEGRITY__" crossorigin="anonymous" href="__DOCUMENT_RENDERER_CSS_URL__" />`。
- 扩展现有 fail-closed 的 `showLoadError` 监听器，把
  `event.target.id === 'transcript-stylesheet'` 也视为加载失败。

### 3. `packages/web-templates/src/export-html/src/document-main.tsx`

- 为渲染成功标记加保护，避免覆盖样式表加载失败：仅当
  `document.body.dataset.renderComplete` 还不是 `'error'` 时才置为 `'true'`。

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
- `docs/verification/export-html-runtime-size/README.md`：更新测量说明以覆盖两个资产。

## 涉及文件

- `packages/web-templates/src/export-html/build.mjs`
- `packages/web-templates/src/export-html/src/document-index.html`
- `packages/web-templates/src/export-html/src/document-main.tsx`
- `scripts/copy_bundle_assets.js`
- `scripts/prepare-package.js`
- `scripts/create-standalone-package.js`
- `packages/cli/src/ui/utils/export/formatters/html.test.ts`
- `integration-tests/chat-transcript-document.test.ts`
- `scripts/tests/package-assets.test.js`
- `scripts/tests/install-script.test.js`
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
