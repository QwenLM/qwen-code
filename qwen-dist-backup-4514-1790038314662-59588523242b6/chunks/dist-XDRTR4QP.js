// Force strict mode and setup for ESM
"use strict";
import {
  require_axios,
  require_ws
} from "./chunk-JJKNYRFY.js";
import "./chunk-OBTWL6ZW.js";
import "./chunk-K6KS3LTN.js";
import "./chunk-OSHQMOBS.js";
import {
  ChannelBase,
  sanitizeLogText
} from "./chunk-PZRXWQUA.js";
import "./chunk-IJOS26LH.js";
import "./chunk-CQ35AJ4Z.js";
import "./chunk-DMTGGOSA.js";
import "./chunk-YQ3U5MUC.js";
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

// node_modules/eventemitter3/index.js
var require_eventemitter3 = __commonJS({
  "node_modules/eventemitter3/index.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var has = Object.prototype.hasOwnProperty;
    var prefix = "~";
    function Events() {
    }
    __name(Events, "Events");
    if (Object.create) {
      Events.prototype = /* @__PURE__ */ Object.create(null);
      if (!new Events().__proto__) prefix = false;
    }
    function EE(fn, context, once) {
      this.fn = fn;
      this.context = context;
      this.once = once || false;
    }
    __name(EE, "EE");
    function addListener(emitter, event, fn, context, once) {
      if (typeof fn !== "function") {
        throw new TypeError("The listener must be a function");
      }
      var listener = new EE(fn, context || emitter, once), evt = prefix ? prefix + event : event;
      if (!emitter._events[evt]) emitter._events[evt] = listener, emitter._eventsCount++;
      else if (!emitter._events[evt].fn) emitter._events[evt].push(listener);
      else emitter._events[evt] = [emitter._events[evt], listener];
      return emitter;
    }
    __name(addListener, "addListener");
    function clearEvent(emitter, evt) {
      if (--emitter._eventsCount === 0) emitter._events = new Events();
      else delete emitter._events[evt];
    }
    __name(clearEvent, "clearEvent");
    function EventEmitter() {
      this._events = new Events();
      this._eventsCount = 0;
    }
    __name(EventEmitter, "EventEmitter");
    EventEmitter.prototype.eventNames = /* @__PURE__ */ __name(function eventNames() {
      var names = [], events, name;
      if (this._eventsCount === 0) return names;
      for (name in events = this._events) {
        if (has.call(events, name)) names.push(prefix ? name.slice(1) : name);
      }
      if (Object.getOwnPropertySymbols) {
        return names.concat(Object.getOwnPropertySymbols(events));
      }
      return names;
    }, "eventNames");
    EventEmitter.prototype.listeners = /* @__PURE__ */ __name(function listeners(event) {
      var evt = prefix ? prefix + event : event, handlers = this._events[evt];
      if (!handlers) return [];
      if (handlers.fn) return [handlers.fn];
      for (var i = 0, l = handlers.length, ee = new Array(l); i < l; i++) {
        ee[i] = handlers[i].fn;
      }
      return ee;
    }, "listeners");
    EventEmitter.prototype.listenerCount = /* @__PURE__ */ __name(function listenerCount(event) {
      var evt = prefix ? prefix + event : event, listeners = this._events[evt];
      if (!listeners) return 0;
      if (listeners.fn) return 1;
      return listeners.length;
    }, "listenerCount");
    EventEmitter.prototype.emit = /* @__PURE__ */ __name(function emit(event, a1, a2, a3, a4, a5) {
      var evt = prefix ? prefix + event : event;
      if (!this._events[evt]) return false;
      var listeners = this._events[evt], len = arguments.length, args, i;
      if (listeners.fn) {
        if (listeners.once) this.removeListener(event, listeners.fn, void 0, true);
        switch (len) {
          case 1:
            return listeners.fn.call(listeners.context), true;
          case 2:
            return listeners.fn.call(listeners.context, a1), true;
          case 3:
            return listeners.fn.call(listeners.context, a1, a2), true;
          case 4:
            return listeners.fn.call(listeners.context, a1, a2, a3), true;
          case 5:
            return listeners.fn.call(listeners.context, a1, a2, a3, a4), true;
          case 6:
            return listeners.fn.call(listeners.context, a1, a2, a3, a4, a5), true;
        }
        for (i = 1, args = new Array(len - 1); i < len; i++) {
          args[i - 1] = arguments[i];
        }
        listeners.fn.apply(listeners.context, args);
      } else {
        var length = listeners.length, j;
        for (i = 0; i < length; i++) {
          if (listeners[i].once) this.removeListener(event, listeners[i].fn, void 0, true);
          switch (len) {
            case 1:
              listeners[i].fn.call(listeners[i].context);
              break;
            case 2:
              listeners[i].fn.call(listeners[i].context, a1);
              break;
            case 3:
              listeners[i].fn.call(listeners[i].context, a1, a2);
              break;
            case 4:
              listeners[i].fn.call(listeners[i].context, a1, a2, a3);
              break;
            default:
              if (!args) for (j = 1, args = new Array(len - 1); j < len; j++) {
                args[j - 1] = arguments[j];
              }
              listeners[i].fn.apply(listeners[i].context, args);
          }
        }
      }
      return true;
    }, "emit");
    EventEmitter.prototype.on = /* @__PURE__ */ __name(function on(event, fn, context) {
      return addListener(this, event, fn, context, false);
    }, "on");
    EventEmitter.prototype.once = /* @__PURE__ */ __name(function once(event, fn, context) {
      return addListener(this, event, fn, context, true);
    }, "once");
    EventEmitter.prototype.removeListener = /* @__PURE__ */ __name(function removeListener(event, fn, context, once) {
      var evt = prefix ? prefix + event : event;
      if (!this._events[evt]) return this;
      if (!fn) {
        clearEvent(this, evt);
        return this;
      }
      var listeners = this._events[evt];
      if (listeners.fn) {
        if (listeners.fn === fn && (!once || listeners.once) && (!context || listeners.context === context)) {
          clearEvent(this, evt);
        }
      } else {
        for (var i = 0, events = [], length = listeners.length; i < length; i++) {
          if (listeners[i].fn !== fn || once && !listeners[i].once || context && listeners[i].context !== context) {
            events.push(listeners[i]);
          }
        }
        if (events.length) this._events[evt] = events.length === 1 ? events[0] : events;
        else clearEvent(this, evt);
      }
      return this;
    }, "removeListener");
    EventEmitter.prototype.removeAllListeners = /* @__PURE__ */ __name(function removeAllListeners(event) {
      var evt;
      if (event) {
        evt = prefix ? prefix + event : event;
        if (this._events[evt]) clearEvent(this, evt);
      } else {
        this._events = new Events();
        this._eventsCount = 0;
      }
      return this;
    }, "removeAllListeners");
    EventEmitter.prototype.off = EventEmitter.prototype.removeListener;
    EventEmitter.prototype.addListener = EventEmitter.prototype.on;
    EventEmitter.prefixed = prefix;
    EventEmitter.EventEmitter = EventEmitter;
    if ("undefined" !== typeof module) {
      module.exports = EventEmitter;
    }
  }
});

// node_modules/@wecom/aibot-node-sdk/dist/index.cjs.js
var require_index_cjs = __commonJS({
  "node_modules/@wecom/aibot-node-sdk/dist/index.cjs.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    var eventemitter3 = require_eventemitter3();
    var crypto = __require("crypto");
    var axios = require_axios();
    var WebSocket = require_ws();
    var crypto$1 = __require("node:crypto");
    var WSAuthFailureError = class extends Error {
      static {
        __name(this, "WSAuthFailureError");
      }
      constructor(maxAttempts) {
        super(`Max auth failure attempts exceeded (${maxAttempts})`);
        this.code = "WS_AUTH_FAILURE_EXHAUSTED";
        this.name = "WSAuthFailureError";
      }
    };
    var WSReconnectExhaustedError = class extends Error {
      static {
        __name(this, "WSReconnectExhaustedError");
      }
      constructor(maxAttempts) {
        super(`Max reconnect attempts exceeded (${maxAttempts})`);
        this.code = "WS_RECONNECT_EXHAUSTED";
        this.name = "WSReconnectExhaustedError";
      }
    };
    exports.MessageType = void 0;
    (function(MessageType) {
      MessageType["Text"] = "text";
      MessageType["Image"] = "image";
      MessageType["Mixed"] = "mixed";
      MessageType["Voice"] = "voice";
      MessageType["File"] = "file";
      MessageType["Video"] = "video";
    })(exports.MessageType || (exports.MessageType = {}));
    var WsCmd = {
      // ========== 开发者 → 企业微信 ==========
      /** 认证订阅 */
      SUBSCRIBE: "aibot_subscribe",
      /** 心跳 */
      HEARTBEAT: "ping",
      /** 回复消息 */
      RESPONSE: "aibot_respond_msg",
      /** 回复欢迎语 */
      RESPONSE_WELCOME: "aibot_respond_welcome_msg",
      /** 更新模板卡片 */
      RESPONSE_UPDATE: "aibot_respond_update_msg",
      /** 主动发送消息 */
      SEND_MSG: "aibot_send_msg",
      /** 上传临时素材 - 初始化 */
      UPLOAD_MEDIA_INIT: "aibot_upload_media_init",
      /** 上传临时素材 - 分片上传 */
      UPLOAD_MEDIA_CHUNK: "aibot_upload_media_chunk",
      /** 上传临时素材 - 完成上传 */
      UPLOAD_MEDIA_FINISH: "aibot_upload_media_finish",
      // ========== 企业微信 → 开发者 ==========
      /** 消息推送回调 */
      CALLBACK: "aibot_msg_callback",
      /** 事件推送回调 */
      EVENT_CALLBACK: "aibot_event_callback"
    };
    exports.TemplateCardType = void 0;
    (function(TemplateCardType) {
      TemplateCardType["TextNotice"] = "text_notice";
      TemplateCardType["NewsNotice"] = "news_notice";
      TemplateCardType["ButtonInteraction"] = "button_interaction";
      TemplateCardType["VoteInteraction"] = "vote_interaction";
      TemplateCardType["MultipleInteraction"] = "multiple_interaction";
    })(exports.TemplateCardType || (exports.TemplateCardType = {}));
    exports.EventType = void 0;
    (function(EventType) {
      EventType["EnterChat"] = "enter_chat";
      EventType["TemplateCardEvent"] = "template_card_event";
      EventType["FeedbackEvent"] = "feedback_event";
      EventType["Disconnected"] = "disconnected_event";
    })(exports.EventType || (exports.EventType = {}));
    var WeComApiClient = class {
      static {
        __name(this, "WeComApiClient");
      }
      constructor(logger, timeout = 1e4) {
        this.logger = logger;
        this.httpClient = axios.create({
          timeout,
          headers: {
            "Content-Type": "application/json"
          }
        });
      }
      /**
       * 下载文件（返回原始 Buffer 及文件名）
       */
      async downloadFileRaw(url) {
        this.logger.info("Downloading file...");
        try {
          const response = await this.httpClient.get(url, {
            responseType: "arraybuffer"
          });
          const contentDisposition = response.headers["content-disposition"];
          let filename;
          if (contentDisposition) {
            const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;\s]+)/i);
            if (utf8Match) {
              filename = decodeURIComponent(utf8Match[1]);
            } else {
              const match = contentDisposition.match(/filename="?([^";\s]+)"?/i);
              if (match) {
                filename = decodeURIComponent(match[1]);
              }
            }
          }
          this.logger.info("File downloaded successfully");
          return { buffer: Buffer.from(response.data), filename };
        } catch (error) {
          this.logger.error("File download failed:", error.message);
          throw error;
        }
      }
    };
    function generateRandomString(length = 8) {
      return crypto.randomBytes(Math.ceil(length / 2)).toString("hex").substring(0, length);
    }
    __name(generateRandomString, "generateRandomString");
    function generateReqId(prefix) {
      const timestamp = Date.now();
      const random = generateRandomString();
      return `${prefix}_${timestamp}_${random}`;
    }
    __name(generateReqId, "generateReqId");
    var DEFAULT_WS_URL = "wss://openws.work.weixin.qq.com";
    var WsConnectionManager = class {
      static {
        __name(this, "WsConnectionManager");
      }
      constructor(logger, heartbeatInterval = 3e4, reconnectBaseDelay = 1e3, maxReconnectAttempts = 10, wsUrl, wsOptions, maxReplyQueueSize, maxAuthFailureAttempts) {
        this.ws = null;
        this.heartbeatTimer = null;
        this.reconnectAttempts = 0;
        this.authFailureAttempts = 0;
        this.isManualClose = false;
        this.lastCloseWasAuthFailure = false;
        this.botId = "";
        this.botSecret = "";
        this.extraAuthParams = {};
        this.missedPongCount = 0;
        this.maxMissedPong = 2;
        this.reconnectBaseDelay = 1e3;
        this.reconnectMaxDelay = 3e4;
        this.reconnectTimer = null;
        this.replyQueues = /* @__PURE__ */ new Map();
        this.pendingAcks = /* @__PURE__ */ new Map();
        this.pendingAckSeq = 0;
        this.replyAckTimeout = 5e3;
        this.maxReplyQueueSize = 500;
        this.onConnected = null;
        this.onAuthenticated = null;
        this.onDisconnected = null;
        this.onMessage = null;
        this.onReconnecting = null;
        this.onError = null;
        this.onServerDisconnect = null;
        this.logger = logger;
        this.heartbeatInterval = heartbeatInterval;
        this.reconnectBaseDelay = reconnectBaseDelay;
        this.maxReconnectAttempts = maxReconnectAttempts;
        this.maxAuthFailureAttempts = maxAuthFailureAttempts ?? 5;
        this.wsUrl = wsUrl || DEFAULT_WS_URL;
        this.wsOptions = wsOptions || {};
        if (maxReplyQueueSize !== void 0) {
          this.maxReplyQueueSize = maxReplyQueueSize;
        }
      }
      /**
       * 设置认证凭证
       */
      setCredentials(botId, botSecret, extraAuthParams) {
        this.botId = botId;
        this.botSecret = botSecret;
        this.extraAuthParams = extraAuthParams || {};
      }
      /**
       * 建立 WebSocket 连接（使用 SDK 内置默认地址）
       */
      connect() {
        this.isManualClose = false;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        if (this.ws) {
          this.ws.removeAllListeners();
          this.ws.terminate();
          this.ws = null;
        }
        this.logger.info(`Connecting to WebSocket: ${this.wsUrl}...`);
        try {
          this.ws = new WebSocket(this.wsUrl, this.wsOptions);
          this.setupEventHandlers();
        } catch (error) {
          this.logger.error("Failed to create WebSocket connection:", error.message);
          this.onError?.(error);
          this.scheduleReconnect();
        }
      }
      /**
       * 设置 WebSocket 事件处理器
       */
      setupEventHandlers() {
        if (!this.ws)
          return;
        this.ws.on("open", () => {
          this.logger.info("WebSocket connection established, sending auth...");
          this.missedPongCount = 0;
          this.lastCloseWasAuthFailure = false;
          this.sendAuth();
          this.onConnected?.();
        });
        this.ws.on("message", (data) => {
          try {
            const raw = data.toString().replace(/[\x00-\x08\x0B-\x0D\x0E-\x1F]/g, "");
            const frame = JSON.parse(raw);
            this.handleFrame(frame);
          } catch (error) {
            this.logger.error("Failed to parse WebSocket message:", error.message);
          }
        });
        this.ws.on("close", (code, reason) => {
          const reasonStr = reason.toString() || `code: ${code}`;
          this.logger.warn(`WebSocket connection closed: ${reasonStr}`);
          this.stopHeartbeat();
          this.clearPendingMessages(`WebSocket connection closed (${reasonStr})`);
          this.onDisconnected?.(reasonStr);
          this.ws = null;
          if (!this.isManualClose) {
            this.scheduleReconnect();
          }
        });
        this.ws.on("error", (error) => {
          this.logger.error("WebSocket error:", error.message);
          this.onError?.(error);
        });
        this.ws.on("ping", () => {
          this.ws?.pong();
        });
      }
      /**
       * 发送认证帧
       *
       * 格式：{ cmd: "aibot_subscribe", headers: { req_id }, body: { secret, bot_id } }
       */
      sendAuth() {
        try {
          this.send({
            cmd: WsCmd.SUBSCRIBE,
            headers: { req_id: generateReqId(WsCmd.SUBSCRIBE) },
            body: {
              bot_id: this.botId,
              secret: this.botSecret,
              ...this.extraAuthParams
            }
          });
          this.logger.info("Auth frame sent");
        } catch (error) {
          this.logger.error("Failed to send auth frame:", error.message);
        }
      }
      /**
       * 处理收到的帧数据
       *
       * 接收帧结构：
       * - 消息推送：{ cmd: "aibot_msg_callback", headers: { req_id }, body: { ... } }
       * - 认证/心跳响应：{ headers: { req_id }, errcode: 0, errmsg: "ok" }
       */
      handleFrame(frame) {
        const cmd = frame.cmd || "";
        const reqId = frame.headers?.req_id || "";
        if (frame.cmd === WsCmd.CALLBACK) {
          this.logger.debug(`[server -> plugin] cmd=${cmd}, reqId=${reqId}, body=${JSON.stringify(frame.body)}`);
          this.onMessage?.(frame);
          return;
        }
        if (frame.cmd === WsCmd.EVENT_CALLBACK) {
          this.logger.debug(`[server -> plugin] cmd=${cmd}, reqId=${reqId}, body=${JSON.stringify(frame.body)}`);
          if (frame.body?.event?.eventtype === "disconnected_event") {
            this.logger.warn("Received disconnected_event: a new connection has been established, this connection will be closed by server");
            this.onMessage?.(frame);
            this.stopHeartbeat();
            this.clearPendingMessages("Server disconnected due to new connection");
            this.isManualClose = true;
            this.onServerDisconnect?.("New connection established, server disconnected this connection");
            if (this.ws) {
              this.ws.removeAllListeners();
              this.ws.terminate();
              this.ws = null;
            }
            return;
          }
          this.onMessage?.(frame);
          return;
        }
        const actualReqId = frame.headers?.req_id || "";
        if (actualReqId.startsWith(WsCmd.SUBSCRIBE)) {
          if (frame.errcode !== 0) {
            this.logger.error(`Authentication failed: errcode=${frame.errcode}, errmsg=${frame.errmsg}`);
            this.onError?.(new Error(`Authentication failed: ${frame.errmsg} (code: ${frame.errcode})`));
            this.lastCloseWasAuthFailure = true;
            if (this.ws) {
              this.ws.terminate();
            }
            return;
          }
          this.logger.info("Authentication successful");
          this.reconnectAttempts = 0;
          this.authFailureAttempts = 0;
          this.startHeartbeat();
          this.onAuthenticated?.();
          return;
        }
        if (actualReqId.startsWith(WsCmd.HEARTBEAT)) {
          if (frame.errcode !== 0) {
            this.logger.warn(`Heartbeat ack error: errcode=${frame.errcode}, errmsg=${frame.errmsg}`);
            return;
          }
          this.missedPongCount = 0;
          return;
        }
        if (this.pendingAcks.has(actualReqId)) {
          this.handleReplyAck(actualReqId, frame);
          return;
        }
        this.logger.warn("Received unknown frame (ignored):", JSON.stringify(frame));
      }
      /**
       * 启动心跳定时器
       */
      startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
          this.sendHeartbeat();
        }, this.heartbeatInterval);
        this.logger.debug(`Heartbeat timer started, interval: ${this.heartbeatInterval}ms`);
      }
      /**
       * 停止心跳定时器
       */
      stopHeartbeat() {
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
          this.logger.debug("Heartbeat timer stopped");
        }
      }
      /**
       * 发送心跳
       * If consecutive missed pong count reaches the threshold, treat the
       * connection as dead and trigger reconnection.
       *
       * 格式：{ cmd: "ping", headers: { req_id } }
       */
      sendHeartbeat() {
        if (this.missedPongCount >= this.maxMissedPong) {
          this.logger.warn(`No heartbeat ack received for ${this.missedPongCount} consecutive pings, connection considered dead`);
          this.stopHeartbeat();
          if (this.ws) {
            this.ws.terminate();
          }
          return;
        }
        this.missedPongCount++;
        try {
          this.send({
            cmd: WsCmd.HEARTBEAT,
            headers: { req_id: generateReqId(WsCmd.HEARTBEAT) }
          });
        } catch (error) {
          this.logger.error("Failed to send heartbeat:", error.message);
        }
      }
      /**
       * 安排重连
       *
       * 区分两种重连场景，使用独立的计数器和最大重试次数：
       * - 认证失败（lastCloseWasAuthFailure=true）：使用 authFailureAttempts / maxAuthFailureAttempts
       * - 连接断开（lastCloseWasAuthFailure=false）：使用 reconnectAttempts / maxReconnectAttempts
       *
       * disconnected_event（被踢下线）不会触发重连，因为 isManualClose 已被设为 true。
       */
      scheduleReconnect() {
        if (this.lastCloseWasAuthFailure) {
          if (this.maxAuthFailureAttempts !== -1 && this.authFailureAttempts >= this.maxAuthFailureAttempts) {
            this.logger.error(`Max auth failure attempts reached (${this.maxAuthFailureAttempts}), giving up`);
            this.onError?.(new WSAuthFailureError(this.maxAuthFailureAttempts));
            return;
          }
          this.authFailureAttempts++;
          const delay2 = Math.min(this.reconnectBaseDelay * Math.pow(2, this.authFailureAttempts - 1), this.reconnectMaxDelay);
          this.logger.info(`Auth failed, reconnecting in ${delay2}ms (auth attempt ${this.authFailureAttempts}/${this.maxAuthFailureAttempts})...`);
          this.onReconnecting?.(this.authFailureAttempts);
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.isManualClose)
              return;
            this.connect();
          }, delay2);
        } else {
          if (this.maxReconnectAttempts !== -1 && this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.logger.error(`Max reconnect attempts reached (${this.maxReconnectAttempts}), giving up`);
            this.onError?.(new WSReconnectExhaustedError(this.maxReconnectAttempts));
            return;
          }
          this.reconnectAttempts++;
          const delay2 = Math.min(this.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts - 1), this.reconnectMaxDelay);
          this.logger.info(`Connection lost, reconnecting in ${delay2}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
          this.onReconnecting?.(this.reconnectAttempts);
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.isManualClose)
              return;
            this.connect();
          }, delay2);
        }
      }
      /**
       * 发送数据帧
       *
       * 统一格式：{ cmd, headers: { req_id }, body }
       */
      send(frame) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          const data = JSON.stringify(frame);
          this.ws.send(data);
        } else {
          throw new Error("WebSocket not connected, unable to send data");
        }
      }
      /**
       * 通过 WebSocket 通道发送回复消息（串行队列版本）
       *
       * 同一个 req_id 的消息会被放入队列中串行发送：
       * 发送一条后等待服务端回执，收到回执或超时后才发送下一条。
       *
       * 格式：{ cmd: "aibot_respond_msg", headers: { req_id }, body: { ... } }
       *
       * @param reqId - 透传回调中的 req_id
       * @param body - 回复消息体（如 StreamReplyBody）
       * @param cmd - 发送的命令类型，默认 WsCmd.RESPONSE
       * @returns Promise，收到回执时 resolve(回执帧)，超时或errcode非0时 reject(Error)
       */
      sendReply(reqId, body, cmd = WsCmd.RESPONSE) {
        return new Promise((resolve2, reject) => {
          const frame = {
            cmd,
            headers: { req_id: reqId },
            body
          };
          const item = { frame, resolve: resolve2, reject };
          if (!this.replyQueues.has(reqId)) {
            this.replyQueues.set(reqId, []);
          }
          const queue = this.replyQueues.get(reqId);
          if (queue.length >= this.maxReplyQueueSize) {
            this.logger.warn(`Reply queue for reqId ${reqId} exceeds max size (${this.maxReplyQueueSize}), rejecting new message`);
            reject(new Error(`Reply queue for reqId ${reqId} exceeds max size (${this.maxReplyQueueSize})`));
            return;
          }
          queue.push(item);
          if (queue.length === 1) {
            this.processReplyQueue(reqId);
          }
        });
      }
      /**
       * 处理指定 req_id 的回复队列
       * 取出队列头部的消息发送，并设置回执超时
       */
      processReplyQueue(reqId) {
        const queue = this.replyQueues.get(reqId);
        if (!queue || queue.length === 0) {
          this.replyQueues.delete(reqId);
          return;
        }
        const item = queue[0];
        try {
          this.send(item.frame);
          this.logger.debug(`Reply message sent via WebSocket, reqId: ${reqId}, queue length: ${queue.length}`);
        } catch (error) {
          this.logger.error(`Failed to send reply for reqId ${reqId}:`, error.message);
          queue.shift();
          item.reject(error);
          queueMicrotask(() => this.processReplyQueue(reqId));
          return;
        }
        const seq = ++this.pendingAckSeq;
        const timer = setTimeout(() => {
          const currentPending = this.pendingAcks.get(reqId);
          if (!currentPending || currentPending.seq !== seq) {
            return;
          }
          this.logger.warn(`Reply ack timeout (${this.replyAckTimeout}ms) for reqId: ${reqId}`);
          this.pendingAcks.delete(reqId);
          queue.shift();
          item.reject(new Error(`Reply ack timeout (${this.replyAckTimeout}ms) for reqId: ${reqId}`));
          this.processReplyQueue(reqId);
        }, this.replyAckTimeout);
        this.pendingAcks.set(reqId, {
          resolve: item.resolve,
          reject: item.reject,
          timer,
          seq
        });
      }
      /**
       * 处理回复消息的回执
       * 收到回执后释放队列锁，继续处理下一条
       */
      handleReplyAck(reqId, frame) {
        const pending = this.pendingAcks.get(reqId);
        if (!pending)
          return;
        clearTimeout(pending.timer);
        this.pendingAcks.delete(reqId);
        const queue = this.replyQueues.get(reqId);
        if (frame.errcode !== 0) {
          this.logger.warn(`Reply ack error: reqId=${reqId}, errcode=${frame.errcode}, errmsg=${frame.errmsg}`);
          if (queue) {
            queue.shift();
          }
          pending.reject(frame);
        } else {
          this.logger.debug(`Reply ack received for reqId: ${reqId}`);
          if (queue) {
            queue.shift();
          }
          pending.resolve(frame);
        }
        this.processReplyQueue(reqId);
      }
      /**
       * 主动断开连接
       */
      /**
       * 清理所有待处理的消息和回执
       * @param reason - 清理原因，用于 reject 的错误信息
       */
      clearPendingMessages(reason) {
        const pendingRejects = /* @__PURE__ */ new Set();
        for (const [reqId, pending] of this.pendingAcks) {
          clearTimeout(pending.timer);
          pendingRejects.add(pending.reject);
          pending.reject(new Error(`${reason}, reply for reqId: ${reqId} cancelled`));
        }
        this.pendingAcks.clear();
        for (const [reqId, queue] of this.replyQueues) {
          for (const item of queue) {
            if (pendingRejects.has(item.reject)) {
              continue;
            }
            item.reject(new Error(`${reason}, reply for reqId: ${reqId} cancelled`));
          }
        }
        this.replyQueues.clear();
      }
      disconnect() {
        this.isManualClose = true;
        this.stopHeartbeat();
        this.clearPendingMessages("Connection manually closed");
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        if (this.ws) {
          this.ws.terminate();
          this.ws = null;
        }
        this.logger.info("WebSocket connection manually closed");
      }
      /**
       * 检查指定 reqId 是否有待回执的消息（即上一条消息还未收到 ack）
       *
       * 用于流式场景：调用方可据此决定是否跳过当前帧，避免排队积压。
       *
       * @param reqId - 要检查的 req_id
       * @returns true 表示有消息正在等待 ack
       */
      hasPendingAck(reqId) {
        return this.pendingAcks.has(reqId);
      }
      /**
       * 获取当前连接状态
       */
      get isConnected() {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
      }
    };
    var MessageHandler = class {
      static {
        __name(this, "MessageHandler");
      }
      constructor(logger) {
        this.logger = logger;
      }
      /**
       * 处理收到的 WebSocket 帧，解析并触发对应的消息/事件
       *
       * WebSocket 推送帧结构：
       * - 消息推送：{ cmd: "aibot_msg_callback", headers: { req_id: "xxx" }, body: { msgid, msgtype, ... } }
       * - 事件推送：{ cmd: "aibot_event_callback", headers: { req_id: "xxx" }, body: { msgid, msgtype: "event", event: { ... } } }
       *
       * @param frame - WebSocket 接收帧
       * @param emitter - WSClient 实例，用于触发事件
       */
      handleFrame(frame, emitter) {
        try {
          const body = frame.body;
          if (!body || !body.msgtype) {
            this.logger.warn("Received invalid message format:", JSON.stringify(frame).substring(0, 200));
            return;
          }
          if (frame.cmd === WsCmd.EVENT_CALLBACK) {
            this.handleEventCallback(frame, emitter);
            return;
          }
          this.handleMessageCallback(frame, emitter);
        } catch (error) {
          this.logger.error("Failed to handle message:", error.message);
        }
      }
      /**
       * 处理消息推送回调 (aibot_msg_callback)
       */
      handleMessageCallback(frame, emitter) {
        const body = frame.body;
        emitter.emit("message", frame);
        switch (body.msgtype) {
          case exports.MessageType.Text:
            emitter.emit("message.text", frame);
            break;
          case exports.MessageType.Image:
            emitter.emit("message.image", frame);
            break;
          case exports.MessageType.Mixed:
            emitter.emit("message.mixed", frame);
            break;
          case exports.MessageType.Voice:
            emitter.emit("message.voice", frame);
            break;
          case exports.MessageType.File:
            emitter.emit("message.file", frame);
            break;
          case exports.MessageType.Video:
            emitter.emit("message.video", frame);
            break;
          default:
            this.logger.debug(`Received unhandled message type: ${body.msgtype}`);
            break;
        }
      }
      /**
       * 处理事件推送回调 (aibot_event_callback)
       */
      handleEventCallback(frame, emitter) {
        const body = frame.body;
        emitter.emit("event", frame);
        const eventType = body.event?.eventtype;
        if (eventType) {
          const eventKey = `event.${eventType}`;
          emitter.emit(eventKey, frame);
        } else {
          this.logger.debug("Received event callback without eventtype:", JSON.stringify(body).substring(0, 200));
        }
      }
    };
    function decryptFile2(encryptedBuffer, aesKey) {
      if (!encryptedBuffer || encryptedBuffer.length === 0) {
        throw new Error("decryptFile: encryptedBuffer is empty or not provided");
      }
      if (!aesKey || typeof aesKey !== "string") {
        throw new Error("decryptFile: aesKey must be a non-empty string");
      }
      const key = Buffer.from(aesKey, "base64");
      const iv = key.subarray(0, 16);
      try {
        const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
        decipher.setAutoPadding(false);
        const decrypted = Buffer.concat([
          decipher.update(encryptedBuffer),
          decipher.final()
        ]);
        const padLen = decrypted[decrypted.length - 1];
        if (padLen < 1 || padLen > 32 || padLen > decrypted.length) {
          throw new Error(`Invalid PKCS#7 padding value: ${padLen}`);
        }
        for (let i = decrypted.length - padLen; i < decrypted.length; i++) {
          if (decrypted[i] !== padLen) {
            throw new Error("Invalid PKCS#7 padding: padding bytes mismatch");
          }
        }
        return decrypted.subarray(0, decrypted.length - padLen);
      } catch (error) {
        throw new Error(`decryptFile: Decryption failed - ${error.message}. This may indicate corrupted data or an incorrect aesKey.`);
      }
    }
    __name(decryptFile2, "decryptFile");
    var DefaultLogger = class {
      static {
        __name(this, "DefaultLogger");
      }
      constructor(prefix = "AiBotSDK") {
        this.prefix = prefix;
      }
      formatTime() {
        return (/* @__PURE__ */ new Date()).toISOString();
      }
      debug(message, ...args) {
        console.debug(`[${this.formatTime()}] [${this.prefix}] [DEBUG] ${message}`, ...args);
      }
      info(message, ...args) {
        console.info(`[${this.formatTime()}] [${this.prefix}] [INFO] ${message}`, ...args);
      }
      warn(message, ...args) {
        console.warn(`[${this.formatTime()}] [${this.prefix}] [WARN] ${message}`, ...args);
      }
      error(message, ...args) {
        console.error(`[${this.formatTime()}] [${this.prefix}] [ERROR] ${message}`, ...args);
      }
    };
    var WSClient2 = class extends eventemitter3.EventEmitter {
      static {
        __name(this, "WSClient");
      }
      constructor(options) {
        super();
        this.started = false;
        this.options = {
          reconnectInterval: 1e3,
          maxReconnectAttempts: 10,
          maxAuthFailureAttempts: 5,
          heartbeatInterval: 3e4,
          requestTimeout: 1e4,
          wsUrl: "",
          wsOptions: {},
          maxReplyQueueSize: 500,
          logger: new DefaultLogger(),
          ...options
        };
        this.logger = this.options.logger;
        this.apiClient = new WeComApiClient(this.logger, this.options.requestTimeout);
        this.wsManager = new WsConnectionManager(this.logger, this.options.heartbeatInterval, this.options.reconnectInterval, this.options.maxReconnectAttempts, this.options.wsUrl || void 0, this.options.wsOptions, this.options.maxReplyQueueSize, this.options.maxAuthFailureAttempts);
        this.wsManager.setCredentials(this.options.botId, this.options.secret, {
          ...this.options.scene !== void 0 && { scene: this.options.scene },
          ...this.options.plug_version !== void 0 && { plug_version: this.options.plug_version }
        });
        this.messageHandler = new MessageHandler(this.logger);
        this.setupWsEvents();
      }
      /**
       * 设置 WebSocket 事件处理
       */
      setupWsEvents() {
        this.wsManager.onConnected = () => {
          this.emit("connected");
        };
        this.wsManager.onAuthenticated = () => {
          this.logger.info("Authenticated");
          this.emit("authenticated");
        };
        this.wsManager.onDisconnected = (reason) => {
          this.emit("disconnected", reason);
        };
        this.wsManager.onServerDisconnect = (reason) => {
          this.logger.warn(`Server disconnected this connection: ${reason}`);
          this.started = false;
          this.emit("disconnected", reason);
        };
        this.wsManager.onReconnecting = (attempt) => {
          this.emit("reconnecting", attempt);
        };
        this.wsManager.onError = (error) => {
          this.emit("error", error);
        };
        this.wsManager.onMessage = (frame) => {
          this.messageHandler.handleFrame(frame, this);
        };
      }
      /**
       * 建立 WebSocket 长连接
       * SDK 使用内置默认地址建立连接，连接成功后自动发送认证帧（botId + secret）。
       * 支持链式调用：wsClient.connect().on('message', handler)
       *
       * @returns 返回 this，支持链式调用
       */
      connect() {
        if (this.started) {
          this.logger.warn("Client already connected");
          return this;
        }
        this.logger.info("Establishing WebSocket connection...");
        this.started = true;
        this.wsManager.connect();
        return this;
      }
      /**
       * 断开 WebSocket 连接
       */
      disconnect() {
        if (!this.started) {
          this.logger.warn("Client not connected");
          return;
        }
        this.logger.info("Disconnecting...");
        this.started = false;
        this.wsManager.disconnect();
        this.logger.info("Disconnected");
      }
      /**
       * 通过 WebSocket 通道发送回复消息（通用方法）
       *
       * @param frame - 收到的原始 WebSocket 帧，透传 headers.req_id
       * @param body - 回复消息体
       * @param cmd
       */
      reply(frame, body, cmd) {
        const reqId = frame.headers?.req_id || "";
        return this.wsManager.sendReply(reqId, body, cmd);
      }
      /**
       * 发送流式文本回复（便捷方法）
       *
       * @param frame - 收到的原始 WebSocket 帧，透传 headers.req_id
       * @param streamId - 流式消息 ID
       * @param content - 回复内容（支持 Markdown）
       * @param finish - 是否结束流式消息，默认 false
       * @param msgItem - 图文混排项（仅在 finish=true 时有效），用于在结束时附带图片内容
       * @param feedback - 反馈信息（仅在首次回复时设置）
       */
      replyStream(frame, streamId, content, finish = false, msgItem, feedback) {
        const stream = {
          id: streamId,
          finish,
          content
        };
        if (finish && msgItem && msgItem.length > 0) {
          stream.msg_item = msgItem;
        }
        if (feedback) {
          stream.feedback = feedback;
        }
        return this.reply(frame, {
          msgtype: "stream",
          stream
        });
      }
      /**
       * 发送欢迎语回复
       *
       * 注意：此方法需要使用对应事件（如 enter_chat）的 req_id 才能调用，
       * 即 frame 参数应来自触发欢迎语的事件帧。
       * 收到事件回调后需在 5 秒内发送回复，超时将无法发送欢迎语。
       *
       * @param frame - 对应事件的 WebSocket 帧（需包含该事件的 req_id）
       * @param body - 欢迎语消息体（支持文本或模板卡片格式）
       */
      replyWelcome(frame, body) {
        return this.reply(frame, body, WsCmd.RESPONSE_WELCOME);
      }
      /**
       * 回复模板卡片消息
       *
       * 收到消息回调或进入会话事件后，可使用此方法回复模板卡片消息。
       *
       * @param frame - 收到的原始 WebSocket 帧，透传 headers.req_id
       * @param templateCard - 模板卡片内容
       * @param feedback - 反馈信息
       */
      replyTemplateCard(frame, templateCard, feedback) {
        const card = feedback ? { ...templateCard, feedback } : templateCard;
        const body = {
          msgtype: "template_card",
          template_card: card
        };
        return this.reply(frame, body);
      }
      /**
       * 发送流式消息 + 模板卡片组合回复
       *
       * 首次回复时必须返回 stream 的 id。
       * template_card 可首次回复，也可在后续回复中发送，但同一个消息只能回复一次。
       *
       * @param frame - 收到的原始 WebSocket 帧，透传 headers.req_id
       * @param streamId - 流式消息 ID
       * @param content - 回复内容（支持 Markdown）
       * @param finish - 是否结束流式消息，默认 false
       * @param options - 可选项
       * @param options.msgItem - 图文混排项（仅在 finish=true 时有效）
       * @param options.streamFeedback - 流式消息反馈信息（首次回复时设置）
       * @param options.templateCard - 模板卡片内容（同一消息只能回复一次）
       * @param options.cardFeedback - 模板卡片反馈信息
       */
      replyStreamWithCard(frame, streamId, content, finish = false, options) {
        const stream = {
          id: streamId,
          finish,
          content
        };
        if (finish && options?.msgItem && options.msgItem.length > 0) {
          stream.msg_item = options.msgItem;
        }
        if (options?.streamFeedback) {
          stream.feedback = options.streamFeedback;
        }
        const body = {
          msgtype: "stream_with_template_card",
          stream
        };
        if (options?.templateCard) {
          body.template_card = options.cardFeedback ? { ...options.templateCard, feedback: options.cardFeedback } : options.templateCard;
        }
        return this.reply(frame, body);
      }
      /**
       * 更新模板卡片
       *
       * 注意：此方法需要使用对应事件（template_card_event）的 req_id 才能调用，
       * 即 frame 参数应来自触发更新的事件帧。
       * 收到事件回调后需在 5 秒内发送回复，超时将无法更新卡片。
       *
       * @param frame - 对应事件的 WebSocket 帧（需包含该事件的 req_id）
       * @param templateCard - 模板卡片内容（task_id 需跟回调收到的 task_id 一致）
       * @param userids - 要替换模版卡片消息的 userid 列表，若不填则替换所有用户
       */
      updateTemplateCard(frame, templateCard, userids) {
        const body = {
          response_type: "update_template_card",
          template_card: templateCard
        };
        if (userids && userids.length > 0) {
          body.userids = userids;
        }
        return this.reply(frame, body, WsCmd.RESPONSE_UPDATE);
      }
      /**
       * 主动发送消息
       *
       * 向指定会话（单聊或群聊）主动推送消息，无需依赖收到的回调帧。
       *
       * @param chatid - 会话 ID，单聊填用户的 userid，群聊填对应群聊的 chatid
       * @param body - 消息体（支持 markdown 或 template_card 格式）
       * @returns Promise，收到回执时 resolve(回执帧)
       *
       * @example
       * ```ts
       * // 发送 markdown 消息
       * await wsClient.sendMessage('CHATID', {
       *   msgtype: 'markdown',
       *   markdown: { content: '这是一条**主动推送**的消息' },
       * });
       *
       * // 发送模板卡片消息
       * await wsClient.sendMessage('CHATID', {
       *   msgtype: 'template_card',
       *   template_card: { card_type: 'text_notice', ... },
       * });
       * ```
       */
      sendMessage(chatid, body) {
        const reqId = generateReqId(WsCmd.SEND_MSG);
        const fullBody = {
          chatid,
          ...body
        };
        return this.wsManager.sendReply(reqId, fullBody, WsCmd.SEND_MSG);
      }
      /**
       * 上传临时素材（三步分片上传）
       *
       * 通过 WebSocket 长连接执行分片上传：init → chunk × N → finish
       * 单个分片不超过 512KB（Base64 编码前），最多 100 个分片。
       *
       * @param fileBuffer - 文件 Buffer
       * @param options - 上传选项（类型、文件名）
       * @returns 上传结果，包含 media_id
       */
      async uploadMedia(fileBuffer, options) {
        const { type, filename } = options;
        const totalSize = fileBuffer.length;
        const CHUNK_SIZE = 512 * 1024;
        const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);
        if (totalChunks > 100) {
          throw new Error(`File too large: ${totalChunks} chunks exceeds maximum of 100 chunks (max ~50MB)`);
        }
        const md5 = crypto.createHash("md5").update(fileBuffer).digest("hex");
        this.logger.info(`Uploading media: type=${type}, filename=${filename}, size=${totalSize}, chunks=${totalChunks}`);
        const initReqId = generateReqId(WsCmd.UPLOAD_MEDIA_INIT);
        const initResult = await this.wsManager.sendReply(initReqId, { type, filename, total_size: totalSize, total_chunks: totalChunks, md5 }, WsCmd.UPLOAD_MEDIA_INIT);
        const uploadId = initResult.body?.upload_id;
        if (!uploadId) {
          throw new Error(`Upload init failed: no upload_id returned. Response: ${JSON.stringify(initResult)}`);
        }
        this.logger.info(`Upload init success: upload_id=${uploadId}`);
        const MAX_CHUNK_RETRIES = 2;
        const MAX_CONCURRENCY = totalChunks <= 4 ? totalChunks : totalChunks <= 10 ? 3 : 2;
        const uploadChunk = /* @__PURE__ */ __name(async (chunkIndex) => {
          const start = chunkIndex * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, totalSize);
          const chunk = fileBuffer.subarray(start, end);
          const base64Data = chunk.toString("base64");
          let lastError;
          for (let attempt = 0; attempt <= MAX_CHUNK_RETRIES; attempt++) {
            try {
              const chunkReqId = generateReqId(WsCmd.UPLOAD_MEDIA_CHUNK);
              await this.wsManager.sendReply(chunkReqId, { upload_id: uploadId, chunk_index: chunkIndex, base64_data: base64Data }, WsCmd.UPLOAD_MEDIA_CHUNK);
              this.logger.debug(`Uploaded chunk ${chunkIndex + 1}/${totalChunks} (${chunk.length} bytes)`);
              return;
            } catch (err) {
              lastError = err;
              if (attempt < MAX_CHUNK_RETRIES) {
                const delay2 = 500 * (attempt + 1);
                this.logger.warn(`Chunk ${chunkIndex} upload failed (attempt ${attempt + 1}/${MAX_CHUNK_RETRIES + 1}), retrying in ${delay2}ms... error: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
                await new Promise((r) => setTimeout(r, delay2));
              }
            }
          }
          const errMsg = lastError instanceof Error ? lastError.message : JSON.stringify(lastError);
          throw new Error(`Chunk ${chunkIndex} upload failed after ${MAX_CHUNK_RETRIES + 1} attempts: ${errMsg}`);
        }, "uploadChunk");
        this.logger.debug(`Upload concurrency: ${MAX_CONCURRENCY} workers for ${totalChunks} chunks`);
        if (totalChunks <= 1) {
          await uploadChunk(0);
        } else {
          let nextIndex = 0;
          const errors = [];
          const runWorker = /* @__PURE__ */ __name(async () => {
            while (nextIndex < totalChunks) {
              const idx = nextIndex++;
              try {
                await uploadChunk(idx);
              } catch (err) {
                errors.push(err instanceof Error ? err : new Error(String(err)));
              }
            }
          }, "runWorker");
          const workerCount = Math.min(MAX_CONCURRENCY, totalChunks);
          await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
          if (errors.length > 0) {
            throw new Error(`Upload failed: ${errors.length} chunk(s) failed. First error: ${errors[0].message}`);
          }
        }
        this.logger.info(`All ${totalChunks} chunks uploaded, finishing...`);
        const finishReqId = generateReqId(WsCmd.UPLOAD_MEDIA_FINISH);
        const finishResult = await this.wsManager.sendReply(finishReqId, { upload_id: uploadId }, WsCmd.UPLOAD_MEDIA_FINISH);
        const mediaId = finishResult.body?.media_id;
        if (!mediaId) {
          throw new Error(`Upload finish failed: no media_id returned. Response: ${JSON.stringify(finishResult)}`);
        }
        this.logger.info(`Upload complete: media_id=${mediaId}, type=${finishResult.body?.type}`);
        return {
          type: finishResult.body?.type ?? type,
          media_id: mediaId,
          created_at: finishResult.body?.created_at ?? (/* @__PURE__ */ new Date()).toISOString()
        };
      }
      /**
       * 被动回复媒体消息（便捷方法）
       *
       * 通过 aibot_respond_msg 被动回复通道发送媒体消息（file/image/voice/video）
       *
       * @param frame - 收到的原始 WebSocket 帧，透传 headers.req_id
       * @param mediaType - 媒体类型
       * @param mediaId - 临时素材 media_id
       * @param videoOptions - 视频消息可选参数（仅 mediaType='video' 时生效）
       */
      replyMedia(frame, mediaType, mediaId, videoOptions) {
        const mediaContent = { media_id: mediaId };
        if (mediaType === "video" && videoOptions) {
          if (videoOptions.title)
            mediaContent.title = videoOptions.title;
          if (videoOptions.description)
            mediaContent.description = videoOptions.description;
        }
        const body = {
          msgtype: mediaType,
          [mediaType]: mediaContent
        };
        return this.reply(frame, body);
      }
      /**
       * 主动发送媒体消息（便捷方法）
       *
       * 通过 aibot_send_msg 主动推送通道发送媒体消息
       *
       * @param chatid - 会话 ID
       * @param mediaType - 媒体类型
       * @param mediaId - 临时素材 media_id
       * @param videoOptions - 视频消息可选参数（仅 mediaType='video' 时生效）
       */
      sendMediaMessage(chatid, mediaType, mediaId, videoOptions) {
        const mediaContent = { media_id: mediaId };
        if (mediaType === "video" && videoOptions) {
          if (videoOptions.title)
            mediaContent.title = videoOptions.title;
          if (videoOptions.description)
            mediaContent.description = videoOptions.description;
        }
        const body = {
          msgtype: mediaType,
          [mediaType]: mediaContent
        };
        return this.sendMessage(chatid, body);
      }
      /**
       * 下载文件并使用 AES 密钥解密
       *
       * @param url - 文件下载地址
       * @param aesKey - AES 解密密钥（Base64 编码），取自消息中 image.aeskey 或 file.aeskey 字段
       * @returns 解密后的文件 Buffer 及文件名
       *
       * @example
       * ```ts
       * // aesKey 来自消息体中的 image.aeskey 或 file.aeskey
       * const { buffer, filename } = await wsClient.downloadFile(imageUrl, body.image?.aeskey);
       * ```
       */
      async downloadFile(url, aesKey) {
        this.logger.debug(`[plugin] downloadFile: url=${url}, hasAesKey=${!!aesKey}`);
        this.logger.info("Downloading and decrypting file...");
        try {
          const { buffer: encryptedBuffer, filename } = await this.apiClient.downloadFileRaw(url);
          if (!aesKey) {
            this.logger.warn("No aesKey provided, returning raw file data");
            return { buffer: encryptedBuffer, filename };
          }
          const decryptedBuffer = decryptFile2(encryptedBuffer, aesKey);
          this.logger.info("File downloaded and decrypted successfully");
          return { buffer: decryptedBuffer, filename };
        } catch (error) {
          this.logger.error("File download/decrypt failed:", error.message);
          throw error;
        }
      }
      /**
       * 检查指定消息帧是否有未完成的 ack（即上一条消息还未收到回执）
       *
       * 用于流式场景：调用方可据此决定是否跳过当前中间帧，避免排队积压。
       *
       * @param frame - 收到的原始 WebSocket 帧
       * @returns true 表示有消息正在等待 ack
       */
      hasPendingReplyAck(frame) {
        const reqId = frame.headers?.req_id || "";
        return this.wsManager.hasPendingAck(reqId);
      }
      /**
       * 非阻塞流式文本回复
       *
       * 如果上一条同 reqId 的消息尚未收到 ack，则跳过本次发送（返回 'skipped'），
       * 避免流式中间帧排队积压导致延迟。
       *
       * 注意：finish=true 的最终帧不受此限制，始终保证发送（走正常队列）。
       *
       * @param frame - 收到的原始 WebSocket 帧
       * @param streamId - 流式消息 ID
       * @param content - 回复内容
       * @param finish - 是否结束流式消息
       * @param msgItem - 图文混排项（仅在 finish=true 时有效），用于在结束时附带图片内容
       * @param feedback - 反馈信息（仅在首次回复时设置）
       * @returns Promise<WsFrame> 正常发送时返回回执帧，跳过时返回 'skipped'
       */
      replyStreamNonBlocking(frame, streamId, content, finish = false, msgItem, feedback) {
        if (!finish && this.hasPendingReplyAck(frame)) {
          return Promise.resolve("skipped");
        }
        return this.replyStream(frame, streamId, content, finish, msgItem, feedback);
      }
      /**
       * 获取当前连接状态
       */
      get isConnected() {
        return this.wsManager.isConnected;
      }
      /**
       * 获取 API 客户端实例（供高级用途使用，如文件下载）
       */
      get api() {
        return this.apiClient;
      }
    };
    var CRYPTO_CONSTANTS = {
      /** PKCS#7 块大小 */
      PKCS7_BLOCK_SIZE: 32,
      /** AES Key 长度 */
      AES_KEY_LENGTH: 32
    };
    function decodeEncodingAESKey(encodingAESKey) {
      const trimmed = encodingAESKey.trim();
      if (!trimmed)
        throw new Error("encodingAESKey missing");
      const withPadding = trimmed.endsWith("=") ? trimmed : `${trimmed}=`;
      const key = Buffer.from(withPadding, "base64");
      if (key.length !== CRYPTO_CONSTANTS.AES_KEY_LENGTH) {
        throw new Error(`invalid encodingAESKey (expected ${CRYPTO_CONSTANTS.AES_KEY_LENGTH} bytes, got ${key.length})`);
      }
      return key;
    }
    __name(decodeEncodingAESKey, "decodeEncodingAESKey");
    function pkcs7Pad(buf, blockSize) {
      const mod = buf.length % blockSize;
      const pad = mod === 0 ? blockSize : blockSize - mod;
      const padByte = Buffer.alloc(1, pad);
      return Buffer.concat([buf, Buffer.alloc(pad, padByte[0])]);
    }
    __name(pkcs7Pad, "pkcs7Pad");
    function pkcs7Unpad(buf, blockSize) {
      if (buf.length === 0)
        throw new Error("invalid pkcs7 payload");
      const pad = buf[buf.length - 1];
      if (pad < 1 || pad > blockSize) {
        throw new Error("invalid pkcs7 padding value");
      }
      if (pad > buf.length) {
        throw new Error("invalid pkcs7 payload length");
      }
      for (let i = 0; i < pad; i += 1) {
        if (buf[buf.length - 1 - i] !== pad) {
          throw new Error("invalid pkcs7 padding byte");
        }
      }
      return buf.subarray(0, buf.length - pad);
    }
    __name(pkcs7Unpad, "pkcs7Unpad");
    function sha1Hex(input) {
      return crypto$1.createHash("sha1").update(input).digest("hex");
    }
    __name(sha1Hex, "sha1Hex");
    var WecomCrypto = class {
      static {
        __name(this, "WecomCrypto");
      }
      constructor(token, encodingAESKey, receiveId) {
        this.token = token;
        this.encodingAESKey = encodingAESKey;
        this.receiveId = receiveId;
        if (!token)
          throw new Error("token is required");
        this.aesKey = decodeEncodingAESKey(encodingAESKey);
        this.iv = this.aesKey.subarray(0, 16);
      }
      /**
       * 计算 WeCom 消息签名
       */
      computeSignature(timestamp, nonce, encrypt) {
        const parts = [this.token, timestamp, nonce, encrypt].map((v) => String(v ?? "")).sort();
        return sha1Hex(parts.join(""));
      }
      /**
       * 验证 WeCom 消息签名
       */
      verifySignature(signature, timestamp, nonce, encrypt) {
        const expected = this.computeSignature(timestamp, nonce, encrypt);
        return expected === signature;
      }
      /**
       * 消息解密
       * 返回纯文本字符串（XML 或 JSON 根据上层业务而定）
       */
      decrypt(encryptText) {
        const decipher = crypto$1.createDecipheriv("aes-256-cbc", this.aesKey, this.iv);
        decipher.setAutoPadding(false);
        const decryptedPadded = Buffer.concat([
          decipher.update(Buffer.from(encryptText, "base64")),
          decipher.final()
        ]);
        const decrypted = pkcs7Unpad(decryptedPadded, CRYPTO_CONSTANTS.PKCS7_BLOCK_SIZE);
        if (decrypted.length < 20) {
          throw new Error(`invalid payload (expected >=20 bytes, got ${decrypted.length})`);
        }
        const msgLen = decrypted.readUInt32BE(16);
        const msgStart = 20;
        const msgEnd = msgStart + msgLen;
        if (msgEnd > decrypted.length) {
          throw new Error(`invalid msg length (msgEnd=${msgEnd}, total=${decrypted.length})`);
        }
        const msg = decrypted.subarray(msgStart, msgEnd).toString("utf8");
        const receiveId = this.receiveId ?? "";
        if (receiveId) {
          const trailing = decrypted.subarray(msgEnd).toString("utf8");
          if (trailing !== receiveId) {
            throw new Error(`receiveId mismatch (expected "${receiveId}", got "${trailing}")`);
          }
        }
        return msg;
      }
      /**
       * 消息加密
       * 加密明文并返回 base64 格式密文与对应的新签名
       */
      encrypt(plainText, timestamp, nonce) {
        const random16 = crypto$1.randomBytes(16);
        const msgBuf = Buffer.from(plainText ?? "", "utf8");
        const msgLen = Buffer.alloc(4);
        msgLen.writeUInt32BE(msgBuf.length, 0);
        const receiveIdBuf = Buffer.from(this.receiveId ?? "", "utf8");
        const raw = Buffer.concat([random16, msgLen, msgBuf, receiveIdBuf]);
        const padded = pkcs7Pad(raw, CRYPTO_CONSTANTS.PKCS7_BLOCK_SIZE);
        const cipher = crypto$1.createCipheriv("aes-256-cbc", this.aesKey, this.iv);
        cipher.setAutoPadding(false);
        const encryptedBuf = Buffer.concat([cipher.update(padded), cipher.final()]);
        const encryptBase64 = encryptedBuf.toString("base64");
        const signature = this.computeSignature(timestamp, nonce, encryptBase64);
        return { encrypt: encryptBase64, signature };
      }
    };
    var AiBot = {
      WSClient: WSClient2
    };
    exports.DefaultLogger = DefaultLogger;
    exports.MessageHandler = MessageHandler;
    exports.WSAuthFailureError = WSAuthFailureError;
    exports.WSClient = WSClient2;
    exports.WSReconnectExhaustedError = WSReconnectExhaustedError;
    exports.WeComApiClient = WeComApiClient;
    exports.WecomCrypto = WecomCrypto;
    exports.WsCmd = WsCmd;
    exports.WsConnectionManager = WsConnectionManager;
    exports.decodeEncodingAESKey = decodeEncodingAESKey;
    exports.decryptFile = decryptFile2;
    exports.default = AiBot;
    exports.generateRandomString = generateRandomString;
    exports.generateReqId = generateReqId;
    exports.pkcs7Pad = pkcs7Pad;
    exports.pkcs7Unpad = pkcs7Unpad;
  }
});

// packages/channels/wecom/dist/index.js
init_esbuild_shims();

// packages/channels/wecom/dist/WeComAdapter.js
init_esbuild_shims();
var import_aibot_node_sdk = __toESM(require_index_cjs(), 1);
import { constants, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { randomUUID } from "node:crypto";
import { basename, join, resolve, win32, posix } from "node:path";
import { tmpdir } from "node:os";
import { Buffer as Buffer2 } from "node:buffer";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
var ClientCtor = import_aibot_node_sdk.WSClient;
var MESSAGE_EVENTS = [
  "message.text",
  "message.image",
  "message.mixed",
  "message.voice",
  "message.file",
  "message.video"
];
var SENSITIVE_ERROR_FIELDS = /* @__PURE__ */ new Set([
  "secret",
  "aeskey",
  "token",
  "password",
  "authorization"
]);
var DEDUP_TTL_MS = 5 * 60 * 1e3;
var MAX_MEDIA_BYTES = 20 * 1024 * 1024;
var MARKDOWN_CHUNK_BYTES = 3800;
var AUTHENTICATION_TIMEOUT_MS = 3e4;
var KICK_RECONNECT_MAX_ATTEMPTS = 3;
var KICK_RECONNECT_MAX_RETRY_CYCLES = 3;
var KICK_RECONNECT_BASE_DELAY_MS = 1e3;
var KICK_RECONNECT_RESET_MS = 6e4;
var KICK_RECONNECT_RETRY_MS = 5 * 60 * 1e3;
var KICK_RECONNECT_LONG_RETRY_MS = 15 * 60 * 1e3;
var DISCONNECT_RECONNECT_FALLBACK_MS = 3e4;
var ACTIVITY_WATCHDOG_INTERVAL_MS = 6e4;
var ACTIVITY_STALE_MS = 5 * 6e4;
var WeComChannel = class extends ChannelBase {
  static {
    __name(this, "WeComChannel");
  }
  wecom;
  client;
  seenMessages = /* @__PURE__ */ new Map();
  inFlightMessages = /* @__PURE__ */ new Set();
  attachmentDirsByMessage = /* @__PURE__ */ new Map();
  attachmentMessageByDir = /* @__PURE__ */ new Map();
  attachmentDirsBySession = /* @__PURE__ */ new Map();
  attachmentDirsWithoutMessageByRoute = /* @__PURE__ */ new Map();
  bufferedAttachmentMessages = /* @__PURE__ */ new Set();
  coalescedAttachmentMessages = /* @__PURE__ */ new Map();
  dedupTimer;
  kickReconnectReset;
  kickReconnectRetry;
  disconnectReconnectFallback;
  activityWatchdog;
  lastActivityAt = 0;
  connecting;
  connectingClient;
  authentication;
  disconnectGeneration = 0;
  clientHandlers;
  reconnectingAfterKick = false;
  pendingKickReconnect = false;
  kickReconnectAttempts = 0;
  kickReconnectRetryCycles = 0;
  constructor(name, config, bridge, options) {
    super(name, config, bridge, options);
    this.wecom = parseWeComConfig(name, config);
  }
  async connect() {
    if (this.client)
      return;
    if (this.connecting)
      return this.connecting;
    const connecting = this.openClient();
    this.connecting = connecting;
    try {
      await connecting;
    } finally {
      if (this.connecting === connecting)
        this.connecting = void 0;
    }
  }
  async openClient() {
    const options = {
      botId: this.wecom.botId,
      secret: this.wecom.secret,
      logger: createWeComLogger(this.name)
    };
    if (this.wecom.wsUrl) {
      options.wsUrl = this.wecom.wsUrl;
    }
    const client = new ClientCtor(options);
    let authenticated = false;
    const connectionGeneration = this.disconnectGeneration;
    const messageHandler = /* @__PURE__ */ __name((payload) => {
      this.recordActivity();
      if (!authenticated) {
        process.stderr.write(`[WeCom:${this.name}] dropping message before authentication.
`);
        return;
      }
      this.clearDisconnectReconnectFallback();
      this.onMessage(payload, connectionGeneration).catch((err) => {
        const logMessageId = getLogMessageId(payload);
        process.stderr.write(`[WeCom:${this.name}] message handling failed for ${logMessageId}: ${sanitizeLogText(formatSdkError(err), 200)}
`);
      });
    }, "messageHandler");
    const errorHandler = /* @__PURE__ */ __name((err) => {
      this.recordActivity();
      process.stderr.write(`[WeCom:${this.name}] SDK error: ${sanitizeLogText(formatSdkError(err), 200)}
`);
    }, "errorHandler");
    const disconnectedHandler = /* @__PURE__ */ __name((reason) => {
      this.recordActivity();
      if (this.disconnectGeneration !== connectionGeneration)
        return;
      process.stderr.write(`[WeCom:${this.name}] WebSocket ${formatDisconnectReason(reason)}; waiting for SDK reconnect.
`);
      if (authenticated) {
        this.scheduleDisconnectReconnectFallback(reason, client, this.disconnectGeneration);
      }
    }, "disconnectedHandler");
    const kickedHandler = /* @__PURE__ */ __name((reason) => {
      this.recordActivity();
      if (this.disconnectGeneration !== connectionGeneration)
        return;
      this.clearDisconnectReconnectFallback();
      this.startKickReconnect(reason);
    }, "kickedHandler");
    const handlers = {
      message: messageHandler,
      error: errorHandler,
      disconnected: disconnectedHandler,
      kicked: kickedHandler
    };
    for (const event of MESSAGE_EVENTS) {
      client.on(event, messageHandler);
    }
    client.on("error", errorHandler);
    client.on("disconnected", disconnectedHandler);
    client.on("event.disconnected_event", kickedHandler);
    this.clientHandlers = handlers;
    this.connectingClient = client;
    const authentication = waitForAuthentication(client);
    this.authentication = authentication;
    try {
      authentication.promise.catch(() => {
      });
      const connected = client.connect();
      const connectedPromise = isPromiseLike(connected) ? withTimeout(Promise.resolve(connected).then(() => {
      }), AUTHENTICATION_TIMEOUT_MS, "WeCom SDK connect timed out.") : Promise.resolve();
      await Promise.all([connectedPromise, authentication.promise]);
      authenticated = true;
      if (this.connectingClient !== client) {
        throw new Error("WeCom connection was replaced before authentication.");
      }
      this.client = client;
      this.connectingClient = void 0;
      this.authentication = void 0;
      this.recordActivity();
      this.startActivityWatchdog(connectionGeneration);
    } catch (err) {
      authentication.cancel();
      try {
        this.detachClientHandlers(client, handlers);
      } catch {
      }
      if (this.connectingClient === client)
        this.connectingClient = void 0;
      if (this.authentication === authentication)
        this.authentication = void 0;
      try {
        client.disconnect();
      } catch {
      }
      throw err;
    }
    if (!this.dedupTimer) {
      this.dedupTimer = setInterval(() => this.cleanupSeenMessages(), 6e4);
      this.dedupTimer.unref?.();
    }
    process.stderr.write(`[WeCom:${this.name}] Connected via smart bot.
`);
  }
  disconnect() {
    this.disconnectGeneration += 1;
    this.kickReconnectAttempts = 0;
    this.kickReconnectRetryCycles = 0;
    this.pendingKickReconnect = false;
    if (this.kickReconnectReset) {
      clearTimeout(this.kickReconnectReset);
      this.kickReconnectReset = void 0;
    }
    if (this.kickReconnectRetry) {
      clearTimeout(this.kickReconnectRetry);
      this.kickReconnectRetry = void 0;
    }
    this.clearDisconnectReconnectFallback();
    this.clearActivityWatchdog();
    if (this.dedupTimer) {
      clearInterval(this.dedupTimer);
      this.dedupTimer = void 0;
    }
    this.seenMessages.clear();
    this.inFlightMessages.clear();
    this.cleanupAllAttachmentDirs();
    this.disconnectClientOnly(new Error("WeCom channel disconnected."));
    process.stderr.write(`[WeCom:${this.name}] Disconnected.
`);
  }
  supportsProactiveSend() {
    return true;
  }
  async sendMessage(chatId, text) {
    await this.sendAttributedMessage(chatId, text);
  }
  async sendThreadMessage(chatId, _threadId, text, sourceLabel) {
    await this.sendAttributedMessage(chatId, text, sourceLabel);
  }
  async sendAttributedMessage(chatId, text, sourceLabel) {
    const client = this.client;
    if (!client) {
      throw new Error(`[WeCom:${this.name}] No active SDK client, cannot send.`);
    }
    const { cleanedText, media } = parseOutboundMediaMarkers(text);
    const prefix = sourceLabel && (cleanedText.trim().length > 0 || media.length > 0) ? `${escapeWeComMarkdown(sourceLabel)}
` : void 0;
    const chunks = splitMarkdownChunks(cleanedText, prefix);
    if (chunks.length === 0 && media.length > 0 && prefix) {
      chunks.push(prefix.trimEnd());
    }
    if (chunks.length === 0 && media.length === 0) {
      process.stderr.write(`[WeCom:${this.name}] sendMessage produced empty payload for chatId=${sanitizeLogText(chatId, 100)}.
`);
      return;
    }
    for (const chunk of chunks) {
      await client.sendMessage(chatId, {
        msgtype: "markdown",
        markdown: { content: chunk }
      });
    }
    const mediaErrors = [];
    for (const item of media) {
      if (item.type !== "image") {
        process.stderr.write(`[WeCom:${this.name}] skipping unsupported outbound media marker: ${item.type}
`);
        continue;
      }
      try {
        const file = await readOutboundMedia(item.path, this.config.cwd);
        const upload = await client.uploadMedia(file.data, {
          type: item.type,
          filename: file.fileName
        });
        const mediaId = extractMediaId(upload);
        if (!mediaId) {
          mediaErrors.push(`upload returned no media_id for ${item.type}`);
          process.stderr.write(`[WeCom:${this.name}] upload returned no media_id, skipping.
`);
          continue;
        }
        await client.sendMediaMessage(chatId, item.type, mediaId);
      } catch (err) {
        const message = sanitizeLogText(formatSdkError(err), 200);
        mediaErrors.push(`${item.type}: ${message}`);
        process.stderr.write(`[WeCom:${this.name}] media send failed for ${item.type}: ${message}
`);
      }
    }
    if (mediaErrors.length > 0) {
      const message = `[WeCom:${this.name}] ${mediaErrors.length} media send(s) failed (markdown text may already be delivered): ${mediaErrors.join("; ")}`;
      process.stderr.write(`${message}
`);
    }
  }
  async onMessage(payload, connectionGeneration) {
    const body = extractBody(payload);
    if (!body) {
      process.stderr.write(`[WeCom:${this.name}] dropping message with unrecognized payload structure.
`);
      return;
    }
    this.logDebugPayload("WeCom", body);
    const rawMessageId = getString(body, "msgid") || void 0;
    const messageId = rawMessageId ?? `synthetic-${randomUUID()}`;
    const logMessageId = sanitizeLogText(rawMessageId || "(no id)", 100);
    const from = getRecord(body, "from");
    const senderId = getString(from, "userid") || "";
    const senderName = getString(from, "name") || senderId || "Unknown";
    const isGroup = getString(body, "chattype") === "group";
    const rawChatId = getString(body, "chatid");
    const chatId = isGroup ? rawChatId : rawChatId || senderId;
    if (!chatId || !senderId) {
      process.stderr.write(`[WeCom:${this.name}] dropping message ${logMessageId}: missing ${!senderId ? "senderId" : "chatId"}.
`);
      return;
    }
    if (rawMessageId) {
      if (this.inFlightMessages.has(rawMessageId)) {
        process.stderr.write(`[WeCom:${this.name}] dropping duplicate message ${logMessageId} (already in flight).
`);
        return;
      }
      if (this.seenMessages.has(rawMessageId)) {
        process.stderr.write(`[WeCom:${this.name}] dropping duplicate message ${logMessageId} (already seen).
`);
        return;
      }
      this.inFlightMessages.add(rawMessageId);
    }
    const text = extractText(body);
    const quote = getRecord(body, "quote");
    const envelope = {
      channelName: this.name,
      senderId,
      senderName,
      chatId,
      text,
      ...isSyntheticMediaText(body, text) ? { syntheticText: true } : {},
      messageId: rawMessageId ?? messageId,
      isGroup,
      // WeCom only delivers group callbacks when the intelligent robot is
      // mentioned, so each delivered group message is already mention-scoped.
      isMentioned: true,
      isReplyToBot: getString(getRecord(quote, "from"), "userid") === this.wecom.botId,
      referencedText: extractQuoteText(quote)
    };
    let attachments = [];
    const hasInboundMedia = collectInboundMediaRefs(body).length > 0;
    const attachmentRouteKey = this.attachmentRouteKey(senderId, chatId, envelope.threadId);
    let processStarted = false;
    try {
      if (!await this.preflightInbound(envelope)) {
        process.stderr.write(`[WeCom:${this.name}] dropping message ${logMessageId}: preflight rejected.
`);
        return;
      }
      await this.processPreflightedInbound(envelope, async () => {
        attachments = await this.downloadAttachments(body, attachments, messageId, attachmentRouteKey, connectionGeneration);
        if (this.disconnectGeneration !== connectionGeneration) {
          process.stderr.write(`[WeCom:${this.name}] dropping message ${logMessageId}: connection changed during attachment download.
`);
          return;
        }
        if (attachments.length) {
          envelope.attachments = attachments;
        }
        if (envelope.syntheticText && attachments.length === 0 && hasInboundMedia) {
          envelope.text = "(User sent media but download failed)";
        }
        if (!envelope.text && attachments.length) {
          envelope.text = attachments.some((a) => a.type === "image") ? "(image)" : `(file: ${attachments[0]?.fileName ?? "file"})`;
        }
        if (rawMessageId)
          this.seenMessages.set(rawMessageId, Date.now());
        processStarted = true;
        await this.processInbound(envelope);
      });
    } catch (err) {
      if (rawMessageId && !processStarted) {
        this.seenMessages.delete(rawMessageId);
      } else if (rawMessageId) {
        process.stderr.write(`[WeCom:${this.name}] message ${logMessageId} failed after processing started; dedup entry retained.
`);
      }
      throw err;
    } finally {
      if (rawMessageId)
        this.inFlightMessages.delete(rawMessageId);
      if (messageId && !this.bufferedAttachmentMessages.has(messageId) && this.attachmentDirsByMessage.has(messageId)) {
        this.cleanupAttachmentDirsForMessage(messageId);
      }
    }
  }
  async downloadAttachments(body, attachments = [], messageId, routeKey, connectionGeneration = this.disconnectGeneration) {
    const refs = collectInboundMediaRefs(body);
    for (const ref of refs) {
      if (this.disconnectGeneration !== connectionGeneration)
        return attachments;
      let downloaded;
      try {
        downloaded = await downloadInboundMedia(ref);
      } catch (err) {
        process.stderr.write(`[WeCom:${this.name}] skipping ${ref.type} attachment: ${sanitizeLogText(err instanceof Error ? err.message : String(err), 160)}.
`);
        continue;
      }
      if (this.disconnectGeneration !== connectionGeneration)
        return attachments;
      const data = downloaded.buffer;
      const fileName = sanitizeFileName(ref.fileName || downloaded.filename);
      if (ref.type === "image") {
        attachments.push({
          type: "image",
          data: data.toString("base64"),
          mimeType: detectImageMime(data),
          fileName
        });
      } else {
        const dir = join(tmpdir(), "channel-files", randomUUID());
        const safeName = fileName || `wecom_${ref.type}`;
        const filePath = join(dir, safeName);
        try {
          if (this.disconnectGeneration !== connectionGeneration) {
            return attachments;
          }
          mkdirSync(dir, { recursive: true, mode: 448 });
          await writeFile(filePath, data, { mode: 384 });
          if (this.disconnectGeneration !== connectionGeneration) {
            cleanupAttachmentDirs([dir]);
            return attachments;
          }
          this.rememberAttachmentDir(dir, messageId, routeKey);
        } catch (err) {
          cleanupAttachmentDirs([dir]);
          process.stderr.write(`[WeCom:${this.name}] skipping ${ref.type} attachment: ${sanitizeLogText(err instanceof Error ? err.message : String(err), 160)}.
`);
          continue;
        }
        attachments.push({
          type: ref.type === "voice" ? "audio" : ref.type,
          filePath,
          mimeType: mediaTypeToMime(ref.type),
          fileName: safeName
        });
      }
    }
    return attachments;
  }
  onPromptBuffered(_chatId, sessionId, messageId) {
    if (!messageId) {
      this.rememberUntrackedDirsForSession(sessionId);
      return;
    }
    this.bufferedAttachmentMessages.add(messageId);
    this.rememberMessageDirsForSession(messageId, sessionId);
  }
  onPromptStart(_chatId, sessionId, messageId) {
    if (messageId) {
      this.rememberMessageDirsForSession(messageId, sessionId);
    } else {
      this.rememberUntrackedDirsForSession(sessionId);
    }
  }
  onPromptBufferDrained(_chatId, _sessionId, messageIds) {
    const lastMessageId = messageIds.at(-1);
    if (lastMessageId) {
      this.coalescedAttachmentMessages.set(lastMessageId, messageIds);
    }
  }
  onPromptBufferDropped(_chatId, sessionId, messageIds) {
    for (const messageId of messageIds) {
      this.cleanupAttachmentDirsForMessage(messageId);
    }
    this.cleanupUntrackedAttachmentDirsForSession(sessionId);
  }
  onPromptEnd(_chatId, sessionId, messageId) {
    if (!messageId) {
      this.cleanupAttachmentDirsForSession(sessionId);
      return;
    }
    const coalescedMessageIds = this.coalescedAttachmentMessages.get(messageId);
    if (coalescedMessageIds) {
      this.coalescedAttachmentMessages.delete(messageId);
      for (const coalescedMessageId of coalescedMessageIds) {
        this.cleanupAttachmentDirsForMessage(coalescedMessageId);
      }
      this.cleanupUntrackedAttachmentDirsForSession(sessionId);
      return;
    }
    this.cleanupAttachmentDirsForMessage(messageId);
  }
  rememberAttachmentDir(dir, messageId, routeKey) {
    if (messageId) {
      const messageDirs = this.attachmentDirsByMessage.get(messageId) ?? [];
      messageDirs.push(dir);
      this.attachmentDirsByMessage.set(messageId, messageDirs);
      this.attachmentMessageByDir.set(dir, messageId);
    } else if (routeKey) {
      const dirs = this.attachmentDirsWithoutMessageByRoute.get(routeKey) ?? [];
      dirs.push(dir);
      this.attachmentDirsWithoutMessageByRoute.set(routeKey, dirs);
    }
  }
  rememberMessageDirsForSession(messageId, sessionId) {
    const dirs = this.attachmentDirsByMessage.get(messageId);
    if (!dirs)
      return;
    const sessionDirs = this.attachmentDirsBySession.get(sessionId) ?? [];
    for (const dir of dirs) {
      if (!sessionDirs.includes(dir))
        sessionDirs.push(dir);
    }
    this.attachmentDirsBySession.set(sessionId, sessionDirs);
  }
  cleanupAttachmentDirsForMessage(messageId) {
    this.bufferedAttachmentMessages.delete(messageId);
    const dirs = this.attachmentDirsByMessage.get(messageId);
    if (!dirs)
      return;
    this.attachmentDirsByMessage.delete(messageId);
    for (const dir of dirs) {
      this.attachmentMessageByDir.delete(dir);
    }
    this.removeAttachmentDirsFromSessions(dirs);
    cleanupAttachmentDirs(dirs);
  }
  cleanupAttachmentDirsForSession(sessionId) {
    const dirs = this.attachmentDirsBySession.get(sessionId);
    if (!dirs)
      return;
    this.attachmentDirsBySession.delete(sessionId);
    this.removeAttachmentDirsFromMessages(dirs);
    for (const dir of dirs) {
      this.attachmentMessageByDir.delete(dir);
    }
    cleanupAttachmentDirs(dirs);
  }
  cleanupUntrackedAttachmentDirsForSession(sessionId) {
    const dirs = this.attachmentDirsBySession.get(sessionId);
    if (!dirs)
      return;
    const untrackedDirs = dirs.filter((dir) => !this.attachmentMessageByDir.has(dir));
    if (untrackedDirs.length === 0)
      return;
    const remainingDirs = dirs.filter((dir) => this.attachmentMessageByDir.has(dir));
    if (remainingDirs.length > 0) {
      this.attachmentDirsBySession.set(sessionId, remainingDirs);
    } else {
      this.attachmentDirsBySession.delete(sessionId);
    }
    cleanupAttachmentDirs(untrackedDirs);
  }
  rememberUntrackedDirsForSession(sessionId) {
    const routeKey = this.attachmentRouteKeyForSession(sessionId);
    if (!routeKey)
      return;
    const dirs = this.attachmentDirsWithoutMessageByRoute.get(routeKey);
    if (!dirs || dirs.length === 0)
      return;
    const sessionDirs = this.attachmentDirsBySession.get(sessionId) ?? [];
    for (const dir of dirs) {
      if (!sessionDirs.includes(dir))
        sessionDirs.push(dir);
    }
    this.attachmentDirsBySession.set(sessionId, sessionDirs);
    this.attachmentDirsWithoutMessageByRoute.delete(routeKey);
  }
  removeAttachmentDirsFromSessions(dirs) {
    const removed = new Set(dirs);
    for (const [sessionId, sessionDirs] of this.attachmentDirsBySession) {
      const remaining = sessionDirs.filter((dir) => !removed.has(dir));
      if (remaining.length) {
        this.attachmentDirsBySession.set(sessionId, remaining);
      } else {
        this.attachmentDirsBySession.delete(sessionId);
      }
    }
  }
  removeAttachmentDirsFromMessages(dirs) {
    const removed = new Set(dirs);
    for (const [messageId, messageDirs] of this.attachmentDirsByMessage) {
      const remaining = messageDirs.filter((dir) => !removed.has(dir));
      if (remaining.length) {
        this.attachmentDirsByMessage.set(messageId, remaining);
      } else {
        this.attachmentDirsByMessage.delete(messageId);
        this.bufferedAttachmentMessages.delete(messageId);
      }
    }
    for (const dir of dirs) {
      this.attachmentMessageByDir.delete(dir);
    }
  }
  cleanupAllAttachmentDirs() {
    const dirs = Array.from(/* @__PURE__ */ new Set([
      ...Array.from(this.attachmentDirsBySession.values()).flat(),
      ...Array.from(this.attachmentDirsByMessage.values()).flat(),
      ...Array.from(this.attachmentDirsWithoutMessageByRoute.values()).flat()
    ]));
    this.attachmentDirsBySession.clear();
    this.attachmentDirsByMessage.clear();
    this.attachmentMessageByDir.clear();
    this.attachmentDirsWithoutMessageByRoute.clear();
    this.bufferedAttachmentMessages.clear();
    this.coalescedAttachmentMessages.clear();
    cleanupAttachmentDirs(dirs);
  }
  attachmentRouteKeyForSession(sessionId) {
    const target = this.router.getTarget(sessionId);
    if (!target || target.channelName !== this.name)
      return void 0;
    return this.attachmentRouteKey(target.senderId, target.chatId, target.threadId);
  }
  attachmentRouteKey(senderId, chatId, threadId) {
    switch (this.config.sessionScope) {
      case "thread":
        return `${this.name}:${threadId || chatId}`;
      case "chat_thread":
        return threadId ? `${this.name}:${chatId}:${threadId}` : `${this.name}:${chatId}`;
      case "single":
        return `${this.name}:__single__`;
      case "user":
      default:
        return `${this.name}:${senderId}:${chatId}`;
    }
  }
  detachClientHandlers(client, handlers = this.clientHandlers) {
    if (!handlers)
      return;
    for (const event of MESSAGE_EVENTS) {
      client.off?.(event, handlers.message);
    }
    client.off?.("error", handlers.error);
    client.off?.("disconnected", handlers.disconnected);
    client.off?.("event.disconnected_event", handlers.kicked);
    if (this.clientHandlers === handlers)
      this.clientHandlers = void 0;
  }
  disconnectClientOnly(err) {
    const client = this.client ?? this.connectingClient;
    this.authentication?.cancel(err);
    this.authentication = void 0;
    this.client = void 0;
    this.connectingClient = void 0;
    this.clearActivityWatchdog();
    if (client)
      this.detachClientHandlers(client);
    try {
      client?.disconnect();
    } catch (e) {
      process.stderr.write(`[WeCom:${this.name}] client.disconnect() threw: ${sanitizeLogText(formatSdkError(e), 200)}
`);
    }
  }
  clearDisconnectReconnectFallback() {
    if (!this.disconnectReconnectFallback)
      return;
    clearTimeout(this.disconnectReconnectFallback);
    this.disconnectReconnectFallback = void 0;
  }
  recordActivity() {
    this.lastActivityAt = Date.now();
  }
  clearActivityWatchdog() {
    if (!this.activityWatchdog)
      return;
    clearInterval(this.activityWatchdog);
    this.activityWatchdog = void 0;
  }
  startActivityWatchdog(disconnectGeneration) {
    this.clearActivityWatchdog();
    this.activityWatchdog = setInterval(() => {
      if (this.disconnectGeneration !== disconnectGeneration)
        return;
      if (!this.client || this.reconnectingAfterKick)
        return;
      if (Date.now() - this.lastActivityAt < ACTIVITY_STALE_MS)
        return;
      process.stderr.write(`[WeCom:${this.name}] no SDK activity for ${ACTIVITY_STALE_MS / 6e4} minutes; reconnecting adapter.
`);
      this.kickReconnectAttempts = 0;
      this.kickReconnectRetryCycles = 0;
      this.startKickReconnect(new Error("WeCom SDK activity watchdog timed out."), "activity watchdog");
    }, ACTIVITY_WATCHDOG_INTERVAL_MS);
    this.activityWatchdog.unref?.();
  }
  scheduleDisconnectReconnectFallback(reason, client, disconnectGeneration) {
    this.clearDisconnectReconnectFallback();
    const formattedReason = formatDisconnectReason(reason);
    this.disconnectReconnectFallback = setTimeout(() => {
      this.disconnectReconnectFallback = void 0;
      if (this.disconnectGeneration !== disconnectGeneration)
        return;
      if (this.client !== client)
        return;
      process.stderr.write(`[WeCom:${this.name}] SDK reconnect did not recover after WebSocket ${formattedReason}; reconnecting adapter.
`);
      this.kickReconnectAttempts = 0;
      this.kickReconnectRetryCycles = 0;
      this.startKickReconnect(reason, "SDK disconnect");
    }, DISCONNECT_RECONNECT_FALLBACK_MS);
    this.disconnectReconnectFallback.unref?.();
  }
  async reconnectAfterKick(reason, reconnectReason = "server kick") {
    if (this.reconnectingAfterKick) {
      this.pendingKickReconnect = true;
      return;
    }
    if (this.kickReconnectRetry) {
      clearTimeout(this.kickReconnectRetry);
      this.kickReconnectRetry = void 0;
      this.kickReconnectAttempts = 0;
    }
    if (this.kickReconnectReset) {
      clearTimeout(this.kickReconnectReset);
      this.kickReconnectReset = void 0;
    }
    this.reconnectingAfterKick = true;
    const previousConnecting = this.connecting;
    const disconnectGeneration = this.disconnectGeneration;
    process.stderr.write(`[WeCom:${this.name}] WebSocket ${formatDisconnectReason(reason)}; reconnecting after ${reconnectReason}.
`);
    try {
      this.disconnectClientOnly(new Error(`WeCom connection was kicked: ${formatDisconnectReason(reason)}`));
      if (previousConnecting) {
        await previousConnecting.catch(() => {
        });
      }
      while (this.kickReconnectAttempts < KICK_RECONNECT_MAX_ATTEMPTS) {
        const attempt = ++this.kickReconnectAttempts;
        await delay(KICK_RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
        if (this.disconnectGeneration !== disconnectGeneration) {
          process.stderr.write(`[WeCom:${this.name}] reconnect after ${reconnectReason} abandoned: connection generation changed.
`);
          return;
        }
        try {
          await this.connect();
          if (this.disconnectGeneration !== disconnectGeneration) {
            process.stderr.write(`[WeCom:${this.name}] reconnect after ${reconnectReason} abandoned: connection generation changed.
`);
            return;
          }
          this.kickReconnectAttempts = 0;
          this.kickReconnectRetryCycles = 0;
          this.scheduleKickReconnectReset();
          process.stderr.write(`[WeCom:${this.name}] reconnected after ${reconnectReason}.
`);
          return;
        } catch (err) {
          process.stderr.write(`[WeCom:${this.name}] reconnect after ${reconnectReason} attempt ${attempt} failed: ${sanitizeLogText(formatSdkError(err), 200)}
`);
        }
      }
      this.kickReconnectRetryCycles += 1;
      if (this.kickReconnectRetryCycles >= KICK_RECONNECT_MAX_RETRY_CYCLES) {
        process.stderr.write(`[WeCom:${this.name}] reconnect after ${reconnectReason} exhausted ${this.kickReconnectRetryCycles} retry cycles; next attempt in ${KICK_RECONNECT_LONG_RETRY_MS / 6e4} minutes.
`);
        this.scheduleKickReconnectRetry(reason, disconnectGeneration, KICK_RECONNECT_LONG_RETRY_MS, reconnectReason, true);
        return;
      }
      process.stderr.write(`[WeCom:${this.name}] reconnect after ${reconnectReason} gave up after ${KICK_RECONNECT_MAX_ATTEMPTS} attempts; retrying later.
`);
      this.scheduleKickReconnectRetry(reason, disconnectGeneration, KICK_RECONNECT_RETRY_MS, reconnectReason);
    } finally {
      this.reconnectingAfterKick = false;
      const shouldRetryPendingKick = this.pendingKickReconnect && this.disconnectGeneration === disconnectGeneration;
      this.pendingKickReconnect = false;
      if (shouldRetryPendingKick && !this.client) {
        this.kickReconnectAttempts = 0;
        this.startKickReconnect(reason, reconnectReason);
      }
    }
  }
  scheduleKickReconnectReset() {
    if (this.kickReconnectRetry) {
      clearTimeout(this.kickReconnectRetry);
      this.kickReconnectRetry = void 0;
    }
    if (this.kickReconnectReset)
      clearTimeout(this.kickReconnectReset);
    this.kickReconnectReset = setTimeout(() => {
      this.kickReconnectAttempts = 0;
      this.kickReconnectRetryCycles = 0;
      this.kickReconnectReset = void 0;
    }, KICK_RECONNECT_RESET_MS);
    this.kickReconnectReset.unref?.();
  }
  scheduleKickReconnectRetry(reason, disconnectGeneration, delayMs = KICK_RECONNECT_RETRY_MS, reconnectReason = "server kick", resetRetryCycles = false) {
    this.kickReconnectRetry = setTimeout(() => {
      this.kickReconnectRetry = void 0;
      if (this.disconnectGeneration !== disconnectGeneration) {
        process.stderr.write(`[WeCom:${this.name}] scheduled kick-reconnect cancelled; connection generation changed.
`);
        return;
      }
      this.kickReconnectAttempts = 0;
      if (resetRetryCycles)
        this.kickReconnectRetryCycles = 0;
      this.startKickReconnect(reason, reconnectReason);
    }, delayMs);
    this.kickReconnectRetry.unref?.();
  }
  startKickReconnect(reason, reconnectReason = "server kick") {
    void this.reconnectAfterKick(reason, reconnectReason).catch((err) => {
      process.stderr.write(`[WeCom:${this.name}] kick-reconnect failed: ${sanitizeLogText(formatSdkError(err), 200)}
`);
      if (this.kickReconnectRetry === void 0) {
        this.scheduleKickReconnectRetry(reason, this.disconnectGeneration, KICK_RECONNECT_LONG_RETRY_MS, reconnectReason, true);
      }
    });
  }
  cleanupSeenMessages() {
    const now = Date.now();
    for (const [id, ts] of this.seenMessages) {
      if (now - ts > DEDUP_TTL_MS) {
        this.seenMessages.delete(id);
      }
    }
  }
};
function waitForAuthentication(client) {
  let timeout;
  let settled = false;
  let finish = /* @__PURE__ */ __name(() => {
  }, "finish");
  const onAuth = /* @__PURE__ */ __name(() => finish(), "onAuth");
  const onError = /* @__PURE__ */ __name((err) => finish(new Error(`WeCom authentication failed: ${sanitizeLogText(String(err), 200)}`)), "onError");
  const onKicked = /* @__PURE__ */ __name((reason) => finish(new Error(`WeCom authentication interrupted by server kick: ${formatDisconnectReason(reason)}`)), "onKicked");
  const promise = new Promise((resolvePromise, rejectPromise) => {
    finish = /* @__PURE__ */ __name((err) => {
      if (settled)
        return;
      settled = true;
      if (timeout)
        clearTimeout(timeout);
      client.off?.("authenticated", onAuth);
      client.off?.("error", onError);
      client.off?.("event.disconnected_event", onKicked);
      if (err) {
        rejectPromise(err);
      } else {
        resolvePromise();
      }
    }, "finish");
    timeout = setTimeout(() => {
      finish(new Error("WeCom authentication timed out."));
    }, AUTHENTICATION_TIMEOUT_MS);
    timeout.unref?.();
    client.on("authenticated", onAuth);
    client.on("error", onError);
    client.on("event.disconnected_event", onKicked);
  });
  return {
    promise,
    cancel: /* @__PURE__ */ __name((err) => finish(err), "cancel")
  };
}
__name(waitForAuthentication, "waitForAuthentication");
function withTimeout(promise, timeoutMs, message) {
  let timeout;
  return new Promise((resolvePromise, rejectPromise) => {
    timeout = setTimeout(() => {
      rejectPromise(new Error(message));
    }, timeoutMs);
    timeout.unref?.();
    promise.then((value) => {
      if (timeout)
        clearTimeout(timeout);
      resolvePromise(value);
    }, (err) => {
      if (timeout)
        clearTimeout(timeout);
      rejectPromise(err);
    });
  });
}
__name(withTimeout, "withTimeout");
function delay(ms) {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    timer.unref?.();
  });
}
__name(delay, "delay");
function cleanupAttachmentDirs(dirs) {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      process.stderr.write(`[WeCom] failed to remove attachment dir ${sanitizeLogText(dir, 200)}: ${sanitizeLogText(formatSdkError(err), 200)}.
`);
    }
  }
}
__name(cleanupAttachmentDirs, "cleanupAttachmentDirs");
function formatDisconnectReason(reason) {
  const text = typeof reason === "string" && reason ? reason : formatSdkError(reason);
  return sanitizeLogText(text, 120);
}
__name(formatDisconnectReason, "formatDisconnectReason");
function formatSdkError(err) {
  if (err instanceof Error)
    return err.message;
  const record = asRecord(err);
  if (record) {
    const errcode = record["errcode"];
    const errmsg = record["errmsg"];
    if (typeof errcode === "number" || typeof errmsg === "string") {
      return redactSensitiveErrorText(`errcode=${String(errcode)} errmsg=${String(errmsg)}`);
    }
    const code = record["code"];
    const reason = record["reason"];
    const wasClean = record["wasClean"];
    if (typeof code === "number" || typeof reason === "string" || typeof wasClean === "boolean") {
      return [
        typeof code === "number" ? `code=${code}` : void 0,
        typeof reason === "string" ? `reason=${redactSensitiveErrorText(reason)}` : void 0,
        typeof wasClean === "boolean" ? `wasClean=${wasClean}` : void 0
      ].filter((part) => Boolean(part)).join(" ");
    }
    try {
      return JSON.stringify(record, (key, value) => SENSITIVE_ERROR_FIELDS.has(key.toLowerCase()) ? "[REDACTED]" : value);
    } catch {
    }
  }
  return String(err);
}
__name(formatSdkError, "formatSdkError");
function redactSensitiveErrorText(text) {
  return text.replace(/(["']?(?:secret|aeskey|token|password|authorization)["']?\s*[:=]\s*)(["']?)[^"',\s}]+(\2)/giu, "$1$2[REDACTED]$3");
}
__name(redactSensitiveErrorText, "redactSensitiveErrorText");
function isPromiseLike(value) {
  return value !== null && (typeof value === "object" || typeof value === "function") && "then" in value && typeof value.then === "function";
}
__name(isPromiseLike, "isPromiseLike");
function parseWeComConfig(name, config) {
  const botId = readRequiredString(config, "botId");
  const secret = readRequiredString(config, "secret");
  if (!botId || !secret) {
    throw new Error(`Channel "${name}" requires botId and secret for WeCom.`);
  }
  const wsUrl = readOptionalString(config, "wsUrl");
  if (wsUrl && !isSecureWebSocketUrl(wsUrl)) {
    throw new Error(`Channel "${name}" requires wsUrl to use wss://.`);
  }
  return wsUrl ? { botId, secret, wsUrl } : { botId, secret };
}
__name(parseWeComConfig, "parseWeComConfig");
function readRequiredString(config, key) {
  const value = config[key];
  return typeof value === "string" ? value.trim() : "";
}
__name(readRequiredString, "readRequiredString");
function readOptionalString(config, key) {
  const value = config[key];
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
__name(readOptionalString, "readOptionalString");
function isSecureWebSocketUrl(value) {
  try {
    return new URL(value).protocol === "wss:";
  } catch {
    return false;
  }
}
__name(isSecureWebSocketUrl, "isSecureWebSocketUrl");
function createWeComLogger(name) {
  const write = /* @__PURE__ */ __name((level, message) => {
    process.stderr.write(`[WeCom:${name}] SDK ${level}: ${sanitizeLogText(message, 200)}
`);
  }, "write");
  return {
    debug: /* @__PURE__ */ __name(() => {
    }, "debug"),
    info: /* @__PURE__ */ __name(() => {
    }, "info"),
    warn: /* @__PURE__ */ __name((message) => write("warn", message), "warn"),
    error: /* @__PURE__ */ __name((message) => write("error", message), "error")
  };
}
__name(createWeComLogger, "createWeComLogger");
function extractBody(payload) {
  const raw = asRecord(payload);
  if (!raw)
    return void 0;
  return getRecord(raw, "body") ?? raw;
}
__name(extractBody, "extractBody");
function getLogMessageId(payload) {
  const body = extractBody(payload);
  if (!body)
    return "(unknown id)";
  return sanitizeLogText(getString(body, "msgid") || "(no id)", 100);
}
__name(getLogMessageId, "getLogMessageId");
function extractText(body) {
  const msgType = getString(body, "msgtype");
  if (msgType === "mixed") {
    const mixed = getRecord(body, "mixed");
    const items = getArray(mixed, "msg_item");
    return items.map((item) => {
      const record = asRecord(item);
      if (!record)
        return "";
      const itemType = getString(record, "msgtype");
      if (itemType === "text") {
        return getString(getRecord(record, "text"), "content");
      }
      if (itemType === "voice") {
        return getString(getRecord(record, "voice"), "content");
      }
      return "";
    }).filter(Boolean).join("\n").trim();
  }
  const text = getString(getRecord(body, "text"), "content");
  const voiceText = getString(getRecord(body, "voice"), "content");
  if (text)
    return text;
  if (voiceText)
    return voiceText;
  if (msgType === "image")
    return "(image)";
  if (msgType === "voice")
    return "(voice)";
  if (msgType === "video")
    return "(video)";
  if (msgType === "file") {
    const name = sanitizeFileName(getString(getRecord(body, "file"), "filename"));
    return `(file: ${name || "file"})`;
  }
  return "";
}
__name(extractText, "extractText");
function extractQuoteText(quote) {
  if (!quote)
    return void 0;
  return extractText(quote) || void 0;
}
__name(extractQuoteText, "extractQuoteText");
function isSyntheticMediaText(body, text) {
  const msgType = getString(body, "msgtype");
  if (msgType === "image" || msgType === "video" || msgType === "file") {
    return true;
  }
  if (msgType === "voice") {
    return !getString(getRecord(body, "voice"), "content");
  }
  return msgType === "mixed" && text.length === 0;
}
__name(isSyntheticMediaText, "isSyntheticMediaText");
function collectInboundMediaRefs(body, depth = 0, seenUrls = /* @__PURE__ */ new Set()) {
  if (depth > 3)
    return [];
  const refs = [];
  const add = /* @__PURE__ */ __name((type, source) => {
    const url = getString(source, "url");
    if (!url || seenUrls.has(url))
      return;
    seenUrls.add(url);
    refs.push({
      type,
      url,
      aesKey: getString(source, "aeskey") || void 0,
      fileName: getString(source, "filename") || getString(source, "file_name") || void 0
    });
  }, "add");
  const mixed = getRecord(body, "mixed");
  for (const item of getArray(mixed, "msg_item")) {
    const record = asRecord(item);
    if (!record)
      continue;
    const itemType = getString(record, "msgtype");
    if (isWeComMediaType(itemType)) {
      add(itemType, getRecord(record, itemType) ?? {});
    }
  }
  add("image", getRecord(body, "image") ?? {});
  add("file", getRecord(body, "file") ?? {});
  add("video", getRecord(body, "video") ?? {});
  add("voice", getRecord(body, "voice") ?? {});
  const quote = getRecord(body, "quote");
  if (quote)
    refs.push(...collectInboundMediaRefs(quote, depth + 1, seenUrls));
  return refs;
}
__name(collectInboundMediaRefs, "collectInboundMediaRefs");
function parseOutboundMediaMarkers(text) {
  const codeRanges = findCodeRanges(text);
  const markerRe = /\[(IMAGE):\s*([^\]]+)\]/gi;
  const media = [];
  const rangesToRemove = [];
  for (const match of text.matchAll(markerRe)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (codeRanges.some(([from, to]) => start >= from && start < to))
      continue;
    const path = match[2]?.trim();
    const rawType = match[1]?.toLowerCase();
    if (!path || !isWeComMediaType(rawType))
      continue;
    media.push({ type: rawType, path });
    rangesToRemove.push([start, end]);
  }
  let cleanedText = text;
  for (const [start, end] of rangesToRemove.toReversed()) {
    cleanedText = `${cleanedText.slice(0, start)}${cleanedText.slice(end)}`;
  }
  return {
    cleanedText: cleanedText.replace(/\n{3,}/g, "\n\n").trim(),
    media
  };
}
__name(parseOutboundMediaMarkers, "parseOutboundMediaMarkers");
function findCodeRanges(text) {
  const ranges = [];
  let fenceStart;
  let fenceToken;
  for (const match of text.matchAll(/```|~~~/g)) {
    const start = match.index ?? 0;
    const token = match[0];
    if (fenceStart === void 0) {
      fenceStart = start;
      fenceToken = token;
    } else if (token === fenceToken) {
      ranges.push([fenceStart, start + 3]);
      fenceStart = void 0;
      fenceToken = void 0;
    }
  }
  if (fenceStart !== void 0) {
    ranges.push([fenceStart, text.length]);
  }
  for (const match of text.matchAll(/(`+)[^`\n]*\1/g)) {
    const start = match.index ?? 0;
    if (ranges.some(([from, to]) => start >= from && start < to))
      continue;
    ranges.push([start, start + match[0].length]);
  }
  const lineRe = /^(?: {4,}|\t).*$/gm;
  for (const match of text.matchAll(lineRe)) {
    const start = match.index ?? 0;
    if (ranges.some(([from, to]) => start >= from && start < to))
      continue;
    ranges.push([start, start + match[0].length]);
  }
  return ranges;
}
__name(findCodeRanges, "findCodeRanges");
function isWeComMediaType(value) {
  return value === "image" || value === "file" || value === "voice" || value === "video";
}
__name(isWeComMediaType, "isWeComMediaType");
function splitMarkdownChunks(text, prefix) {
  if (!text)
    return [];
  const contentLimit = MARKDOWN_CHUNK_BYTES - Buffer2.byteLength(prefix ?? "");
  if (contentLimit <= 0) {
    throw new Error("WeCom source label exceeds the markdown message limit.");
  }
  const chunks = [];
  let current = "";
  let codeFence;
  const fits = /* @__PURE__ */ __name((value, nextCodeFence = codeFence) => Buffer2.byteLength(nextCodeFence ? `${value}
${nextCodeFence}` : value, "utf8") <= contentLimit, "fits");
  const flush = /* @__PURE__ */ __name((closeCode = true) => {
    if (!current)
      return;
    chunks.push(closeCode && codeFence ? `${current}
${codeFence}` : current);
    current = closeCode && codeFence ? codeFence : "";
  }, "flush");
  for (const line of text.split("\n")) {
    const candidate = current ? `${current}
${line}` : line;
    const candidateCodeFence = toggleCodeFenceState(line, codeFence);
    if (fits(candidate, candidateCodeFence)) {
      current = candidate;
      codeFence = candidateCodeFence;
      continue;
    }
    flush();
    const retried = current ? `${current}
${line}` : line;
    const retriedCodeFence = toggleCodeFenceState(line, codeFence);
    if (fits(retried, retriedCodeFence)) {
      current = retried;
      codeFence = retriedCodeFence;
      continue;
    }
    let needsLineBreak = Boolean(current);
    for (let index = 0; index < line.length; ) {
      const codePoint = line.codePointAt(index);
      const token = line.startsWith("```", index) ? "```" : line.startsWith("~~~", index) ? "~~~" : codePoint === void 0 ? "" : String.fromCodePoint(codePoint);
      if (!token)
        break;
      const nextCodeFence = token === codeFence ? void 0 : !codeFence && isFenceToken(token) ? token : codeFence;
      const addition = needsLineBreak && current ? `
${token}` : token;
      const candidate2 = `${current}${addition}`;
      if (!fits(candidate2, nextCodeFence)) {
        flush();
        current = current ? `${current}
${token}` : token;
      } else {
        current = candidate2;
      }
      codeFence = nextCodeFence;
      needsLineBreak = false;
      index += token.length;
    }
  }
  flush();
  return prefix ? chunks.map((chunk) => `${prefix}${chunk}`) : chunks;
}
__name(splitMarkdownChunks, "splitMarkdownChunks");
function escapeWeComMarkdown(value) {
  return value.replace(/([\\`*_{}[\]()#+\-.!|>])/gu, "\\$1");
}
__name(escapeWeComMarkdown, "escapeWeComMarkdown");
function toggleCodeFenceState(line, codeFence) {
  let nextCodeFence = codeFence;
  for (const match of line.matchAll(/```|~~~/g)) {
    const token = match[0];
    if (nextCodeFence === token) {
      nextCodeFence = void 0;
    } else if (!nextCodeFence) {
      nextCodeFence = token;
    }
  }
  return nextCodeFence;
}
__name(toggleCodeFenceState, "toggleCodeFenceState");
function isFenceToken(token) {
  return token === "```" || token === "~~~";
}
__name(isFenceToken, "isFenceToken");
async function readOutboundMedia(rawPath, cwd) {
  const resolved = resolve(cwd, rawPath);
  const real = realpathSync(resolved);
  const allowedDirs = [
    ensureDirectoryRealpath(join(tmpdir(), "channel-files"))
  ];
  if (!allowedDirs.some((dir) => isInsideDir(real, dir))) {
    throw new Error("Media path outside allowed outbound directory");
  }
  const file = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile())
      throw new Error(`Not a regular file: ${basename(rawPath)}`);
    if (stat.size > MAX_MEDIA_BYTES) {
      throw new Error(`Media file too large: ${stat.size} bytes`);
    }
    return { data: await file.readFile(), fileName: basename(real) };
  } finally {
    await file.close();
  }
}
__name(readOutboundMedia, "readOutboundMedia");
function ensureDirectoryRealpath(path) {
  try {
    mkdirSync(path, { recursive: true });
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("not a safe directory");
    }
    return realpathSync(path);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot prepare outbound media directory ${path}: ${reason}`);
  }
}
__name(ensureDirectoryRealpath, "ensureDirectoryRealpath");
function isInsideDir(filePath, dir) {
  const windowsStyle = /^[a-zA-Z]:[\\/]/.test(filePath);
  const pathImpl = windowsStyle ? win32 : posix;
  const relative = pathImpl.relative(dir, filePath);
  return relative === "" || !relative.startsWith("..") && !pathImpl.isAbsolute(relative);
}
__name(isInsideDir, "isInsideDir");
async function isSafeInboundMediaUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { safe: false, reason: "invalid URL" };
  }
  if (url.protocol !== "https:") {
    return { safe: false, reason: "non-HTTPS protocol" };
  }
  if (url.username || url.password) {
    return { safe: false, reason: "URL contains embedded credentials" };
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost")) {
    return { safe: false, reason: "local hostname" };
  }
  if (host.endsWith(".local")) {
    return { safe: false, reason: "local hostname" };
  }
  if (isIP(host)) {
    return isPublicIpAddress(host) ? { safe: true } : { safe: false, reason: `private address ${host}` };
  }
  if (!host.includes("."))
    return { safe: false, reason: "bare hostname" };
  try {
    const records = await lookup(host, { all: true });
    if (records.length === 0) {
      return { safe: false, reason: "no DNS records" };
    }
    const privateRecord = records.find((record) => !isPublicIpAddress(record.address));
    return privateRecord ? {
      safe: false,
      reason: `${host} resolved to private address ${privateRecord.address}`
    } : { safe: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { safe: false, reason: `DNS lookup failed for ${host}: ${message}` };
  }
}
__name(isSafeInboundMediaUrl, "isSafeInboundMediaUrl");
async function downloadInboundMedia(ref) {
  const urlSafety = await isSafeInboundMediaUrl(ref.url);
  if (!urlSafety.safe) {
    throw new Error(`unsafe media URL (${urlSafety.reason})`);
  }
  const downloaded = await guardedHttpsDownload(ref.url);
  return {
    buffer: ref.aesKey ? (0, import_aibot_node_sdk.decryptFile)(downloaded.buffer, ref.aesKey) : downloaded.buffer,
    ...ref.fileName || downloaded.filename ? { filename: ref.fileName || downloaded.filename } : {}
  };
}
__name(downloadInboundMedia, "downloadInboundMedia");
function guardedHttpsDownload(rawUrl) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const cleanup = {};
    const finish = /* @__PURE__ */ __name((err, value) => {
      if (settled)
        return;
      settled = true;
      if (cleanup.absoluteTimeout)
        clearTimeout(cleanup.absoluteTimeout);
      if (err) {
        rejectPromise(err);
      } else {
        resolvePromise(value ?? { buffer: Buffer2.alloc(0) });
      }
    }, "finish");
    const req = httpsRequest(rawUrl, {
      method: "GET",
      lookup: safePublicLookup
    }, (res) => {
      const statusCode = res.statusCode ?? 0;
      if (statusCode >= 300 && statusCode < 400) {
        req.destroy();
        finish(new Error("redirected media URL"));
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        req.destroy();
        finish(new Error(`media download failed: HTTP ${statusCode}`));
        return;
      }
      const contentLength = getHeaderNumber(res.headers, "content-length");
      if (contentLength !== void 0 && contentLength > MAX_MEDIA_BYTES) {
        req.destroy();
        finish(new Error(`oversized attachment (${contentLength} bytes)`));
        return;
      }
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => {
        const buffer = Buffer2.isBuffer(chunk) ? chunk : Buffer2.from(chunk);
        total += buffer.byteLength;
        if (total > MAX_MEDIA_BYTES) {
          req.destroy();
          finish(new Error("oversized attachment"));
          return;
        }
        chunks.push(buffer);
      });
      res.on("end", () => {
        const buffer = Buffer2.concat(chunks);
        if (buffer.byteLength === 0) {
          finish(new Error("empty media response"));
          return;
        }
        finish(void 0, {
          buffer,
          ...parseContentDispositionFileName(res.headers)
        });
      });
      res.on("error", (err) => {
        req.destroy();
        finish(err);
      });
    });
    req.setTimeout(1e4, () => {
      req.destroy();
      finish(new Error("media download timed out"));
    });
    cleanup.absoluteTimeout = setTimeout(() => {
      req.destroy();
      finish(new Error("media download absolute timeout"));
    }, 6e4);
    cleanup.absoluteTimeout.unref?.();
    req.on("error", (err) => finish(err));
    req.end();
  });
}
__name(guardedHttpsDownload, "guardedHttpsDownload");
var safePublicLookup = /* @__PURE__ */ __name((hostname, options, callback) => {
  lookup(hostname, { all: true }).then((records) => {
    const unsafeRecord = records.find((record2) => !isPublicIpAddress(record2.address));
    if (records.length === 0 || unsafeRecord) {
      const reason = records.length === 0 ? `no DNS records for ${hostname}` : `${hostname} resolved to private address ${unsafeRecord.address}`;
      callback(new Error(`unsafe resolved media address: ${reason}`), "", 0);
      return;
    }
    if (options.all) {
      callback(null, records);
      return;
    }
    const record = records[0];
    callback(null, record.address, record.family);
  }).catch((err) => callback(err instanceof Error ? err : new Error(String(err)), "", 0));
}, "safePublicLookup");
function getHeaderNumber(headers, name) {
  const value = getHeaderValue(headers, name);
  if (value === void 0)
    return void 0;
  const size = Number(value);
  return Number.isFinite(size) && size >= 0 ? size : void 0;
}
__name(getHeaderNumber, "getHeaderNumber");
function getHeaderValue(headers, name) {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value))
    return value[0];
  return value;
}
__name(getHeaderValue, "getHeaderValue");
function parseContentDispositionFileName(headers) {
  const value = getHeaderValue(headers, "content-disposition");
  if (!value)
    return {};
  const encoded = value.match(/filename\*=UTF-8''([^;\s]+)/i)?.[1];
  if (encoded) {
    try {
      return { filename: decodeURIComponent(encoded) };
    } catch {
      return { filename: encoded };
    }
  }
  const plain = value.match(/filename="?([^";]+)"?/i)?.[1];
  return plain ? { filename: plain } : {};
}
__name(parseContentDispositionFileName, "parseContentDispositionFileName");
function isPublicIpAddress(address) {
  const host = address.toLowerCase().replace(/^\[|\]$/g, "");
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    const parts = parseIpv4Parts(host);
    return parts ? isPublicIpv4(parts) : false;
  }
  if (ipVersion === 6) {
    const embedded = parseEmbeddedIpv4(host);
    if (embedded)
      return isPublicIpv4(embedded);
    const groups = expandIpv6Groups(host);
    if (!groups)
      return false;
    const first = groups[0] ?? 0;
    const isAllZeros = groups.every((group) => group === 0);
    const isLoopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
    const lowZeroEmbeddedIpv4 = hexGroupsToIpv4(groups[6], groups[7]);
    const hasLowZeroPrivateIpv4 = groups.slice(0, 5).every((group) => group === 0) && lowZeroEmbeddedIpv4 !== void 0 && (groups[6] !== 0 || groups[7] !== 0) && !isPublicIpv4(lowZeroEmbeddedIpv4);
    return !(isAllZeros || isLoopback || hasLowZeroPrivateIpv4 || first >= 64512 && first <= 65023 || first >= 65280 && first <= 65535 || first === 256 && groups.slice(1, 4).every((g) => g === 0) || first === 8193 && groups[1] === 2 || first === 8193 && groups[1] === 3512 || first === 8193 && (groups[1] & 65520) === 16 || first === 8193 && (groups[1] & 65520) === 48 || isIpv6LinkLocalGroup(first));
  }
  return false;
}
__name(isPublicIpAddress, "isPublicIpAddress");
function isIpv6LinkLocalGroup(firstGroup) {
  return firstGroup >= 65152 && firstGroup <= 65279;
}
__name(isIpv6LinkLocalGroup, "isIpv6LinkLocalGroup");
function parseIpv4Parts(host) {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return void 0;
  }
  const nums = parts.map((part) => {
    if (!/^(0|[1-9]\d{0,2})$/u.test(part))
      return NaN;
    const n = Number(part);
    return n >= 0 && n <= 255 ? n : NaN;
  });
  if (nums.some((part) => Number.isNaN(part))) {
    return void 0;
  }
  return nums;
}
__name(parseIpv4Parts, "parseIpv4Parts");
function parseMappedIpv4(host) {
  if (!host.startsWith("::ffff:"))
    return void 0;
  const suffix = host.slice("::ffff:".length);
  if (suffix.includes(".")) {
    return parseIpv4Parts(suffix);
  }
  const groups = suffix.split(":");
  if (groups.length !== 2)
    return void 0;
  const high = parseHexGroup(groups[0]);
  const low = parseHexGroup(groups[1]);
  if (high === void 0 || low === void 0)
    return void 0;
  return [high >> 8, high & 255, low >> 8, low & 255];
}
__name(parseMappedIpv4, "parseMappedIpv4");
function parseEmbeddedIpv4(host) {
  const mapped = parseMappedIpv4(host);
  if (mapped)
    return mapped;
  const groups = expandIpv6Groups(host);
  if (!groups)
    return void 0;
  if (groups.slice(0, 4).every((group) => group === 0) && groups[4] === 65535 && groups[5] === 0 && (groups[6] !== 0 || groups[7] !== 0)) {
    return hexGroupsToIpv4(groups[6], groups[7]);
  }
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 65535 && (groups[6] !== 0 || groups[7] !== 0)) {
    return hexGroupsToIpv4(groups[6], groups[7]);
  }
  if (groups.slice(0, 6).every((group) => group === 0) && (groups[6] !== 0 || groups[7] !== 0)) {
    return hexGroupsToIpv4(groups[6], groups[7]);
  }
  if (groups[0] === 8194) {
    return hexGroupsToIpv4(groups[1], groups[2]);
  }
  if (groups[0] === 8193 && groups[1] === 0) {
    return hexGroupsToIpv4(groups[6] ^ 65535, groups[7] ^ 65535);
  }
  if (groups[0] === 100 && groups[1] === 65435) {
    return hexGroupsToIpv4(groups[6], groups[7]);
  }
  return void 0;
}
__name(parseEmbeddedIpv4, "parseEmbeddedIpv4");
function expandIpv6Groups(host) {
  const normalized = normalizeIpv6DottedSuffix(host);
  if (!normalized)
    return void 0;
  const parts = normalized.split("::");
  if (parts.length > 2)
    return void 0;
  const left = parseIpv6GroupList(parts[0]);
  const right = parseIpv6GroupList(parts[1]);
  if (!left || !right)
    return void 0;
  if (parts.length === 1) {
    return left.length === 8 ? left : void 0;
  }
  const fill = 8 - left.length - right.length;
  if (fill < 1)
    return void 0;
  return [...left, ...Array(fill).fill(0), ...right];
}
__name(expandIpv6Groups, "expandIpv6Groups");
function normalizeIpv6DottedSuffix(host) {
  if (!host.includes("."))
    return host;
  const lastColon = host.lastIndexOf(":");
  if (lastColon === -1)
    return void 0;
  const ipv4 = parseIpv4Parts(host.slice(lastColon + 1));
  if (!ipv4)
    return void 0;
  const high = ipv4[0] << 8 | ipv4[1];
  const low = ipv4[2] << 8 | ipv4[3];
  return `${host.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
}
__name(normalizeIpv6DottedSuffix, "normalizeIpv6DottedSuffix");
function parseIpv6GroupList(value) {
  if (!value)
    return [];
  const groups = [];
  for (const group of value.split(":")) {
    const parsed = parseHexGroup(group);
    if (parsed === void 0)
      return void 0;
    groups.push(parsed);
  }
  return groups;
}
__name(parseIpv6GroupList, "parseIpv6GroupList");
function hexGroupsToIpv4(high, low) {
  if (high === void 0 || low === void 0)
    return void 0;
  return [high >> 8, high & 255, low >> 8, low & 255];
}
__name(hexGroupsToIpv4, "hexGroupsToIpv4");
function parseHexGroup(value) {
  if (!value || !/^[\da-f]{1,4}$/i.test(value))
    return void 0;
  const parsed = Number.parseInt(value, 16);
  return parsed >= 0 && parsed <= 65535 ? parsed : void 0;
}
__name(parseHexGroup, "parseHexGroup");
function isPublicIpv4(parts) {
  const [a = 0, b = 0, c = 0] = parts;
  return !(a === 0 || a === 10 || a === 127 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 0 && (c === 0 || c === 2) || a === 192 && b === 88 && c === 99 || a === 192 && b === 168 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113 || a >= 224);
}
__name(isPublicIpv4, "isPublicIpv4");
function extractMediaId(value) {
  const record = asRecord(value);
  return getString(record, "media_id") || getString(record, "mediaId") || getString(getRecord(record, "body"), "media_id") || void 0;
}
__name(extractMediaId, "extractMediaId");
function detectImageMime(data) {
  if (data[0] === 137 && data[1] === 80 && data[2] === 78 && data[3] === 71) {
    return "image/png";
  }
  if (data[0] === 71 && data[1] === 73 && data[2] === 70) {
    return "image/gif";
  }
  if (data[0] === 82 && data[1] === 73 && data[2] === 70 && data[3] === 70 && data[8] === 87 && data[9] === 69 && data[10] === 66 && data[11] === 80) {
    return "image/webp";
  }
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) {
    return "image/jpeg";
  }
  return "application/octet-stream";
}
__name(detectImageMime, "detectImageMime");
function mediaTypeToMime(type) {
  switch (type) {
    case "video":
      return "video/mp4";
    case "voice":
      return "audio/amr";
    default:
      return "application/octet-stream";
  }
}
__name(mediaTypeToMime, "mediaTypeToMime");
function sanitizeFileName(name) {
  const base = basename(name || "").replace(/\0/g, "");
  return base.replace(/[^\p{L}\p{N}._-]/gu, "_").replace(/^\.+/, "_");
}
__name(sanitizeFileName, "sanitizeFileName");
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
__name(asRecord, "asRecord");
function getRecord(value, key) {
  return asRecord(value?.[key]);
}
__name(getRecord, "getRecord");
function getArray(value, key) {
  const raw = value?.[key];
  return Array.isArray(raw) ? raw : [];
}
__name(getArray, "getArray");
function getString(value, key) {
  const raw = value?.[key];
  return typeof raw === "string" ? raw : "";
}
__name(getString, "getString");

// packages/channels/wecom/dist/index.js
var plugin = {
  channelType: "wecom",
  displayName: "WeCom",
  requiredConfigFields: ["botId", "secret"],
  envResolvableConfigFields: ["wsUrl"],
  management: {
    fields: [
      {
        key: "botId",
        label: "Bot ID",
        kind: "string",
        required: true,
        envResolvable: true
      },
      {
        key: "secret",
        label: "Bot Secret",
        kind: "secret",
        required: true,
        envResolvable: true
      },
      {
        key: "wsUrl",
        label: "WebSocket URL",
        kind: "string",
        envResolvable: true
      }
    ]
  },
  createChannel: /* @__PURE__ */ __name((name, config, bridge, options) => new WeComChannel(name, config, bridge, options), "createChannel")
};
export {
  WeComChannel,
  plugin
};
