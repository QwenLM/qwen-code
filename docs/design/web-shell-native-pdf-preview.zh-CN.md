# Web Shell 原生 PDF 预览

[English](web-shell-native-pdf-preview.md) | [简体中文](web-shell-native-pdf-preview.zh-CN.md)

## 问题与现状

具备 PDF MIME 类型的附件已经通过 Blob URL 和 iframe 使用浏览器阅读器。通过 @ 引用或文件扩展区打开的工作区 PDF 仍进入文本读取流程，而 PDF artifact 被归类为仅下载。

## 方案

通过 `.pdf` 扩展名、规范化后的 `application/pdf` MIME 类型或 artifact 的 `kind: pdf` 识别 PDF。预览分流从原始工作区文件名提取扩展名，保留文件名和目录中的 `#` 与 `?`。Excel 分类和仅下载拦截使用相同的文件系统路径解析，避免 `reports.xlsx#approved` 这样的目录覆盖 PDF 文件名。现有面向 URL 的类型标签逻辑保持原样。使用 PDF 元数据放行 artifact 预览前，保留现有 SVG 和其他仅下载格式的拦截。四个入口均复用现有原生阅读器。已有附件 Blob 在本地预览；工作区文件通过现有 `readWorkspaceFileAsBlob` 和解析后的所属工作区 actions 读取。通过预览 MIME 类型传递 PDF artifact 的 kind 信息。不可用的 artifact 保留已有的不可用/下载展示。

## 决策与范围

仅修改 Web Shell 预览分类、渲染及测试。复用附件阅读器和已有下载 UI；不引入 PDF.js、服务端路由、公共 API、编辑、OCR 或自定义阅读器控件。工作区 PDF 使用二进制读取，保留 100 MiB 上限、256 KiB 分块、stat 一致性及工作区权限检查。文件、版本或所属工作区变化时重新加载，忽略取消后的读取结果，在替换或卸载时释放 Blob URL。浏览器明确不支持内嵌 PDF 时提供下载回退，读取失败时显示错误并支持重试。

## 涉及文件

- `packages/web-shell/client/components/artifacts/artifactUtils.ts` 及测试：统一分类。
- `packages/web-shell/client/components/artifacts/ArtifactPanel.tsx` 及测试：工作区加载及复用原生附件阅读器。
- `packages/web-shell/client/components/artifacts/WorkspaceFileBrowser.tsx`：在已有独立页签预览菜单中放行 PDF。
- `packages/web-shell/client/e2e/web-shell.pdf-preview.spec.ts`：四个入口的浏览器覆盖。

## 约束与风险

PDF 工具栏、密码提示和渲染错误由浏览器处理。内嵌支持检测不能证明某一份 PDF 成功渲染。宿主 CSP 必须允许 Blob frame。完整文件加载会占用内存，大文件可能等待较久；保留已有大小上限。模拟 daemon 的浏览器测试验证 UI 集成，不验证真实 daemon 文件系统操作。

## 验证与验收标准

附件、@ 引用、文件扩展区和 artifact 在完整 Chromium 浏览器中显示有效 PDF 页面。覆盖大写扩展名、通用附件 MIME、规范化 PDF MIME、仅 kind 标识的 PDF artifact，以及原始 `#`/`?` 路径（包括含误导扩展名的目录）。Sources PDF 预览继续支持这些原始文件路径。工作区 PDF 不走文本读取，已有 Blob 不触发工作区读取。下载字节保持一致。版本变化替换预览，卸载释放 URL，读取失败可以重试，不可用 artifact 不发起读取，工作区归属检查继续生效。执行定向单测、浏览器测试、构建、类型检查、bundle 和连续两轮无问题的自审。捕获并目视检查浏览器截图，明确标注模拟 daemon 证据。

## 待定问题

当前范围内无。跨浏览器统一控件和大文件流式读取不在本次范围内。
