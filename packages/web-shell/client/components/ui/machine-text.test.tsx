import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MachineText } from './machine-text';

it('preserves text and escaping in server-rendered exports', () => {
  expect(
    renderToStaticMarkup(<MachineText>{'مجلد/run.sh <input>'}</MachineText>),
  ).toBe('<bdi dir="ltr">مجلد/run.sh &lt;input&gt;</bdi>');
});
