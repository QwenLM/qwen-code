# WebShell composer placeholders

## Context

Today the main composer resolves its placeholder from internal i18n keys directly.
Embedders can localize the WebShell UI, but they cannot provide product-specific
copy for the main composer without forking the component or changing its
translations.

## Goals

- Let embedders customize main-composer placeholder copy for its semantic UI
  states.
- Keep the existing localized placeholder for callers that do not opt in.
- Preserve the existing shell-mode and follow-up placeholder precedence.

## API

`WebShellProps` accepts an optional `composerPlaceholders` map:

```ts
type WebShellComposerPlaceholderState = 'idle' | 'loading' | 'processing';

type WebShellComposerPlaceholders = Partial<
  Record<WebShellComposerPlaceholderState, string>
>;
```

Both types are exported from the WebShell entry points. The map is optional and
its entries are optional so an embedder can customize one state while retaining
the standard copy for every other state.

## State and fallback behavior

The composer resolves one semantic state before resolving copy:

| State        | Condition                                              |
| ------------ | ------------------------------------------------------ |
| `loading`    | The connection is catching up.                         |
| `processing` | A prompt is being prepared or a response is streaming. |
| `idle`       | Neither of the above applies.                          |

`loading` takes precedence over `processing`, matching the existing
placeholder-key behavior. A configured value is used only when it contains
non-whitespace text; absent or blank values fall back to the corresponding
localized WebShell placeholder.

The new map affects only the main composer. Shell-mode and follow-up composers
retain their existing specialized placeholders, and split-view composers keep
their independent placeholder behavior.

## Verification

Unit tests cover all configured states, partial-map fallback, whitespace
fallback, and semantic state selection independently from i18n keys. The
embedding integration should verify its supplied idle copy renders in the host
without changing the default behavior for unconfigured states.
