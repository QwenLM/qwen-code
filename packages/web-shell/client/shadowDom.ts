export interface WebShellShadowDomOptions {
  /** Isolate the plugin manager page body from host-page CSS. */
  plugins?: boolean;
  /** Isolate every Web Shell portal surface from host-page CSS. */
  portals?: boolean;
  /** Additional CSS applied inside every enabled Web Shell ShadowRoot. */
  styles?: string;
}

export type WebShellShadowDom = boolean | WebShellShadowDomOptions;

export interface ResolvedWebShellShadowDomOptions {
  plugins: boolean;
  portals: boolean;
  styles?: string;
}

export function resolveWebShellShadowDom(
  value: WebShellShadowDom | undefined,
): ResolvedWebShellShadowDomOptions {
  if (typeof value === 'boolean') {
    return { plugins: value, portals: value };
  }
  return {
    plugins: value?.plugins ?? false,
    portals: value?.portals ?? false,
    styles: value?.styles,
  };
}

const packageStyleSheetCache = new WeakMap<
  Document,
  { css: string; sheet: CSSStyleSheet }
>();

function getWebShellStyleText(document: Document): string {
  const injectedStyle = document.querySelector<HTMLStyleElement>(
    'style[data-qwen-web-shell="component"]',
  );
  if (injectedStyle?.textContent) return injectedStyle.textContent;

  return Array.from(
    document.querySelectorAll<HTMLStyleElement>('style[data-vite-dev-id]'),
  )
    .filter((style) => {
      const id = style.dataset.viteDevId ?? '';
      return (
        id.includes('/packages/web-shell/') || id.includes('/web-shell/client/')
      );
    })
    .map((style) => style.textContent ?? '')
    .filter(Boolean)
    .join('\n');
}

function createStyleSheet(
  document: Document,
  css: string,
): CSSStyleSheet | null {
  const StyleSheet = document.defaultView?.CSSStyleSheet;
  if (!StyleSheet || typeof StyleSheet.prototype.replaceSync !== 'function') {
    return null;
  }
  const sheet = new StyleSheet();
  sheet.replaceSync(css);
  return sheet;
}

function getPackageStyleSheet(
  document: Document,
  css: string,
): CSSStyleSheet | null {
  const cached = packageStyleSheetCache.get(document);
  if (cached?.css === css) return cached.sheet;
  const sheet = createStyleSheet(document, css);
  if (sheet) packageStyleSheetCache.set(document, { css, sheet });
  return sheet;
}

export function installWebShellShadowStyles(
  shadowRoot: ShadowRoot,
  additionalStyles?: string,
): () => void {
  const packageCss = getWebShellStyleText(shadowRoot.ownerDocument);
  const styles = [packageCss, additionalStyles].filter((css): css is string =>
    Boolean(css),
  );
  try {
    const packageSheet = packageCss
      ? getPackageStyleSheet(shadowRoot.ownerDocument, packageCss)
      : null;
    const additionalSheet = additionalStyles
      ? createStyleSheet(shadowRoot.ownerDocument, additionalStyles)
      : null;
    const sheets = [packageSheet, additionalSheet].filter(
      (sheet): sheet is CSSStyleSheet => Boolean(sheet),
    );
    if (sheets.length === styles.length && sheets.length > 0) {
      shadowRoot.adoptedStyleSheets = [
        ...shadowRoot.adoptedStyleSheets,
        ...sheets,
      ];
      return () => {
        shadowRoot.adoptedStyleSheets = shadowRoot.adoptedStyleSheets.filter(
          (sheet) => !sheets.includes(sheet),
        );
      };
    }
  } catch {
    // Fall back to style elements in browsers without constructable sheets.
  }
  const elements = styles.map((css) => {
    const style = shadowRoot.ownerDocument.createElement('style');
    style.dataset.qwenWebShellShadow = '';
    style.textContent = css;
    shadowRoot.appendChild(style);
    return style;
  });
  return () => {
    for (const style of elements) style.remove();
  };
}
