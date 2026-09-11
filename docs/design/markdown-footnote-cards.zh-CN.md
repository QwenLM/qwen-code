# 通用 Markdown 脚注卡片与宿主图标选择

[English](./markdown-footnote-cards.md)

## 问题与方案

报告引用网页、文件、附件、知识库记录，也可能包含纯文字说明。所有可解析的标准 Markdown 脚注均使用同一套聚合机制，不要求特殊 ID 或内容格式。数字、命名、中文 ID，以及无链接、无加粗的脚注均可聚合。保留当前默认知识图标，宿主通过两个独立函数返回图片资源 URL，分别决定正文和 Assistant 操作栏图标，无须提供 React 组件。

```markdown
订单遵循统一口径。[^a][^b]

资源组影响并发。[^c]

[^a]: [订单定义](https://example.com/orders '知识库') — 业务定义。

[^b]: 这里是一条没有链接的补充说明。

    第二段说明也完整保留。

[^c]: [资源组规格](https://example.com/resources) — 规格说明。
```

## 公开接口

`WebShellMarkdownCustomization` 新增可选的 `getInlineFootnoteIcon` 和 `getAssistantFootnoteIcon`。两者使用导出的 `WebShellFootnoteIconResolver` 类型，必须同步、无副作用，返回现有 `WebShellIconSource` 资源 URL 或 null/undefined。SolidJS 宿主编写普通 JavaScript 函数即可，无须 React 依赖或挂载桥接。

每个函数收到只读的 `WebShellFootnote` 列表：

| 字段                         | 含义                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `id: string`                 | definition 中写出的脚注逻辑标识，不包含消息 DOM 前缀或 URL 编码。                                                   |
| `number: number`             | 按首次引用顺序得到的脚注编号。                                                                                      |
| `definitionMarkdown: string` | 包含 `[^id]:`、多行内容和原始链接的完整 definition；按 AST 位置直接截取 `transformMarkdown` 后实际渲染的 Markdown。 |
| `title?: string`             | 首个安全链接的文字。                                                                                                |
| `summary: string`            | 其余文字；没有链接时为完整脚注说明。                                                                                |
| `href?: string`              | 首个安全链接的地址，沿用现有 Markdown URL 转换。                                                                    |
| `source?: string`            | 首个安全链接的可选 title 属性。                                                                                     |
| `image?: string`             | 首张安全缩略图的地址。                                                                                              |

公开列表不含 HAST、DOM 或 React 对象。示例中正文分别收到 `[a,b]`、`[c]`，操作栏收到 `[a,b,c]`。每组和消息总列表均按首次引用顺序、脚注 ID 去重；不同 ID 即使 URL 相同也不合并。翻页不改变图标判断函数的完整列表。React 可能重复渲染，不承诺生命周期内函数总共只执行两次。

```ts
const markdown = {
  getInlineFootnoteIcon: (notes) =>
    notes.every((note) => note.href?.startsWith('https://citation.invalid/'))
      ? '/icons/knowledge.svg'
      : '/icons/web.svg',
  getAssistantFootnoteIcon: () => '/icons/references.svg',
};
```

两个函数互不代替。未传入、返回空值、无效地址或抛出异常，均回退到默认知识图标。自定义图标沿用输入框标签的单色 mask 和图片 URL 策略（包括拒绝 SVG data URL）。正文 16px，操作栏 14px；只有默认操作栏知识图标上移 1px，自定义图标正常居中。宿主仅决定图标，数量、按钮、Hover、翻页、键盘与点击行为由 Qwen 负责。宿主资源需自行统一 viewBox 留白、实际绘制尺寸、视觉重心和线宽；CSS 容器等大不代表图形等大。Demo 操作栏资源以 Assistant 复制图形为参照，浏览器验收同时检查实绘边界、视觉重心和元素几何位置。

## 展示与生命周期

- 同一行内父节点中，相邻脚注允许空白间隔并聚合；正文、标点、块和表格单元格边界中断聚合。单个脚注也构成一组。
- 纯文本脚注使用“脚注 n”作为标题，完整说明可滚动查看并支持键盘滚动；无链接则无跳转。
- Hover、聚焦或点击可打开预览。点击分页器或触发器后卡片保持打开，Escape 或外部点击关闭；仅 Hover 打开的卡片移出后关闭。一个 definition 对应一页。
- Assistant 操作栏在复制、分支和时间旁显示“N 个引用”，取本条消息实际引用的去重列表；沿用消息 Hover/聚焦和触屏展示规则。独立 Markdown 渲染保留聚合入口回退。
- 缺失 definition 时保留引用原文。只有所有引用均已转换的 definition 才从普通文末列表移除；不能转换的引用（例如链接内脚注）仍有有效文末目标与返回正文链接。
- 在现有 AST 管线中提取原文，不二次解析 Markdown。保持现有稳定的引用上报和组件身份，流式更新不重挂已打开的卡片；消息之间的 DOM 锚点互相隔离。
- 复制 Markdown 和静态文档导出保留标准脚注。宿主自定义 `components.sup` 时继续退出聚合，表格复制保留原脚注编号。

## 当前页内容插槽

可选的 `mountFootnotePreview(container, info)` 只替换当前页的来源标签、标题、说明和缩略图。聚合、入口图标/数量、浮层定位、Hover/保持打开/Escape、键盘导航和分页器继续由 Qwen 管理。正文与 Assistant 操作栏共用此插槽。不配置、返回 null/undefined 或同步执行失败时使用默认内容。

框架无关的挂载函数接收已连接且可布局的独立 HTML 容器和 `WebShellFootnotePreviewInfo`：完整只读 `footnotes` 列表、当前 `footnote`、从零开始的 `index`、入口 `location`（`inline` 或 `assistant`）、本地化 `title`、已解析的 `sourceLabel`，以及 Qwen 管理的 HTMLElement `sourceLink`。元数据仍不含 AST/React 对象；DOM 元素属于展示句柄，宿主可将其放入布局，但不要替换其子节点。Qwen 通过原有 `components.a` 在该元素内渲染当前来源链接，保留宿主接管和普通安全链接行为。纯文本脚注提供不可跳转的标题。

挂载成功后返回 `WebShellFootnotePreviewHandle`，包含同步的 `update(info)` 与 `dispose()`。浮层打开时挂载，翻页/流式数据变化时更新而不重建宿主视图，关闭/卸载、替换挂载函数或回退时清理。React StrictMode 可能多次挂载/清理，每次成功挂载对应一次清理。宿主应保持挂载函数引用稳定，自行处理异步错误，并在挂载尚未返回句柄就抛错时清理已申请的资源。同步 mount/update/cleanup 错误不会破坏报告；切换页面/数据或更换挂载函数后可以重试。

自定义内容保留在 Web Shell Portal 及有高度边界的滚动区域内。原生 DOM/SolidJS 接入不需要创建 React 元素；Solid 宿主按自身需要保留响应式 owner，返回更新和清理方法。此插槽不改变 `components.sup` 退出聚合的优先级，也不用于静态文档脚注。

Demo 提供默认/自定义内容两种模式：自定义内容用原生 DOM 挂载，将 Qwen 管理的来源链接放进布局，使用内建分页器更新。单测与浏览器验收覆盖数据隔离、当前页/完整列表、挂载/更新/清理、回退/恢复、来源接管、焦点/翻页、流式更新与静态导出。

最小原生 DOM 接入示例：

```js
const markdown = {
  mountFootnotePreview(container, initial) {
    const summary = container.ownerDocument.createElement('p');
    const update = (info) => {
      summary.textContent = info.footnote.summary;
      container.replaceChildren(info.sourceLink, summary);
    };
    update(initial);
    return {
      update,
      dispose() {
        container.replaceChildren();
      },
    };
  },
};
```

## 宿主链接与范围

卡片标题继续通过宿主现有 `components.a` 渲染。内部脚注和返回正文链接沿用内建导航。普通 HTTP(S) 链接正常打开；宿主也可使用 `https://citation.invalid/dataworks-knowledge#...` 等 sentinel 携带私有定位字段，点击后校验、解析并打开自己的面板。Web Shell 不解析业务字段，也不拼接 OpenCode 业务 URL。没有宿主解析器时 sentinel 不可导航。Demo 使用固定数据、普通脚注 ID、两种正文资源图标、独立操作栏资源图标和示意右侧面板。

聚合不依赖 sentinel 或业务来源格式。脚注表达报告声称引用的内容，不证明执行过检索或结论已获证据支持。Session Sources 是独立的会话来源目录。本次不增加 MCP、Core 引用协议、网页元数据请求或业务 URL 解析器。

## 实现与验收

修改范围为 Web Shell 公开类型/导出、现有 Markdown AST 转换、脚注卡片、Assistant 操作栏接线、Demo 和测试。没有待定设计问题。

定向测试覆盖各种 ID、多行原文及 transform 后内容、安全字段、分组/消息完整列表、同 URL 不合并、两个函数独立与回退、默认/自定义尺寸、流式更新、缺失 definition、部分转换、宿主链接、复制及静态导出。开发和生产浏览器 E2E 覆盖聚合、长说明滚动、翻页保持打开、消息 Hover、键盘/触屏、主题、视口/Portal 和跨消息隔离。开发 Demo 额外验证自定义 SVG 资源和宿主面板，生产验收使用构建产物。完成构建和类型检查。
