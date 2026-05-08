import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  BusinessBotRights,
  BusinessConnection,
} from '@grammyjs/types/manage.js';

export interface StoredBusinessConnection {
  id: string;
  userId: string;
  userChatId: string;
  userName: string;
  rights?: BusinessBotRights;
  isEnabled: boolean;
  connectedAt: number;
  updatedAt: number;
}

export class BusinessConnectionStore {
  private readonly dir: string;
  private readonly filePath: string;

  constructor(channelName: string) {
    this.dir = path.join(os.homedir(), '.qwen', 'channels');
    this.filePath = path.join(
      this.dir,
      `${channelName}-business-connections.json`,
    );
  }

  upsert(connection: BusinessConnection): StoredBusinessConnection {
    const entries = this.readAll();
    const stored = toStoredConnection(connection);
    entries[stored.id] = stored;
    this.writeAll(entries);
    return stored;
  }

  get(connectionId: string): StoredBusinessConnection | undefined {
    return this.readAll()[connectionId];
  }

  private readAll(): Record<string, StoredBusinessConnection> {
    try {
      const data = readFileSync(this.filePath, 'utf-8');
      return JSON.parse(data) as Record<string, StoredBusinessConnection>;
    } catch {
      return {};
    }
  }

  private writeAll(entries: Record<string, StoredBusinessConnection>): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
    writeFileSync(this.filePath, JSON.stringify(entries, null, 2), 'utf-8');
  }
}

function toStoredConnection(
  connection: BusinessConnection,
): StoredBusinessConnection {
  return {
    id: connection.id,
    userId: String(connection.user.id),
    userChatId: String(connection.user_chat_id),
    userName:
      connection.user.first_name +
      (connection.user.last_name ? ` ${connection.user.last_name}` : ''),
    rights: connection.rights,
    isEnabled: connection.is_enabled,
    connectedAt: connection.date,
    updatedAt: Math.floor(Date.now() / 1000),
  };
}
