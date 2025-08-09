/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { SlashCommand, CommandKind } from './types.js';
import {
  checkText,
  applySuggestions,
} from '@qwen-code/qwen-code-core/dist/src/integrations/languagetool/ltClient.js';
import { DEFAULT_LT_OPTIONS } from '@qwen-code/qwen-code-core/dist/src/config/ltConfig.js';

export const ltCommand: SlashCommand = {
  name: 'lt',
  description: 'Verifica e corrige erros de gramática usando o LanguageTool',
  kind: CommandKind.BUILT_IN,
  action: async (context, args) => {
    if (!args.trim()) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Uso: /lt <texto para verificar>',
      };
    }

    try {
      // Verifica o texto com o LanguageTool
      const res = await checkText({
        server: DEFAULT_LT_OPTIONS.server,
        text: args,
        language: DEFAULT_LT_OPTIONS.language,
        motherTongue: DEFAULT_LT_OPTIONS.motherTongue,
        enabledRules: DEFAULT_LT_OPTIONS.rulesOn,
        disabledRules: DEFAULT_LT_OPTIONS.rulesOff,
        level: DEFAULT_LT_OPTIONS.level || 'default',
      });

      // Aplica as sugestões de correção
      const applied = applySuggestions(args, res.matches || [], 'first');

      // Mostra os resultados
      let output = '— Correções sugeridas —\n';
      if (applied.changes > 0) {
        output += `Original : ${args}\n`;
        output += `Corrigido: ${applied.text}\n\n`;

        // Mostra detalhes das correções
        if (res.matches && res.matches.length > 0) {
          output += 'Detalhes:\n';
          res.matches.forEach((match: any, index: number) => {
            output += `${index + 1}. ${match.message}\n`;
            if (match.replacements && match.replacements.length > 0) {
              const suggestions = match.replacements
                .slice(0, 3)
                .map((r: any) => r.value)
                .join(', ');
              output += `   Sugestões: ${suggestions}\n`;
            }
            if (match.rule?.id) {
              output += `   Regra: ${match.rule.id}\n`;
            }
            output += '\n';
          });
        }
      } else {
        output += 'Nenhum erro encontrado. O texto está correto!\n';
      }

      return {
        type: 'message',
        messageType: 'info',
        content: output,
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Erro ao verificar o texto: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};