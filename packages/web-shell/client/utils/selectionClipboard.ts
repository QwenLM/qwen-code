import TurndownService from 'turndown';

const IGNORED =
  '[data-selection-copy-ignore], [hidden], .markdown-chart-data-notice, [data-footnote-backref], [data-markdown-chart-loading], .markdown-chart-error, [aria-hidden="true"]:not(.katex-html), .katex-mathml, button, select, input, textarea, svg, style, script';
const BLOCKS = /^(P|H[1-6]|DIV|SECTION|BLOCKQUOTE|UL|OL|LI|PRE|TR)$/;

export function getReplySelectionRange(body: HTMLElement): Range | null {
  const root = body.getRootNode() as Document | ShadowRoot;
  const selection =
    (root as Document).getSelection?.() ?? body.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1)
    return null;
  let range = selection.getRangeAt(0);
  if (root instanceof ShadowRoot) {
    const composed = (
      selection as Selection & {
        getComposedRanges?: (options: {
          shadowRoots: ShadowRoot[];
        }) => StaticRange[];
      }
    ).getComposedRanges?.({ shadowRoots: [root] })[0];
    if (composed) {
      range = body.ownerDocument.createRange();
      range.setStart(composed.startContainer, composed.startOffset);
      range.setEnd(composed.endContainer, composed.endOffset);
    }
  }
  return !range.collapsed &&
    body.contains(range.startContainer) &&
    body.contains(range.endContainer)
    ? range
    : null;
}

function cloneSelected(node: Node, range: Range): Node | null {
  if (!range.intersectsNode(node)) return null;
  if (node instanceof Element && node.matches(IGNORED)) return null;
  if (node instanceof Element && node.matches('.katex')) {
    const source = node.querySelector(
      'annotation[encoding="application/x-tex"]',
    )?.textContent;
    const visible = node.querySelector('.katex-html');
    if (source && visible) {
      const walker = node.ownerDocument.createTreeWalker(
        visible,
        NodeFilter.SHOW_TEXT,
      );
      const first = walker.nextNode();
      let last = first;
      while (walker.nextNode()) last = walker.currentNode;
      if (
        first &&
        last &&
        range.comparePoint(first, 0) === 0 &&
        range.comparePoint(last, last.textContent!.length) === 0
      ) {
        const math = node.ownerDocument.createElement('span');
        math.dataset.selectionCopyMath = node.closest('.katex-display')
          ? 'display'
          : 'inline';
        math.textContent = source;
        return math;
      }
      return cloneSelected(visible, range);
    }
  }
  if (node.nodeType === Node.TEXT_NODE) {
    const start = node === range.startContainer ? range.startOffset : 0;
    const end =
      node === range.endContainer ? range.endOffset : node.textContent!.length;
    return end > start
      ? node.ownerDocument!.createTextNode(node.textContent!.slice(start, end))
      : null;
  }
  const clone = node.cloneNode(false);
  const checkbox =
    node instanceof HTMLLIElement
      ? node.querySelector<HTMLInputElement>(
          ':scope > input[type="checkbox"][disabled], :scope > p > input[type="checkbox"][disabled]:first-child',
        )
      : null;
  let taskHost: Node | null = checkbox?.parentElement === node ? clone : null;
  let ordinal = node instanceof HTMLOListElement ? node.start : 0;
  for (const child of node.childNodes) {
    const selected = cloneSelected(child, range);
    if (child === checkbox?.parentElement) taskHost = selected;
    if (clone instanceof HTMLOListElement && child instanceof HTMLLIElement) {
      if (child.hasAttribute('value')) ordinal = child.value;
      if (selected instanceof HTMLLIElement)
        selected.dataset.selectionCopyOrdinal = String(ordinal);
      ordinal++;
    }
    if (selected) clone.appendChild(selected);
  }
  if (clone instanceof HTMLLIElement) {
    if (!clone.textContent?.trim() && !clone.querySelector('img')) return null;
    const onlyNestedLists = Array.from(clone.childNodes).every(
      (child) =>
        child.nodeName === 'UL' ||
        child.nodeName === 'OL' ||
        (child.nodeType === Node.TEXT_NODE && !child.textContent?.trim()),
    );
    if (onlyNestedLists) clone.dataset.selectionCopyListWrapper = '';
    if (checkbox && taskHost && !onlyNestedLists) {
      const marker = clone.ownerDocument.createElement('span');
      marker.dataset.selectionCopyTask = checkbox.checked ? '[x] ' : '[ ] ';
      marker.textContent = marker.dataset.selectionCopyTask;
      taskHost.insertBefore(marker, taskHost.firstChild);
    }
  }
  if (
    clone instanceof HTMLTableRowElement &&
    !clone.textContent?.trim() &&
    !clone.querySelector('img') &&
    !(
      range.comparePoint(node, 0) === 0 &&
      range.comparePoint(node, node.childNodes.length) === 0
    )
  )
    return null;
  if (clone instanceof HTMLTableCellElement) {
    clone.dataset.copyColumn = String((node as HTMLTableCellElement).cellIndex);
  }
  return clone.hasChildNodes() ||
    (node instanceof Element && ['BR', 'HR', 'IMG'].includes(node.tagName)) ||
    node instanceof HTMLTableCellElement
    ? clone
    : null;
}

function plainText(node: Node): string {
  if (node instanceof Element && node.hasAttribute('data-selection-copy-task'))
    return '';
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? '';
    return !text.trim() &&
      /^(DIV|UL|OL|TABLE|THEAD|TBODY|TR)$/.test(node.parentNode?.nodeName ?? '')
      ? ''
      : text;
  }
  const tag = node.nodeName;
  if (
    node instanceof Element &&
    node.getAttribute('data-selection-copy-math') === 'display'
  )
    return `${node.textContent}\n`;
  if (node instanceof HTMLImageElement) return node.alt;
  if (tag === 'BR') return '\n';
  if (tag === 'PRE') return `${node.textContent}\n`;
  const children = Array.from(node.childNodes).reduce((text, child) => {
    const value = plainText(child);
    const startsBlock =
      BLOCKS.test(child.nodeName) ||
      (child instanceof Element &&
        child.getAttribute('data-selection-copy-math') === 'display');
    const separator =
      value && startsBlock && text && !text.endsWith('\n') ? '\n' : '';
    return text + separator + value;
  }, '');
  if (tag === 'TD' || tag === 'TH')
    return `${children.replace(/^\n+|\n+$/g, '').replace(/\n+/g, ' ')}\t`;
  if (tag === 'TR') return `${children.replace(/\t$/, '')}\n`;
  return BLOCKS.test(tag) ? `${children.replace(/\n+$/, '')}\n` : children;
}

const markdown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});
markdown.addRule('orderedListItem', {
  filter: (node) => node.hasAttribute('data-selection-copy-ordinal'),
  replacement: (content, node) => {
    const prefix = `${node.dataset.selectionCopyOrdinal}.  `;
    const trailing = content.endsWith('\n') ? '\n' : '';
    const indented = (content.replace(/^\n+|\n+$/g, '') + trailing).replace(
      /\n/g,
      `\n${' '.repeat(prefix.length)}`,
    );
    return prefix + indented + (node.nextSibling ? '\n' : '');
  },
});
markdown.addRule('unselectedListAncestor', {
  filter: (node) => node.hasAttribute('data-selection-copy-list-wrapper'),
  replacement: (content, node) =>
    content + (node.nextSibling && !content.endsWith('\n') ? '\n' : ''),
});
markdown.addRule('math', {
  filter: (node) => node.hasAttribute('data-selection-copy-math'),
  replacement: (_content, node) =>
    node.dataset.selectionCopyMath === 'display'
      ? `\n\n$$\n${node.textContent}\n$$\n\n`
      : `$${node.textContent}$`,
});
markdown.addRule('heading', {
  filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
  replacement: (content, node) => {
    const prefix = '#'.repeat(Number(node.nodeName[1]));
    return `\n\n${prefix} ${content.replace(/^(\d+)\\\.(?= )/, '$1.')}\n\n`;
  },
});
markdown.addRule('taskCheckbox', {
  filter: (node) => node.hasAttribute('data-selection-copy-task'),
  replacement: (_content, node) => node.dataset.selectionCopyTask ?? '',
});
markdown.addRule('strikethrough', {
  filter: ['del', 's'],
  replacement: (content) => `~~${content}~~`,
});
markdown.addRule('table', {
  filter: 'table',
  replacement: (_content, node) => {
    const rows = Array.from((node as HTMLTableElement).rows);
    const columns = [
      ...new Set(
        rows.flatMap((row) =>
          Array.from(row.cells, (cell) => Number(cell.dataset.copyColumn)),
        ),
      ),
    ].sort((a, b) => a - b);
    const line = (row?: HTMLTableRowElement) =>
      `| ${columns
        .map((column) => {
          const cell =
            row &&
            Array.from(row.cells).find(
              (item) => Number(item.dataset.copyColumn) === column,
            );
          return cell
            ? markdown.turndown(cell).replace(/\n+/g, ' ').replace(/\|/g, '\\|')
            : '';
        })
        .join(' | ')} |`;
    const hasHeader = rows[0]?.querySelector('th');
    return `\n\n${line(hasHeader ? rows.shift() : undefined)}\n| ${columns.map(() => '---').join(' | ')} |\n${rows.map((row) => line(row)).join('\n')}\n\n`;
  },
});
markdown.addRule('code', {
  filter: 'pre',
  replacement: (_content, node) => {
    const code = node.textContent ?? '';
    let longest = 2;
    for (const match of code.matchAll(/`+/g))
      longest = Math.max(longest, match[0].length);
    const fence = '`'.repeat(longest + 1);
    const language =
      node
        .closest('[data-selection-code-language]')
        ?.getAttribute('data-selection-code-language') ?? '';
    return `\n\n${fence}${language}\n${code.replace(/\n$/, '')}\n${fence}\n\n`;
  },
});

export function getSelectedReplyContent(body: HTMLElement, range: Range) {
  if (
    !body.contains(range.startContainer) ||
    !body.contains(range.endContainer)
  ) {
    return null;
  }
  const selected = cloneSelected(body, range) as HTMLElement | null;
  if (!selected) return null;
  const text = plainText(selected).replace(/^\n+|\n+$/g, '');
  const formatted = markdown.turndown(selected);
  if (!text.trim() && !formatted.trim()) return null;
  return { text, markdown: formatted };
}
