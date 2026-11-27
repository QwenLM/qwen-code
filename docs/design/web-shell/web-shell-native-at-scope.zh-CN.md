# Web Shell 原生 CSS `@scope` 样式隔离

[English](web-shell-native-at-scope.md) | [简体中文](web-shell-native-at-scope.zh-CN.md)

## 问题背景

此前嵌入态 Web Shell 库产物通过在样式表的每条选择器分支前拼接长达 198 字符的 `:where([data-web-shell-root][data-web-shell-shadcn], [data-web-shell-portal-root][data-web-shell-shadcn], [data-web-shell-root][data-web-shell-shadcn] *, [data-web-shell-portal-root][data-web-shell-shadcn] *)` 前缀来实现样式隔离。

在宿主环境中，这在输入框交互（尤其是输入文本后全选删除）时引发了两个叠加的样式重算瓶颈：

1. **零 Bloom Filter 快速拒绝与双重作用域嵌套**：`:where(...)` 内部包含后代通配符 `*`，使 Blink 祖先 Bloom 过滤器失效（`fastReject = 0`），并且对 `preflight.css` / `globals.css` 中已经自带作用域的通用规则（`*`、`::before`、`::after`、`::backdrop`、`::-webkit-scrollbar`）进行了二次包裹，同时让内联 CSS 体积膨胀约 1.4 MB。
2. **整棵子树 `:has()` 失效集**：4 个 shadcn UI 原语（`field.tsx`、`checkbox.tsx`、`alert.tsx`、`alert-dialog.tsx`）中的 `group-has-*` 会编译为 `:is(:where(.group/...):has(...) *)`，在 Blink 中生成 `WholeSubtreeInvalid` 失效集。当宿主页存在泛匹配 `:has()` 规则时，`.cm-content` / `.cm-selectionLayer` 的每次变更都会向上冒泡到应用根节点，单次全选删除连续触发 3 轮约 1,260 节点的全页 `UpdateLayoutTree`（累计约 360–400 ms）。

## 方案设计

1. **组件 CSS 改用原生 `@scope` 包裹**：
   - 在 `packages/web-shell/vite.lib.config.ts` 中将组件样式规则统一包裹进 `@scope ([data-web-shell-root][data-web-shell-shadcn], [data-web-shell-portal-root][data-web-shell-shadcn]) { ... }`（同时覆盖 `index`、`transcript`、`managed-host` 以及懒加载的 `xterm.css`）。
   - 将全局声明式 at-rule（`@charset`、`@import`、`@font-face`、`@property`、`@keyframes`，包括嵌套在 `@media` / `@supports` 内的 `@keyframes`）提升至 `@scope` 外部顶层，并保留原有的 `qwen-web-shell-` / `--qwen-web-shell-` 前缀隔离。
   - 顶层 `@layer` 块（如 Tailwind 的 `@layer properties` 回退块）保持在顶层，仅将其内部规则包裹在 `@scope` 中。
   - 将 `:root` / `:host` 以及预置的 `:is([data-web-shell-root]:where([data-web-shell-shadcn]), [data-web-shell-portal-root]:where([data-web-shell-shadcn]))` 选择器简化为 `:scope`，在消除双重包裹的同时保留 preflight 重置的 `(0, 1, 0)` 权重。
   - 由于 `@scope` 内未显式包含 `:scope` 的选择器默认等价于后代选择器（`:where(:scope) <sel>`），会漏掉直接挂在 `[data-web-shell-root]` 本身的类（如 `.app`、`.themeDark`、`.appChatEmpty .content`），因此对非 `:scope` 开头的选择器补充零权重的 `:where(:scope)` 复合分支，在不引入 `*` 的前提下同时命中作用域根元素与后代元素。
2. **替换生成 `:has(...) *` 的 4 处 `group-has-*` 类名**：
   - `FieldDescription`：改为 `group-data-[orientation=horizontal]/field:text-balance`（直接读取 `Field` 上的 `data-orientation`）。
   - `Checkbox`：改为 `group-data-[disabled=true]/field:opacity-50`（与 `FieldLabel`、`FieldTitle` 一致，同时保留自身的 `disabled:opacity-50`）。
   - `Alert` / `AlertTitle`：将列定位移至 `Alert` 上，使用直接子代选择器 `has-[>svg]:[&>[data-slot=alert-title]]:col-start-2`。
   - `AlertDialogHeader` / `AlertDialogTitle`：将列定位移至 `AlertDialogHeader` 上，使用直接子代选择器 `sm:group-data-[size=default]/alert-dialog-content:has-data-[slot=alert-dialog-media]:[&>[data-slot=alert-dialog-title]]:col-start-2`。

## 约束与权衡

- 嵌入态库构建产物依赖原生 CSS `@scope`（Chrome/Edge 118+、Safari 17.4+、Firefox 146+）。
- 独立应用构建（`vite.config.ts`）与宿主样式表保持不变；即便宿主页仍存在裸 `div:has(...)` 规则，该优化也能将样式重算耗时降低约 45 倍，宿主进一步移除泛匹配 `div:has(...)` 后可降至 1 ms 以内。

## 验证方案

- 在 `packages/web-shell/client/build-artifact.test.ts` 中校验 `dist/index.js` 与 `dist/transcript.js` 所有样式规则均处于 `@scope` 内，`@font-face` / `@property` / `@keyframes` 位于顶层，不再存在旧 `:where([data-web-shell-root][data-web-shell-shadcn]...` 前缀及 `:has(...) *` 选择器，且懒加载 `terminal-runtime` 的 `xterm.css` 同样被 `@scope` 包裹。
- 在 Chromium 与 WebKit 中验证 Light DOM、Portal 根节点与 Shadow DOM（`adoptedStyleSheets`）下的宿主隔离、根元素类名、暗色主题、KaTeX 字体与边框、动画（含 `@media (prefers-reduced-motion: no-preference)` 嵌套关键帧）以及 4 个改动 UI 原语的计算样式。
