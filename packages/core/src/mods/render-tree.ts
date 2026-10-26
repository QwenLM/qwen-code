/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The trees a `ui.render` hook draws, judged by Claude Code 2.1.310's rules.
// The worker checks each hook's answer and the host the tree the chain settles
// on, so a tree Qwen Code accepts is one Claude Code accepts.

export const MOD_RENDER_SITES = ['AbovePrompt'] as const;
export type ModRenderSite = (typeof MOD_RENDER_SITES)[number];

/** The terminal's element table, as Claude Code declares it. */
export const TERMINAL_ELEMENTS = [
  'Box',
  'Text',
  'Button',
  'Input',
  'Select',
  'Link',
  'Code',
  'Markdown',
  'Client',
  'Raster',
  'Image',
] as const;
const DRAWN = new Set(['Box', 'Text']);

/** The events `$.ui.invalidate` names. */
export const INVALIDATABLE_EVENTS = [
  'ui.render',
  'prompt.section',
  'prompt.context',
  'prompt.attachment',
  'tool.describe',
  'command.describe',
  'config.describe',
] as const;

export type ModRenderProps = Record<string, string | number | boolean>;
export type ModRenderNode = ModRenderElement | string;
export type ModRenderElement =
  | {
      type: 'Box' | 'Text';
      props?: ModRenderProps;
      hover?: ModRenderProps;
      children?: ModRenderNode[];
    }
  | { type: 'engine'; ref: number };

/** What `next(e)` resolves to: the engine's own drawing, nothing at the band. */
export const ENGINE_NODE: ModRenderElement = Object.freeze({
  type: 'engine',
  ref: 0,
});

export interface ModAbovePromptProps {
  hasSurvey: boolean;
  isWorking: boolean;
  maxRows: number;
  bodyColumns: number;
  scroll: { offset: number; bodyRows: number };
  view: { agentId?: string };
}

export interface ModRenderInput {
  surface: 'terminal';
  component: ModRenderSite;
  requestId: string;
  viewport?: { columns: number; rows: number; isFullscreen?: boolean };
  props: ModAbovePromptProps;
}

export const BORDER_STYLES = [
  'single',
  'double',
  'round',
  'bold',
  'singleDouble',
  'doubleSingle',
  'classic',
  'arrow',
  'dashed',
  'quote',
];
const MAX_DEPTH = 32;
const MAX_NODES = 20_000;
export const MOD_RENDER_TEXT_CAP = 100_000;

type Rule = (value: unknown) => string | undefined;
const oneOf =
  (...values: string[]): Rule =>
  (value) =>
    values.includes(value as string)
      ? undefined
      : `must be one of ${values.join(', ')}`;
const finite = (value: unknown, limit: number) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  Math.abs(value) <= limit;
const size: Rule = (value) =>
  (finite(value, 10_000) && (value as number) >= 0) ||
  (typeof value === 'string' && /^\d{1,3}%$/.test(value))
    ? undefined
    : 'must be 0 to 10000 cells or a percentage';
const factor: Rule = (value) =>
  finite(value, 10_000) ? undefined : 'must be a number up to 10000';
const space: Rule = (value) =>
  finite(value, 10_000) ||
  ['xs', 'sm', 'md', 'lg', 'xl'].includes(value as string)
    ? undefined
    : 'must be a number of cells or xs, sm, md, lg or xl';
const offset: Rule = (value) =>
  Number.isInteger(value) && Math.abs(value as number) <= 10_000
    ? undefined
    : 'must be a whole number of cells up to 10000';
const color: Rule = (value) =>
  typeof value === 'string' && /^[#a-zA-Z0-9_().,% -]{1,40}$/.test(value)
    ? undefined
    : 'must be a theme key or a color';
const flag: Rule = (value) =>
  typeof value === 'boolean' ? undefined : 'must be true or false';
const label: Rule = (value) =>
  typeof value === 'string' ? undefined : 'must be a string';
// Kept for the adjustments below, which never refuse a tree over them.
const loose: Rule = () => undefined;

const SPACING = [
  'gap',
  'columnGap',
  'rowGap',
  'margin',
  'marginX',
  'marginY',
  'marginTop',
  'marginBottom',
  'marginLeft',
  'marginRight',
  'padding',
  'paddingX',
  'paddingY',
  'paddingTop',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
];
const OFFSETS = ['top', 'left', 'right', 'bottom'];
const BOX_PROPS: Record<string, Rule> = {
  key: loose,
  flexDirection: oneOf('row', 'column', 'row-reverse', 'column-reverse'),
  flexGrow: factor,
  flexShrink: factor,
  flexWrap: oneOf('nowrap', 'wrap', 'wrap-reverse'),
  alignItems: oneOf('flex-start', 'center', 'flex-end', 'stretch'),
  alignSelf: oneOf('flex-start', 'center', 'flex-end', 'auto'),
  justifyContent: oneOf(
    'flex-start',
    'center',
    'flex-end',
    'space-between',
    'space-around',
    'space-evenly',
  ),
  width: size,
  height: size,
  minWidth: size,
  minHeight: size,
  ...Object.fromEntries(SPACING.map((name) => [name, space])),
  borderStyle: loose,
  borderColor: color,
  borderDimColor: flag,
  backgroundColor: color,
  overflow: oneOf('visible', 'hidden'),
  display: oneOf('flex', 'none'),
  position: oneOf('relative', 'absolute'),
  ...Object.fromEntries(OFFSETS.map((name) => [name, offset])),
};
const TEXT_PROPS: Record<string, Rule> = {
  color,
  backgroundColor: color,
  dimColor: flag,
  size: oneOf('caption', 'footnote', 'body', 'heading', 'title'),
  weight: oneOf('regular', 'medium', 'semibold', 'bold'),
  mono: flag,
  tabular: flag,
  bold: flag,
  italic: flag,
  underline: flag,
  strikethrough: flag,
  inverse: flag,
  dir: oneOf('ltr', 'rtl'),
  wrap: oneOf(
    'wrap',
    'end',
    'middle',
    'truncate',
    'truncate-start',
    'truncate-middle',
    'truncate-end',
  ),
};
const HOVER_PROPS: Record<'Box' | 'Text', Record<string, Rule>> = {
  Box: {
    scope: label,
    borderStyle: loose,
    borderColor: color,
    borderDimColor: flag,
    backgroundColor: color,
    display: oneOf('flex'),
    ...Object.fromEntries(OFFSETS.map((name) => [name, offset])),
  },
  Text: {
    scope: label,
    color,
    backgroundColor: color,
    dimColor: flag,
    bold: flag,
    italic: flag,
    underline: flag,
    strikethrough: flag,
    inverse: flag,
  },
};
// A Box that sets one of these may not hold the engine's own node.
const ENGINE_BLOCKERS = [
  'display',
  'overflow',
  'position',
  'width',
  'height',
  'minWidth',
  'minHeight',
  ...OFFSETS,
];
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const kind = (value: unknown) =>
  value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value;

function checkProps(
  type: 'Box' | 'Text',
  props: unknown,
  rules: Record<string, Rule>,
  label: string,
): void {
  if (!record(props)) throw new Error(`${type} ${label} is ${kind(props)}`);
  for (const [name, value] of Object.entries(props)) {
    const rule = rules[name];
    if (!rule) throw new Error(`${type} prop "${name}" is not allowed`);
    if (!['string', 'number', 'boolean'].includes(typeof value))
      throw new Error(`${type} prop "${name}" is ${kind(value)}`);
    const problem = rule(value);
    if (problem) throw new Error(`${type} prop "${name}" ${problem}`);
  }
}

/** Throws the reason Claude Code gives when it refuses the tree. */
export function validateRenderTree(tree: unknown): void {
  if (!record(tree)) throw new Error('the root must be an element');
  let nodes = 0;
  const visit = (
    node: unknown,
    depth: number,
    inline: boolean,
    blocker: string | undefined,
  ): void => {
    if (++nodes > MAX_NODES) throw new Error(`more than ${MAX_NODES} nodes`);
    if (depth > MAX_DEPTH) throw new Error(`deeper than ${MAX_DEPTH}`);
    if (typeof node === 'string') {
      if (CONTROL.test(node) || LONE_SURROGATE.test(node))
        throw new Error(
          'a text child holds a control character (an escape sequence)',
        );
      return;
    }
    if (!record(node)) throw new Error(`a child is ${kind(node)}`);
    const type = node['type'];
    if (type === 'engine') {
      if (
        Object.keys(node).some((key) => key !== 'type' && key !== 'ref') ||
        !Number.isSafeInteger(node['ref']) ||
        (node['ref'] as number) < 0
      )
        throw new Error('an engine node holds more than its ref');
      if (inline) throw new Error('engine node inside an inline element');
      if (blocker)
        throw new Error(`engine node under a Box with prop "${blocker}"`);
      return;
    }
    if (typeof type !== 'string') throw new Error('an element has no type');
    if (!DRAWN.has(type)) {
      if ((TERMINAL_ELEMENTS as readonly string[]).includes(type))
        throw new Error(`${type} is not drawn by Qwen Code yet`);
      throw new Error(`${type} is not an element of the terminal`);
    }
    const tag = type as 'Box' | 'Text';
    if (
      Object.keys(node).some(
        (key) => !['type', 'props', 'hover', 'children'].includes(key),
      )
    )
      throw new Error(`${tag} holds fields other than props and children`);
    if (tag === 'Box' && inline)
      throw new Error('Box inside an inline element');
    const props = node['props'];
    if (props !== undefined)
      checkProps(tag, props, tag === 'Box' ? BOX_PROPS : TEXT_PROPS, 'props');
    if (node['hover'] !== undefined)
      checkProps(tag, node['hover'], HOVER_PROPS[tag], 'hover');
    const children = node['children'];
    if (children === undefined) return;
    if (!Array.isArray(children))
      throw new Error(`${tag} children is ${kind(children)}`);
    const blocks =
      tag === 'Box' && record(props)
        ? ENGINE_BLOCKERS.find((name) => props[name] !== undefined)
        : undefined;
    for (const child of children)
      visit(child, depth + 1, tag === 'Text', blocks ?? blocker);
  };
  visit(tree, 1, false, undefined);
}

/** An adjustment note; `key` names its kind, said once per load and site. */
export interface ModRenderNote {
  key: 'borderStyle' | 'text cut';
  text: string;
}

/**
 * The changes Claude Code makes to a tree it accepts: a Box key it cannot
 * address by, a border the terminal lacks, and text past the cap. Each note
 * names what changed, in Claude Code's words after `<owner>: `; the first of
 * each kind in the tree stands for it.
 */
export function adjustRenderTree(
  tree: ModRenderElement,
  site: ModRenderSite,
): { tree: ModRenderElement; notes: ModRenderNote[] } {
  const notes = new Map<ModRenderNote['key'], string>();
  let budget = MOD_RENDER_TEXT_CAP;
  let total = 0;
  let drawn = 0;
  let cut = false;
  const text = (value: string): string => {
    total += value.length;
    if (cut) return '';
    if (value.length <= budget) {
      budget -= value.length;
      drawn += value.length;
      return value;
    }
    cut = true;
    // A cut between the halves of a surrogate pair keeps neither.
    const last = value.charCodeAt(budget - 1);
    const kept = value.slice(
      0,
      last >= 0xd800 && last <= 0xdbff ? budget - 1 : budget,
    );
    drawn += kept.length;
    return `${kept}\n… ${value.length - kept.length} more characters, not drawn`;
  };
  const border = (props: ModRenderProps): ModRenderProps => {
    const style = props['borderStyle'];
    if (style === undefined || BORDER_STYLES.includes(style as string))
      return props;
    const { borderStyle: _style, ...rest } = props;
    if (!notes.has('borderStyle'))
      notes.set(
        'borderStyle',
        typeof style === 'string'
          ? `ui.render (${site}): Box borderStyle "${style}" is not a border style (the styles are ${BORDER_STYLES.join(', ')}); the Box is drawn with no border`
          : `ui.render (${site}): Box borderStyle is ${kind(style)}, not a style name (the styles are ${BORDER_STYLES.join(', ')}); the Box is drawn with no border`,
      );
    return rest;
  };
  const walk = (node: ModRenderNode): ModRenderNode => {
    if (typeof node === 'string') return text(node);
    if (node.type === 'engine') return node;
    let props = node.props;
    let hover = node.hover;
    if (node.type === 'Box' && props) {
      const key = props['key'];
      if (
        key !== undefined &&
        (typeof key !== 'string' ||
          key.length < 1 ||
          key.length > 10_000 ||
          CONTROL.test(key))
      ) {
        const { key: _key, ...rest } = props;
        props = rest;
      }
      props = border(props);
    }
    if (node.type === 'Box' && hover) hover = border(hover);
    return {
      type: node.type,
      ...(props && Object.keys(props).length ? { props } : {}),
      ...(hover && Object.keys(hover).length ? { hover } : {}),
      ...(node.children ? { children: node.children.map(walk) } : {}),
    };
  };
  const adjusted = walk(tree) as ModRenderElement;
  if (cut)
    notes.set(
      'text cut',
      `ui.render (${site}): ${total} characters of text are drawn up to the first ${drawn}`,
    );
  return {
    tree: adjusted,
    notes: [...notes].map(([key, text]) => ({ key, text })),
  };
}
