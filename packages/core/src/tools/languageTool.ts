import {
  checkText,
  applySuggestions,
} from '../integrations/languagetool/ltClient.js';
import { DEFAULT_LT_OPTIONS } from '../config/ltConfig.js';
import { BaseTool, Icon, ToolResult } from './tools.js';
import { Type } from '@google/genai';

export interface LanguageToolParams {
  text: string;
  language?: string;
  policy?: 'first' | 'best' | 'none';
  rulesOn?: string[];
  rulesOff?: string[];
  level?: 'default' | 'picky';
}

export class LanguageToolTool extends BaseTool<LanguageToolParams, ToolResult> {
  static readonly Name: string = 'language_tool_check';

  constructor() {
    super(
      LanguageToolTool.Name,
      'LanguageTool Check',
      'Verifica e corrige erros de gramática em textos usando o LanguageTool',
      Icon.Pencil,
      {
        type: Type.OBJECT,
        properties: {
          text: {
            type: Type.STRING,
            description:
              'Texto a ser verificado/corrigido pela ferramenta LanguageTool.',
          },
          language: {
            type: Type.STRING,
            description:
              'Código do idioma (ex: pt-BR, en-US). Se não especificado, usa o idioma padrão.',
          },
          policy: {
            type: Type.STRING,
            description:
              'Política de correção: first (primeira sugestão), best (melhor sugestão) ou none (apenas verificar).',
            enum: ['first', 'best', 'none'],
          },
          rulesOn: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Lista de regras do LanguageTool a serem habilitadas.',
          },
          rulesOff: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Lista de regras do LanguageTool a serem desabilitadas.',
          },
          level: {
            type: Type.STRING,
            description: 'Nível de verificação: default ou picky (mais rigoroso).',
            enum: ['default', 'picky'],
          },
        },
        required: ['text'],
      },
    );
  }

  validateToolParams(params: LanguageToolParams): string | null {
    if (typeof params !== 'object' || params === null || !('text' in params) || typeof (params as any).text !== 'string' || !(params as any).text.trim()) {
      return 'Parâmetro "text" é obrigatório e não pode estar vazio.';
    }
    return null;
  }

  async execute(params: LanguageToolParams, _signal: AbortSignal, _updateOutput?: (output: string) => void): Promise<ToolResult> {
    try {
      const server = DEFAULT_LT_OPTIONS.server;
      const language = params.language || DEFAULT_LT_OPTIONS.language;
      const level = params.level || DEFAULT_LT_OPTIONS.level || 'default';

      const res = await checkText({
        server,
        text: params.text,
        language,
        motherTongue: DEFAULT_LT_OPTIONS.motherTongue,
        enabledRules: params.rulesOn || DEFAULT_LT_OPTIONS.rulesOn,
        disabledRules: params.rulesOff || DEFAULT_LT_OPTIONS.rulesOff,
        level,
      });

      let corrected = params.text;
      let changes = 0;
      const policy = params.policy || 'first';

      if (policy !== 'none') {
        const strat = policy === 'best' ? 'best' : 'first';
        const ap = applySuggestions(params.text, res.matches ?? [], strat);
        corrected = ap.text;
        changes = ap.changes;
      }

      const output = {
        original: params.text,
        corrected,
        changes,
        matches: res.matches ?? [],
        language,
        policy,
      };

      return {
        llmContent: JSON.stringify(output, null, 2),
        returnDisplay: JSON.stringify(output, null, 2),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Erro ao verificar o texto: ${errorMessage}`,
        returnDisplay: `Erro ao verificar o texto: ${errorMessage}`,
      };
    }
  }
}
