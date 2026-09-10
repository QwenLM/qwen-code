import type { Element, ElementContent, Root, RootContent } from 'hast';

export interface FootnotePreview {
  id: string;
  number: string;
  title: string;
  summary: string;
  source?: string;
  href?: string;
  image?: string;
  linkNode?: Element;
}

export interface FootnoteElement extends Element {
  data?: Element['data'] & {
    footnoteCards?: FootnotePreview[];
    footnoteSourcesFooter?: boolean;
    hasVisibleFootnotes?: boolean;
  };
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

function isSourceDefinition(id: string): boolean {
  return id.toLowerCase().startsWith('user-content-fn-source-');
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
    let number = 0;
    const definitionNumbers = new Map<string, number>();
    for (const node of list?.children ?? []) {
      if (node.type !== 'element' || node.tagName !== 'li') continue;
      number += 1;
      const id = String(node.properties.id);
      definitionNumbers.set(id, number);
      if (!isSourceDefinition(id)) continue;
      let link: Element | undefined;
      let strong: Element | undefined;
      let source: string | undefined;
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
            const title = child.properties.title;
            source =
              typeof title === 'string' ? title.trim() || undefined : undefined;
          }
        }
        if (
          child.tagName === 'strong' &&
          !strong &&
          child.properties.dataFootnoteBackref === undefined
        ) {
          strong = child;
        }
        if (child.tagName === 'img' && !image && child.properties.src) {
          const url = options.transformUrl(String(child.properties.src));
          if (options.safeImage(url)) image = url;
        }
      });
      const titleNode = link ?? strong;
      const title = titleNode ? noteText(titleNode).trim() : '';
      if (!title) continue;
      definitions.set(`#${id}`, {
        id,
        number: String(number),
        title,
        summary: noteText(node, titleNode).replace(/\s+/g, ' ').trim(),
        source,
        href,
        image,
        linkNode: link,
      });
    }

    const referencedSources = new Map<string, FootnotePreview>();
    const convertedReferences = new Set<Element>();

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
          referencedSources.set(preview.id, preview);
          convertedReferences.add(item);
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
      if (referencedSources.size > 0 && list) {
        const definitionsWithVisibleReferences = new Set<string>();
        visit(tree, (node) => {
          if (
            node.properties.dataFootnoteRef === undefined ||
            convertedReferences.has(node)
          ) {
            return;
          }
          const definition = definitions.get(String(node.properties.href));
          if (definition) definitionsWithVisibleReferences.add(definition.id);
        });
        const enhancedIds = new Set(
          [...referencedSources.values()]
            .filter(
              (definition) =>
                !definitionsWithVisibleReferences.has(definition.id),
            )
            .map((definition) => definition.id),
        );
        list.children = list.children.filter(
          (child) =>
            child.type !== 'element' ||
            child.tagName !== 'li' ||
            !enhancedIds.has(String(child.properties.id)),
        );
        for (const child of list.children) {
          if (child.type !== 'element' || child.tagName !== 'li') continue;
          const originalNumber = definitionNumbers.get(
            String(child.properties.id),
          );
          if (originalNumber !== undefined)
            child.properties.value = String(originalNumber);
        }
        const hasVisibleFootnotes = list.children.some(
          (child) => child.type === 'element' && child.tagName === 'li',
        );
        const element = footer as FootnoteElement;
        element.data = {
          ...element.data,
          footnoteCards: [...referencedSources.values()],
          footnoteSourcesFooter: true,
          hasVisibleFootnotes,
        };
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
