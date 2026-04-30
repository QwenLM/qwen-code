/**
 * @craft-agent/messaging-gateway
 *
 * Messaging gateway for Craft Agent — Telegram & WhatsApp.
 */

export { MessagingGateway, type GatewayOptions } from './gateway'
export { TelegramAdapter } from './adapters/telegram/index'
export {
  WhatsAppAdapter,
  type WhatsAppConfig,
  type WhatsAppEvent,
} from './adapters/whatsapp/index'
export { BindingStore } from './binding-store'
export { ConfigStore } from './config-store'
export { PairingCodeManager, PAIRING_TTL_MS, PAIRING_RATE_LIMIT_PER_MINUTE } from './pairing'
export type { PairingEntry, GeneratedPairing } from './pairing'
export { Router } from './router'
export { Commands, type PairingCodeConsumer } from './commands'
export { Renderer } from './renderer'

export type {
  PlatformType,
  PlatformAdapter,
  PlatformConfig,
  AdapterCapabilities,
  IncomingMessage,
  SentMessage,
  InlineButton,
  ButtonPress,
  ChannelBinding,
  BindingConfig,
  MessagingConfig,
  MessagingLogger,
  MessagingLogContext,
  MessagingLogMeta,
  MessagingPlatformRuntimeInfo,
  MessagingPlatformRuntimeState,
} from './types'

export {
  DEFAULT_BINDING_CONFIG,
  DEFAULT_MESSAGING_CONFIG,
  getDefaultBindingConfig,
  normalizeBindingConfig,
} from './types'

export { createFanOutSink, type EventSinkFn } from './event-fanout'
export {
  MessagingGatewayRegistry,
  type MessagingGatewayRegistryOptions,
} from './registry'
export {
  createMessagingBootstrap,
  type MessagingBootstrapOptions,
  type MessagingBootstrapHandle,
  type PublishEventFn,
} from './bootstrap'
