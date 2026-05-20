/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { t, ta, getCurrentLanguage } from '../../i18n/index.js';
import { getFortuneQuote } from './fortune.js';
import { selectRandomPhrase } from './phraseSelector.js';

export const WITTY_LOADING_PHRASES: string[] = ["I'm Feeling Lucky"];

export const PHRASE_CHANGE_INTERVAL_MS = 15000;

/**
 * Custom hook to manage cycling through loading phrases.
 * Uses fortune command for dynamic quotes instead of static phrases.
 * @param isActive Whether the phrase cycling should be active.
 * @param isWaiting Whether to show a specific waiting phrase.
 * @param customPhrases Optional custom phrases to cycle through.
 * @param enableFortunes Whether to use fortune quotes (default: false).
 * @param fortuneCommand Optional custom fortune command (default: '/usr/games/fortune -s -n 45').
 * @returns The current loading phrase.
 */
export const usePhraseCycler = (
  isActive: boolean,
  isWaiting: boolean,
  customPhrases?: string[],
  enableFortunes: boolean = false,
  fortuneCommand: string = '/usr/games/fortune -s -n 45',
) => {
  // Get phrases from translations if available
  const currentLanguage = getCurrentLanguage();
  const loadingPhrases = useMemo(() => {
    if (customPhrases && customPhrases.length > 0) {
      return customPhrases;
    }
    const translatedPhrases = ta('WITTY_LOADING_PHRASES');
    return translatedPhrases.length > 0
      ? translatedPhrases
      : WITTY_LOADING_PHRASES;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customPhrases, currentLanguage]);

  const [currentLoadingPhrase, setCurrentLoadingPhrase] = useState(
    loadingPhrases[0],
  );
  const phraseIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (isWaiting) {
      setCurrentLoadingPhrase(t('Waiting for user confirmation...'));
      if (phraseIntervalRef.current) {
        clearInterval(phraseIntervalRef.current);
        phraseIntervalRef.current = null;
      }
    } else if (isActive) {
      if (phraseIntervalRef.current) {
        clearInterval(phraseIntervalRef.current);
      }

      const updatePhrase = async () => {
        const hasFortuneCommand = enableFortunes && fortuneCommand?.trim();
        if (hasFortuneCommand) {
          const fortuneQuote = await getFortuneQuote(fortuneCommand);
          setCurrentLoadingPhrase(
            fortuneQuote ?? selectRandomPhrase(loadingPhrases),
          );
        } else {
          setCurrentLoadingPhrase(selectRandomPhrase(loadingPhrases));
        }
      };

      updatePhrase();
      phraseIntervalRef.current = setInterval(
        updatePhrase,
        PHRASE_CHANGE_INTERVAL_MS,
      );
    } else {
      if (phraseIntervalRef.current) {
        clearInterval(phraseIntervalRef.current);
        phraseIntervalRef.current = null;
      }
      setCurrentLoadingPhrase(loadingPhrases[0]);
    }

    return () => {
      if (phraseIntervalRef.current) {
        clearInterval(phraseIntervalRef.current);
        phraseIntervalRef.current = null;
      }
    };
  }, [isActive, isWaiting, loadingPhrases, enableFortunes, fortuneCommand]);

  return currentLoadingPhrase;
};
