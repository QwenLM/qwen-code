// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { RemoteAccessSettingsCard } from './RemoteAccessSettingsCard';

const request = vi.hoisted(() => vi.fn());
const availability = vi.hoisted(() => ({ value: 'available' as string }));
vi.mock('../daemon/rest-request.js', () => ({
  createDaemonRestRequest: () => request,
}));
vi.mock('../daemon/availability-context.js', () => ({
  useDaemonAvailability: () => availability.value,
}));
vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspace: () => ({ baseUrl: 'http://localhost:4173', token: 'operator' }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let container: HTMLDivElement;
const off = {
  active: false,
  canManage: true,
  externallyConfigured: false,
  interfaces: [{ address: '11.1.2.3', interfaceName: 'eth0' }],
  defaultPort: 4173,
};
const on = {
  ...off,
  active: true,
  generation: 'first',
  url: 'http://11.1.2.3:4173',
  address: '11.1.2.3',
  port: 4173,
};

beforeEach(() => {
  request.mockReset();
  availability.value = 'available';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const mount = () =>
  act(async () =>
    root.render(
      <I18nProvider language="en">
        <RemoteAccessSettingsCard />
      </I18nProvider>,
    ),
  );
const toggle = () =>
  container.querySelector<HTMLButtonElement>('[role="switch"]')!;

it('stays off until the user enables access and then exposes address and token controls', async () => {
  request.mockResolvedValueOnce(Response.json(off));
  await mount();
  expect(toggle().getAttribute('aria-checked')).toBe('false');
  expect(request).toHaveBeenCalledTimes(1);
  request.mockResolvedValueOnce(Response.json(on));
  await act(async () => toggle().click());
  expect(request.mock.calls[1][0]).toBe('/remote-access/enable');
  expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({
    address: '11.1.2.3',
    origins: [],
  });
  expect(toggle().getAttribute('aria-checked')).toBe('true');
  expect(
    container.querySelector<HTMLInputElement>(
      '[aria-label="Connection address"]',
    )?.value,
  ).toBe(on.url);
  request.mockResolvedValueOnce(Response.json({ ...on, token: 'secret' }));
  const reveal = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Show token',
  )!;
  await act(async () => reveal.click());
  expect(
    container.querySelector<HTMLInputElement>('#remote-access-token')?.value,
  ).toBe('secret');
  request.mockResolvedValueOnce(Response.json(off));
  await act(async () => toggle().click());
  expect(container.querySelector('#remote-access-token')).toBeNull();
  expect(toggle().getAttribute('aria-checked')).toBe('false');
});

it('reconciles a lost enable response rather than reporting a false off state', async () => {
  request.mockResolvedValueOnce(Response.json(off));
  await mount();
  request.mockRejectedValueOnce(new TypeError('connection lost'));
  request.mockResolvedValueOnce(Response.json(on));
  await act(async () => toggle().click());
  expect(request.mock.calls[2][0]).toBe('/remote-access');
  expect(toggle().getAttribute('aria-checked')).toBe('true');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'connection lost',
  );
});

it('does not let a remote client manage access or disguise an external primary as off', async () => {
  request.mockResolvedValueOnce(
    Response.json({
      active: false,
      canManage: false,
      externallyConfigured: true,
    }),
  );
  await mount();
  expect(container.querySelector('[role="switch"]')).toBeNull();
  expect(container.textContent).toContain('externally configured');
  expect(request).toHaveBeenCalledTimes(1);
});

it('clears a stale poll error once a later refresh succeeds (R1-7)', async () => {
  request.mockRejectedValueOnce(new Error('poll failed'));
  await mount();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'poll failed',
  );
  request.mockResolvedValueOnce(Response.json(off));
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('renders no interface Select when the server reports zero interfaces (R1-11)', async () => {
  request.mockResolvedValueOnce(Response.json({ ...off, interfaces: [] }));
  await mount();
  expect(container.querySelector('[role="combobox"]')).toBeNull();
  request.mockResolvedValueOnce(
    Response.json({
      ...off,
      interfaces: [
        { address: '11.1.2.3', interfaceName: 'eth0' },
        { address: '192.168.1.5', interfaceName: 'wlan0' },
      ],
    }),
  );
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  expect(container.querySelector('[role="combobox"]')).not.toBeNull();
});

it('preserves the operator origins draft across an availability blip (R1-9)', async () => {
  request.mockResolvedValue(Response.json(off));
  await mount();
  const textarea = () =>
    container.querySelector<HTMLTextAreaElement>('#remote-access-origins')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )!.set!;
    setter.call(textarea(), 'https://draft.example');
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(textarea().value).toBe('https://draft.example');
  // A transient daemon-availability blip re-runs the polling effect but must
  // not reset the identity-scoped draft.
  availability.value = 'unavailable';
  await mount();
  availability.value = 'available';
  await mount();
  expect(textarea().value).toBe('https://draft.example');
});
