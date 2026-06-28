/**
 * Markdown render seam. The panel never bundles a markdown engine — the host
 * injects its renderer (web-shell's `<Markdown>`, desktop's Tiptap/Shiki, …) and
 * its image-safety policy. The default is a plain-text fallback so the package
 * renders standalone. Carved call sites use `<Markdown>` unchanged; it just
 * resolves the injected renderer from context.
 */
import {
  createContext,
  useContext,
  type ReactNode,
  type ReactElement,
} from 'react';

export type MarkdownContentSource = 'assistant' | 'thinking';

export interface RenderMarkdownProps {
  content: string;
  source?: MarkdownContentSource;
  /** Hold mermaid rendering while text is still streaming. */
  deferMermaid?: boolean;
  /** Upgrade GFM tables to the interactive variant once streaming settles. */
  enhanceTables?: boolean;
}

export interface MarkdownSeam {
  /** Render markdown to React nodes. Host injects its full renderer. */
  renderMarkdown: (props: RenderMarkdownProps) => ReactNode;
  /** Host policy for whether an `<img src>` is safe to render. */
  isSafeImageSrc: (url: string | undefined) => boolean;
}

const DEFAULT_MARKDOWN: MarkdownSeam = {
  renderMarkdown: ({ content }) => content,
  isSafeImageSrc: () => false,
};

export const MarkdownContext = createContext<MarkdownSeam>(DEFAULT_MARKDOWN);

export function useMarkdown(): MarkdownSeam {
  return useContext(MarkdownContext);
}

/** Drop-in for the host `<Markdown>` component; defers to the injected seam. */
export function Markdown(props: RenderMarkdownProps): ReactElement {
  return <>{useMarkdown().renderMarkdown(props)}</>;
}
