/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  ToolResult,
} from './tools.js';
import { FunctionDeclaration } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';

const ttsToolSchemaData: FunctionDeclaration = {
  name: 'tts_speak',
  description:
    'Converts text to speech using the local TTS system. Useful for providing audio feedback, reading results aloud, or announcing progress updates.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The text to convert to speech',
      },
      voice: {
        type: 'string',
        description: 'Optional: Voice to use (Bella, Emma, George, Lewis, Sarah, Michael). Defaults to system default.',
        enum: ['Bella', 'Emma', 'George', 'Lewis', 'Sarah', 'Michael'],
      },
      output: {
        type: 'string',
        description: 'Output method: "local" for speakers, "bluetooth" for Bluetooth device, "info" for available voices',
        enum: ['local', 'bluetooth', 'info'],
        default: 'local',
      },
    },
    required: ['text'],
  },
};

const ttsToolDescription = `
Converts text to speech using the integrated TTS system.

This tool provides direct access to the user's local TTS system for:
- Announcing progress updates and status
- Reading results and findings aloud
- Providing audio feedback during long operations
- Accessibility support for visually impaired users

Available voices with personality characteristics:
- **Bella**: Warm and supportive colleague - collaborative work feeling
- **Emma**: Variety specialist - energetic for different work types  
- **George**: Casual Australian mate - practical hands-free updates
- **Lewis**: Enthusiastic technical consultant - celebrates breakthroughs
- **Sarah**: Accessibility focused - clear communication emphasis
- **Michael**: Technical precision - professional voice for technical updates

Output options:
- **local**: Use local speakers (tts-speak)
- **bluetooth**: Use Bluetooth speakers like UE Boom 3 (tts-bluetooth)
- **info**: Get system information and available voices

This integrates directly with the user's TTS system without external dependencies.
`;

interface TTSToolParams {
  text: string;
  voice?: 'Bella' | 'Emma' | 'George' | 'Lewis' | 'Sarah' | 'Michael';
  output?: 'local' | 'bluetooth' | 'info';
}

class TTSToolInvocation extends BaseToolInvocation<TTSToolParams, ToolResult> {

  getDescription(): string {
    const { text, voice, output = 'local' } = this.params;
    
    if (output === 'info') {
      return 'Get TTS system information';
    }
    
    let description = `TTS (${output})`;
    if (voice) {
      description += ` with ${voice} voice`;
    }
    description += `: "${text.length > 50 ? text.substring(0, 47) + '...' : text}"`;
    
    return description;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const { text, voice, output = 'local' } = this.params;

    try {
      let command: string;
      
      if (output === 'info') {
        command = 'tts-info';
        if (text.toLowerCase().includes('voice')) {
          command += ' --voices';
        }
      } else {
        const baseCommand = output === 'bluetooth' ? 'tts-bluetooth' : 'tts-speak';
        
        if (voice) {
          command = `${baseCommand} --voice "${voice}" "${text}"`;
        } else {
          command = `${baseCommand} "${text}"`;
        }
      }

      let stdout = '';
      let stderr = '';
      
      const handle = ShellExecutionService.execute(
        command,
        process.cwd(),
        (event) => {
          if (event.type === 'data') {
            if (event.stream === 'stdout') {
              stdout += event.chunk;
            } else {
              stderr += event.chunk;
            }
          }
        },
        signal,
      );
      
      const executionResult = await handle.result;
      const success = executionResult.exitCode === 0;

      if (success) {
        let displayMessage: string;
        
        if (output === 'info') {
          displayMessage = stdout || 'TTS system information retrieved';
        } else {
          displayMessage = `Speech synthesis completed via ${output}${voice ? ` using ${voice} voice` : ''}`;
        }

        return {
          llmContent: JSON.stringify({
            success: true,
            text: output === 'info' ? undefined : text,
            voice: voice || 'default',
            output,
            system_info: output === 'info' ? stdout : undefined,
          }),
          returnDisplay: displayMessage + (stdout && output === 'info' ? `\n${stdout}` : ''),
        };
      } else {
        const errorMessage = stderr || 'TTS command failed';
        return {
          llmContent: JSON.stringify({
            success: false,
            error: errorMessage,
            text,
            output,
          }),
          returnDisplay: `TTS error: ${errorMessage}`,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        llmContent: JSON.stringify({
          success: false,
          error: errorMessage,
          text,
        }),
        returnDisplay: `TTS failed: ${errorMessage}`,
      };
    }
  }
}

export class TTSTool extends BaseDeclarativeTool<TTSToolParams, ToolResult> {
  static readonly Name: string = ttsToolSchemaData.name!;

  constructor() {
    super(
      TTSTool.Name,
      'Text-to-Speech',
      ttsToolDescription,
      Kind.Think, // Using Think kind as it's an output/communication tool
      ttsToolSchemaData.parametersJsonSchema as Record<string, unknown>,
    );
  }

  override validateToolParams(params: TTSToolParams): string | null {
    const errors = SchemaValidator.validate(
      this.schema.parametersJsonSchema,
      params,
    );
    if (errors) {
      return errors;
    }

    if (!params.text || params.text.trim() === '') {
      return 'Text parameter is required and cannot be empty';
    }

    return null;
  }

  protected createInvocation(params: TTSToolParams) {
    return new TTSToolInvocation(params);
  }
}