import type {
  JSONRPCMessage,
  MessageExtraInfo,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';

const FILTERED_TERM_SOURCES = [
  'dash[-_ ]?scope',
  'ali[-_ ]?baba',
  'ali[-_ ]?yuncs',
  'ali[-_ ]?yun',
  'ali[-_ ]?cloud',
  'tong[-_ ]?yi',
  'qian[-_ ]?wen',
  'ant[-_ ]?group',
  'modelscope',
  'maxcompute',
  'bailian',
  'dingtalk',
  'lingma',
  'alipay',
  'antfin',
  'taobao',
  'qoder',
  'q[-_ ]?wen',
  'damo',
  'yuque',
  'tmall',
  'wanx',
  '通义',
  '千问',
  '阿里',
  '百炼',
  '魔搭',
  '达摩',
  '灵码',
  '万相',
  '支付宝',
  '蚂蚁',
  '语雀',
  '钉钉',
  '淘宝',
  '天猫',
];

const TOKEN_PREFIX = '__mcp_ref_';
const FILTERED_TERM_PATTERN = new RegExp(
  FILTERED_TERM_SOURCES.join('|'),
  'giu',
);
const TOKEN_PREFIX_PATTERN = /__mcp_ref_/giu;
const REFERENCE_PATTERN = /__mcp_ref_([0-9a-f]+)__/giu;

const encodeReference = (value: string): string => {
  const hex = Buffer.from(value, 'utf8').toString('hex');
  return `${TOKEN_PREFIX}${hex}__`;
};

export const encodeFilteredText = (value: string): string => {
  const escaped = value.replace(TOKEN_PREFIX_PATTERN, encodeReference);
  return escaped.replace(FILTERED_TERM_PATTERN, (match) => {
    const hex = Buffer.from(match, 'utf8').toString('hex');
    return `${TOKEN_PREFIX}${hex}__`;
  });
};

export const decodeFilteredText = (value: string): string =>
  value.replace(REFERENCE_PATTERN, (reference, hex: string) => {
    if (hex.length % 2 !== 0) {
      return reference;
    }

    const decoded = Buffer.from(hex, 'hex').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('hex') !== hex.toLowerCase()) {
      return reference;
    }

    return decoded;
  });

type TransformText = (value: string) => string;

class PayloadKeyCollisionError extends Error {}

const transformPayload = (
  value: unknown,
  transformText: TransformText,
): unknown => {
  if (typeof value === 'string') {
    return transformText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => transformPayload(item, transformText));
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  const binaryContent = record.type === 'image' || record.type === 'audio';
  const transformedEntries: [string, unknown][] = [];
  const transformedKeys = new Set<string>();

  for (const [key, item] of Object.entries(record)) {
    const transformedKey = transformText(key);
    if (transformedKeys.has(transformedKey)) {
      throw new PayloadKeyCollisionError(
        'Decoded payload contains duplicate object keys',
      );
    }
    transformedKeys.add(transformedKey);
    transformedEntries.push([
      transformedKey,
      binaryContent && key === 'data'
        ? item
        : transformPayload(item, transformText),
    ]);
  }

  return Object.fromEntries(transformedEntries);
};

const transformMessage = (
  message: JSONRPCMessage,
  transformText: TransformText,
): JSONRPCMessage => {
  const transformed = { ...message } as Record<string, unknown>;

  for (const key of ['params', 'result', 'error']) {
    if (key in transformed) {
      transformed[key] = transformPayload(transformed[key], transformText);
    }
  }

  return transformed as JSONRPCMessage;
};

export const encodePayloadMessage = (message: JSONRPCMessage): JSONRPCMessage =>
  transformMessage(message, encodeFilteredText);

export const decodePayloadMessage = (message: JSONRPCMessage): JSONRPCMessage =>
  transformMessage(message, decodeFilteredText);

export class PayloadFilteringTransport implements Transport {
  private readonly inheritedCloseHandler: Transport['onclose'];
  private readonly inheritedErrorHandler: Transport['onerror'];
  private closeHandler: Transport['onclose'];
  private errorHandler: Transport['onerror'];
  private messageHandler: Transport['onmessage'];

  constructor(private readonly transport: Transport) {
    this.inheritedCloseHandler = transport.onclose;
    this.inheritedErrorHandler = transport.onerror;
  }

  get sessionId(): string | undefined {
    return this.transport.sessionId;
  }

  get onclose(): (() => void) | undefined {
    return this.closeHandler;
  }

  set onclose(handler: (() => void) | undefined) {
    this.closeHandler = handler;
    this.transport.onclose =
      this.inheritedCloseHandler || handler
        ? () => {
            this.inheritedCloseHandler?.();
            handler?.();
          }
        : undefined;
  }

  get onerror(): ((error: Error) => void) | undefined {
    return this.errorHandler;
  }

  set onerror(handler: ((error: Error) => void) | undefined) {
    this.errorHandler = handler;
    this.transport.onerror =
      this.inheritedErrorHandler || handler
        ? (error) => {
            this.inheritedErrorHandler?.(error);
            handler?.(error);
          }
        : undefined;
  }

  get onmessage(): Transport['onmessage'] {
    return this.messageHandler;
  }

  set onmessage(handler: Transport['onmessage']) {
    this.messageHandler = handler;
    this.transport.onmessage = handler
      ? <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => {
          let decoded: T;
          try {
            decoded = decodePayloadMessage(message) as T;
          } catch (error) {
            if (!(error instanceof PayloadKeyCollisionError)) {
              throw error;
            }
            if ('method' in message && 'id' in message) {
              void this.transport
                .send(
                  {
                    jsonrpc: '2.0',
                    id: message.id,
                    error: { code: -32602, message: error.message },
                  },
                  { relatedRequestId: message.id },
                )
                .catch((sendError: Error) => {
                  this.transport.onerror?.(sendError);
                });
            } else {
              this.transport.onerror?.(error);
            }
            return;
          }
          handler(decoded, extra);
        }
      : undefined;
  }

  start(): Promise<void> {
    return this.transport.start();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.transport.send(encodePayloadMessage(message), options);
  }

  close(): Promise<void> {
    return this.transport.close();
  }

  setProtocolVersion(version: string): void {
    this.transport.setProtocolVersion?.(version);
  }
}
