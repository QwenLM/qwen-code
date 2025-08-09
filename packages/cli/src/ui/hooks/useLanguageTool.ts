import { useCallback } from 'react';
import {
  preprocessUserInput,
} from '@qwen-code/qwen-code-core/dist/src/integrations/languagetool/preprocess.js';
import type { LTResult } from '@qwen-code/qwen-code-core/dist/src/integrations/languagetool/preprocess.js';
import { promptConfirmOnTty } from '@qwen-code/qwen-code-core/dist/src/ui/promptConfirm.js';
import { DEFAULT_LT_OPTIONS } from '@qwen-code/qwen-code-core/dist/src/config/ltConfig.js';

/**
 * Hook to integrate LanguageTool grammar checking into the user input pipeline.
 */
export const useLanguageTool = () => {
  const processWithLanguageTool = useCallback(
    async (input: string): Promise<string> => {
      try {
        // Process the input with LanguageTool
        const result: LTResult = await preprocessUserInput(
          input,
          DEFAULT_LT_OPTIONS,
          async (orig: string, corrected: string, _matches: any[]) => {
            // Simple confirmation prompt in the terminal
            console.log('\n— LanguageTool sugeriu correções —');
            console.log('Original :', orig);
            console.log('Corrigido:', corrected);
            return await promptConfirmOnTty('Aplicar correções? (y/N) ');
          },
        );

        // Return the corrected text if changes were applied, otherwise return the original
        return result.applied ? result.corrected : result.original;
      } catch (error) {
        // If there's an error with LanguageTool, just return the original input
        // This ensures that the chat continues to work even if LanguageTool is not available
        console.error('Error processing with LanguageTool:', error);
        return input;
      }
    },
    [],
  );

  return { processWithLanguageTool };
};
