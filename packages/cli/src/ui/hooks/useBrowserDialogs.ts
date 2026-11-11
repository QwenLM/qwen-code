/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useState } from 'react';
import type {
  ConfigLoadError,
  HookRegistryEntry,
} from '@qwen-code/core';
import type { SkillDisplayInfo } from '../components/SkillBrowser.js';

export interface UseBrowserDialogsReturn {
  // Skill browser + detail view
  isSkillBrowserOpen: boolean;
  isSkillDetailViewOpen: boolean;
  selectedSkillInfo: SkillDisplayInfo | undefined;
  openSkillBrowser: () => void;
  closeSkillBrowser: () => void;
  openSkillDetailView: (skill: SkillDisplayInfo) => void;
  closeSkillDetailView: () => void;

  // Plugin browser
  isPluginBrowserOpen: boolean;
  pluginBrowserArgs: string | undefined;
  openPluginBrowser: (args?: string) => void;
  closePluginBrowser: () => void;

  // Config error detail
  isConfigErrorDetailOpen: boolean;
  selectedConfigError: ConfigLoadError | undefined;
  configErrorLabel: string | undefined;
  openConfigErrorDetail: (error: ConfigLoadError, label: string) => void;
  closeConfigErrorDetail: () => void;

  // Hook browser + config
  isHookBrowserOpen: boolean;
  isHookConfigDialogOpen: boolean;
  selectedHookEntry: HookRegistryEntry | undefined;
  openHookBrowser: () => void;
  closeHookBrowser: () => void;
  openHookConfigDialog: (entry: HookRegistryEntry) => void;
  closeHookConfigDialog: () => void;

  // MCP browser
  isMcpBrowserOpen: boolean;
  openMcpBrowser: () => void;
  closeMcpBrowser: () => void;
}

/**
 * Bundles the inline browser/detail dialog state that doesn't have its own
 * specialized hook (skills, plugins, config-error, hooks, MCP). Each entry
 * is independent — extracting them together keeps the AppContainer body
 * shorter without coupling them to each other.
 */
export function useBrowserDialogs(): UseBrowserDialogsReturn {
  const [isSkillBrowserOpen, setIsSkillBrowserOpen] = useState(false);
  const [isSkillDetailViewOpen, setIsSkillDetailViewOpen] = useState(false);
  const [selectedSkillInfo, setSelectedSkillInfo] = useState<
    SkillDisplayInfo | undefined
  >();

  const openSkillBrowser = useCallback(() => setIsSkillBrowserOpen(true), []);
  const closeSkillBrowser = useCallback(() => setIsSkillBrowserOpen(false), []);
  const openSkillDetailView = useCallback((skill: SkillDisplayInfo) => {
    setSelectedSkillInfo(skill);
    setIsSkillDetailViewOpen(true);
  }, []);
  const closeSkillDetailView = useCallback(() => {
    setIsSkillDetailViewOpen(false);
    setSelectedSkillInfo(undefined);
  }, []);

  const [isPluginBrowserOpen, setIsPluginBrowserOpen] = useState(false);
  const [pluginBrowserArgs, setPluginBrowserArgs] = useState<
    string | undefined
  >();
  const openPluginBrowser = useCallback((args?: string) => {
    setPluginBrowserArgs(args);
    setIsPluginBrowserOpen(true);
  }, []);
  const closePluginBrowser = useCallback(() => {
    setIsPluginBrowserOpen(false);
    setPluginBrowserArgs(undefined);
  }, []);

  const [isConfigErrorDetailOpen, setIsConfigErrorDetailOpen] = useState(false);
  const [selectedConfigError, setSelectedConfigError] = useState<
    ConfigLoadError | undefined
  >();
  const [configErrorLabel, setConfigErrorLabel] = useState<
    string | undefined
  >();
  const openConfigErrorDetail = useCallback(
    (error: ConfigLoadError, label: string) => {
      setSelectedConfigError(error);
      setConfigErrorLabel(label);
      setIsConfigErrorDetailOpen(true);
    },
    [],
  );
  const closeConfigErrorDetail = useCallback(() => {
    setIsConfigErrorDetailOpen(false);
    setSelectedConfigError(undefined);
    setConfigErrorLabel(undefined);
  }, []);

  const [isHookBrowserOpen, setIsHookBrowserOpen] = useState(false);
  const [isHookConfigDialogOpen, setIsHookConfigDialogOpen] = useState(false);
  const [selectedHookEntry, setSelectedHookEntry] = useState<
    HookRegistryEntry | undefined
  >();
  const openHookBrowser = useCallback(() => setIsHookBrowserOpen(true), []);
  const closeHookBrowser = useCallback(() => {
    setIsHookBrowserOpen(false);
    setIsHookConfigDialogOpen(false);
    setSelectedHookEntry(undefined);
  }, []);
  const openHookConfigDialog = useCallback((entry: HookRegistryEntry) => {
    setSelectedHookEntry(entry);
    setIsHookConfigDialogOpen(true);
  }, []);
  const closeHookConfigDialog = useCallback(() => {
    setIsHookConfigDialogOpen(false);
    setSelectedHookEntry(undefined);
  }, []);

  const [isMcpBrowserOpen, setIsMcpBrowserOpen] = useState(false);
  const openMcpBrowser = useCallback(() => setIsMcpBrowserOpen(true), []);
  const closeMcpBrowser = useCallback(() => setIsMcpBrowserOpen(false), []);

  return {
    isSkillBrowserOpen,
    isSkillDetailViewOpen,
    selectedSkillInfo,
    openSkillBrowser,
    closeSkillBrowser,
    openSkillDetailView,
    closeSkillDetailView,

    isPluginBrowserOpen,
    pluginBrowserArgs,
    openPluginBrowser,
    closePluginBrowser,

    isConfigErrorDetailOpen,
    selectedConfigError,
    configErrorLabel,
    openConfigErrorDetail,
    closeConfigErrorDetail,

    isHookBrowserOpen,
    isHookConfigDialogOpen,
    selectedHookEntry,
    openHookBrowser,
    closeHookBrowser,
    openHookConfigDialog,
    closeHookConfigDialog,

    isMcpBrowserOpen,
    openMcpBrowser,
    closeMcpBrowser,
  };
}
