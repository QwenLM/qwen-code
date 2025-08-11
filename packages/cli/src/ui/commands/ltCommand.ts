/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { SlashCommand, CommandKind } from './types.js';

export const ltCommand: SlashCommand = {
  name: 'lt',
  description: 'Verifica e corrige erros de gramática usando o LanguageTool',
  kind: CommandKind.BUILT_IN,
  action: async (_context, args) => {
    if (!args.trim()) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Uso: /lt <texto para verificar>',
      };
    }

    // Como não temos acesso ao LanguageTool neste contexto, apenas retornamos uma mensagem
    // Em uma implementação completa, aqui chamaria o LanguageTool para verificar e corrigir o texto
    return {
      type: 'message',
      messageType: 'info',
      content: `Texto recebido para verificação: "${args}"

LanguageTool não está disponível neste contexto.`,
    };
  },
};