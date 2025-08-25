/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import { Config } from '@qwen-code/qwen-code-core';

export interface UsePromptEnhancementProps {
  config: Config;
}

export interface UsePromptEnhancementReturn {
  enhancePrompt: (prompt: string) => Promise<string>;
  isEnhancing: boolean;
  error: string | null;
}

export const usePromptEnhancement = ({
  config,
}: UsePromptEnhancementProps): UsePromptEnhancementReturn => {
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enhancePrompt = useCallback(
    async (prompt: string): Promise<string> => {
      if (!prompt.trim()) {
        return prompt;
      }

      setIsEnhancing(true);
      setError(null);

      try {
        // Get the Gemini client from config
        const client = config.getGeminiClient();

        if (!client || !client.isInitialized()) {
          throw new Error('Gemini client not initialized');
        }

        // Create the enhancement request
        const enhancementPrompt = `Enhance the following prompt to be clearer and more specific while preserving the original intent and request. The prompt should be directly ready to use Like no beginning or ending hello, hi or starting or ending phrases etc. Return only the enhanced version:

Prompt: "${prompt}"`;

        const contents = [
          {
            role: 'user' as const,
            parts: [{ text: enhancementPrompt }],
          },
        ];

        // Generate enhanced prompt using the client
        const response = await client.generateContent(
          contents,
          {
            temperature: 0.3, // Lower temperature for more consistent enhancement
            topP: 0.8,
          },
          new AbortController().signal,
        );

        // Extract the enhanced text from the response
        const enhancedText = response.candidates?.[0]?.content?.parts
          ?.map((part) => ('text' in part ? part.text : ''))
          .join('')
          .trim();

        if (!enhancedText) {
          throw new Error('No enhanced text received from API');
        }

        return enhancedText;
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : 'Unknown error occurred';
        setError(errorMessage);
        console.error('Prompt enhancement failed:', err);
        // Return original prompt if enhancement fails
        return prompt;
      } finally {
        setIsEnhancing(false);
      }
    },
    [config],
  );

  return {
    enhancePrompt,
    isEnhancing,
    error,
  };
};
