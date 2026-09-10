// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrandProvider } from '../../brandContext';
import { I18nProvider } from '../../i18n';
import { StatusMessage, type StatusInfo } from './StatusMessage';

const INFO: StatusInfo = {
  cliVersion: '1.2.3',
  runtime: 'node',
  platform: 'darwin',
  auth: 'Qwen OAuth',
  baseUrl: '',
  model: 'qwen',
  fastModel: '',
  sessionId: 'session-1',
  sandbox: '',
  proxy: '',
  memoryUsage: '',
};

let root: Root;
let container: HTMLDivElement;

function renderStatus(name?: string) {
  act(() => {
    root.render(
      <I18nProvider language="en">
        <BrandProvider value={name === undefined ? {} : { name }}>
          <StatusMessage info={INFO} />
        </BrandProvider>
      </I18nProvider>,
    );
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('StatusMessage brand', () => {
  it('labels the version row with the configured brand name', () => {
    renderStatus('QiuQiu Code');

    expect(container.textContent).toContain('QiuQiu Code');
    expect(container.textContent).toContain('1.2.3');
    expect(container.textContent).not.toContain('Qwen Code');
  });

  it('labels the version row with the built-in name when no brand is configured', () => {
    renderStatus();

    expect(container.textContent).toContain('Qwen Code');
  });

  it('leaves the auth row naming the identity provider, not the product', () => {
    // Deliberate scope exclusion: a white-labeled shell still authenticates
    // against Qwen's OAuth service, and renaming that label would misdescribe
    // the flow to the person about to grant it access.
    renderStatus('QiuQiu Code');

    expect(container.textContent).toContain('Qwen OAuth');
  });
});
