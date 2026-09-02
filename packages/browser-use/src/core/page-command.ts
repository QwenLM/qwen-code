/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Serialized and evaluated by the trusted backend inside the claimed tab. Model
// input is data (a validated locator plan and action arguments), never
// executable source. The program resolves locators with Playwright-like
// semantics, waits for actionability, and renders DOM snapshots whose entries
// carry stable refs ([n12]) that later commands can address directly.
type TextMatcher =
  | string
  | {
      regex: string;
      flags?: string;
    };

type LocatorStep =
  | { kind: 'locator' | 'frame'; selector: string }
  | { kind: 'ref'; ref: string }
  | {
      kind: 'getByRole';
      role: string;
      name?: TextMatcher;
      exact?: boolean;
    }
  | { kind: 'getByText' | 'getByLabel'; text: TextMatcher; exact?: boolean }
  | { kind: 'getByPlaceholder'; text: TextMatcher; exact?: boolean }
  | { kind: 'getByTestId'; testId: string }
  | {
      kind: 'filter';
      hasText?: TextMatcher;
      hasNotText?: TextMatcher;
      has?: LocatorStep[];
      hasNot?: LocatorStep[];
      visible?: boolean;
    }
  | { kind: 'first' | 'last' }
  | { kind: 'nth'; index: number }
  | { kind: 'and' | 'or'; steps: LocatorStep[] };

interface SelectOptionRequest {
  index?: number;
  label?: string;
  value?: string;
}

interface PageCommandArgs {
  documentId?: string;
  expectedDocumentId?: string;
  filter?: 'interactive' | 'all';
  footer?: boolean;
  indent?: number;
  maxChars?: number;
  name?: string;
  refPrefix?: string;
  requirements?: { visible?: boolean; enabled?: boolean; editable?: boolean };
  root?: string;
  state?: 'attached' | 'detached' | 'visible' | 'hidden';
  timeoutMs?: number;
  value?: string | Array<string | SelectOptionRequest>;
  viewportOnly?: boolean;
}

interface PageRefRegistry {
  byElement: WeakMap<Element, number>;
  byId: Map<number, WeakRef<Element>>;
  next: number;
  documentId?: string;
}

interface PageCommandInput {
  operation: string;
  steps?: LocatorStep[];
  args?: PageCommandArgs;
}

export async function pageCommand(input: PageCommandInput): Promise<unknown> {
  const operation = input.operation;
  const steps = input.steps || [];
  const args = input.args || {};
  const fail = (code: string, message: string, details?: unknown) => {
    const detailLine =
      details === undefined
        ? ''
        : '\n__QWEN_BROWSER_DETAILS__:' + JSON.stringify(details);
    const error = new Error(code + ': ' + message + detailLine);
    error.name = 'QwenBrowserPageError';
    return error;
  };
  const sleep = (ms: number) =>
    new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));
  const normalize = (value: unknown) =>
    String(value == null ? '' : value)
      .replace(/\s+/g, ' ')
      .trim();
  const matches = (value: unknown, expected: TextMatcher, exact?: boolean) => {
    const actual = normalize(value);
    if (
      expected &&
      typeof expected === 'object' &&
      typeof expected.regex === 'string'
    ) {
      return new RegExp(expected.regex, expected.flags || '').test(actual);
    }
    const wanted = normalize(expected);
    if (exact) return actual === wanted;
    return actual.toLowerCase().includes(wanted.toLowerCase());
  };
  const SKIP_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'HEAD',
    'META',
    'LINK',
    'TITLE',
    'HTML',
    'BODY',
  ]);
  const unique = <T>(items: T[]) => [...new Set(items)];

  // Rendered/actionable visibility intentionally does not require viewport
  // intersection: locator actions scroll off-screen elements into view.
  const rendered = (element: Element): boolean => {
    if (!(element instanceof Element)) return false;
    if (element.tagName === 'OPTION' || element.tagName === 'OPTGROUP') {
      const select = element.closest('select');
      return select ? rendered(select) : false;
    }
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const hiddenFromAccessibility = (element: Element) => {
    for (
      let current: Element | null = element;
      current instanceof Element;
      current = current.parentElement
    ) {
      if ((current.getAttribute('aria-hidden') || '').toLowerCase() === 'true')
        return true;
    }
    return false;
  };
  const snapshotEligible = (element: Element) =>
    rendered(element) && !hiddenFromAccessibility(element);
  const enabled = (element: Element) =>
    !element.matches(':disabled') &&
    element.getAttribute('aria-disabled') !== 'true';
  const editable = (element: Element) =>
    enabled(element) &&
    (!(element instanceof HTMLInputElement) &&
    !(element instanceof HTMLTextAreaElement)
      ? true
      : !element.readOnly) &&
    element.getAttribute('aria-readonly') !== 'true';

  const ownText = (element: Element) => {
    let text = '';
    for (const node of element.childNodes)
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
    return normalize(text);
  };
  const fullText = (element: Element) => {
    if (
      element instanceof HTMLInputElement &&
      ['button', 'submit', 'reset'].includes(element.type)
    )
      return normalize(element.value);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        return parent &&
          (parent.tagName === 'SCRIPT' ||
            parent.tagName === 'STYLE' ||
            parent.tagName === 'NOSCRIPT' ||
            parent.tagName === 'TEMPLATE')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    let text = '';
    while (walker.nextNode()) text += walker.currentNode.textContent;
    return normalize(text);
  };

  // Structural roles must not acquire a name from all of their descendants.
  // Doing so turns an unnamed form into e.g. form "Email Pay now", which is
  // both noisy and different from the accessibility tree used by Qwen. These
  // roles only accept an authored/native container label.
  const containerName = (element: Element): string => {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id: string) => document.getElementById(id)?.textContent || '')
        .join(' ');
      if (normalize(text)) return normalize(text);
    }
    const aria = element.getAttribute('aria-label');
    if (aria && normalize(aria)) return normalize(aria);
    const tag = element.tagName.toLowerCase();
    if (tag === 'fieldset') {
      const legend = [...element.children].find(
        (child) => child.tagName === 'LEGEND',
      );
      if (legend && normalize(fullText(legend)))
        return normalize(fullText(legend));
    }
    if (tag === 'table') {
      const caption = [...element.children].find(
        (child) => child.tagName === 'CAPTION',
      );
      if (caption && normalize(fullText(caption)))
        return normalize(fullText(caption));
    }
    return normalize(element.getAttribute('title') || '');
  };
  const CONTAINER_NAME_ROLES = new Set([
    'article',
    'banner',
    'complementary',
    'contentinfo',
    'dialog',
    'form',
    'generic',
    'group',
    'list',
    'listitem',
    'main',
    'navigation',
    'row',
    'table',
  ]);
  const FLATTEN_NAMELESS_ROLES = new Set([
    'form',
    'generic',
    'group',
    'listitem',
  ]);

  const role = (element: Element): string => {
    const explicit = element.getAttribute('role');
    if (explicit && normalize(explicit))
      return normalize(explicit).split(' ')[0] ?? '';
    const tag = element.tagName.toLowerCase();
    switch (tag) {
      case 'a':
      case 'area':
        return element.hasAttribute('href') ? 'link' : '';
      case 'button':
        return 'button';
      case 'select':
        return (element as HTMLSelectElement).multiple ||
          (element as HTMLSelectElement).size > 1
          ? 'listbox'
          : 'combobox';
      case 'textarea':
        return 'textbox';
      case 'img':
        return element.getAttribute('alt') === '' ? 'presentation' : 'img';
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return 'heading';
      case 'li':
        return 'listitem';
      case 'ul':
      case 'ol':
        return 'list';
      case 'nav':
        return 'navigation';
      case 'main':
        return 'main';
      case 'header':
        return element.closest('article,aside,main,nav,section')
          ? ''
          : 'banner';
      case 'footer':
        return element.closest('article,aside,main,nav,section')
          ? ''
          : 'contentinfo';
      // An HTML form is only exposed as the form landmark when it has an
      // accessible name. An explicit role="form" is handled above.
      case 'form':
        return containerName(element) ? 'form' : '';
      case 'fieldset':
        return 'group';
      case 'table':
        return 'table';
      case 'tr':
        return 'row';
      case 'td':
        return 'cell';
      case 'th':
        return 'columnheader';
      case 'option':
        return 'option';
      case 'dialog':
        return 'dialog';
      case 'article':
        return 'article';
      case 'aside':
        return 'complementary';
      case 'summary':
        return 'button';
      case 'details':
        return 'group';
      case 'progress':
        return 'progressbar';
      case 'input': {
        const type = (element.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (['button', 'submit', 'reset', 'image'].includes(type))
          return 'button';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'search') return 'searchbox';
        if (type === 'hidden') return '';
        if (element.hasAttribute('list')) return 'combobox';
        return 'textbox';
      }
      default:
        return '';
    }
  };
  const labelsFor = (element: Element): NodeListOf<HTMLLabelElement> | null =>
    (element as Element & { labels?: NodeListOf<HTMLLabelElement> | null })
      .labels ?? null;
  const name = (element: Element): string => {
    const elementRole = role(element);
    if (CONTAINER_NAME_ROLES.has(elementRole)) return containerName(element);
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id: string) => document.getElementById(id)?.textContent || '')
        .join(' ');
      if (normalize(text)) return normalize(text);
    }
    const aria = element.getAttribute('aria-label');
    if (aria && normalize(aria)) return normalize(aria);
    const labels = labelsFor(element);
    if (labels && labels.length)
      return normalize(
        [...labels].map((label) => label.textContent || '').join(' '),
      );
    const tag = element.tagName.toLowerCase();
    const type =
      tag === 'input'
        ? (element.getAttribute('type') || 'text').toLowerCase()
        : '';
    if (tag === 'input' && ['button', 'submit', 'reset'].includes(type)) {
      return normalize(
        (element as HTMLInputElement).value ||
          (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : ''),
      );
    }
    if (tag === 'img' || type === 'image')
      return normalize(
        element.getAttribute('alt') || element.getAttribute('title') || '',
      );
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      return normalize(
        element.getAttribute('placeholder') ||
          element.getAttribute('title') ||
          '',
      );
    }
    return normalize(fullText(element) || element.getAttribute('title') || '');
  };

  // Stable refs: the same element keeps the same [nN] for the lifetime of the
  // document, so a snapshot entry can be addressed by later commands.
  const registry = (() => {
    const key = '__qwenBrowserRefs';
    const pageWindow = window as Window & {
      __qwenBrowserRefs?: PageRefRegistry;
    };
    let store = pageWindow.__qwenBrowserRefs;
    if (!store || typeof store !== 'object') {
      store = {
        byElement: new WeakMap(),
        byId: new Map(),
        next: 1,
        documentId: undefined,
      };
      Object.defineProperty(pageWindow, key, {
        value: store,
        enumerable: false,
        configurable: true,
      });
    }
    if (typeof args.documentId === 'string') store.documentId = args.documentId;
    if (
      typeof args.expectedDocumentId === 'string' &&
      store.documentId !== args.expectedDocumentId
    ) {
      throw fail(
        'INVALID_LOCATOR',
        'the referenced browser document is stale; take a new domSnapshot',
        {
          kind: 'stale_document',
          action: operation,
        },
      );
    }
    return store;
  })();
  const refFor = (element: Element) => {
    let id = registry.byElement.get(element);
    if (id === undefined) {
      id = registry.next++;
      registry.byElement.set(element, id);
      registry.byId.set(id, new WeakRef(element));
    }
    return 'n' + id;
  };
  const elementForRef = (ref: string) => {
    const match = /^n(\d+)$/.exec(String(ref));
    const entry = match ? registry.byId.get(Number(match[1])) : undefined;
    const element = entry ? entry.deref() : undefined;
    if (!element || !element.isConnected) {
      throw fail(
        'INVALID_LOCATOR',
        'ref ' + ref + ' is stale or unknown; take a new domSnapshot',
        {
          kind: 'stale_ref',
          action: operation,
          locator: String(ref).slice(0, 200),
          matchCount: 0,
          visibleCount: 0,
        },
      );
    }
    return element;
  };

  const allElements = () =>
    [...document.querySelectorAll('body *')].filter(
      (el) => !SKIP_TAGS.has(el.tagName),
    );
  const descendants = (roots: Element[]) =>
    unique(roots.flatMap((root) => [...root.querySelectorAll('*')])).filter(
      (el) => !SKIP_TAGS.has(el.tagName),
    );
  const innermost = (matched: Element[]) => {
    const set = new Set(matched);
    const hasMatchedDescendant = new Set();
    for (const element of matched) {
      for (
        let parent = element.parentElement;
        parent;
        parent = parent.parentElement
      ) {
        if (set.has(parent)) hasMatchedDescendant.add(parent);
      }
    }
    return matched.filter((element) => !hasMatchedDescendant.has(element));
  };
  const labelable = (element: Element) =>
    element.matches(
      'input:not([type=hidden]),textarea,select,button,meter,output,progress,[aria-label],[aria-labelledby]',
    );
  const hasLabelSource = (element: Element) =>
    element.hasAttribute('aria-label') ||
    element.hasAttribute('aria-labelledby') ||
    Boolean(labelsFor(element)?.length);
  const query = (root: ParentNode, selector: string): Element[] => {
    try {
      return [...root.querySelectorAll(selector)];
    } catch {
      throw fail('INVALID_LOCATOR', 'invalid CSS selector', {
        kind: 'invalid_selector',
        action: operation,
        locator: String(selector).slice(0, 1000),
      });
    }
  };

  const resolve = (planSteps: LocatorStep[]): Element[] => {
    let current: Element[] = [];
    for (let index = 0; index < planSteps.length; index += 1) {
      const step = planSteps[index];
      const universe: Element[] =
        index === 0 ? allElements() : descendants(current);
      if (step.kind === 'ref') {
        if (index !== 0)
          throw fail('INVALID_LOCATOR', 'a ref must be the first locator step');
        current = [elementForRef(step.ref)];
      } else if (step.kind === 'frame') {
        throw fail(
          'INVALID_LOCATOR',
          'frameLocator steps cannot be used inside filter(), and() or or()',
        );
      } else if (step.kind === 'locator') {
        current =
          index === 0
            ? query(document, step.selector)
            : unique(current.flatMap((root) => query(root, step.selector)));
      } else if (step.kind === 'getByRole') {
        current = universe.filter(
          (el) =>
            role(el) === step.role &&
            (step.name === undefined ||
              matches(name(el), step.name, step.exact)),
        );
      } else if (step.kind === 'getByText') {
        current = innermost(
          universe.filter((el) => matches(fullText(el), step.text, step.exact)),
        );
      } else if (step.kind === 'getByLabel') {
        current = universe.filter(
          (el) =>
            labelable(el) &&
            hasLabelSource(el) &&
            matches(name(el), step.text, step.exact),
        );
      } else if (step.kind === 'getByPlaceholder') {
        current = universe.filter((el) =>
          matches(el.getAttribute('placeholder'), step.text, step.exact),
        );
      } else if (step.kind === 'getByTestId') {
        current = universe.filter(
          (el) => el.getAttribute('data-testid') === step.testId,
        );
      } else if (step.kind === 'filter') {
        current = current.filter((el) => {
          const text = fullText(el);
          if (step.hasText !== undefined && !matches(text, step.hasText, false))
            return false;
          if (
            step.hasNotText !== undefined &&
            matches(text, step.hasNotText, false)
          )
            return false;
          if (
            step.has !== undefined &&
            !resolve(step.has).some((candidate) => el.contains(candidate))
          )
            return false;
          if (
            step.hasNot !== undefined &&
            resolve(step.hasNot).some((candidate) => el.contains(candidate))
          )
            return false;
          if (step.visible !== undefined && rendered(el) !== step.visible)
            return false;
          return true;
        });
      } else if (step.kind === 'first') current = current.slice(0, 1);
      else if (step.kind === 'last') current = current.slice(-1);
      else if (step.kind === 'nth') {
        const position =
          step.index < 0 ? current.length + step.index : step.index;
        current = position < 0 ? [] : current.slice(position, position + 1);
      } else if (step.kind === 'and') {
        const other = new Set(resolve(step.steps));
        current = current.filter((el) => other.has(el));
      } else if (step.kind === 'or')
        current = unique([...current, ...resolve(step.steps)]);
      else throw fail('INVALID_LOCATOR', 'unsupported locator step');
    }
    return unique(current);
  };

  const timeoutMs = () =>
    Math.min(
      Math.max(
        Number(args.timeoutMs === undefined ? 30000 : args.timeoutMs) || 0,
        0,
      ),
      120000,
    );
  const locatorDescription = () => {
    try {
      return JSON.stringify(steps).slice(0, 1000);
    } catch {
      return '[unserializable locator]';
    }
  };
  const diagnostics = (kind: string, items: Element[]) => ({
    kind,
    action: operation,
    locator: locatorDescription(),
    matchCount: items.length,
    visibleCount: items.filter(rendered).length,
  });
  // Wait for exactly one match that satisfies the requested actionability
  // conditions. Ambiguity fails immediately (waiting cannot make a locator
  // unique); absence and visibility/enabled states are retried until timeout.
  const waitForOne = async (requirements: {
    visible?: boolean;
    enabled?: boolean;
    editable?: boolean;
  }) => {
    const timeout = timeoutMs();
    const started = Date.now();
    while (true) {
      const items = resolve(steps);
      let reason = '';
      let code = 'OPERATION_TIMEOUT';
      if (items.length > 1) {
        throw fail(
          'LOCATOR_NOT_UNIQUE',
          items.length +
            ' elements matched; the locator must resolve to exactly one element',
          diagnostics('multiple_matches', items),
        );
      }
      let detailKind = 'action_failed';
      if (items.length === 0) {
        reason = 'no element matched';
        code = 'INVALID_LOCATOR';
        detailKind = 'no_matches';
      } else {
        const element = items[0];
        if (requirements.visible && !rendered(element)) {
          reason = 'the element is not visible';
          detailKind = 'no_visible_match';
        } else if (requirements.enabled && !enabled(element))
          reason = 'the element is disabled';
        else if (requirements.editable && !editable(element))
          reason = 'the element is read-only or disabled';
        else return element;
      }
      if (Date.now() - started >= timeout) {
        throw fail(
          code,
          reason + ' after ' + timeout + 'ms',
          diagnostics(detailKind, items),
        );
      }
      await sleep(100);
    }
  };
  const exactlyOne = () => {
    const items = resolve(steps);
    if (items.length > 1) {
      throw fail(
        'LOCATOR_NOT_UNIQUE',
        items.length +
          ' elements matched; the locator must resolve to exactly one element',
        diagnostics('multiple_matches', items),
      );
    }
    return items[0];
  };
  const setValue = (element: Element, value: string) => {
    if (element instanceof HTMLInputElement)
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(element, value);
    else if (element instanceof HTMLTextAreaElement)
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set?.call(element, value);
    else if (element instanceof HTMLElement && element.isContentEditable)
      element.textContent = value;
    else
      throw fail(
        'INVALID_LOCATOR',
        'fill requires an input, textarea or contenteditable element',
      );
    element.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: value,
      }),
    );
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const rectOf = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };

  const INTERACTIVE =
    "a[href],button,input:not([type=hidden]),select,textarea,summary,[contenteditable]:not([contenteditable=false]),[onclick],[tabindex]:not([tabindex='-1']),[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=switch],[role=textbox],[role=combobox],[role=listbox],[role=slider],[role=spinbutton],[role=searchbox],[role=treeitem]";
  const SENSITIVE_AUTOCOMPLETE =
    /^(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp.*)$/i;
  const SENSITIVE_FIELD_HINT =
    /(?:password|passwd|passcode|secret|token|one[\s_-]*time|verification[\s_-]*code|auth(?:entication)?[\s_-]*code|security[\s_-]*code|otp|card[\s_-]*number|credit[\s_-]*card|cc[\s_-]*(?:number|csc|exp)|cvv|cvc)/i;
  const sensitiveField = (element: Element) => {
    if (element instanceof HTMLInputElement && element.type === 'password')
      return true;
    const autocomplete = element.getAttribute('autocomplete') || '';
    if (
      autocomplete
        .split(/\s+/)
        .some((token: string) => SENSITIVE_AUTOCOMPLETE.test(token))
    )
      return true;
    const labels = labelsFor(element)
      ? [...(labelsFor(element) ?? [])]
          .map((label) => label.textContent || '')
          .join(' ')
      : '';
    const hints = [
      element.getAttribute('name'),
      element.id,
      element.getAttribute('aria-label'),
      element.getAttribute('placeholder'),
      labels,
    ]
      .filter(Boolean)
      .join(' ');
    return SENSITIVE_FIELD_HINT.test(hints);
  };
  const snapshot = () => {
    const filter = args.filter === 'interactive' ? 'interactive' : 'all';
    const maxChars = Math.min(
      Math.max(Number(args.maxChars) || 20000, 1000),
      200000,
    );
    const refPrefix = typeof args.refPrefix === 'string' ? args.refPrefix : '';
    const indentBase = Math.min(Math.max(Number(args.indent) || 0, 0), 30);
    const withFooter = args.footer !== false;
    const viewportOnly = args.viewportOnly === true;
    const intersectsViewport = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < innerWidth &&
        rect.top < innerHeight
      );
    };
    const root = args.root ? elementForRef(args.root) : document.body;
    const candidates =
      root === document.body ? allElements() : [root, ...descendants([root])];
    const included = new Map();
    const lines = [];
    let chars = 0;
    let omitted = 0;
    let total = 0;
    for (const element of candidates) {
      if (!snapshotEligible(element)) continue;
      if (viewportOnly && !intersectsViewport(element)) continue;
      const elementRole = role(element);
      const interactive = element.matches(INTERACTIVE);
      const text = ownText(element);
      // Frames are always listed so the backend can splice their documents
      // beneath them; their own content is rendered by a separate command.
      const isFrame =
        element.tagName === 'IFRAME' || element.tagName === 'FRAME';
      if (
        !isFrame &&
        (filter === 'interactive'
          ? !interactive
          : !(elementRole || interactive || text))
      )
        continue;
      const displayName =
        elementRole || interactive || isFrame ? name(element) : text;
      const flattened =
        FLATTEN_NAMELESS_ROLES.has(elementRole) && displayName === '';
      // Preserve a container's own direct text as a text entry while keeping
      // child elements at the container's parent depth.
      if (flattened && text === '') continue;
      total += 1;
      let depth = 0;
      for (
        let parent = element.parentElement;
        parent;
        parent = parent.parentElement
      ) {
        if (included.has(parent)) {
          depth = included.get(parent) + 1;
          break;
        }
      }
      if (!flattened) included.set(element, depth);
      const label = flattened
        ? 'text'
        : elementRole || element.tagName.toLowerCase();
      const renderedName = flattened ? text : displayName;
      const ref = refPrefix + refFor(element);
      let line =
        '  '.repeat(Math.min(indentBase + depth, 30)) +
        '- ' +
        label +
        (renderedName ? ' ' + JSON.stringify(renderedName.slice(0, 200)) : '') +
        ' [' +
        ref +
        ']';
      const attrs = [];
      if (isFrame) {
        const src = element.getAttribute('src');
        if (src) attrs.push('src=' + JSON.stringify(src.slice(0, 200)));
      }
      const href =
        element.tagName === 'A' ? element.getAttribute('href') : null;
      if (href) attrs.push('href=' + JSON.stringify(href.slice(0, 200)));
      if (element.tagName === 'INPUT')
        attrs.push(
          'type=' + (element.getAttribute('type') || 'text').toLowerCase(),
        );
      if (elementRole === 'heading')
        attrs.push(
          'level=' +
            (element.getAttribute('aria-level') || element.tagName.slice(1)),
        );
      const placeholder = element.getAttribute('placeholder');
      if (placeholder)
        attrs.push('placeholder=' + JSON.stringify(placeholder.slice(0, 100)));
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      ) {
        if (
          ![
            'checkbox',
            'radio',
            'button',
            'submit',
            'reset',
            'file',
            'image',
          ].includes(element.type)
        ) {
          const sensitive = sensitiveField(element);
          const value =
            element instanceof HTMLSelectElement
              ? [...element.selectedOptions]
                  .map((option) => option.label)
                  .join(', ')
              : element.value;
          if (value)
            attrs.push(
              'value=' +
                (sensitive
                  ? '[redacted]'
                  : JSON.stringify(String(value).slice(0, 100))),
            );
        }
      }
      const state = [];
      if (
        (element instanceof HTMLInputElement && element.checked) ||
        element.getAttribute('aria-checked') === 'true'
      )
        state.push('checked');
      if (!enabled(element)) state.push('disabled');
      const expanded = element.getAttribute('aria-expanded');
      if (expanded) state.push('expanded=' + expanded);
      if (element instanceof HTMLOptionElement && element.selected)
        state.push('selected');
      if (attrs.length) line += ' ' + attrs.join(' ');
      if (state.length) line += ' [' + state.join(', ') + ']';
      if (isFrame) line += ' <<frame:' + ref + '>>';
      if (chars + line.length + 1 > maxChars) {
        omitted += 1;
        continue;
      }
      lines.push(line);
      chars += line.length + 1;
    }
    const footer = [];
    if (withFooter)
      footer.push(
        '',
        'Viewport: ' +
          innerWidth +
          'x' +
          innerHeight +
          ' css px, scrolled to ' +
          Math.round(scrollX) +
          ',' +
          Math.round(scrollY),
      );
    if (omitted > 0)
      footer.push(
        '  '.repeat(indentBase) +
          '[truncated: ' +
          omitted +
          ' of ' +
          total +
          ' elements omitted; pass a larger maxChars, filter: "interactive", or root: "<ref>"]',
      );
    return lines.join('\n') + (footer.length ? '\n' + footer.join('\n') : '');
  };

  switch (operation) {
    case 'domSnapshot':
      return snapshot();
    case 'readyState':
      return document.readyState;
    case 'viewport':
      return {
        devicePixelRatio: window.devicePixelRatio,
        width: innerWidth,
        height: innerHeight,
        scrollX: Math.round(scrollX),
        scrollY: Math.round(scrollY),
      };
    case 'count':
      return resolve(steps).length;
    case 'allTextContents':
      return resolve(steps)
        .slice(0, 1000)
        .map((el) => (el.textContent || '').slice(0, 20000));
    case 'innerText': {
      const element = await waitForOne({});
      return (
        (element instanceof HTMLElement
          ? element.innerText
          : element.textContent) || ''
      ).slice(0, 200000);
    }
    case 'textContent':
      return ((await waitForOne({})).textContent || '').slice(0, 200000);
    case 'getAttribute':
      return (await waitForOne({})).getAttribute(args.name ?? '');
    case 'isEnabled':
      return enabled(await waitForOne({}));
    case 'isChecked': {
      const element = await waitForOne({});
      if (
        element instanceof HTMLInputElement &&
        ['checkbox', 'radio'].includes(element.type)
      )
        return element.checked;
      const aria = element.getAttribute('aria-checked');
      if (aria === 'true' || aria === 'false') return aria === 'true';
      throw fail(
        'INVALID_LOCATOR',
        'isChecked requires a checkbox, radio or aria-checked element',
      );
    }
    case 'inputValue': {
      const element = await waitForOne({});
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      )
        return element.value;
      if (element instanceof HTMLElement && element.isContentEditable)
        return element.textContent || '';
      throw fail(
        'INVALID_LOCATOR',
        'inputValue requires an input, textarea, select or contenteditable element',
      );
    }
    case 'isVisible': {
      const element = exactlyOne();
      return element === undefined ? false : rendered(element);
    }
    case 'boundingBox': {
      const element = await waitForOne({});
      return rendered(element) ? rectOf(element) : null;
    }
    case 'focus': {
      const element = await waitForOne({ visible: true, enabled: true });
      element.scrollIntoView({ block: 'center', inline: 'center' });
      if (element instanceof HTMLElement || element instanceof SVGElement)
        element.focus();
      return {
        focused:
          document.activeElement === element ||
          element.contains(document.activeElement),
        ref: refFor(element),
        editable:
          (element instanceof HTMLInputElement &&
            ![
              'checkbox',
              'radio',
              'button',
              'submit',
              'reset',
              'file',
              'image',
              'range',
              'color',
            ].includes(element.type)) ||
          element instanceof HTMLTextAreaElement ||
          (element instanceof HTMLElement &&
            element.isContentEditable === true),
        documentHasFocus: document.hasFocus(),
        visibilityState: document.visibilityState,
      };
    }
    case 'scrollIntoView': {
      const element = await waitForOne({});
      element.scrollIntoView({ block: 'center', inline: 'center' });
      return rectOf(element);
    }
    case 'resolve': {
      // Returns the element itself; the backend evaluates this without
      // returnByValue to obtain a remote object handle.
      const requirements = args.requirements || {};
      return await waitForOne(requirements);
    }
    case 'resolveAll':
      // evaluateAll consumes these elements inside the same Runtime.evaluate
      // expression, so no DOM objects cross the CDP serialization boundary.
      return resolve(steps);
    case 'fill': {
      const element = await waitForOne({ visible: true, editable: true });
      if (element instanceof HTMLSelectElement)
        throw fail(
          'INVALID_LOCATOR',
          'fill cannot target a select element; use selectOption',
        );
      if (
        element instanceof HTMLInputElement &&
        ['checkbox', 'radio'].includes(element.type)
      )
        throw fail(
          'INVALID_LOCATOR',
          'fill cannot target a checkbox or radio; use check/uncheck',
        );
      element.scrollIntoView({ block: 'center', inline: 'center' });
      if (element instanceof HTMLElement || element instanceof SVGElement)
        element.focus();
      setValue(element, args.value as string);
      return null;
    }
    case 'selectOption': {
      const element = await waitForOne({ visible: true, enabled: true });
      if (!(element instanceof HTMLSelectElement))
        throw fail('INVALID_LOCATOR', 'selectOption requires a select element');
      const requested = Array.isArray(args.value) ? args.value : [args.value];
      if (requested.length === 0)
        throw fail(
          'INVALID_ARGUMENT',
          'selectOption requires at least one value, label or index',
        );
      const optionMatches = (
        option: HTMLOptionElement,
        item: SelectOptionRequest,
      ) =>
        (item.value === undefined || item.value === option.value) &&
        (item.label === undefined || item.label === option.label) &&
        (item.index === undefined || item.index === option.index);
      const options = [...element.options];
      const matchesByRequest = requested.map((item) => {
        if (typeof item !== 'string' && item !== undefined)
          return options.filter((option) => optionMatches(option, item));
        const byValue = options.filter((option) => option.value === item);
        return byValue.length > 0
          ? byValue
          : options.filter((option) => option.label === item);
      });
      if (
        matchesByRequest.some((matchesForItem) => matchesForItem.length === 0)
      ) {
        throw fail(
          'INVALID_LOCATOR',
          'no option matched one of the requested values, labels or indexes',
        );
      }
      const firstMatch = matchesByRequest[0]?.[0];
      if (firstMatch === undefined)
        throw fail(
          'INVALID_LOCATOR',
          'no option matched the requested selection',
        );
      const wanted = element.multiple
        ? new Set(matchesByRequest.flat())
        : new Set([firstMatch]);
      for (const option of options) option.selected = wanted.has(option);
      const selected = [...element.selectedOptions].map(
        (option) => option.value,
      );
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return selected;
    }
    case 'waitFor': {
      const timeout = timeoutMs();
      const started = Date.now();
      while (true) {
        const items = resolve(steps);
        const exists = items.length > 0;
        const anyVisible = items.some(rendered);
        const done =
          args.state === 'attached'
            ? exists
            : args.state === 'detached'
              ? !exists
              : args.state === 'visible'
                ? anyVisible
                : !anyVisible;
        if (done) return null;
        if (Date.now() - started >= timeout)
          throw fail(
            'OPERATION_TIMEOUT',
            'waiting for locator to be ' +
              args.state +
              ' timed out after ' +
              timeout +
              'ms',
          );
        await sleep(100);
      }
    }
    default:
      throw fail('OPERATION_FAILED', 'unsupported page operation ' + operation);
  }
}

export const PAGE_COMMAND_SOURCE = pageCommand.toString();
