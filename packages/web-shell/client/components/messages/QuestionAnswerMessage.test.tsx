// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ACPToolCall } from '../../adapters/types';
import { I18nProvider } from '../../i18n';
import { WebShellPortalRootContext } from '../../portalRoot';
import { TranscriptRenderModeProvider } from '../../transcriptRenderMode';
import { QuestionAnswerMessage } from './QuestionAnswerMessage';
import { QuoteToComposerContext } from './quoteToComposerContext';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let portal: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  portal?.remove();
  window.getSelection()?.removeAllRanges();
});

function mount(mode: 'interactive' | 'document', onQuote: () => void) {
  container = document.createElement('div');
  portal = document.createElement('div');
  document.body.append(container, portal);
  root = createRoot(container);
  act(() =>
    root!.render(
      <TranscriptRenderModeProvider value={mode}>
        <I18nProvider language="en">
          <WebShellPortalRootContext.Provider value={portal}>
            <QuoteToComposerContext.Provider value={onQuote}>
              <QuestionAnswerMessage
                tool={{ callId: 'ask-1' } as ACPToolCall}
                result={{
                  text: 'answered',
                  answers: [
                    { question: 'Which database?', answer: 'Postgres' },
                  ],
                }}
              />
            </QuoteToComposerContext.Provider>
          </WebShellPortalRootContext.Provider>
        </I18nProvider>
      </TranscriptRenderModeProvider>,
    ),
  );
}

async function selectQuestion() {
  const question = container!.querySelector('dt')!;
  const pointer = (type: string) => {
    const event = new MouseEvent(type, { bubbles: true, button: 0 });
    Object.defineProperty(event, 'pointerType', { value: 'mouse' });
    return event;
  };
  await act(async () => question.dispatchEvent(pointer('pointerdown')));
  const range = document.createRange();
  range.selectNodeContents(question);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () => question.dispatchEvent(pointer('pointerup')));
}

describe('QuestionAnswerMessage selection menu', () => {
  it('offers Quote over the question the agent asked', async () => {
    const onQuote = vi.fn();
    mount('interactive', onQuote);
    await selectQuestion();
    const quote = [...portal!.querySelectorAll('button')].find(
      (button) => button.textContent === 'Quote to composer',
    );
    expect(quote).toBeDefined();
    await act(async () => quote!.click());
    expect(onQuote).toHaveBeenCalledWith('Which database?');
  });

  it('stays closed in document mode', async () => {
    mount('document', vi.fn());
    await selectQuestion();
    expect(portal!.querySelector('[data-slot="popover-content"]')).toBeNull();
  });
});
