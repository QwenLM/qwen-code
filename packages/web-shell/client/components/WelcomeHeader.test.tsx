// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrandProvider } from '../brandContext';
import { I18nProvider } from '../i18n';
import { WelcomeHeader } from './WelcomeHeader';

const BASE_PROPS = {
  version: '1.2.3',
  cwd: '/tmp/project',
  currentModel: 'qwen',
  currentMode: 'default',
};

let root: Root;
let container: HTMLDivElement;

function renderHeader(name?: string) {
  act(() => {
    root.render(
      <I18nProvider language="en">
        <BrandProvider value={name === undefined ? {} : { name }}>
          <WelcomeHeader {...BASE_PROPS} />
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

describe('WelcomeHeader brand', () => {
  it('renders the configured brand name as the welcome title', () => {
    renderHeader('QiuQiu Code');

    expect(container.textContent).toContain('QiuQiu Code');
    expect(container.textContent).not.toContain('Qwen Code');
  });

  it('renders the built-in name when no brand is configured', () => {
    renderHeader();

    expect(container.textContent).toContain('Qwen Code');
  });

  it('renders the built-in name for an empty brand name', () => {
    renderHeader('');

    expect(container.textContent).toContain('Qwen Code');
  });
});
