export interface DingtalkManagedSocket {
  readyState: number;
  ping(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
}

export interface DingtalkManagedClient {
  connected: boolean;
  registered: boolean;
  connect(): Promise<void>;
  disconnect(): void;
}

export interface DingtalkConnectionManagerOptions<
  T extends DingtalkManagedClient,
> {
  initialClient: T;
  createClient(): T;
  getSocket(client: T): DingtalkManagedSocket | undefined;
  onClientChanged(client: T): void;
  log(message: string): void;
}

const SOCKET_OPEN = 1;
const CONNECT_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 100;
const HEARTBEAT_INTERVAL_MS = 20_000;
const MAX_HEARTBEAT_MISSES = 2;

export class DingtalkConnectionManager<T extends DingtalkManagedClient> {
  private running = false;
  private generation = 0;
  private activeClient: T;
  private readyTimer?: ReturnType<typeof setTimeout>;
  private resolveReadyDelay?: () => void;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private heartbeatMisses = 0;
  private activitySinceHeartbeat = false;
  private reconnectTask?: Promise<void>;
  private socketCleanup?: () => void;

  constructor(private readonly options: DingtalkConnectionManagerOptions<T>) {
    this.activeClient = options.initialClient;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    const generation = ++this.generation;
    await this.activeClient.connect();
    await this.waitUntilReady(this.activeClient, generation);
    this.options.onClientChanged(this.activeClient);
    this.startMonitoring(this.activeClient);
  }

  noteActivity(client: T): void {
    if (!this.running || client !== this.activeClient) {
      return;
    }
    this.activitySinceHeartbeat = true;
    this.heartbeatMisses = 0;
  }

  requestReconnect(client: T, reason: string): void {
    if (!this.running || client !== this.activeClient || this.reconnectTask) {
      return;
    }
    this.reconnectTask = this.reconnect(reason).finally(() => {
      this.reconnectTask = undefined;
    });
  }

  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.generation++;
    this.stopMonitoring();
    this.cancelReadyDelay();
    this.activeClient.disconnect();
  }

  private startMonitoring(client: T): void {
    this.stopMonitoring();
    this.activitySinceHeartbeat = false;
    this.heartbeatMisses = 0;

    const socket = this.options.getSocket(client);
    if (socket) {
      const onPong = () => this.noteActivity(client);
      const onClose = () => this.requestReconnect(client, 'socket closed');
      const onError = () => this.requestReconnect(client, 'socket error');
      socket.on('pong', onPong);
      socket.on('close', onClose);
      socket.on('error', onError);
      this.socketCleanup = () => {
        socket.off('pong', onPong);
        socket.off('close', onClose);
        socket.off('error', onError);
      };
    }

    this.heartbeatTimer = setInterval(() => {
      if (!this.running || client !== this.activeClient) {
        return;
      }
      if (this.activitySinceHeartbeat) {
        this.activitySinceHeartbeat = false;
        this.heartbeatMisses = 0;
      } else {
        this.heartbeatMisses++;
      }
      if (this.heartbeatMisses >= MAX_HEARTBEAT_MISSES) {
        this.requestReconnect(client, 'heartbeat timeout');
        return;
      }
      this.options.getSocket(client)?.ping();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopMonitoring(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.socketCleanup?.();
    this.socketCleanup = undefined;
  }

  private async reconnect(reason: string): Promise<void> {
    const generation = this.generation;
    const previousClient = this.activeClient;
    const replacement = this.options.createClient();
    try {
      await replacement.connect();
      await this.waitUntilReady(replacement, generation);
      if (!this.running || generation !== this.generation) {
        replacement.disconnect();
        return;
      }
      this.activeClient = replacement;
      this.stopMonitoring();
      this.options.onClientChanged(replacement);
      previousClient.disconnect();
      this.startMonitoring(replacement);
    } catch (error) {
      replacement.disconnect();
      this.options.log(`${reason}: ${String(error)}`);
    }
  }

  private async waitUntilReady(client: T, generation: number): Promise<void> {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    while (this.running && generation === this.generation) {
      if (
        client.connected &&
        client.registered &&
        this.options.getSocket(client)?.readyState === SOCKET_OPEN
      ) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for DingTalk Stream registration.');
      }
      await this.waitForReadyPoll();
    }
    throw new Error('DingTalk connection manager stopped.');
  }

  private waitForReadyPoll(): Promise<void> {
    return new Promise((resolve) => {
      this.resolveReadyDelay = resolve;
      this.readyTimer = setTimeout(() => {
        this.readyTimer = undefined;
        this.resolveReadyDelay = undefined;
        resolve();
      }, READY_POLL_MS);
    });
  }

  private cancelReadyDelay(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
    }
    this.resolveReadyDelay?.();
    this.resolveReadyDelay = undefined;
  }
}
