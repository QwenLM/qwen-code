import type { Element, ElementContent, Root, RootContent } from 'hast';

export interface FootnotePreview {
  id: string;
  number: string;
  title: string;
  summary: string;
  href?: string;
  image?: string;
}

export interface FootnoteElement extends Element {
  data?: Element['data'] & { footnoteCards?: FootnotePreview[] };
}

interface FootnoteOptions {
  prefix: string;
  group: boolean;
  safeHref: (url: string) => boolean;
  safeImage: (url: string) => boolean;
  transformUrl: (url: string) => string;
}

function visit(node: Root | RootContent, fn: (node: Element) => void) {
  if (node.type === 'element') fn(node);
  if ('children' in node) {
    for (const child of node.children) visit(child, fn);
  }
}

function noteText(node: RootContent, omit?: Element): string {
  if (node === omit) return '';
  if (node.type === 'text') return node.value;
  if (node.type !== 'element') return '';
  if (node.properties.dataFootnoteBackref !== undefined) return '';
  const text = node.children.map((child) => noteText(child, omit)).join('');
  return /^(p|li|br|div)$/.test(node.tagName) ? `${text} ` : text;
}

function reference(node: RootContent): Element | undefined {
  if (node.type !== 'element' || node.tagName !== 'sup') return;
  const child = node.children[0];
  return node.children.length === 1 &&
    child?.type === 'element' &&
    child.tagName === 'a' &&
    child.properties.dataFootnoteRef !== undefined
    ? child
    : undefined;
}

export function rehypeFootnoteCards(options: FootnoteOptions) {
  return (tree: Root) => {
    const definitions = new Map<string, FootnotePreview>();
    const anchors = new Map<string, string>();
    let footer: Element | undefined;
    visit(tree, (node) => {
      if (node.properties.dataFootnotes) footer = node;
      if (node.properties.dataFootnoteRef !== undefined) {
        const id = String(node.properties.id);
        anchors.set(id, options.prefix + id);
      }
    });
    if (!footer) return;

    visit(footer, (node) => {
      if (node.properties.id) {
        const id = String(node.properties.id);
        anchors.set(id, options.prefix + id);
      }
    });
    const list = footer.children.find(
      (node): node is Element =>
        node.type === 'element' && node.tagName === 'ol',
    );
    for (const node of list?.children ?? []) {
      if (node.type !== 'element' || node.tagName !== 'li') continue;
      let link: Element | undefined;
      let href: string | undefined;
      let image: string | undefined;
      visit(node, (child) => {
        if (
          child.tagName === 'a' &&
          !link &&
          child.properties.href &&
          child.properties.dataFootnoteBackref === undefined &&
          child.properties.dataFootnoteRef === undefined
        ) {
          const url = options.transformUrl(String(child.properties.href));
          if (options.safeHref(url)) {
            link = child;
            href = url;
          }
        }
        if (child.tagName === 'img' && !image && child.properties.src) {
          const url = options.transformUrl(String(child.properties.src));
          if (options.safeImage(url)) image = url;
        }
      });
      const id = String(node.properties.id);
      definitions.set(`#${id}`, {
        id,
        number: String(definitions.size + 1),
        title: link ? noteText(link).trim() || href || '' : '',
        summary: noteText(node, link).replace(/\s+/g, ' ').trim(),
        href,
        image,
      });
    }

    function group(parent: Element) {
      if (parent === footer || parent.tagName === 'a') return;
      const children = parent.children;
      const grouped: typeof children = [];
      for (let i = 0; i < children.length; i++) {
        const first = children[i];
        grouped.push(first);
        const ref = reference(first);
        if (!ref || !definitions.has(String(ref.properties.href))) {
          if (first.type === 'element') group(first);
          continue;
        }
        const refs = [ref];
        let end = i + 1;
        for (let j = end; j < children.length; j++) {
          const next = children[j];
          if (next.type === 'text' && /^\s*$/.test(next.value)) continue;
          const nextRef = reference(next);
          if (!nextRef || !definitions.has(String(nextRef.properties.href)))
            break;
          refs.push(nextRef);
          end = j + 1;
        }
        const previews = new Map<string, FootnotePreview>();
        const id = String(ref.properties.id);
        for (const item of refs) {
          const preview = definitions.get(String(item.properties.href))!;
          previews.set(preview.id, preview);
          anchors.set(String(item.properties.id), options.prefix + id);
        }
        const element = first as FootnoteElement;
        element.properties.id = id;
        element.data = {
          ...element.data,
          footnoteCards: [...previews.values()],
        };
        // Preserve the original reference text for advanced-table extraction.
        element.children = children
          .slice(i, end)
          .flatMap<ElementContent>((child) => {
            if (child.type === 'text') return [child];
            const ref = reference(child);
            return ref ? [ref] : [];
          });
        i = end - 1;
      }
      parent.children = grouped;
    }
    if (options.group) {
      for (const child of tree.children) {
        if (child.type === 'element') group(child);
      }
    }
    visit(tree, (node) => {
      const { properties } = node;
      if (properties.id && anchors.has(String(properties.id))) {
        properties.id = anchors.get(String(properties.id));
      }
      if (
        typeof properties.href === 'string' &&
        properties.href.startsWith('#')
      ) {
        const target = anchors.get(properties.href.slice(1));
        if (target) properties.href = `#${target}`;
      }
      if (Array.isArray(properties.ariaDescribedBy)) {
        properties.ariaDescribedBy = properties.ariaDescribedBy.map(
          (id) => anchors.get(String(id)) ?? id,
        );
      }
    });
  };
}
