/**
 * Customization seam — the narrow slice of host customization the conversation
 * flow reads. The host's full customization surface (composer, footer, welcome,
 * markdown plugins, …) stays host-side; only these three fields cross into the
 * panel. Host injects them via `ChatPanelProviders`.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { ACPToolCall } from './adapters/types';

export type ToolHeaderKind =
  | 'agent'
  | 'edit'
  | 'fetch'
  | 'read'
  | 'shell'
  | 'todo'
  | 'write'
  | 'other';

export interface ToolHeaderExtraRenderInfo {
  kind: ToolHeaderKind;
  tool: ACPToolCall;
  displayName: string;
  description: string;
  elapsed: string;
  workspaceCwd?: string;
}

export type ToolHeaderExtraRenderer = (
  info: ToolHeaderExtraRenderInfo,
) => ReactNode;

/**
 * A system message the host may render specially (slash-command output like
 * `/stats`, `/mcp`, context-usage panels, …). The panel renders these via the
 * host seam; anything the host returns `null` for falls back to the panel's
 * generic info/error/warning rendering.
 */
export interface SystemMessageInfo {
  content: string;
  variant: 'info' | 'error' | 'warning';
  source?: string;
  data?: unknown;
  isLatest: boolean;
  onShowContextDetail?: () => void;
}

export interface ChatPanelCustomization {
  /** Extra content appended to a tool header (e.g. a host-specific badge). */
  renderToolHeaderExtra?: ToolHeaderExtraRenderer;
  /** Collapse sub-agent thinking streams to a pinned window. */
  compactThinking?: boolean;
  /** Auto-collapse each completed turn's intermediate steps. */
  collapseCompletedTurns?: boolean;
  /**
   * Host-specific system-message renderer (slash-command panels). Returns the
   * inner node (the panel adds the row wrapper) or `null` to fall through to the
   * generic renderer.
   */
  renderSystemMessage?: (info: SystemMessageInfo) => ReactNode | null;
}

const EMPTY_CUSTOMIZATION: ChatPanelCustomization = {};

export const ChatPanelCustomizationContext =
  createContext<ChatPanelCustomization>(EMPTY_CUSTOMIZATION);

export function useChatPanelCustomization(): ChatPanelCustomization {
  return useContext(ChatPanelCustomizationContext);
}
