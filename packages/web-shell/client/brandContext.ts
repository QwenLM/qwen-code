import { createContext, useContext, type ReactNode } from 'react';

/**
 * Product branding the shell presents. An empty value means "use the built-in
 * brand", so a deployment that configures nothing renders exactly what it
 * rendered before branding was configurable.
 */
export interface WebShellBrand {
  /**
   * Product name. Absent *or empty* means {@link DEFAULT_BRAND_NAME} — the
   * settings surface documents an empty value as "use the built-in name", and a
   * host mirroring that convention must not blank the sidebar.
   */
  name?: string;
  /**
   * Logo node rendered in place of the built-in mark. Only an embedding host
   * can supply this; the daemon-resolved brand carries `logoDataUri` instead.
   */
  logo?: ReactNode;
  /**
   * Logo as a `data:image/svg+xml` URI.
   *
   * Always render it as an `img` src, never as injected markup. SVG loaded as
   * an image cannot run script; SVG injected into the document can, and the
   * daemon does not sanitize the file it read. This is the invariant that makes
   * the absence of a sanitizer on the server correct.
   */
  logoDataUri?: string;
}

export const DEFAULT_BRAND_NAME = 'Qwen Code';

/**
 * The payload of `onBrandResolved` — the subset of `WebShellBrand` a host
 * document can act on. `logo` (a React node) is deliberately absent: a document
 * can apply a title and a favicon URI but never renders a node, and the node
 * has no stable identity to key a change notification on.
 */
export type WebShellResolvedBrand = Pick<WebShellBrand, 'name' | 'logoDataUri'>;

/**
 * Stable identity for "no brand configured". Returning a fresh `{}` from a hook
 * would change the provider value on every render and re-render every consumer.
 */
export const EMPTY_BRAND: WebShellBrand = {};

const BrandContext = createContext<WebShellBrand>(EMPTY_BRAND);

export const BrandProvider = BrandContext.Provider;

export function useBrand(): WebShellBrand {
  return useContext(BrandContext);
}

export function useBrandName(): string {
  // Truthiness, not `??`: an empty name means "use the built-in one" on the
  // settings surface, so it must mean the same through the host prop.
  return useContext(BrandContext).name || DEFAULT_BRAND_NAME;
}
