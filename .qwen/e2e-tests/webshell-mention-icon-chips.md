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
