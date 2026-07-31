declare module 'marked-terminal' {
  import type { MarkedExtension } from 'marked';

  interface MarkedTerminalOptions {
    code?: (code: string) => string;
    blockquote?: (quote: string) => string;
    html?: (html: string) => string;
    heading?: (text: string) => string;
    firstHeading?: (text: string) => string;
    hr?: () => string;
    listitem?: (text: string) => string;
    list?: (body: string, ordered: boolean) => string;
    table?: (header: string, body: string) => string;
    paragraph?: (text: string) => string;
    strong?: (text: string) => string;
    em?: (text: string) => string;
    codespan?: (code: string) => string;
    del?: (text: string) => string;
    link?: (href: string, title: string, text: string) => string;
    href?: (href: string) => string;
    showSectionPrefix?: boolean;
    unescape?: boolean;
    width?: number;
    reflowText?: boolean;
    tab?: number;
    emoji?: boolean;
  }

  export function markedTerminal(options?: MarkedTerminalOptions): MarkedExtension;
}
