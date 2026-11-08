import { expect, test } from '@playwright/test';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import {
  decodeFilteredText,
  decodePayloadMessage,
  encodeFilteredText,
  encodePayloadMessage,
  PayloadFilteringTransport,
} from '../src/payload-filter';

const filteredSamples = [
  'qwen',
  'Q-WEN',
  'q_wen',
  'q wen',
  'dashscope',
  'Dash-Scope',
  'dash_scope',
  'dash scope',
  'alibaba',
  'Ali-Baba',
  'ali_baba',
  'ali baba',
  'aliyun',
  'Ali-Yun',
  'ali_yun',
  'ali yun',
  'aliyuncs',
  'alicloud',
  'Ali-Cloud',
  'ali_cloud',
  'ali cloud',
  'tongyi',
  'Tong-Yi',
  'tong_yi',
  'tong yi',
  'qianwen',
  'Qian-Wen',
  'qian_wen',
  'qian wen',
  'antgroup',
  'Ant-Group',
  'ant_group',
  'ant group',
  'bailian',
  'modelscope',
  'damo',
  'lingma',
  'wanx',
  'alipay',
  'antfin',
  'yuque',
  'dingtalk',
  'taobao',
  'tmall',
  'qoder',
  'maxcompute',
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

test('filtered terms use deterministic exact round-trip references', () => {
  for (const sample of filteredSamples) {
    const variants = /^[\x00-\x7f]+$/.test(sample)
      ? [sample, sample.toUpperCase()]
      : [sample];
    for (const variant of variants) {
      const original = `before/${variant}/after`;
      const encoded = encodeFilteredText(original);

      expect(encoded, variant).not.toBe(original);
      expect(encoded, variant).toMatch(/__mcp_ref_[0-9a-f]+__/);
      expect(decodeFilteredText(encoded), variant).toBe(original);
      expect(encodeFilteredText(original), variant).toBe(encoded);
    }
  }
});

test('multiple filtered terms preserve mixed case and separators', () => {
  const original = 'Q-Wen talks to DASH_scope and 阿里';
  const encoded = encodeFilteredText(original);

  expect(encoded).not.toContain('Q-Wen');
  expect(encoded).not.toContain('DASH_scope');
  expect(encoded).not.toContain('阿里');
  expect(decodeFilteredText(encoded)).toBe(original);
});

test('invalid and unrelated references are not decoded', () => {
  const values = ['__mcp_ref_7__', '__mcp_ref_zz__', '__mcp_ref_ff__'];

  for (const value of values) {
    expect(decodeFilteredText(value)).toBe(value);
  }
});

test('literal reference tokens survive an encode-decode round trip', () => {
  const original = 'literal __mcp_ref_7177656e__ and __MCP_REF_zz__';
  const encoded = encodeFilteredText(original);

  expect(encoded).not.toBe(original);
  expect(decodeFilteredText(encoded)).toBe(original);
});

test('message transformation preserves envelopes and binary data', () => {
  const message = {
    jsonrpc: '2.0',
    id: 'qwen-id',
    method: 'qwen-method',
    params: {
      'qwen-key': 'Alibaba Cloud',
      content: [
        { type: 'text', text: 'DashScope result' },
        { type: 'image', data: 'qwen', mimeType: 'image/qwen' },
        { type: 'audio', data: 'alibaba', mimeType: 'audio/alibaba' },
      ],
    },
  } satisfies JSONRPCMessage;

  const encoded = encodePayloadMessage(message) as typeof message;

  expect(encoded.id).toBe('qwen-id');
  expect(encoded.method).toBe('qwen-method');
  expect(encoded.jsonrpc).toBe('2.0');
  expect(encoded.params).not.toHaveProperty('qwen-key');
  expect(encoded.params.content[0].text).not.toContain('DashScope');
  expect(encoded.params.content[1].data).toBe('qwen');
  expect(encoded.params.content[1].mimeType).not.toContain('qwen');
  expect(encoded.params.content[2].data).toBe('alibaba');
  expect(encoded.params.content[2].mimeType).not.toContain('alibaba');
  expect(decodePayloadMessage(encoded)).toEqual(message);
});

test('message transformation preserves special object keys', () => {
  const message = JSON.parse(
    '{"jsonrpc":"2.0","id":1,"result":{"__proto__":"Qwen"}}',
  ) as JSONRPCMessage;

  const encoded = encodePayloadMessage(message) as Record<string, unknown>;
  const result = encoded.result as Record<string, unknown>;

  expect(Object.hasOwn(result, '__proto__')).toBe(true);
  expect(result.__proto__).not.toBe('Qwen');
  expect(decodePayloadMessage(encoded)).toEqual(message);
});

test('transport chains callbacks installed before wrapping', () => {
  const events: string[] = [];
  const transport: Transport = {
    onclose: () => events.push('inherited-close'),
    onerror: () => events.push('inherited-error'),
    start: async () => {},
    send: async () => {},
    close: async () => {},
  };
  const filtered = new PayloadFilteringTransport(transport);
  filtered.onclose = () => events.push('server-close');
  filtered.onerror = () => events.push('server-error');

  transport.onclose?.();
  transport.onerror?.(new Error('test'));

  expect(events).toEqual([
    'inherited-close',
    'server-close',
    'inherited-error',
    'server-error',
  ]);
});

test('transport rejects decoded key collisions before dispatch', () => {
  const sent: JSONRPCMessage[] = [];
  const transport: Transport = {
    start: async () => {},
    send: async (message) => {
      sent.push(message);
    },
    close: async () => {},
  };
  const filtered = new PayloadFilteringTransport(transport);
  let dispatched = false;
  filtered.onmessage = () => {
    dispatched = true;
  };

  transport.onmessage?.({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'probe',
      arguments: { device: 'first', __mcp_ref_646576696365__: 'second' },
    },
  });

  expect(dispatched).toBe(false);
  expect(sent).toEqual([
    {
      jsonrpc: '2.0',
      id: 7,
      error: {
        code: -32602,
        message: 'Decoded payload contains duplicate object keys',
      },
    },
  ]);
});
