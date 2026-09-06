export { QQChannel } from './QQChannel.js';

import { QQChannel } from './QQChannel.js';
import type { ChannelPlugin } from '@qwen-code/channel-base';

export const plugin: ChannelPlugin = {
  channelType: 'qq',
  displayName: 'QQ',
  // Both appID and appSecret are optional at config level because
  // fetchToken() resolves them via a fallback chain:
  //   config values → persisted credentials file → QR code login
  // If we required them here, parseChannelConfig() would reject the config
  // before QQChannel is ever constructed — QR-only login would be unreachable
  // through the built-in channel path.
  requiredConfigFields: [],
  createChannel: (name, config, bridge, options) =>
    new QQChannel(name, config, bridge, options),
};
