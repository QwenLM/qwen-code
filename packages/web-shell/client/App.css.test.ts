import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss, { type ChildNode, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const appCss = postcss.parse(
  readFileSync(new URL('./App.module.css', import.meta.url), 'utf8'),
  { from: fileURLToPath(new URL('./App.module.css', import.meta.url)) },
);

const chatPaneCss = postcss.parse(
  readFileSync(
    new URL('./components/ChatPane.module.css', import.meta.url),
    'utf8',
  ),
  {
    from: fileURLToPath(
      new URL('./components/ChatPane.module.css', import.meta.url),
    ),
  },
);

const chatEditorCss = postcss.parse(
  readFileSync(
    new URL('./components/ChatEditor.module.css', import.meta.url),
    'utf8',
  ),
);

const tidy = (text: string) => text.replace(/\s+/g, ' ').trim();

function declarations(rule: Rule): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of (rule.nodes ?? []) as ChildNode[]) {
    if (node.type === 'decl') {
      map.set(node.prop, `${node.value}${node.important ? ' !important' : ''}`);
    }
  }
  return map;
}

function findRules(
  root: postcss.Root,
  selector: string,
): Array<Map<string, string>> {
  const matches: Array<Map<string, string>> = [];
  root.walkRules((rule) => {
    if (rule.selectors.map(tidy).includes(selector)) {
      matches.push(declarations(rule));
    }
  });
  return matches;
}

describe('Chat layout relayout boundary CSS contracts', () => {
  it.each([
    '.appShell',
    '.contextShell',
    '.contextBody',
    '.chatPane',
    '.chatViewWrap',
    '.content',
    '.contentHasMessages',
    '.managedHome',
  ])('pins flex: 1 1 0%% on %s', (selector) => {
    const rules = findRules(appCss, selector);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.some((decls) => decls.get('flex') === '1 1 0%')).toBe(true);
    expect(rules.some((decls) => decls.get('flex') === '1 1 auto')).toBe(false);
  });

  it('pins flex: 1 1 0% on ChatPane .body', () => {
    const bodyRules = findRules(chatPaneCss, '.body');
    expect(bodyRules.length).toBeGreaterThan(0);
    expect(bodyRules.some((decls) => decls.get('flex') === '1 1 0%')).toBe(
      true,
    );
    expect(bodyRules.some((decls) => decls.get('flex') === '1 1 auto')).toBe(
      false,
    );
  });

  it('keeps .chatPane relative with inline-size containment and .content with inline-size containment', () => {
    const chatPaneRules = findRules(appCss, '.chatPane');
    expect(chatPaneRules).toHaveLength(1);
    expect(chatPaneRules[0]?.get('position')).toBe('relative');
    expect(chatPaneRules[0]?.get('container-type')).toBe('inline-size');

    // WebShellTranscript mounts .content directly inside .app without .chatPane.
    const contentRules = findRules(appCss, '.content');
    expect(contentRules).toHaveLength(1);
    expect(contentRules[0]?.get('container-type')).toBe('inline-size');
  });

  it('makes non-empty .chatViewWrap an isolated Blink relayout boundary', () => {
    const wrapRules = findRules(appCss, '.chatViewWrap');
    expect(wrapRules).toHaveLength(1);
    expect(wrapRules[0]?.get('position')).toBe('absolute');
    expect(wrapRules[0]?.get('inset')).toBe('0');
    expect(wrapRules[0]?.get('contain')).toBe('layout size style');
    expect(wrapRules[0]?.get('container-type')).toBe('inline-size');
  });

  it('resets .chatViewWrap containment/positioning in empty state and scopes approval positioning there', () => {
    const emptyWrapRules = findRules(appCss, '.appChatEmpty .chatViewWrap');
    expect(emptyWrapRules).toHaveLength(1);
    expect(emptyWrapRules[0]?.get('position')).toBe('static');
    expect(emptyWrapRules[0]?.get('inset')).toBe('auto');
    expect(emptyWrapRules[0]?.get('contain')).toBe('none');
    expect(emptyWrapRules[0]?.get('flex')).toBe('0 0 auto');
    expect(emptyWrapRules[0]?.get('overflow')).toBe('visible');

    // A standalone `.chatViewWithApproval { position: relative }` would
    // downgrade non-empty `.chatViewWrap` from `position: absolute` and break
    // size containment whenever an approval overlay opens.
    expect(findRules(appCss, '.chatViewWithApproval')).toEqual([]);
    const emptyApprovalRules = findRules(
      appCss,
      '.appChatEmpty .chatViewWithApproval',
    );
    expect(emptyApprovalRules).toHaveLength(1);
    expect(emptyApprovalRules[0]?.get('position')).toBe('relative');
  });
});

describe('touch follow-up chip background tokens', () => {
  it('uses background tokens declared in both theme blocks', () => {
    for (const selector of [
      '.mobileFollowupAccept',
      '.mobileFollowupAccept:not(:disabled):hover',
    ]) {
      const rules = findRules(chatEditorCss, selector);
      expect(rules.length, `${selector} exists`).toBeGreaterThan(0);
      const backgroundTokens = rules
        .flatMap((decls) => decls.get('background') ?? '')
        .join(' ')
        .match(/--chat-editor-[\w-]+/g);
      expect(
        backgroundTokens,
        `${selector} uses background tokens`,
      ).not.toBeNull();
      for (const theme of ['.themeDark', '.themeLight']) {
        const declared = new Set<string>();
        findRules(appCss, theme).forEach((decls) => {
          for (const prop of decls.keys()) declared.add(prop);
        });
        for (const token of backgroundTokens!) {
          expect(declared.has(token), `${theme} declares ${token}`).toBe(true);
        }
      }
    }
  });
});
