/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { t, ta, getCurrentLanguage } from '../../i18n/index.js';
import { getFortuneQuote, DEFAULT_FORTUNE_COMMAND } from './fortune.js';

export const WITTY_LOADING_PHRASES: string[] = ["I'm Feeling Lucky"];

export const PHRASE_CHANGE_INTERVAL_MS = 15000;

/**
 * Select a random phrase from an array.
 */
function selectRandomPhrase<T>(phrases: T[]): T {
  if (!phrases || phrases.length === 0) {
    throw new Error('Phrases array cannot be empty');
  }
  const index = Math.floor(Math.random() * phrases.length);
  return phrases[index];
}

/**
 * Custom hook to manage cycling through loading phrases.
 * Uses fortune command for dynamic quotes instead of static phrases.
 * @param isActive Whether the phrase cycling should be active.
 * @param isWaiting Whether to show a specific waiting phrase.
 * @param customPhrases Optional custom phrases to cycle through.
 * @param enableFortunes Whether to use fortune quotes (default: false).
 * @param fortuneCommand Optional custom fortune command (default: DEFAULT_FORTUNE_COMMAND).
 * @returns The current loading phrase.
 */
export const usePhraseCycler = (
  isActive: boolean,
  isWaiting: boolean,
  customPhrases?: string[],
  enableFortunes: boolean = false,
  fortuneCommand: string = DEFAULT_FORTUNE_COMMAND,
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

      // Use fortune command for dynamic quotes if enabled
      const updatePhrase = async () => {
        const shouldUseFortune = enableFortunes && fortuneCommand?.trim();
        if (shouldUseFortune) {
          const fortuneQuote = await getFortuneQuote(fortuneCommand);
          setCurrentLoadingPhrase(
            fortuneQuote ?? selectRandomPhrase(loadingPhrases),
          );
        } else {
          setCurrentLoadingPhrase(selectRandomPhrase(loadingPhrases));
        }
      };

      // Set initial loading phrase
      updatePhrase().catch(() => {
        setCurrentLoadingPhrase(loadingPhrases[0]);
      });

      phraseIntervalRef.current = setInterval(() => {
        // Update with new loading phrase every interval
        updatePhrase().catch(() => {
          setCurrentLoadingPhrase(loadingPhrases[0]);
        });
      }, PHRASE_CHANGE_INTERVAL_MS);
    } else {
      // Idle or other states, clear the phrase interval
      // and reset to the first phrase for next active state.
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
