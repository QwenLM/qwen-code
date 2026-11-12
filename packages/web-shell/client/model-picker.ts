import type { WebShellLanguage } from './i18n';
import type { WebShellTheme } from './themeContext';

export interface WebShellModelPickerContext {
  readonly composerId: string;
  readonly sessionId?: string;
  readonly workspaceId?: string;
  readonly workspaceCwd?: string;
  readonly daemonBaseUrl?: string;
  readonly currentModelId?: string;
  readonly language: WebShellLanguage;
  readonly theme: WebShellTheme;
  readonly overlayContainer: HTMLElement;
}

export interface WebShellModelPickerItemContext
  extends WebShellModelPickerContext {
  readonly model: {
    readonly id: string;
    readonly label: string;
    readonly disabled: boolean;
    readonly tooltip?: string;
  };
  readonly isSelected: boolean;
  readonly rowElement: HTMLElement;
}

/** Keep mount functions stable; create an independent view for each call. */
export type WebShellModelPickerMount<TContext> = (
  container: HTMLElement,
  context: TContext,
) =>
  | {
      update(context: TContext): void;
      dispose(): void;
    }
  | null
  | undefined;

export interface WebShellModelPickerOptions {
  readonly mountHeader?: WebShellModelPickerMount<WebShellModelPickerContext>;
  readonly displayContentByModelId?: Readonly<
    Partial<
      Record<string, WebShellModelPickerMount<WebShellModelPickerItemContext>>
    >
  >;
}
