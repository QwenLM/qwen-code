/**
 * Channel registry - manages notification channels and provides factory methods.
 */

import type {
  NotificationChannel,
  ChannelConfig,
  TaskNotification,
} from './channel.js';
import { ConsoleChannel } from './console-channel.js';
import { FileChannel, type FileChannelConfig } from './file-channel.js';
import {
  WebhookChannel,
  type WebhookChannelConfig,
} from './webhook-channel.js';

export class ChannelRegistry {
  private channels: Map<string, NotificationChannel> = new Map();

  /**
   * Create a channel from configuration.
   */
  static createChannel(config: ChannelConfig): NotificationChannel {
    switch (config.type) {
      case 'console':
        return new ConsoleChannel();
      case 'file':
        return new FileChannel(config as unknown as FileChannelConfig);
      case 'webhook':
        return new WebhookChannel(config as unknown as WebhookChannelConfig);
      default:
        throw new Error(`Unknown channel type: ${config.type}`);
    }
  }

  /**
   * Create multiple channels from configuration array.
   */
  static createChannels(configs: ChannelConfig[]): NotificationChannel[] {
    return configs
      .filter((config) => config.enabled !== false)
      .map((config) => ChannelRegistry.createChannel(config));
  }

  /**
   * Register a channel.
   */
  register(channel: NotificationChannel): void {
    this.channels.set(channel.name, channel);
  }

  /**
   * Get a channel by name.
   */
  get(name: string): NotificationChannel | undefined {
    return this.channels.get(name);
  }

  /**
   * Send notification to all registered channels.
   */
  async sendToAll(notification: TaskNotification): Promise<void> {
    const promises = Array.from(this.channels.values()).map(async (channel) => {
      try {
        await channel.send(notification);
      } catch (err) {
        // Log error but don't throw - we want to continue sending to other channels
        process.stderr.write(
          `Warning: Failed to send notification to ${channel.name}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    });

    await Promise.all(promises);
  }

  /**
   * Test all registered channels.
   */
  async testAll(): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();

    for (const [name, channel] of this.channels) {
      try {
        const success = await channel.test();
        results.set(name, success);
      } catch {
        results.set(name, false);
      }
    }

    return results;
  }

  /**
   * Get all registered channel names.
   */
  list(): string[] {
    return Array.from(this.channels.keys());
  }

  /**
   * Clear all registered channels.
   */
  clear(): void {
    this.channels.clear();
  }
}
