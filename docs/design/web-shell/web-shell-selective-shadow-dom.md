# Web Shell selective Shadow DOM

## Motivation

Web Shell can be embedded in pages that own aggressive global rules such as
`* { padding: 0 }`, `h2 { ... }`, or `button { ... }`. The existing scoped Web
Shell CSS prevents Web Shell rules from leaking into the host, but CSS cascade
scoping cannot prevent host selectors from matching elements inside Web Shell.

The isolation must be opt-in so existing integrations keep their current DOM,
query, and styling behavior.

## Public API

`WebShell` and `WebShellWithProviders` accept a `shadowDom` option:

```tsx
<WebShell
  shadowDom={{
    plugins: true,
    portals: true,
    styles: customShadowCss,
  }}
/>
```

- `plugins` isolates only the plugin manager page body.
- `portals` isolates the single shared Web Shell portal root. It therefore
  applies to every dialog, drawer, popover, dropdown, select, and tooltip that
  uses the Web Shell portal context, including popups opened from plugins.
- `styles` adds consumer CSS to every enabled Web Shell shadow root. This is
  intended for custom render-prop content whose class rules otherwise live in
  the host document.
- `true` enables both scenes, while omitted or `false` keeps the existing Light
  DOM behavior.

The two scenes are independent. Enabling `plugins` never changes where a popup
renders; enabling `portals` never moves the plugin page body.

## Rendering model

Each enabled scene creates an open ShadowRoot and an inner element carrying the
existing Web Shell root marker. React renders into that element with
`createPortal`. It remains part of the original React tree: context, event
bubbling, refs, state, error boundaries, and render props retain their current
semantics. No second React root is created.

The plugin boundary wraps only `PluginManagerPage`. It intentionally does not
provide a new portal context. All portal-capable primitives continue to consume
the one context owned by `App`.

When `portals` is disabled, App creates the current Light DOM portal root under
`document.body`. When enabled, App creates a host under `document.body`, attaches
a ShadowRoot, and places the same portal-root element inside it. Existing theme,
language, and CSS-variable synchronization continues to target that inner
element.

## Styles

The package's compiled and scoped CSS is copied into every enabled ShadowRoot.
Published library builds use the marked style element already injected by the
package. Development builds copy Vite style elements belonging to Web Shell.
The optional consumer `styles` text is appended after package CSS so integrations
can style their render-prop output. Consumers can import a stylesheet as text
(for example, `import styles from './web-shell-shadow.css?inline'`) and pass it
without changing their component or render callback structure.

Styles are installed before React content is mounted. Browsers with
constructable stylesheet support reuse one parsed package stylesheet across the
plugin and portal roots; style elements remain the compatibility fallback.

CSS custom properties set through the existing root `style` prop continue to
inherit into the plugin shadow tree and are copied to the global portal root.

The shadow host itself remains in the host document, so critical host layout is
set with inline styles. Elements below the boundary are protected from ordinary
host selectors such as `*`, element selectors, and host utility classes.
The portal host owns a separate stacking context at
`--web-shell-portal-root-z-index` (default `1000`) so descendant dialog z-indexes
are not trapped below sticky Web Shell content.

## Compatibility and lifecycle

The feature requires Shadow DOM support. The option is intended as mount-time
configuration. Changing it at runtime recreates the affected surface and can
close an open popup or remount plugin-page state.

The default path does not create a ShadowRoot, preserving existing selectors,
tests, and host styling integrations.
