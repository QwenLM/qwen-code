# §3.6 Table Inline Code

## Goal

> 表格内代码：禁用语法高亮，仅用等宽字体 + 灰色底色。

## Current

- `MarkdownDisplay.tsx:104-280` 解析 markdown，维护 `inCodeBlock` / `inTable` 状态。
- `TableRenderer.tsx` 渲染表格行；行内每个 cell 文本仍走 `InlineMarkdownRenderer` 处理，遇到 ` `code` ` 会调用 highlight 路径（基于 highlight.js token）。
- 痛点（提案附图 7）：表格中代码 cell 被高亮成五彩颜色，破坏对齐与可读性。

## Design

### Behaviour

在 markdown 解析或行内渲染层，对 **位于表格 cell 内** 的行内代码：

- 不调用 highlight.js
- 不使用 token 配色
- 渲染为：`Text color={theme.text.primary}` + `backgroundColor={theme.background.subtle}`（如存在），否则只用 `color={theme.text.primary}` 单色
- 字体本就是等宽（终端默认），无需改

### Implementation

`InlineMarkdownRenderer` 已有 `inTable` context（确认下；如果没有就 thread 进去）。增加 prop：

```tsx
<InlineMarkdownRenderer text={cell} inTable />
```

`InlineMarkdownRenderer` 渲染 ` `code` ` 时：

```tsx
if (inTable) {
  return (
    <Text backgroundColor={theme.background.subtle ?? undefined}>
      {token.text}
    </Text>
  );
}
// else: existing highlight path
```

如果 `theme.background.subtle` 在当前主题里不存在，**不**新加 theme key（避免触碰主题，符合 scope）—— 退化为 secondary 色单色：

```tsx
return <Text color={theme.text.secondary}>{token.text}</Text>;
```

> 这一处的 fallback 比加 bg 视觉差一些，但符合"暂不动主题"约束。

### Edge cases

- ` `code` ` 中含 markdown 转义字符：当前的 escape 处理保留。
- Table cell 内嵌入 code block（极少；markdown 严格不支持）：仍按现有逻辑。
- 多行 cell：表格 render 时已经把 `<br>` / `\n` 处理过；不需要改。

### Risk

- `InlineMarkdownRenderer` 可能被多处复用，新 prop `inTable` 必须有默认值 `false`，确保非表格上下文行为不变。

## Files touched

- `packages/cli/src/ui/utils/InlineMarkdownRenderer.tsx` — 加 `inTable` prop + 行内 code 渲染分支
- `packages/cli/src/ui/utils/TableRenderer.tsx` — 在渲染 cell 内容时传 `inTable`
- 测试新增：`InlineMarkdownRenderer.test.tsx` 加 `inTable` 用例
