/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ChatLaunchConfig {
  kind: 'chat';
  daemonBaseUrl: string;
  daemonToken: string;
  desktopVersion: string;
  windowId: number;
  workspace: string;
}

export interface BrowserLaunchConfig {
  kind: 'browser';
  desktopVersion: string;
  windowId: number;
}

export interface VoiceOverlayLaunchConfig {
  kind: 'voice-overlay';
  desktopVersion: string;
  windowId: number;
}

export type DesktopLaunchConfig =
  | ChatLaunchConfig
  | BrowserLaunchConfig
  | VoiceOverlayLaunchConfig;

export interface DesktopBrowserState {
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  title: string;
  url: string;
}

export type DesktopLiveState =
  | 'unavailable'
  | 'idle'
  | 'starting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'stopping'
  | 'error';

export interface DesktopLiveStatus {
  v: 1;
  available: boolean;
  state: DesktopLiveState;
  shortcut: string;
  blocker?: string;
  message?: string;
  callId?: string;
  inputMuted?: boolean;
  outputMuted?: boolean;
  transcript?: string;
  caption?: string;
  statusText?: string;
}

export interface QwenDesktopBridge {
  getLaunchConfig(): Promise<DesktopLaunchConfig>;
  newChatWindow(): Promise<void>;
  openBrowser(url?: string): Promise<void>;
  getBrowserState(): Promise<DesktopBrowserState>;
  navigateBrowser(url: string): Promise<DesktopBrowserState>;
  goBackBrowser(): Promise<void>;
  goForwardBrowser(): Promise<void>;
  reloadBrowser(): Promise<void>;
  onBrowserState(listener: (state: DesktopBrowserState) => void): () => void;
  showVoiceOverlay(): Promise<void>;
  closeVoiceOverlay(): Promise<void>;
  getLiveStatus(): Promise<DesktopLiveStatus>;
  startLive(mode?: 'resume' | 'new'): Promise<DesktopLiveStatus>;
  stopLive(): Promise<DesktopLiveStatus>;
  setLiveMute(update: {
    inputMuted?: boolean;
    outputMuted?: boolean;
  }): Promise<DesktopLiveStatus>;
}
