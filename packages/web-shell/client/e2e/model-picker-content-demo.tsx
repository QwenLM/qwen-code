import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import { ChatEditor } from '../components/ChatEditor';
import { WebShellCustomizationProvider } from '../customization';
import { I18nProvider } from '../i18n';
import type {
  WebShellModelPickerContext,
  WebShellModelPickerItemContext,
  WebShellModelPickerMount,
  WebShellModelPickerOptions,
} from '../model-picker';
import { WebShellPortalRootContext } from '../portalRoot';
import { installWebShellShadowStyles } from '../shadowDom';
import { ThemeProvider, type WebShellTheme } from '../themeContext';
import '../styles/globals.css';
import '../styles/standalone.css';

const params = new URLSearchParams(location.search);
const alpha = 'model-alpha(openai)';
const beta = 'model-beta(anthropic)';
const gamma = 'model-gamma(openai)';
const models = [
  { id: alpha, label: 'Example Alpha' },
  { id: beta, label: 'Example Beta' },
];
const unavailableModels = [
  {
    id: gamma,
    label: 'Example Gamma',
    tooltip: 'This model is unavailable in the current demo plan.',
  },
];
const stats = {
  mounts: 0,
  updates: 0,
  disposes: 0,
  actions: 0,
  leftSelections: 0,
  rightSelections: 0,
};

function count(key: keyof typeof stats) {
  stats[key]++;
  document.getElementById('demo-stats')!.textContent = JSON.stringify(stats);
}

function pane(context: WebShellModelPickerContext) {
  return context.sessionId === 'demo-left' ? 'left' : 'right';
}

const mountHeader: WebShellModelPickerMount<WebShellModelPickerContext> = (
  container,
  initial,
) => {
  count('mounts');
  const text = container.ownerDocument.createElement('span');
  text.dataset.demoHeader = pane(initial);
  text.style.cssText = 'display:block;padding:8px;font-size:12px';
  container.append(text);
  const update = (context: WebShellModelPickerContext) => {
    text.textContent = `${pane(context)}: ${context.currentModelId ?? 'none'}`;
    text.dataset.currentModel = context.currentModelId;
    text.dataset.composerId = context.composerId;
    text.dataset.sessionId = context.sessionId;
    text.dataset.workspaceCwd = context.workspaceCwd;
    text.dataset.theme = context.theme;
  };
  update(initial);
  return {
    update(context) {
      count('updates');
      update(context);
    },
    dispose() {
      count('disposes');
      text.remove();
    },
  };
};

const mountRow: WebShellModelPickerMount<WebShellModelPickerItemContext> = (
  container,
  initial,
) => {
  count('mounts');
  let context = initial;
  const document = container.ownerDocument;
  const content = document.createElement('span');
  content.dataset.demoModel = initial.model.id;
  content.style.cssText = 'display:flex;align-items:center;gap:10px;width:100%';
  const label = document.createElement('span');
  const badge = document.createElement('span');
  badge.textContent = 'Special rate';
  badge.style.cssText =
    'font-size:10px;border:1px solid currentColor;padding:2px';
  const rate = document.createElement('span');
  rate.textContent = '0.5×';
  rate.style.marginLeft = 'auto';
  content.append(label, badge, rate);
  container.append(content);

  const card = document.createElement('div');
  card.dataset.demoOverlay = initial.model.id;
  card.dataset.demoPane = pane(initial);
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', `${initial.model.label} details`);
  card.hidden = true;
  card.style.cssText =
    'position:fixed;z-index:2000;max-width:240px;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--popover);color:var(--popover-foreground);box-shadow:0 4px 20px #0003';
  const explanation = document.createElement('p');
  explanation.textContent = 'Example pricing applies during the demo window.';
  const action = document.createElement('button');
  action.type = 'button';
  action.textContent = 'Read model details';
  action.style.cssText =
    'padding:6px;border:1px solid currentColor;border-radius:4px;cursor:pointer';
  action.addEventListener('click', () => count('actions'));
  card.append(explanation, action);
  initial.overlayContainer.append(card);

  let restoringFocus = false;
  const show = () => {
    const rect = context.rowElement.getBoundingClientRect();
    card.style.left = `${Math.max(8, Math.min(rect.right + 8, window.innerWidth - 264))}px`;
    card.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - 160))}px`;
    card.hidden = false;
  };
  const focus = () => {
    if (restoringFocus) return;
    show();
  };
  const leave = (event: PointerEvent | FocusEvent) => {
    if (event instanceof PointerEvent && event.pointerType === 'touch') return;
    const next = event.relatedTarget;
    if (
      next instanceof Node &&
      (context.rowElement.contains(next) || card.contains(next))
    ) {
      return;
    }
    card.hidden = true;
  };
  const enter = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') show();
  };
  const touch = (event: MouseEvent) => {
    if (
      params.get('touch') === '1' &&
      (event as PointerEvent).pointerType === 'touch'
    ) {
      event.preventDefault();
      show();
    }
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    card.hidden = true;
    restoringFocus = true;
    context.rowElement.focus();
    restoringFocus = false;
  };
  initial.rowElement.addEventListener('pointerenter', enter);
  initial.rowElement.addEventListener('pointerleave', leave);
  initial.rowElement.addEventListener('focus', focus);
  initial.rowElement.addEventListener('blur', leave);
  initial.rowElement.addEventListener('click', touch);
  card.addEventListener('pointerleave', leave);
  card.addEventListener('focusout', leave);
  card.addEventListener('keydown', escape);

  const update = (next: WebShellModelPickerItemContext) => {
    context = next;
    label.textContent = next.model.label;
    content.dataset.selected = String(next.isSelected);
    content.dataset.sessionId = next.sessionId;
  };
  update(initial);
  return {
    update(next) {
      count('updates');
      update(next);
    },
    dispose() {
      count('disposes');
      initial.rowElement.removeEventListener('pointerenter', enter);
      initial.rowElement.removeEventListener('pointerleave', leave);
      initial.rowElement.removeEventListener('focus', focus);
      initial.rowElement.removeEventListener('blur', leave);
      initial.rowElement.removeEventListener('click', touch);
      card.remove();
      content.remove();
    },
  };
};

const failRow: WebShellModelPickerMount<
  WebShellModelPickerItemContext
> = () => {
  if (params.get('failure') === 'throw') {
    throw new Error('Example host mount failed');
  }
  return undefined;
};
const modelPicker: WebShellModelPickerOptions = {
  mountHeader,
  displayContentByModelId: {
    [alpha]: mountRow,
    [beta]: mountRow,
    [gamma]: params.has('failure') ? failRow : mountRow,
  },
};

function Demo() {
  const [current, setCurrent] = useState({ left: alpha, right: beta });
  const [reasoning, setReasoning] = useState(params.get('reasoning') === '1');
  const [theme, setTheme] = useState<WebShellTheme>(
    params.get('theme') === 'light' ? 'light' : 'dark',
  );
  const [shadow, setShadow] = useState(params.get('shadow') === '1');
  const portalHost = useRef<HTMLDivElement>(null);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const customization = useMemo(
    () => ({ modelPicker, fileUploadEnabled: false }),
    [],
  );
  useLayoutEffect(() => {
    const host = portalHost.current!;
    const parent = shadow
      ? (host.shadowRoot ?? host.attachShadow({ mode: 'open' }))
      : host;
    const mount = host.ownerDocument.createElement('div');
    mount.dataset.webShellRoot = '';
    mount.dataset.webShellShadcn = '';
    const removeStyles = shadow
      ? installWebShellShadowStyles(parent as ShadowRoot)
      : () => undefined;
    parent.append(mount);
    setPortalRoot(mount);
    return () => {
      setPortalRoot(null);
      mount.remove();
      removeStyles();
    };
  }, [shadow]);
  useLayoutEffect(() => {
    const className = `theme-${theme}${theme === 'dark' ? ' dark' : ''}`;
    document.documentElement.className = className;
    if (portalRoot) portalRoot.className = className;
  }, [portalRoot, theme]);
  useEffect(() => {
    const update = (event: Event) => {
      const change = (
        event as CustomEvent<{ pane: 'left' | 'right'; modelId: string }>
      ).detail;
      setCurrent((previous) => ({
        ...previous,
        [change.pane]: change.modelId,
      }));
    };
    window.addEventListener('model-picker-current-model', update);
    return () =>
      window.removeEventListener('model-picker-current-model', update);
  }, []);

  return (
    <I18nProvider language="en">
      <ThemeProvider value={theme}>
        <WebShellCustomizationProvider value={customization}>
          <WebShellPortalRootContext.Provider value={portalRoot}>
            <main
              data-web-shell-root=""
              data-web-shell-shadcn=""
              className={`theme-${theme}${theme === 'dark' ? ' dark' : ''}`}
              style={{
                minHeight: '100vh',
                padding: 24,
                fontFamily: 'system-ui, sans-serif',
                color: 'var(--foreground)',
                background: 'var(--background)',
              }}
            >
              <h1>Model picker content</h1>
              <p>Fictional models and prices for embedding-host acceptance.</p>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <button onClick={() => setReasoning((value) => !value)}>
                  Toggle reasoning
                </button>
                <button
                  onClick={() =>
                    setTheme((value) => (value === 'dark' ? 'light' : 'dark'))
                  }
                >
                  Toggle theme
                </button>
                <button onClick={() => setShadow((value) => !value)}>
                  Toggle shadow
                </button>
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: 24,
                  flexWrap: 'wrap',
                  marginTop: 160,
                }}
              >
                {(['left', 'right'] as const).map((name) => (
                  <section
                    key={name}
                    data-demo-composer={name}
                    style={{ flex: '1 1 380px', minWidth: 0 }}
                  >
                    <h2>{name} composer</h2>
                    <ChatEditor
                      onSubmit={() => undefined}
                      commands={[]}
                      currentModel={current[name]}
                      availableModels={models}
                      unavailableModels={unavailableModels}
                      visibleToolbarActions={['model']}
                      attachmentsEnabled={false}
                      workspaceFeaturesEnabled={false}
                      disableLegacyHistoryFallback
                      composerScopeKey={`demo-${name}`}
                      modelPickerScope={{
                        sessionId: `demo-${name}`,
                        workspaceId: `workspace-${name}`,
                        workspaceCwd: `/example/${name}`,
                        daemonBaseUrl: `https://${name}.example.invalid/proxy`,
                      }}
                      reasoning={
                        reasoning
                          ? {
                              enabled: true,
                              effort: 'medium',
                              efforts: ['low', 'medium', 'high'],
                            }
                          : undefined
                      }
                      onSelectModel={(id) => {
                        count(
                          name === 'left'
                            ? 'leftSelections'
                            : 'rightSelections',
                        );
                        setCurrent((previous) => ({ ...previous, [name]: id }));
                      }}
                    />
                  </section>
                ))}
              </div>
              <div
                key={String(shadow)}
                ref={portalHost}
                data-demo-portal-host=""
              />
              <button
                data-testid="outside"
                style={{ position: 'fixed', right: 24, bottom: 24 }}
              >
                Outside picker
              </button>
            </main>
          </WebShellPortalRootContext.Provider>
        </WebShellCustomizationProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
