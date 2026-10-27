import type { ChannelPlugin } from '@qwen-code/channel-base';
import { TeamsChannel } from './TeamsChannel.js';
import type { TeamsConfig } from './types.js';

export { TeamsChannel, TeamsDeliveryError } from './TeamsChannel.js';
export { FileTeamsReferenceStore } from './reference-store.js';
export { createTeamsIngress } from './ingress.js';
export type {
  TeamsChannelOptions,
  TeamsConfig,
  TeamsCredentials,
  TeamsHost,
  TeamsPromptOutcome,
  TeamsInboundEvent,
  TeamsIngress,
  TeamsReferenceStore,
  TeamsSendContext,
  TeamsSendReceipt,
  TeamsTarget,
  TeamsWebhookRequest,
  TeamsWebhookResponse,
} from './types.js';

export const plugin: ChannelPlugin = {
  channelType: 'msteams',
  displayName: 'Microsoft Teams',
  requiredConfigFields: ['appId', 'appPassword', 'tenantId', 'approvalMode'],
  createChannel: (name, config, bridge, options) =>
    new TeamsChannel(
      name,
      config as TeamsConfig & Record<string, unknown>,
      bridge,
      options,
    ),
};
