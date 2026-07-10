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
const HEALTH_INTERVAL_MS = 60_000;
const MAX_HEALTH_FAILURES = 2;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export class DingtalkConnectionManager<T extends DingtalkManagedClient> {
  private running = false;
  private generation = 0;
  private activeClient: T;
  private readyTimer?: ReturnType<typeof setTimeout>;
  private resolveReadyDelay?: () => void;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private heartbeatMisses = 0;
  private activitySinceHeartbeat = false;
  private healthTimer?: ReturnType<typeof setInterval>;
  private healthFailures = 0;
  private reconnectTask?: Promise<void>;
  private socketCleanup?: () => void;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private resolveRetryDelay?: () => void;

  constructor(private readonly options: DingtalkConnectionManagerOptions<T>) {
    this.activeClient = options.initialClient;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    const generation = ++this.generation;
    try {
      await this.activeClient.connect();
      await this.waitUntilReady(this.activeClient, generation);
      this.options.onClientChanged(this.activeClient);
      this.startMonitoring(this.activeClient);
    } catch (error) {
      if (this.running && generation === this.generation) {
        this.running = false;
        this.generation++;
        this.cancelReadyDelay();
        this.activeClient.disconnect();
      }
      throw error;
    }
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
    this.cancelRetryDelay();
    this.activeClient.disconnect();
  }

  private startMonitoring(client: T): void {
    this.stopMonitoring();
    this.activitySinceHeartbeat = false;
    this.heartbeatMisses = 0;
    this.healthFailures = 0;

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
      const socket = this.options.getSocket(client);
      if (!socket || socket.readyState !== SOCKET_OPEN) {
        this.requestReconnect(client, 'socket is not open');
        return;
      }
      try {
        socket.ping();
      } catch (error) {
        this.requestReconnect(client, `socket ping failed: ${String(error)}`);
      }
    }, HEARTBEAT_INTERVAL_MS);

    this.healthTimer = setInterval(() => {
      if (!this.running || client !== this.activeClient) {
        return;
      }
      if (
        client.connected &&
        client.registered &&
        this.options.getSocket(client)?.readyState === SOCKET_OPEN
      ) {
        this.healthFailures = 0;
        return;
      }
      this.healthFailures++;
      if (this.healthFailures >= MAX_HEALTH_FAILURES) {
        this.requestReconnect(client, 'unhealthy connection state');
      }
    }, HEALTH_INTERVAL_MS);
  }

  private stopMonitoring(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
    this.socketCleanup?.();
    this.socketCleanup = undefined;
  }

  private async reconnect(reason: string): Promise<void> {
    const generation = this.generation;
    const previousClient = this.activeClient;
    let retryDelay = INITIAL_RECONNECT_DELAY_MS;
    while (this.running && generation === this.generation) {
      let replacement: T | undefined;
      try {
        replacement = this.options.createClient();
        await replacement.connect();
        await this.waitUntilReady(replacement, generation);
        if (!this.running || generation !== this.generation) {
          replacement.disconnect();
          return;
        }
        this.activeClient = replacement;
        this.stopMonitoring();
        this.options.onClientChanged(replacement);
        this.startMonitoring(replacement);
        try {
          previousClient.disconnect();
        } catch (error) {
          this.options.log(
            `failed to disconnect replaced client: ${String(error)}`,
          );
        }
        return;
      } catch (error) {
        replacement?.disconnect();
        if (!this.running || generation !== this.generation) {
          return;
        }
        this.options.log(`${reason}: ${String(error)}`);
        await this.waitForRetry(retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RECONNECT_DELAY_MS);
      }
    }
  }

  private waitForRetry(delay: number): Promise<void> {
    return new Promise((resolve) => {
      this.resolveRetryDelay = resolve;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        this.resolveRetryDelay = undefined;
        resolve();
      }, delay);
    });
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

  private cancelRetryDelay(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.resolveRetryDelay?.();
    this.resolveRetryDelay = undefined;
  }
}
