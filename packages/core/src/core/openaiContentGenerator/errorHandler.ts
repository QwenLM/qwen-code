/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentParameters } from '@google/genai';

export interface RequestContext {
  userPromptId: string;
  model: string;
  authType: string;
  startTime: number;
  duration: number;
  isStreaming: boolean;
}

export interface ErrorHandler {
  handle(
    error: unknown,
    context: RequestContext,
    request: GenerateContentParameters,
  ): never;
  shouldSuppressErrorLogging(
    error: unknown,
    request: GenerateContentParameters,
  ): boolean;
}

export class EnhancedErrorHandler implements ErrorHandler {
  constructor(
    private shouldSuppressLogging: (
      error: unknown,
      request: GenerateContentParameters,
    ) => boolean = () => false,
  ) {}

  handle(
    error: unknown,
    context: RequestContext,
    request: GenerateContentParameters,
  ): never {
    const isTimeoutError = this.isTimeoutError(error);
    const errorMessage = this.buildErrorMessage(error, context, isTimeoutError);

    // Allow subclasses to suppress error logging for specific scenarios
    if (!this.shouldSuppressErrorLogging(error, request)) {
      const providerName = this.getProviderName(context.authType);
      const logPrefix = context.isStreaming
        ? `${providerName} Streaming Error:`
        : `${providerName} Error:`;
      console.error(logPrefix, errorMessage);
      
      // Print detailed diagnostic information
      const diagnosticInfo = this.buildDiagnosticInfo(error, context);
      if (diagnosticInfo) {
        console.error('\nDiagnostic Information:');
        console.error(diagnosticInfo);
      }
    }

    // Provide helpful timeout-specific error message
    if (isTimeoutError) {
      throw new Error(
        `${errorMessage}\n\n${this.getTimeoutTroubleshootingTips(context)}`,
      );
    }

    throw error;
  }

  private buildDiagnosticInfo(error: unknown, context: RequestContext): string {
    const diagnostics: string[] = [];
    
    // Add context information
    diagnostics.push(`Model: ${context.model}`);
    diagnostics.push(`Auth Type: ${context.authType}`);
    diagnostics.push(`Duration: ${Math.round(context.duration)}ms`);
    
    // Add error details
    if (error instanceof Error) {
      diagnostics.push(`Error Name: ${error.name}`);
      diagnostics.push(`Error Message: ${error.message}`);
      
      // Add stack trace for debugging
      if (error.stack) {
        diagnostics.push(`Stack Trace:\n${error.stack}`);
      }
      
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errorObj = error as any;
      
      // Add HTTP/API specific details
      if (errorObj.status) {
        diagnostics.push(`HTTP Status: ${errorObj.status}`);
      }
      if (errorObj.code) {
        diagnostics.push(`Error Code: ${errorObj.code}`);
      }
      if (errorObj.response) {
        diagnostics.push(`Response Status: ${errorObj.response.status}`);
        if (errorObj.response.statusText) {
          diagnostics.push(`Response Status Text: ${errorObj.response.statusText}`);
        }
        // For Ollama, try to extract response body
        if (context.authType === 'ollama' && errorObj.response.data) {
          try {
            const responseData = typeof errorObj.response.data === 'string' 
              ? JSON.parse(errorObj.response.data)
              : errorObj.response.data;
            diagnostics.push(`Response Body: ${JSON.stringify(responseData, null, 2)}`);
          } catch {
            diagnostics.push(`Response Body: ${errorObj.response.data}`);
          }
        }
      }
    } else if (typeof error === 'string') {
      diagnostics.push(`Error: ${error}`);
    } else if (error instanceof Object) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errorObj = error as any;
      diagnostics.push(`Error Type: ${typeof error}`);
      diagnostics.push(`Error Details: ${JSON.stringify(errorObj, null, 2)}`);
    }
    
    // Add provider-specific troubleshooting tips
    const troubleshootingTips = this.getProviderSpecificTroubleshootingTips(context);
    if (troubleshootingTips) {
      diagnostics.push(`\nTroubleshooting Tips:\n${troubleshootingTips}`);
    }
    
    return diagnostics.join('\n');
  }

  private getProviderSpecificTroubleshootingTips(context: RequestContext): string {
    if (context.authType === 'ollama') {
      return [
        '- Verify Ollama is running: ollama serve',
        '- Check Ollama base URL is correct in settings (default: http://localhost:11434)',
        '- Verify the model exists: ollama list',
        '- Try a simple test: ollama run <model-name>',
        '- Check Ollama logs for more details',
        '- Ensure Ollama API endpoint is accessible from this machine',
      ].join('\n');
    }
    return '';
  }

  private getProviderName(authType: string): string {
    switch (authType) {
      case 'openai':
        return 'OpenAI API';
      case 'ollama':
        return 'Ollama API';
      case 'anthropic':
        return 'Anthropic API';
      case 'gemini':
        return 'Gemini API';
      case 'vertex-ai':
        return 'Vertex AI API';
      case 'qwen-oauth':
        return 'Qwen API';
      default:
        return 'OpenAI-compatible API';
    }
  }

  shouldSuppressErrorLogging(
    error: unknown,
    request: GenerateContentParameters,
  ): boolean {
    return this.shouldSuppressLogging(error, request);
  }

  private isTimeoutError(error: unknown): boolean {
    if (!error) return false;

    const errorMessage =
      error instanceof Error
        ? error.message.toLowerCase()
        : String(error).toLowerCase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errorCode = (error as any)?.code;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errorType = (error as any)?.type;

    // Check for common timeout indicators
    return (
      errorMessage.includes('timeout') ||
      errorMessage.includes('timed out') ||
      errorMessage.includes('connection timeout') ||
      errorMessage.includes('request timeout') ||
      errorMessage.includes('read timeout') ||
      errorMessage.includes('etimedout') ||
      errorMessage.includes('esockettimedout') ||
      errorCode === 'ETIMEDOUT' ||
      errorCode === 'ESOCKETTIMEDOUT' ||
      errorType === 'timeout' ||
      errorMessage.includes('request timed out') ||
      errorMessage.includes('deadline exceeded')
    );
  }

  private buildErrorMessage(
    error: unknown,
    context: RequestContext,
    isTimeoutError: boolean,
  ): string {
    const durationSeconds = Math.round(context.duration / 1000);

    if (isTimeoutError) {
      const prefix = context.isStreaming
        ? 'Streaming request timeout'
        : 'Request timeout';
      return `${prefix} after ${durationSeconds}s. Try reducing input length or increasing timeout in config.`;
    }

    return error instanceof Error ? error.message : String(error);
  }

  private getTimeoutTroubleshootingTips(context: RequestContext): string {
    const baseTitle = context.isStreaming
      ? 'Streaming timeout troubleshooting:'
      : 'Troubleshooting tips:';

    const baseTips = [
      '- Reduce input length or complexity',
      '- Increase timeout in config: contentGenerator.timeout',
      '- Check network connectivity',
    ];

    const streamingSpecificTips = context.isStreaming
      ? [
          '- Check network stability for streaming connections',
          '- Consider using non-streaming mode for very long inputs',
        ]
      : ['- Consider using streaming mode for long responses'];

    return `${baseTitle}\n${[...baseTips, ...streamingSpecificTips].join('\n')}`;
  }
}
