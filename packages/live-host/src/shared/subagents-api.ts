import type { LiveLanguage } from '@qwen-code/qwen-live/i18n';
import type {
  SubagentsControlErrorCode,
  SubagentsControlRequest,
  SubagentsControlResult,
  SubagentsPage,
  SubagentsSnapshot,
} from '@qwen-code/qwen-live/subagents';
import type { LiveTheme, ResolvedTheme } from './theme.ts';

export type SubagentsWindowState = {
  theme?: LiveTheme;
  resolvedTheme?: ResolvedTheme;
  language: LiveLanguage;
  connected: boolean;
  snapshot?: SubagentsSnapshot;
  instanceId?: string;
  controlsAvailable?: boolean;
  page?: SubagentsPage;
  loading?: boolean;
  pageError?: SubagentsControlErrorCode;
  mode: 'summary' | 'list' | 'detail';
  selectedId?: string;
};

export type SubagentsWindowApi = {
  getState: () => Promise<SubagentsWindowState>;
  onState: (listener: (state: SubagentsWindowState) => void) => () => void;
  setHover: (hovered: boolean) => void;
  setKeyboardHeld?: (held: boolean) => void;
  back: () => Promise<void>;
  expand: () => Promise<void>;
  close: () => void;
  openDetail: (id: string) => Promise<void>;
  control: (
    instanceId: string,
    request: SubagentsControlRequest,
  ) => Promise<SubagentsControlResult>;
};
