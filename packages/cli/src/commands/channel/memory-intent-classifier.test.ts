import { describe, expect, it, vi } from 'vitest';
import type { ChannelAgentBridge } from '@qwen-code/channel-base';
import { BridgeChannelMemoryIntentClassifier } from './memory-intent-classifier.js';

function bridgeWithResponse(response: string): ChannelAgentBridge {
  return {
    availableCommands: [],
    on: vi.fn(),
    off: vi.fn(),
    newSession: vi.fn().mockResolvedValue('classifier-session'),
    loadSession: vi.fn(),
    prompt: vi.fn().mockResolvedValue(response),
    cancelSession: vi.fn(),
  };
}

describe('BridgeChannelMemoryIntentClassifier', () => {
  it('uses an isolated bridge session and parses classifier JSON', async () => {
    const bridge = bridgeWithResponse(
      '{"intent":"remember","memory":"回复前说 1122","confidence":0.93}',
    );
    const classifier = new BridgeChannelMemoryIntentClassifier(bridge, '/tmp');

    await expect(
      classifier.classifyChannelMemoryIntent('你记一下以后回复前说 1122'),
    ).resolves.toEqual({
      intent: 'remember',
      memory: '回复前说 1122',
      confidence: 0.93,
    });
    expect(bridge.newSession).toHaveBeenCalledWith('/tmp');
    expect(bridge.prompt).toHaveBeenCalledWith(
      'classifier-session',
      expect.stringContaining('"你记一下以后回复前说 1122"'),
      {},
    );
  });

  it('extracts a JSON object from wrapped model output', async () => {
    const bridge = bridgeWithResponse(
      '```json\n{"intent":"list","confidence":0.86}\n```',
    );
    const classifier = new BridgeChannelMemoryIntentClassifier(bridge, '/tmp');

    await expect(
      classifier.classifyChannelMemoryIntent('你记住了什么'),
    ).resolves.toEqual({
      intent: 'list',
      confidence: 0.86,
    });
  });

  it('uses the latest bridge from a lazy provider', async () => {
    const firstBridge = bridgeWithResponse('{"intent":"none","confidence":1}');
    const secondBridge = bridgeWithResponse(
      '{"intent":"list","confidence":0.86}',
    );
    let bridge = firstBridge;
    const classifier = new BridgeChannelMemoryIntentClassifier(
      () => bridge,
      '/tmp',
    );

    bridge = secondBridge;

    await expect(
      classifier.classifyChannelMemoryIntent('你记住了什么'),
    ).resolves.toEqual({
      intent: 'list',
      confidence: 0.86,
    });
    expect(firstBridge.newSession).not.toHaveBeenCalled();
    expect(secondBridge.newSession).toHaveBeenCalledWith('/tmp');
  });

  it('rejects prose-wrapped JSON output', async () => {
    const bridge = bridgeWithResponse(
      'Here is the classification: {"intent":"list","confidence":0.86}',
    );
    const classifier = new BridgeChannelMemoryIntentClassifier(bridge, '/tmp');

    await expect(
      classifier.classifyChannelMemoryIntent('你记住了什么'),
    ).rejects.toThrow('Classifier response did not contain a JSON object.');
  });

  it('normalizes invalid classifier fields to none', async () => {
    const bridge = bridgeWithResponse(
      '{"intent":"delete_one","confidence":"high"}',
    );
    const classifier = new BridgeChannelMemoryIntentClassifier(bridge, '/tmp');

    await expect(
      classifier.classifyChannelMemoryIntent('忘掉其中一条'),
    ).resolves.toEqual({
      intent: 'none',
      confidence: 0,
    });
  });

  it('normalizes out-of-range confidence to none', async () => {
    const bridge = bridgeWithResponse(
      '{"intent":"remember","memory":"x","confidence":999}',
    );
    const classifier = new BridgeChannelMemoryIntentClassifier(bridge, '/tmp');

    await expect(
      classifier.classifyChannelMemoryIntent('记住 x'),
    ).resolves.toEqual({
      intent: 'none',
      confidence: 0,
    });
  });
});
