/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ModRuntime, type ModRenderHost } from './runtime.js';
import type { ModRenderInput } from './render-tree.js';
import type { ModLog } from './types.js';

const signal = () => new AbortController().signal;
const band = (
  props: Partial<ModRenderInput['props']> = {},
): ModRenderInput => ({
  surface: 'terminal',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns: 100, rows: 30, isFullscreen: true },
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 95,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
    ...props,
  },
});

describe('ui.render through the real QuickJS worker', () => {
  const runtimes: ModRuntime[] = [];
  const logs: Array<ModLog & { plugin: string }> = [];
  const invalidated: string[] = [];
  const host: ModRenderHost = {
    sites: ['AbovePrompt'],
    invalidate: (plugin) => invalidated.push(plugin),
  };
  const create = async (
    sources: string[],
    render: ModRenderHost | null = host,
    entry = '/fixture/mod.js',
  ) => {
    const runtime = await ModRuntime.createGroup(
      sources.map((source, index) => ({
        id: `mod-${index}`,
        name: `mod-${index}`,
        source: { root: '/fixture', entry, source },
        options: {},
      })),
      '/workspace',
      (log, plugin) => logs.push({ ...log, plugin }),
      signal(),
      undefined,
      'terminal',
      '1.0.0',
      undefined,
      undefined,
      render ?? undefined,
    );
    runtimes.push(runtime);
    return runtime;
  };
  const mod = (body: string) => `export function register(on) { ${body} }`;

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
    logs.length = 0;
    invalidated.length = 0;
  });

  it('draws the Token Weather band from the table $.ui.resolve hands out', async () => {
    const runtime = await create([
      mod(`on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
        const { Box, Text } = $.ui.resolve(e);
        return Box({ flexDirection: 'row', paddingX: 1, children: [
          Text({ color: 'yellow', bold: true, children: '☀  Clear' }),
          Text({ children: ['  ', e.props.bodyColumns, ' columns'] }),
          Text({ dimColor: true, children: [null, false, '  done'] }),
        ] });
      });`),
    ]);
    expect(runtime.renderHooks).toEqual(['mod-0']);
    await expect(runtime.render(band(), signal())).resolves.toEqual({
      tree: {
        type: 'Box',
        props: { flexDirection: 'row', paddingX: 1 },
        children: [
          {
            type: 'Text',
            props: { color: 'yellow', bold: true },
            children: ['☀  Clear'],
          },
          { type: 'Text', children: ['  ', '95', ' columns'] },
          { type: 'Text', props: { dimColor: true }, children: ['  done'] },
        ],
      },
      notes: [],
    });
  });

  it('draws the same band from a .tsx entry written in JSX', async () => {
    const runtime = await create(
      [
        `type Props = { columns: number };
        export function register(on: any) {
          on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
            const { Box, Text } = $.ui.resolve(e);
            const Columns = ({ columns }: Props) => <Text>  {columns} columns</Text>;
            return (
              <Box flexDirection="row" paddingX={1}>
                <Text color="yellow" bold>☀  Clear</Text>
                <Columns columns={e.props.bodyColumns} />
                <Text dimColor>{null}{false}  done</Text>
              </Box>
            );
          });
        }`,
      ],
      host,
      '/fixture/mod.tsx',
    );
    await expect(runtime.render(band(), signal())).resolves.toEqual({
      tree: {
        type: 'Box',
        props: { flexDirection: 'row', paddingX: 1 },
        children: [
          {
            type: 'Text',
            props: { color: 'yellow', bold: true },
            children: ['☀  Clear'],
          },
          { type: 'Text', children: ['  ', '95', ' columns'] },
          { type: 'Text', props: { dimColor: true }, children: ['  done'] },
        ],
      },
      notes: [],
    });
  });

  it('hands out a frozen table of the eleven terminal elements, two of them drawn', async () => {
    const runtime = await create([
      mod(`on('ui.render', ($, e) => {
        const { Box, Button } = $.ui.resolve(e);
        return Box({ children: Button({ label: 'Go' }) });
      }).catch(($, e, next) => {
        const { Text } = $.ui.resolve(e);
        return Text({ children: 'caught: ' + next.error.message });
      });`),
    ]);
    // A Button fails the tree, so the hook's catch answers in its place.
    await expect(runtime.render(band(), signal())).resolves.toEqual({
      tree: {
        type: 'Text',
        children: [
          'caught: returned the wrong shape (a tree AbovePrompt refuses: Button is not drawn by Qwen Code yet)',
        ],
      },
      notes: [],
    });
    const probe = await create([
      mod(`on('ui.render', ($, e) => {
        const table = $.ui.resolve(e);
        let refused = '';
        try { $.ui.resolve({ surface: 'desktop' }); } catch (error) { refused = String(error); }
        const { Box, Text } = table;
        const built = Box({ key: 7, children: Text({ key: 'dropped', children: 'x' }) });
        return Text({ children: JSON.stringify({
          names: Object.keys(table), frozen: Object.isFrozen(table) && Object.isFrozen(built.children[0]),
          bare: Object.getPrototypeOf(table) === null, refused, built,
        }) });
      });`),
    ]);
    const { tree } = await probe.render(band(), signal());
    expect(JSON.parse((tree as { children: string[] }).children[0])).toEqual({
      names: [
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
      ],
      frozen: true,
      bare: true,
      refused:
        'TypeError: $.ui.resolve takes a ui.render event drawn on a surface this host draws',
      built: {
        type: 'Box',
        props: { key: '7' },
        children: [{ type: 'Text', children: ['x'] }],
      },
    });
  });

  it('gives each environment h and Fragment as JSX compiles them', async () => {
    const runtime = await create([
      mod(`on('ui.render', ($, e) => {
        const { Box, Text } = $.ui.resolve(e);
        const Row = ({ label, children }) => h(Box, { flexDirection: 'row' }, h(Text, { bold: true }, label), children);
        let unknown = '';
        try { h('Spinner', null); } catch (error) { unknown = String(error); }
        const seen = [];
        const Probe = ({ children }) => { seen.push(children); return null; };
        h(Probe, null);
        h(Probe, null, 'one');
        h(Probe, null, ['a', [null, 2]], false);
        return h(Fragment, null, h(Row, { label: 'a' }, 'b', [1, [2]]), h(Text, null, unknown), h(Text, null, JSON.stringify(seen)));
      });`),
    ]);
    const { tree } = await runtime.render(band(), signal());
    expect(tree).toEqual({
      type: 'Box',
      props: { flexDirection: 'column' },
      children: [
        {
          type: 'Box',
          props: { flexDirection: 'row' },
          children: [
            { type: 'Text', props: { bold: true }, children: ['a'] },
            'b',
            '1',
            '2',
          ],
        },
        {
          type: 'Text',
          children: [
            'TypeError: JSX element <Spinner> is not an element: a render hook draws with the table $.ui.resolve(e) returns, not by tag name',
          ],
        },
        // A component gets its children flattened, always an array.
        { type: 'Text', children: ['[[],["one"],["a","2"]]'] },
      ],
    });
  });

  it('draws nothing at the band for the engine node next(e) resolves to', async () => {
    const runtime = await create([
      mod(`on('ui.render', async ($, e, next) => {
        const { Box } = $.ui.resolve(e);
        return Box({ flexDirection: 'column', children: [await next(e)] });
      });`),
      mod(`on('ui.render', ($, e, next) => next(e));`),
    ]);
    expect(runtime.renderHooks).toEqual(['mod-0', 'mod-1']);
    await expect(runtime.render(band(), signal())).resolves.toEqual({
      tree: {
        type: 'Box',
        props: { flexDirection: 'column' },
        children: [{ type: 'engine', ref: 0 }],
      },
      notes: [],
    });
  });

  it('pins the envelope and the view and keeps the kind of every other prop', async () => {
    const runtime = await create([
      mod(`on('ui.render', async ($, e, next) => {
        const tries = {
          viewport: { ...e, viewport: { ...e.viewport, columns: 1 } },
          view: { ...e, props: { ...e.props, view: { agentId: 'a' } } },
          kind: { ...e, props: { ...e.props, maxRows: 'ten' } },
          added: { ...e, props: { ...e.props, extra: true } },
          rows: { ...e, props: { ...e.props, maxRows: 3 } },
        };
        const out = {};
        for (const [name, input] of Object.entries(tries)) {
          out[name] = await next(input).then(() => 'ok', (error) => String(error));
        }
        const { Text } = $.ui.resolve(e);
        return Text({ children: JSON.stringify(out) });
      });`),
    ]);
    const { tree } = await runtime.render(band(), signal());
    expect(JSON.parse((tree as { children: string[] }).children[0])).toEqual({
      viewport: 'Error: Mod hook changed pinned event fields.',
      view: 'Error: Mod hook changed pinned event fields.',
      kind: 'Error: Mod ui.render props.maxRows is string, not number.',
      added: 'Error: Mod hook changed pinned event fields.',
      rows: 'ok',
    });
  });

  it('skips a hook whose tree fails, runs its catch and says why once', async () => {
    const runtime = await create([
      mod(`on('ui.render', async ($, e, next) => {
        const { Box, Text } = $.ui.resolve(e);
        return Box({ children: [await next(e), Text({ children: 'outer' })] });
      });`),
      mod(
        `on('ui.render', ($, e) => ({ type: 'Box', props: { color: 'red' } }));`,
      ),
      mod(`on('ui.render', ($, e) => 'a bare string');`),
    ]);
    for (let i = 0; i < 2; i++) {
      await expect(runtime.render(band(), signal())).resolves.toEqual({
        tree: {
          type: 'Box',
          children: [
            { type: 'engine', ref: 0 },
            { type: 'Text', children: ['outer'] },
          ],
        },
        notes: [],
      });
    }
    expect(logs.filter((log) => log.text.startsWith('ui.render'))).toEqual([
      // The middle one answers without next, so the last runs only once it fails.
      {
        plugin: 'mod-1',
        to: 'debug',
        text: 'ui.render hook skipped: returned the wrong shape (a tree AbovePrompt refuses: Box prop "color" is not allowed)',
      },
      {
        plugin: 'mod-2',
        to: 'debug',
        text: 'ui.render hook skipped: returned the wrong shape (a tree AbovePrompt refuses: the root must be an element)',
      },
    ]);
  });

  it('adjusts an accepted tree and says so once per load', async () => {
    const runtime = await create([
      mod(`let extra = 5;
      on('ui.render', ($, e) => {
        const { Box, Text } = $.ui.resolve(e);
        return Box({ borderStyle: extra === 5 ? 'wavy' : 'dotty', children: Text({ children: 'x'.repeat(100000 + extra++) }) });
      });`),
    ]);
    const first = await runtime.render(band(), signal());
    expect(first.tree).toEqual({
      type: 'Box',
      children: [
        {
          type: 'Text',
          children: ['x'.repeat(100000) + '\n… 5 more characters, not drawn'],
        },
      ],
    });
    expect(first.notes).toEqual([
      'mod-0: ui.render (AbovePrompt): Box borderStyle "wavy" is not a border style (the styles are single, double, round, bold, singleDouble, doubleSingle, classic, arrow, dashed, quote); the Box is drawn with no border',
      'mod-0: ui.render (AbovePrompt): 100005 characters of text are drawn up to the first 100000',
    ]);
    // Another border and a longer text are the same kinds, told already.
    expect((await runtime.render(band(), signal())).notes).toEqual([]);
  });

  it('asks the host for a redraw after a dispatch, only for plugins that draw', async () => {
    const runtime = await create([
      mod(`on('session.start', ($, e, next) => { $.ui.invalidate('ui.render'); return next(e); });
        on('ui.render', ($, e, next) => next(e));
        on('session.end', ($, e, next) => { $.ui.invalidate('prompt.section'); $.ui.invalidate('ui.render'); return next(e); });`),
      mod(`on('session.start', ($, e, next) => {
        let refused = '';
        try { $.ui.invalidate('ui.paint'); } catch (error) { refused = String(error); }
        $.ui.log(refused);
        $.ui.invalidate('ui.render');
        return next(e);
      });
      on('session.end', ($, e, next) => { $.ui.invalidate('ui.render'); return next(e); });`),
    ]);
    expect(invalidated).toEqual(['mod-0']);
    expect(logs.find((log) => log.plugin === 'mod-1')?.text).toBe(
      'TypeError: $.ui.invalidate takes ui.render or a cached-answer event, not ui.paint',
    );
    await runtime.end('session', 'other', signal());
    expect(invalidated).toEqual(['mod-0', 'mod-0']);
  });

  it('runs ui.render only where the host offers a site', async () => {
    const source = mod(`on('ui.render', ($, e, next) => next(e));
      on('session.start', async ($, e, next) => {
        const { qwen } = await $.session.version();
        $.ui.log(String(qwen.events.includes('ui.render')) + ':' + String(qwen.methods.includes('ui.resolve')));
        $.ui.invalidate('ui.render');
        return next(e);
      });`);
    const headless = await create([source], null);
    expect(headless.renderHooks).toEqual([]);
    expect(logs.map((log) => log.text)).toEqual([
      'Hooks for unsupported events will not run: ui.render',
      'false:true',
    ]);
    await expect(headless.render(band(), signal())).rejects.toThrow(
      'This host draws no AbovePrompt.',
    );
    logs.length = 0;
    await create([source]);
    expect(logs.map((log) => log.text)).toEqual(['true:true']);
    expect(invalidated).toEqual(['mod-0']);
  });
});
