import type { ChannelPlugin } from '@qwen-code/channel-base';
import { MockPluginChannel } from './MockPluginChannel.js';

export { MockPluginChannel } from './MockPluginChannel.js';
export type { MockPluginConfig } from './MockPluginChannel.js';
export { createMockServer } from './mock-server.js';
export type { MockServerHandle, MockServerOptions } from './mock-server.js';
export type { InboundMessage, OutboundMessage, WsMessage } from './protocol.js';

export const plugin: ChannelPlugin = {
  channelType: 'mock-plugin',
  displayName: 'Mock Plugin',
  requiredConfigFields: ['serverWsUrl'],
  createChannel: (name, config, bridge, options) =>
    new MockPluginChannel(name, config as MockPluginConfig, bridge, options),
};
