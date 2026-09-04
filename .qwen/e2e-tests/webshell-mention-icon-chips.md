# Web Shell mention icon chips verification

## Test groups

### Built-in mention chips

Verify that accepting an extension, file, or MCP @ mention inserts the original serialized text into the editor and attaches an inline composer tag over the inserted reference. The visible result should be an inline chip with the built-in icon instead of plain `@ext:...`, `@mcp:...`, or file reference text.

### Custom mention chips

Register an `atProvider` whose item provides `composerTag.kind = 'table'` and pass `composerTagIcons={{ table: '<icon-url>' }}` to `WebShell`. Accepting the item should insert the provider's `insertText` and render an inline chip using the registered table icon.

### Regression coverage

Verify custom icon lookup ignores inherited object properties, built-in icons still resolve without a custom registry, and icon URLs are escaped before being written into CSS custom properties.

## Local verification

- `cd packages/web-shell && npx vitest run client/hooks/useComposerCore.test.ts client/hooks/useAtMentionMenu.test.tsx client/components/composerTagIcons.test.ts client/utils/cssUrlVar.test.ts`
- Result: passed, 4 files and 80 tests.
- `npx eslint packages/web-shell/client/customization.tsx packages/web-shell/client/components/composerTagIcons.ts packages/web-shell/client/components/composerTagIcons.test.ts packages/web-shell/client/components/ChatEditor.tsx packages/web-shell/client/hooks/useAtMentionMenu.ts packages/web-shell/client/hooks/useAtMentionMenu.test.tsx packages/web-shell/client/hooks/useComposerCore.ts packages/web-shell/client/hooks/useComposerCore.test.ts packages/web-shell/client/index.ts packages/web-shell/client/App.tsx packages/web-shell/client/utils/cssUrlVar.ts packages/web-shell/client/utils/cssUrlVar.test.ts`
- Result: passed.
- `npm run build --workspace=packages/web-shell`
- Result: passed with existing Vite large chunk warnings.

## Not run

Manual browser screenshots were not captured in this environment. The behavior is covered at the hook and rendering helper boundaries, and the package build validates the web-shell bundle.

## Built-in SVG data URI regression (2026-07-16)

### Baseline

- Global `qwen --version`: `0.18.5-preview.0`.
- The pre-fix DOM matrix resolved all four built-in icons to `data:image/svg+xml` URLs, then rendered zero icon mask nodes in inline composer tags, top composer tags, and submitted user-message tags.

### Verification

- Accepting an extension from the `@` menu still inserts an inline tag with `kind: 'extension'`.
- Inline composer tags, top composer tags, and submitted user-message tags each render four icon mask nodes for extension, file, MCP, and skill references.
- Arbitrary SVG data URIs and `javascript:` custom icon URLs remain absent from the DOM on all three surfaces.
- Focused WebShell result: 5 files and 128 tests passed, including the extension `@` acceptance path.
- Full repository build passed after installing the dependency set declared by the existing lockfile; full repository typecheck passed.
