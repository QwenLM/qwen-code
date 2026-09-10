# Markdown 来源脚注卡片

[English](./markdown-footnote-cards.md)

## 问题

报告中的一条结论可能同时引用网页、文件、附件或私有知识。标准 GFM 脚注会把这些引用显示为分散数字和很长的文末列表，读者需要离开正文才能逐个查看。私有来源还可能只有稳定定位字段，没有长期可用的 URL。

## 决策

使用 identifier 以 `source-` 开头的标准 GFM footnote 作为可复制的来源格式。Web Shell 将相邻来源脚注聚合成知识库图标，每页预览一个来源，并显示本条消息的唯一来源数。其他脚注继续保留标准数字、文末定义和返回导航。

来源 definition 中的第一个链接同时提供标题和打开目标。普通 HTTP(S) 地址按原逻辑打开；宿主也可以把稳定字段编码到固定 HTTPS sentinel 中，只在用户点击后解析。Web Shell 不理解 provider 字段，也不拼接业务 URL。

```markdown
订单遵循统一业务口径。[^source-1][^source-2]

这句话还有一个普通说明脚注。[^note-1]

[^source-1]: [订单定义](https://example.com/orders) — 定义和适用范围。

[^source-2]: [订单规范](https://citation.invalid/dataworks-knowledge#v=1&kind=content&kbInstanceId=INSTANCE&sourceFileId=FILE&citationId=CITATION&relativePath=docs%2Forder.md&anchor=definition 'DataWorks Knowledge') — 对应原文片段。

[^note-1]: 这里仍是普通脚注。
```

## 展示行为

- 只将 definition 完整的 `source-*` 脚注变成来源卡片。definition 缺失或格式不合法时安全降级，不删除回答正文。
- 在同一个行内父节点中聚合相邻来源脚注，允许中间只有空白。正文、标点、普通脚注、块和表格单元格都会中断聚合。
- 按首次引用顺序用 definition ID 去重。单来源 marker 只显示 SVG；多来源 marker 同时显示唯一来源数。
- Hover、聚焦或点击打开卡片。仅由 Hover 打开的卡片在指针离开后关闭；点击入口或分页器后保持打开，直到按 Escape 或点击外部。每个 definition 对应一页，键盘、触屏、首尾按钮、流式更新、主题、窄屏和 portal 沿用 Web Shell 现有交互规则。
- 有链接的 definition 取第一个安全链接文字作为标题、可选 link title 作为来源标签，其余文本作为摘要；无链接时取第一个 strong text 作为标题。第一个安全图片仍可作为缩略图。
- 只有某个来源的全部引用都已转成卡片时，才从文末列表移除该 definition；仍被标准引用指向的来源、普通脚注及其返回链接继续保留。没有这些内容时移除整个 footer。
- 消息底部显示 `N 个引用`，只统计该 assistant message 正文实际引用的唯一来源 definition。入口位于复制、分支和时间所在的 assistant 操作栏，沿用整条消息 Hover/聚焦时显示、触屏设备常驻的行为；Hover、聚焦或点击引用入口时复用同一个分页卡片查看本条消息全部引用。没有 assistant 操作栏的独立 Markdown 界面继续使用正文后的聚合入口作为降级。
- 静态文档导出保留标准 Markdown 脚注；高级表格提取文本时保留原始引用数字，来源 Markdown 本身保持不变。

## 宿主链接接入

卡片内的来源标题使用宿主已有的 Markdown `components.a` renderer。正文 footnote reference、普通 definition 和 backreference 始终使用 Web Shell 内建锚点逻辑，不交给宿主 renderer。

这样嵌入宿主无需新增 provider 专用的 Web Shell API，即可接管来源定位：

```text
Footnote 来源链接
→ 宿主 components.a
→ 宿主校验并解析 locator
→ 宿主打开自己的预览区域
```

Demo 使用 `https://citation.invalid/dataworks-knowledge#...` 作为 sentinel。provider 字段放在 fragment 中，不会发送到网络。宿主必须在普通 HTTP(S) 分支前消费整个 `citation.invalid` namespace，把受控操作渲染为 `href="#"` 或 button，不能把 sentinel 留成可导航 DOM URL。版本、path、重复或未知字段、必填字段和长度校验失败时均保持不可打开。

开发态 Demo 只使用一个固定的合法 fixture，用于证明链接交接和右侧面板打开。生产 locator 校验及最终 URL 拼接由嵌入宿主实现。

Locator 是不可信 Markdown，不能决定 BFF host、endpoint、凭证或最终 URL。宿主始终使用当前会话凭证及固定 builder 或受鉴权 resolver。某种 locator 尚无 resolver 时，卡片仍可阅读，但打开入口禁用。

## 边界

- Footnote marker 只表示最终 Markdown 声称引用了该来源，不证明来源来自某次工具调用，也不证明来源内容必然支持结论。
- 一个 definition 只能保存一个 locator。复用来源 ID 会复用同一位置；需要不同 anchor 时使用不同 ID，或以后升级结构化 Citation。
- Session Sources 是独立的会话参考资料目录，其数量不能作为消息引用数。
- 本方案不引入 MCP server、Extension tool 协议、provider metadata store，也不抓取网页 metadata。

## 验证

单元测试覆盖来源范围、聚合、去重、来源 footer 隐藏、普通脚注导航、strong 标题、宿主链接接管、不安全链接、流式更新、静态导出和表格复制。浏览器测试用固定报告分别回放开发构建与生产构建，覆盖 SVG、单/多来源 marker、分页卡片、消息 footer、键盘/触屏、主题、窄屏和 portal 隔离。

宿主侧最终 URL builder 不属于本 PR。Qwen Demo 负责证明完整 sentinel 会到达宿主 renderer；普通脚注导航保持隔离由单元测试和浏览器测试分别验证。
