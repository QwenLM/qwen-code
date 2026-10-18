/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, test } from '@playwright/test';

let script: string;

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: fileURLToPath(
        new URL(
          '../../../../integrations/generated-ui/src/app/',
          import.meta.url,
        ),
      ),
      contents: `
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
      `,
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
  });
  script = result.outputFiles[0].text;
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
