import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss, { type ChildNode, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

// jsdom does not compute the cascade, so pin the stylesheet's source shape:
// the attribute UserMessage.tsx emits for a line-leading slash token must keep
// a rule declaring the highlight, and the composer's `.cm-input-slash` theme
// must agree — the integrator docs promise both surfaces render the same blue
// bold. Keep the `var(--agent-blue-500, #4a9eff)` fallback literal on both
// sides: it is what keeps the two equal where the app-root variable is
// undefined, such as the `/export html` document.
const css = readFileSync(
  fileURLToPath(new URL('./UserMessage.module.css', import.meta.url)),
  'utf8',
);
const root = postcss.parse(css);
const userMessageSource = readFileSync(
  fileURLToPath(new URL('./UserMessage.tsx', import.meta.url)),
  'utf8',
);
const composerThemeSource = readFileSync(
  fileURLToPath(new URL('../../extensions/inputHighlight.ts', import.meta.url)),
  'utf8',
);

const tidy = (text: string) => text.replace(/\s+/g, ' ').trim();

function declarations(rule: Rule): string[] {
  return (rule.nodes ?? [])
    .filter((node: ChildNode) => node.type !== 'comment')
    .map((node: ChildNode) =>
      node.type === 'decl'
        ? `${node.prop}: ${node.value}${node.important ? ' !important' : ''}`
        : // Nested rules would hide declarations from a flat reading.
          `<nested ${node.type}>`,
    );
}

function find(selector: string): Rule[] {
  const found: Rule[] = [];
  root.walkRules((rule) => {
    if (rule.selectors.map(tidy).includes(selector)) found.push(rule);
  });
  return found;
}

// Tied to the emit site so renaming the attribute on either side turns this
// guard red instead of silently orphaning the rule.
const slashAttribute = userMessageSource.match(
  /data-web-shell-user-slash-command/,
)?.[0];

function slashRuleDeclarations(): string[] {
  expect(slashAttribute).toBeTruthy();
  const rules = find(`[${slashAttribute}]`);
  expect(rules).toHaveLength(1);
  return declarations(rules[0]!);
}

describe('UserMessage slash command stylesheet', () => {
  it('styles the attribute UserMessage emits for a line-leading slash token', () => {
    expect(slashRuleDeclarations()).toEqual([
      'color: var(--agent-blue-500, #4a9eff)',
      'font-weight: bold',
    ]);
  });

  it('matches the composer slash highlight', () => {
    const declared = new Map(
      slashRuleDeclarations().map((entry) => {
        const splitAt = entry.indexOf(':');
        return [entry.slice(0, splitAt), entry.slice(splitAt + 1).trim()];
      }),
    );
    // The closing quote right after `slash` is what keeps the sibling
    // `.cm-input-slash-argument-hint` key out of the match.
    const composerSlash = composerThemeSource.match(
      /'\.cm-input-slash':\s*\{[^}]*\}/,
    )?.[0];
    expect(composerSlash).toBeTruthy();
    // Compare declaration sets, not substrings, so an extra composer-side
    // declaration (breaking parity the other way) also turns this red.
    const composerDeclarations = new Map(
      Array.from(composerSlash!.matchAll(/(\w+):\s*'([^']*)'/g), (m) => [
        m[1]!.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
        m[2]!,
      ]),
    );
    expect(composerDeclarations).toEqual(declared);
  });
});
