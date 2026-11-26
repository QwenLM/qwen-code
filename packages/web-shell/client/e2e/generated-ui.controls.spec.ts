/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, test } from '@playwright/test';

let script: string;
let selectionScript: string;
let radioScript: string;

async function bundleSurface(contents: string): Promise<string> {
  const result = await build({
    stdin: {
      resolveDir: fileURLToPath(
        new URL(
          '../../../../integrations/generated-ui/src/app/',
          import.meta.url,
        ),
      ),
      contents,
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
  });
  return result.outputFiles[0].text;
}

test.beforeAll(async () => {
  script = await bundleSurface(`
        import { ViewSurface } from './surface.ts';
        const frame = document.querySelector('iframe');
        const snapshot = document.querySelector('#snapshot');
        const surface = new ViewSurface(frame, () => {}, (message) => {
          throw new Error(message);
        });
        surface.mount(
          '<input id="plan-a" type="radio" name="plan" value="a">' +
          '<input id="plan-b" type="radio" name="plan" value="b" checked>' +
          '<input id="alone" type="radio" name="solo" checked onclick="alert(1)">' +
          '<div id="dynamic"></div><p id="answer"></p><script>alert(1)</script>',
          '',
        ).then((inputs) => { snapshot.textContent = JSON.stringify(inputs); });
        document.querySelector('#update').onclick = () => {
          surface.apply([{ kind: 'text', id: 'answer', value: 'Updated' }]);
          snapshot.textContent = JSON.stringify(surface.inputs());
        };
        document.querySelector('#insert').onclick = () => {
          surface.apply([{
            kind: 'html', id: 'dynamic',
            value: '<input id="new-a" type="radio" name="new" value="a" checked>' +
              '<input id="new-b" type="radio" name="new" value="b" checked onclick="alert(1)">' +
              '<script>alert(1)</script>',
          }]);
          snapshot.textContent = JSON.stringify(surface.inputs());
        };
  `);
  selectionScript = await bundleSurface(`
    import { ViewSurface } from './surface.ts';
    const surface = new ViewSurface(document.querySelector('iframe'), () => {}, (message) => {
      throw new Error(message);
    });
    const options = '<option value="1">One</option><option value="2">Two</option>';
    surface.mount('<select id="rate">' + options + '</select><output id="answer">Initial</output>', '');
    let inputs;
    document.querySelector('#capture').onclick = () => { inputs = surface.inputs(); };
    document.querySelector('#rebuild').onclick = () => {
      surface.apply([
        { kind: 'html', id: 'rate', value: options },
        { kind: 'text', id: 'answer', value: 'Rebuilt' },
      ], inputs);
    };
  `);
  radioScript = await bundleSurface(`
    import { ViewSurface } from './surface.ts';
    const surface = new ViewSurface(document.querySelector('iframe'), () => {}, (message) => {
      throw new Error(message);
    });
    surface.mount(
      '<input id="plan-a" type="radio" name="plan" checked>' +
      '<input id="plan-b" type="radio" name="plan">' +
      '<div id="dynamic"></div><output id="answer">Initial</output>',
      '',
    );
    let inputs;
    document.querySelector('#capture').onclick = () => { inputs = surface.inputs(); };
    document.querySelector('#insert').onclick = () => {
      surface.apply([
        { kind: 'html', id: 'dynamic', value: '<input id="plan-c" type="radio" name="plan" checked>' },
        { kind: 'text', id: 'answer', value: 'Inserted' },
      ], inputs);
    };
  `);
});

test('generated radio defaults and user edits survive sanitized updates @smoke', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent(
    '<iframe title="Generated view" style="width:600px;height:200px"></iframe>' +
      '<button id="update">Update text</button><button id="insert">Insert radios</button>' +
      '<output id="snapshot"></output>',
  );
  await page.addScriptTag({ content: script });
  const view = page.frameLocator('iframe');
  await expect(view.locator('#plan-b')).toBeChecked();
  await expect(view.locator('#plan-a')).not.toBeChecked();
  await expect(view.locator('#alone')).toBeChecked();
  const snapshot = async () =>
    JSON.parse((await page.locator('#snapshot').textContent())!);
  expect(await snapshot()).toEqual({
    'plan-a': { value: 'a', checked: false },
    'plan-b': { value: 'b', checked: true },
    alone: { value: 'on', checked: true },
  });
  await expect(view.locator('script,[onclick]')).toHaveCount(0);

  await view.locator('#plan-a').check();
  await page.getByRole('button', { name: 'Update text' }).click();
  await expect(view.locator('#answer')).toHaveText('Updated');
  await expect(view.locator('#plan-a')).toBeChecked();
  await expect(view.locator('#plan-b')).not.toBeChecked();
  expect(await snapshot()).toMatchObject({
    'plan-a': { checked: true },
    'plan-b': { checked: false },
  });

  await page.getByRole('button', { name: 'Insert radios' }).click();
  await expect(view.locator('#new-a')).not.toBeChecked();
  await expect(view.locator('#new-b')).toBeChecked();
  await expect(view.locator('#plan-a')).toBeChecked();
  expect(await snapshot()).toMatchObject({
    'new-a': { value: 'a', checked: false },
    'new-b': { value: 'b', checked: true },
  });
  await expect(view.locator('script,[onclick]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('generated dropdown rebuilding preserves newer edits and accepts a fresh round @smoke', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent(
    '<iframe title="Generated view" style="width:600px;height:200px"></iframe>' +
      '<button id="capture">Start round</button><button id="rebuild">Deliver rebuild</button>',
  );
  await page.addScriptTag({ content: selectionScript });
  const view = page.frameLocator('iframe');
  await expect(view.locator('#rate')).toHaveValue('1');
  await page.getByRole('button', { name: 'Start round' }).click();
  await view.locator('#rate').selectOption('2');
  await page.getByRole('button', { name: 'Deliver rebuild' }).click();
  await expect(view.locator('#rate')).toHaveValue('2');
  await expect(view.locator('#answer')).toHaveText('Initial');

  await page.getByRole('button', { name: 'Start round' }).click();
  await page.getByRole('button', { name: 'Deliver rebuild' }).click();
  await expect(view.locator('#rate')).toHaveValue('1');
  await expect(view.locator('#answer')).toHaveText('Rebuilt');
  expect(errors).toEqual([]);
});

test('generated radio insertion preserves newer group selections and accepts a fresh round @smoke', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent(
    '<iframe title="Generated view" style="width:600px;height:200px"></iframe>' +
      '<button id="capture">Start round</button><button id="insert">Deliver insertion</button>',
  );
  await page.addScriptTag({ content: radioScript });
  const view = page.frameLocator('iframe');
  await expect(view.locator('#plan-a')).toBeChecked();
  await page.getByRole('button', { name: 'Start round' }).click();
  await view.locator('#plan-b').check();
  await page.getByRole('button', { name: 'Deliver insertion' }).click();
  await expect(view.locator('#plan-b')).toBeChecked();
  await expect(view.locator('#plan-a')).not.toBeChecked();
  await expect(view.locator('#plan-c')).toHaveCount(0);
  await expect(view.locator('#answer')).toHaveText('Initial');

  await page.getByRole('button', { name: 'Start round' }).click();
  await page.getByRole('button', { name: 'Deliver insertion' }).click();
  await expect(view.locator('#plan-b')).not.toBeChecked();
  await expect(view.locator('#plan-c')).toBeChecked();
  await expect(view.locator('#answer')).toHaveText('Inserted');
  expect(errors).toEqual([]);
});
