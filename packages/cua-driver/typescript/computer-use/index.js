/** Thin session transport for the driver-owned Computer Use interface. */
import { randomUUID } from 'node:crypto';
import { ComputerUseApp } from './app.js';
import manifest from './interface.json' with { type: 'json' };

const DEFAULT_EXPLICIT_SESSION_TTL_SECONDS = 60 * 60;
const DEFAULT_EXPLICIT_IDLE_TTL_SECONDS = 5 * 60;
const RECONNECTABLE_SESSION_CODES = new Set(['authorization_context_expired', 'session_unavailable']);
async function loadCuaDriver() { return import('@qwen-code/cua-sdk'); }

export class ComputerUseError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'ComputerUseError';
    this.code = info.code;
    this.reason = info.reason;
    this.sent = info.sent;
    this.next = info.next;
    this.details = info.details;
  }
}

function unwrapToolResult(tool, result, operation) {
  const structured = result.structuredJson ? JSON.parse(result.structuredJson) : undefined;
  if (result.isError) {
    throw new ComputerUseError(result.text || `${tool} failed`, {
      ...structured, code: structured?.code ?? result.errorCode,
      details: { ...structured, operation },
    });
  }
  return { text: result.text ?? '', structured, images: result.images ?? [], operation };
}

function requirePositiveInteger(name, value, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new ComputerUseError(
      `${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`,
    );
  }
  return value;
}

function requireIntegerRange(name, value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ComputerUseError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function requireAbortSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new ComputerUseError("signal must be an AbortSignal");
  }
  return signal;
}

function operationSnapshot(operation) {
  return Object.freeze({
    id: operation.id,
    state: operation.state,
    dispatched: operation.dispatched,
    committed: operation.committed,
    cancellationRequested: operation.cancellationRequested,
  });
}

function beginOperation(method, signal) {
  requireAbortSignal(signal);
  const operation = {
    id: randomUUID(),
    method,
    state: "accepted",
    dispatched: false,
    committed: false,
    cancellationRequested: signal?.aborted === true,
  };
  const onAbort = () => {
    operation.cancellationRequested = true;
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  return {
    operation,
    release: () => signal?.removeEventListener("abort", onAbort),
  };
}

function cancelledBeforeDispatch(method, operation) {
  operation.state = "completed";
  throw new ComputerUseError(`${method} was cancelled before dispatch`, {
    code: "call_cancelled",
    details: { method, operation: operationSnapshot(operation) },
  });
}

function requireDispatchableSignal(method, signal) {
  const lifecycle = beginOperation(method, signal);
  try {
    if (lifecycle.operation.cancellationRequested) {
      cancelledBeforeDispatch(method, lifecycle.operation);
    }
  } finally {
    lifecycle.release();
  }
}

function awaitNativeTerminal(value, signal) {
  const promise = Promise.resolve(value);
  const waitUntil = signal?.waitUntil;
  return typeof waitUntil === "function" ? waitUntil.call(signal, promise) : promise;
}

function createTrustedSessionAsync(sdk, owner, options) {
  if (typeof sdk.createTrustedSessionAsync !== "function") {
    throw new ComputerUseError("typed CUA SDK lacks asynchronous session binding", {
      code: "typed_sdk_method_unavailable",
    });
  }
  return sdk.createTrustedSessionAsync(owner, options);
}

function requireNonEmptyString(name, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ComputerUseError(`${name} must be a non-empty string`);
  }
  return value;
}

function sessionOptions(sdk, options) {
  const finiteLifetimeRequested =
    options.sessionTtlSeconds !== undefined || options.idleTtlSeconds !== undefined;
  const ttlSeconds = requirePositiveInteger(
    "sessionTtlSeconds",
    finiteLifetimeRequested
      ? (options.sessionTtlSeconds ?? DEFAULT_EXPLICIT_SESSION_TTL_SECONDS)
      : 0,
    { allowZero: !finiteLifetimeRequested },
  );
  const idleTtlSeconds = requirePositiveInteger(
    "idleTtlSeconds",
    finiteLifetimeRequested ? (options.idleTtlSeconds ?? DEFAULT_EXPLICIT_IDLE_TTL_SECONDS) : 0,
    { allowZero: !finiteLifetimeRequested },
  );
  if (idleTtlSeconds > ttlSeconds) {
    throw new ComputerUseError("idleTtlSeconds cannot exceed sessionTtlSeconds");
  }
  const publicSession =
    options.session ?? `computer-use-${process.pid}-${randomUUID().slice(0, 8)}`;
  requireNonEmptyString("session", publicSession);
  return {
    publicSession,
    mode: sdk.SessionPermissionMode.Standard,
    ttlSeconds: BigInt(ttlSeconds),
    idleTtlSeconds: BigInt(idleTtlSeconds),
    capabilityManifestPath: undefined,
    boundedManifestPath: undefined,
  };
}

function configuredDriverOptions(sdk, options) {
  const session = sessionOptions(sdk, options);
  return {
    session,
    driver: {
      claudeCodeCompatibility: false,
      authorization: {
        allowedModes: [sdk.SessionPermissionMode.Standard],
        compatibilityMode: sdk.SessionPermissionMode.Standard,
        compatibilityCapabilityManifestPath: undefined,
        compatibilityBoundedManifestPath: undefined,
        unrestrictedAcknowledged: false,
        maxSessionTtlSeconds: session.ttlSeconds,
        maxIdleTtlSeconds: session.idleTtlSeconds,
      },
    },
  };
}

async function destroyOwner(owner) {
  let failure;
  if (typeof owner?.shutdown === "function") {
    try {
      await owner.shutdown();
    } catch (error) {
      failure = error;
    }
  }
  if (typeof owner?.uniffiDestroy === "function") {
    try {
      owner.uniffiDestroy();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

async function destroySessionHandle(session) {
  let failure;
  if (typeof session?.closeAsync === "function") {
    try {
      await session.closeAsync();
    } catch (error) {
      failure = error;
    }
  } else if (typeof session?.close === "function") {
    try {
      session.close();
    } catch (error) {
      failure = error;
    }
  }
  if (typeof session?.uniffiDestroy === "function") {
    try {
      session.uniffiDestroy();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

export class ComputerUse {
  #driver;
  #owner;
  #sdk;
  #ownsSession;
  #publicSession;
  #sessionFactory;
  #reconnectPromise;
  #connectionGeneration = 1;
  #closed = false;
  #apps = new Map();

  /** Internal injection seam for hermetic tests. Use create/connect in applications. */
  constructor(
    driver,
    {
      owner = driver,
      sdk = {},
      ownsSession = false,
      publicSession,
      sessionFactory,
    } = {},
  ) {
    if (!driver || typeof driver.callTool !== "function") {
      throw new ComputerUseError("ComputerUse requires a typed driver session");
    }
    this.#driver = driver;
    this.#owner = owner;
    this.#sdk = sdk;
    this.#ownsSession = ownsSession;
    this.#publicSession = publicSession;
    this.#sessionFactory = sessionFactory;
  }

  /** Create a same-process configured runtime and one bound standard session. */
  static async create(options = {}) {
    const signal = options.signal;
    requireDispatchableSignal("createTrustedSession", signal);
    const sdk = await loadCuaDriver();
    const configured = configuredDriverOptions(sdk, options);
    const owner = sdk.CuaDriver.createConfigured(configured.driver);
    try {
      requireDispatchableSignal("createTrustedSession", signal);
      const session = await awaitNativeTerminal(
        createTrustedSessionAsync(sdk, owner, configured.session),
        signal,
      );
      return new ComputerUse(session, {
        owner,
        sdk,
        ownsSession: true,
        publicSession: configured.session.publicSession,
        environment: process.env,
        sessionFactory: (publicSession) =>
          createTrustedSessionAsync(sdk, owner, {
            ...configured.session,
            publicSession,
          }),
      });
    } catch (error) {
      await destroyOwner(owner);
      throw error;
    }
  }

  /** Compatibility factory; ordinary serve daemons reject trusted session binding. */
  static async connect(options = {}) {
    const signal = options.signal;
    requireDispatchableSignal("createTrustedSession", signal);
    const sdk = await loadCuaDriver();
    const configured = configuredDriverOptions(sdk, options);
    const owner = sdk.CuaDriver.connect(options.socketPath);
    try {
      requireDispatchableSignal("createTrustedSession", signal);
      const session = await awaitNativeTerminal(
        createTrustedSessionAsync(sdk, owner, configured.session),
        signal,
      );
      return new ComputerUse(session, {
        owner,
        sdk,
        ownsSession: true,
        publicSession: configured.session.publicSession,
        environment: process.env,
        sessionFactory: (publicSession) =>
          createTrustedSessionAsync(sdk, owner, {
            ...configured.session,
            publicSession,
          }),
      });
    } catch (error) {
      await destroyOwner(owner);
      throw error;
    }
  }

  #requireOpen() {
    if (this.#closed) throw new ComputerUseError("ComputerUse instance is closed");
  }

  async #call(method, input, { signal, mutating = false, onDispatch } = {}) {
    this.#requireOpen();
    const lifecycle = beginOperation(method, signal);
    const { operation } = lifecycle;
    try {
      const reconnect = this.#reconnectPromise;
      if (reconnect) await reconnect;
      this.#requireOpen();
      if (!this.#driver && typeof this.#sessionFactory === "function") {
        await this.#reconnect(this.#connectionGeneration, { signal });
      }
      if (operation.cancellationRequested) {
        cancelledBeforeDispatch(method, operation);
      }
      const driver = this.#driver;
      const call = driver?.[method];
      if (typeof call !== "function") {
        throw new ComputerUseError(`typed CuaDriver method ${method} is unavailable`, {
          code: "typed_sdk_method_unavailable",
        });
      }
      onDispatch?.(this.#connectionGeneration);
      if (operation.cancellationRequested) {
        cancelledBeforeDispatch(method, operation);
      }
      operation.state = "dispatched";
      operation.dispatched = true;

      // Do not hand caller cancellation to UniFFI after dispatch. UniFFI drops
      // the Rust future immediately, while platform work may continue. Awaiting
      // the native terminal result is what prevents ambiguous late actions.
      const pending = method === "callTool"
        ? call.call(driver, input.name, JSON.stringify(input.args))
        : call.call(driver, input);
      const value = await awaitNativeTerminal(pending, signal);
      const refusedEffect = this.#sdk.ActionEffect?.Refused ?? 4;
      const refused =
        value?.action?.effect === refusedEffect || value?.action?.effect === "refused";
      if (mutating && !refused && (value?.action !== undefined || value?.isError !== true)) {
        operation.state = "committed";
        operation.committed = true;
      }
      operation.state = "completed";
      return { value, operation: operationSnapshot(operation) };
    } catch (error) {
      if (operation.state !== "completed") operation.state = "completed";
      if (operation.dispatched && operation.cancellationRequested) {
        throw new ComputerUseError(
          `${method} failed after dispatch; cancellation did not establish that the action was uncommitted`,
          {
            code: error?.code,
            details: { cause: error, operation: operationSnapshot(operation) },
          },
        );
      }
      throw error;
    } finally {
      lifecycle.release();
    }
  }

  async #invoke(method, input, { readOnly = false, afterReconnect, signal, onDispatch } = {}) {
    let activeInput = input;
    let retried = false;
    while (true) {
      let dispatchedGeneration;
      try {
        const { value, operation } = await this.#call(method, activeInput, {
          signal,
          mutating: !readOnly,
          onDispatch: (generation) => {
            dispatchedGeneration = generation;
            onDispatch?.(generation);
          },
        });
        return unwrapToolResult(method, value, operation);
      } catch (error) {
        if (
          !readOnly ||
          retried ||
          !RECONNECTABLE_SESSION_CODES.has(error?.code) ||
          typeof this.#sessionFactory !== "function"
        ) {
          throw error;
        }
        await this.#reconnect(dispatchedGeneration, { signal });
        activeInput = afterReconnect ? await afterReconnect() : input;
        retried = true;
      }
    }
  }

  get connectionGeneration() {
    return this.#connectionGeneration;
  }

  async getPlatform(options = {}) {
    this.#requireOpen();
    requireDispatchableSignal("getPlatform", options.signal);
    if (typeof this.#owner?.listToolsJson !== "function") {
      throw new ComputerUseError("the connected driver does not report its platform", {
        code: "driver_platform_unavailable",
      });
    }
    const raw = await awaitNativeTerminal(this.#owner.listToolsJson(), options.signal);
    let platform;
    try {
      platform = JSON.parse(raw)?.platform;
    } catch {
      throw new ComputerUseError("the connected driver returned invalid platform metadata", {
        code: "driver_platform_unavailable",
      });
    }
    if (!["macos", "windows", "linux"].includes(platform)) {
      throw new ComputerUseError("the connected driver did not report a supported platform; update the driver and SDK", {
        code: "driver_platform_unavailable",
      });
    }
    return platform;
  }

  async sessionInfo(options = {}) {
    const { value } = await this.#call("getSession", {}, options);
    return value;
  }

  async reconnect(options = {}) {
    this.#requireOpen();
    if (!this.#ownsSession || typeof this.#sessionFactory !== "function") {
      throw new ComputerUseError("this ComputerUse instance cannot reconnect", {
        code: "reconnect_unavailable",
      });
    }
    return this.#reconnect(this.#connectionGeneration, options);
  }

  async #reconnect(expectedGeneration, { signal } = {}) {
    this.#requireOpen();
    if (expectedGeneration !== this.#connectionGeneration) {
      return { connectionGeneration: this.#connectionGeneration };
    }
    if (this.#reconnectPromise) {
      return this.#reconnectPromise;
    }

    const previous = this.#driver;
    const lifecycle = beginOperation("reconnect", signal);
    const operation = (async () => {
      try {
        if (lifecycle.operation.cancellationRequested) {
          cancelledBeforeDispatch("reconnect", lifecycle.operation);
        }
        lifecycle.operation.state = "dispatched";
        lifecycle.operation.dispatched = true;
        await destroySessionHandle(previous);
        this.#driver = undefined;
        let replacement;
        const replacementPublicSession =
          this.#publicSession === undefined ? undefined : randomUUID();
        try {
          replacement = await awaitNativeTerminal(
            this.#sessionFactory(replacementPublicSession),
            signal,
          );
        } catch (error) {
          if (this.#closed) throw new ComputerUseError("ComputerUse instance is closed");
          throw new ComputerUseError("failed to create a replacement CUA session", {
            code: "reconnect_failed",
            details: { cause: error },
          });
        }

        if (this.#closed || expectedGeneration !== this.#connectionGeneration) {
          await destroySessionHandle(replacement);
          if (this.#closed) throw new ComputerUseError("ComputerUse instance is closed");
          return { connectionGeneration: this.#connectionGeneration };
        }
        this.#driver = replacement;
        if (replacementPublicSession !== undefined) {
          this.#publicSession = replacementPublicSession;
        }
        this.#connectionGeneration += 1;
            lifecycle.operation.state = "committed";
        lifecycle.operation.committed = true;
        lifecycle.operation.state = "completed";
        return {
          connectionGeneration: this.#connectionGeneration,
          operation: operationSnapshot(lifecycle.operation),
        };
      } finally {
        if (lifecycle.operation.state !== "completed") {
          lifecycle.operation.state = "completed";
        }
        lifecycle.release();
      }
    })();
    this.#reconnectPromise = operation;
    const clearReconnect = () => {
      if (this.#reconnectPromise === operation) this.#reconnectPromise = undefined;
    };
    void operation.then(clearReconnect, clearReconnect);
    return operation;
  }

  async appCall(name, args = {}, { signal } = {}) {
    const readOnly = manifest.tools.find((tool) => tool.name === name)?.read_only === true;
    return this.#invoke('callTool', { name, args }, { signal, readOnly });
  }

  async getState(options = {}) {
    return this.appCall('get_state', {}, { ...options, readOnly: true });
  }

  async getApp(selector, options = {}) {
    const initial = await this.appCall('get_app', { app: selector }, options);
    const id = initial.structured.app;
    if (!this.#apps.has(id)) {
      this.#apps.set(id, new ComputerUseApp(this, id, initial.structured.name));
    }
    return { app: this.#apps.get(id), initial };
  }

  /** Close the bound session, then the owning runtime/client handle. */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#apps.clear();
    let failure;
    if (this.#ownsSession && typeof this.#driver?.endSession === "function") {
      try {
        await this.#driver.endSession({ session: this.#publicSession });
      } catch (error) {
        failure = error;
      }
    }
    if (this.#ownsSession) {
      try {
        await destroySessionHandle(this.#driver);
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      await destroyOwner(this.#owner);
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  }
}
