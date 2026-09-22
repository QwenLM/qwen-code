// Force strict mode and setup for ESM
"use strict";
import {
  require_abort_controller,
  require_lib
} from "./chunk-DI35ZN7T.js";
import {
  Blob,
  File,
  isFile,
  isFunction
} from "./chunk-QMGX2KO2.js";
import {
  parseToolCallArguments,
  resolveStreamIdleTimeoutMs,
  resolveStreamMaxLifetimeMs,
  withStreamGuards
} from "./chunk-ACDUHDYG.js";
import {
  convertSchema
} from "./chunk-CF5KXZZX.js";
import {
  runtimeDiagnostics
} from "./chunk-VNOVK4I7.js";
import {
  reportAnthropicEvent,
  reportAnthropicFollowingRequest,
  reportAnthropicRequest,
  reportAnthropicResponse
} from "./chunk-736AZVPL.js";
import {
  InvalidStreamError,
  isRetryableStatuslessUpstreamError,
  isRetryableStreamTransportError,
  setToolCallPreparations
} from "./chunk-S7UQ3V2H.js";
import "./chunk-QE36VXWP.js";
import {
  safeJsonParse,
  setGenAiUsageProvenance
} from "./chunk-BA6AXQDA.js";
import {
  isResponsesReasoningSignature
} from "./chunk-KP2FHIFR.js";
import {
  anthropicSupportedEffortTiers,
  buildSessionAwareFetch,
  getEffectiveReasoning,
  parseClaudeModelVersion,
  resolveReasoningForModel,
  resolveRequestTimeout
} from "./chunk-TLS6QN2S.js";
import {
  classifyRetryError
} from "./chunk-YSD6IY6F.js";
import {
  createChildAbortController
} from "./chunk-DJ2GSRLV.js";
import "./chunk-MS4SXNJ6.js";
import "./chunk-5WV5S2GT.js";
import "./chunk-XWRJCPHC.js";
import {
  normalizeMcpToolName
} from "./chunk-WZAD4ZNJ.js";
import {
  clampReasoningEffort,
  defaultOutputCeiling,
  hasExplicitOutputLimit,
  parsePositiveIntegerEnvValue,
  reconcileMaxTokens,
  tokenLimit
} from "./chunk-KUON6Z6R.js";
import "./chunk-XZA32HII.js";
import {
  buildRuntimeFetchOptions,
  redactProxyError
} from "./chunk-SBP43AO6.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  getErrorStatus
} from "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import {
  require_ms
} from "./chunk-YQ3U5MUC.js";
import {
  FinishReason,
  GenerateContentResponse
} from "./chunk-EFT7OMDN.js";
import "./chunk-MATEIJZF.js";
import "./chunk-J5TTWBZK.js";
import "./chunk-RVIGZBIT.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __commonJS,
  __name,
  __require,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// node_modules/humanize-ms/index.js
var require_humanize_ms = __commonJS({
  "node_modules/humanize-ms/index.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var util = __require("util");
    var ms = require_ms();
    module.exports = function(t) {
      if (typeof t === "number") return t;
      var r = ms(t);
      if (r === void 0) {
        var err = new Error(util.format("humanize-ms(%j) result undefined", t));
        console.warn(err.stack);
      }
      return r;
    };
  }
});

// node_modules/agentkeepalive/lib/constants.js
var require_constants = __commonJS({
  "node_modules/agentkeepalive/lib/constants.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    module.exports = {
      // agent
      CURRENT_ID: Symbol("agentkeepalive#currentId"),
      CREATE_ID: Symbol("agentkeepalive#createId"),
      INIT_SOCKET: Symbol("agentkeepalive#initSocket"),
      CREATE_HTTPS_CONNECTION: Symbol("agentkeepalive#createHttpsConnection"),
      // socket
      SOCKET_CREATED_TIME: Symbol("agentkeepalive#socketCreatedTime"),
      SOCKET_NAME: Symbol("agentkeepalive#socketName"),
      SOCKET_REQUEST_COUNT: Symbol("agentkeepalive#socketRequestCount"),
      SOCKET_REQUEST_FINISHED_COUNT: Symbol("agentkeepalive#socketRequestFinishedCount")
    };
  }
});

// node_modules/agentkeepalive/lib/agent.js
var require_agent = __commonJS({
  "node_modules/agentkeepalive/lib/agent.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var OriginalAgent = __require("http").Agent;
    var ms = require_humanize_ms();
    var debug2 = __require("util").debuglog("agentkeepalive");
    var {
      INIT_SOCKET,
      CURRENT_ID,
      CREATE_ID,
      SOCKET_CREATED_TIME,
      SOCKET_NAME,
      SOCKET_REQUEST_COUNT,
      SOCKET_REQUEST_FINISHED_COUNT
    } = require_constants();
    var defaultTimeoutListenerCount = 1;
    var majorVersion = parseInt(process.version.split(".", 1)[0].substring(1));
    if (majorVersion >= 11 && majorVersion <= 12) {
      defaultTimeoutListenerCount = 2;
    } else if (majorVersion >= 13) {
      defaultTimeoutListenerCount = 3;
    }
    function deprecate2(message) {
      console.log("[agentkeepalive:deprecated] %s", message);
    }
    __name(deprecate2, "deprecate");
    var Agent = class extends OriginalAgent {
      static {
        __name(this, "Agent");
      }
      constructor(options) {
        options = options || {};
        options.keepAlive = options.keepAlive !== false;
        if (options.freeSocketTimeout === void 0) {
          options.freeSocketTimeout = 4e3;
        }
        if (options.keepAliveTimeout) {
          deprecate2("options.keepAliveTimeout is deprecated, please use options.freeSocketTimeout instead");
          options.freeSocketTimeout = options.keepAliveTimeout;
          delete options.keepAliveTimeout;
        }
        if (options.freeSocketKeepAliveTimeout) {
          deprecate2("options.freeSocketKeepAliveTimeout is deprecated, please use options.freeSocketTimeout instead");
          options.freeSocketTimeout = options.freeSocketKeepAliveTimeout;
          delete options.freeSocketKeepAliveTimeout;
        }
        if (options.timeout === void 0) {
          options.timeout = Math.max(options.freeSocketTimeout * 2, 8e3);
        }
        options.timeout = ms(options.timeout);
        options.freeSocketTimeout = ms(options.freeSocketTimeout);
        options.socketActiveTTL = options.socketActiveTTL ? ms(options.socketActiveTTL) : 0;
        super(options);
        this[CURRENT_ID] = 0;
        this.createSocketCount = 0;
        this.createSocketCountLastCheck = 0;
        this.createSocketErrorCount = 0;
        this.createSocketErrorCountLastCheck = 0;
        this.closeSocketCount = 0;
        this.closeSocketCountLastCheck = 0;
        this.errorSocketCount = 0;
        this.errorSocketCountLastCheck = 0;
        this.requestCount = 0;
        this.requestCountLastCheck = 0;
        this.timeoutSocketCount = 0;
        this.timeoutSocketCountLastCheck = 0;
        this.on("free", (socket) => {
          const timeout = this.calcSocketTimeout(socket);
          if (timeout > 0 && socket.timeout !== timeout) {
            socket.setTimeout(timeout);
          }
        });
      }
      get freeSocketKeepAliveTimeout() {
        deprecate2("agent.freeSocketKeepAliveTimeout is deprecated, please use agent.options.freeSocketTimeout instead");
        return this.options.freeSocketTimeout;
      }
      get timeout() {
        deprecate2("agent.timeout is deprecated, please use agent.options.timeout instead");
        return this.options.timeout;
      }
      get socketActiveTTL() {
        deprecate2("agent.socketActiveTTL is deprecated, please use agent.options.socketActiveTTL instead");
        return this.options.socketActiveTTL;
      }
      calcSocketTimeout(socket) {
        let freeSocketTimeout = this.options.freeSocketTimeout;
        const socketActiveTTL = this.options.socketActiveTTL;
        if (socketActiveTTL) {
          const aliveTime = Date.now() - socket[SOCKET_CREATED_TIME];
          const diff = socketActiveTTL - aliveTime;
          if (diff <= 0) {
            return diff;
          }
          if (freeSocketTimeout && diff < freeSocketTimeout) {
            freeSocketTimeout = diff;
          }
        }
        if (freeSocketTimeout) {
          const customFreeSocketTimeout = socket.freeSocketTimeout || socket.freeSocketKeepAliveTimeout;
          return customFreeSocketTimeout || freeSocketTimeout;
        }
      }
      keepSocketAlive(socket) {
        const result = super.keepSocketAlive(socket);
        if (!result) return result;
        const customTimeout = this.calcSocketTimeout(socket);
        if (typeof customTimeout === "undefined") {
          return true;
        }
        if (customTimeout <= 0) {
          debug2(
            "%s(requests: %s, finished: %s) free but need to destroy by TTL, request count %s, diff is %s",
            socket[SOCKET_NAME],
            socket[SOCKET_REQUEST_COUNT],
            socket[SOCKET_REQUEST_FINISHED_COUNT],
            customTimeout
          );
          return false;
        }
        if (socket.timeout !== customTimeout) {
          socket.setTimeout(customTimeout);
        }
        return true;
      }
      // only call on addRequest
      reuseSocket(...args) {
        super.reuseSocket(...args);
        const socket = args[0];
        const req = args[1];
        req.reusedSocket = true;
        const agentTimeout = this.options.timeout;
        if (getSocketTimeout(socket) !== agentTimeout) {
          socket.setTimeout(agentTimeout);
          debug2("%s reset timeout to %sms", socket[SOCKET_NAME], agentTimeout);
        }
        socket[SOCKET_REQUEST_COUNT]++;
        debug2(
          "%s(requests: %s, finished: %s) reuse on addRequest, timeout %sms",
          socket[SOCKET_NAME],
          socket[SOCKET_REQUEST_COUNT],
          socket[SOCKET_REQUEST_FINISHED_COUNT],
          getSocketTimeout(socket)
        );
      }
      [CREATE_ID]() {
        const id = this[CURRENT_ID]++;
        if (this[CURRENT_ID] === Number.MAX_SAFE_INTEGER) this[CURRENT_ID] = 0;
        return id;
      }
      [INIT_SOCKET](socket, options) {
        if (options.timeout) {
          const timeout = getSocketTimeout(socket);
          if (!timeout) {
            socket.setTimeout(options.timeout);
          }
        }
        if (this.options.keepAlive) {
          socket.setNoDelay(true);
        }
        this.createSocketCount++;
        if (this.options.socketActiveTTL) {
          socket[SOCKET_CREATED_TIME] = Date.now();
        }
        socket[SOCKET_NAME] = `sock[${this[CREATE_ID]()}#${options._agentKey}]`.split("-----BEGIN", 1)[0];
        socket[SOCKET_REQUEST_COUNT] = 1;
        socket[SOCKET_REQUEST_FINISHED_COUNT] = 0;
        installListeners(this, socket, options);
      }
      createConnection(options, oncreate) {
        let called = false;
        const onNewCreate = /* @__PURE__ */ __name((err, socket) => {
          if (called) return;
          called = true;
          if (err) {
            this.createSocketErrorCount++;
            return oncreate(err);
          }
          this[INIT_SOCKET](socket, options);
          oncreate(err, socket);
        }, "onNewCreate");
        const newSocket = super.createConnection(options, onNewCreate);
        if (newSocket) onNewCreate(null, newSocket);
        return newSocket;
      }
      get statusChanged() {
        const changed = this.createSocketCount !== this.createSocketCountLastCheck || this.createSocketErrorCount !== this.createSocketErrorCountLastCheck || this.closeSocketCount !== this.closeSocketCountLastCheck || this.errorSocketCount !== this.errorSocketCountLastCheck || this.timeoutSocketCount !== this.timeoutSocketCountLastCheck || this.requestCount !== this.requestCountLastCheck;
        if (changed) {
          this.createSocketCountLastCheck = this.createSocketCount;
          this.createSocketErrorCountLastCheck = this.createSocketErrorCount;
          this.closeSocketCountLastCheck = this.closeSocketCount;
          this.errorSocketCountLastCheck = this.errorSocketCount;
          this.timeoutSocketCountLastCheck = this.timeoutSocketCount;
          this.requestCountLastCheck = this.requestCount;
        }
        return changed;
      }
      getCurrentStatus() {
        return {
          createSocketCount: this.createSocketCount,
          createSocketErrorCount: this.createSocketErrorCount,
          closeSocketCount: this.closeSocketCount,
          errorSocketCount: this.errorSocketCount,
          timeoutSocketCount: this.timeoutSocketCount,
          requestCount: this.requestCount,
          freeSockets: inspect2(this.freeSockets),
          sockets: inspect2(this.sockets),
          requests: inspect2(this.requests)
        };
      }
    };
    function getSocketTimeout(socket) {
      return socket.timeout || socket._idleTimeout;
    }
    __name(getSocketTimeout, "getSocketTimeout");
    function installListeners(agent, socket, options) {
      debug2("%s create, timeout %sms", socket[SOCKET_NAME], getSocketTimeout(socket));
      function onFree() {
        if (!socket._httpMessage && socket[SOCKET_REQUEST_COUNT] === 1) return;
        socket[SOCKET_REQUEST_FINISHED_COUNT]++;
        agent.requestCount++;
        debug2(
          "%s(requests: %s, finished: %s) free",
          socket[SOCKET_NAME],
          socket[SOCKET_REQUEST_COUNT],
          socket[SOCKET_REQUEST_FINISHED_COUNT]
        );
        const name = agent.getName(options);
        if (socket.writable && agent.requests[name] && agent.requests[name].length) {
          socket[SOCKET_REQUEST_COUNT]++;
          debug2(
            "%s(requests: %s, finished: %s) will be reuse on agent free event",
            socket[SOCKET_NAME],
            socket[SOCKET_REQUEST_COUNT],
            socket[SOCKET_REQUEST_FINISHED_COUNT]
          );
        }
      }
      __name(onFree, "onFree");
      socket.on("free", onFree);
      function onClose(isError) {
        debug2(
          "%s(requests: %s, finished: %s) close, isError: %s",
          socket[SOCKET_NAME],
          socket[SOCKET_REQUEST_COUNT],
          socket[SOCKET_REQUEST_FINISHED_COUNT],
          isError
        );
        agent.closeSocketCount++;
      }
      __name(onClose, "onClose");
      socket.on("close", onClose);
      function onTimeout() {
        const listenerCount = socket.listeners("timeout").length;
        const timeout = getSocketTimeout(socket);
        const req = socket._httpMessage;
        const reqTimeoutListenerCount = req && req.listeners("timeout").length || 0;
        debug2(
          "%s(requests: %s, finished: %s) timeout after %sms, listeners %s, defaultTimeoutListenerCount %s, hasHttpRequest %s, HttpRequest timeoutListenerCount %s",
          socket[SOCKET_NAME],
          socket[SOCKET_REQUEST_COUNT],
          socket[SOCKET_REQUEST_FINISHED_COUNT],
          timeout,
          listenerCount,
          defaultTimeoutListenerCount,
          !!req,
          reqTimeoutListenerCount
        );
        if (debug2.enabled) {
          debug2("timeout listeners: %s", socket.listeners("timeout").map((f) => f.name).join(", "));
        }
        agent.timeoutSocketCount++;
        const name = agent.getName(options);
        if (agent.freeSockets[name] && agent.freeSockets[name].indexOf(socket) !== -1) {
          socket.destroy();
          agent.removeSocket(socket, options);
          debug2("%s is free, destroy quietly", socket[SOCKET_NAME]);
        } else {
          if (reqTimeoutListenerCount === 0) {
            const error = new Error("Socket timeout");
            error.code = "ERR_SOCKET_TIMEOUT";
            error.timeout = timeout;
            socket.destroy(error);
            agent.removeSocket(socket, options);
            debug2("%s destroy with timeout error", socket[SOCKET_NAME]);
          }
        }
      }
      __name(onTimeout, "onTimeout");
      socket.on("timeout", onTimeout);
      function onError(err) {
        const listenerCount = socket.listeners("error").length;
        debug2(
          "%s(requests: %s, finished: %s) error: %s, listenerCount: %s",
          socket[SOCKET_NAME],
          socket[SOCKET_REQUEST_COUNT],
          socket[SOCKET_REQUEST_FINISHED_COUNT],
          err,
          listenerCount
        );
        agent.errorSocketCount++;
        if (listenerCount === 1) {
          debug2("%s emit uncaught error event", socket[SOCKET_NAME]);
          socket.removeListener("error", onError);
          socket.emit("error", err);
        }
      }
      __name(onError, "onError");
      socket.on("error", onError);
      function onRemove() {
        debug2(
          "%s(requests: %s, finished: %s) agentRemove",
          socket[SOCKET_NAME],
          socket[SOCKET_REQUEST_COUNT],
          socket[SOCKET_REQUEST_FINISHED_COUNT]
        );
        socket.removeListener("close", onClose);
        socket.removeListener("error", onError);
        socket.removeListener("free", onFree);
        socket.removeListener("timeout", onTimeout);
        socket.removeListener("agentRemove", onRemove);
      }
      __name(onRemove, "onRemove");
      socket.on("agentRemove", onRemove);
    }
    __name(installListeners, "installListeners");
    module.exports = Agent;
    function inspect2(obj) {
      const res = {};
      for (const key in obj) {
        res[key] = obj[key].length;
      }
      return res;
    }
    __name(inspect2, "inspect");
  }
});

// node_modules/agentkeepalive/lib/https_agent.js
var require_https_agent = __commonJS({
  "node_modules/agentkeepalive/lib/https_agent.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var OriginalHttpsAgent = __require("https").Agent;
    var HttpAgent = require_agent();
    var {
      INIT_SOCKET,
      CREATE_HTTPS_CONNECTION
    } = require_constants();
    var HttpsAgent = class extends HttpAgent {
      static {
        __name(this, "HttpsAgent");
      }
      constructor(options) {
        super(options);
        this.defaultPort = 443;
        this.protocol = "https:";
        this.maxCachedSessions = this.options.maxCachedSessions;
        if (this.maxCachedSessions === void 0) {
          this.maxCachedSessions = 100;
        }
        this._sessionCache = {
          map: {},
          list: []
        };
      }
      createConnection(options, oncreate) {
        const socket = this[CREATE_HTTPS_CONNECTION](options, oncreate);
        this[INIT_SOCKET](socket, options);
        return socket;
      }
    };
    HttpsAgent.prototype[CREATE_HTTPS_CONNECTION] = OriginalHttpsAgent.prototype.createConnection;
    [
      "getName",
      "_getSession",
      "_cacheSession",
      // https://github.com/nodejs/node/pull/4982
      "_evictSession"
    ].forEach(function(method) {
      if (typeof OriginalHttpsAgent.prototype[method] === "function") {
        HttpsAgent.prototype[method] = OriginalHttpsAgent.prototype[method];
      }
    });
    module.exports = HttpsAgent;
  }
});

// node_modules/agentkeepalive/index.js
var require_agentkeepalive = __commonJS({
  "node_modules/agentkeepalive/index.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var HttpAgent = require_agent();
    module.exports = HttpAgent;
    module.exports.HttpAgent = HttpAgent;
    module.exports.HttpsAgent = require_https_agent();
    module.exports.constants = require_constants();
  }
});

// packages/core/src/core/anthropicContentGenerator/index.ts
init_esbuild_shims();

// packages/core/src/core/anthropicContentGenerator/anthropicContentGenerator.ts
init_esbuild_shims();

// node_modules/@anthropic-ai/sdk/index.mjs
init_esbuild_shims();

// node_modules/@anthropic-ai/sdk/core.mjs
init_esbuild_shims();

// node_modules/@anthropic-ai/sdk/version.mjs
init_esbuild_shims();
var VERSION = "0.36.3";

// node_modules/@anthropic-ai/sdk/streaming.mjs
init_esbuild_shims();

// node_modules/@anthropic-ai/sdk/_shims/index.mjs
init_esbuild_shims();

// node_modules/@anthropic-ai/sdk/_shims/registry.mjs
init_esbuild_shims();
var auto = false;
var kind = void 0;
var fetch = void 0;
var Request = void 0;
var Response = void 0;
var Headers = void 0;
var FormData = void 0;
var Blob2 = void 0;
var File2 = void 0;
var ReadableStream = void 0;
var getMultipartRequestOptions = void 0;
var getDefaultAgent = void 0;
var fileFromPath = void 0;
var isFsReadStream = void 0;
function setShims(shims, options = { auto: false }) {
  if (auto) {
    throw new Error(`you must \`import '@anthropic-ai/sdk/shims/${shims.kind}'\` before importing anything else from @anthropic-ai/sdk`);
  }
  if (kind) {
    throw new Error(`can't \`import '@anthropic-ai/sdk/shims/${shims.kind}'\` after \`import '@anthropic-ai/sdk/shims/${kind}'\``);
  }
  auto = options.auto;
  kind = shims.kind;
  fetch = shims.fetch;
  Request = shims.Request;
  Response = shims.Response;
  Headers = shims.Headers;
  FormData = shims.FormData;
  Blob2 = shims.Blob;
  File2 = shims.File;
  ReadableStream = shims.ReadableStream;
  getMultipartRequestOptions = shims.getMultipartRequestOptions;
  getDefaultAgent = shims.getDefaultAgent;
  fileFromPath = shims.fileFromPath;
  isFsReadStream = shims.isFsReadStream;
}
__name(setShims, "setShims");

// node_modules/@anthropic-ai/sdk/_shims/node-runtime.mjs
init_esbuild_shims();
var nf = __toESM(require_lib(), 1);

// node_modules/formdata-node/lib/esm/index.js
init_esbuild_shims();

// node_modules/formdata-node/lib/esm/FormData.js
init_esbuild_shims();
import { inspect } from "util";

// node_modules/formdata-node/lib/esm/isBlob.js
init_esbuild_shims();
var isBlob = /* @__PURE__ */ __name((value) => value instanceof Blob, "isBlob");

// node_modules/formdata-node/lib/esm/deprecateConstructorEntries.js
init_esbuild_shims();
import { deprecate } from "util";
var deprecateConstructorEntries = deprecate(() => {
}, 'Constructor "entries" argument is not spec-compliant and will be removed in next major release.');

// node_modules/formdata-node/lib/esm/FormData.js
var __classPrivateFieldGet = function(receiver, state, kind2, f) {
  if (kind2 === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind2 === "m" ? f : kind2 === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _FormData_instances;
var _FormData_entries;
var _FormData_setEntry;
var FormData2 = class {
  static {
    __name(this, "FormData");
  }
  constructor(entries) {
    _FormData_instances.add(this);
    _FormData_entries.set(this, /* @__PURE__ */ new Map());
    if (entries) {
      deprecateConstructorEntries();
      entries.forEach(({ name, value, fileName }) => this.append(name, value, fileName));
    }
  }
  static [(_FormData_entries = /* @__PURE__ */ new WeakMap(), _FormData_instances = /* @__PURE__ */ new WeakSet(), Symbol.hasInstance)](value) {
    return Boolean(value && isFunction(value.constructor) && value[Symbol.toStringTag] === "FormData" && isFunction(value.append) && isFunction(value.set) && isFunction(value.get) && isFunction(value.getAll) && isFunction(value.has) && isFunction(value.delete) && isFunction(value.entries) && isFunction(value.values) && isFunction(value.keys) && isFunction(value[Symbol.iterator]) && isFunction(value.forEach));
  }
  append(name, value, fileName) {
    __classPrivateFieldGet(this, _FormData_instances, "m", _FormData_setEntry).call(this, {
      name,
      fileName,
      append: true,
      rawValue: value,
      argsLength: arguments.length
    });
  }
  set(name, value, fileName) {
    __classPrivateFieldGet(this, _FormData_instances, "m", _FormData_setEntry).call(this, {
      name,
      fileName,
      append: false,
      rawValue: value,
      argsLength: arguments.length
    });
  }
  get(name) {
    const field = __classPrivateFieldGet(this, _FormData_entries, "f").get(String(name));
    if (!field) {
      return null;
    }
    return field[0];
  }
  getAll(name) {
    const field = __classPrivateFieldGet(this, _FormData_entries, "f").get(String(name));
    if (!field) {
      return [];
    }
    return field.slice();
  }
  has(name) {
    return __classPrivateFieldGet(this, _FormData_entries, "f").has(String(name));
  }
  delete(name) {
    __classPrivateFieldGet(this, _FormData_entries, "f").delete(String(name));
  }
  *keys() {
    for (const key of __classPrivateFieldGet(this, _FormData_entries, "f").keys()) {
      yield key;
    }
  }
  *entries() {
    for (const name of this.keys()) {
      const values = this.getAll(name);
      for (const value of values) {
        yield [name, value];
      }
    }
  }
  *values() {
    for (const [, value] of this) {
      yield value;
    }
  }
  [(_FormData_setEntry = /* @__PURE__ */ __name(function _FormData_setEntry2({ name, rawValue, append, fileName, argsLength }) {
    const methodName = append ? "append" : "set";
    if (argsLength < 2) {
      throw new TypeError(`Failed to execute '${methodName}' on 'FormData': 2 arguments required, but only ${argsLength} present.`);
    }
    name = String(name);
    let value;
    if (isFile(rawValue)) {
      value = fileName === void 0 ? rawValue : new File([rawValue], fileName, {
        type: rawValue.type,
        lastModified: rawValue.lastModified
      });
    } else if (isBlob(rawValue)) {
      value = new File([rawValue], fileName === void 0 ? "blob" : fileName, {
        type: rawValue.type
      });
    } else if (fileName) {
      throw new TypeError(`Failed to execute '${methodName}' on 'FormData': parameter 2 is not of type 'Blob'.`);
    } else {
      value = String(rawValue);
    }
    const values = __classPrivateFieldGet(this, _FormData_entries, "f").get(name);
    if (!values) {
      return void __classPrivateFieldGet(this, _FormData_entries, "f").set(name, [value]);
    }
    if (!append) {
      return void __classPrivateFieldGet(this, _FormData_entries, "f").set(name, [value]);
    }
    values.push(value);
  }, "_FormData_setEntry"), Symbol.iterator)]() {
    return this.entries();
  }
  forEach(callback, thisArg) {
    for (const [name, value] of this) {
      callback.call(thisArg, value, name, this);
    }
  }
  get [Symbol.toStringTag]() {
    return "FormData";
  }
  [inspect.custom]() {
    return this[Symbol.toStringTag];
  }
};

// node_modules/@anthropic-ai/sdk/_shims/node-runtime.mjs
var import_agentkeepalive = __toESM(require_agentkeepalive(), 1);
var import_abort_controller = __toESM(require_abort_controller(), 1);
import { ReadStream as FsReadStream } from "node:fs";

// node_modules/form-data-encoder/lib/esm/index.js
init_esbuild_shims();

// node_modules/form-data-encoder/lib/esm/FormDataEncoder.js
init_esbuild_shims();

// node_modules/form-data-encoder/lib/esm/util/createBoundary.js
init_esbuild_shims();
var alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
function createBoundary() {
  let size = 16;
  let res = "";
  while (size--) {
    res += alphabet[Math.random() * alphabet.length << 0];
  }
  return res;
}
__name(createBoundary, "createBoundary");
var createBoundary_default = createBoundary;

// node_modules/form-data-encoder/lib/esm/util/isPlainObject.js
init_esbuild_shims();
var getType = /* @__PURE__ */ __name((value) => Object.prototype.toString.call(value).slice(8, -1).toLowerCase(), "getType");
function isPlainObject(value) {
  if (getType(value) !== "object") {
    return false;
  }
  const pp = Object.getPrototypeOf(value);
  if (pp === null || pp === void 0) {
    return true;
  }
  const Ctor = pp.constructor && pp.constructor.toString();
  return Ctor === Object.toString();
}
__name(isPlainObject, "isPlainObject");
var isPlainObject_default = isPlainObject;

// node_modules/form-data-encoder/lib/esm/util/normalizeValue.js
init_esbuild_shims();
var normalizeValue = /* @__PURE__ */ __name((value) => String(value).replace(/\r|\n/g, (match, i, str) => {
  if (match === "\r" && str[i + 1] !== "\n" || match === "\n" && str[i - 1] !== "\r") {
    return "\r\n";
  }
  return match;
}), "normalizeValue");
var normalizeValue_default = normalizeValue;

// node_modules/form-data-encoder/lib/esm/util/escapeName.js
init_esbuild_shims();
var escapeName = /* @__PURE__ */ __name((name) => String(name).replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/"/g, "%22"), "escapeName");
var escapeName_default = escapeName;

// node_modules/form-data-encoder/lib/esm/util/isFileLike.js
init_esbuild_shims();

// node_modules/form-data-encoder/lib/esm/util/isFunction.js
init_esbuild_shims();
var isFunction2 = /* @__PURE__ */ __name((value) => typeof value === "function", "isFunction");
var isFunction_default = isFunction2;

// node_modules/form-data-encoder/lib/esm/util/isFileLike.js
var isFileLike = /* @__PURE__ */ __name((value) => Boolean(value && typeof value === "object" && isFunction_default(value.constructor) && value[Symbol.toStringTag] === "File" && isFunction_default(value.stream) && value.name != null && value.size != null && value.lastModified != null), "isFileLike");

// node_modules/form-data-encoder/lib/esm/util/isFormData.js
init_esbuild_shims();
var isFormData = /* @__PURE__ */ __name((value) => Boolean(value && isFunction_default(value.constructor) && value[Symbol.toStringTag] === "FormData" && isFunction_default(value.append) && isFunction_default(value.getAll) && isFunction_default(value.entries) && isFunction_default(value[Symbol.iterator])), "isFormData");

// node_modules/form-data-encoder/lib/esm/FormDataEncoder.js
var __classPrivateFieldSet = function(receiver, state, value, kind2, f) {
  if (kind2 === "m") throw new TypeError("Private method is not writable");
  if (kind2 === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind2 === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
};
var __classPrivateFieldGet2 = function(receiver, state, kind2, f) {
  if (kind2 === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind2 === "m" ? f : kind2 === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _FormDataEncoder_instances;
var _FormDataEncoder_CRLF;
var _FormDataEncoder_CRLF_BYTES;
var _FormDataEncoder_CRLF_BYTES_LENGTH;
var _FormDataEncoder_DASHES;
var _FormDataEncoder_encoder;
var _FormDataEncoder_footer;
var _FormDataEncoder_form;
var _FormDataEncoder_options;
var _FormDataEncoder_getFieldHeader;
var defaultOptions = {
  enableAdditionalHeaders: false
};
var FormDataEncoder = class {
  static {
    __name(this, "FormDataEncoder");
  }
  constructor(form, boundaryOrOptions, options) {
    _FormDataEncoder_instances.add(this);
    _FormDataEncoder_CRLF.set(this, "\r\n");
    _FormDataEncoder_CRLF_BYTES.set(this, void 0);
    _FormDataEncoder_CRLF_BYTES_LENGTH.set(this, void 0);
    _FormDataEncoder_DASHES.set(this, "-".repeat(2));
    _FormDataEncoder_encoder.set(this, new TextEncoder());
    _FormDataEncoder_footer.set(this, void 0);
    _FormDataEncoder_form.set(this, void 0);
    _FormDataEncoder_options.set(this, void 0);
    if (!isFormData(form)) {
      throw new TypeError("Expected first argument to be a FormData instance.");
    }
    let boundary;
    if (isPlainObject_default(boundaryOrOptions)) {
      options = boundaryOrOptions;
    } else {
      boundary = boundaryOrOptions;
    }
    if (!boundary) {
      boundary = createBoundary_default();
    }
    if (typeof boundary !== "string") {
      throw new TypeError("Expected boundary argument to be a string.");
    }
    if (options && !isPlainObject_default(options)) {
      throw new TypeError("Expected options argument to be an object.");
    }
    __classPrivateFieldSet(this, _FormDataEncoder_form, form, "f");
    __classPrivateFieldSet(this, _FormDataEncoder_options, { ...defaultOptions, ...options }, "f");
    __classPrivateFieldSet(this, _FormDataEncoder_CRLF_BYTES, __classPrivateFieldGet2(this, _FormDataEncoder_encoder, "f").encode(__classPrivateFieldGet2(this, _FormDataEncoder_CRLF, "f")), "f");
    __classPrivateFieldSet(this, _FormDataEncoder_CRLF_BYTES_LENGTH, __classPrivateFieldGet2(this, _FormDataEncoder_CRLF_BYTES, "f").byteLength, "f");
    this.boundary = `form-data-boundary-${boundary}`;
    this.contentType = `multipart/form-data; boundary=${this.boundary}`;
    __classPrivateFieldSet(this, _FormDataEncoder_footer, __classPrivateFieldGet2(this, _FormDataEncoder_encoder, "f").encode(`${__classPrivateFieldGet2(this, _FormDataEncoder_DASHES, "f")}${this.boundary}${__classPrivateFieldGet2(this, _FormDataEncoder_DASHES, "f")}${__classPrivateFieldGet2(this, _FormDataEncoder_CRLF, "f").repeat(2)}`), "f");
    this.contentLength = String(this.getContentLength());
    this.headers = Object.freeze({
      "Content-Type": this.contentType,
      "Content-Length": this.contentLength
    });
    Object.defineProperties(this, {
      boundary: { writable: false, configurable: false },
      contentType: { writable: false, configurable: false },
      contentLength: { writable: false, configurable: false },
      headers: { writable: false, configurable: false }
    });
  }
  getContentLength() {
    let length = 0;
    for (const [name, raw] of __classPrivateFieldGet2(this, _FormDataEncoder_form, "f")) {
      const value = isFileLike(raw) ? raw : __classPrivateFieldGet2(this, _FormDataEncoder_encoder, "f").encode(normalizeValue_default(raw));
      length += __classPrivateFieldGet2(this, _FormDataEncoder_instances, "m", _FormDataEncoder_getFieldHeader).call(this, name, value).byteLength;
      length += isFileLike(value) ? value.size : value.byteLength;
      length += __classPrivateFieldGet2(this, _FormDataEncoder_CRLF_BYTES_LENGTH, "f");
    }
    return length + __classPrivateFieldGet2(this, _FormDataEncoder_footer, "f").byteLength;
  }
  *values() {
    for (const [name, raw] of __classPrivateFieldGet2(this, _FormDataEncoder_form, "f").entries()) {
      const value = isFileLike(raw) ? raw : __classPrivateFieldGet2(this, _FormDataEncoder_encoder, "f").encode(normalizeValue_default(raw));
      yield __classPrivateFieldGet2(this, _FormDataEncoder_instances, "m", _FormDataEncoder_getFieldHeader).call(this, name, value);
      yield value;
      yield __classPrivateFieldGet2(this, _FormDataEncoder_CRLF_BYTES, "f");
    }
    yield __classPrivateFieldGet2(this, _FormDataEncoder_footer, "f");
  }
  async *encode() {
    for (const part of this.values()) {
      if (isFileLike(part)) {
        yield* part.stream();
      } else {
        yield part;
      }
    }
  }
  [(_FormDataEncoder_CRLF = /* @__PURE__ */ new WeakMap(), _FormDataEncoder_CRLF_BYTES = /* @__PURE__ */ new WeakMap(), _FormDataEncoder_CRLF_BYTES_LENGTH = /* @__PURE__ */ new WeakMap(), _FormDataEncoder_DASHES = /* @__PURE__ */ new WeakMap(), _FormDataEncoder_encoder = /* @__PURE__ */ new WeakMap(), _FormDataEncoder_footer = /* @__PURE__ */ new WeakMap(), _FormDataEncoder_form = /* @__PURE__ */ new WeakMap(), _FormDataEncoder_options = /* @__PURE__ */ new WeakMap(), _FormDataEncoder_instances = /* @__PURE__ */ new WeakSet(), _FormDataEncoder_getFieldHeader = /* @__PURE__ */ __name(function _FormDataEncoder_getFieldHeader2(name, value) {
    let header = "";
    header += `${__classPrivateFieldGet2(this, _FormDataEncoder_DASHES, "f")}${this.boundary}${__classPrivateFieldGet2(this, _FormDataEncoder_CRLF, "f")}`;
    header += `Content-Disposition: form-data; name="${escapeName_default(name)}"`;
    if (isFileLike(value)) {
      header += `; filename="${escapeName_default(value.name)}"${__classPrivateFieldGet2(this, _FormDataEncoder_CRLF, "f")}`;
      header += `Content-Type: ${value.type || "application/octet-stream"}`;
    }
    if (__classPrivateFieldGet2(this, _FormDataEncoder_options, "f").enableAdditionalHeaders === true) {
      header += `${__classPrivateFieldGet2(this, _FormDataEncoder_CRLF, "f")}Content-Length: ${isFileLike(value) ? value.size : value.byteLength}`;
    }
    return __classPrivateFieldGet2(this, _FormDataEncoder_encoder, "f").encode(`${header}${__classPrivateFieldGet2(this, _FormDataEncoder_CRLF, "f").repeat(2)}`);
  }, "_FormDataEncoder_getFieldHeader"), Symbol.iterator)]() {
    return this.values();
  }
  [Symbol.asyncIterator]() {
    return this.encode();
  }
};

// node_modules/form-data-encoder/lib/esm/FileLike.js
init_esbuild_shims();

// node_modules/form-data-encoder/lib/esm/FormDataLike.js
init_esbuild_shims();

// node_modules/@anthropic-ai/sdk/_shims/node-runtime.mjs
import { Readable } from "node:stream";

// node_modules/@anthropic-ai/sdk/_shims/MultipartBody.mjs
init_esbuild_shims();
var MultipartBody = class {
  static {
    __name(this, "MultipartBody");
  }
  constructor(body) {
    this.body = body;
  }
  get [Symbol.toStringTag]() {
    return "MultipartBody";
  }
};

// node_modules/@anthropic-ai/sdk/_shims/node-runtime.mjs
import { ReadableStream as ReadableStream2 } from "node:stream/web";
var fileFromPathWarned = false;
async function fileFromPath2(path, ...args) {
  const { fileFromPath: _fileFromPath } = await import("./fileFromPath-UDALK7FM.js");
  if (!fileFromPathWarned) {
    console.warn(`fileFromPath is deprecated; use fs.createReadStream(${JSON.stringify(path)}) instead`);
    fileFromPathWarned = true;
  }
  return await _fileFromPath(path, ...args);
}
__name(fileFromPath2, "fileFromPath");
var defaultHttpAgent = new import_agentkeepalive.default({ keepAlive: true, timeout: 5 * 60 * 1e3 });
var defaultHttpsAgent = new import_agentkeepalive.default.HttpsAgent({ keepAlive: true, timeout: 5 * 60 * 1e3 });
async function getMultipartRequestOptions2(form, opts) {
  const encoder = new FormDataEncoder(form);
  const readable = Readable.from(encoder);
  const body = new MultipartBody(readable);
  const headers = {
    ...opts.headers,
    ...encoder.headers,
    "Content-Length": encoder.contentLength
  };
  return { ...opts, body, headers };
}
__name(getMultipartRequestOptions2, "getMultipartRequestOptions");
function getRuntime() {
  if (typeof AbortController === "undefined") {
    globalThis.AbortController = import_abort_controller.AbortController;
  }
  return {
    kind: "node",
    fetch: nf.default,
    Request: nf.Request,
    Response: nf.Response,
    Headers: nf.Headers,
    FormData: FormData2,
    Blob,
    File,
    ReadableStream: ReadableStream2,
    getMultipartRequestOptions: getMultipartRequestOptions2,
    getDefaultAgent: /* @__PURE__ */ __name((url) => url.startsWith("https") ? defaultHttpsAgent : defaultHttpAgent, "getDefaultAgent"),
    fileFromPath: fileFromPath2,
    isFsReadStream: /* @__PURE__ */ __name((value) => value instanceof FsReadStream, "isFsReadStream")
  };
}
__name(getRuntime, "getRuntime");

// node_modules/@anthropic-ai/sdk/_shims/index.mjs
if (!kind) setShims(getRuntime(), { auto: true });

// node_modules/@anthropic-ai/sdk/error.mjs
init_esbuild_shims();
var AnthropicError = class extends Error {
  static {
    __name(this, "AnthropicError");
  }
};
var APIError = class _APIError extends AnthropicError {
  static {
    __name(this, "APIError");
  }
  constructor(status, error, message, headers) {
    super(`${_APIError.makeMessage(status, error, message)}`);
    this.status = status;
    this.headers = headers;
    this.request_id = headers?.["request-id"];
    this.error = error;
  }
  static makeMessage(status, error, message) {
    const msg = error?.message ? typeof error.message === "string" ? error.message : JSON.stringify(error.message) : error ? JSON.stringify(error) : message;
    if (status && msg) {
      return `${status} ${msg}`;
    }
    if (status) {
      return `${status} status code (no body)`;
    }
    if (msg) {
      return msg;
    }
    return "(no status code or body)";
  }
  static generate(status, errorResponse, message, headers) {
    if (!status || !headers) {
      return new APIConnectionError({ message, cause: castToError(errorResponse) });
    }
    const error = errorResponse;
    if (status === 400) {
      return new BadRequestError(status, error, message, headers);
    }
    if (status === 401) {
      return new AuthenticationError(status, error, message, headers);
    }
    if (status === 403) {
      return new PermissionDeniedError(status, error, message, headers);
    }
    if (status === 404) {
      return new NotFoundError(status, error, message, headers);
    }
    if (status === 409) {
      return new ConflictError(status, error, message, headers);
    }
    if (status === 422) {
      return new UnprocessableEntityError(status, error, message, headers);
    }
    if (status === 429) {
      return new RateLimitError(status, error, message, headers);
    }
    if (status >= 500) {
      return new InternalServerError(status, error, message, headers);
    }
    return new _APIError(status, error, message, headers);
  }
};
var APIUserAbortError = class extends APIError {
  static {
    __name(this, "APIUserAbortError");
  }
  constructor({ message } = {}) {
    super(void 0, void 0, message || "Request was aborted.", void 0);
  }
};
var APIConnectionError = class extends APIError {
  static {
    __name(this, "APIConnectionError");
  }
  constructor({ message, cause }) {
    super(void 0, void 0, message || "Connection error.", void 0);
    if (cause)
      this.cause = cause;
  }
};
var APIConnectionTimeoutError = class extends APIConnectionError {
  static {
    __name(this, "APIConnectionTimeoutError");
  }
  constructor({ message } = {}) {
    super({ message: message ?? "Request timed out." });
  }
};
var BadRequestError = class extends APIError {
  static {
    __name(this, "BadRequestError");
  }
};
var AuthenticationError = class extends APIError {
  static {
    __name(this, "AuthenticationError");
  }
};
var PermissionDeniedError = class extends APIError {
  static {
    __name(this, "PermissionDeniedError");
  }
};
var NotFoundError = class extends APIError {
  static {
    __name(this, "NotFoundError");
  }
};
var ConflictError = class extends APIError {
  static {
    __name(this, "ConflictError");
  }
};
var UnprocessableEntityError = class extends APIError {
  static {
    __name(this, "UnprocessableEntityError");
  }
};
var RateLimitError = class extends APIError {
  static {
    __name(this, "RateLimitError");
  }
};
var InternalServerError = class extends APIError {
  static {
    __name(this, "InternalServerError");
  }
};

// node_modules/@anthropic-ai/sdk/internal/decoders/line.mjs
init_esbuild_shims();
var LineDecoder = class _LineDecoder {
  static {
    __name(this, "LineDecoder");
  }
  constructor() {
    this.buffer = [];
    this.trailingCR = false;
  }
  decode(chunk) {
    let text = this.decodeText(chunk);
    if (this.trailingCR) {
      text = "\r" + text;
      this.trailingCR = false;
    }
    if (text.endsWith("\r")) {
      this.trailingCR = true;
      text = text.slice(0, -1);
    }
    if (!text) {
      return [];
    }
    const trailingNewline = _LineDecoder.NEWLINE_CHARS.has(text[text.length - 1] || "");
    let lines = text.split(_LineDecoder.NEWLINE_REGEXP);
    if (trailingNewline) {
      lines.pop();
    }
    if (lines.length === 1 && !trailingNewline) {
      this.buffer.push(lines[0]);
      return [];
    }
    if (this.buffer.length > 0) {
      lines = [this.buffer.join("") + lines[0], ...lines.slice(1)];
      this.buffer = [];
    }
    if (!trailingNewline) {
      this.buffer = [lines.pop() || ""];
    }
    return lines;
  }
  decodeText(bytes) {
    if (bytes == null)
      return "";
    if (typeof bytes === "string")
      return bytes;
    if (typeof Buffer !== "undefined") {
      if (bytes instanceof Buffer) {
        return bytes.toString();
      }
      if (bytes instanceof Uint8Array) {
        return Buffer.from(bytes).toString();
      }
      throw new AnthropicError(`Unexpected: received non-Uint8Array (${bytes.constructor.name}) stream chunk in an environment with a global "Buffer" defined, which this library assumes to be Node. Please report this error.`);
    }
    if (typeof TextDecoder !== "undefined") {
      if (bytes instanceof Uint8Array || bytes instanceof ArrayBuffer) {
        this.textDecoder ?? (this.textDecoder = new TextDecoder("utf8"));
        return this.textDecoder.decode(bytes);
      }
      throw new AnthropicError(`Unexpected: received non-Uint8Array/ArrayBuffer (${bytes.constructor.name}) in a web platform. Please report this error.`);
    }
    throw new AnthropicError(`Unexpected: neither Buffer nor TextDecoder are available as globals. Please report this error.`);
  }
  flush() {
    if (!this.buffer.length && !this.trailingCR) {
      return [];
    }
    const lines = [this.buffer.join("")];
    this.buffer = [];
    this.trailingCR = false;
    return lines;
  }
};
LineDecoder.NEWLINE_CHARS = /* @__PURE__ */ new Set(["\n", "\r"]);
LineDecoder.NEWLINE_REGEXP = /\r\n|[\n\r]/g;

// node_modules/@anthropic-ai/sdk/internal/stream-utils.mjs
init_esbuild_shims();
function ReadableStreamToAsyncIterable(stream) {
  if (stream[Symbol.asyncIterator])
    return stream;
  const reader = stream.getReader();
  return {
    async next() {
      try {
        const result = await reader.read();
        if (result?.done)
          reader.releaseLock();
        return result;
      } catch (e) {
        reader.releaseLock();
        throw e;
      }
    },
    async return() {
      const cancelPromise = reader.cancel();
      reader.releaseLock();
      await cancelPromise;
      return { done: true, value: void 0 };
    },
    [Symbol.asyncIterator]() {
      return this;
    }
  };
}
__name(ReadableStreamToAsyncIterable, "ReadableStreamToAsyncIterable");

// node_modules/@anthropic-ai/sdk/streaming.mjs
var Stream = class _Stream {
  static {
    __name(this, "Stream");
  }
  constructor(iterator, controller) {
    this.iterator = iterator;
    this.controller = controller;
  }
  static fromSSEResponse(response, controller) {
    let consumed = false;
    async function* iterator() {
      if (consumed) {
        throw new Error("Cannot iterate over a consumed stream, use `.tee()` to split the stream.");
      }
      consumed = true;
      let done = false;
      try {
        for await (const sse of _iterSSEMessages(response, controller)) {
          if (sse.event === "completion") {
            try {
              yield JSON.parse(sse.data);
            } catch (e) {
              console.error(`Could not parse message into JSON:`, sse.data);
              console.error(`From chunk:`, sse.raw);
              throw e;
            }
          }
          if (sse.event === "message_start" || sse.event === "message_delta" || sse.event === "message_stop" || sse.event === "content_block_start" || sse.event === "content_block_delta" || sse.event === "content_block_stop") {
            try {
              yield JSON.parse(sse.data);
            } catch (e) {
              console.error(`Could not parse message into JSON:`, sse.data);
              console.error(`From chunk:`, sse.raw);
              throw e;
            }
          }
          if (sse.event === "ping") {
            continue;
          }
          if (sse.event === "error") {
            throw APIError.generate(void 0, `SSE Error: ${sse.data}`, sse.data, createResponseHeaders(response.headers));
          }
        }
        done = true;
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError")
          return;
        throw e;
      } finally {
        if (!done)
          controller.abort();
      }
    }
    __name(iterator, "iterator");
    return new _Stream(iterator, controller);
  }
  /**
   * Generates a Stream from a newline-separated ReadableStream
   * where each item is a JSON value.
   */
  static fromReadableStream(readableStream, controller) {
    let consumed = false;
    async function* iterLines() {
      const lineDecoder = new LineDecoder();
      const iter = ReadableStreamToAsyncIterable(readableStream);
      for await (const chunk of iter) {
        for (const line of lineDecoder.decode(chunk)) {
          yield line;
        }
      }
      for (const line of lineDecoder.flush()) {
        yield line;
      }
    }
    __name(iterLines, "iterLines");
    async function* iterator() {
      if (consumed) {
        throw new Error("Cannot iterate over a consumed stream, use `.tee()` to split the stream.");
      }
      consumed = true;
      let done = false;
      try {
        for await (const line of iterLines()) {
          if (done)
            continue;
          if (line)
            yield JSON.parse(line);
        }
        done = true;
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError")
          return;
        throw e;
      } finally {
        if (!done)
          controller.abort();
      }
    }
    __name(iterator, "iterator");
    return new _Stream(iterator, controller);
  }
  [Symbol.asyncIterator]() {
    return this.iterator();
  }
  /**
   * Splits the stream into two streams which can be
   * independently read from at different speeds.
   */
  tee() {
    const left = [];
    const right = [];
    const iterator = this.iterator();
    const teeIterator = /* @__PURE__ */ __name((queue) => {
      return {
        next: /* @__PURE__ */ __name(() => {
          if (queue.length === 0) {
            const result = iterator.next();
            left.push(result);
            right.push(result);
          }
          return queue.shift();
        }, "next")
      };
    }, "teeIterator");
    return [
      new _Stream(() => teeIterator(left), this.controller),
      new _Stream(() => teeIterator(right), this.controller)
    ];
  }
  /**
   * Converts this stream to a newline-separated ReadableStream of
   * JSON stringified values in the stream
   * which can be turned back into a Stream with `Stream.fromReadableStream()`.
   */
  toReadableStream() {
    const self = this;
    let iter;
    const encoder = new TextEncoder();
    return new ReadableStream({
      async start() {
        iter = self[Symbol.asyncIterator]();
      },
      async pull(ctrl) {
        try {
          const { value, done } = await iter.next();
          if (done)
            return ctrl.close();
          const bytes = encoder.encode(JSON.stringify(value) + "\n");
          ctrl.enqueue(bytes);
        } catch (err) {
          ctrl.error(err);
        }
      },
      async cancel() {
        await iter.return?.();
      }
    });
  }
};
async function* _iterSSEMessages(response, controller) {
  if (!response.body) {
    controller.abort();
    throw new AnthropicError(`Attempted to iterate over a response with no body`);
  }
  const sseDecoder = new SSEDecoder();
  const lineDecoder = new LineDecoder();
  const iter = ReadableStreamToAsyncIterable(response.body);
  for await (const sseChunk of iterSSEChunks(iter)) {
    for (const line of lineDecoder.decode(sseChunk)) {
      const sse = sseDecoder.decode(line);
      if (sse)
        yield sse;
    }
  }
  for (const line of lineDecoder.flush()) {
    const sse = sseDecoder.decode(line);
    if (sse)
      yield sse;
  }
}
__name(_iterSSEMessages, "_iterSSEMessages");
async function* iterSSEChunks(iterator) {
  let data = new Uint8Array();
  for await (const chunk of iterator) {
    if (chunk == null) {
      continue;
    }
    const binaryChunk = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    let newData = new Uint8Array(data.length + binaryChunk.length);
    newData.set(data);
    newData.set(binaryChunk, data.length);
    data = newData;
    let patternIndex;
    while ((patternIndex = findDoubleNewlineIndex(data)) !== -1) {
      yield data.slice(0, patternIndex);
      data = data.slice(patternIndex);
    }
  }
  if (data.length > 0) {
    yield data;
  }
}
__name(iterSSEChunks, "iterSSEChunks");
function findDoubleNewlineIndex(buffer) {
  const newline = 10;
  const carriage = 13;
  for (let i = 0; i < buffer.length - 2; i++) {
    if (buffer[i] === newline && buffer[i + 1] === newline) {
      return i + 2;
    }
    if (buffer[i] === carriage && buffer[i + 1] === carriage) {
      return i + 2;
    }
    if (buffer[i] === carriage && buffer[i + 1] === newline && i + 3 < buffer.length && buffer[i + 2] === carriage && buffer[i + 3] === newline) {
      return i + 4;
    }
  }
  return -1;
}
__name(findDoubleNewlineIndex, "findDoubleNewlineIndex");
var SSEDecoder = class {
  static {
    __name(this, "SSEDecoder");
  }
  constructor() {
    this.event = null;
    this.data = [];
    this.chunks = [];
  }
  decode(line) {
    if (line.endsWith("\r")) {
      line = line.substring(0, line.length - 1);
    }
    if (!line) {
      if (!this.event && !this.data.length)
        return null;
      const sse = {
        event: this.event,
        data: this.data.join("\n"),
        raw: this.chunks
      };
      this.event = null;
      this.data = [];
      this.chunks = [];
      return sse;
    }
    this.chunks.push(line);
    if (line.startsWith(":")) {
      return null;
    }
    let [fieldname, _, value] = partition(line, ":");
    if (value.startsWith(" ")) {
      value = value.substring(1);
    }
    if (fieldname === "event") {
      this.event = value;
    } else if (fieldname === "data") {
      this.data.push(value);
    }
    return null;
  }
};
function partition(str, delimiter) {
  const index = str.indexOf(delimiter);
  if (index !== -1) {
    return [str.substring(0, index), delimiter, str.substring(index + delimiter.length)];
  }
  return [str, "", ""];
}
__name(partition, "partition");

// node_modules/@anthropic-ai/sdk/uploads.mjs
init_esbuild_shims();
var isResponseLike = /* @__PURE__ */ __name((value) => value != null && typeof value === "object" && typeof value.url === "string" && typeof value.blob === "function", "isResponseLike");
var isFileLike2 = /* @__PURE__ */ __name((value) => value != null && typeof value === "object" && typeof value.name === "string" && typeof value.lastModified === "number" && isBlobLike(value), "isFileLike");
var isBlobLike = /* @__PURE__ */ __name((value) => value != null && typeof value === "object" && typeof value.size === "number" && typeof value.type === "string" && typeof value.text === "function" && typeof value.slice === "function" && typeof value.arrayBuffer === "function", "isBlobLike");
async function toFile(value, name, options) {
  value = await value;
  if (isFileLike2(value)) {
    return value;
  }
  if (isResponseLike(value)) {
    const blob = await value.blob();
    name || (name = new URL(value.url).pathname.split(/[\\/]/).pop() ?? "unknown_file");
    const data = isBlobLike(blob) ? [await blob.arrayBuffer()] : [blob];
    return new File2(data, name, options);
  }
  const bits = await getBytes(value);
  name || (name = getName(value) ?? "unknown_file");
  if (!options?.type) {
    const type = bits[0]?.type;
    if (typeof type === "string") {
      options = { ...options, type };
    }
  }
  return new File2(bits, name, options);
}
__name(toFile, "toFile");
async function getBytes(value) {
  let parts = [];
  if (typeof value === "string" || ArrayBuffer.isView(value) || // includes Uint8Array, Buffer, etc.
  value instanceof ArrayBuffer) {
    parts.push(value);
  } else if (isBlobLike(value)) {
    parts.push(await value.arrayBuffer());
  } else if (isAsyncIterableIterator(value)) {
    for await (const chunk of value) {
      parts.push(chunk);
    }
  } else {
    throw new Error(`Unexpected data type: ${typeof value}; constructor: ${value?.constructor?.name}; props: ${propsForError(value)}`);
  }
  return parts;
}
__name(getBytes, "getBytes");
function propsForError(value) {
  const props = Object.getOwnPropertyNames(value);
  return `[${props.map((p) => `"${p}"`).join(", ")}]`;
}
__name(propsForError, "propsForError");
function getName(value) {
  return getStringFromMaybeBuffer(value.name) || getStringFromMaybeBuffer(value.filename) || // For fs.ReadStream
  getStringFromMaybeBuffer(value.path)?.split(/[\\/]/).pop();
}
__name(getName, "getName");
var getStringFromMaybeBuffer = /* @__PURE__ */ __name((x) => {
  if (typeof x === "string")
    return x;
  if (typeof Buffer !== "undefined" && x instanceof Buffer)
    return String(x);
  return void 0;
}, "getStringFromMaybeBuffer");
var isAsyncIterableIterator = /* @__PURE__ */ __name((value) => value != null && typeof value === "object" && typeof value[Symbol.asyncIterator] === "function", "isAsyncIterableIterator");
var isMultipartBody = /* @__PURE__ */ __name((body) => body && typeof body === "object" && body.body && body[Symbol.toStringTag] === "MultipartBody", "isMultipartBody");

// node_modules/@anthropic-ai/sdk/core.mjs
var __classPrivateFieldSet2 = function(receiver, state, value, kind2, f) {
  if (kind2 === "m") throw new TypeError("Private method is not writable");
  if (kind2 === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind2 === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
};
var __classPrivateFieldGet3 = function(receiver, state, kind2, f) {
  if (kind2 === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind2 === "m" ? f : kind2 === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _AbstractPage_client;
async function defaultParseResponse(props) {
  const { response } = props;
  if (props.options.stream) {
    debug("response", response.status, response.url, response.headers, response.body);
    if (props.options.__streamClass) {
      return props.options.__streamClass.fromSSEResponse(response, props.controller);
    }
    return Stream.fromSSEResponse(response, props.controller);
  }
  if (response.status === 204) {
    return null;
  }
  if (props.options.__binaryResponse) {
    return response;
  }
  const contentType = response.headers.get("content-type");
  const isJSON = contentType?.includes("application/json") || contentType?.includes("application/vnd.api+json");
  if (isJSON) {
    const json = await response.json();
    debug("response", response.status, response.url, response.headers, json);
    return _addRequestID(json, response);
  }
  const text = await response.text();
  debug("response", response.status, response.url, response.headers, text);
  return text;
}
__name(defaultParseResponse, "defaultParseResponse");
function _addRequestID(value, response) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return Object.defineProperty(value, "_request_id", {
    value: response.headers.get("request-id"),
    enumerable: false
  });
}
__name(_addRequestID, "_addRequestID");
var APIPromise = class _APIPromise extends Promise {
  static {
    __name(this, "APIPromise");
  }
  constructor(responsePromise, parseResponse = defaultParseResponse) {
    super((resolve) => {
      resolve(null);
    });
    this.responsePromise = responsePromise;
    this.parseResponse = parseResponse;
  }
  _thenUnwrap(transform) {
    return new _APIPromise(this.responsePromise, async (props) => _addRequestID(transform(await this.parseResponse(props), props), props.response));
  }
  /**
   * Gets the raw `Response` instance instead of parsing the response
   * data.
   *
   * If you want to parse the response body but still get the `Response`
   * instance, you can use {@link withResponse()}.
   *
   * 👋 Getting the wrong TypeScript type for `Response`?
   * Try setting `"moduleResolution": "NodeNext"` if you can,
   * or add one of these imports before your first `import … from '@anthropic-ai/sdk'`:
   * - `import '@anthropic-ai/sdk/shims/node'` (if you're running on Node)
   * - `import '@anthropic-ai/sdk/shims/web'` (otherwise)
   */
  asResponse() {
    return this.responsePromise.then((p) => p.response);
  }
  /**
   * Gets the parsed response data, the raw `Response` instance and the ID of the request,
   * returned vie the `request-id` header which is useful for debugging requests and resporting
   * issues to Anthropic.
   *
   * If you just want to get the raw `Response` instance without parsing it,
   * you can use {@link asResponse()}.
   *
   * 👋 Getting the wrong TypeScript type for `Response`?
   * Try setting `"moduleResolution": "NodeNext"` if you can,
   * or add one of these imports before your first `import … from '@anthropic-ai/sdk'`:
   * - `import '@anthropic-ai/sdk/shims/node'` (if you're running on Node)
   * - `import '@anthropic-ai/sdk/shims/web'` (otherwise)
   */
  async withResponse() {
    const [data, response] = await Promise.all([this.parse(), this.asResponse()]);
    return { data, response, request_id: response.headers.get("request-id") };
  }
  parse() {
    if (!this.parsedPromise) {
      this.parsedPromise = this.responsePromise.then(this.parseResponse);
    }
    return this.parsedPromise;
  }
  then(onfulfilled, onrejected) {
    return this.parse().then(onfulfilled, onrejected);
  }
  catch(onrejected) {
    return this.parse().catch(onrejected);
  }
  finally(onfinally) {
    return this.parse().finally(onfinally);
  }
};
var APIClient = class {
  static {
    __name(this, "APIClient");
  }
  constructor({
    baseURL,
    maxRetries = 2,
    timeout = 6e5,
    // 10 minutes
    httpAgent,
    fetch: overriddenFetch
  }) {
    this.baseURL = baseURL;
    this.maxRetries = validatePositiveInteger("maxRetries", maxRetries);
    this.timeout = validatePositiveInteger("timeout", timeout);
    this.httpAgent = httpAgent;
    this.fetch = overriddenFetch ?? fetch;
  }
  authHeaders(opts) {
    return {};
  }
  /**
   * Override this to add your own default headers, for example:
   *
   *  {
   *    ...super.defaultHeaders(),
   *    Authorization: 'Bearer 123',
   *  }
   */
  defaultHeaders(opts) {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": this.getUserAgent(),
      ...getPlatformHeaders(),
      ...this.authHeaders(opts)
    };
  }
  /**
   * Override this to add your own headers validation:
   */
  validateHeaders(headers, customHeaders) {
  }
  defaultIdempotencyKey() {
    return `stainless-node-retry-${uuid4()}`;
  }
  get(path, opts) {
    return this.methodRequest("get", path, opts);
  }
  post(path, opts) {
    return this.methodRequest("post", path, opts);
  }
  patch(path, opts) {
    return this.methodRequest("patch", path, opts);
  }
  put(path, opts) {
    return this.methodRequest("put", path, opts);
  }
  delete(path, opts) {
    return this.methodRequest("delete", path, opts);
  }
  methodRequest(method, path, opts) {
    return this.request(Promise.resolve(opts).then(async (opts2) => {
      const body = opts2 && isBlobLike(opts2?.body) ? new DataView(await opts2.body.arrayBuffer()) : opts2?.body instanceof DataView ? opts2.body : opts2?.body instanceof ArrayBuffer ? new DataView(opts2.body) : opts2 && ArrayBuffer.isView(opts2?.body) ? new DataView(opts2.body.buffer) : opts2?.body;
      return { method, path, ...opts2, body };
    }));
  }
  getAPIList(path, Page2, opts) {
    return this.requestAPIList(Page2, { method: "get", path, ...opts });
  }
  calculateContentLength(body) {
    if (typeof body === "string") {
      if (typeof Buffer !== "undefined") {
        return Buffer.byteLength(body, "utf8").toString();
      }
      if (typeof TextEncoder !== "undefined") {
        const encoder = new TextEncoder();
        const encoded = encoder.encode(body);
        return encoded.length.toString();
      }
    } else if (ArrayBuffer.isView(body)) {
      return body.byteLength.toString();
    }
    return null;
  }
  buildRequest(options, { retryCount = 0 } = {}) {
    const { method, path, query, headers = {} } = options;
    const body = ArrayBuffer.isView(options.body) || options.__binaryRequest && typeof options.body === "string" ? options.body : isMultipartBody(options.body) ? options.body.body : options.body ? JSON.stringify(options.body, null, 2) : null;
    const contentLength = this.calculateContentLength(body);
    const url = this.buildURL(path, query);
    if ("timeout" in options)
      validatePositiveInteger("timeout", options.timeout);
    const timeout = options.timeout ?? this.timeout;
    const httpAgent = options.httpAgent ?? this.httpAgent ?? getDefaultAgent(url);
    const minAgentTimeout = timeout + 1e3;
    if (typeof httpAgent?.options?.timeout === "number" && minAgentTimeout > (httpAgent.options.timeout ?? 0)) {
      httpAgent.options.timeout = minAgentTimeout;
    }
    if (this.idempotencyHeader && method !== "get") {
      if (!options.idempotencyKey)
        options.idempotencyKey = this.defaultIdempotencyKey();
      headers[this.idempotencyHeader] = options.idempotencyKey;
    }
    const reqHeaders = this.buildHeaders({ options, headers, contentLength, retryCount });
    const req = {
      method,
      ...body && { body },
      headers: reqHeaders,
      ...httpAgent && { agent: httpAgent },
      // @ts-ignore node-fetch uses a custom AbortSignal type that is
      // not compatible with standard web types
      signal: options.signal ?? null
    };
    return { req, url, timeout };
  }
  buildHeaders({ options, headers, contentLength, retryCount }) {
    const reqHeaders = {};
    if (contentLength) {
      reqHeaders["content-length"] = contentLength;
    }
    const defaultHeaders = this.defaultHeaders(options);
    applyHeadersMut(reqHeaders, defaultHeaders);
    applyHeadersMut(reqHeaders, headers);
    if (isMultipartBody(options.body) && kind !== "node") {
      delete reqHeaders["content-type"];
    }
    if (getHeader(defaultHeaders, "x-stainless-retry-count") === void 0 && getHeader(headers, "x-stainless-retry-count") === void 0) {
      reqHeaders["x-stainless-retry-count"] = String(retryCount);
    }
    this.validateHeaders(reqHeaders, headers);
    return reqHeaders;
  }
  /**
   * Used as a callback for mutating the given `FinalRequestOptions` object.
   */
  async prepareOptions(options) {
  }
  /**
   * Used as a callback for mutating the given `RequestInit` object.
   *
   * This is useful for cases where you want to add certain headers based off of
   * the request properties, e.g. `method` or `url`.
   */
  async prepareRequest(request, { url, options }) {
  }
  parseHeaders(headers) {
    return !headers ? {} : Symbol.iterator in headers ? Object.fromEntries(Array.from(headers).map((header) => [...header])) : { ...headers };
  }
  makeStatusError(status, error, message, headers) {
    return APIError.generate(status, error, message, headers);
  }
  request(options, remainingRetries = null) {
    return new APIPromise(this.makeRequest(options, remainingRetries));
  }
  async makeRequest(optionsInput, retriesRemaining) {
    const options = await optionsInput;
    const maxRetries = options.maxRetries ?? this.maxRetries;
    if (retriesRemaining == null) {
      retriesRemaining = maxRetries;
    }
    await this.prepareOptions(options);
    const { req, url, timeout } = this.buildRequest(options, { retryCount: maxRetries - retriesRemaining });
    await this.prepareRequest(req, { url, options });
    debug("request", url, options, req.headers);
    if (options.signal?.aborted) {
      throw new APIUserAbortError();
    }
    const controller = new AbortController();
    const response = await this.fetchWithTimeout(url, req, timeout, controller).catch(castToError);
    if (response instanceof Error) {
      if (options.signal?.aborted) {
        throw new APIUserAbortError();
      }
      if (retriesRemaining) {
        return this.retryRequest(options, retriesRemaining);
      }
      if (response.name === "AbortError") {
        throw new APIConnectionTimeoutError();
      }
      throw new APIConnectionError({ cause: response });
    }
    const responseHeaders = createResponseHeaders(response.headers);
    if (!response.ok) {
      if (retriesRemaining && this.shouldRetry(response)) {
        const retryMessage2 = `retrying, ${retriesRemaining} attempts remaining`;
        debug(`response (error; ${retryMessage2})`, response.status, url, responseHeaders);
        return this.retryRequest(options, retriesRemaining, responseHeaders);
      }
      const errText = await response.text().catch((e) => castToError(e).message);
      const errJSON = safeJSON(errText);
      const errMessage = errJSON ? void 0 : errText;
      const retryMessage = retriesRemaining ? `(error; no more retries left)` : `(error; not retryable)`;
      debug(`response (error; ${retryMessage})`, response.status, url, responseHeaders, errMessage);
      const err = this.makeStatusError(response.status, errJSON, errMessage, responseHeaders);
      throw err;
    }
    return { response, options, controller };
  }
  requestAPIList(Page2, options) {
    const request = this.makeRequest(options, null);
    return new PagePromise(this, request, Page2);
  }
  buildURL(path, query) {
    const url = isAbsoluteURL(path) ? new URL(path) : new URL(this.baseURL + (this.baseURL.endsWith("/") && path.startsWith("/") ? path.slice(1) : path));
    const defaultQuery = this.defaultQuery();
    if (!isEmptyObj(defaultQuery)) {
      query = { ...defaultQuery, ...query };
    }
    if (typeof query === "object" && query && !Array.isArray(query)) {
      url.search = this.stringifyQuery(query);
    }
    return url.toString();
  }
  stringifyQuery(query) {
    return Object.entries(query).filter(([_, value]) => typeof value !== "undefined").map(([key, value]) => {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
      }
      if (value === null) {
        return `${encodeURIComponent(key)}=`;
      }
      throw new AnthropicError(`Cannot stringify type ${typeof value}; Expected string, number, boolean, or null. If you need to pass nested query parameters, you can manually encode them, e.g. { query: { 'foo[key1]': value1, 'foo[key2]': value2 } }, and please open a GitHub issue requesting better support for your use case.`);
    }).join("&");
  }
  async fetchWithTimeout(url, init, ms, controller) {
    const { signal, ...options } = init || {};
    if (signal)
      signal.addEventListener("abort", () => controller.abort());
    const timeout = setTimeout(() => controller.abort(), ms);
    const fetchOptions = {
      signal: controller.signal,
      ...options
    };
    if (fetchOptions.method) {
      fetchOptions.method = fetchOptions.method.toUpperCase();
    }
    return (
      // use undefined this binding; fetch errors if bound to something else in browser/cloudflare
      this.fetch.call(void 0, url, fetchOptions).finally(() => {
        clearTimeout(timeout);
      })
    );
  }
  shouldRetry(response) {
    const shouldRetryHeader = response.headers.get("x-should-retry");
    if (shouldRetryHeader === "true")
      return true;
    if (shouldRetryHeader === "false")
      return false;
    if (response.status === 408)
      return true;
    if (response.status === 409)
      return true;
    if (response.status === 429)
      return true;
    if (response.status >= 500)
      return true;
    return false;
  }
  async retryRequest(options, retriesRemaining, responseHeaders) {
    let timeoutMillis;
    const retryAfterMillisHeader = responseHeaders?.["retry-after-ms"];
    if (retryAfterMillisHeader) {
      const timeoutMs = parseFloat(retryAfterMillisHeader);
      if (!Number.isNaN(timeoutMs)) {
        timeoutMillis = timeoutMs;
      }
    }
    const retryAfterHeader = responseHeaders?.["retry-after"];
    if (retryAfterHeader && !timeoutMillis) {
      const timeoutSeconds = parseFloat(retryAfterHeader);
      if (!Number.isNaN(timeoutSeconds)) {
        timeoutMillis = timeoutSeconds * 1e3;
      } else {
        timeoutMillis = Date.parse(retryAfterHeader) - Date.now();
      }
    }
    if (!(timeoutMillis && 0 <= timeoutMillis && timeoutMillis < 60 * 1e3)) {
      const maxRetries = options.maxRetries ?? this.maxRetries;
      timeoutMillis = this.calculateDefaultRetryTimeoutMillis(retriesRemaining, maxRetries);
    }
    await sleep(timeoutMillis);
    return this.makeRequest(options, retriesRemaining - 1);
  }
  calculateDefaultRetryTimeoutMillis(retriesRemaining, maxRetries) {
    const initialRetryDelay = 0.5;
    const maxRetryDelay = 8;
    const numRetries = maxRetries - retriesRemaining;
    const sleepSeconds = Math.min(initialRetryDelay * Math.pow(2, numRetries), maxRetryDelay);
    const jitter = 1 - Math.random() * 0.25;
    return sleepSeconds * jitter * 1e3;
  }
  getUserAgent() {
    return `${this.constructor.name}/JS ${VERSION}`;
  }
};
var AbstractPage = class {
  static {
    __name(this, "AbstractPage");
  }
  constructor(client, response, body, options) {
    _AbstractPage_client.set(this, void 0);
    __classPrivateFieldSet2(this, _AbstractPage_client, client, "f");
    this.options = options;
    this.response = response;
    this.body = body;
  }
  hasNextPage() {
    const items = this.getPaginatedItems();
    if (!items.length)
      return false;
    return this.nextPageInfo() != null;
  }
  async getNextPage() {
    const nextInfo = this.nextPageInfo();
    if (!nextInfo) {
      throw new AnthropicError("No next page expected; please check `.hasNextPage()` before calling `.getNextPage()`.");
    }
    const nextOptions = { ...this.options };
    if ("params" in nextInfo && typeof nextOptions.query === "object") {
      nextOptions.query = { ...nextOptions.query, ...nextInfo.params };
    } else if ("url" in nextInfo) {
      const params = [...Object.entries(nextOptions.query || {}), ...nextInfo.url.searchParams.entries()];
      for (const [key, value] of params) {
        nextInfo.url.searchParams.set(key, value);
      }
      nextOptions.query = void 0;
      nextOptions.path = nextInfo.url.toString();
    }
    return await __classPrivateFieldGet3(this, _AbstractPage_client, "f").requestAPIList(this.constructor, nextOptions);
  }
  async *iterPages() {
    let page = this;
    yield page;
    while (page.hasNextPage()) {
      page = await page.getNextPage();
      yield page;
    }
  }
  async *[(_AbstractPage_client = /* @__PURE__ */ new WeakMap(), Symbol.asyncIterator)]() {
    for await (const page of this.iterPages()) {
      for (const item of page.getPaginatedItems()) {
        yield item;
      }
    }
  }
};
var PagePromise = class extends APIPromise {
  static {
    __name(this, "PagePromise");
  }
  constructor(client, request, Page2) {
    super(request, async (props) => new Page2(client, props.response, await defaultParseResponse(props), props.options));
  }
  /**
   * Allow auto-paginating iteration on an unawaited list call, eg:
   *
   *    for await (const item of client.items.list()) {
   *      console.log(item)
   *    }
   */
  async *[Symbol.asyncIterator]() {
    const page = await this;
    for await (const item of page) {
      yield item;
    }
  }
};
var createResponseHeaders = /* @__PURE__ */ __name((headers) => {
  return new Proxy(Object.fromEntries(
    // @ts-ignore
    headers.entries()
  ), {
    get(target, name) {
      const key = name.toString();
      return target[key.toLowerCase()] || target[key];
    }
  });
}, "createResponseHeaders");
var requestOptionsKeys = {
  method: true,
  path: true,
  query: true,
  body: true,
  headers: true,
  maxRetries: true,
  stream: true,
  timeout: true,
  httpAgent: true,
  signal: true,
  idempotencyKey: true,
  __binaryRequest: true,
  __binaryResponse: true,
  __streamClass: true
};
var isRequestOptions = /* @__PURE__ */ __name((obj) => {
  return typeof obj === "object" && obj !== null && !isEmptyObj(obj) && Object.keys(obj).every((k) => hasOwn(requestOptionsKeys, k));
}, "isRequestOptions");
var getPlatformProperties = /* @__PURE__ */ __name(() => {
  if (typeof Deno !== "undefined" && Deno.build != null) {
    return {
      "X-Stainless-Lang": "js",
      "X-Stainless-Package-Version": VERSION,
      "X-Stainless-OS": normalizePlatform(Deno.build.os),
      "X-Stainless-Arch": normalizeArch(Deno.build.arch),
      "X-Stainless-Runtime": "deno",
      "X-Stainless-Runtime-Version": typeof Deno.version === "string" ? Deno.version : Deno.version?.deno ?? "unknown"
    };
  }
  if (typeof EdgeRuntime !== "undefined") {
    return {
      "X-Stainless-Lang": "js",
      "X-Stainless-Package-Version": VERSION,
      "X-Stainless-OS": "Unknown",
      "X-Stainless-Arch": `other:${EdgeRuntime}`,
      "X-Stainless-Runtime": "edge",
      "X-Stainless-Runtime-Version": process.version
    };
  }
  if (Object.prototype.toString.call(typeof process !== "undefined" ? process : 0) === "[object process]") {
    return {
      "X-Stainless-Lang": "js",
      "X-Stainless-Package-Version": VERSION,
      "X-Stainless-OS": normalizePlatform(process.platform),
      "X-Stainless-Arch": normalizeArch(process.arch),
      "X-Stainless-Runtime": "node",
      "X-Stainless-Runtime-Version": process.version
    };
  }
  const browserInfo = getBrowserInfo();
  if (browserInfo) {
    return {
      "X-Stainless-Lang": "js",
      "X-Stainless-Package-Version": VERSION,
      "X-Stainless-OS": "Unknown",
      "X-Stainless-Arch": "unknown",
      "X-Stainless-Runtime": `browser:${browserInfo.browser}`,
      "X-Stainless-Runtime-Version": browserInfo.version
    };
  }
  return {
    "X-Stainless-Lang": "js",
    "X-Stainless-Package-Version": VERSION,
    "X-Stainless-OS": "Unknown",
    "X-Stainless-Arch": "unknown",
    "X-Stainless-Runtime": "unknown",
    "X-Stainless-Runtime-Version": "unknown"
  };
}, "getPlatformProperties");
function getBrowserInfo() {
  if (typeof navigator === "undefined" || !navigator) {
    return null;
  }
  const browserPatterns = [
    { key: "edge", pattern: /Edge(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: "ie", pattern: /MSIE(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: "ie", pattern: /Trident(?:.*rv\:(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: "chrome", pattern: /Chrome(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: "firefox", pattern: /Firefox(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: "safari", pattern: /(?:Version\W+(\d+)\.(\d+)(?:\.(\d+))?)?(?:\W+Mobile\S*)?\W+Safari/ }
  ];
  for (const { key, pattern } of browserPatterns) {
    const match = pattern.exec(navigator.userAgent);
    if (match) {
      const major = match[1] || 0;
      const minor = match[2] || 0;
      const patch = match[3] || 0;
      return { browser: key, version: `${major}.${minor}.${patch}` };
    }
  }
  return null;
}
__name(getBrowserInfo, "getBrowserInfo");
var normalizeArch = /* @__PURE__ */ __name((arch) => {
  if (arch === "x32")
    return "x32";
  if (arch === "x86_64" || arch === "x64")
    return "x64";
  if (arch === "arm")
    return "arm";
  if (arch === "aarch64" || arch === "arm64")
    return "arm64";
  if (arch)
    return `other:${arch}`;
  return "unknown";
}, "normalizeArch");
var normalizePlatform = /* @__PURE__ */ __name((platform) => {
  platform = platform.toLowerCase();
  if (platform.includes("ios"))
    return "iOS";
  if (platform === "android")
    return "Android";
  if (platform === "darwin")
    return "MacOS";
  if (platform === "win32")
    return "Windows";
  if (platform === "freebsd")
    return "FreeBSD";
  if (platform === "openbsd")
    return "OpenBSD";
  if (platform === "linux")
    return "Linux";
  if (platform)
    return `Other:${platform}`;
  return "Unknown";
}, "normalizePlatform");
var _platformHeaders;
var getPlatformHeaders = /* @__PURE__ */ __name(() => {
  return _platformHeaders ?? (_platformHeaders = getPlatformProperties());
}, "getPlatformHeaders");
var safeJSON = /* @__PURE__ */ __name((text) => {
  try {
    return JSON.parse(text);
  } catch (err) {
    return void 0;
  }
}, "safeJSON");
var startsWithSchemeRegexp = /^[a-z][a-z0-9+.-]*:/i;
var isAbsoluteURL = /* @__PURE__ */ __name((url) => {
  return startsWithSchemeRegexp.test(url);
}, "isAbsoluteURL");
var sleep = /* @__PURE__ */ __name((ms) => new Promise((resolve) => setTimeout(resolve, ms)), "sleep");
var validatePositiveInteger = /* @__PURE__ */ __name((name, n) => {
  if (typeof n !== "number" || !Number.isInteger(n)) {
    throw new AnthropicError(`${name} must be an integer`);
  }
  if (n < 0) {
    throw new AnthropicError(`${name} must be a positive integer`);
  }
  return n;
}, "validatePositiveInteger");
var castToError = /* @__PURE__ */ __name((err) => {
  if (err instanceof Error)
    return err;
  if (typeof err === "object" && err !== null) {
    try {
      return new Error(JSON.stringify(err));
    } catch {
    }
  }
  return new Error(String(err));
}, "castToError");
var readEnv = /* @__PURE__ */ __name((env) => {
  if (typeof process !== "undefined") {
    return process.env?.[env]?.trim() ?? void 0;
  }
  if (typeof Deno !== "undefined") {
    return Deno.env?.get?.(env)?.trim();
  }
  return void 0;
}, "readEnv");
function isEmptyObj(obj) {
  if (!obj)
    return true;
  for (const _k in obj)
    return false;
  return true;
}
__name(isEmptyObj, "isEmptyObj");
function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
__name(hasOwn, "hasOwn");
function applyHeadersMut(targetHeaders, newHeaders) {
  for (const k in newHeaders) {
    if (!hasOwn(newHeaders, k))
      continue;
    const lowerKey = k.toLowerCase();
    if (!lowerKey)
      continue;
    const val = newHeaders[k];
    if (val === null) {
      delete targetHeaders[lowerKey];
    } else if (val !== void 0) {
      targetHeaders[lowerKey] = val;
    }
  }
}
__name(applyHeadersMut, "applyHeadersMut");
function debug(action, ...args) {
  if (typeof process !== "undefined" && process?.env?.["DEBUG"] === "true") {
    console.log(`Anthropic:DEBUG:${action}`, ...args);
  }
}
__name(debug, "debug");
var uuid4 = /* @__PURE__ */ __name(() => {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : r & 3 | 8;
    return v.toString(16);
  });
}, "uuid4");
var isRunningInBrowser = /* @__PURE__ */ __name(() => {
  return (
    // @ts-ignore
    typeof window !== "undefined" && // @ts-ignore
    typeof window.document !== "undefined" && // @ts-ignore
    typeof navigator !== "undefined"
  );
}, "isRunningInBrowser");
var isHeadersProtocol = /* @__PURE__ */ __name((headers) => {
  return typeof headers?.get === "function";
}, "isHeadersProtocol");
var getHeader = /* @__PURE__ */ __name((headers, header) => {
  const lowerCasedHeader = header.toLowerCase();
  if (isHeadersProtocol(headers)) {
    const intercapsHeader = header[0]?.toUpperCase() + header.substring(1).replace(/([^\w])(\w)/g, (_m, g1, g2) => g1 + g2.toUpperCase());
    for (const key of [header, lowerCasedHeader, header.toUpperCase(), intercapsHeader]) {
      const value = headers.get(key);
      if (value) {
        return value;
      }
    }
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerCasedHeader) {
      if (Array.isArray(value)) {
        if (value.length <= 1)
          return value[0];
        console.warn(`Received ${value.length} entries for the ${header} header, using the first entry.`);
        return value[0];
      }
      return value;
    }
  }
  return void 0;
}, "getHeader");

// node_modules/@anthropic-ai/sdk/pagination.mjs
init_esbuild_shims();
var Page = class extends AbstractPage {
  static {
    __name(this, "Page");
  }
  constructor(client, response, body, options) {
    super(client, response, body, options);
    this.data = body.data || [];
    this.has_more = body.has_more || false;
    this.first_id = body.first_id || null;
    this.last_id = body.last_id || null;
  }
  getPaginatedItems() {
    return this.data ?? [];
  }
  // @deprecated Please use `nextPageInfo()` instead
  nextPageParams() {
    const info = this.nextPageInfo();
    if (!info)
      return null;
    if ("params" in info)
      return info.params;
    const params = Object.fromEntries(info.url.searchParams);
    if (!Object.keys(params).length)
      return null;
    return params;
  }
  nextPageInfo() {
    if (this.options.query?.["before_id"]) {
      const firstId = this.first_id;
      if (!firstId) {
        return null;
      }
      return {
        params: {
          before_id: firstId
        }
      };
    }
    const cursor = this.last_id;
    if (!cursor) {
      return null;
    }
    return {
      params: {
        after_id: cursor
      }
    };
  }
};

// node_modules/@anthropic-ai/sdk/resources/index.mjs
init_esbuild_shims();

// node_modules/@anthropic-ai/sdk/resources/beta/beta.mjs
init_esbuild_shims();

// node_modules/@anthropic-ai/sdk/resource.mjs
init_esbuild_shims();
var APIResource = class {
  static {
    __name(this, "APIResource");
  }
  constructor(client) {
    this._client = client;
  }
};

// node_modules/@anthropic-ai/sdk/resources/beta/models.mjs
init_esbuild_shims();
var Models = class extends APIResource {
  static {
    __name(this, "Models");
  }
  /**
   * Get a specific model.
   *
   * The Models API response can be used to determine information about a specific
   * model or resolve a model alias to a model ID.
   */
  retrieve(modelId, options) {
    return this._client.get(`/v1/models/${modelId}?beta=true`, options);
  }
  list(query = {}, options) {
    if (isRequestOptions(query)) {
      return this.list({}, query);
    }
    return this._client.getAPIList("/v1/models?beta=true", BetaModelInfosPage, { query, ...options });
  }
};
var BetaModelInfosPage = class extends Page {
  static {
    __name(this, "BetaModelInfosPage");
  }
};
Models.BetaModelInfosPage = BetaModelInfosPage;

// node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.mjs
init_esbuild_shims();

// node_modules/@anthropic-ai/sdk/resources/beta/messages/batches.mjs
init_esbuild_shims();

// node_modules/@anthropic-ai/sdk/internal/decoders/jsonl.mjs
init_esbuild_shims();
var JSONLDecoder = class _JSONLDecoder {
  static {
    __name(this, "JSONLDecoder");
  }
  constructor(iterator, controller) {
    this.iterator = iterator;
    this.controller = controller;
  }
  async *decoder() {
    const lineDecoder = new LineDecoder();
    for await (const chunk of this.iterator) {
      for (const line of lineDecoder.decode(chunk)) {
        yield JSON.parse(line);
      }
    }
    for (const line of lineDecoder.flush()) {
      yield JSON.parse(line);
    }
  }
  [Symbol.asyncIterator]() {
    return this.decoder();
  }
  static fromResponse(response, controller) {
    if (!response.body) {
      controller.abort();
      throw new AnthropicError(`Attempted to iterate over a response with no body`);
    }
    return new _JSONLDecoder(ReadableStreamToAsyncIterable(response.body), controller);
  }
};

// node_modules/@anthropic-ai/sdk/resources/beta/messages/batches.mjs
var Batches = class extends APIResource {
  static {
    __name(this, "Batches");
  }
  /**
   * Send a batch of Message creation requests.
   *
   * The Message Batches API can be used to process multiple Messages API requests at
   * once. Once a Message Batch is created, it begins processing immediately. Batches
   * can take up to 24 hours to complete.
   */
  create(params, options) {
    const { betas, ...body } = params;
    return this._client.post("/v1/messages/batches?beta=true", {
      body,
      ...options,
      headers: {
        "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString(),
        ...options?.headers
      }
    });
  }
  retrieve(messageBatchId, params = {}, options) {
    if (isRequestOptions(params)) {
      return this.retrieve(messageBatchId, {}, params);
    }
    const { betas } = params;
    return this._client.get(`/v1/messages/batches/${messageBatchId}?beta=true`, {
      ...options,
      headers: {
        "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString(),
        ...options?.headers
      }
    });
  }
  list(params = {}, options) {
    if (isRequestOptions(params)) {
      return this.list({}, params);
    }
    const { betas, ...query } = params;
    return this._client.getAPIList("/v1/messages/batches?beta=true", BetaMessageBatchesPage, {
      query,
      ...options,
      headers: {
        "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString(),
        ...options?.headers
      }
    });
  }
  delete(messageBatchId, params = {}, options) {
    if (isRequestOptions(params)) {
      return this.delete(messageBatchId, {}, params);
    }
    const { betas } = params;
    return this._client.delete(`/v1/messages/batches/${messageBatchId}?beta=true`, {
      ...options,
      headers: {
        "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString(),
        ...options?.headers
      }
    });
  }
  cancel(messageBatchId, params = {}, options) {
    if (isRequestOptions(params)) {
      return this.cancel(messageBatchId, {}, params);
    }
    const { betas } = params;
    return this._client.post(`/v1/messages/batches/${messageBatchId}/cancel?beta=true`, {
      ...options,
      headers: {
        "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString(),
        ...options?.headers
      }
    });
  }
  async results(messageBatchId, params = {}, options) {
    if (isRequestOptions(params)) {
      return this.results(messageBatchId, {}, params);
    }
    const batch = await this.retrieve(messageBatchId);
    if (!batch.results_url) {
      throw new AnthropicError(`No batch \`results_url\`; Has it finished processing? ${batch.processing_status} - ${batch.id}`);
    }
    const { betas } = params;
    return this._client.get(batch.results_url, {
      ...options,
      headers: {
        "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString(),
        Accept: "application/binary",
        ...options?.headers
      },
      __binaryResponse: true
    })._thenUnwrap((_, props) => JSONLDecoder.fromResponse(props.response, props.controller));
  }
};
var BetaMessageBatchesPage = class extends Page {
  static {
    __name(this, "BetaMessageBatchesPage");
  }
};
Batches.BetaMessageBatchesPage = BetaMessageBatchesPage;

// node_modules/@anthropic-ai/sdk/lib/BetaMessageStream.mjs
init_esbuild_shims();

// node_modules/@anthropic-ai/sdk/_vendor/partial-json-parser/parser.mjs
init_esbuild_shims();
var tokenize = /* @__PURE__ */ __name((input) => {
  let current = 0;
  let tokens = [];
  while (current < input.length) {
    let char = input[current];
    if (char === "\\") {
      current++;
      continue;
    }
    if (char === "{") {
      tokens.push({
        type: "brace",
        value: "{"
      });
      current++;
      continue;
    }
    if (char === "}") {
      tokens.push({
        type: "brace",
        value: "}"
      });
      current++;
      continue;
    }
    if (char === "[") {
      tokens.push({
        type: "paren",
        value: "["
      });
      current++;
      continue;
    }
    if (char === "]") {
      tokens.push({
        type: "paren",
        value: "]"
      });
      current++;
      continue;
    }
    if (char === ":") {
      tokens.push({
        type: "separator",
        value: ":"
      });
      current++;
      continue;
    }
    if (char === ",") {
      tokens.push({
        type: "delimiter",
        value: ","
      });
      current++;
      continue;
    }
    if (char === '"') {
      let value = "";
      let danglingQuote = false;
      char = input[++current];
      while (char !== '"') {
        if (current === input.length) {
          danglingQuote = true;
          break;
        }
        if (char === "\\") {
          current++;
          if (current === input.length) {
            danglingQuote = true;
            break;
          }
          value += char + input[current];
          char = input[++current];
        } else {
          value += char;
          char = input[++current];
        }
      }
      char = input[++current];
      if (!danglingQuote) {
        tokens.push({
          type: "string",
          value
        });
      }
      continue;
    }
    let WHITESPACE = /\s/;
    if (char && WHITESPACE.test(char)) {
      current++;
      continue;
    }
    let NUMBERS = /[0-9]/;
    if (char && NUMBERS.test(char) || char === "-" || char === ".") {
      let value = "";
      if (char === "-") {
        value += char;
        char = input[++current];
      }
      while (char && NUMBERS.test(char) || char === ".") {
        value += char;
        char = input[++current];
      }
      tokens.push({
        type: "number",
        value
      });
      continue;
    }
    let LETTERS = /[a-z]/i;
    if (char && LETTERS.test(char)) {
      let value = "";
      while (char && LETTERS.test(char)) {
        if (current === input.length) {
          break;
        }
        value += char;
        char = input[++current];
      }
      if (value == "true" || value == "false" || value === "null") {
        tokens.push({
          type: "name",
          value
        });
      } else {
        current++;
        continue;
      }
      continue;
    }
    current++;
  }
  return tokens;
}, "tokenize");
var strip = /* @__PURE__ */ __name((tokens) => {
  if (tokens.length === 0) {
    return tokens;
  }
  let lastToken = tokens[tokens.length - 1];
  switch (lastToken.type) {
    case "separator":
      tokens = tokens.slice(0, tokens.length - 1);
      return strip(tokens);
      break;
    case "number":
      let lastCharacterOfLastToken = lastToken.value[lastToken.value.length - 1];
      if (lastCharacterOfLastToken === "." || lastCharacterOfLastToken === "-") {
        tokens = tokens.slice(0, tokens.length - 1);
        return strip(tokens);
      }
    case "string":
      let tokenBeforeTheLastToken = tokens[tokens.length - 2];
      if (tokenBeforeTheLastToken?.type === "delimiter") {
        tokens = tokens.slice(0, tokens.length - 1);
        return strip(tokens);
      } else if (tokenBeforeTheLastToken?.type === "brace" && tokenBeforeTheLastToken.value === "{") {
        tokens = tokens.slice(0, tokens.length - 1);
        return strip(tokens);
      }
      break;
    case "delimiter":
      tokens = tokens.slice(0, tokens.length - 1);
      return strip(tokens);
      break;
  }
  return tokens;
}, "strip");
var unstrip = /* @__PURE__ */ __name((tokens) => {
  let tail = [];
  tokens.map((token) => {
    if (token.type === "brace") {
      if (token.value === "{") {
        tail.push("}");
      } else {
        tail.splice(tail.lastIndexOf("}"), 1);
      }
    }
    if (token.type === "paren") {
      if (token.value === "[") {
        tail.push("]");
      } else {
        tail.splice(tail.lastIndexOf("]"), 1);
      }
    }
  });
  if (tail.length > 0) {
    tail.reverse().map((item) => {
      if (item === "}") {
        tokens.push({
          type: "brace",
          value: "}"
        });
      } else if (item === "]") {
        tokens.push({
          type: "paren",
          value: "]"
        });
      }
    });
  }
  return tokens;
}, "unstrip");
var generate = /* @__PURE__ */ __name((tokens) => {
  let output = "";
  tokens.map((token) => {
    switch (token.type) {
      case "string":
        output += '"' + token.value + '"';
        break;
      default:
        output += token.value;
        break;
    }
  });
  return output;
}, "generate");
var partialParse = /* @__PURE__ */ __name((input) => JSON.parse(generate(unstrip(strip(tokenize(input))))), "partialParse");

// node_modules/@anthropic-ai/sdk/lib/BetaMessageStream.mjs
var __classPrivateFieldSet3 = function(receiver, state, value, kind2, f) {
  if (kind2 === "m") throw new TypeError("Private method is not writable");
  if (kind2 === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind2 === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
};
var __classPrivateFieldGet4 = function(receiver, state, kind2, f) {
  if (kind2 === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind2 === "m" ? f : kind2 === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _BetaMessageStream_instances;
var _BetaMessageStream_currentMessageSnapshot;
var _BetaMessageStream_connectedPromise;
var _BetaMessageStream_resolveConnectedPromise;
var _BetaMessageStream_rejectConnectedPromise;
var _BetaMessageStream_endPromise;
var _BetaMessageStream_resolveEndPromise;
var _BetaMessageStream_rejectEndPromise;
var _BetaMessageStream_listeners;
var _BetaMessageStream_ended;
var _BetaMessageStream_errored;
var _BetaMessageStream_aborted;
var _BetaMessageStream_catchingPromiseCreated;
var _BetaMessageStream_response;
var _BetaMessageStream_request_id;
var _BetaMessageStream_getFinalMessage;
var _BetaMessageStream_getFinalText;
var _BetaMessageStream_handleError;
var _BetaMessageStream_beginRequest;
var _BetaMessageStream_addStreamEvent;
var _BetaMessageStream_endRequest;
var _BetaMessageStream_accumulateMessage;
var JSON_BUF_PROPERTY = "__json_buf";
var BetaMessageStream = class _BetaMessageStream {
  static {
    __name(this, "BetaMessageStream");
  }
  constructor() {
    _BetaMessageStream_instances.add(this);
    this.messages = [];
    this.receivedMessages = [];
    _BetaMessageStream_currentMessageSnapshot.set(this, void 0);
    this.controller = new AbortController();
    _BetaMessageStream_connectedPromise.set(this, void 0);
    _BetaMessageStream_resolveConnectedPromise.set(this, () => {
    });
    _BetaMessageStream_rejectConnectedPromise.set(this, () => {
    });
    _BetaMessageStream_endPromise.set(this, void 0);
    _BetaMessageStream_resolveEndPromise.set(this, () => {
    });
    _BetaMessageStream_rejectEndPromise.set(this, () => {
    });
    _BetaMessageStream_listeners.set(this, {});
    _BetaMessageStream_ended.set(this, false);
    _BetaMessageStream_errored.set(this, false);
    _BetaMessageStream_aborted.set(this, false);
    _BetaMessageStream_catchingPromiseCreated.set(this, false);
    _BetaMessageStream_response.set(this, void 0);
    _BetaMessageStream_request_id.set(this, void 0);
    _BetaMessageStream_handleError.set(this, (error) => {
      __classPrivateFieldSet3(this, _BetaMessageStream_errored, true, "f");
      if (error instanceof Error && error.name === "AbortError") {
        error = new APIUserAbortError();
      }
      if (error instanceof APIUserAbortError) {
        __classPrivateFieldSet3(this, _BetaMessageStream_aborted, true, "f");
        return this._emit("abort", error);
      }
      if (error instanceof AnthropicError) {
        return this._emit("error", error);
      }
      if (error instanceof Error) {
        const anthropicError = new AnthropicError(error.message);
        anthropicError.cause = error;
        return this._emit("error", anthropicError);
      }
      return this._emit("error", new AnthropicError(String(error)));
    });
    __classPrivateFieldSet3(this, _BetaMessageStream_connectedPromise, new Promise((resolve, reject) => {
      __classPrivateFieldSet3(this, _BetaMessageStream_resolveConnectedPromise, resolve, "f");
      __classPrivateFieldSet3(this, _BetaMessageStream_rejectConnectedPromise, reject, "f");
    }), "f");
    __classPrivateFieldSet3(this, _BetaMessageStream_endPromise, new Promise((resolve, reject) => {
      __classPrivateFieldSet3(this, _BetaMessageStream_resolveEndPromise, resolve, "f");
      __classPrivateFieldSet3(this, _BetaMessageStream_rejectEndPromise, reject, "f");
    }), "f");
    __classPrivateFieldGet4(this, _BetaMessageStream_connectedPromise, "f").catch(() => {
    });
    __classPrivateFieldGet4(this, _BetaMessageStream_endPromise, "f").catch(() => {
    });
  }
  get response() {
    return __classPrivateFieldGet4(this, _BetaMessageStream_response, "f");
  }
  get request_id() {
    return __classPrivateFieldGet4(this, _BetaMessageStream_request_id, "f");
  }
  /**
   * Returns the `MessageStream` data, the raw `Response` instance and the ID of the request,
   * returned vie the `request-id` header which is useful for debugging requests and resporting
   * issues to Anthropic.
   *
   * This is the same as the `APIPromise.withResponse()` method.
   *
   * This method will raise an error if you created the stream using `MessageStream.fromReadableStream`
   * as no `Response` is available.
   */
  async withResponse() {
    const response = await __classPrivateFieldGet4(this, _BetaMessageStream_connectedPromise, "f");
    if (!response) {
      throw new Error("Could not resolve a `Response` object");
    }
    return {
      data: this,
      response,
      request_id: response.headers.get("request-id")
    };
  }
  /**
   * Intended for use on the frontend, consuming a stream produced with
   * `.toReadableStream()` on the backend.
   *
   * Note that messages sent to the model do not appear in `.on('message')`
   * in this context.
   */
  static fromReadableStream(stream) {
    const runner = new _BetaMessageStream();
    runner._run(() => runner._fromReadableStream(stream));
    return runner;
  }
  static createMessage(messages, params, options) {
    const runner = new _BetaMessageStream();
    for (const message of params.messages) {
      runner._addMessageParam(message);
    }
    runner._run(() => runner._createMessage(messages, { ...params, stream: true }, { ...options, headers: { ...options?.headers, "X-Stainless-Helper-Method": "stream" } }));
    return runner;
  }
  _run(executor) {
    executor().then(() => {
      this._emitFinal();
      this._emit("end");
    }, __classPrivateFieldGet4(this, _BetaMessageStream_handleError, "f"));
  }
  _addMessageParam(message) {
    this.messages.push(message);
  }
  _addMessage(message, emit = true) {
    this.receivedMessages.push(message);
    if (emit) {
      this._emit("message", message);
    }
  }
  async _createMessage(messages, params, options) {
    const signal = options?.signal;
    if (signal) {
      if (signal.aborted)
        this.controller.abort();
      signal.addEventListener("abort", () => this.controller.abort());
    }
    __classPrivateFieldGet4(this, _BetaMessageStream_instances, "m", _BetaMessageStream_beginRequest).call(this);
    const { response, data: stream } = await messages.create({ ...params, stream: true }, { ...options, signal: this.controller.signal }).withResponse();
    this._connected(response);
    for await (const event of stream) {
      __classPrivateFieldGet4(this, _BetaMessageStream_instances, "m", _BetaMessageStream_addStreamEvent).call(this, event);
    }
    if (stream.controller.signal?.aborted) {
      throw new APIUserAbortError();
    }
    __classPrivateFieldGet4(this, _BetaMessageStream_instances, "m", _BetaMessageStream_endRequest).call(this);
  }
  _connected(response) {
    if (this.ended)
      return;
    __classPrivateFieldSet3(this, _BetaMessageStream_response, response, "f");
    __classPrivateFieldSet3(this, _BetaMessageStream_request_id, response?.headers.get("request-id"), "f");
    __classPrivateFieldGet4(this, _BetaMessageStream_resolveConnectedPromise, "f").call(this, response);
    this._emit("connect");
  }
  get ended() {
    return __classPrivateFieldGet4(this, _BetaMessageStream_ended, "f");
  }
  get errored() {
    return __classPrivateFieldGet4(this, _BetaMessageStream_errored, "f");
  }
  get aborted() {
    return __classPrivateFieldGet4(this, _BetaMessageStream_aborted, "f");
  }
  abort() {
    this.controller.abort();
  }
  /**
   * Adds the listener function to the end of the listeners array for the event.
   * No checks are made to see if the listener has already been added. Multiple calls passing
   * the same combination of event and listener will result in the listener being added, and
   * called, multiple times.
   * @returns this MessageStream, so that calls can be chained
   */
  on(event, listener) {
    const listeners = __classPrivateFieldGet4(this, _BetaMessageStream_listeners, "f")[event] || (__classPrivateFieldGet4(this, _BetaMessageStream_listeners, "f")[event] = []);
    listeners.push({ listener });
    return this;
  }
  /**
   * Removes the specified listener from the listener array for the event.
   * off() will remove, at most, one instance of a listener from the listener array. If any single
   * listener has been added multiple times to the listener array for the specified event, then
   * off() must be called multiple times to remove each instance.
   * @returns this MessageStream, so that calls can be chained
   */
  off(event, listener) {
    const listeners = __classPrivateFieldGet4(this, _BetaMessageStream_listeners, "f")[event];
    if (!listeners)
      return this;
    const index = listeners.findIndex((l) => l.listener === listener);
    if (index >= 0)
      listeners.splice(index, 1);
    return this;
  }
  /**
   * Adds a one-time listener function for the event. The next time the event is triggered,
   * this listener is removed and then invoked.
   * @returns this MessageStream, so that calls can be chained
   */
  once(event, listener) {
    const listeners = __classPrivateFieldGet4(this, _BetaMessageStream_listeners, "f")[event] || (__classPrivateFieldGet4(this, _BetaMessageStream_listeners, "f")[event] = []);
    listeners.push({ listener, once: true });
    return this;
  }
  /**
   * This is similar to `.once()`, but returns a Promise that resolves the next time
   * the event is triggered, instead of calling a listener callback.
   * @returns a Promise that resolves the next time given event is triggered,
   * or rejects if an error is emitted.  (If you request the 'error' event,
   * returns a promise that resolves with the error).
   *
   * Example:
   *
   *   const message = await stream.emitted('message') // rejects if the stream errors
   */
  emitted(event) {
    return new Promise((resolve, reject) => {
      __classPrivateFieldSet3(this, _BetaMessageStream_catchingPromiseCreated, true, "f");
      if (event !== "error")
        this.once("error", reject);
      this.once(event, resolve);
    });
  }
  async done() {
    __classPrivateFieldSet3(this, _BetaMessageStream_catchingPromiseCreated, true, "f");
    await __classPrivateFieldGet4(this, _BetaMessageStream_endPromise, "f");
  }
  get currentMessage() {
    return __classPrivateFieldGet4(this, _BetaMessageStream_currentMessageSnapshot, "f");
  }
  /**
   * @returns a promise that resolves with the the final assistant Message response,
   * or rejects if an error occurred or the stream ended prematurely without producing a Message.
   */
  async finalMessage() {
    await this.done();
    return __classPrivateFieldGet4(this, _BetaMessageStream_instances, "m", _BetaMessageStream_getFinalMessage).call(this);
  }
  /**
   * @returns a promise that resolves with the the final assistant Message's text response, concatenated
   * together if there are more than one text blocks.
   * Rejects if an error occurred or the stream ended prematurely without producing a Message.
   */
  async finalText() {
    await this.done();
    return __classPrivateFieldGet4(this, _BetaMessageStream_instances, "m", _BetaMessageStream_getFinalText).call(this);
  }
  _emit(event, ...args) {
    if (__classPrivateFieldGet4(this, _BetaMessageStream_ended, "f"))
      return;
    if (event === "end") {
      __classPrivateFieldSet3(this, _BetaMessageStream_ended, true, "f");
      __classPrivateFieldGet4(this, _BetaMessageStream_resolveEndPromise, "f").call(this);
    }
    const listeners = __classPrivateFieldGet4(this, _BetaMessageStream_listeners, "f")[event];
    if (listeners) {
      __classPrivateFieldGet4(this, _BetaMessageStream_listeners, "f")[event] = listeners.filter((l) => !l.once);
      listeners.forEach(({ listener }) => listener(...args));
    }
    if (event === "abort") {
      const error = args[0];
      if (!__classPrivateFieldGet4(this, _BetaMessageStream_catchingPromiseCreated, "f") && !listeners?.length) {
        Promise.reject(error);
      }
      __classPrivateFieldGet4(this, _BetaMessageStream_rejectConnectedPromise, "f").call(this, error);
      __classPrivateFieldGet4(this, _BetaMessageStream_rejectEndPromise, "f").call(this, error);
      this._emit("end");
      return;
    }
    if (event === "error") {
      const error = args[0];
      if (!__classPrivateFieldGet4(this, _BetaMessageStream_catchingPromiseCreated, "f") && !listeners?.length) {
        Promise.reject(error);
      }
      __classPrivateFieldGet4(this, _BetaMessageStream_rejectConnectedPromise, "f").call(this, error);
      __classPrivateFieldGet4(this, _BetaMessageStream_rejectEndPromise, "f").call(this, error);
      this._emit("end");
    }
  }
  _emitFinal() {
    const finalMessage = this.receivedMessages.at(-1);
    if (finalMessage) {
      this._emit("finalMessage", __classPrivateFieldGet4(this, _BetaMessageStream_instances, "m", _BetaMessageStream_getFinalMessage).call(this));
    }
  }
  async _fromReadableStream(readableStream, options) {
    const signal = options?.signal;
    if (signal) {
      if (signal.aborted)
        this.controller.abort();
      signal.addEventListener("abort", () => this.controller.abort());
    }
    __classPrivateFieldGet4(this, _BetaMessageStream_instances, "m", _BetaMessageStream_beginRequest).call(this);
    this._connected(null);
    const stream = Stream.fromReadableStream(readableStream, this.controller);
    for await (const event of stream) {
      __classPrivateFieldGet4(this, _BetaMessageStream_instances, "m", _BetaMessageStream_addStreamEvent).call(this, event);
    }
    if (stream.controller.signal?.aborted) {
      throw new APIUserAbortError();
    }
    __classPrivateFieldGet4(this, _BetaMessageStream_instances, "m", _BetaMessageStream_endRequest).call(this);
  }
  [(_BetaMessageStream_currentMessageSnapshot = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_connectedPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_resolveConnectedPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_rejectConnectedPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_endPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_resolveEndPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_rejectEndPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_listeners = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_ended = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_errored = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_aborted = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_catchingPromiseCreated = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_response = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_request_id = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_handleError = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_instances = /* @__PURE__ */ new WeakSet(), _BetaMessageStream_getFinalMessage = /* @__PURE__ */ __name(function _BetaMessageStream_getFinalMessage2() {
    if (this.receivedMessages.length === 0) {
      throw new AnthropicError("stream ended without producing a Message with role=assistant");
    }
    return this.receivedMessages.at(-1);
  }, "_BetaMessageStream_getFinalMessage"), _BetaMessageStream_getFinalText = /* @__PURE__ */ __name(function _BetaMessageStream_getFinalText2() {
    if (this.receivedMessages.length === 0) {
      throw new AnthropicError("stream ended without producing a Message with role=assistant");
    }
    const textBlocks = this.receivedMessages.at(-1).content.filter((block) => block.type === "text").map((block) => block.text);
    if (textBlocks.length === 0) {
      throw new AnthropicError("stream ended without producing a content block with type=text");
    }
    return textBlocks.join(" ");
  }, "_BetaMessageStream_getFinalText"), _BetaMessageStream_beginRequest = /* @__PURE__ */ __name(function _BetaMessageStream_beginRequest2() {
    if (this.ended)
      return;
    __classPrivateFieldSet3(this, _BetaMessageStream_currentMessageSnapshot, void 0, "f");
  }, "_BetaMessageStream_beginRequest"), _BetaMessageStream_addStreamEvent = /* @__PURE__ */ __name(function _BetaMessageStream_addStreamEvent2(event) {
    if (this.ended)
      return;
    const messageSnapshot = __classPrivateFieldGet4(this, _BetaMessageStream_instances, "m", _BetaMessageStream_accumulateMessage).call(this, event);
    this._emit("streamEvent", event, messageSnapshot);
    switch (event.type) {
      case "content_block_delta": {
        const content = messageSnapshot.content.at(-1);
        switch (event.delta.type) {
          case "text_delta": {
            if (content.type === "text") {
              this._emit("text", event.delta.text, content.text || "");
            }
            break;
          }
          case "citations_delta": {
            if (content.type === "text") {
              this._emit("citation", event.delta.citation, content.citations ?? []);
            }
            break;
          }
          case "input_json_delta": {
            if (content.type === "tool_use" && content.input) {
              this._emit("inputJson", event.delta.partial_json, content.input);
            }
            break;
          }
          default:
            checkNever(event.delta);
        }
        break;
      }
      case "message_stop": {
        this._addMessageParam(messageSnapshot);
        this._addMessage(messageSnapshot, true);
        break;
      }
      case "content_block_stop": {
        this._emit("contentBlock", messageSnapshot.content.at(-1));
        break;
      }
      case "message_start": {
        __classPrivateFieldSet3(this, _BetaMessageStream_currentMessageSnapshot, messageSnapshot, "f");
        break;
      }
      case "content_block_start":
      case "message_delta":
        break;
    }
  }, "_BetaMessageStream_addStreamEvent"), _BetaMessageStream_endRequest = /* @__PURE__ */ __name(function _BetaMessageStream_endRequest2() {
    if (this.ended) {
      throw new AnthropicError(`stream has ended, this shouldn't happen`);
    }
    const snapshot = __classPrivateFieldGet4(this, _BetaMessageStream_currentMessageSnapshot, "f");
    if (!snapshot) {
      throw new AnthropicError(`request ended without sending any chunks`);
    }
    __classPrivateFieldSet3(this, _BetaMessageStream_currentMessageSnapshot, void 0, "f");
    return snapshot;
  }, "_BetaMessageStream_endRequest"), _BetaMessageStream_accumulateMessage = /* @__PURE__ */ __name(function _BetaMessageStream_accumulateMessage2(event) {
    let snapshot = __classPrivateFieldGet4(this, _BetaMessageStream_currentMessageSnapshot, "f");
    if (event.type === "message_start") {
      if (snapshot) {
        throw new AnthropicError(`Unexpected event order, got ${event.type} before receiving "message_stop"`);
      }
      return event.message;
    }
    if (!snapshot) {
      throw new AnthropicError(`Unexpected event order, got ${event.type} before "message_start"`);
    }
    switch (event.type) {
      case "message_stop":
        return snapshot;
      case "message_delta":
        snapshot.stop_reason = event.delta.stop_reason;
        snapshot.stop_sequence = event.delta.stop_sequence;
        snapshot.usage.output_tokens = event.usage.output_tokens;
        return snapshot;
      case "content_block_start":
        snapshot.content.push(event.content_block);
        return snapshot;
      case "content_block_delta": {
        const snapshotContent = snapshot.content.at(event.index);
        switch (event.delta.type) {
          case "text_delta": {
            if (snapshotContent?.type === "text") {
              snapshotContent.text += event.delta.text;
            }
            break;
          }
          case "citations_delta": {
            if (snapshotContent?.type === "text") {
              snapshotContent.citations ?? (snapshotContent.citations = []);
              snapshotContent.citations.push(event.delta.citation);
            }
            break;
          }
          case "input_json_delta": {
            if (snapshotContent?.type === "tool_use") {
              let jsonBuf = snapshotContent[JSON_BUF_PROPERTY] || "";
              jsonBuf += event.delta.partial_json;
              Object.defineProperty(snapshotContent, JSON_BUF_PROPERTY, {
                value: jsonBuf,
                enumerable: false,
                writable: true
              });
              if (jsonBuf) {
                snapshotContent.input = partialParse(jsonBuf);
              }
            }
            break;
          }
          default:
            checkNever(event.delta);
        }
        return snapshot;
      }
      case "content_block_stop":
        return snapshot;
    }
  }, "_BetaMessageStream_accumulateMessage"), Symbol.asyncIterator)]() {
    const pushQueue = [];
    const readQueue = [];
    let done = false;
    this.on("streamEvent", (event) => {
      const reader = readQueue.shift();
      if (reader) {
        reader.resolve(event);
      } else {
        pushQueue.push(event);
      }
    });
    this.on("end", () => {
      done = true;
      for (const reader of readQueue) {
        reader.resolve(void 0);
      }
      readQueue.length = 0;
    });
    this.on("abort", (err) => {
      done = true;
      for (const reader of readQueue) {
        reader.reject(err);
      }
      readQueue.length = 0;
    });
    this.on("error", (err) => {
      done = true;
      for (const reader of readQueue) {
        reader.reject(err);
      }
      readQueue.length = 0;
    });
    return {
      next: /* @__PURE__ */ __name(async () => {
        if (!pushQueue.length) {
          if (done) {
            return { value: void 0, done: true };
          }
          return new Promise((resolve, reject) => readQueue.push({ resolve, reject })).then((chunk2) => chunk2 ? { value: chunk2, done: false } : { value: void 0, done: true });
        }
        const chunk = pushQueue.shift();
        return { value: chunk, done: false };
      }, "next"),
      return: /* @__PURE__ */ __name(async () => {
        this.abort();
        return { value: void 0, done: true };
      }, "return")
    };
  }
  toReadableStream() {
    const stream = new Stream(this[Symbol.asyncIterator].bind(this), this.controller);
    return stream.toReadableStream();
  }
};
function checkNever(x) {
}
__name(checkNever, "checkNever");

// node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.mjs
var DEPRECATED_MODELS = {
  "claude-1.3": "November 6th, 2024",
  "claude-1.3-100k": "November 6th, 2024",
  "claude-instant-1.1": "November 6th, 2024",
  "claude-instant-1.1-100k": "November 6th, 2024",
  "claude-instant-1.2": "November 6th, 2024",
  "claude-3-sonnet-20240229": "July 21st, 2025",
  "claude-2.1": "July 21st, 2025",
  "claude-2.0": "July 21st, 2025"
};
var Messages = class extends APIResource {
  static {
    __name(this, "Messages");
  }
  constructor() {
    super(...arguments);
    this.batches = new Batches(this._client);
  }
  create(params, options) {
    const { betas, ...body } = params;
    if (body.model in DEPRECATED_MODELS) {
      console.warn(`The model '${body.model}' is deprecated and will reach end-of-life on ${DEPRECATED_MODELS[body.model]}
Please migrate to a newer model. Visit https://docs.anthropic.com/en/docs/resources/model-deprecations for more information.`);
    }
    return this._client.post("/v1/messages?beta=true", {
      body,
      timeout: this._client._options.timeout ?? 6e5,
      ...options,
      headers: {
        ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0,
        ...options?.headers
      },
      stream: params.stream ?? false
    });
  }
  /**
   * Create a Message stream
   */
  stream(body, options) {
    return BetaMessageStream.createMessage(this, body, options);
  }
  /**
   * Count the number of tokens in a Message.
   *
   * The Token Count API can be used to count the number of tokens in a Message,
   * including tools, images, and documents, without creating it.
   */
  countTokens(params, options) {
    const { betas, ...body } = params;
    return this._client.post("/v1/messages/count_tokens?beta=true", {
      body,
      ...options,
      headers: {
        "anthropic-beta": [...betas ?? [], "token-counting-2024-11-01"].toString(),
        ...options?.headers
      }
    });
  }
};
Messages.Batches = Batches;
Messages.BetaMessageBatchesPage = BetaMessageBatchesPage;

// node_modules/@anthropic-ai/sdk/resources/beta/beta.mjs
var Beta = class extends APIResource {
  static {
    __name(this, "Beta");
  }
  constructor() {
    super(...arguments);
    this.models = new Models(this._client);
    this.messages = new Messages(this._client);
  }
};
Beta.Models = Models;
Beta.BetaModelInfosPage = BetaModelInfosPage;
Beta.Messages = Messages;

// node_modules/@anthropic-ai/sdk/resources/completions.mjs
init_esbuild_shims();
var Completions = class extends APIResource {
  static {
    __name(this, "Completions");
  }
  create(body, options) {
    return this._client.post("/v1/complete", {
      body,
      timeout: this._client._options.timeout ?? 6e5,
      ...options,
      stream: body.stream ?? false
    });
  }
};

// node_modules/@anthropic-ai/sdk/resources/messages/messages.mjs
init_esbuild_shims();

// node_modules/@anthropic-ai/sdk/resources/messages/batches.mjs
init_esbuild_shims();
var Batches2 = class extends APIResource {
  static {
    __name(this, "Batches");
  }
  /**
   * Send a batch of Message creation requests.
   *
   * The Message Batches API can be used to process multiple Messages API requests at
   * once. Once a Message Batch is created, it begins processing immediately. Batches
   * can take up to 24 hours to complete.
   */
  create(body, options) {
    return this._client.post("/v1/messages/batches", { body, ...options });
  }
  /**
   * This endpoint is idempotent and can be used to poll for Message Batch
   * completion. To access the results of a Message Batch, make a request to the
   * `results_url` field in the response.
   */
  retrieve(messageBatchId, options) {
    return this._client.get(`/v1/messages/batches/${messageBatchId}`, options);
  }
  list(query = {}, options) {
    if (isRequestOptions(query)) {
      return this.list({}, query);
    }
    return this._client.getAPIList("/v1/messages/batches", MessageBatchesPage, { query, ...options });
  }
  /**
   * Delete a Message Batch.
   *
   * Message Batches can only be deleted once they've finished processing. If you'd
   * like to delete an in-progress batch, you must first cancel it.
   */
  delete(messageBatchId, options) {
    return this._client.delete(`/v1/messages/batches/${messageBatchId}`, options);
  }
  /**
   * Batches may be canceled any time before processing ends. Once cancellation is
   * initiated, the batch enters a `canceling` state, at which time the system may
   * complete any in-progress, non-interruptible requests before finalizing
   * cancellation.
   *
   * The number of canceled requests is specified in `request_counts`. To determine
   * which requests were canceled, check the individual results within the batch.
   * Note that cancellation may not result in any canceled requests if they were
   * non-interruptible.
   */
  cancel(messageBatchId, options) {
    return this._client.post(`/v1/messages/batches/${messageBatchId}/cancel`, options);
  }
  /**
   * Streams the results of a Message Batch as a `.jsonl` file.
   *
   * Each line in the file is a JSON object containing the result of a single request
   * in the Message Batch. Results are not guaranteed to be in the same order as
   * requests. Use the `custom_id` field to match results to requests.
   */
  async results(messageBatchId, options) {
    const batch = await this.retrieve(messageBatchId);
    if (!batch.results_url) {
      throw new AnthropicError(`No batch \`results_url\`; Has it finished processing? ${batch.processing_status} - ${batch.id}`);
    }
    return this._client.get(batch.results_url, {
      ...options,
      headers: {
        Accept: "application/binary",
        ...options?.headers
      },
      __binaryResponse: true
    })._thenUnwrap((_, props) => JSONLDecoder.fromResponse(props.response, props.controller));
  }
};
var MessageBatchesPage = class extends Page {
  static {
    __name(this, "MessageBatchesPage");
  }
};
Batches2.MessageBatchesPage = MessageBatchesPage;

// node_modules/@anthropic-ai/sdk/lib/MessageStream.mjs
init_esbuild_shims();
var __classPrivateFieldSet4 = function(receiver, state, value, kind2, f) {
  if (kind2 === "m") throw new TypeError("Private method is not writable");
  if (kind2 === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind2 === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
};
var __classPrivateFieldGet5 = function(receiver, state, kind2, f) {
  if (kind2 === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind2 === "m" ? f : kind2 === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _MessageStream_instances;
var _MessageStream_currentMessageSnapshot;
var _MessageStream_connectedPromise;
var _MessageStream_resolveConnectedPromise;
var _MessageStream_rejectConnectedPromise;
var _MessageStream_endPromise;
var _MessageStream_resolveEndPromise;
var _MessageStream_rejectEndPromise;
var _MessageStream_listeners;
var _MessageStream_ended;
var _MessageStream_errored;
var _MessageStream_aborted;
var _MessageStream_catchingPromiseCreated;
var _MessageStream_response;
var _MessageStream_request_id;
var _MessageStream_getFinalMessage;
var _MessageStream_getFinalText;
var _MessageStream_handleError;
var _MessageStream_beginRequest;
var _MessageStream_addStreamEvent;
var _MessageStream_endRequest;
var _MessageStream_accumulateMessage;
var JSON_BUF_PROPERTY2 = "__json_buf";
var MessageStream = class _MessageStream {
  static {
    __name(this, "MessageStream");
  }
  constructor() {
    _MessageStream_instances.add(this);
    this.messages = [];
    this.receivedMessages = [];
    _MessageStream_currentMessageSnapshot.set(this, void 0);
    this.controller = new AbortController();
    _MessageStream_connectedPromise.set(this, void 0);
    _MessageStream_resolveConnectedPromise.set(this, () => {
    });
    _MessageStream_rejectConnectedPromise.set(this, () => {
    });
    _MessageStream_endPromise.set(this, void 0);
    _MessageStream_resolveEndPromise.set(this, () => {
    });
    _MessageStream_rejectEndPromise.set(this, () => {
    });
    _MessageStream_listeners.set(this, {});
    _MessageStream_ended.set(this, false);
    _MessageStream_errored.set(this, false);
    _MessageStream_aborted.set(this, false);
    _MessageStream_catchingPromiseCreated.set(this, false);
    _MessageStream_response.set(this, void 0);
    _MessageStream_request_id.set(this, void 0);
    _MessageStream_handleError.set(this, (error) => {
      __classPrivateFieldSet4(this, _MessageStream_errored, true, "f");
      if (error instanceof Error && error.name === "AbortError") {
        error = new APIUserAbortError();
      }
      if (error instanceof APIUserAbortError) {
        __classPrivateFieldSet4(this, _MessageStream_aborted, true, "f");
        return this._emit("abort", error);
      }
      if (error instanceof AnthropicError) {
        return this._emit("error", error);
      }
      if (error instanceof Error) {
        const anthropicError = new AnthropicError(error.message);
        anthropicError.cause = error;
        return this._emit("error", anthropicError);
      }
      return this._emit("error", new AnthropicError(String(error)));
    });
    __classPrivateFieldSet4(this, _MessageStream_connectedPromise, new Promise((resolve, reject) => {
      __classPrivateFieldSet4(this, _MessageStream_resolveConnectedPromise, resolve, "f");
      __classPrivateFieldSet4(this, _MessageStream_rejectConnectedPromise, reject, "f");
    }), "f");
    __classPrivateFieldSet4(this, _MessageStream_endPromise, new Promise((resolve, reject) => {
      __classPrivateFieldSet4(this, _MessageStream_resolveEndPromise, resolve, "f");
      __classPrivateFieldSet4(this, _MessageStream_rejectEndPromise, reject, "f");
    }), "f");
    __classPrivateFieldGet5(this, _MessageStream_connectedPromise, "f").catch(() => {
    });
    __classPrivateFieldGet5(this, _MessageStream_endPromise, "f").catch(() => {
    });
  }
  get response() {
    return __classPrivateFieldGet5(this, _MessageStream_response, "f");
  }
  get request_id() {
    return __classPrivateFieldGet5(this, _MessageStream_request_id, "f");
  }
  /**
   * Returns the `MessageStream` data, the raw `Response` instance and the ID of the request,
   * returned vie the `request-id` header which is useful for debugging requests and resporting
   * issues to Anthropic.
   *
   * This is the same as the `APIPromise.withResponse()` method.
   *
   * This method will raise an error if you created the stream using `MessageStream.fromReadableStream`
   * as no `Response` is available.
   */
  async withResponse() {
    const response = await __classPrivateFieldGet5(this, _MessageStream_connectedPromise, "f");
    if (!response) {
      throw new Error("Could not resolve a `Response` object");
    }
    return {
      data: this,
      response,
      request_id: response.headers.get("request-id")
    };
  }
  /**
   * Intended for use on the frontend, consuming a stream produced with
   * `.toReadableStream()` on the backend.
   *
   * Note that messages sent to the model do not appear in `.on('message')`
   * in this context.
   */
  static fromReadableStream(stream) {
    const runner = new _MessageStream();
    runner._run(() => runner._fromReadableStream(stream));
    return runner;
  }
  static createMessage(messages, params, options) {
    const runner = new _MessageStream();
    for (const message of params.messages) {
      runner._addMessageParam(message);
    }
    runner._run(() => runner._createMessage(messages, { ...params, stream: true }, { ...options, headers: { ...options?.headers, "X-Stainless-Helper-Method": "stream" } }));
    return runner;
  }
  _run(executor) {
    executor().then(() => {
      this._emitFinal();
      this._emit("end");
    }, __classPrivateFieldGet5(this, _MessageStream_handleError, "f"));
  }
  _addMessageParam(message) {
    this.messages.push(message);
  }
  _addMessage(message, emit = true) {
    this.receivedMessages.push(message);
    if (emit) {
      this._emit("message", message);
    }
  }
  async _createMessage(messages, params, options) {
    const signal = options?.signal;
    if (signal) {
      if (signal.aborted)
        this.controller.abort();
      signal.addEventListener("abort", () => this.controller.abort());
    }
    __classPrivateFieldGet5(this, _MessageStream_instances, "m", _MessageStream_beginRequest).call(this);
    const { response, data: stream } = await messages.create({ ...params, stream: true }, { ...options, signal: this.controller.signal }).withResponse();
    this._connected(response);
    for await (const event of stream) {
      __classPrivateFieldGet5(this, _MessageStream_instances, "m", _MessageStream_addStreamEvent).call(this, event);
    }
    if (stream.controller.signal?.aborted) {
      throw new APIUserAbortError();
    }
    __classPrivateFieldGet5(this, _MessageStream_instances, "m", _MessageStream_endRequest).call(this);
  }
  _connected(response) {
    if (this.ended)
      return;
    __classPrivateFieldSet4(this, _MessageStream_response, response, "f");
    __classPrivateFieldSet4(this, _MessageStream_request_id, response?.headers.get("request-id"), "f");
    __classPrivateFieldGet5(this, _MessageStream_resolveConnectedPromise, "f").call(this, response);
    this._emit("connect");
  }
  get ended() {
    return __classPrivateFieldGet5(this, _MessageStream_ended, "f");
  }
  get errored() {
    return __classPrivateFieldGet5(this, _MessageStream_errored, "f");
  }
  get aborted() {
    return __classPrivateFieldGet5(this, _MessageStream_aborted, "f");
  }
  abort() {
    this.controller.abort();
  }
  /**
   * Adds the listener function to the end of the listeners array for the event.
   * No checks are made to see if the listener has already been added. Multiple calls passing
   * the same combination of event and listener will result in the listener being added, and
   * called, multiple times.
   * @returns this MessageStream, so that calls can be chained
   */
  on(event, listener) {
    const listeners = __classPrivateFieldGet5(this, _MessageStream_listeners, "f")[event] || (__classPrivateFieldGet5(this, _MessageStream_listeners, "f")[event] = []);
    listeners.push({ listener });
    return this;
  }
  /**
   * Removes the specified listener from the listener array for the event.
   * off() will remove, at most, one instance of a listener from the listener array. If any single
   * listener has been added multiple times to the listener array for the specified event, then
   * off() must be called multiple times to remove each instance.
   * @returns this MessageStream, so that calls can be chained
   */
  off(event, listener) {
    const listeners = __classPrivateFieldGet5(this, _MessageStream_listeners, "f")[event];
    if (!listeners)
      return this;
    const index = listeners.findIndex((l) => l.listener === listener);
    if (index >= 0)
      listeners.splice(index, 1);
    return this;
  }
  /**
   * Adds a one-time listener function for the event. The next time the event is triggered,
   * this listener is removed and then invoked.
   * @returns this MessageStream, so that calls can be chained
   */
  once(event, listener) {
    const listeners = __classPrivateFieldGet5(this, _MessageStream_listeners, "f")[event] || (__classPrivateFieldGet5(this, _MessageStream_listeners, "f")[event] = []);
    listeners.push({ listener, once: true });
    return this;
  }
  /**
   * This is similar to `.once()`, but returns a Promise that resolves the next time
   * the event is triggered, instead of calling a listener callback.
   * @returns a Promise that resolves the next time given event is triggered,
   * or rejects if an error is emitted.  (If you request the 'error' event,
   * returns a promise that resolves with the error).
   *
   * Example:
   *
   *   const message = await stream.emitted('message') // rejects if the stream errors
   */
  emitted(event) {
    return new Promise((resolve, reject) => {
      __classPrivateFieldSet4(this, _MessageStream_catchingPromiseCreated, true, "f");
      if (event !== "error")
        this.once("error", reject);
      this.once(event, resolve);
    });
  }
  async done() {
    __classPrivateFieldSet4(this, _MessageStream_catchingPromiseCreated, true, "f");
    await __classPrivateFieldGet5(this, _MessageStream_endPromise, "f");
  }
  get currentMessage() {
    return __classPrivateFieldGet5(this, _MessageStream_currentMessageSnapshot, "f");
  }
  /**
   * @returns a promise that resolves with the the final assistant Message response,
   * or rejects if an error occurred or the stream ended prematurely without producing a Message.
   */
  async finalMessage() {
    await this.done();
    return __classPrivateFieldGet5(this, _MessageStream_instances, "m", _MessageStream_getFinalMessage).call(this);
  }
  /**
   * @returns a promise that resolves with the the final assistant Message's text response, concatenated
   * together if there are more than one text blocks.
   * Rejects if an error occurred or the stream ended prematurely without producing a Message.
   */
  async finalText() {
    await this.done();
    return __classPrivateFieldGet5(this, _MessageStream_instances, "m", _MessageStream_getFinalText).call(this);
  }
  _emit(event, ...args) {
    if (__classPrivateFieldGet5(this, _MessageStream_ended, "f"))
      return;
    if (event === "end") {
      __classPrivateFieldSet4(this, _MessageStream_ended, true, "f");
      __classPrivateFieldGet5(this, _MessageStream_resolveEndPromise, "f").call(this);
    }
    const listeners = __classPrivateFieldGet5(this, _MessageStream_listeners, "f")[event];
    if (listeners) {
      __classPrivateFieldGet5(this, _MessageStream_listeners, "f")[event] = listeners.filter((l) => !l.once);
      listeners.forEach(({ listener }) => listener(...args));
    }
    if (event === "abort") {
      const error = args[0];
      if (!__classPrivateFieldGet5(this, _MessageStream_catchingPromiseCreated, "f") && !listeners?.length) {
        Promise.reject(error);
      }
      __classPrivateFieldGet5(this, _MessageStream_rejectConnectedPromise, "f").call(this, error);
      __classPrivateFieldGet5(this, _MessageStream_rejectEndPromise, "f").call(this, error);
      this._emit("end");
      return;
    }
    if (event === "error") {
      const error = args[0];
      if (!__classPrivateFieldGet5(this, _MessageStream_catchingPromiseCreated, "f") && !listeners?.length) {
        Promise.reject(error);
      }
      __classPrivateFieldGet5(this, _MessageStream_rejectConnectedPromise, "f").call(this, error);
      __classPrivateFieldGet5(this, _MessageStream_rejectEndPromise, "f").call(this, error);
      this._emit("end");
    }
  }
  _emitFinal() {
    const finalMessage = this.receivedMessages.at(-1);
    if (finalMessage) {
      this._emit("finalMessage", __classPrivateFieldGet5(this, _MessageStream_instances, "m", _MessageStream_getFinalMessage).call(this));
    }
  }
  async _fromReadableStream(readableStream, options) {
    const signal = options?.signal;
    if (signal) {
      if (signal.aborted)
        this.controller.abort();
      signal.addEventListener("abort", () => this.controller.abort());
    }
    __classPrivateFieldGet5(this, _MessageStream_instances, "m", _MessageStream_beginRequest).call(this);
    this._connected(null);
    const stream = Stream.fromReadableStream(readableStream, this.controller);
    for await (const event of stream) {
      __classPrivateFieldGet5(this, _MessageStream_instances, "m", _MessageStream_addStreamEvent).call(this, event);
    }
    if (stream.controller.signal?.aborted) {
      throw new APIUserAbortError();
    }
    __classPrivateFieldGet5(this, _MessageStream_instances, "m", _MessageStream_endRequest).call(this);
  }
  [(_MessageStream_currentMessageSnapshot = /* @__PURE__ */ new WeakMap(), _MessageStream_connectedPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_resolveConnectedPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_rejectConnectedPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_endPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_resolveEndPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_rejectEndPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_listeners = /* @__PURE__ */ new WeakMap(), _MessageStream_ended = /* @__PURE__ */ new WeakMap(), _MessageStream_errored = /* @__PURE__ */ new WeakMap(), _MessageStream_aborted = /* @__PURE__ */ new WeakMap(), _MessageStream_catchingPromiseCreated = /* @__PURE__ */ new WeakMap(), _MessageStream_response = /* @__PURE__ */ new WeakMap(), _MessageStream_request_id = /* @__PURE__ */ new WeakMap(), _MessageStream_handleError = /* @__PURE__ */ new WeakMap(), _MessageStream_instances = /* @__PURE__ */ new WeakSet(), _MessageStream_getFinalMessage = /* @__PURE__ */ __name(function _MessageStream_getFinalMessage2() {
    if (this.receivedMessages.length === 0) {
      throw new AnthropicError("stream ended without producing a Message with role=assistant");
    }
    return this.receivedMessages.at(-1);
  }, "_MessageStream_getFinalMessage"), _MessageStream_getFinalText = /* @__PURE__ */ __name(function _MessageStream_getFinalText2() {
    if (this.receivedMessages.length === 0) {
      throw new AnthropicError("stream ended without producing a Message with role=assistant");
    }
    const textBlocks = this.receivedMessages.at(-1).content.filter((block) => block.type === "text").map((block) => block.text);
    if (textBlocks.length === 0) {
      throw new AnthropicError("stream ended without producing a content block with type=text");
    }
    return textBlocks.join(" ");
  }, "_MessageStream_getFinalText"), _MessageStream_beginRequest = /* @__PURE__ */ __name(function _MessageStream_beginRequest2() {
    if (this.ended)
      return;
    __classPrivateFieldSet4(this, _MessageStream_currentMessageSnapshot, void 0, "f");
  }, "_MessageStream_beginRequest"), _MessageStream_addStreamEvent = /* @__PURE__ */ __name(function _MessageStream_addStreamEvent2(event) {
    if (this.ended)
      return;
    const messageSnapshot = __classPrivateFieldGet5(this, _MessageStream_instances, "m", _MessageStream_accumulateMessage).call(this, event);
    this._emit("streamEvent", event, messageSnapshot);
    switch (event.type) {
      case "content_block_delta": {
        const content = messageSnapshot.content.at(-1);
        switch (event.delta.type) {
          case "text_delta": {
            if (content.type === "text") {
              this._emit("text", event.delta.text, content.text || "");
            }
            break;
          }
          case "citations_delta": {
            if (content.type === "text") {
              this._emit("citation", event.delta.citation, content.citations ?? []);
            }
            break;
          }
          case "input_json_delta": {
            if (content.type === "tool_use" && content.input) {
              this._emit("inputJson", event.delta.partial_json, content.input);
            }
            break;
          }
          default:
            checkNever2(event.delta);
        }
        break;
      }
      case "message_stop": {
        this._addMessageParam(messageSnapshot);
        this._addMessage(messageSnapshot, true);
        break;
      }
      case "content_block_stop": {
        this._emit("contentBlock", messageSnapshot.content.at(-1));
        break;
      }
      case "message_start": {
        __classPrivateFieldSet4(this, _MessageStream_currentMessageSnapshot, messageSnapshot, "f");
        break;
      }
      case "content_block_start":
      case "message_delta":
        break;
    }
  }, "_MessageStream_addStreamEvent"), _MessageStream_endRequest = /* @__PURE__ */ __name(function _MessageStream_endRequest2() {
    if (this.ended) {
      throw new AnthropicError(`stream has ended, this shouldn't happen`);
    }
    const snapshot = __classPrivateFieldGet5(this, _MessageStream_currentMessageSnapshot, "f");
    if (!snapshot) {
      throw new AnthropicError(`request ended without sending any chunks`);
    }
    __classPrivateFieldSet4(this, _MessageStream_currentMessageSnapshot, void 0, "f");
    return snapshot;
  }, "_MessageStream_endRequest"), _MessageStream_accumulateMessage = /* @__PURE__ */ __name(function _MessageStream_accumulateMessage2(event) {
    let snapshot = __classPrivateFieldGet5(this, _MessageStream_currentMessageSnapshot, "f");
    if (event.type === "message_start") {
      if (snapshot) {
        throw new AnthropicError(`Unexpected event order, got ${event.type} before receiving "message_stop"`);
      }
      return event.message;
    }
    if (!snapshot) {
      throw new AnthropicError(`Unexpected event order, got ${event.type} before "message_start"`);
    }
    switch (event.type) {
      case "message_stop":
        return snapshot;
      case "message_delta":
        snapshot.stop_reason = event.delta.stop_reason;
        snapshot.stop_sequence = event.delta.stop_sequence;
        snapshot.usage.output_tokens = event.usage.output_tokens;
        return snapshot;
      case "content_block_start":
        snapshot.content.push(event.content_block);
        return snapshot;
      case "content_block_delta": {
        const snapshotContent = snapshot.content.at(event.index);
        switch (event.delta.type) {
          case "text_delta": {
            if (snapshotContent?.type === "text") {
              snapshotContent.text += event.delta.text;
            }
            break;
          }
          case "citations_delta": {
            if (snapshotContent?.type === "text") {
              snapshotContent.citations ?? (snapshotContent.citations = []);
              snapshotContent.citations.push(event.delta.citation);
            }
            break;
          }
          case "input_json_delta": {
            if (snapshotContent?.type === "tool_use") {
              let jsonBuf = snapshotContent[JSON_BUF_PROPERTY2] || "";
              jsonBuf += event.delta.partial_json;
              Object.defineProperty(snapshotContent, JSON_BUF_PROPERTY2, {
                value: jsonBuf,
                enumerable: false,
                writable: true
              });
              if (jsonBuf) {
                snapshotContent.input = partialParse(jsonBuf);
              }
            }
            break;
          }
          default:
            checkNever2(event.delta);
        }
        return snapshot;
      }
      case "content_block_stop":
        return snapshot;
    }
  }, "_MessageStream_accumulateMessage"), Symbol.asyncIterator)]() {
    const pushQueue = [];
    const readQueue = [];
    let done = false;
    this.on("streamEvent", (event) => {
      const reader = readQueue.shift();
      if (reader) {
        reader.resolve(event);
      } else {
        pushQueue.push(event);
      }
    });
    this.on("end", () => {
      done = true;
      for (const reader of readQueue) {
        reader.resolve(void 0);
      }
      readQueue.length = 0;
    });
    this.on("abort", (err) => {
      done = true;
      for (const reader of readQueue) {
        reader.reject(err);
      }
      readQueue.length = 0;
    });
    this.on("error", (err) => {
      done = true;
      for (const reader of readQueue) {
        reader.reject(err);
      }
      readQueue.length = 0;
    });
    return {
      next: /* @__PURE__ */ __name(async () => {
        if (!pushQueue.length) {
          if (done) {
            return { value: void 0, done: true };
          }
          return new Promise((resolve, reject) => readQueue.push({ resolve, reject })).then((chunk2) => chunk2 ? { value: chunk2, done: false } : { value: void 0, done: true });
        }
        const chunk = pushQueue.shift();
        return { value: chunk, done: false };
      }, "next"),
      return: /* @__PURE__ */ __name(async () => {
        this.abort();
        return { value: void 0, done: true };
      }, "return")
    };
  }
  toReadableStream() {
    const stream = new Stream(this[Symbol.asyncIterator].bind(this), this.controller);
    return stream.toReadableStream();
  }
};
function checkNever2(x) {
}
__name(checkNever2, "checkNever");

// node_modules/@anthropic-ai/sdk/resources/messages/messages.mjs
var Messages2 = class extends APIResource {
  static {
    __name(this, "Messages");
  }
  constructor() {
    super(...arguments);
    this.batches = new Batches2(this._client);
  }
  create(body, options) {
    if (body.model in DEPRECATED_MODELS2) {
      console.warn(`The model '${body.model}' is deprecated and will reach end-of-life on ${DEPRECATED_MODELS2[body.model]}
Please migrate to a newer model. Visit https://docs.anthropic.com/en/docs/resources/model-deprecations for more information.`);
    }
    return this._client.post("/v1/messages", {
      body,
      timeout: this._client._options.timeout ?? 6e5,
      ...options,
      stream: body.stream ?? false
    });
  }
  /**
   * Create a Message stream
   */
  stream(body, options) {
    return MessageStream.createMessage(this, body, options);
  }
  /**
   * Count the number of tokens in a Message.
   *
   * The Token Count API can be used to count the number of tokens in a Message,
   * including tools, images, and documents, without creating it.
   */
  countTokens(body, options) {
    return this._client.post("/v1/messages/count_tokens", { body, ...options });
  }
};
var DEPRECATED_MODELS2 = {
  "claude-1.3": "November 6th, 2024",
  "claude-1.3-100k": "November 6th, 2024",
  "claude-instant-1.1": "November 6th, 2024",
  "claude-instant-1.1-100k": "November 6th, 2024",
  "claude-instant-1.2": "November 6th, 2024",
  "claude-3-sonnet-20240229": "July 21st, 2025",
  "claude-2.1": "July 21st, 2025",
  "claude-2.0": "July 21st, 2025"
};
Messages2.Batches = Batches2;
Messages2.MessageBatchesPage = MessageBatchesPage;

// node_modules/@anthropic-ai/sdk/resources/models.mjs
init_esbuild_shims();
var Models2 = class extends APIResource {
  static {
    __name(this, "Models");
  }
  /**
   * Get a specific model.
   *
   * The Models API response can be used to determine information about a specific
   * model or resolve a model alias to a model ID.
   */
  retrieve(modelId, options) {
    return this._client.get(`/v1/models/${modelId}`, options);
  }
  list(query = {}, options) {
    if (isRequestOptions(query)) {
      return this.list({}, query);
    }
    return this._client.getAPIList("/v1/models", ModelInfosPage, { query, ...options });
  }
};
var ModelInfosPage = class extends Page {
  static {
    __name(this, "ModelInfosPage");
  }
};
Models2.ModelInfosPage = ModelInfosPage;

// node_modules/@anthropic-ai/sdk/index.mjs
var _a;
var Anthropic = class extends APIClient {
  static {
    __name(this, "Anthropic");
  }
  /**
   * API Client for interfacing with the Anthropic API.
   *
   * @param {string | null | undefined} [opts.apiKey=process.env['ANTHROPIC_API_KEY'] ?? null]
   * @param {string | null | undefined} [opts.authToken=process.env['ANTHROPIC_AUTH_TOKEN'] ?? null]
   * @param {string} [opts.baseURL=process.env['ANTHROPIC_BASE_URL'] ?? https://api.anthropic.com] - Override the default base URL for the API.
   * @param {number} [opts.timeout=10 minutes] - The maximum amount of time (in milliseconds) the client will wait for a response before timing out.
   * @param {number} [opts.httpAgent] - An HTTP agent used to manage HTTP(s) connections.
   * @param {Core.Fetch} [opts.fetch] - Specify a custom `fetch` function implementation.
   * @param {number} [opts.maxRetries=2] - The maximum number of times the client will retry a request.
   * @param {Core.Headers} opts.defaultHeaders - Default headers to include with every request to the API.
   * @param {Core.DefaultQuery} opts.defaultQuery - Default query parameters to include with every request to the API.
   * @param {boolean} [opts.dangerouslyAllowBrowser=false] - By default, client-side use of this library is not allowed, as it risks exposing your secret API credentials to attackers.
   */
  constructor({ baseURL = readEnv("ANTHROPIC_BASE_URL"), apiKey = readEnv("ANTHROPIC_API_KEY") ?? null, authToken = readEnv("ANTHROPIC_AUTH_TOKEN") ?? null, ...opts } = {}) {
    const options = {
      apiKey,
      authToken,
      ...opts,
      baseURL: baseURL || `https://api.anthropic.com`
    };
    if (!options.dangerouslyAllowBrowser && isRunningInBrowser()) {
      throw new AnthropicError("It looks like you're running in a browser-like environment.\n\nThis is disabled by default, as it risks exposing your secret API credentials to attackers.\nIf you understand the risks and have appropriate mitigations in place,\nyou can set the `dangerouslyAllowBrowser` option to `true`, e.g.,\n\nnew Anthropic({ apiKey, dangerouslyAllowBrowser: true });\n");
    }
    super({
      baseURL: options.baseURL,
      timeout: options.timeout ?? 6e5,
      httpAgent: options.httpAgent,
      maxRetries: options.maxRetries,
      fetch: options.fetch
    });
    this.completions = new Completions(this);
    this.messages = new Messages2(this);
    this.models = new Models2(this);
    this.beta = new Beta(this);
    this._options = options;
    this.apiKey = apiKey;
    this.authToken = authToken;
  }
  defaultQuery() {
    return this._options.defaultQuery;
  }
  defaultHeaders(opts) {
    return {
      ...super.defaultHeaders(opts),
      ...this._options.dangerouslyAllowBrowser ? { "anthropic-dangerous-direct-browser-access": "true" } : void 0,
      "anthropic-version": "2023-06-01",
      ...this._options.defaultHeaders
    };
  }
  validateHeaders(headers, customHeaders) {
    if (this.apiKey && headers["x-api-key"]) {
      return;
    }
    if (customHeaders["x-api-key"] === null) {
      return;
    }
    if (this.authToken && headers["authorization"]) {
      return;
    }
    if (customHeaders["authorization"] === null) {
      return;
    }
    throw new Error('Could not resolve authentication method. Expected either apiKey or authToken to be set. Or for one of the "X-Api-Key" or "Authorization" headers to be explicitly omitted');
  }
  authHeaders(opts) {
    const apiKeyAuth = this.apiKeyAuth(opts);
    const bearerAuth = this.bearerAuth(opts);
    if (apiKeyAuth != null && !isEmptyObj(apiKeyAuth)) {
      return apiKeyAuth;
    }
    if (bearerAuth != null && !isEmptyObj(bearerAuth)) {
      return bearerAuth;
    }
    return {};
  }
  apiKeyAuth(opts) {
    if (this.apiKey == null) {
      return {};
    }
    return { "X-Api-Key": this.apiKey };
  }
  bearerAuth(opts) {
    if (this.authToken == null) {
      return {};
    }
    return { Authorization: `Bearer ${this.authToken}` };
  }
};
_a = Anthropic;
Anthropic.Anthropic = _a;
Anthropic.HUMAN_PROMPT = "\n\nHuman:";
Anthropic.AI_PROMPT = "\n\nAssistant:";
Anthropic.DEFAULT_TIMEOUT = 6e5;
Anthropic.AnthropicError = AnthropicError;
Anthropic.APIError = APIError;
Anthropic.APIConnectionError = APIConnectionError;
Anthropic.APIConnectionTimeoutError = APIConnectionTimeoutError;
Anthropic.APIUserAbortError = APIUserAbortError;
Anthropic.NotFoundError = NotFoundError;
Anthropic.ConflictError = ConflictError;
Anthropic.RateLimitError = RateLimitError;
Anthropic.BadRequestError = BadRequestError;
Anthropic.AuthenticationError = AuthenticationError;
Anthropic.InternalServerError = InternalServerError;
Anthropic.PermissionDeniedError = PermissionDeniedError;
Anthropic.UnprocessableEntityError = UnprocessableEntityError;
Anthropic.toFile = toFile;
Anthropic.fileFromPath = fileFromPath;
Anthropic.Completions = Completions;
Anthropic.Messages = Messages2;
Anthropic.Models = Models2;
Anthropic.ModelInfosPage = ModelInfosPage;
Anthropic.Beta = Beta;
var { HUMAN_PROMPT, AI_PROMPT } = Anthropic;
var sdk_default = Anthropic;

// packages/core/src/core/anthropicContentGenerator/converter.ts
init_esbuild_shims();

// packages/core/src/core/anthropicContentGenerator/usage.ts
init_esbuild_shims();
function buildAnthropicUsageMetadata(parts) {
  const { inputTokens, cacheReadTokens, cacheCreationTokens, outputTokens } = parts;
  const looksLikeOpenAi = parts.cacheCreationTokensReported !== true && cacheCreationTokens === 0 && cacheReadTokens > 0 && inputTokens >= cacheReadTokens;
  const promptTotal = looksLikeOpenAi ? inputTokens : inputTokens + cacheReadTokens + cacheCreationTokens;
  const usage = {
    promptTokenCount: promptTotal,
    cachedContentTokenCount: cacheReadTokens,
    ...outputTokens !== void 0 ? {
      candidatesTokenCount: outputTokens,
      totalTokenCount: promptTotal + outputTokens
    } : {}
  };
  setGenAiUsageProvenance(usage, {
    cachedInputTokensReported: parts.cacheReadTokensReported === true,
    cacheCreationInputTokens: parts.cacheCreationTokensReported === true ? cacheCreationTokens : void 0
  });
  return usage;
}
__name(buildAnthropicUsageMetadata, "buildAnthropicUsageMetadata");

// packages/core/src/core/anthropicContentGenerator/converter.ts
var debugLogger = createDebugLogger("AnthropicConverter");
var AnthropicContentConverter = class {
  static {
    __name(this, "AnthropicContentConverter");
  }
  schemaCompliance;
  enableCacheControl;
  /**
   * Per-request tool ID sanitization state (see {@link resolveToolUseId}).
   * The converter instance is long-lived across requests (constructed once
   * per generator), so this state is reset at the top of every
   * `convertLlmRequestToAnthropic` call rather than at construction.
   */
  toolIdMap = /* @__PURE__ */ new Map();
  usedToolIds = /* @__PURE__ */ new Set();
  generatedToolIdCounter = 0;
  constructor(_model, schemaCompliance = "auto", enableCacheControl = true) {
    this.schemaCompliance = schemaCompliance;
    this.enableCacheControl = enableCacheControl;
  }
  convertLlmRequestToAnthropic(request, options = {}) {
    this.resetToolIdState();
    let messages = [];
    const systemText = this.extractTextFromContentUnion(
      request.config?.systemInstruction
    );
    this.processContents(
      request.contents,
      messages,
      !!options.dropUnsignedAssistantThinking
    );
    if (options.stripAssistantThinking) {
      this.stripThinkingFromAssistantMessages(messages);
    }
    if (options.normalizeAssistantThinkingSignature) {
      this.fillMissingThinkingSignatures(messages);
    }
    if (options.injectThinkingOnToolUseTurns) {
      this.injectEmptyThinkingOnToolUseTurns(messages);
    }
    messages = mergeConsecutiveAssistantMessages(messages);
    messages = cleanOrphanedToolCalls(messages);
    messages = mergeConsecutiveAssistantMessages(messages);
    if (options.dropUnsignedAssistantThinking) {
      messages = this.dropUnsignedThinkingFromAssistantMessages(messages);
    }
    if (options.stripTrailingAssistantPrefill) {
      this.stripTrailingAssistantPrefill(messages);
    }
    if (!options.injectThinkingOnToolUseTurns) {
      messages = dropEmptyTextThinkingBlocks(messages);
    }
    if (options.stripAssistantThinking) {
      this.stripThinkingFromAssistantMessages(messages);
    }
    messages = mergeConsecutiveUserMessages(messages);
    if (options.ensureLeadingAssistantThinking) {
      ensureLeadingThinkingOnToolUseAssistantMessages(messages);
    }
    const enableCacheControl = options.enableCacheControl ?? this.enableCacheControl;
    const useGlobalCacheScope = options.useGlobalCacheScope ?? false;
    const cacheRetention = options.cacheRetention ?? "ephemeral";
    const cacheRetentionByBlock = options.cacheRetentionByBlock ?? {};
    const system = enableCacheControl ? this.buildSystemWithCacheControl(
      systemText,
      useGlobalCacheScope,
      options.staticSystemPrefix,
      this.resolveCacheRetention(
        "system",
        cacheRetention,
        cacheRetentionByBlock
      )
    ) : systemText;
    if (enableCacheControl) {
      this.addCacheControlToMessages(
        messages,
        this.resolveCacheRetention(
          "user.last",
          cacheRetention,
          cacheRetentionByBlock
        )
      );
    }
    return {
      system,
      messages
    };
  }
  async convertLlmToolsToAnthropic(llmTools, options = {}) {
    const tools = [];
    for (const tool of llmTools) {
      let actualTool;
      if ("tool" in tool) {
        actualTool = await tool.tool();
      } else {
        actualTool = tool;
      }
      if (!actualTool.functionDeclarations) {
        continue;
      }
      for (const func of actualTool.functionDeclarations) {
        if (!func.name || !func.description) continue;
        let inputSchema;
        if (func.parametersJsonSchema) {
          inputSchema = {
            ...func.parametersJsonSchema
          };
        } else if (func.parameters) {
          inputSchema = func.parameters;
        }
        if (!inputSchema) {
          inputSchema = { type: "object", properties: {} };
        }
        inputSchema = convertSchema(inputSchema, this.schemaCompliance);
        if (typeof inputSchema["type"] !== "string") {
          inputSchema["type"] = "object";
        }
        tools.push({
          name: func.name,
          description: func.description,
          input_schema: inputSchema
        });
      }
    }
    const enableCacheControl = options.enableCacheControl ?? this.enableCacheControl;
    const useGlobalCacheScope = options.useGlobalCacheScope ?? false;
    if (enableCacheControl && tools.length > 0) {
      const lastToolIndex = tools.length - 1;
      const resolvedRetention = this.resolveCacheRetention(
        "tool",
        options.cacheRetention ?? "ephemeral",
        options.cacheRetentionByBlock ?? {}
      );
      tools[lastToolIndex] = {
        ...tools[lastToolIndex],
        cache_control: {
          type: "ephemeral",
          ...useGlobalCacheScope ? { scope: "global" } : {},
          ...resolvedRetention === "1h" ? { ttl: "1h" } : {}
        }
      };
    }
    return tools;
  }
  convertAnthropicResponseToLlm(response) {
    const llmResponse = new GenerateContentResponse();
    const parts = [];
    for (const block of response.content || []) {
      const blockType = String(block["type"] || "");
      if (blockType === "text") {
        const text = typeof block.text === "string" ? block.text : "";
        if (text) {
          parts.push({ text });
        }
      } else if (blockType === "tool_use") {
        const toolUse = block;
        parts.push({
          functionCall: {
            id: typeof toolUse.id === "string" ? toolUse.id : void 0,
            name: typeof toolUse.name === "string" ? toolUse.name : void 0,
            args: this.safeInputToArgs(toolUse.input)
          }
        });
      } else if (blockType === "thinking") {
        const thinking = typeof block.thinking === "string" ? block.thinking : "";
        const signature = typeof block.signature === "string" ? block.signature : "";
        if (thinking || signature) {
          const thoughtPart = {
            text: thinking,
            thought: true,
            thoughtSignature: signature
          };
          parts.push(thoughtPart);
        }
      } else if (blockType === "redacted_thinking") {
        parts.push({ text: "", thought: true });
      }
    }
    const candidate = {
      content: {
        parts,
        role: "model"
      },
      index: 0,
      safetyRatings: []
    };
    const finishReason = this.mapAnthropicFinishReasonToLlm(
      response.stop_reason
    );
    if (finishReason) {
      candidate.finishReason = finishReason;
    }
    llmResponse.candidates = [candidate];
    llmResponse.responseId = response.id;
    llmResponse.createTime = Date.now().toString();
    llmResponse.modelVersion = response.model || void 0;
    llmResponse.promptFeedback = { safetyRatings: [] };
    if (response.usage) {
      llmResponse.usageMetadata = buildAnthropicUsageMetadata({
        inputTokens: response.usage.input_tokens || 0,
        cacheReadTokens: response.usage.cache_read_input_tokens || 0,
        cacheCreationTokens: response.usage.cache_creation_input_tokens || 0,
        outputTokens: response.usage.output_tokens || 0,
        cacheReadTokensReported: typeof response.usage.cache_read_input_tokens === "number",
        cacheCreationTokensReported: typeof response.usage.cache_creation_input_tokens === "number"
      });
    }
    return llmResponse;
  }
  processContents(contents, messages, demoteForeignThoughtToText) {
    if (Array.isArray(contents)) {
      for (const content of contents) {
        this.processContent(content, messages, demoteForeignThoughtToText);
      }
    } else if (contents) {
      this.processContent(contents, messages, demoteForeignThoughtToText);
    }
  }
  processContent(content, messages, demoteForeignThoughtToText) {
    if (typeof content === "string") {
      messages.push({
        role: "user",
        content: [{ type: "text", text: content }]
      });
      return;
    }
    if (!this.isContentObject(content)) return;
    const parts = content.parts || [];
    const role = content.role === "model" ? "assistant" : "user";
    const contentBlocks = [];
    for (const part of parts) {
      if (typeof part === "string") {
        contentBlocks.push({ type: "text", text: part });
        continue;
      }
      if ("text" in part && "thought" in part && part.thought) {
        if (role === "assistant") {
          const thinkingBlock = {
            type: "thinking",
            thinking: part.text || ""
          };
          let dropThinkingBlock = false;
          if ("thoughtSignature" in part && typeof part.thoughtSignature === "string") {
            if (isResponsesReasoningSignature(part.thoughtSignature)) {
              debugLogger.debug(
                "Dropping a Responses reasoning replay payload from thoughtSignature"
              );
              if (demoteForeignThoughtToText) {
                dropThinkingBlock = true;
                if (part.text) {
                  contentBlocks.push({ type: "text", text: part.text });
                }
              }
            } else {
              thinkingBlock.signature = part.thoughtSignature;
            }
          }
          if (!dropThinkingBlock) {
            contentBlocks.push(thinkingBlock);
          }
        }
      }
      if ("text" in part && part.text && !("thought" in part && part.thought)) {
        contentBlocks.push({ type: "text", text: part.text });
      }
      const mediaBlock = this.createMediaBlockFromPart(part);
      if (mediaBlock) {
        contentBlocks.push(mediaBlock);
      }
      if ("functionCall" in part && part.functionCall) {
        if (role === "assistant") {
          contentBlocks.push({
            type: "tool_use",
            id: this.resolveToolUseId(part.functionCall.id),
            name: normalizeMcpToolName(part.functionCall.name || ""),
            input: part.functionCall.args || {}
          });
        }
      }
      if (part.functionResponse) {
        const toolResultBlock = this.createToolResultBlock(
          part.functionResponse
        );
        if (toolResultBlock && role === "user") {
          contentBlocks.push(toolResultBlock);
        }
      }
    }
    if (contentBlocks.length > 0) {
      if (role === "user" && contentBlocks.some((b) => b.type === "tool_result")) {
        contentBlocks.sort((a, b) => {
          if (a.type === "tool_result" && b.type !== "tool_result") return -1;
          if (a.type !== "tool_result" && b.type === "tool_result") return 1;
          return 0;
        });
      }
      messages.push({ role, content: contentBlocks });
    }
  }
  createToolResultBlock(response) {
    const textContent = this.extractFunctionResponseContent(response.response);
    const partBlocks = [];
    for (const part of response.parts || []) {
      const block = this.createMediaBlockFromPart(part);
      if (block) {
        partBlocks.push(block);
      }
    }
    let content;
    if (partBlocks.length > 0) {
      const blocks = [];
      if (textContent) {
        blocks.push({ type: "text", text: textContent });
      }
      blocks.push(...partBlocks);
      content = blocks;
    } else {
      content = textContent;
    }
    return {
      type: "tool_result",
      tool_use_id: this.resolveToolUseId(response.id),
      content,
      ...response.response && Object.prototype.hasOwnProperty.call(response.response, "error") ? { is_error: true } : {}
    };
  }
  resetToolIdState() {
    this.toolIdMap.clear();
    this.usedToolIds.clear();
    this.generatedToolIdCounter = 0;
  }
  /**
   * Resolve a `functionCall.id` / `functionResponse.id` into a wire-safe
   * `tool_use.id` / `tool_result.tool_use_id`. Anthropic validates both
   * fields against `^[a-zA-Z0-9_-]+$` server-side (HTTP 400 otherwise) and
   * rejects the empty string the same way, since `+` requires at least one
   * character. The Gemini lingua-franca's `id` field has no such
   * constraint -- it can carry another provider's ID scheme, a
   * composite/namespaced ID, or be entirely absent.
   *
   * The same source ID always resolves to the same wire ID within a
   * request (memoized in `toolIdMap`), so a `tool_use`/`tool_result` pair
   * that shares a source ID still links up correctly after sanitization.
   * State is scoped to a single `convertLlmRequestToAnthropic` call
   * (reset via {@link resetToolIdState}), since the converter instance
   * itself is long-lived across requests.
   */
  resolveToolUseId(rawId) {
    const sourceId = typeof rawId === "string" ? rawId.trim() : "";
    const existingId = sourceId ? this.toolIdMap.get(sourceId) : void 0;
    if (existingId) {
      return existingId;
    }
    const baseId = sourceId ? this.sanitizeToolUseId(sourceId) : this.nextGeneratedToolId();
    const uniqueId = this.makeUniqueToolUseId(baseId);
    if (sourceId) {
      this.toolIdMap.set(sourceId, uniqueId);
    }
    return uniqueId;
  }
  sanitizeToolUseId(id) {
    const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_");
    return cleaned || this.nextGeneratedToolId();
  }
  nextGeneratedToolId() {
    const id = `tool_${this.generatedToolIdCounter}`;
    this.generatedToolIdCounter += 1;
    return id;
  }
  makeUniqueToolUseId(baseId) {
    if (!this.usedToolIds.has(baseId)) {
      this.usedToolIds.add(baseId);
      return baseId;
    }
    let suffix = 1;
    let candidate = `${baseId}_${suffix}`;
    while (this.usedToolIds.has(candidate)) {
      suffix += 1;
      candidate = `${baseId}_${suffix}`;
    }
    this.usedToolIds.add(candidate);
    return candidate;
  }
  createMediaBlockFromPart(part) {
    if (part.inlineData?.mimeType && part.inlineData?.data) {
      if (this.isSupportedAnthropicImageMimeType(part.inlineData.mimeType)) {
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: part.inlineData.mimeType,
            data: part.inlineData.data
          }
        };
      }
      if (part.inlineData.mimeType === "application/pdf") {
        return {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: part.inlineData.data
          }
        };
      }
      const displayName = part.inlineData.displayName ? ` (${part.inlineData.displayName})` : "";
      return {
        type: "text",
        text: `Unsupported inline media type: ${part.inlineData.mimeType}${displayName}.`
      };
    }
    if (part.fileData?.mimeType && part.fileData?.fileUri) {
      const displayName = part.fileData.displayName ? ` (${part.fileData.displayName})` : "";
      const fileUri = part.fileData.fileUri;
      if (this.isSupportedAnthropicImageMimeType(part.fileData.mimeType)) {
        return {
          type: "image",
          source: {
            type: "url",
            url: fileUri
          }
        };
      }
      if (part.fileData.mimeType === "application/pdf") {
        return {
          type: "document",
          source: {
            type: "url",
            url: fileUri
          }
        };
      }
      return {
        type: "text",
        text: `Unsupported file media type: ${part.fileData.mimeType}${displayName}.`
      };
    }
    return null;
  }
  isSupportedAnthropicImageMimeType(mimeType) {
    return mimeType === "image/jpeg" || mimeType === "image/png" || mimeType === "image/gif" || mimeType === "image/webp";
  }
  extractTextFromContentUnion(contentUnion) {
    if (typeof contentUnion === "string") {
      return contentUnion;
    }
    if (Array.isArray(contentUnion)) {
      return contentUnion.map((item) => this.extractTextFromContentUnion(item)).filter(Boolean).join("\n");
    }
    if (typeof contentUnion === "object" && contentUnion !== null) {
      if ("parts" in contentUnion) {
        const content = contentUnion;
        return content.parts?.map((part) => {
          if (typeof part === "string") return part;
          if ("text" in part) return part.text || "";
          return "";
        }).filter(Boolean).join("\n") || "";
      }
    }
    return "";
  }
  extractFunctionResponseContent(response) {
    if (response === null || response === void 0) {
      return "";
    }
    if (typeof response === "string") {
      return response;
    }
    if (typeof response === "object") {
      const responseObject = response;
      const output = responseObject["output"];
      if (typeof output === "string") {
        return output;
      }
      const error = responseObject["error"];
      if (typeof error === "string") {
        return error;
      }
    }
    try {
      const serialized = JSON.stringify(response);
      return serialized ?? String(response);
    } catch {
      return String(response);
    }
  }
  safeInputToArgs(input) {
    if (input && typeof input === "object") {
      return input;
    }
    if (typeof input === "string") {
      return safeJsonParse(input, {});
    }
    return {};
  }
  mapAnthropicFinishReasonToLlm(reason) {
    if (!reason) return void 0;
    const mapping = {
      end_turn: FinishReason.STOP,
      stop_sequence: FinishReason.STOP,
      tool_use: FinishReason.STOP,
      max_tokens: FinishReason.MAX_TOKENS,
      content_filter: FinishReason.SAFETY,
      // Anthropic's refusal stop_reason is a provider safety decision; it
      // must land in the content-filter family so downstream gates (e.g.
      // the quiet post-tool-result acceptance in llmChat, #9026) keep
      // it fatal instead of masking it with an "(empty content)" turn.
      refusal: FinishReason.SAFETY
    };
    return mapping[reason] || FinishReason.FINISH_REASON_UNSPECIFIED;
  }
  isContentObject(content) {
    return typeof content === "object" && content !== null && "role" in content && "parts" in content && Array.isArray(content["parts"]);
  }
  /**
   * Resolve the effective {@link CacheRetention} for one cache anchor,
   * normalized so retention is monotonically non-increasing in wire order.
   *
   * Render order is `tools` -> `system` -> `messages`, so this converter's
   * three anchors sit on the wire in exactly that order: `tool` -> `system`
   * -> `user.last`. Anthropic requires "cache entries with longer TTL must
   * appear before shorter TTLs" — an anchor at the spec's 5-minute default
   * (no `ttl`) is a short-TTL entry for this rule's purposes, so a raw
   * per-anchor override like `cacheRetentionByBlock: { system: '1h' }`
   * would otherwise leave the (still 5m-default) `tool` anchor ahead of a
   * 1h `system` anchor on the wire — an ordering violation Anthropic 400s
   * on.
   *
   * Resolving with a scan instead of a straight per-anchor lookup avoids
   * that: `anchor` resolves to `'1h'` if `anchor` itself OR any anchor
   * later on the wire resolves to `'1h'`. That makes every
   * `cacheRetentionByBlock` configuration legal — anchors before a `'1h'`
   * anchor are promoted to `'1h'` too — without adding a new error surface
   * or rejecting any input. `{ tool: '1h' }` alone is unaffected (nothing
   * follows it that needs promoting); `{ system: '1h' }` alone now also
   * promotes `tool` to `'1h'`, which is exactly the "cache my big system
   * prompt for an hour" usage the per-anchor override exists for.
   */
  resolveCacheRetention(anchor, cacheRetention, cacheRetentionByBlock) {
    const wireOrder = [
      "tool",
      "system",
      "user.last"
    ];
    const anchorIndex = wireOrder.indexOf(anchor);
    for (let i = wireOrder.length - 1; i >= anchorIndex; i--) {
      if ((cacheRetentionByBlock[wireOrder[i]] ?? cacheRetention) === "1h") {
        return "1h";
      }
    }
    return "ephemeral";
  }
  /**
   * Build system content blocks with cache_control.
   * Anthropic prompt caching requires cache_control on system content.
   * When `useGlobalCacheScope` is set, attach `scope: 'global'` so the
   * system prefix participates in cross-session caching under the
   * `prompt-caching-scope-2026-01-05` beta. Otherwise emit the standard
   * per-session shape so non-Anthropic baseURLs aren't sent a scope
   * extension they may not recognize.
   *
   * When `staticSystemPrefix` matches the beginning of the system text and
   * a suffix follows (git status, session-start context — the volatile
   * tails the client appends after the stable prompt), the text is split
   * into two blocks carrying one breakpoint each:
   *   1. the stable prefix — scoped per `useGlobalCacheScope`, so new
   *      sessions reuse it even though their suffix differs;
   *   2. the end of the full system prompt — always the per-session
   *      `{ type: 'ephemeral' }` shape. The suffix varies across sessions,
   *      so a global-scope entry here would churn cache for zero hits
   *      (same reasoning as `addCacheControlToMessages`). Within a session
   *      it still caches the suffix, and when the suffix changes mid-session
   *      (/cd refreshes git status, session-start context lands) the prefix
   *      breakpoint keeps the big block from re-billing.
   * The split only shapes the outgoing request; stored history and
   * non-Anthropic transports keep seeing a single system string.
   */
  buildSystemWithCacheControl(systemText, useGlobalCacheScope, staticSystemPrefix, cacheRetention = "ephemeral") {
    if (!systemText) {
      return systemText;
    }
    const scopedCacheControl = {
      type: "ephemeral",
      ...useGlobalCacheScope ? { scope: "global" } : {},
      ...cacheRetention === "1h" ? { ttl: "1h" } : {}
    };
    if (staticSystemPrefix && systemText.length > staticSystemPrefix.length && systemText.startsWith(staticSystemPrefix)) {
      return [
        {
          type: "text",
          text: staticSystemPrefix,
          cache_control: scopedCacheControl
        },
        {
          type: "text",
          text: systemText.slice(staticSystemPrefix.length),
          // Deliberately never carries `scope: 'global'` (see class doc
          // above — the suffix varies per session, cross-session reuse
          // has ~zero hit rate). `cacheRetention` still applies: the
          // suffix is cached within a session, and a caller that asked
          // for the 1h tier benefits from it surviving longer gaps
          // between turns even on this volatile block.
          cache_control: {
            type: "ephemeral",
            ...cacheRetention === "1h" ? { ttl: "1h" } : {}
          }
        }
      ];
    }
    return [
      {
        type: "text",
        text: systemText,
        cache_control: scopedCacheControl
      }
    ];
  }
  /**
   * Remove thinking and redacted_thinking blocks from assistant messages.
   * Used by DeepSeek when thinking mode is off but session history still
   * has `thought: true` parts — keeps the request body in sync with the
   * absent top-level `thinking` config.
   *
   * If stripping would leave an assistant message with no content blocks
   * (a thinking-only turn, e.g. one cut off by max_tokens before any text
   * or tool_use was emitted), we keep the original blocks. An empty
   * `content: []` is rejected by the Anthropic API, and dropping the
   * message would break the required user/assistant alternation. DeepSeek
   * empirically tolerates the residual `thinking-block + no-thinking-config`
   * shape (verified against api.deepseek.com/anthropic), so leaving it as
   * an unaltered passthrough is the safer fallback.
   */
  stripThinkingFromAssistantMessages(messages) {
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      if (!Array.isArray(message.content)) continue;
      const filtered = message.content.filter((block) => {
        const t = block.type;
        return t !== "thinking" && t !== "redacted_thinking";
      });
      if (filtered.length === 0) continue;
      if (filtered.length !== message.content.length) {
        message.content = filtered;
      }
    }
  }
  /**
   * Fill in `signature: ''` on every assistant `thinking` block that lacks
   * a `signature` field. Preserves the original thinking text. Common cases:
   *
   * - Cross-provider history where the upstream generator (OpenAI / Gemini /
   *   agent-runtime) only set `thought: true` without a signature.
   * - `redacted_thinking` blocks whose `data` field didn't survive the
   *   round-trip through Gemini Part format.
   *
   * DeepSeek empirically accepts empty signatures, so this keeps the wire
   * shape spec-compliant without discarding any preserved thinking text.
   */
  fillMissingThinkingSignatures(messages) {
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      if (!Array.isArray(message.content)) continue;
      let modified = false;
      const normalized = message.content.map((block) => {
        const b = block;
        if (b.type === "thinking" && typeof b.signature !== "string") {
          modified = true;
          return {
            ...block,
            signature: ""
          };
        }
        return block;
      });
      if (modified) {
        message.content = normalized;
      }
    }
  }
  dropUnsignedThinkingFromAssistantMessages(messages) {
    const cleaned = [];
    const isUnsignedThinking = /* @__PURE__ */ __name((block) => {
      const value = block;
      return value.type === "thinking" && (typeof value.signature !== "string" || value.signature.length === 0);
    }, "isUnsignedThinking");
    const hasBlockType = /* @__PURE__ */ __name((message, type) => Array.isArray(message.content) && message.content.some(
      (block) => block.type === type
    ), "hasBlockType");
    const activeToolUseTurns = /* @__PURE__ */ new Set();
    let cursor = messages.length - 1;
    while (cursor >= 0) {
      let hasToolResult = false;
      while (cursor >= 0 && messages[cursor]?.role === "user") {
        hasToolResult ||= hasBlockType(messages[cursor], "tool_result");
        cursor--;
      }
      const assistant = messages[cursor];
      if (!hasToolResult || !assistant || assistant.role !== "assistant" || !hasBlockType(assistant, "tool_use")) {
        break;
      }
      activeToolUseTurns.add(cursor);
      cursor--;
    }
    for (const [index, message] of messages.entries()) {
      if (message.role !== "assistant" || !Array.isArray(message.content)) {
        cleaned.push(message);
        continue;
      }
      if (!message.content.some(isUnsignedThinking)) {
        cleaned.push(message);
        continue;
      }
      if (activeToolUseTurns.has(index)) {
        throw new Error(
          "Anthropic-compatible proxy omitted the thinking signature for a tool-use turn that is still in progress. Configure the proxy to preserve thinking signatures, or start a new session with reasoning disabled."
        );
      }
      const filtered = message.content.filter(
        (block) => !isUnsignedThinking(block)
      );
      if (filtered.length > 0) {
        cleaned.push({ ...message, content: filtered });
      }
    }
    return cleaned;
  }
  /**
   * DeepSeek's anthropic-compatible API rejects follow-up requests when an
   * assistant turn carrying `tool_use` omits a thinking block while thinking
   * mode is on, returning HTTP 400 ("The content[].thinking in the thinking
   * mode must be passed back to the API."). The model can legitimately
   * return a tool round without thinking content, so prepend a synthetic
   * empty thinking block when one is missing.
   *
   * Live verification against api.deepseek.com/anthropic confirmed the
   * trigger is specific to tool_use turns — plain-text assistant turns
   * without thinking are accepted unchanged. We mirror that boundary here
   * to avoid bloating replay history with synthetic blocks for turns the
   * API already accepts.
   *
   * Should be paired with `fillMissingThinkingSignatures` running first
   * so that signature-less `thinking` blocks become compliant in place
   * (preserving their original text), and this pass then sees them as
   * already-satisfying. https://github.com/QwenLM/qwen-code/issues/3786
   */
  injectEmptyThinkingOnToolUseTurns(messages) {
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      if (!Array.isArray(message.content)) continue;
      const blocks = message.content;
      const hasToolUse = blocks.some(
        (block) => block.type === "tool_use"
      );
      if (!hasToolUse) continue;
      const hasThinking = blocks.some((block) => {
        const t = block.type;
        return t === "thinking" || t === "redacted_thinking";
      });
      if (hasThinking) continue;
      const emptyThinking = {
        type: "thinking",
        thinking: "",
        signature: ""
      };
      message.content = [emptyThinking, ...blocks];
    }
  }
  /**
   * Strip a trailing empty-content assistant message, or append a
   * synthetic user turn to satisfy Anthropic's "must end with a user
   * message" requirement (Opus/Sonnet 4.6+, every 5.x family) when the
   * conversation would otherwise end on a non-empty assistant message.
   * See {@link ConvertLlmRequestToAnthropicOptions.stripTrailingAssistantPrefill}.
   */
  stripTrailingAssistantPrefill(messages) {
    while (messages.length > 0) {
      const last = messages[messages.length - 1];
      if (last.role !== "assistant") return;
      if (!this.isEmptyAssistantMessage(last)) break;
      messages.pop();
    }
    if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
      messages.push({
        role: "user",
        content: [{ type: "text", text: "Continue." }]
      });
    }
  }
  isEmptyAssistantMessage(message) {
    const content = message.content;
    if (!content) return true;
    if (typeof content === "string") return content.trim().length === 0;
    if (!Array.isArray(content) || content.length === 0) return true;
    for (const block of content) {
      const type = block.type;
      if (type === "text") {
        const text = block.text;
        if (typeof text === "string" && text.trim().length > 0) return false;
      } else {
        return false;
      }
    }
    return true;
  }
  /**
   * Add cache_control to the last user message's content.
   * This enables prompt caching for the conversation context.
   *
   * Deliberately emits the per-session `{ type: 'ephemeral' }` shape only —
   * no `scope: 'global'`. The last user message changes every turn (it's
   * the live prompt and any tool_result blocks from the immediately prior
   * round), so cross-session reuse here has effectively zero hit rate and
   * paying the global-scope overhead would just churn cache. The static
   * system prefix and tool prefixes (which DO repeat across sessions) carry
   * `scope: 'global'` instead.
   */
  addCacheControlToMessages(messages, cacheRetention = "ephemeral") {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "user") {
        const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];
        if (content.length > 0) {
          const lastContent = content[content.length - 1];
          if (typeof lastContent === "object" && "type" in lastContent) {
            const type = lastContent.type;
            const isEmptyText = type === "text" && (!("text" in lastContent) || !lastContent.text);
            if ((type === "text" || type === "tool_result") && !isEmptyText) {
              lastContent.cache_control = {
                type: "ephemeral",
                ...cacheRetention === "1h" ? { ttl: "1h" } : {}
              };
            }
          }
          msg.content = content;
        }
        break;
      }
    }
  }
};
function mergeConsecutiveAssistantMessages(messages) {
  const merged = [];
  for (const message of messages) {
    if (message.role === "assistant" && merged.length > 0 && Array.isArray(message.content)) {
      const lastMessage = merged[merged.length - 1];
      if (lastMessage.role === "assistant" && Array.isArray(lastMessage.content)) {
        const lastBlocks = lastMessage.content;
        const currentBlocks = message.content;
        const seenToolUseIds = /* @__PURE__ */ new Set();
        const combined = [
          ...lastBlocks,
          ...currentBlocks
        ].filter((b) => {
          const t = b.type;
          if (t === "tool_use") {
            const id = b.id;
            if (id) {
              if (seenToolUseIds.has(id)) return false;
              seenToolUseIds.add(id);
            }
          }
          return true;
        });
        lastMessage.content = combined;
        continue;
      }
    }
    merged.push(message);
  }
  return merged;
}
__name(mergeConsecutiveAssistantMessages, "mergeConsecutiveAssistantMessages");
function ensureLeadingThinkingOnToolUseAssistantMessages(messages) {
  const blockType = /* @__PURE__ */ __name((b) => b.type, "blockType");
  const isThinking = /* @__PURE__ */ __name((b) => {
    const t = blockType(b);
    return t === "thinking" || t === "redacted_thinking";
  }, "isThinking");
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    if (!Array.isArray(message.content)) continue;
    const blocks = message.content;
    if (blocks.length === 0 || isThinking(blocks[0])) continue;
    if (!blocks.some((b) => blockType(b) === "tool_use")) continue;
    const runStart = blocks.findIndex(isThinking);
    if (runStart === -1) continue;
    let runEnd = runStart;
    while (runEnd < blocks.length && isThinking(blocks[runEnd])) {
      runEnd++;
    }
    const run = blocks.slice(runStart, runEnd);
    const rest = [...blocks.slice(0, runStart), ...blocks.slice(runEnd)];
    message.content = [...run, ...rest];
  }
}
__name(ensureLeadingThinkingOnToolUseAssistantMessages, "ensureLeadingThinkingOnToolUseAssistantMessages");
function makeToolResultDeduper() {
  const seen = /* @__PURE__ */ new Set();
  return (id) => {
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  };
}
__name(makeToolResultDeduper, "makeToolResultDeduper");
function cleanOrphanedToolCalls(messages) {
  const validToolUseBlocks = /* @__PURE__ */ new WeakSet();
  const validToolResultBlocks = /* @__PURE__ */ new WeakSet();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    const blocks = message.content;
    const toolUseBlocks = /* @__PURE__ */ new Map();
    for (const block of blocks) {
      if (block.type === "tool_use") {
        const id = block.id;
        if (id && !toolUseBlocks.has(id)) toolUseBlocks.set(id, block);
      }
    }
    if (toolUseBlocks.size === 0) continue;
    if (i === messages.length - 1) {
      for (const block of toolUseBlocks.values()) {
        validToolUseBlocks.add(block);
      }
      continue;
    }
    for (let j = i + 1; j < messages.length; j++) {
      const nextMessage = messages[j];
      if (!nextMessage || nextMessage.role !== "user" || !Array.isArray(nextMessage.content)) {
        break;
      }
      let seenNonToolResult = false;
      for (const block of nextMessage.content) {
        if (block.type === "tool_result") {
          const id = block.tool_use_id;
          const toolUseBlock = id ? toolUseBlocks.get(id) : void 0;
          if (!seenNonToolResult && toolUseBlock) {
            validToolUseBlocks.add(toolUseBlock);
            validToolResultBlocks.add(block);
          }
        } else {
          seenNonToolResult = true;
        }
      }
    }
  }
  const cleaned = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      cleaned.push(message);
      continue;
    }
    const blocks = message.content;
    const hasToolUse = blocks.some(
      (b) => b.type === "tool_use"
    );
    const hasToolResult = blocks.some(
      (b) => b.type === "tool_result"
    );
    if (!hasToolUse && !hasToolResult) {
      cleaned.push(message);
      continue;
    }
    let toolUseRemoved = false;
    const keepToolResult = makeToolResultDeduper();
    const filtered = blocks.filter((b) => {
      const t = b.type;
      if (t === "tool_use") {
        const id = b.id;
        const keep = !id || validToolUseBlocks.has(b);
        if (!keep) toolUseRemoved = true;
        return keep;
      }
      if (t === "tool_result") {
        const id = b.tool_use_id;
        if (!id) return true;
        if (!validToolResultBlocks.has(b)) return false;
        return keepToolResult(id);
      }
      return true;
    });
    const survivingToolUse = filtered.some(
      (b) => b.type === "tool_use"
    );
    const finalBlocks = toolUseRemoved && !survivingToolUse && message.role === "assistant" ? filtered.filter((b) => {
      const t = b.type;
      return t !== "thinking" && t !== "redacted_thinking";
    }) : filtered;
    if (finalBlocks.length > 0) {
      cleaned.push({ ...message, content: finalBlocks });
    } else {
      debugLogger.debug(
        "cleanOrphanedToolCalls: dropping message with only orphaned tool blocks"
      );
    }
  }
  return cleaned;
}
__name(cleanOrphanedToolCalls, "cleanOrphanedToolCalls");
function dropEmptyTextThinkingBlocks(messages) {
  let latestAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      latestAssistantIdx = i;
      break;
    }
  }
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }
    if (i === latestAssistantIdx) {
      out.push(msg);
      continue;
    }
    const blocks = msg.content;
    const filtered = blocks.filter((raw) => {
      const bType = raw.type;
      const bThinkingRaw = raw.thinking;
      const bThinking = typeof bThinkingRaw === "string" ? bThinkingRaw : void 0;
      return !(bType === "thinking" && (bThinking === void 0 || bThinking.length === 0));
    });
    if (filtered.length === 0) continue;
    out.push({ role: msg.role, content: filtered });
  }
  return out;
}
__name(dropEmptyTextThinkingBlocks, "dropEmptyTextThinkingBlocks");
function mergeConsecutiveUserMessages(messages) {
  const merged = [];
  for (const message of messages) {
    const lastMessage = merged[merged.length - 1];
    if (message.role === "user" && lastMessage?.role === "user" && Array.isArray(message.content) && Array.isArray(lastMessage.content)) {
      const combined = [
        ...lastMessage.content,
        ...message.content
      ];
      const keepToolResult = makeToolResultDeduper();
      const toolResults = combined.filter((b) => {
        if (b.type !== "tool_result") return false;
        const id = b.tool_use_id;
        return keepToolResult(id);
      });
      lastMessage.content = [
        ...toolResults,
        ...combined.filter(
          (b) => b.type !== "tool_result"
        )
      ];
      continue;
    }
    merged.push(message);
  }
  return merged;
}
__name(mergeConsecutiveUserMessages, "mergeConsecutiveUserMessages");

// packages/core/src/core/anthropicContentGenerator/anthropicContentGenerator.ts
var debugLogger2 = createDebugLogger("ANTHROPIC");
function normalizeStreamError(error) {
  const redacted = redactProxyError(error);
  if (!(redacted instanceof Error) || getErrorStatus(redacted) !== void 0) {
    return redacted;
  }
  let payload;
  try {
    payload = JSON.parse(redacted.message);
  } catch {
    return redacted;
  }
  if (payload?.error?.type === "api_error" && typeof payload.error.message === "string" && /^Streaming error: 404: Rate limit exceeded on Anthropic API\.?$/i.test(
    payload.error.message.trim()
  )) {
    return Object.assign(new Error(redacted.message, { cause: redacted }), {
      status: 429
    });
  }
  return redacted;
}
__name(normalizeStreamError, "normalizeStreamError");
function isDeepSeekAnthropicHostname(contentGeneratorConfig) {
  const baseUrl = contentGeneratorConfig.baseUrl ?? "";
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "api.deepseek.com" || hostname.endsWith(".api.deepseek.com");
  } catch {
    return false;
  }
}
__name(isDeepSeekAnthropicHostname, "isDeepSeekAnthropicHostname");
function isDeepSeekAnthropicProvider(contentGeneratorConfig) {
  if (isDeepSeekAnthropicHostname(contentGeneratorConfig)) return true;
  const model = (contentGeneratorConfig.model ?? "").toLowerCase();
  return model.includes("deepseek");
}
__name(isDeepSeekAnthropicProvider, "isDeepSeekAnthropicProvider");
function resolveEffectiveBaseUrl(contentGeneratorConfig) {
  const fromConfig = contentGeneratorConfig.baseUrl?.trim();
  if (fromConfig) return fromConfig;
  const fromEnv = process.env["ANTHROPIC_BASE_URL"]?.trim();
  if (fromEnv) return fromEnv;
  return "https://api.anthropic.com";
}
__name(resolveEffectiveBaseUrl, "resolveEffectiveBaseUrl");
function isAnthropicNativeBaseUrl(contentGeneratorConfig) {
  try {
    const hostname = new URL(
      resolveEffectiveBaseUrl(contentGeneratorConfig)
    ).hostname.toLowerCase();
    return hostname === "api.anthropic.com" || hostname.endsWith(".anthropic.com");
  } catch {
    return false;
  }
}
__name(isAnthropicNativeBaseUrl, "isAnthropicNativeBaseUrl");
var AnthropicContentGenerator = class {
  constructor(contentGeneratorConfig, cliConfig) {
    this.contentGeneratorConfig = contentGeneratorConfig;
    this.cliConfig = cliConfig;
    const useProxyIdentity = !isAnthropicNativeBaseUrl(contentGeneratorConfig);
    const defaultHeaders = this.buildHeaders(useProxyIdentity);
    const baseURL = contentGeneratorConfig.baseUrl;
    const runtimeOptions = buildRuntimeFetchOptions(
      "anthropic",
      this.cliConfig.getProxy()
    );
    this.client = new sdk_default({
      ...useProxyIdentity ? { authToken: contentGeneratorConfig.apiKey, apiKey: null } : { apiKey: contentGeneratorConfig.apiKey, authToken: null },
      baseURL,
      timeout: resolveRequestTimeout(contentGeneratorConfig.timeout),
      maxRetries: contentGeneratorConfig.maxRetries,
      defaultHeaders,
      ...runtimeOptions,
      fetch: buildSessionAwareFetch(
        runtimeOptions.fetch,
        this.cliConfig,
        this.contentGeneratorConfig.customHeaders
      )
    });
    this.converter = new AnthropicContentConverter(
      contentGeneratorConfig.model,
      contentGeneratorConfig.schemaCompliance,
      contentGeneratorConfig.enableCacheControl
    );
    this.streamIdleTimeoutMs = resolveStreamIdleTimeoutMs(
      contentGeneratorConfig
    );
    this.streamMaxLifetimeMs = resolveStreamMaxLifetimeMs(
      contentGeneratorConfig
    );
  }
  static {
    __name(this, "AnthropicContentGenerator");
  }
  client;
  converter;
  // Latch so the 'max' clamp warning fires once per generator lifetime
  // instead of on every request that needs the downgrade.
  effortClampWarned = false;
  budgetDropWarned = false;
  temperatureDropWarned = false;
  // Stream watchdog tuning, resolved once (config field > env > default) so
  // the env read + any invalid-value warning happen per generator, not per
  // streaming request. Same guards the OpenAI pipeline applies — the two
  // wires must not differ on whether a stalled stream is recoverable
  // (issue #9005 finding 4).
  streamIdleTimeoutMs;
  streamMaxLifetimeMs;
  async generateContent(request) {
    let response;
    const parentSignal = request.config?.abortSignal;
    const perRequestAc = parentSignal ? createChildAbortController(parentSignal) : void 0;
    try {
      const anthropicRequest = await this.buildRequest(request);
      runtimeDiagnostics.recordAnthropicWireRequest(anthropicRequest);
      const telemetryAttempt = reportAnthropicRequest(anthropicRequest);
      const headers = this.buildPerRequestHeaders(anthropicRequest);
      response = await this.client.messages.create(anthropicRequest, {
        signal: perRequestAc?.signal,
        ...headers ? { headers } : {}
      });
      reportAnthropicResponse(telemetryAttempt, response);
    } catch (error) {
      throw redactProxyError(error);
    } finally {
      perRequestAc?.abort();
    }
    return this.converter.convertAnthropicResponseToLlm(response);
  }
  async generateContentStream(request) {
    const anthropicRequest = await this.buildRequest(request);
    const headers = this.buildPerRequestHeaders(anthropicRequest);
    const streamingRequest = {
      ...anthropicRequest,
      stream: true
    };
    runtimeDiagnostics.recordAnthropicWireRequest(streamingRequest);
    const telemetryAttempt = reportAnthropicRequest(streamingRequest);
    const perRequestAc = createChildAbortController(
      request.config?.abortSignal
    );
    let stream;
    try {
      stream = await this.client.messages.create(
        streamingRequest,
        {
          signal: perRequestAc.signal,
          ...headers ? { headers } : {}
        }
      );
    } catch (error) {
      perRequestAc.abort();
      throw redactProxyError(error);
    }
    const idleMs = this.streamIdleTimeoutMs;
    const maxLifetimeMs = this.streamMaxLifetimeMs;
    const guardedStream = idleMs > 0 || maxLifetimeMs > 0 ? withStreamGuards(
      stream,
      idleMs,
      maxLifetimeMs,
      () => perRequestAc.abort(),
      request.config?.abortSignal
    ) : stream;
    const inner = this.processStreamWithEmptyFallback(
      this.redactStreamErrors(guardedStream),
      anthropicRequest,
      // The empty-stream fallback probe needs a signal that is still live
      // after the source stream drains. The shared stream guard aborts
      // `perRequestAc` in its `finally` the moment the source drains — which
      // happens before the probe runs — so pass the caller's signal instead;
      // the probe derives its own short-lived child from it.
      request.config?.abortSignal,
      headers,
      telemetryAttempt
    );
    async function* drainThenCleanup() {
      try {
        yield* inner;
      } finally {
        perRequestAc.abort();
      }
    }
    __name(drainThenCleanup, "drainThenCleanup");
    return drainThenCleanup();
  }
  async embedContent(_request) {
    throw new Error("Anthropic does not support embeddings.");
  }
  buildHeaders(useProxyIdentity) {
    const version = this.cliConfig.getCliVersion() || "unknown";
    const userAgent = useProxyIdentity ? `claude-cli/${version} (external, cli)` : `QwenCode/${version} (${process.platform}; ${process.arch})`;
    const { customHeaders } = this.contentGeneratorConfig;
    const headers = {
      "User-Agent": userAgent
    };
    if (useProxyIdentity) {
      headers["x-app"] = "cli";
    }
    if (customHeaders) {
      for (const [key, value] of Object.entries(customHeaders)) {
        if (key.toLowerCase() === "anthropic-beta") continue;
        headers[key] = value;
      }
    }
    return headers;
  }
  /**
   * Compute `anthropic-beta` from the actual fields present in the request
   * body. Keeps the header consistent with the body even when a per-request
   * `thinkingConfig.includeThoughts: false` opt-out drops `thinking` /
   * `output_config` after the constructor has already run.
   *
   * User-supplied `customHeaders['anthropic-beta']` flags are merged in (and
   * deduped) so the per-request override doesn't wipe out the existing
   * customHeaders escape hatch for unrelated beta features. The lookup is
   * case-insensitive — HTTP header names are case-insensitive by spec, so a
   * user-configured `Anthropic-Beta` or `ANTHROPIC-BETA` is honored too.
   */
  buildPerRequestHeaders(anthropicRequest) {
    const betas = [];
    for (const flag of this.collectCustomBetaFlags()) {
      betas.push(flag);
    }
    if (anthropicRequest.thinking) {
      betas.push("interleaved-thinking-2025-05-14");
    }
    if (anthropicRequest.output_config) {
      betas.push("effort-2025-11-24");
    }
    if (this.hasGlobalCacheScopeOnWire(anthropicRequest)) {
      betas.push("prompt-caching-scope-2026-01-05");
    }
    if (this.hasExtendedCacheTtlOnWire(anthropicRequest)) {
      betas.push("extended-cache-ttl-2025-04-11");
    }
    if (betas.length === 0) return void 0;
    const unique = Array.from(new Set(betas));
    return { "anthropic-beta": unique.join(",") };
  }
  /**
   * Whether to ATTACH the body-side `scope: 'global'` field on
   * `cache_control` entries this request. Requires
   * `enableCacheControl !== false` AND either an Anthropic-native baseURL
   * OR `forceGlobalCacheScope` (opt-in for proxy providers that forward
   * the `prompt-caching-scope-2026-01-05` beta; see issue #6642).
   * Computed per request: `Config.handleModelChange()` hot-updates
   * `enableCacheControl` in-place on the qwen-oauth path (without
   * recreating the ContentGenerator); non-qwen-oauth providers refresh
   * via generator recreation, which captures `baseUrl` fresh at
   * construct time (not mutated). Reading both fields each request is
   * the right defense — cheap and avoids stale-cache surprises if the
   * hot-update list ever expands.
   *
   * The matching `prompt-caching-scope-2026-01-05` beta header is NOT
   * gated on this predicate directly; instead `buildPerRequestHeaders`
   * scans the assembled body via `hasGlobalCacheScopeOnWire` so the beta
   * and the body field always agree even in degenerate cases (e.g.
   * empty-system + no-tools request — predicate true, body has nothing
   * to attach scope to, beta correctly suppressed).
   */
  useGlobalCacheScope() {
    if (this.contentGeneratorConfig.enableCacheControl === false) {
      return false;
    }
    return isAnthropicNativeBaseUrl(this.contentGeneratorConfig) || this.contentGeneratorConfig.forceGlobalCacheScope === true;
  }
  /**
   * Whether the assembled request body carries any
   * `cache_control: { …, scope: 'global' }` entry. Scans the system
   * block (when present as TextBlockParam[]) and the tools array — these
   * are the only two places the converter attaches scoped cache control.
   * Used to gate the `prompt-caching-scope-2026-01-05` beta header so it
   * never ships without a matching body field, and conversely so the
   * field never ships without the beta declaring it.
   */
  hasGlobalCacheScopeOnWire(req) {
    const isGlobalScope = /* @__PURE__ */ __name((block) => {
      if (!block || typeof block !== "object") return false;
      const cc = block.cache_control;
      if (!cc || typeof cc !== "object") return false;
      return cc.scope === "global";
    }, "isGlobalScope");
    if (Array.isArray(req.system)) {
      for (const block of req.system) {
        if (isGlobalScope(block)) return true;
      }
    }
    if (Array.isArray(req.tools)) {
      for (const tool of req.tools) {
        if (isGlobalScope(tool)) return true;
      }
    }
    return false;
  }
  /**
   * Whether the assembled request body carries any
   * `cache_control: { ..., ttl: '1h' }` entry. Scans the system block,
   * tools array, and message content blocks — every place the converter
   * attaches `cache_control` (system text, last tool, trailing user
   * message). Used to gate the `extended-cache-ttl-2025-04-11` beta
   * header defensively: live verification found the header has no
   * observable effect on this proxy/Vertex backend (identical
   * `ephemeral_1h_input_tokens` with and without it), but a hard
   * requirement can't be ruled out for every Anthropic-compatible
   * backend, so it is sent whenever the body actually requests the 1h
   * tier -- same single-source-of-truth pattern as
   * {@link hasGlobalCacheScopeOnWire}.
   */
  hasExtendedCacheTtlOnWire(req) {
    const hasTtl1h = /* @__PURE__ */ __name((block) => {
      if (!block || typeof block !== "object") return false;
      const cc = block.cache_control;
      if (!cc || typeof cc !== "object") return false;
      return cc.ttl === "1h";
    }, "hasTtl1h");
    if (Array.isArray(req.system)) {
      for (const block of req.system) {
        if (hasTtl1h(block)) return true;
      }
    }
    if (Array.isArray(req.tools)) {
      for (const tool of req.tools) {
        if (hasTtl1h(tool)) return true;
      }
    }
    if (Array.isArray(req.messages)) {
      for (const message of req.messages) {
        if (!Array.isArray(message.content)) continue;
        for (const block of message.content) {
          if (hasTtl1h(block)) return true;
        }
      }
    }
    return false;
  }
  /**
   * Read every customHeaders entry whose key (case-insensitively) is
   * `anthropic-beta` and yield the comma-separated flags from each. Multiple
   * matching entries are concatenated; later ones may produce duplicates
   * which the caller dedupes.
   */
  collectCustomBetaFlags() {
    const customHeaders = this.contentGeneratorConfig.customHeaders;
    if (!customHeaders) return [];
    const flags = [];
    for (const [key, value] of Object.entries(customHeaders)) {
      if (key.toLowerCase() !== "anthropic-beta") continue;
      if (typeof value !== "string" || !value) continue;
      for (const flag of value.split(",")) {
        const trimmed = flag.trim();
        if (trimmed) flags.push(trimmed);
      }
    }
    return flags;
  }
  async buildRequest(request) {
    const sampling = this.buildSamplingParameters(request);
    const effectiveEffort = this.resolveEffectiveEffort(request);
    let thinking = this.buildThinkingConfig(request, effectiveEffort);
    const outputConfig = this.buildOutputConfig(request, effectiveEffort);
    const profile = this.getReasoningCapabilities()?.profile;
    if (profile === "anthropic-manual" && thinking?.type === "enabled") {
      const budget = Math.min(thinking.budget_tokens, sampling.max_tokens - 1);
      thinking = budget >= 1024 ? { ...thinking, budget_tokens: budget } : void 0;
      if (thinking && sampling.temperature !== void 0)
        sampling.temperature = 1;
    }
    const isDeepSeek = isDeepSeekAnthropicHostname(this.contentGeneratorConfig) || (profile ? profile === "deepseek-anthropic" : isDeepSeekAnthropicProvider(this.contentGeneratorConfig));
    const deepseekThinkingOn = isDeepSeek && !!thinking;
    const stripAssistantThinking = isDeepSeek && !thinking;
    const dropUnsignedAssistantThinking = !isDeepSeek && !!thinking && this.modelSupportsAdaptiveThinking(true) && !isAnthropicNativeBaseUrl(this.contentGeneratorConfig);
    const stripTrailingAssistantPrefill = this.modelSupportsAdaptiveThinking(true);
    const enableCacheControl = this.contentGeneratorConfig.enableCacheControl !== false;
    const useGlobalCacheScope = this.useGlobalCacheScope();
    const cacheRetention = this.contentGeneratorConfig.cacheRetention;
    const cacheRetentionByBlock = this.contentGeneratorConfig.cacheRetentionByBlock;
    const { system, messages } = this.converter.convertLlmRequestToAnthropic(
      request,
      {
        // DeepSeek normalization and injection run together. Proxy-hosted
        // Claude uses the separate unsigned-thinking cleanup below because an
        // empty string cannot replace Claude's opaque signature.
        normalizeAssistantThinkingSignature: deepseekThinkingOn,
        injectThinkingOnToolUseTurns: deepseekThinkingOn,
        dropUnsignedAssistantThinking,
        stripAssistantThinking,
        stripTrailingAssistantPrefill,
        // Manual (non-adaptive) extended thinking requires an assistant
        // turn to begin with a thinking block whenever a tool_use remains
        // in it; adaptive thinking relaxes this. Applied to every such turn
        // in history, not just the latest -- see
        // ensureLeadingAssistantThinking's doc in the converter.
        ensureLeadingAssistantThinking: thinking?.type === "enabled",
        enableCacheControl,
        useGlobalCacheScope,
        cacheRetention,
        cacheRetentionByBlock,
        // Read per request (not latched at construction): the client
        // re-records the prefix whenever it rebuilds the system prompt
        // (memory refresh, model change), and the converter fails open to
        // the single-block layout when the request's system text doesn't
        // start with it (subagent prompts, stale prefix).
        staticSystemPrefix: this.cliConfig.getStaticSystemPrefix()
      }
    );
    const tools = request.config?.tools ? await this.converter.convertLlmToolsToAnthropic(request.config.tools, {
      enableCacheControl,
      useGlobalCacheScope,
      cacheRetention,
      cacheRetentionByBlock
    }) : void 0;
    const toolChoice = this.resolveToolChoice(request, tools);
    return {
      model: this.contentGeneratorConfig.model,
      system,
      messages,
      tools,
      ...sampling,
      ...thinking ? { thinking } : {},
      ...outputConfig ? { output_config: outputConfig } : {},
      ...toolChoice ? { tool_choice: toolChoice } : {}
    };
  }
  buildSamplingParameters(request) {
    const configSamplingParams = this.contentGeneratorConfig.samplingParams;
    const requestConfig = request.config || {};
    const getParam = /* @__PURE__ */ __name((configKey, requestKey) => {
      const configValue = configSamplingParams?.[configKey];
      const requestValue = requestKey ? requestConfig[requestKey] : void 0;
      return configValue !== void 0 ? configValue : requestValue;
    }, "getParam");
    const configMaxTokens = configSamplingParams?.max_tokens;
    const requestMaxTokens = requestConfig.maxOutputTokens;
    const userMaxTokens = reconcileMaxTokens(configMaxTokens, requestMaxTokens) ?? configMaxTokens ?? requestMaxTokens;
    const modelId = this.contentGeneratorConfig.model;
    const modelLimit = tokenLimit(modelId, "output");
    const isKnownModel = hasExplicitOutputLimit(modelId);
    let maxTokens;
    if (userMaxTokens !== void 0 && userMaxTokens !== null) {
      maxTokens = isKnownModel ? Math.min(userMaxTokens, modelLimit) : userMaxTokens;
    } else {
      const envMaxTokens = parsePositiveIntegerEnvValue(
        process.env["QWEN_CODE_MAX_OUTPUT_TOKENS"]
      );
      if (envMaxTokens !== void 0) {
        maxTokens = isKnownModel ? Math.min(envMaxTokens, modelLimit) : envMaxTokens;
      } else {
        maxTokens = defaultOutputCeiling(modelId);
      }
    }
    const temperatureDropped = this.modelRejectsTemperature();
    if (temperatureDropped && !this.temperatureDropWarned) {
      const userTemp = getParam("temperature", "temperature");
      if (userTemp !== void 0) {
        debugLogger2.warn(
          `temperature=${userTemp} is not supported by '${this.contentGeneratorConfig.model ?? "unknown"}' (deprecated on 4.8+); ignoring.`
        );
      }
      this.temperatureDropWarned = true;
    }
    return {
      max_tokens: maxTokens,
      ...temperatureDropped ? {} : { temperature: getParam("temperature", "temperature") ?? 1 },
      top_p: getParam("top_p", "topP"),
      top_k: getParam("top_k", "topK")
    };
  }
  /**
   * Compute the effort value that both the thinking budget ladder and
   * output_config should use for this request. Returns undefined whenever
   * reasoning is disabled or the user didn't set an effort. Clamps the
   * DeepSeek-only 'max' tier to 'high' when the resolved baseURL is NOT a
   * DeepSeek hostname (real Anthropic accepts low/medium/high only and
   * would 400 on 'max'). Uses the hostname-only detector deliberately —
   * the broader `isDeepSeekAnthropicProvider` model-name fallback exists
   * for the thinking-block injection workaround (sglang/vllm self-hosted
   * coverage), but trusting it here would let a model named e.g.
   * "deepseek-clone" running on real api.anthropic.com bypass the clamp.
   *
   * The downgrade warning fires once per generator lifetime via the
   * `effortClampWarned` latch — repeating on every request just spams
   * the log without giving users new information.
   */
  resolveEffectiveEffort(request) {
    if (request.config?.thinkingConfig?.includeThoughts === false) {
      return void 0;
    }
    const reasoning = getEffectiveReasoning(
      this.contentGeneratorConfig,
      this.getReasoningCapabilities()
    );
    if (reasoning === false || reasoning === void 0) {
      return void 0;
    }
    const effort = reasoning.effort;
    if (effort === void 0) {
      return void 0;
    }
    if (this.getReasoningCapabilities()?.profile) return effort;
    if (isDeepSeekAnthropicHostname(this.contentGeneratorConfig)) {
      const mapped = effort === "xhigh" || effort === "max" ? "max" : "high";
      if (mapped !== effort && !this.effortClampWarned) {
        debugLogger2.warn(
          `reasoning.effort='${effort}' is not accepted by the DeepSeek anthropic-compatible endpoint; using '${mapped}'.`
        );
        this.effortClampWarned = true;
      }
      return mapped;
    }
    const supported = anthropicSupportedEffortTiers(
      this.contentGeneratorConfig.model ?? ""
    );
    const clamped = clampReasoningEffort(effort, supported);
    if (clamped !== effort && !this.effortClampWarned) {
      debugLogger2.warn(
        `reasoning.effort='${effort}' is not supported by '${this.contentGeneratorConfig.model ?? "unknown"}'; using '${clamped}'.`
      );
      this.effortClampWarned = true;
    }
    return clamped;
  }
  getReasoningCapabilities() {
    return resolveReasoningForModel(
      this.cliConfig,
      this.contentGeneratorConfig
    );
  }
  /**
   * Check if the current model supports adaptive thinking (type: 'adaptive').
   * Claude 4.6+ models require adaptive thinking; older models use the
   * budget-based config. Shares `parseClaudeModelVersion` with
   * `anthropicSupportedEffortTiers` so the family list and the date-suffix guard
   * stay in lockstep — a model parsed for effort gating is parsed identically
   * here for the thinking shape.
   */
  modelSupportsAdaptiveThinking(history = false) {
    const profile = this.getReasoningCapabilities()?.profile;
    if (profile === "anthropic-adaptive") return true;
    if (profile && !history) return false;
    const parsed = parseClaudeModelVersion(
      this.contentGeneratorConfig.model || ""
    );
    if (!parsed) return false;
    const { major, minor } = parsed;
    return major > 4 || major === 4 && minor >= 6;
  }
  /**
   * Whether the model rejects the manual `thinking: { type: 'enabled',
   * budget_tokens: N }` shape with a 400. Opus 4.7+ and every 5.x family
   * (Fable 5, Mythos 5, Sonnet 5, …) dropped manual extended thinking in favor
   * of adaptive thinking, so a budget-tokens-shaped request errors on those
   * models — they must use `{ type: 'adaptive' }` with `output_config.effort`
   * instead (https://platform.claude.com/docs/en/build-with-claude/effort).
   * Opus 4.5/4.6 and Sonnet 4.6 still accept `budget_tokens` (deprecated on
   * 4.6), and unknown/unversioned ids keep the manual escape hatch, so both
   * return false. Shares `parseClaudeModelVersion` with the effort/adaptive
   * gates so the version rules can't drift.
   */
  modelRejectsManualThinking() {
    const profile = this.getReasoningCapabilities()?.profile;
    if (profile) return profile === "anthropic-adaptive";
    const parsed = parseClaudeModelVersion(
      this.contentGeneratorConfig.model || ""
    );
    if (!parsed) return false;
    const { major, minor } = parsed;
    return major > 4 || major === 4 && minor >= 7;
  }
  /**
   * Whether the model rejects the `temperature` sampling parameter with a 400.
   * Claude Opus 4.8+ deprecated temperature — the server controls sampling
   * determinism internally and responds with
   * `"temperature is deprecated for this model."` when the parameter is sent.
   * Older models (4.7 and below) and unknown/unversioned ids still accept it,
   * so both return false.
   */
  modelRejectsTemperature() {
    const parsed = parseClaudeModelVersion(
      this.contentGeneratorConfig.model || ""
    );
    if (!parsed) return false;
    const { major, minor } = parsed;
    return major > 4 || major === 4 && minor >= 8;
  }
  buildThinkingConfig(request, effectiveEffort) {
    if (request.config?.thinkingConfig?.includeThoughts === false) {
      return void 0;
    }
    const reasoning = getEffectiveReasoning(
      this.contentGeneratorConfig,
      this.getReasoningCapabilities()
    );
    const requestBudgetCap = request.config?.thinkingConfig?.thinkingBudget;
    const applyRequestBudgetCap = /* @__PURE__ */ __name((budgetTokens2) => typeof requestBudgetCap === "number" && requestBudgetCap > 0 ? Math.min(budgetTokens2, requestBudgetCap) : budgetTokens2, "applyRequestBudgetCap");
    if (reasoning === false) {
      return void 0;
    }
    if (reasoning?.budget_tokens !== void 0 && !this.modelRejectsManualThinking()) {
      return {
        type: "enabled",
        budget_tokens: applyRequestBudgetCap(reasoning.budget_tokens)
      };
    }
    if (reasoning?.budget_tokens !== void 0 && this.modelRejectsManualThinking() && !this.budgetDropWarned) {
      debugLogger2.warn(
        `reasoning.budget_tokens=${reasoning.budget_tokens} is ignored on '${this.contentGeneratorConfig.model ?? "unknown"}' (Opus 4.7+/5.x use adaptive thinking); output_config.effort governs thinking depth instead.`
      );
      this.budgetDropWarned = true;
    }
    if (this.modelSupportsAdaptiveThinking()) {
      return { type: "adaptive", display: "summarized" };
    }
    const budgetTokens = effectiveEffort === "low" ? 16e3 : effectiveEffort === "max" ? 128e3 : effectiveEffort === "xhigh" ? 96e3 : effectiveEffort === "high" ? 64e3 : 32e3;
    return {
      type: "enabled",
      budget_tokens: applyRequestBudgetCap(budgetTokens)
    };
  }
  buildOutputConfig(request, effectiveEffort) {
    if (effectiveEffort === void 0) return void 0;
    return { effort: effectiveEffort };
  }
  /**
   * Translate the Gemini-style `toolConfig.functionCallingConfig.mode` on
   * the request into an Anthropic `tool_choice` value.
   *
   * Mapping:
   *   mode 'ANY'  → `{ type: 'any' }`   (model must call at least one tool)
   *   mode 'NONE' or 'AUTO' or absent → undefined (Anthropic has no
   *     `tool_choice: { type: 'none' }`; to prevent tool calls the caller
   *     should omit `tools` entirely)
   *
   * Only emitted when `tools` is non-empty — Anthropic rejects requests
   * that carry `tool_choice` without a `tools` array.
   */
  resolveToolChoice(request, tools) {
    if (!tools || tools.length === 0) return void 0;
    const mode = request.config?.toolConfig?.functionCallingConfig?.mode;
    if (mode === "ANY") {
      return { type: "any" };
    }
    return void 0;
  }
  async *redactStreamErrors(stream) {
    try {
      for await (const event of stream) {
        yield event;
      }
    } catch (error) {
      throw normalizeStreamError(error);
    }
  }
  responseHasAssistantPayload(response) {
    return Boolean(
      response.candidates?.some(
        (candidate) => candidate.content?.parts?.some(
          (part) => part.text || part.thought || part.thoughtSignature || part.functionCall
        )
      )
    );
  }
  async *processStream(stream, telemetryAttempt) {
    let messageId;
    let model;
    let cachedTokens = 0;
    let cacheCreationTokens = 0;
    let cachedTokensReported = false;
    let cacheCreationTokensReported = false;
    let promptTokens = 0;
    let promptTokensReported = false;
    let completionTokens = 0;
    let completionTokensReported = false;
    let finishReason;
    const blocks = /* @__PURE__ */ new Map();
    const deferredToolCalls = [];
    let hasEmptyToolCall = false;
    let hasMalformedToolCall = false;
    let hasNonObjectToolCall = false;
    let upstreamStreamFailed = false;
    let upstreamStreamError;
    const collectedResponses = [];
    const throwMalformedToolCall = /* @__PURE__ */ __name((detail) => {
      throw new InvalidStreamError(
        `Anthropic stream contained malformed tool call arguments: ${detail}`,
        "MALFORMED_TOOL_CALL"
      );
    }, "throwMalformedToolCall");
    let messageStartUsagePending = false;
    const takePendingMessageStartUsage = /* @__PURE__ */ __name(() => {
      if (!messageStartUsagePending) return void 0;
      messageStartUsagePending = false;
      return buildAnthropicUsageMetadata({
        inputTokens: promptTokens,
        cacheReadTokens: cachedTokens,
        cacheCreationTokens,
        outputTokens: completionTokensReported ? completionTokens : void 0,
        cacheReadTokensReported: cachedTokensReported,
        cacheCreationTokensReported
      });
    }, "takePendingMessageStartUsage");
    const capturedStream = async function* () {
      try {
        yield* stream;
      } catch (error) {
        upstreamStreamFailed = true;
        upstreamStreamError = error;
      }
    }();
    for await (const event of capturedStream) {
      reportAnthropicEvent(telemetryAttempt, event);
      switch (event.type) {
        case "message_start": {
          messageId = event.message.id ?? messageId;
          model = event.message.model ?? model;
          promptTokensReported ||= typeof event.message.usage?.input_tokens === "number";
          completionTokensReported ||= typeof event.message.usage?.output_tokens === "number";
          cachedTokensReported ||= typeof event.message.usage?.cache_read_input_tokens === "number";
          cacheCreationTokensReported ||= typeof event.message.usage?.cache_creation_input_tokens === "number";
          cachedTokens = event.message.usage?.cache_read_input_tokens ?? cachedTokens;
          cacheCreationTokens = event.message.usage?.cache_creation_input_tokens ?? cacheCreationTokens;
          promptTokens = event.message.usage?.input_tokens ?? promptTokens;
          completionTokens = event.message.usage?.output_tokens ?? completionTokens;
          messageStartUsagePending = promptTokensReported || completionTokensReported || cachedTokensReported || cacheCreationTokensReported;
          break;
        }
        case "content_block_start": {
          const index = event.index ?? 0;
          const type = String(event.content_block.type || "text");
          const id = "id" in event.content_block ? event.content_block.id : void 0;
          const name = "name" in event.content_block ? event.content_block.name : void 0;
          const initialInput = type === "tool_use" && "input" in event.content_block ? JSON.stringify(event.content_block.input) : "";
          blocks.set(index, {
            type,
            id,
            name,
            inputJson: initialInput !== "{}" ? initialInput : "",
            signature: type === "thinking" && "signature" in event.content_block && typeof event.content_block.signature === "string" ? event.content_block.signature : ""
          });
          if (type === "tool_use" && typeof id === "string" && id.length > 0 && typeof name === "string" && name.length > 0) {
            const chunk = this.buildLlmChunk(
              void 0,
              messageId,
              model,
              void 0,
              takePendingMessageStartUsage()
            );
            setToolCallPreparations(chunk, [{ callId: id, toolName: name }]);
            collectedResponses.push(chunk);
            yield chunk;
          }
          break;
        }
        case "content_block_delta": {
          const index = event.index ?? 0;
          const deltaType = event.delta.type || "";
          const blockState = blocks.get(index);
          if (deltaType === "text_delta") {
            const text = "text" in event.delta ? event.delta.text : "";
            if (text) {
              const chunk = this.buildLlmChunk(
                { text },
                messageId,
                model,
                void 0,
                takePendingMessageStartUsage()
              );
              collectedResponses.push(chunk);
              yield chunk;
            }
          } else if (deltaType === "thinking_delta") {
            const thinking = event.delta.thinking || "";
            if (thinking) {
              const chunk = this.buildLlmChunk(
                { text: thinking, thought: true },
                messageId,
                model,
                void 0,
                takePendingMessageStartUsage()
              );
              collectedResponses.push(chunk);
              yield chunk;
            }
          } else if (deltaType === "signature_delta" && blockState) {
            const signature = event.delta.signature || "";
            if (signature) {
              blockState.signature += signature;
              const chunk = this.buildLlmChunk(
                { thought: true, thoughtSignature: signature },
                messageId,
                model,
                void 0,
                takePendingMessageStartUsage()
              );
              collectedResponses.push(chunk);
              yield chunk;
            }
          } else if (deltaType === "input_json_delta" && blockState) {
            const jsonDelta = event.delta.partial_json || "";
            if (jsonDelta) {
              blockState.inputJson += jsonDelta;
            }
          }
          break;
        }
        case "content_block_stop": {
          const index = event.index ?? 0;
          const blockState = blocks.get(index);
          if (blockState?.type === "tool_use") {
            const inputJson = blockState.inputJson;
            const parseResult = inputJson ? parseToolCallArguments(inputJson) : { ok: true, value: {} };
            if (!parseResult.ok) {
              if (parseResult.reason === "MALFORMED_JSON") {
                hasMalformedToolCall = true;
              } else {
                hasNonObjectToolCall = true;
              }
            } else {
              const chunk = this.buildLlmChunk(
                {
                  functionCall: {
                    id: blockState.id,
                    name: blockState.name,
                    args: parseResult.value
                  }
                },
                messageId,
                model,
                void 0,
                takePendingMessageStartUsage()
              );
              hasEmptyToolCall ||= !inputJson;
              deferredToolCalls.push(chunk);
            }
          }
          blocks.delete(index);
          break;
        }
        case "message_delta": {
          const stopReasonValue = event.delta.stop_reason;
          if (stopReasonValue) {
            finishReason = stopReasonValue;
            const hasOpenToolCall2 = [...blocks.values()].some(
              (block) => block.type === "tool_use"
            );
            const hasUnconfirmedEmptyToolCall = hasEmptyToolCall && stopReasonValue !== "tool_use";
            const hasTruncatedToolCall = hasMalformedToolCall || hasOpenToolCall2 || hasUnconfirmedEmptyToolCall;
            if (hasNonObjectToolCall) {
              throwMalformedToolCall(
                "completed argument buffer had a non-object JSON root"
              );
            } else if (hasTruncatedToolCall && stopReasonValue === "max_tokens") {
              deferredToolCalls.length = 0;
              hasEmptyToolCall = false;
              hasMalformedToolCall = false;
              for (const [index, block] of blocks) {
                if (block.type === "tool_use") blocks.delete(index);
              }
            } else if (hasTruncatedToolCall) {
              throwMalformedToolCall(
                hasOpenToolCall2 ? "tool-use block did not close before the stop reason" : hasMalformedToolCall ? "completed argument buffer was not valid JSON" : "empty argument buffer lacked a tool-use stop reason"
              );
            } else if (deferredToolCalls.length > 0) {
              for (const chunk of deferredToolCalls.splice(0)) {
                collectedResponses.push(chunk);
                yield chunk;
              }
              hasEmptyToolCall = false;
            }
          }
          const usageUnknown = event.usage;
          const usageRecord = usageUnknown && typeof usageUnknown === "object" ? usageUnknown : void 0;
          if (event.usage?.output_tokens !== void 0) {
            completionTokens = event.usage.output_tokens;
            completionTokensReported = true;
          }
          if (usageRecord?.["input_tokens"] !== void 0) {
            const inputTokens = usageRecord["input_tokens"];
            if (typeof inputTokens === "number") {
              promptTokens = inputTokens;
              promptTokensReported = true;
            }
          }
          if (usageRecord?.["cache_read_input_tokens"] !== void 0) {
            const cacheRead = usageRecord["cache_read_input_tokens"];
            if (typeof cacheRead === "number") {
              cachedTokens = cacheRead;
              cachedTokensReported = true;
            }
          }
          if (usageRecord?.["cache_creation_input_tokens"] !== void 0) {
            const cacheCreate = usageRecord["cache_creation_input_tokens"];
            if (typeof cacheCreate === "number") {
              cacheCreationTokens = cacheCreate;
              cacheCreationTokensReported = true;
            }
          }
          if (finishReason || event.usage) {
            messageStartUsagePending = false;
            const chunk = this.buildLlmChunk(
              void 0,
              messageId,
              model,
              finishReason,
              buildAnthropicUsageMetadata({
                inputTokens: promptTokens,
                cacheReadTokens: cachedTokens,
                cacheCreationTokens,
                outputTokens: completionTokensReported ? completionTokens : void 0,
                cacheReadTokensReported: cachedTokensReported,
                cacheCreationTokensReported
              })
            );
            collectedResponses.push(chunk);
            yield chunk;
          }
          break;
        }
        case "message_stop": {
          if (promptTokensReported || completionTokensReported || cachedTokensReported || cacheCreationTokensReported) {
            messageStartUsagePending = false;
            const chunk = this.buildLlmChunk(
              void 0,
              messageId,
              model,
              finishReason,
              buildAnthropicUsageMetadata({
                inputTokens: promptTokens,
                cacheReadTokens: cachedTokens,
                cacheCreationTokens,
                outputTokens: completionTokensReported ? completionTokens : void 0,
                cacheReadTokensReported: cachedTokensReported,
                cacheCreationTokensReported
              })
            );
            collectedResponses.push(chunk);
            yield chunk;
          }
          break;
        }
        default:
          break;
      }
    }
    const hasOpenToolCall = [...blocks.values()].some(
      (block) => block.type === "tool_use"
    );
    if (upstreamStreamFailed) {
      const upstreamErrorClassification = classifyRetryError(upstreamStreamError);
      if ((isRetryableStreamTransportError(upstreamErrorClassification) || isRetryableStatuslessUpstreamError(upstreamErrorClassification)) && deferredToolCalls.length > 0 && !hasEmptyToolCall && !hasMalformedToolCall && !hasNonObjectToolCall && !hasOpenToolCall) {
        for (const chunk of deferredToolCalls.splice(0)) {
          collectedResponses.push(chunk);
          yield chunk;
        }
      }
      throw upstreamStreamError;
    }
    const hasAssistantPayload = collectedResponses.some(
      (response) => this.responseHasAssistantPayload(response)
    );
    if (hasMalformedToolCall || hasNonObjectToolCall || deferredToolCalls.length > 0 || hasOpenToolCall && hasAssistantPayload) {
      throwMalformedToolCall(
        hasMalformedToolCall ? "stream ended with a malformed argument buffer" : hasNonObjectToolCall ? "stream ended with a non-object argument root" : deferredToolCalls.length > 0 ? "stream ended before deferred tool calls were confirmed" : "stream ended with an open tool-use block"
      );
    }
  }
  // Some Anthropic-compatible gateways close the SSE stream with HTTP 200
  // but emit no assistant content or stop reason (e.g. billing / quota
  // limits hit mid-proxy). When that happens we probe once with the same
  // request in non-streaming mode so the real provider error surfaces
  // instead of the generic "stream ended without a finish reason".
  async *processStreamWithEmptyFallback(stream, fallbackRequest, abortSignal, headers, telemetryAttempt) {
    let hasAssistantPayload = false;
    let hasFinishReason = false;
    for await (const chunk of this.processStream(stream, telemetryAttempt)) {
      const candidates = chunk.candidates ?? [];
      hasFinishReason ||= candidates.some(
        (candidate) => candidate.finishReason !== void 0
      );
      hasAssistantPayload ||= this.responseHasAssistantPayload(chunk);
      yield chunk;
    }
    if (hasAssistantPayload || hasFinishReason) {
      return;
    }
    debugLogger2.warn(
      "Anthropic stream ended without assistant payload or finish reason; probing once with a non-streaming request to surface provider errors."
    );
    let response;
    const probeAc = createChildAbortController(abortSignal);
    try {
      runtimeDiagnostics.recordAnthropicWireRequest(fallbackRequest);
      const fallbackAttempt = reportAnthropicFollowingRequest(
        fallbackRequest,
        telemetryAttempt
      );
      response = await this.client.messages.create(fallbackRequest, {
        signal: probeAc.signal,
        ...headers ? { headers } : {}
      });
      reportAnthropicResponse(fallbackAttempt, response);
      yield this.converter.convertAnthropicResponseToLlm(response);
    } catch (error) {
      throw redactProxyError(error);
    } finally {
      probeAc.abort();
    }
  }
  buildLlmChunk(part, responseId, model, finishReason, usageMetadata) {
    const response = new GenerateContentResponse();
    response.responseId = responseId;
    response.createTime = Date.now().toString();
    response.modelVersion = model || void 0;
    response.promptFeedback = { safetyRatings: [] };
    const candidateParts = part ? [part] : [];
    const mappedFinishReason = finishReason !== void 0 ? this.converter.mapAnthropicFinishReasonToLlm(finishReason) : void 0;
    response.candidates = [
      {
        content: {
          parts: candidateParts,
          role: "model"
        },
        index: 0,
        safetyRatings: [],
        ...mappedFinishReason ? { finishReason: mappedFinishReason } : {}
      }
    ];
    if (usageMetadata) {
      response.usageMetadata = usageMetadata;
    }
    return response;
  }
};

// packages/core/src/core/anthropicContentGenerator/index.ts
function createAnthropicContentGenerator(contentGeneratorConfig, cliConfig) {
  return new AnthropicContentGenerator(contentGeneratorConfig, cliConfig);
}
__name(createAnthropicContentGenerator, "createAnthropicContentGenerator");
export {
  AnthropicContentGenerator,
  createAnthropicContentGenerator
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/*! Bundled license information:

humanize-ms/index.js:
  (*!
   * humanize-ms - index.js
   * Copyright(c) 2014 dead_horse <dead_horse@qq.com>
   * MIT Licensed
   *)
*/
