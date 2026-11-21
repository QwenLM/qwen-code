/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AuthClient } from 'google-auth-library';
import * as readline from 'node:readline';
import { Readable } from 'node:stream';
import type {
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../core/contentGenerator.js';
import type { Config } from '../config/config.js';
import {
  reportLlmChunk,
  reportLlmRequest,
  reportLlmResponse,
} from '../telemetry/gen-ai-request.js';
import { markRequestDispatched } from '../core/loggingContentGenerator/request-dispatch.js';
import type {
  LoadCodeAssistRequest,
  LoadCodeAssistResponse,
  LongRunningOperationResponse,
  OnboardUserRequest,
} from './types.js';
import {
  fromGenerateContentResponse,
  toGenerateContentRequest,
  type CaGenerateContentResponse,
} from './converter.js';

import { CODE_ASSIST_API_VERSION, CODE_ASSIST_ENDPOINT } from './constants.js';

export interface HttpOptions {
  headers?: Record<string, string>;
}

export { CODE_ASSIST_API_VERSION, CODE_ASSIST_ENDPOINT };

export class CodeAssistServer implements ContentGenerator {
  constructor(
    readonly client: AuthClient,
    readonly projectId?: string,
    readonly httpOptions: HttpOptions = {},
    readonly config?: Config,
    readonly sessionId?: string,
    readonly samplingParams?: ContentGeneratorConfig['samplingParams'],
  ) {}

  getEffectiveSessionId(): string | undefined {
    return this.config?.getSessionId() ?? this.sessionId;
  }

  async generateContent(
    req: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    const telemetryAttempt = reportLlmRequest(req);
    const response = await this.requestPost<CaGenerateContentResponse>(
      'generateContent',
      await toGenerateContentRequest(
        req,
        userPromptId,
        this.projectId,
        this.getEffectiveSessionId(),
        this.samplingParams,
      ),
      req.config?.abortSignal,
      req.config?.httpOptions?.timeout,
      true,
    );
    const translatedResponse = fromGenerateContentResponse(response);
    reportLlmResponse(telemetryAttempt, translatedResponse);
    return translatedResponse;
  }

  async generateContentStream(
    req: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const telemetryAttempt = reportLlmRequest(req);
    const responses =
      await this.requestStreamingPost<CaGenerateContentResponse>(
        'streamGenerateContent',
        await toGenerateContentRequest(
          req,
          userPromptId,
          this.projectId,
          this.getEffectiveSessionId(),
          this.samplingParams,
        ),
        req.config?.abortSignal,
        req.config?.httpOptions?.timeout,
      );

    const mapped: AsyncGenerator<GenerateContentResponse, void, unknown> = {
      next: async (): Promise<
        IteratorResult<GenerateContentResponse, void>
      > => {
        const result = await responses.next();
        if (result.done) return { done: true, value: undefined };
        const translatedResponse = fromGenerateContentResponse(result.value);
        reportLlmChunk(telemetryAttempt, translatedResponse);
        return { done: false, value: translatedResponse };
      },
      return: async (_value: void | PromiseLike<void>) => {
        await responses.return(undefined);
        return { done: true, value: undefined };
      },
      throw: async (error?: unknown) => {
        await responses.throw(error);
        throw error;
      },
      [Symbol.asyncIterator]() {
        return mapped;
      },
    };
    return mapped;
  }

  async embedContent(
    _req: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    throw new Error('Code Assist does not support embedContent.');
  }

  async onboardUser(
    req: OnboardUserRequest,
    signal?: AbortSignal,
  ): Promise<LongRunningOperationResponse> {
    return this.requestPost<LongRunningOperationResponse>(
      'onboardUser',
      req,
      signal,
    );
  }

  async getOperation(
    name: string,
    signal?: AbortSignal,
  ): Promise<LongRunningOperationResponse> {
    return this.makeGetRequest<LongRunningOperationResponse>(
      this.getOperationUrl(name),
      signal,
    );
  }

  async loadCodeAssist(
    req: LoadCodeAssistRequest,
    signal?: AbortSignal,
  ): Promise<LoadCodeAssistResponse> {
    return this.requestPost<LoadCodeAssistResponse>(
      'loadCodeAssist',
      req,
      signal,
    );
  }

  async requestPost<T>(
    method: string,
    req: object,
    signal?: AbortSignal,
    timeout?: number,
    trackDispatch = false,
  ): Promise<T> {
    const body = JSON.stringify(req);
    if (trackDispatch) markRequestDispatched();
    const res = await this.client.request<T>({
      url: this.getMethodUrl(method),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.httpOptions.headers,
      },
      responseType: 'json',
      body,
      signal,
      ...(timeout === undefined ? {} : { timeout }),
      retry: false,
    });
    return res.data;
  }

  private async makeGetRequest<T>(
    url: string,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await this.client.request<T>({
      url,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...this.httpOptions.headers,
      },
      responseType: 'json',
      signal,
      retry: false,
    });
    return res.data;
  }

  async requestStreamingPost<T>(
    method: string,
    req: object,
    signal?: AbortSignal,
    timeout?: number,
  ): Promise<AsyncGenerator<T>> {
    const body = JSON.stringify(req);
    markRequestDispatched();
    const res = await this.client.request<AsyncIterable<unknown>>({
      url: this.getMethodUrl(method),
      method: 'POST',
      params: { alt: 'sse' },
      headers: {
        'Content-Type': 'application/json',
        ...this.httpOptions.headers,
      },
      responseType: 'stream',
      body,
      signal,
      ...(timeout === undefined ? {} : { timeout }),
      retry: false,
    });

    const stream =
      res.data instanceof Readable ? res.data : Readable.from(res.data);
    let lines: readline.Interface | undefined;
    let iterator: AsyncIterator<string> | undefined;
    let done = false;
    let streamError: unknown;
    let pending: Promise<unknown> = Promise.resolve();
    let buffered: string[] = [];
    let firstLine = true;

    const readError = (error: unknown) => {
      streamError = error;
      lines?.close();
    };
    stream.on('error', readError);
    const abort = () => close();
    const close = () => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', abort);
      stream.off('error', readError);
      lines?.close();
      stream.destroy();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();

    const nextResponse = async (): Promise<IteratorResult<T, void>> => {
      if (signal?.aborted) {
        close();
        throw signal.reason;
      }
      if (streamError) {
        close();
        throw streamError;
      }
      if (done) return { done: true, value: undefined };
      try {
        while (!done) {
          lines ??= readline.createInterface({
            input: stream,
            crlfDelay: Infinity,
          });
          iterator ??= lines[Symbol.asyncIterator]();
          const next = await iterator.next();
          if (signal?.aborted) throw signal.reason;
          if (streamError) throw streamError;
          if (next.done) {
            if (buffered.length > 0) {
              const value = parseChunk(buffered.join('\n'));
              buffered = [];
              close();
              return { done: false, value };
            }
            close();
            return { done: true, value: undefined };
          }
          let line = next.value;
          if (firstLine) {
            firstLine = false;
            line = line.replace(/^\uFEFF/, '');
          }
          if (line.startsWith('data:')) {
            buffered.push(line.slice(5).trimStart());
            continue;
          }
          if (line === '' && buffered.length > 0) {
            const value = parseChunk(buffered.join('\n'));
            buffered = [];
            if (signal?.aborted) throw signal.reason;
            return { done: false, value };
          }
        }
        if (signal?.aborted) throw signal.reason;
        if (streamError) throw streamError;
        return { done: true, value: undefined };
      } catch (error) {
        close();
        throw error;
      }
    };

    function parseChunk(chunk: string) {
      try {
        return JSON.parse(chunk) as T;
      } catch (error) {
        throw new Error('Malformed JSON in Code Assist stream.', {
          cause: error,
        });
      }
    }

    const streamIterator: AsyncGenerator<T, void, unknown> = {
      next: () => {
        const result = pending.then(nextResponse, nextResponse);
        pending = result.catch(() => undefined);
        return result;
      },
      return: async (_value: void | PromiseLike<void>) => {
        close();
        await pending;
        return { done: true, value: undefined };
      },
      throw: async (error?: unknown) => {
        close();
        await pending;
        throw error;
      },
      [Symbol.asyncIterator]() {
        return streamIterator;
      },
    };
    return streamIterator;
  }

  private getBaseUrl(): string {
    const rawEndpoint =
      process.env['CODE_ASSIST_ENDPOINT'] || CODE_ASSIST_ENDPOINT;
    const endpoint = new URL(rawEndpoint);
    if (endpoint.protocol === 'http:') {
      const host = endpoint.hostname;
      const loopback =
        host === 'localhost' ||
        host === '[::1]' ||
        /^127(?:\.\d{1,3}){3}$/.test(host);
      if (!loopback) {
        throw new Error('Plain HTTP Code Assist endpoints must be loopback.');
      }
    } else if (endpoint.protocol !== 'https:') {
      throw new Error('Code Assist endpoint must use HTTPS or loopback HTTP.');
    }
    const version =
      process.env['CODE_ASSIST_API_VERSION'] || CODE_ASSIST_API_VERSION;
    return `${rawEndpoint.trim().replace(/\/$/, '')}/${version}`;
  }

  getMethodUrl(method: string): string {
    return `${this.getBaseUrl()}:${method}`;
  }

  getOperationUrl(name: string): string {
    return `${this.getBaseUrl()}/${name}`;
  }
}
