/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react';
import { WITTY_LOADING_PHRASES } from '../constants/wittyPhrases.js';
import type { UiLocale } from '@qwen-code/core';
import { useI18nService } from '../i18n/I18nServiceContext.js';
import {
  getLocalizedInformativeTip,
  INFORMATIVE_TIP_CATALOG,
  type InformativeTipId,
} from '../i18n/informativeTips.js';
import { stringWidth } from '../../ink/stringWidth.js';

export const PHRASE_CHANGE_INTERVAL_MS = 10000;
export const WITTY_PHRASE_CHANGE_INTERVAL_MS = 5000;
const NO_ADDITIONAL_TIPS: readonly string[] = Object.freeze([]);

type TipSelection =
  | { kind: 'builtin'; id: InformativeTipId }
  | { kind: 'raw'; text: string };

const getTipSelectionWidth = (selection: TipSelection): number => {
  if (selection.kind === 'raw') return stringWidth(selection.text);
  return Math.max(
    stringWidth(getLocalizedInformativeTip('en', selection.id) ?? ''),
    stringWidth(getLocalizedInformativeTip('zh-CN', selection.id) ?? ''),
  );
};

const fitsMaxLength = (text: string, maxLength?: number): boolean =>
  maxLength === undefined || stringWidth(text) <= maxLength;
/**
 * Custom hook to manage cycling through loading phrases.
 * @param isActive Whether the phrase cycling should be active.
 * @param isWaiting Whether to show a specific waiting phrase.
 * @param showTips Whether to show informative tips.
 * @param showWit Whether to show witty phrases.
 * @param customPhrases Optional list of custom phrases to use instead of built-in witty phrases.
 * @param maxLength Optional maximum length for the selected phrase.
 * @param additionalTips Optional context-specific tips to include in the existing rotation.
 * @returns The current loading phrase.
 */
export const usePhraseCycler = (
  isActive: boolean,
  isWaiting: boolean,
  showTips: boolean = true,
  showWit: boolean = true,
  customPhrases?: string[],
  maxLength?: number,
  additionalTips: readonly string[] = NO_ADDITIONAL_TIPS,
  locale: UiLocale = 'en',
) => {
  const i18n = useI18nService();
  const [currentTipState, setCurrentTipState] = useState<
    TipSelection | undefined
  >(undefined);
  const [currentWittyPhraseState, setCurrentWittyPhraseState] = useState<
    string | undefined
  >(undefined);

  const tipIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const wittyIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastTipChangeTimeRef = useRef<number>(0);
  const lastWittyChangeTimeRef = useRef<number>(0);
  const lastSelectedTipRef = useRef<TipSelection | undefined>(undefined);
  const lastSelectedWittyPhraseRef = useRef<string | undefined>(undefined);
  const MIN_TIP_DISPLAY_TIME_MS = 10000;
  const MIN_WIT_DISPLAY_TIME_MS = 5000;

  useEffect(() => {
    // Always clear on re-run
    const clearTimers = () => {
      if (tipIntervalRef.current) {
        clearInterval(tipIntervalRef.current);
        tipIntervalRef.current = null;
      }
      if (wittyIntervalRef.current) {
        clearInterval(wittyIntervalRef.current);
        wittyIntervalRef.current = null;
      }
    };

    clearTimers();

    if (isWaiting) {
      // These are handled by the return value directly for immediate feedback
      return clearTimers;
    }

    if (!isActive || (!showTips && !showWit)) {
      return clearTimers;
    }

    const wittyPhrasesList =
      customPhrases && customPhrases.length > 0
        ? customPhrases
        : WITTY_LOADING_PHRASES;

    const setRandomTip = (force: boolean = false) => {
      if (!showTips) {
        setCurrentTipState(undefined);
        lastSelectedTipRef.current = undefined;
        return;
      }

      const now = Date.now();
      if (
        !force &&
        now - lastTipChangeTimeRef.current < MIN_TIP_DISPLAY_TIME_MS &&
        lastSelectedTipRef.current &&
        (maxLength === undefined ||
          getTipSelectionWidth(lastSelectedTipRef.current) <= maxLength)
      ) {
        setCurrentTipState(lastSelectedTipRef.current);
        return;
      }

      const availableTips = [
        ...INFORMATIVE_TIP_CATALOG.map(({ id }) => ({
          selection: { kind: 'builtin' as const, id },
          text: getLocalizedInformativeTip(locale, id) ?? '',
        })),
        ...additionalTips.map((text) => ({
          selection: { kind: 'raw' as const, text },
          text,
        })),
      ];
      const filteredTips =
        maxLength !== undefined
          ? availableTips.filter(
              ({ selection }) => getTipSelectionWidth(selection) <= maxLength,
            )
          : availableTips;

      if (filteredTips.length > 0) {
        // codeql[js/insecure-randomness] false positive: used for non-sensitive UI flavor text (tips)
        const selectedOption =
          filteredTips[Math.floor(Math.random() * filteredTips.length)];
        const selected = selectedOption.selection;
        setCurrentTipState(selected);
        lastSelectedTipRef.current = selected;
        lastTipChangeTimeRef.current = now;
      } else {
        setCurrentTipState(undefined);
        lastSelectedTipRef.current = undefined;
      }
    };

    const setRandomWitty = (force: boolean = false) => {
      if (!showWit) {
        setCurrentWittyPhraseState(undefined);
        lastSelectedWittyPhraseRef.current = undefined;
        return;
      }

      const now = Date.now();
      if (
        !force &&
        now - lastWittyChangeTimeRef.current < MIN_WIT_DISPLAY_TIME_MS &&
        lastSelectedWittyPhraseRef.current &&
        fitsMaxLength(lastSelectedWittyPhraseRef.current, maxLength)
      ) {
        setCurrentWittyPhraseState(lastSelectedWittyPhraseRef.current);
        return;
      }

      const filteredWitty =
        maxLength !== undefined
          ? wittyPhrasesList.filter((phrase) =>
              fitsMaxLength(phrase, maxLength),
            )
          : wittyPhrasesList;

      if (filteredWitty.length > 0) {
        // codeql[js/insecure-randomness] false positive: used for non-sensitive UI flavor text (witty phrases)
        const selected =
          filteredWitty[Math.floor(Math.random() * filteredWitty.length)];
        setCurrentWittyPhraseState(selected);
        lastSelectedWittyPhraseRef.current = selected;
        lastWittyChangeTimeRef.current = now;
      } else {
        setCurrentWittyPhraseState(undefined);
        lastSelectedWittyPhraseRef.current = undefined;
      }
    };

    // Select initial random phrases or resume previous ones
    setRandomTip(false);
    setRandomWitty(false);

    if (showTips) {
      tipIntervalRef.current = setInterval(() => {
        setRandomTip(true);
      }, PHRASE_CHANGE_INTERVAL_MS);
    }

    if (showWit) {
      wittyIntervalRef.current = setInterval(() => {
        setRandomWitty(true);
      }, WITTY_PHRASE_CHANGE_INTERVAL_MS);
    }

    return clearTimers;
  }, [
    isActive,
    isWaiting,
    showTips,
    showWit,
    customPhrases,
    maxLength,
    additionalTips,
    locale,
  ]);

  let currentTip = undefined;
  let currentWittyPhrase = undefined;

  if (isWaiting) {
    currentTip = i18n.get('status.waitingForConfirmation');
  } else if (isActive) {
    currentTip =
      currentTipState?.kind === 'builtin'
        ? getLocalizedInformativeTip(locale, currentTipState.id)
        : currentTipState?.text;
    currentWittyPhrase = currentWittyPhraseState;
  }

  return { currentTip, currentWittyPhrase };
};
