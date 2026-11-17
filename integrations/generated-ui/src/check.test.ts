/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkDocument, readMarkup } from './check.js';
import type { ShowInput } from './contracts.js';

function view(html: string, javascript: string): ShowInput {
  return { title: 'View', summary: 'Summary', html, css: '', javascript };
}

describe('readMarkup', () => {
  it('reads initial control values the way the browser starts them', () => {
    const markup = readMarkup(
      '<input id="seats" type="number" value="13">' +
        '<input id="share" type="range" min="10" max="30">' +
        '<input id="annual" type="checkbox" checked>' +
        "<input id='name' value='A &amp; B'>" +
        '<select id="plan"><option value="basic">Basic</option>' +
        '<option value="team" selected>Team</option></select>' +
        '<select id="unit"><option>USD</option><option>CNY</option></select>' +
        '<textarea id="note">a &lt; b</textarea><p id="out"></p>',
    );
    expect(markup.problem).toBeUndefined();
    expect(markup.inputs).toEqual({
      seats: { value: '13', checked: false },
      share: { value: '20', checked: false },
      annual: { value: 'on', checked: true },
      name: { value: 'A & B', checked: false },
      plan: { value: 'team', checked: false },
      unit: { value: 'USD', checked: false },
      note: { value: 'a < b', checked: false },
    });
    expect([...markup.ids]).toContain('out');
  });

  it.each([
    ['<p id="a"></p><p id="a"></p>', /used more than once/],
    ['<p id="1a"></p>', /must start with an ASCII letter/],
    ['<input type="number">', /needs a unique id/],
    ['<input id="d" type="date">', /unsupported type "date"/],
    ['<select id="s" multiple></select>', /cannot use multiple/],
  ])('reports markup the view would reject: %s', (html, problem) => {
    expect(readMarkup(html).problem).toMatch(problem);
  });
});

describe('checkDocument', () => {
  it.each(['../README.md', '../skills/generated-ui/SKILL.md'])(
    'accepts every documented example in %s',
    async (path) => {
      const text = readFileSync(new URL(path, import.meta.url), 'utf8');
      for (const [, json] of text.matchAll(/```json\n([\s\S]*?)\n```/g)) {
        await expect(checkDocument(JSON.parse(json))).resolves.toBeUndefined();
      }
    },
  );

  it('accepts a view whose initial calculation succeeds', async () => {
    await expect(
      checkDocument(
        view(
          '<input id="workers" type="number" value="4"><output id="capacity"></output>',
          'function update(){ui.text("capacity", String(Number(ui.input("workers").value)*25));}' +
            'ui.on("workers","input",update); update();',
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it('names a syntax error with its location', async () => {
    await expect(
      checkDocument(
        view(
          '<input id="seats" type="number" value="5"><p id="out"></p>',
          'function render(){\nui.value("seats", String(5)));\n}\nrender();',
        ),
      ),
    ).resolves.toMatch(
      /^Script error: SyntaxError: .+ \(line 2, column \d+\)\.$/,
    );
  });

  it('names an error thrown by the initial calculation', async () => {
    await expect(
      checkDocument(view('<p id="out"></p>', 'ui.text("out", total());')),
    ).resolves.toBe(
      "Script error: ReferenceError: 'total' is not defined (line 1, column 16).",
    );
  });

  it('uses initial input values when it runs the calculation', async () => {
    await expect(
      checkDocument(
        view(
          '<input id="rate" type="number" value="2"><p id="out"></p>',
          'if (ui.input("rate").value !== "2") throw new Error("defaults missing");' +
            'ui.text("out", "ok");',
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it('reports initial updates that target missing elements', async () => {
    await expect(
      checkDocument(view('<p id="out"></p>', 'ui.text("result", "x");')),
    ).resolves.toBe(
      'The initial calculation updates "#result", but no element has that id.',
    );
    await expect(
      checkDocument(view('<p id="out"></p>', 'ui.value("out", "x");')),
    ).resolves.toMatch(/not an input/);
  });

  it('follows elements inserted by earlier initial updates', async () => {
    await expect(
      checkDocument(
        view(
          '<div id="slot"></div>',
          'ui.html("slot", "<input id=\\"n\\" type=\\"number\\">");' +
            'ui.value("n", "3");',
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it('reports a calculation that never finishes', async () => {
    await expect(
      checkDocument(view('<p id="out"></p>', 'while (true) {}')),
    ).resolves.toMatch(/time limit/);
  });

  it('reports markup problems before running the script', async () => {
    await expect(
      checkDocument(view('<input id="d" type="date">', 'nope();')),
    ).resolves.toMatch(/unsupported type "date"/);
  });
});
