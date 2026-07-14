import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import { CompactModeContext } from '../App';
import {
  WebShellCustomizationProvider,
  type AssistantTurnFooterRenderer,
  type ComposerTagRenderer,
  type MarkdownTableMode,
  type ToolHeaderExtraRenderer,
  type UserMessageContentParser,
  type UserMessageContentRenderer,
  type WebShellComposerTagIconMap,
  type WebShellMarkdownCustomization,
} from '../customization';
import { ErrorBoundary } from './ErrorBoundary';
import { MessageList } from './MessageList';
import { RootErrorFallback } from './RootErrorFallback';
import {
  getTranslator,
  I18nProvider,
  normalizeLanguage,
  type WebShellLanguage,
} from '../i18n';
import { transcriptBlocksToLocalizedMessages } from '../hooks/useMessages';
import { WebShellPortalRootContext } from '../portalRoot';
import {
  ThemeProvider,
  WebShellThemeId,
  type WebShellTheme,
} from '../themeContext';
import { TranscriptRenderModeProvider } from '../transcriptRenderMode';
import '../styles/globals.css';
import styles from '../App.module.css';

const DEFAULT_CHAT_MAX_WIDTH = 1000;
const CHAT_SHELL_HORIZONTAL_PADDING = 40;

export interface WebShellTranscriptProps {
  blocks: readonly DaemonTranscriptBlock[];
  theme?: WebShellTheme;
  language?: 'en' | 'zh-CN' | 'zh' | 'zh-cn';
  className?: string;
  style?: CSSProperties;
  chatMaxWidth?: number;
  workspaceCwd?: string;
  compactThinking?: boolean;
  collapseCompletedTurns?: boolean;
  markdownTableMode?: MarkdownTableMode;
  virtualScrollThreshold?: number;
  markdown?: WebShellMarkdownCustomization;
  composerTagIcons?: WebShellComposerTagIconMap;
  renderToolHeaderExtra?: ToolHeaderExtraRenderer;
  parseUserMessageContent?: UserMessageContentParser;
  renderUserMessageContent?: UserMessageContentRenderer;
  renderComposerTag?: ComposerTagRenderer;
  renderComposerTagTooltip?: ComposerTagRenderer;
  renderAssistantTurnFooter?: AssistantTurnFooterRenderer;
}

function resolveLanguage(
  language: WebShellTranscriptProps['language'],
): WebShellLanguage {
  if (language !== undefined) return normalizeLanguage(language);
  if (typeof window === 'undefined') return 'en';
  const params = new URLSearchParams(window.location.search);
  return normalizeLanguage(
    params.get('language') ?? params.get('lang') ?? navigator.language,
  );
}

function getChatWidthStyle(chatMaxWidth: number | undefined): CSSProperties {
  const width =
    typeof chatMaxWidth === 'number' &&
    Number.isFinite(chatMaxWidth) &&
    chatMaxWidth > 0
      ? chatMaxWidth
      : DEFAULT_CHAT_MAX_WIDTH;
  const contentWidth = `${width}px`;
  const shellWidth = `calc(${contentWidth} + ${CHAT_SHELL_HORIZONTAL_PADDING}px)`;
  return {
    '--chat-regular-content-width': contentWidth,
    '--chat-regular-shell-width': shellWidth,
    '--chat-content-width': contentWidth,
    '--chat-shell-width': shellWidth,
  } as CSSProperties;
}

function WebShellTranscriptContent({
  blocks,
  theme = WebShellThemeId.Dark,
  language,
  className,
  style,
  chatMaxWidth,
  workspaceCwd = '',
  compactThinking = false,
  collapseCompletedTurns = true,
  markdownTableMode = 'basic',
  virtualScrollThreshold,
  markdown,
  composerTagIcons,
  renderToolHeaderExtra,
  parseUserMessageContent,
  renderUserMessageContent,
  renderComposerTag,
  renderComposerTagTooltip,
  renderAssistantTurnFooter,
}: WebShellTranscriptProps): ReactElement {
  const resolvedLanguage = resolveLanguage(language);
  const t = useMemo(() => getTranslator(resolvedLanguage), [resolvedLanguage]);
  const messages = useMemo(
    () => transcriptBlocksToLocalizedMessages(blocks, t),
    [blocks, t],
  );
  const customization = useMemo(
    () => ({
      composerTagIcons,
      renderToolHeaderExtra,
      parseUserMessageContent,
      renderUserMessageContent,
      renderComposerTag,
      renderComposerTagTooltip,
      renderAssistantTurnFooter,
      compactThinking,
      collapseCompletedTurns,
      markdownTableMode,
      markdown,
    }),
    [
      collapseCompletedTurns,
      compactThinking,
      composerTagIcons,
      markdown,
      markdownTableMode,
      parseUserMessageContent,
      renderAssistantTurnFooter,
      renderComposerTag,
      renderComposerTagTooltip,
      renderToolHeaderExtra,
      renderUserMessageContent,
    ],
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const portalVariableNamesRef = useRef<Set<string>>(new Set());
  const rootClassName = [
    styles.app,
    styles.appChat,
    theme === WebShellThemeId.Light ? styles.themeLight : styles.themeDark,
    theme === WebShellThemeId.Dark ? 'dark' : undefined,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  const rootStyle = useMemo(
    () => ({ ...style, ...getChatWidthStyle(chatMaxWidth) }),
    [chatMaxWidth, style],
  );

  useLayoutEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.createElement('div');
    root.dataset.webShellPortalRoot = '';
    root.dataset.webShellShadcn = '';
    document.body.appendChild(root);
    setPortalRoot(root);
    return () => {
      root.remove();
      setPortalRoot(null);
    };
  }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !portalRoot) return;
    let frameId: number | null = null;
    const syncVariables = () => {
      frameId = null;
      const computedStyle = getComputedStyle(root);
      const nextNames = new Set<string>();
      portalRoot.dataset.webShellShadcn = '';
      portalRoot.classList.toggle('dark', theme === WebShellThemeId.Dark);
      portalRoot.lang = resolvedLanguage;
      for (let index = 0; index < computedStyle.length; index += 1) {
        const name = computedStyle[index];
        if (!name.startsWith('--')) continue;
        nextNames.add(name);
        portalRoot.style.setProperty(
          name,
          computedStyle.getPropertyValue(name),
        );
      }
      for (const name of portalVariableNamesRef.current) {
        if (!nextNames.has(name)) portalRoot.style.removeProperty(name);
      }
      portalVariableNamesRef.current = nextNames;
    };
    const scheduleSync = () => {
      if (frameId === null) frameId = requestAnimationFrame(syncVariables);
    };
    syncVariables();
    const observer = new MutationObserver(scheduleSync);
    let element: HTMLElement | null = root;
    while (element) {
      observer.observe(element, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme', 'lang'],
      });
      element = element.parentElement;
    }
    window.addEventListener('resize', scheduleSync);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', scheduleSync);
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [portalRoot, resolvedLanguage, rootClassName, rootStyle, theme]);

  return (
    <ThemeProvider value={theme}>
      <I18nProvider language={resolvedLanguage}>
        <WebShellPortalRootContext.Provider value={portalRoot}>
          <TranscriptRenderModeProvider value="readonly">
            <WebShellCustomizationProvider value={customization}>
              <CompactModeContext.Provider value={false}>
                <div
                  ref={rootRef}
                  className={rootClassName}
                  style={rootStyle}
                  data-web-shell-root
                  data-web-shell-shadcn
                  lang={resolvedLanguage}
                >
                  <div
                    className={`${styles.content} ${styles.contentHasMessages}`}
                  >
                    <MessageList
                      messages={messages}
                      pendingApproval={null}
                      isResponding={false}
                      workspaceCwd={workspaceCwd}
                      virtualScrollThreshold={virtualScrollThreshold}
                    />
                  </div>
                </div>
              </CompactModeContext.Provider>
            </WebShellCustomizationProvider>
          </TranscriptRenderModeProvider>
        </WebShellPortalRootContext.Provider>
      </I18nProvider>
    </ThemeProvider>
  );
}

export function WebShellTranscript(
  props: WebShellTranscriptProps,
): ReactElement {
  const language = resolveLanguage(props.language);
  return (
    <ErrorBoundary
      label="web-shell-transcript-root"
      resetKeys={[props.blocks, language]}
      fallback={(error, reset) => (
        <RootErrorFallback error={error} onRetry={reset} language={language} />
      )}
    >
      <WebShellTranscriptContent {...props} />
    </ErrorBoundary>
  );
}
