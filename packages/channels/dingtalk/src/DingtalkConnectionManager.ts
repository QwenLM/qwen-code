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
  private hasStarted = false;
  private startingGeneration?: number;
  private activeClient: T;
  private readyTimer?: ReturnType<typeof setTimeout>;
  private resolveReadyDelay?: () => void;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private heartbeatMisses = 0;
  private activitySinceHeartbeat = false;
  private healthTimer?: ReturnType<typeof setInterval>;
  private healthFailures = 0;
  private reconnectTask?: Promise<void>;
  private reconnectGeneration?: number;
  private socketCleanup?: () => void;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private resolveRetryDelay?: () => void;
  private readonly cancelConnectionAttempts = new Set<() => void>();

  constructor(private readonly options: DingtalkConnectionManagerOptions<T>) {
    this.activeClient = options.initialClient;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    const client = this.hasStarted
      ? this.options.createClient()
      : this.activeClient;
    this.hasStarted = true;
    this.activeClient = client;
    this.running = true;
    const generation = ++this.generation;
    this.startingGeneration = generation;
    try {
      await this.connectClient(client, generation);
      this.options.onClientChanged(client);
      this.startMonitoring(client);
    } catch (error) {
      if (this.running && generation === this.generation) {
        this.safeDisconnect(client, 'startup client');
        this.running = false;
        this.generation++;
        this.stopMonitoring();
        this.cancelReadyDelay();
        this.cancelRetryDelay();
      }
      throw error;
    } finally {
      if (this.startingGeneration === generation) {
        this.startingGeneration = undefined;
      }
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
    const generation = this.generation;
    if (
      !this.running ||
      client !== this.activeClient ||
      this.startingGeneration === generation ||
      (this.reconnectTask && this.reconnectGeneration === generation)
    ) {
      return;
    }
    const task = this.reconnect(reason, generation);
    this.reconnectTask = task;
    this.reconnectGeneration = generation;
    void task
      .catch((error: unknown) => {
        this.options.log(`reconnect failed: ${String(error)}`);
      })
      .finally(() => {
        if (this.reconnectTask === task) {
          this.reconnectTask = undefined;
          this.reconnectGeneration = undefined;
        }
      });
  }

  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.generation++;
    this.startingGeneration = undefined;
    this.reconnectTask = undefined;
    this.reconnectGeneration = undefined;
    this.stopMonitoring();
    this.cancelReadyDelay();
    this.cancelRetryDelay();
    for (const cancel of this.cancelConnectionAttempts) {
      cancel();
    }
    this.cancelConnectionAttempts.clear();
    this.safeDisconnect(this.activeClient, 'active client');
  }

  private startMonitoring(client: T): void {
    this.stopMonitoring();
    this.activitySinceHeartbeat = true;
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

  private async reconnect(reason: string, generation: number): Promise<void> {
    const previousClient = this.activeClient;
    let retryDelay = INITIAL_RECONNECT_DELAY_MS;
    while (this.running && generation === this.generation) {
      let replacement: T | undefined;
      try {
        replacement = this.options.createClient();
        await this.connectClient(replacement, generation);
        if (!this.running || generation !== this.generation) {
          this.safeDisconnect(replacement, 'stale replacement client');
          return;
        }
        this.activeClient = replacement;
        this.stopMonitoring();
        this.options.onClientChanged(replacement);
        this.startMonitoring(replacement);
        this.safeDisconnect(previousClient, 'replaced client');
        return;
      } catch (error) {
        if (replacement) {
          this.safeDisconnect(replacement, 'failed replacement client');
        }
        if (!this.running || generation !== this.generation) {
          return;
        }
        this.options.log(`${reason}: ${String(error)}`);
        await this.waitForRetry(retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RECONNECT_DELAY_MS);
      }
    }
  }

  private async connectClient(client: T, generation: number): Promise<void> {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    let abortAttempt = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let rejectAttempt!: (error: Error) => void;
    const attemptEnded = new Promise<never>((_resolve, reject) => {
      rejectAttempt = reject;
      timeout = setTimeout(() => {
        abortAttempt = true;
        reject(new Error('Timed out connecting to DingTalk Stream.'));
      }, CONNECT_TIMEOUT_MS);
    });
    const cancel = () => {
      abortAttempt = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      rejectAttempt(new Error('DingTalk connection manager stopped.'));
    };
    this.cancelConnectionAttempts.add(cancel);

    const connect = client.connect();
    try {
      await Promise.race([connect, attemptEnded]);
    } catch (error) {
      if (abortAttempt) {
        void connect.then(
          () => this.safeDisconnect(client, 'late connection client'),
          () => undefined,
        );
      }
      throw error;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      this.cancelConnectionAttempts.delete(cancel);
    }

    await this.waitUntilReady(client, generation, deadline);
  }

  private safeDisconnect(client: T, context: string): void {
    try {
      client.disconnect();
    } catch (error) {
      this.options.log(`failed to disconnect ${context}: ${String(error)}`);
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

  private async waitUntilReady(
    client: T,
    generation: number,
    deadline: number,
  ): Promise<void> {
    while (this.running && generation === this.generation) {
      if (
        client.connected &&
        client.registered &&
        this.options.getSocket(client)?.readyState === SOCKET_OPEN
      ) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out connecting to DingTalk Stream.');
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
