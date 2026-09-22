// Force strict mode and setup for ESM
"use strict";
import {
  require_lib
} from "./chunk-ZL4HFSL6.js";
import "./chunk-OSHQMOBS.js";
import {
  PollingChannelBase
} from "./chunk-PZRXWQUA.js";
import "./chunk-IJOS26LH.js";
import {
  external_exports
} from "./chunk-CQ35AJ4Z.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __commonJS,
  __export,
  __name,
  __require,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// node_modules/xcase/es5/index.js
var require_es5 = __commonJS({
  "node_modules/xcase/es5/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", {
      value: true
    });
    var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function(obj) {
      return typeof obj;
    } : function(obj) {
      return obj && typeof Symbol === "function" && obj.constructor === Symbol ? "symbol" : typeof obj;
    };
    function isLower(char) {
      return char >= 97 && char <= 122;
    }
    __name(isLower, "isLower");
    function isUpper(char) {
      return char >= 65 && char <= 90;
    }
    __name(isUpper, "isUpper");
    function isDigit(char) {
      return char >= 48 && char <= 57;
    }
    __name(isDigit, "isDigit");
    function toUpper(char) {
      return char - 32;
    }
    __name(toUpper, "toUpper");
    function toUpperSafe(char) {
      if (isLower(char)) {
        return char - 32;
      }
      return char;
    }
    __name(toUpperSafe, "toUpperSafe");
    function toLower(char) {
      return char + 32;
    }
    __name(toLower, "toLower");
    function camelize$1(str, separator) {
      var firstChar = str.charCodeAt(0);
      if (isDigit(firstChar) || isUpper(firstChar) || firstChar == separator) {
        return str;
      }
      var out = [];
      var changed = false;
      if (isUpper(firstChar)) {
        changed = true;
        out.push(toLower(firstChar));
      } else {
        out.push(firstChar);
      }
      var length = str.length;
      for (var i = 1; i < length; ++i) {
        var c = str.charCodeAt(i);
        if (c === separator) {
          changed = true;
          c = str.charCodeAt(++i);
          if (isNaN(c)) {
            return str;
          }
          out.push(toUpperSafe(c));
        } else {
          out.push(c);
        }
      }
      return changed ? String.fromCharCode.apply(void 0, out) : str;
    }
    __name(camelize$1, "camelize$1");
    function decamelize$1(str, separator) {
      var firstChar = str.charCodeAt(0);
      if (!isLower(firstChar)) {
        return str;
      }
      var length = str.length;
      var changed = false;
      var out = [];
      for (var i = 0; i < length; ++i) {
        var c = str.charCodeAt(i);
        if (isUpper(c)) {
          out.push(separator);
          out.push(toLower(c));
          changed = true;
        } else {
          out.push(c);
        }
      }
      return changed ? String.fromCharCode.apply(void 0, out) : str;
    }
    __name(decamelize$1, "decamelize$1");
    function pascalize$1(str, separator) {
      var firstChar = str.charCodeAt(0);
      if (isDigit(firstChar) || firstChar == separator) {
        return str;
      }
      var length = str.length;
      var changed = false;
      var out = [];
      for (var i = 0; i < length; ++i) {
        var c = str.charCodeAt(i);
        if (c === separator) {
          changed = true;
          c = str.charCodeAt(++i);
          if (isNaN(c)) {
            return str;
          }
          out.push(toUpperSafe(c));
        } else if (i === 0 && isLower(c)) {
          changed = true;
          out.push(toUpper(c));
        } else {
          out.push(c);
        }
      }
      return changed ? String.fromCharCode.apply(void 0, out) : str;
    }
    __name(pascalize$1, "pascalize$1");
    function depascalize$1(str, separator) {
      var firstChar = str.charCodeAt(0);
      if (!isUpper(firstChar)) {
        return str;
      }
      var length = str.length;
      var changed = false;
      var out = [];
      for (var i = 0; i < length; ++i) {
        var c = str.charCodeAt(i);
        if (isUpper(c)) {
          if (i > 0) {
            out.push(separator);
          }
          out.push(toLower(c));
          changed = true;
        } else {
          out.push(c);
        }
      }
      return changed ? String.fromCharCode.apply(void 0, out) : str;
    }
    __name(depascalize$1, "depascalize$1");
    function shouldProcessValue(value) {
      return value && (typeof value === "undefined" ? "undefined" : _typeof(value)) == "object" && !(value instanceof Date) && !(value instanceof Function);
    }
    __name(shouldProcessValue, "shouldProcessValue");
    function processKeys(obj, fun, opts) {
      var obj2 = void 0;
      if (obj instanceof Array) {
        obj2 = [];
      } else {
        if (typeof obj.prototype !== "undefined") {
          return obj;
        }
        obj2 = {};
      }
      for (var key in obj) {
        var value = obj[key];
        if (typeof key === "string") key = fun(key, opts && opts.separator);
        if (shouldProcessValue(value)) {
          obj2[key] = processKeys(value, fun, opts);
        } else {
          obj2[key] = value;
        }
      }
      return obj2;
    }
    __name(processKeys, "processKeys");
    function processKeysInPlace(obj, fun, opts) {
      var keys = Object.keys(obj);
      for (var idx = 0; idx < keys.length; ++idx) {
        var key = keys[idx];
        var value = obj[key];
        var newKey = fun(key, opts && opts.separator);
        if (newKey !== key) {
          delete obj[key];
        }
        if (shouldProcessValue(value)) {
          obj[newKey] = processKeys(value, fun, opts);
        } else {
          obj[newKey] = value;
        }
      }
      return obj;
    }
    __name(processKeysInPlace, "processKeysInPlace");
    function camelize$$1(str, separator) {
      return camelize$1(
        str,
        separator && separator.charCodeAt(0) || 95
        /* _ */
      );
    }
    __name(camelize$$1, "camelize$$1");
    function decamelize$$1(str, separator) {
      return decamelize$1(
        str,
        separator && separator.charCodeAt(0) || 95
        /* _ */
      );
    }
    __name(decamelize$$1, "decamelize$$1");
    function pascalize$$1(str, separator) {
      return pascalize$1(
        str,
        separator && separator.charCodeAt(0) || 95
        /* _ */
      );
    }
    __name(pascalize$$1, "pascalize$$1");
    function depascalize$$1(str, separator) {
      return depascalize$1(
        str,
        separator && separator.charCodeAt(0) || 95
        /* _ */
      );
    }
    __name(depascalize$$1, "depascalize$$1");
    function camelizeKeys2(obj, opts) {
      opts = opts || {};
      if (!shouldProcessValue(obj)) return obj;
      if (opts.inPlace) return processKeysInPlace(obj, camelize$$1, opts);
      return processKeys(obj, camelize$$1, opts);
    }
    __name(camelizeKeys2, "camelizeKeys");
    function decamelizeKeys3(obj, opts) {
      opts = opts || {};
      if (!shouldProcessValue(obj)) return obj;
      if (opts.inPlace) return processKeysInPlace(obj, decamelize$$1, opts);
      return processKeys(obj, decamelize$$1, opts);
    }
    __name(decamelizeKeys3, "decamelizeKeys");
    function pascalizeKeys(obj, opts) {
      opts = opts || {};
      if (!shouldProcessValue(obj)) return obj;
      if (opts.inPlace) return processKeysInPlace(obj, pascalize$$1, opts);
      return processKeys(obj, pascalize$$1, opts);
    }
    __name(pascalizeKeys, "pascalizeKeys");
    function depascalizeKeys(obj, opts) {
      opts = opts || {};
      if (!shouldProcessValue(obj)) return obj;
      if (opts.inPlace) return processKeysInPlace(obj, depascalize$$1, opts);
      return processKeys(obj, depascalize$$1, opts);
    }
    __name(depascalizeKeys, "depascalizeKeys");
    exports.camelize = camelize$$1;
    exports.decamelize = decamelize$$1;
    exports.pascalize = pascalize$$1;
    exports.depascalize = depascalize$$1;
    exports.camelizeKeys = camelizeKeys2;
    exports.decamelizeKeys = decamelizeKeys3;
    exports.pascalizeKeys = pascalizeKeys;
    exports.depascalizeKeys = depascalizeKeys;
  }
});

// node_modules/rate-limiter-flexible/lib/RateLimiterAbstract.js
var require_RateLimiterAbstract = __commonJS({
  "node_modules/rate-limiter-flexible/lib/RateLimiterAbstract.js"(exports, module) {
    init_esbuild_shims();
    module.exports = class RateLimiterAbstract {
      static {
        __name(this, "RateLimiterAbstract");
      }
      /**
       *
       * @param opts Object Defaults {
       *   points: 4, // Number of points
       *   duration: 1, // Per seconds
       *   blockDuration: 0, // Block if consumed more than points in current duration for blockDuration seconds
       *   execEvenly: false, // Execute allowed actions evenly over duration
       *   execEvenlyMinDelayMs: duration * 1000 / points, // ms, works with execEvenly=true option
       *   keyPrefix: 'rlflx',
       * }
       */
      constructor(opts = {}) {
        this.points = opts.points;
        this.duration = opts.duration;
        this.blockDuration = opts.blockDuration;
        this.execEvenly = opts.execEvenly;
        this.execEvenlyMinDelayMs = opts.execEvenlyMinDelayMs;
        this.keyPrefix = opts.keyPrefix;
      }
      get points() {
        return this._points;
      }
      set points(value) {
        this._points = value >= 0 ? value : 4;
      }
      get duration() {
        return this._duration;
      }
      set duration(value) {
        this._duration = typeof value === "undefined" ? 1 : value;
      }
      get msDuration() {
        return this.duration * 1e3;
      }
      get blockDuration() {
        return this._blockDuration;
      }
      set blockDuration(value) {
        this._blockDuration = typeof value === "undefined" ? 0 : value;
      }
      get msBlockDuration() {
        return this.blockDuration * 1e3;
      }
      get execEvenly() {
        return this._execEvenly;
      }
      set execEvenly(value) {
        this._execEvenly = typeof value === "undefined" ? false : Boolean(value);
      }
      get execEvenlyMinDelayMs() {
        return this._execEvenlyMinDelayMs;
      }
      set execEvenlyMinDelayMs(value) {
        this._execEvenlyMinDelayMs = typeof value === "undefined" ? Math.ceil(this.msDuration / this.points) : value;
      }
      get keyPrefix() {
        return this._keyPrefix;
      }
      set keyPrefix(value) {
        if (typeof value === "undefined") {
          value = "rlflx";
        }
        if (typeof value !== "string") {
          throw new Error("keyPrefix must be string");
        }
        this._keyPrefix = value;
      }
      _getKeySecDuration(options = {}) {
        return options && options.customDuration >= 0 ? options.customDuration : this.duration;
      }
      getKey(key) {
        return this.keyPrefix.length > 0 ? `${this.keyPrefix}:${key}` : key;
      }
      parseKey(rlKey) {
        return rlKey.substring(this.keyPrefix.length);
      }
      consume() {
        throw new Error("You have to implement the method 'consume'!");
      }
      penalty() {
        throw new Error("You have to implement the method 'penalty'!");
      }
      reward() {
        throw new Error("You have to implement the method 'reward'!");
      }
      get() {
        throw new Error("You have to implement the method 'get'!");
      }
      set() {
        throw new Error("You have to implement the method 'set'!");
      }
      block() {
        throw new Error("You have to implement the method 'block'!");
      }
      delete() {
        throw new Error("You have to implement the method 'delete'!");
      }
    };
  }
});

// node_modules/rate-limiter-flexible/lib/component/BlockedKeys/BlockedKeys.js
var require_BlockedKeys = __commonJS({
  "node_modules/rate-limiter-flexible/lib/component/BlockedKeys/BlockedKeys.js"(exports, module) {
    init_esbuild_shims();
    module.exports = class BlockedKeys {
      static {
        __name(this, "BlockedKeys");
      }
      constructor() {
        this._keys = {};
        this._addedKeysAmount = 0;
      }
      collectExpired() {
        const now = Date.now();
        Object.keys(this._keys).forEach((key) => {
          if (this._keys[key] <= now) {
            delete this._keys[key];
          }
        });
        this._addedKeysAmount = Object.keys(this._keys).length;
      }
      /**
       * Add new blocked key
       *
       * @param key String
       * @param sec Number
       */
      add(key, sec) {
        this.addMs(key, sec * 1e3);
      }
      /**
       * Add new blocked key for ms
       *
       * @param key String
       * @param ms Number
       */
      addMs(key, ms) {
        this._keys[key] = Date.now() + ms;
        this._addedKeysAmount++;
        if (this._addedKeysAmount > 999) {
          this.collectExpired();
        }
      }
      /**
       * 0 means not blocked
       *
       * @param key
       * @returns {number}
       */
      msBeforeExpire(key) {
        const expire = this._keys[key];
        if (expire && expire >= Date.now()) {
          this.collectExpired();
          const now = Date.now();
          return expire >= now ? expire - now : 0;
        }
        return 0;
      }
      /**
       * If key is not given, delete all data in memory
       * 
       * @param {string|undefined} key
       */
      delete(key) {
        if (key) {
          delete this._keys[key];
        } else {
          Object.keys(this._keys).forEach((key2) => {
            delete this._keys[key2];
          });
        }
      }
    };
  }
});

// node_modules/rate-limiter-flexible/lib/component/BlockedKeys/index.js
var require_BlockedKeys2 = __commonJS({
  "node_modules/rate-limiter-flexible/lib/component/BlockedKeys/index.js"(exports, module) {
    init_esbuild_shims();
    var BlockedKeys = require_BlockedKeys();
    module.exports = BlockedKeys;
  }
});

// node_modules/rate-limiter-flexible/lib/RateLimiterRes.js
var require_RateLimiterRes = __commonJS({
  "node_modules/rate-limiter-flexible/lib/RateLimiterRes.js"(exports, module) {
    init_esbuild_shims();
    module.exports = class RateLimiterRes {
      static {
        __name(this, "RateLimiterRes");
      }
      constructor(remainingPoints, msBeforeNext, consumedPoints, isFirstInDuration) {
        this.remainingPoints = typeof remainingPoints === "undefined" ? 0 : remainingPoints;
        this.msBeforeNext = typeof msBeforeNext === "undefined" ? 0 : msBeforeNext;
        this.consumedPoints = typeof consumedPoints === "undefined" ? 0 : consumedPoints;
        this.isFirstInDuration = typeof isFirstInDuration === "undefined" ? false : isFirstInDuration;
      }
      get msBeforeNext() {
        return this._msBeforeNext;
      }
      set msBeforeNext(ms) {
        this._msBeforeNext = ms;
        return this;
      }
      get remainingPoints() {
        return this._remainingPoints;
      }
      set remainingPoints(p) {
        this._remainingPoints = p;
        return this;
      }
      get consumedPoints() {
        return this._consumedPoints;
      }
      set consumedPoints(p) {
        this._consumedPoints = p;
        return this;
      }
      get isFirstInDuration() {
        return this._isFirstInDuration;
      }
      set isFirstInDuration(value) {
        this._isFirstInDuration = Boolean(value);
      }
      _getDecoratedProperties() {
        return {
          remainingPoints: this.remainingPoints,
          msBeforeNext: this.msBeforeNext,
          consumedPoints: this.consumedPoints,
          isFirstInDuration: this.isFirstInDuration
        };
      }
      [Symbol.for("nodejs.util.inspect.custom")]() {
        return this._getDecoratedProperties();
      }
      toString() {
        return JSON.stringify(this._getDecoratedProperties());
      }
      toJSON() {
        return this._getDecoratedProperties();
      }
    };
  }
});

// node_modules/rate-limiter-flexible/lib/RateLimiterStoreAbstract.js
var require_RateLimiterStoreAbstract = __commonJS({
  "node_modules/rate-limiter-flexible/lib/RateLimiterStoreAbstract.js"(exports, module) {
    init_esbuild_shims();
    var RateLimiterAbstract = require_RateLimiterAbstract();
    var BlockedKeys = require_BlockedKeys2();
    var RateLimiterRes = require_RateLimiterRes();
    module.exports = class RateLimiterStoreAbstract extends RateLimiterAbstract {
      static {
        __name(this, "RateLimiterStoreAbstract");
      }
      /**
       *
       * @param opts Object Defaults {
       *   ... see other in RateLimiterAbstract
       *
       *   inMemoryBlockOnConsumed: 40, // Number of points when key is blocked
       *   inMemoryBlockDuration: 10, // Block duration in seconds
       *   insuranceLimiter: RateLimiterAbstract
       * }
       */
      constructor(opts = {}) {
        super(opts);
        this.inMemoryBlockOnConsumed = opts.inMemoryBlockOnConsumed;
        this.inMemoryBlockDuration = opts.inMemoryBlockDuration;
        this.insuranceLimiter = opts.insuranceLimiter;
        this._inMemoryBlockedKeys = new BlockedKeys();
      }
      get client() {
        return this._client;
      }
      set client(value) {
        if (typeof value === "undefined") {
          throw new Error("storeClient is not set");
        }
        this._client = value;
      }
      /**
       * Have to be launched after consume
       * It blocks key and execute evenly depending on result from store
       *
       * It uses _getRateLimiterRes function to prepare RateLimiterRes from store result
       *
       * @param resolve
       * @param reject
       * @param rlKey
       * @param changedPoints
       * @param storeResult
       * @param {Object} options
       * @private
       */
      _afterConsume(resolve, reject, rlKey, changedPoints, storeResult, options = {}) {
        const res = this._getRateLimiterRes(rlKey, changedPoints, storeResult);
        if (this.inMemoryBlockOnConsumed > 0 && !(this.inMemoryBlockDuration > 0) && res.consumedPoints >= this.inMemoryBlockOnConsumed) {
          this._inMemoryBlockedKeys.addMs(rlKey, res.msBeforeNext);
          if (res.consumedPoints > this.points) {
            return reject(res);
          } else {
            return resolve(res);
          }
        } else if (res.consumedPoints > this.points) {
          let blockPromise = Promise.resolve();
          if (this.blockDuration > 0 && res.consumedPoints <= this.points + changedPoints) {
            res.msBeforeNext = this.msBlockDuration;
            blockPromise = this._block(rlKey, res.consumedPoints, this.msBlockDuration, options);
          }
          if (this.inMemoryBlockOnConsumed > 0 && res.consumedPoints >= this.inMemoryBlockOnConsumed) {
            this._inMemoryBlockedKeys.add(rlKey, this.inMemoryBlockDuration);
            res.msBeforeNext = this.msInMemoryBlockDuration;
          }
          blockPromise.then(() => {
            reject(res);
          }).catch((err) => {
            reject(err);
          });
        } else if (this.execEvenly && res.msBeforeNext > 0 && !res.isFirstInDuration) {
          let delay2 = Math.ceil(res.msBeforeNext / (res.remainingPoints + 2));
          if (delay2 < this.execEvenlyMinDelayMs) {
            delay2 = res.consumedPoints * this.execEvenlyMinDelayMs;
          }
          setTimeout(resolve, delay2, res);
        } else {
          resolve(res);
        }
      }
      _handleError(err, funcName, resolve, reject, key, data = false, options = {}) {
        if (!(this.insuranceLimiter instanceof RateLimiterAbstract)) {
          reject(err);
        } else {
          this.insuranceLimiter[funcName](key, data, options).then((res) => {
            resolve(res);
          }).catch((res) => {
            reject(res);
          });
        }
      }
      getInMemoryBlockMsBeforeExpire(rlKey) {
        if (this.inMemoryBlockOnConsumed > 0) {
          return this._inMemoryBlockedKeys.msBeforeExpire(rlKey);
        }
        return 0;
      }
      get inMemoryBlockOnConsumed() {
        return this._inMemoryBlockOnConsumed;
      }
      set inMemoryBlockOnConsumed(value) {
        this._inMemoryBlockOnConsumed = value ? parseInt(value) : 0;
        if (this.inMemoryBlockOnConsumed > 0 && this.points > this.inMemoryBlockOnConsumed) {
          throw new Error('inMemoryBlockOnConsumed option must be greater or equal "points" option');
        }
      }
      get inMemoryBlockDuration() {
        return this._inMemoryBlockDuration;
      }
      set inMemoryBlockDuration(value) {
        this._inMemoryBlockDuration = value ? parseInt(value) : 0;
        if (this.inMemoryBlockDuration > 0 && this.inMemoryBlockOnConsumed === 0) {
          throw new Error("inMemoryBlockOnConsumed option must be set up");
        }
      }
      get msInMemoryBlockDuration() {
        return this._inMemoryBlockDuration * 1e3;
      }
      get insuranceLimiter() {
        return this._insuranceLimiter;
      }
      set insuranceLimiter(value) {
        if (typeof value !== "undefined" && !(value instanceof RateLimiterAbstract)) {
          throw new Error("insuranceLimiter must be instance of RateLimiterAbstract");
        }
        this._insuranceLimiter = value;
        if (this._insuranceLimiter) {
          this._insuranceLimiter.blockDuration = this.blockDuration;
          this._insuranceLimiter.execEvenly = this.execEvenly;
        }
      }
      /**
       * Block any key for secDuration seconds
       *
       * @param key
       * @param secDuration
       * @param {Object} options
       *
       * @return Promise<RateLimiterRes>
       */
      block(key, secDuration, options = {}) {
        const msDuration = secDuration * 1e3;
        return this._block(this.getKey(key), this.points + 1, msDuration, options);
      }
      /**
       * Set points by key for any duration
       *
       * @param key
       * @param points
       * @param secDuration
       * @param {Object} options
       *
       * @return Promise<RateLimiterRes>
       */
      set(key, points, secDuration, options = {}) {
        const msDuration = (secDuration >= 0 ? secDuration : this.duration) * 1e3;
        return this._block(this.getKey(key), points, msDuration, options);
      }
      /**
       *
       * @param key
       * @param pointsToConsume
       * @param {Object} options
       * @returns Promise<RateLimiterRes>
       */
      consume(key, pointsToConsume = 1, options = {}) {
        return new Promise((resolve, reject) => {
          const rlKey = this.getKey(key);
          const inMemoryBlockMsBeforeExpire = this.getInMemoryBlockMsBeforeExpire(rlKey);
          if (inMemoryBlockMsBeforeExpire > 0) {
            return reject(new RateLimiterRes(0, inMemoryBlockMsBeforeExpire));
          }
          this._upsert(rlKey, pointsToConsume, this._getKeySecDuration(options) * 1e3, false, options).then((res) => {
            this._afterConsume(resolve, reject, rlKey, pointsToConsume, res);
          }).catch((err) => {
            this._handleError(err, "consume", resolve, reject, key, pointsToConsume, options);
          });
        });
      }
      /**
       *
       * @param key
       * @param points
       * @param {Object} options
       * @returns Promise<RateLimiterRes>
       */
      penalty(key, points = 1, options = {}) {
        const rlKey = this.getKey(key);
        return new Promise((resolve, reject) => {
          this._upsert(rlKey, points, this._getKeySecDuration(options) * 1e3, false, options).then((res) => {
            resolve(this._getRateLimiterRes(rlKey, points, res));
          }).catch((err) => {
            this._handleError(err, "penalty", resolve, reject, key, points, options);
          });
        });
      }
      /**
       *
       * @param key
       * @param points
       * @param {Object} options
       * @returns Promise<RateLimiterRes>
       */
      reward(key, points = 1, options = {}) {
        const rlKey = this.getKey(key);
        return new Promise((resolve, reject) => {
          this._upsert(rlKey, -points, this._getKeySecDuration(options) * 1e3, false, options).then((res) => {
            resolve(this._getRateLimiterRes(rlKey, -points, res));
          }).catch((err) => {
            this._handleError(err, "reward", resolve, reject, key, points, options);
          });
        });
      }
      /**
       *
       * @param key
       * @param {Object} options
       * @returns Promise<RateLimiterRes>|null
       */
      get(key, options = {}) {
        const rlKey = this.getKey(key);
        return new Promise((resolve, reject) => {
          this._get(rlKey, options).then((res) => {
            if (res === null || typeof res === "undefined") {
              resolve(null);
            } else {
              resolve(this._getRateLimiterRes(rlKey, 0, res));
            }
          }).catch((err) => {
            this._handleError(err, "get", resolve, reject, key, options);
          });
        });
      }
      /**
       *
       * @param key
       * @param {Object} options
       * @returns Promise<boolean>
       */
      delete(key, options = {}) {
        const rlKey = this.getKey(key);
        return new Promise((resolve, reject) => {
          this._delete(rlKey, options).then((res) => {
            this._inMemoryBlockedKeys.delete(rlKey);
            resolve(res);
          }).catch((err) => {
            this._handleError(err, "delete", resolve, reject, key, options);
          });
        });
      }
      /**
       * Cleanup keys no-matter expired or not.
       */
      deleteInMemoryBlockedAll() {
        this._inMemoryBlockedKeys.delete();
      }
      /**
       * Get RateLimiterRes object filled depending on storeResult, which specific for exact store
       *
       * @param rlKey
       * @param changedPoints
       * @param storeResult
       * @private
       */
      _getRateLimiterRes(rlKey, changedPoints, storeResult) {
        throw new Error("You have to implement the method '_getRateLimiterRes'!");
      }
      /**
       * Block key for this.msBlockDuration milliseconds
       * Usually, it just prolongs lifetime of key
       *
       * @param rlKey
       * @param initPoints
       * @param msDuration
       * @param {Object} options
       *
       * @return Promise<any>
       */
      _block(rlKey, initPoints, msDuration, options = {}) {
        return new Promise((resolve, reject) => {
          this._upsert(rlKey, initPoints, msDuration, true, options).then(() => {
            resolve(new RateLimiterRes(0, msDuration > 0 ? msDuration : -1, initPoints));
          }).catch((err) => {
            this._handleError(err, "block", resolve, reject, this.parseKey(rlKey), msDuration / 1e3, options);
          });
        });
      }
      /**
       * Have to be implemented in every limiter
       * Resolve with raw result from Store OR null if rlKey is not set
       * or Reject with error
       *
       * @param rlKey
       * @param {Object} options
       * @private
       *
       * @return Promise<any>
       */
      _get(rlKey, options = {}) {
        throw new Error("You have to implement the method '_get'!");
      }
      /**
       * Have to be implemented
       * Resolve with true OR false if rlKey doesn't exist
       * or Reject with error
       *
       * @param rlKey
       * @param {Object} options
       * @private
       *
       * @return Promise<any>
       */
      _delete(rlKey, options = {}) {
        throw new Error("You have to implement the method '_delete'!");
      }
      /**
       * Have to be implemented
       * Resolve with object used for {@link _getRateLimiterRes} to generate {@link RateLimiterRes}
       *
       * @param {string} rlKey
       * @param {number} points
       * @param {number} msDuration
       * @param {boolean} forceExpire
       * @param {Object} options
       * @abstract
       *
       * @return Promise<Object>
       */
      _upsert(rlKey, points, msDuration, forceExpire = false, options = {}) {
        throw new Error("You have to implement the method '_upsert'!");
      }
    };
  }
});

// node_modules/rate-limiter-flexible/lib/RateLimiterRedis.js
var require_RateLimiterRedis = __commonJS({
  "node_modules/rate-limiter-flexible/lib/RateLimiterRedis.js"(exports, module) {
    init_esbuild_shims();
    var RateLimiterStoreAbstract = require_RateLimiterStoreAbstract();
    var RateLimiterRes = require_RateLimiterRes();
    var incrTtlLuaScript = `redis.call('set', KEYS[1], 0, 'EX', ARGV[2], 'NX') local consumed = redis.call('incrby', KEYS[1], ARGV[1]) local ttl = redis.call('pttl', KEYS[1]) if ttl == -1 then   redis.call('expire', KEYS[1], ARGV[2])   ttl = 1000 * ARGV[2] end return {consumed, ttl} `;
    var RateLimiterRedis = class extends RateLimiterStoreAbstract {
      static {
        __name(this, "RateLimiterRedis");
      }
      /**
       *
       * @param {Object} opts
       * Defaults {
       *   ... see other in RateLimiterStoreAbstract
       *
       *   redis: RedisClient
       *   rejectIfRedisNotReady: boolean = false - reject / invoke insuranceLimiter immediately when redis connection is not "ready"
       * }
       */
      constructor(opts) {
        super(opts);
        this.client = opts.storeClient;
        this._rejectIfRedisNotReady = !!opts.rejectIfRedisNotReady;
        this.useRedisPackage = opts.useRedisPackage || this.client.constructor.name === "Commander" || false;
        this.useRedis3AndLowerPackage = opts.useRedis3AndLowerPackage;
        if (typeof this.client.defineCommand === "function") {
          this.client.defineCommand("rlflxIncr", {
            numberOfKeys: 1,
            lua: incrTtlLuaScript
          });
        }
      }
      /**
       * Prevent actual redis call if redis connection is not ready
       * Because of different connection state checks for ioredis and node-redis, only this clients would be actually checked.
       * For any other clients all the requests would be passed directly to redis client
       * @return {boolean}
       * @private
       */
      _isRedisReady() {
        if (!this._rejectIfRedisNotReady) {
          return true;
        }
        if (this.client.status && this.client.status !== "ready") {
          return false;
        }
        if (typeof this.client.isReady === "function" && !this.client.isReady()) {
          return false;
        }
        return true;
      }
      _getRateLimiterRes(rlKey, changedPoints, result) {
        let [consumed, resTtlMs] = result;
        if (Array.isArray(consumed)) {
          [, consumed] = consumed;
          [, resTtlMs] = resTtlMs;
        }
        const res = new RateLimiterRes();
        res.consumedPoints = parseInt(consumed);
        res.isFirstInDuration = res.consumedPoints === changedPoints;
        res.remainingPoints = Math.max(this.points - res.consumedPoints, 0);
        res.msBeforeNext = resTtlMs;
        return res;
      }
      async _upsert(rlKey, points, msDuration, forceExpire = false) {
        if (!this._isRedisReady()) {
          throw new Error("Redis connection is not ready");
        }
        const secDuration = Math.floor(msDuration / 1e3);
        const multi = this.client.multi();
        if (forceExpire) {
          if (secDuration > 0) {
            if (!this.useRedisPackage && !this.useRedis3AndLowerPackage) {
              multi.set(rlKey, points, "EX", secDuration);
            } else {
              multi.set(rlKey, points, { EX: secDuration });
            }
          } else {
            multi.set(rlKey, points);
          }
          if (!this.useRedisPackage && !this.useRedis3AndLowerPackage) {
            return multi.pttl(rlKey).exec(true);
          }
          return multi.pTTL(rlKey).exec(true);
        }
        if (secDuration > 0) {
          if (!this.useRedisPackage && !this.useRedis3AndLowerPackage) {
            return this.client.rlflxIncr(
              [rlKey].concat([String(points), String(secDuration)])
            );
          }
          if (this.useRedis3AndLowerPackage) {
            return new Promise((resolve, reject) => {
              const incrCallback = /* @__PURE__ */ __name(function(err, result) {
                if (err) {
                  return reject(err);
                }
                return resolve(result);
              }, "incrCallback");
              if (typeof this.client.rlflxIncr === "function") {
                this.client.rlflxIncr(rlKey, points, secDuration, incrCallback);
              } else {
                this.client.eval(incrTtlLuaScript, 1, rlKey, points, secDuration, incrCallback);
              }
            });
          } else {
            return this.client.eval(incrTtlLuaScript, {
              keys: [rlKey],
              arguments: [String(points), String(secDuration)]
            });
          }
        } else {
          if (!this.useRedisPackage && !this.useRedis3AndLowerPackage) {
            return multi.incrby(rlKey, points).pttl(rlKey).exec(true);
          }
          return multi.incrBy(rlKey, points).pTTL(rlKey).exec(true);
        }
      }
      async _get(rlKey) {
        if (!this._isRedisReady()) {
          throw new Error("Redis connection is not ready");
        }
        if (!this.useRedisPackage && !this.useRedis3AndLowerPackage) {
          return this.client.multi().get(rlKey).pttl(rlKey).exec().then((result) => {
            const [[, points]] = result;
            if (points === null) return null;
            return result;
          });
        }
        return this.client.multi().get(rlKey).pTTL(rlKey).exec(true).then((result) => {
          const [points] = result;
          if (points === null) return null;
          return result;
        });
      }
      _delete(rlKey) {
        return this.client.del(rlKey).then((result) => result > 0);
      }
    };
    module.exports = RateLimiterRedis;
  }
});

// node_modules/rate-limiter-flexible/lib/RateLimiterMongo.js
var require_RateLimiterMongo = __commonJS({
  "node_modules/rate-limiter-flexible/lib/RateLimiterMongo.js"(exports, module) {
    init_esbuild_shims();
    var RateLimiterStoreAbstract = require_RateLimiterStoreAbstract();
    var RateLimiterRes = require_RateLimiterRes();
    function getDriverVersion(client) {
      try {
        const _client = client.client ? client.client : client;
        let _v = [0, 0, 0];
        if (typeof _client.topology === "undefined") {
          const { version } = _client.options.metadata.driver;
          _v = version.split("|", 1)[0].split(".").map((v) => parseInt(v));
        } else {
          const { version } = _client.topology.s.options.metadata.driver;
          _v = version.split(".").map((v) => parseInt(v));
        }
        return {
          major: _v[0],
          feature: _v[1],
          patch: _v[2]
        };
      } catch (err) {
        return { major: 0, feature: 0, patch: 0 };
      }
    }
    __name(getDriverVersion, "getDriverVersion");
    var RateLimiterMongo = class _RateLimiterMongo extends RateLimiterStoreAbstract {
      static {
        __name(this, "RateLimiterMongo");
      }
      /**
       *
       * @param {Object} opts
       * Defaults {
       *   indexKeyPrefix: {attr1: 1, attr2: 1}
       *   ... see other in RateLimiterStoreAbstract
       *
       *   mongo: MongoClient
       * }
       */
      constructor(opts) {
        super(opts);
        this.dbName = opts.dbName;
        this.tableName = opts.tableName;
        this.indexKeyPrefix = opts.indexKeyPrefix;
        if (opts.mongo) {
          this.client = opts.mongo;
        } else {
          this.client = opts.storeClient;
        }
        if (typeof this.client.then === "function") {
          this.client.then((conn) => {
            this.client = conn;
            this._initCollection();
            this._driverVersion = getDriverVersion(this.client);
          });
        } else {
          this._initCollection();
          this._driverVersion = getDriverVersion(this.client);
        }
      }
      get dbName() {
        return this._dbName;
      }
      set dbName(value) {
        this._dbName = typeof value === "undefined" ? _RateLimiterMongo.getDbName() : value;
      }
      static getDbName() {
        return "node-rate-limiter-flexible";
      }
      get tableName() {
        return this._tableName;
      }
      set tableName(value) {
        this._tableName = typeof value === "undefined" ? this.keyPrefix : value;
      }
      get client() {
        return this._client;
      }
      set client(value) {
        if (typeof value === "undefined") {
          throw new Error("mongo is not set");
        }
        this._client = value;
      }
      get indexKeyPrefix() {
        return this._indexKeyPrefix;
      }
      set indexKeyPrefix(obj) {
        this._indexKeyPrefix = obj || {};
      }
      _initCollection() {
        const db = typeof this.client.db === "function" ? this.client.db(this.dbName) : this.client;
        const collection = db.collection(this.tableName);
        collection.createIndex({ expire: -1 }, { expireAfterSeconds: 0 });
        collection.createIndex(Object.assign({}, this.indexKeyPrefix, { key: 1 }), { unique: true });
        this._collection = collection;
      }
      _getRateLimiterRes(rlKey, changedPoints, result) {
        const res = new RateLimiterRes();
        let doc;
        if (typeof result.value === "undefined") {
          doc = result;
        } else {
          doc = result.value;
        }
        res.isFirstInDuration = doc.points === changedPoints;
        res.consumedPoints = doc.points;
        res.remainingPoints = Math.max(this.points - res.consumedPoints, 0);
        res.msBeforeNext = doc.expire !== null ? Math.max(new Date(doc.expire).getTime() - Date.now(), 0) : -1;
        return res;
      }
      _upsert(key, points, msDuration, forceExpire = false, options = {}) {
        if (!this._collection) {
          return Promise.reject(Error("Mongo connection is not established"));
        }
        const docAttrs = options.attrs || {};
        let where;
        let upsertData;
        if (forceExpire) {
          where = { key };
          where = Object.assign(where, docAttrs);
          upsertData = {
            $set: {
              key,
              points,
              expire: msDuration > 0 ? new Date(Date.now() + msDuration) : null
            }
          };
          upsertData.$set = Object.assign(upsertData.$set, docAttrs);
        } else {
          where = {
            $or: [
              { expire: { $gt: /* @__PURE__ */ new Date() } },
              { expire: { $eq: null } }
            ],
            key
          };
          where = Object.assign(where, docAttrs);
          upsertData = {
            $setOnInsert: {
              key,
              expire: msDuration > 0 ? new Date(Date.now() + msDuration) : null
            },
            $inc: { points }
          };
          upsertData.$setOnInsert = Object.assign(upsertData.$setOnInsert, docAttrs);
        }
        const upsertOptions = {
          upsert: true
        };
        if (this._driverVersion.major >= 4 || (this._driverVersion.major === 3 && this._driverVersion.feature >= 7 || this._driverVersion.feature >= 6 && this._driverVersion.patch >= 7)) {
          upsertOptions.returnDocument = "after";
        } else {
          upsertOptions.returnOriginal = false;
        }
        return new Promise((resolve, reject) => {
          this._collection.findOneAndUpdate(
            where,
            upsertData,
            upsertOptions
          ).then((res) => {
            resolve(res);
          }).catch((errUpsert) => {
            if (errUpsert && errUpsert.code === 11e3) {
              const replaceWhere = Object.assign({
                // try to replace OLD limit doc
                $or: [
                  { expire: { $lte: /* @__PURE__ */ new Date() } },
                  { expire: { $eq: null } }
                ],
                key
              }, docAttrs);
              const replaceTo = {
                $set: Object.assign({
                  key,
                  points,
                  expire: msDuration > 0 ? new Date(Date.now() + msDuration) : null
                }, docAttrs)
              };
              this._collection.findOneAndUpdate(
                replaceWhere,
                replaceTo,
                upsertOptions
              ).then((res) => {
                resolve(res);
              }).catch((errReplace) => {
                if (errReplace && errReplace.code === 11e3) {
                  this._upsert(key, points, msDuration, forceExpire).then((res) => resolve(res)).catch((err) => reject(err));
                } else {
                  reject(errReplace);
                }
              });
            } else {
              reject(errUpsert);
            }
          });
        });
      }
      _get(rlKey, options = {}) {
        if (!this._collection) {
          return Promise.reject(Error("Mongo connection is not established"));
        }
        const docAttrs = options.attrs || {};
        const where = Object.assign({
          key: rlKey,
          $or: [
            { expire: { $gt: /* @__PURE__ */ new Date() } },
            { expire: { $eq: null } }
          ]
        }, docAttrs);
        return this._collection.findOne(where);
      }
      _delete(rlKey, options = {}) {
        if (!this._collection) {
          return Promise.reject(Error("Mongo connection is not established"));
        }
        const docAttrs = options.attrs || {};
        const where = Object.assign({ key: rlKey }, docAttrs);
        return this._collection.deleteOne(where).then((res) => res.deletedCount > 0);
      }
    };
    module.exports = RateLimiterMongo;
  }
});

// node_modules/rate-limiter-flexible/lib/RateLimiterMySQL.js
var require_RateLimiterMySQL = __commonJS({
  "node_modules/rate-limiter-flexible/lib/RateLimiterMySQL.js"(exports, module) {
    init_esbuild_shims();
    var RateLimiterStoreAbstract = require_RateLimiterStoreAbstract();
    var RateLimiterRes = require_RateLimiterRes();
    var RateLimiterMySQL = class extends RateLimiterStoreAbstract {
      static {
        __name(this, "RateLimiterMySQL");
      }
      /**
       * @callback callback
       * @param {Object} err
       *
       * @param {Object} opts
       * @param {callback} cb
       * Defaults {
       *   ... see other in RateLimiterStoreAbstract
       *
       *   storeClient: anySqlClient,
       *   storeType: 'knex', // required only for Knex instance
       *   dbName: 'string',
       *   tableName: 'string',
       * }
       */
      constructor(opts, cb = null) {
        super(opts);
        this.client = opts.storeClient;
        this.clientType = opts.storeType;
        this.dbName = opts.dbName;
        this.tableName = opts.tableName;
        this.clearExpiredByTimeout = opts.clearExpiredByTimeout;
        this.tableCreated = opts.tableCreated;
        if (!this.tableCreated) {
          this._createDbAndTable().then(() => {
            this.tableCreated = true;
            if (this.clearExpiredByTimeout) {
              this._clearExpiredHourAgo();
            }
            if (typeof cb === "function") {
              cb();
            }
          }).catch((err) => {
            if (typeof cb === "function") {
              cb(err);
            } else {
              throw err;
            }
          });
        } else {
          if (this.clearExpiredByTimeout) {
            this._clearExpiredHourAgo();
          }
          if (typeof cb === "function") {
            cb();
          }
        }
      }
      clearExpired(expire) {
        return new Promise((resolve) => {
          this._getConnection().then((conn) => {
            conn.query(`DELETE FROM ??.?? WHERE expire < ?`, [this.dbName, this.tableName, expire], () => {
              this._releaseConnection(conn);
              resolve();
            });
          }).catch(() => {
            resolve();
          });
        });
      }
      _clearExpiredHourAgo() {
        if (this._clearExpiredTimeoutId) {
          clearTimeout(this._clearExpiredTimeoutId);
        }
        this._clearExpiredTimeoutId = setTimeout(() => {
          this.clearExpired(Date.now() - 36e5).then(() => {
            this._clearExpiredHourAgo();
          });
        }, 3e5);
        this._clearExpiredTimeoutId.unref();
      }
      /**
       *
       * @return Promise<any>
       * @private
       */
      _getConnection() {
        switch (this.clientType) {
          case "pool":
            return new Promise((resolve, reject) => {
              this.client.getConnection((errConn, conn) => {
                if (errConn) {
                  return reject(errConn);
                }
                resolve(conn);
              });
            });
          case "sequelize":
            return this.client.connectionManager.getConnection();
          case "knex":
            return this.client.client.acquireConnection();
          default:
            return Promise.resolve(this.client);
        }
      }
      _releaseConnection(conn) {
        switch (this.clientType) {
          case "pool":
            return conn.release();
          case "sequelize":
            return this.client.connectionManager.releaseConnection(conn);
          case "knex":
            return this.client.client.releaseConnection(conn);
          default:
            return true;
        }
      }
      /**
       *
       * @returns {Promise<any>}
       * @private
       */
      _createDbAndTable() {
        return new Promise((resolve, reject) => {
          this._getConnection().then((conn) => {
            conn.query(`CREATE DATABASE IF NOT EXISTS \`${this.dbName}\`;`, (errDb) => {
              if (errDb) {
                this._releaseConnection(conn);
                return reject(errDb);
              }
              conn.query(this._getCreateTableStmt(), (err) => {
                if (err) {
                  this._releaseConnection(conn);
                  return reject(err);
                }
                this._releaseConnection(conn);
                resolve();
              });
            });
          }).catch((err) => {
            reject(err);
          });
        });
      }
      _getCreateTableStmt() {
        return `CREATE TABLE IF NOT EXISTS \`${this.dbName}\`.\`${this.tableName}\` (\`key\` VARCHAR(255) CHARACTER SET utf8 NOT NULL,\`points\` INT(9) NOT NULL default 0,\`expire\` BIGINT UNSIGNED,PRIMARY KEY (\`key\`)) ENGINE = INNODB;`;
      }
      get clientType() {
        return this._clientType;
      }
      set clientType(value) {
        if (typeof value === "undefined") {
          if (this.client.constructor.name === "Connection") {
            value = "connection";
          } else if (this.client.constructor.name === "Pool") {
            value = "pool";
          } else if (this.client.constructor.name === "Sequelize") {
            value = "sequelize";
          } else {
            throw new Error("storeType is not defined");
          }
        }
        this._clientType = value.toLowerCase();
      }
      get dbName() {
        return this._dbName;
      }
      set dbName(value) {
        this._dbName = typeof value === "undefined" ? "rtlmtrflx" : value;
      }
      get tableName() {
        return this._tableName;
      }
      set tableName(value) {
        this._tableName = typeof value === "undefined" ? this.keyPrefix : value;
      }
      get tableCreated() {
        return this._tableCreated;
      }
      set tableCreated(value) {
        this._tableCreated = typeof value === "undefined" ? false : !!value;
      }
      get clearExpiredByTimeout() {
        return this._clearExpiredByTimeout;
      }
      set clearExpiredByTimeout(value) {
        this._clearExpiredByTimeout = typeof value === "undefined" ? true : Boolean(value);
      }
      _getRateLimiterRes(rlKey, changedPoints, result) {
        const res = new RateLimiterRes();
        const [row] = result;
        res.isFirstInDuration = changedPoints === row.points;
        res.consumedPoints = res.isFirstInDuration ? changedPoints : row.points;
        res.remainingPoints = Math.max(this.points - res.consumedPoints, 0);
        res.msBeforeNext = row.expire ? Math.max(row.expire - Date.now(), 0) : -1;
        return res;
      }
      _upsertTransaction(conn, key, points, msDuration, forceExpire) {
        return new Promise((resolve, reject) => {
          conn.query("BEGIN", (errBegin) => {
            if (errBegin) {
              conn.rollback();
              return reject(errBegin);
            }
            const dateNow = Date.now();
            const newExpire = msDuration > 0 ? dateNow + msDuration : null;
            let q;
            let values;
            if (forceExpire) {
              q = `INSERT INTO ??.?? VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE 
            points = ?, 
            expire = ?;`;
              values = [
                this.dbName,
                this.tableName,
                key,
                points,
                newExpire,
                points,
                newExpire
              ];
            } else {
              q = `INSERT INTO ??.?? VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE 
            points = IF(expire <= ?, ?, points + (?)), 
            expire = IF(expire <= ?, ?, expire);`;
              values = [
                this.dbName,
                this.tableName,
                key,
                points,
                newExpire,
                dateNow,
                points,
                points,
                dateNow,
                newExpire
              ];
            }
            conn.query(q, values, (errUpsert) => {
              if (errUpsert) {
                conn.rollback();
                return reject(errUpsert);
              }
              conn.query("SELECT points, expire FROM ??.?? WHERE `key` = ?;", [this.dbName, this.tableName, key], (errSelect, res) => {
                if (errSelect) {
                  conn.rollback();
                  return reject(errSelect);
                }
                conn.query("COMMIT", (err) => {
                  if (err) {
                    conn.rollback();
                    return reject(err);
                  }
                  resolve(res);
                });
              });
            });
          });
        });
      }
      _upsert(key, points, msDuration, forceExpire = false) {
        if (!this.tableCreated) {
          return Promise.reject(Error("Table is not created yet"));
        }
        return new Promise((resolve, reject) => {
          this._getConnection().then((conn) => {
            this._upsertTransaction(conn, key, points, msDuration, forceExpire).then((res) => {
              resolve(res);
              this._releaseConnection(conn);
            }).catch((err) => {
              reject(err);
              this._releaseConnection(conn);
            });
          }).catch((err) => {
            reject(err);
          });
        });
      }
      _get(rlKey) {
        if (!this.tableCreated) {
          return Promise.reject(Error("Table is not created yet"));
        }
        return new Promise((resolve, reject) => {
          this._getConnection().then((conn) => {
            conn.query(
              "SELECT points, expire FROM ??.?? WHERE `key` = ? AND (`expire` > ? OR `expire` IS NULL)",
              [this.dbName, this.tableName, rlKey, Date.now()],
              (err, res) => {
                if (err) {
                  reject(err);
                } else if (res.length === 0) {
                  resolve(null);
                } else {
                  resolve(res);
                }
                this._releaseConnection(conn);
              }
              // eslint-disable-line
            );
          }).catch((err) => {
            reject(err);
          });
        });
      }
      _delete(rlKey) {
        if (!this.tableCreated) {
          return Promise.reject(Error("Table is not created yet"));
        }
        return new Promise((resolve, reject) => {
          this._getConnection().then((conn) => {
            conn.query(
              "DELETE FROM ??.?? WHERE `key` = ?",
              [this.dbName, this.tableName, rlKey],
              (err, res) => {
                if (err) {
                  reject(err);
                } else {
                  resolve(res.affectedRows > 0);
                }
                this._releaseConnection(conn);
              }
              // eslint-disable-line
            );
          }).catch((err) => {
            reject(err);
          });
        });
      }
    };
    module.exports = RateLimiterMySQL;
  }
});

// node_modules/rate-limiter-flexible/lib/RateLimiterPostgres.js
var require_RateLimiterPostgres = __commonJS({
  "node_modules/rate-limiter-flexible/lib/RateLimiterPostgres.js"(exports, module) {
    init_esbuild_shims();
    var RateLimiterStoreAbstract = require_RateLimiterStoreAbstract();
    var RateLimiterRes = require_RateLimiterRes();
    var RateLimiterPostgres = class extends RateLimiterStoreAbstract {
      static {
        __name(this, "RateLimiterPostgres");
      }
      /**
       * @callback callback
       * @param {Object} err
       *
       * @param {Object} opts
       * @param {callback} cb
       * Defaults {
       *   ... see other in RateLimiterStoreAbstract
       *
       *   storeClient: postgresClient,
       *   storeType: 'knex', // required only for Knex instance
       *   tableName: 'string',
       *   schemaName: 'string', // optional
       * }
       */
      constructor(opts, cb = null) {
        super(opts);
        this.client = opts.storeClient;
        this.clientType = opts.storeType;
        this.tableName = opts.tableName;
        this.schemaName = opts.schemaName;
        this.clearExpiredByTimeout = opts.clearExpiredByTimeout;
        this.tableCreated = opts.tableCreated;
        if (!this.tableCreated) {
          this._createTable().then(() => {
            this.tableCreated = true;
            if (this.clearExpiredByTimeout) {
              this._clearExpiredHourAgo();
            }
            if (typeof cb === "function") {
              cb();
            }
          }).catch((err) => {
            if (typeof cb === "function") {
              cb(err);
            } else {
              throw err;
            }
          });
        } else {
          if (this.clearExpiredByTimeout) {
            this._clearExpiredHourAgo();
          }
          if (typeof cb === "function") {
            cb();
          }
        }
      }
      _getTableIdentifier() {
        return this.schemaName ? `"${this.schemaName}"."${this.tableName}"` : `"${this.tableName}"`;
      }
      clearExpired(expire) {
        return new Promise((resolve) => {
          const q = {
            name: "rlflx-clear-expired",
            text: `DELETE FROM ${this._getTableIdentifier()} WHERE expire < $1`,
            values: [expire]
          };
          this._query(q).then(() => {
            resolve();
          }).catch(() => {
            resolve();
          });
        });
      }
      /**
       * Delete all rows expired 1 hour ago once per 5 minutes
       *
       * @private
       */
      _clearExpiredHourAgo() {
        if (this._clearExpiredTimeoutId) {
          clearTimeout(this._clearExpiredTimeoutId);
        }
        this._clearExpiredTimeoutId = setTimeout(() => {
          this.clearExpired(Date.now() - 36e5).then(() => {
            this._clearExpiredHourAgo();
          });
        }, 3e5);
        this._clearExpiredTimeoutId.unref();
      }
      /**
       *
       * @return Promise<any>
       * @private
       */
      _getConnection() {
        switch (this.clientType) {
          case "pool":
            return Promise.resolve(this.client);
          case "sequelize":
            return this.client.connectionManager.getConnection();
          case "knex":
            return this.client.client.acquireConnection();
          case "typeorm":
            return Promise.resolve(this.client.driver.master);
          default:
            return Promise.resolve(this.client);
        }
      }
      _releaseConnection(conn) {
        switch (this.clientType) {
          case "pool":
            return true;
          case "sequelize":
            return this.client.connectionManager.releaseConnection(conn);
          case "knex":
            return this.client.client.releaseConnection(conn);
          case "typeorm":
            return true;
          default:
            return true;
        }
      }
      /**
       *
       * @returns {Promise<any>}
       * @private
       */
      _createTable() {
        return new Promise((resolve, reject) => {
          this._query({
            text: this._getCreateTableStmt()
          }).then(() => {
            resolve();
          }).catch((err) => {
            if (err.code === "23505") {
              resolve();
            } else {
              reject(err);
            }
          });
        });
      }
      _getCreateTableStmt() {
        return `CREATE TABLE IF NOT EXISTS ${this._getTableIdentifier()} (
      key varchar(255) PRIMARY KEY,
      points integer NOT NULL DEFAULT 0,
      expire bigint
    );`;
      }
      get clientType() {
        return this._clientType;
      }
      set clientType(value) {
        const constructorName = this.client.constructor.name;
        if (typeof value === "undefined") {
          if (constructorName === "Client") {
            value = "client";
          } else if (constructorName === "Pool" || constructorName === "BoundPool") {
            value = "pool";
          } else if (constructorName === "Sequelize") {
            value = "sequelize";
          } else {
            throw new Error("storeType is not defined");
          }
        }
        this._clientType = value.toLowerCase();
      }
      get tableName() {
        return this._tableName;
      }
      set tableName(value) {
        this._tableName = typeof value === "undefined" ? this.keyPrefix : value;
      }
      get schemaName() {
        return this._schemaName;
      }
      set schemaName(value) {
        this._schemaName = value;
      }
      get tableCreated() {
        return this._tableCreated;
      }
      set tableCreated(value) {
        this._tableCreated = typeof value === "undefined" ? false : !!value;
      }
      get clearExpiredByTimeout() {
        return this._clearExpiredByTimeout;
      }
      set clearExpiredByTimeout(value) {
        this._clearExpiredByTimeout = typeof value === "undefined" ? true : Boolean(value);
      }
      _getRateLimiterRes(rlKey, changedPoints, result) {
        const res = new RateLimiterRes();
        const row = result.rows[0];
        res.isFirstInDuration = changedPoints === row.points;
        res.consumedPoints = res.isFirstInDuration ? changedPoints : row.points;
        res.remainingPoints = Math.max(this.points - res.consumedPoints, 0);
        res.msBeforeNext = row.expire ? Math.max(row.expire - Date.now(), 0) : -1;
        return res;
      }
      _query(q) {
        const prefix = this.tableName.toLowerCase();
        const queryObj = { name: `${prefix}:${q.name}`, text: q.text, values: q.values };
        return new Promise((resolve, reject) => {
          this._getConnection().then((conn) => {
            conn.query(queryObj).then((res) => {
              resolve(res);
              this._releaseConnection(conn);
            }).catch((err) => {
              reject(err);
              this._releaseConnection(conn);
            });
          }).catch((err) => {
            reject(err);
          });
        });
      }
      _upsert(key, points, msDuration, forceExpire = false) {
        if (!this.tableCreated) {
          return Promise.reject(Error("Table is not created yet"));
        }
        const newExpire = msDuration > 0 ? Date.now() + msDuration : null;
        const expireQ = forceExpire ? " $3 " : ` CASE
             WHEN ${this._getTableIdentifier()}.expire <= $4 THEN $3
             ELSE ${this._getTableIdentifier()}.expire
            END `;
        return this._query({
          name: forceExpire ? "rlflx-upsert-force" : "rlflx-upsert",
          text: `
            INSERT INTO ${this._getTableIdentifier()} VALUES ($1, $2, $3)
              ON CONFLICT(key) DO UPDATE SET
                points = CASE
                          WHEN (${this._getTableIdentifier()}.expire <= $4 OR 1=${forceExpire ? 1 : 0}) THEN $2
                          ELSE ${this._getTableIdentifier()}.points + ($2)
                         END,
                expire = ${expireQ}
            RETURNING points, expire;`,
          values: [key, points, newExpire, Date.now()]
        });
      }
      _get(rlKey) {
        if (!this.tableCreated) {
          return Promise.reject(Error("Table is not created yet"));
        }
        return new Promise((resolve, reject) => {
          this._query({
            name: "rlflx-get",
            text: `
            SELECT points, expire FROM ${this._getTableIdentifier()} WHERE key = $1 AND (expire > $2 OR expire IS NULL);`,
            values: [rlKey, Date.now()]
          }).then((res) => {
            if (res.rowCount === 0) {
              res = null;
            }
            resolve(res);
          }).catch((err) => {
            reject(err);
          });
        });
      }
      _delete(rlKey) {
        if (!this.tableCreated) {
          return Promise.reject(Error("Table is not created yet"));
        }
        return this._query({
          name: "rlflx-delete",
          text: `DELETE FROM ${this._getTableIdentifier()} WHERE key = $1`,
          values: [rlKey]
        }).then((res) => res.rowCount > 0);
      }
    };
    module.exports = RateLimiterPostgres;
  }
});

// node_modules/rate-limiter-flexible/lib/component/MemoryStorage/Record.js
var require_Record = __commonJS({
  "node_modules/rate-limiter-flexible/lib/component/MemoryStorage/Record.js"(exports, module) {
    init_esbuild_shims();
    module.exports = class Record {
      static {
        __name(this, "Record");
      }
      /**
       *
       * @param value int
       * @param expiresAt Date|int
       * @param timeoutId
       */
      constructor(value, expiresAt, timeoutId = null) {
        this.value = value;
        this.expiresAt = expiresAt;
        this.timeoutId = timeoutId;
      }
      get value() {
        return this._value;
      }
      set value(value) {
        this._value = parseInt(value);
      }
      get expiresAt() {
        return this._expiresAt;
      }
      set expiresAt(value) {
        if (!(value instanceof Date) && Number.isInteger(value)) {
          value = new Date(value);
        }
        this._expiresAt = value;
      }
      get timeoutId() {
        return this._timeoutId;
      }
      set timeoutId(value) {
        this._timeoutId = value;
      }
    };
  }
});

// node_modules/rate-limiter-flexible/lib/component/MemoryStorage/MemoryStorage.js
var require_MemoryStorage = __commonJS({
  "node_modules/rate-limiter-flexible/lib/component/MemoryStorage/MemoryStorage.js"(exports, module) {
    init_esbuild_shims();
    var Record = require_Record();
    var RateLimiterRes = require_RateLimiterRes();
    module.exports = class MemoryStorage {
      static {
        __name(this, "MemoryStorage");
      }
      constructor() {
        this._storage = {};
      }
      incrby(key, value, durationSec) {
        if (this._storage[key]) {
          const msBeforeExpires = this._storage[key].expiresAt ? this._storage[key].expiresAt.getTime() - (/* @__PURE__ */ new Date()).getTime() : -1;
          if (!this._storage[key].expiresAt || msBeforeExpires > 0) {
            this._storage[key].value = this._storage[key].value + value;
            return new RateLimiterRes(0, msBeforeExpires, this._storage[key].value, false);
          }
          return this.set(key, value, durationSec);
        }
        return this.set(key, value, durationSec);
      }
      set(key, value, durationSec) {
        const durationMs = durationSec * 1e3;
        if (this._storage[key] && this._storage[key].timeoutId) {
          clearTimeout(this._storage[key].timeoutId);
        }
        this._storage[key] = new Record(
          value,
          durationMs > 0 ? new Date(Date.now() + durationMs) : null
        );
        if (durationMs > 0) {
          this._storage[key].timeoutId = setTimeout(() => {
            delete this._storage[key];
          }, durationMs);
          if (this._storage[key].timeoutId.unref) {
            this._storage[key].timeoutId.unref();
          }
        }
        return new RateLimiterRes(0, durationMs === 0 ? -1 : durationMs, this._storage[key].value, true);
      }
      /**
       *
       * @param key
       * @returns {*}
       */
      get(key) {
        if (this._storage[key]) {
          const msBeforeExpires = this._storage[key].expiresAt ? this._storage[key].expiresAt.getTime() - (/* @__PURE__ */ new Date()).getTime() : -1;
          return new RateLimiterRes(0, msBeforeExpires, this._storage[key].value, false);
        }
        return null;
      }
      /**
       *
       * @param key
       * @returns {boolean}
       */
      delete(key) {
        if (this._storage[key]) {
          if (this._storage[key].timeoutId) {
            clearTimeout(this._storage[key].timeoutId);
          }
          delete this._storage[key];
          return true;
        }
        return false;
      }
    };
  }
});

// node_modules/rate-limiter-flexible/lib/RateLimiterMemory.js
var require_RateLimiterMemory = __commonJS({
  "node_modules/rate-limiter-flexible/lib/RateLimiterMemory.js"(exports, module) {
    init_esbuild_shims();
    var RateLimiterAbstract = require_RateLimiterAbstract();
    var MemoryStorage = require_MemoryStorage();
    var RateLimiterRes = require_RateLimiterRes();
    var RateLimiterMemory2 = class extends RateLimiterAbstract {
      static {
        __name(this, "RateLimiterMemory");
      }
      constructor(opts = {}) {
        super(opts);
        this._memoryStorage = new MemoryStorage();
      }
      /**
       *
       * @param key
       * @param pointsToConsume
       * @param {Object} options
       * @returns {Promise<RateLimiterRes>}
       */
      consume(key, pointsToConsume = 1, options = {}) {
        return new Promise((resolve, reject) => {
          const rlKey = this.getKey(key);
          const secDuration = this._getKeySecDuration(options);
          let res = this._memoryStorage.incrby(rlKey, pointsToConsume, secDuration);
          res.remainingPoints = Math.max(this.points - res.consumedPoints, 0);
          if (res.consumedPoints > this.points) {
            if (this.blockDuration > 0 && res.consumedPoints <= this.points + pointsToConsume) {
              res = this._memoryStorage.set(rlKey, res.consumedPoints, this.blockDuration);
            }
            reject(res);
          } else if (this.execEvenly && res.msBeforeNext > 0 && !res.isFirstInDuration) {
            let delay2 = Math.ceil(res.msBeforeNext / (res.remainingPoints + 2));
            if (delay2 < this.execEvenlyMinDelayMs) {
              delay2 = res.consumedPoints * this.execEvenlyMinDelayMs;
            }
            setTimeout(resolve, delay2, res);
          } else {
            resolve(res);
          }
        });
      }
      penalty(key, points = 1, options = {}) {
        const rlKey = this.getKey(key);
        return new Promise((resolve) => {
          const secDuration = this._getKeySecDuration(options);
          const res = this._memoryStorage.incrby(rlKey, points, secDuration);
          res.remainingPoints = Math.max(this.points - res.consumedPoints, 0);
          resolve(res);
        });
      }
      reward(key, points = 1, options = {}) {
        const rlKey = this.getKey(key);
        return new Promise((resolve) => {
          const secDuration = this._getKeySecDuration(options);
          const res = this._memoryStorage.incrby(rlKey, -points, secDuration);
          res.remainingPoints = Math.max(this.points - res.consumedPoints, 0);
          resolve(res);
        });
      }
      /**
       * Block any key for secDuration seconds
       *
       * @param key
       * @param secDuration
       */
      block(key, secDuration) {
        const msDuration = secDuration * 1e3;
        const initPoints = this.points + 1;
        this._memoryStorage.set(this.getKey(key), initPoints, secDuration);
        return Promise.resolve(
          new RateLimiterRes(0, msDuration === 0 ? -1 : msDuration, initPoints)
        );
      }
      set(key, points, secDuration) {
        const msDuration = (secDuration >= 0 ? secDuration : this.duration) * 1e3;
        this._memoryStorage.set(this.getKey(key), points, secDuration);
        return Promise.resolve(
          new RateLimiterRes(0, msDuration === 0 ? -1 : msDuration, points)
        );
      }
      get(key) {
        const res = this._memoryStorage.get(this.getKey(key));
        if (res !== null) {
          res.remainingPoints = Math.max(this.points - res.consumedPoints, 0);
        }
        return Promise.resolve(res);
      }
      delete(key) {
        return Promise.resolve(this._memoryStorage.delete(this.getKey(key)));
      }
    };
    module.exports = RateLimiterMemory2;
  }
});

// node_modules/rate-limiter-flexible/lib/RateLimiterCluster.js
var require_RateLimiterCluster = __commonJS({
  "node_modules/rate-limiter-flexible/lib/RateLimiterCluster.js"(exports, module) {
    init_esbuild_shims();
    var cluster = __require("cluster");
    var crypto = __require("crypto");
    var RateLimiterAbstract = require_RateLimiterAbstract();
    var RateLimiterMemory2 = require_RateLimiterMemory();
    var RateLimiterRes = require_RateLimiterRes();
    var channel = "rate_limiter_flexible";
    var masterInstance = null;
    var masterSendToWorker = /* @__PURE__ */ __name(function(worker, msg, type, res) {
      let data;
      if (res === null || res === true || res === false) {
        data = res;
      } else {
        data = {
          remainingPoints: res.remainingPoints,
          msBeforeNext: res.msBeforeNext,
          consumedPoints: res.consumedPoints,
          isFirstInDuration: res.isFirstInDuration
        };
      }
      worker.send({
        channel,
        keyPrefix: msg.keyPrefix,
        // which rate limiter exactly
        promiseId: msg.promiseId,
        type,
        data
      });
    }, "masterSendToWorker");
    var workerWaitInit = /* @__PURE__ */ __name(function(payload) {
      setTimeout(() => {
        if (this._initiated) {
          process.send(payload);
        } else if (typeof this._promises[payload.promiseId] !== "undefined") {
          workerWaitInit.call(this, payload);
        }
      }, 30);
    }, "workerWaitInit");
    var workerSendToMaster = /* @__PURE__ */ __name(function(func, promiseId, key, arg, opts) {
      const payload = {
        channel,
        keyPrefix: this.keyPrefix,
        func,
        promiseId,
        data: {
          key,
          arg,
          opts
        }
      };
      if (!this._initiated) {
        workerWaitInit.call(this, payload);
      } else {
        process.send(payload);
      }
    }, "workerSendToMaster");
    var masterProcessMsg = /* @__PURE__ */ __name(function(worker, msg) {
      if (!msg || msg.channel !== channel || typeof this._rateLimiters[msg.keyPrefix] === "undefined") {
        return false;
      }
      let promise;
      switch (msg.func) {
        case "consume":
          promise = this._rateLimiters[msg.keyPrefix].consume(msg.data.key, msg.data.arg, msg.data.opts);
          break;
        case "penalty":
          promise = this._rateLimiters[msg.keyPrefix].penalty(msg.data.key, msg.data.arg, msg.data.opts);
          break;
        case "reward":
          promise = this._rateLimiters[msg.keyPrefix].reward(msg.data.key, msg.data.arg, msg.data.opts);
          break;
        case "block":
          promise = this._rateLimiters[msg.keyPrefix].block(msg.data.key, msg.data.arg, msg.data.opts);
          break;
        case "get":
          promise = this._rateLimiters[msg.keyPrefix].get(msg.data.key, msg.data.opts);
          break;
        case "delete":
          promise = this._rateLimiters[msg.keyPrefix].delete(msg.data.key, msg.data.opts);
          break;
        default:
          return false;
      }
      if (promise) {
        promise.then((res) => {
          masterSendToWorker(worker, msg, "resolve", res);
        }).catch((rejRes) => {
          masterSendToWorker(worker, msg, "reject", rejRes);
        });
      }
    }, "masterProcessMsg");
    var workerProcessMsg = /* @__PURE__ */ __name(function(msg) {
      if (!msg || msg.channel !== channel || msg.keyPrefix !== this.keyPrefix) {
        return false;
      }
      if (this._promises[msg.promiseId]) {
        clearTimeout(this._promises[msg.promiseId].timeoutId);
        let res;
        if (msg.data === null || msg.data === true || msg.data === false) {
          res = msg.data;
        } else {
          res = new RateLimiterRes(
            msg.data.remainingPoints,
            msg.data.msBeforeNext,
            msg.data.consumedPoints,
            msg.data.isFirstInDuration
            // eslint-disable-line comma-dangle
          );
        }
        switch (msg.type) {
          case "resolve":
            this._promises[msg.promiseId].resolve(res);
            break;
          case "reject":
            this._promises[msg.promiseId].reject(res);
            break;
          default:
            throw new Error(`RateLimiterCluster: no such message type '${msg.type}'`);
        }
        delete this._promises[msg.promiseId];
      }
    }, "workerProcessMsg");
    var getOpts = /* @__PURE__ */ __name(function() {
      return {
        points: this.points,
        duration: this.duration,
        blockDuration: this.blockDuration,
        execEvenly: this.execEvenly,
        execEvenlyMinDelayMs: this.execEvenlyMinDelayMs,
        keyPrefix: this.keyPrefix
      };
    }, "getOpts");
    var savePromise = /* @__PURE__ */ __name(function(resolve, reject) {
      const hrtime = process.hrtime();
      let promiseId = hrtime[0].toString() + hrtime[1].toString();
      if (typeof this._promises[promiseId] !== "undefined") {
        promiseId += crypto.randomBytes(12).toString("base64");
      }
      this._promises[promiseId] = {
        resolve,
        reject,
        timeoutId: setTimeout(() => {
          delete this._promises[promiseId];
          reject(new Error("RateLimiterCluster timeout: no answer from master in time"));
        }, this.timeoutMs)
      };
      return promiseId;
    }, "savePromise");
    var RateLimiterClusterMaster = class {
      static {
        __name(this, "RateLimiterClusterMaster");
      }
      constructor() {
        if (masterInstance) {
          return masterInstance;
        }
        this._rateLimiters = {};
        cluster.setMaxListeners(0);
        cluster.on("message", (worker, msg) => {
          if (msg && msg.channel === channel && msg.type === "init") {
            if (typeof this._rateLimiters[msg.opts.keyPrefix] === "undefined") {
              this._rateLimiters[msg.opts.keyPrefix] = new RateLimiterMemory2(msg.opts);
            }
            worker.send({
              channel,
              type: "init",
              keyPrefix: msg.opts.keyPrefix
            });
          } else {
            masterProcessMsg.call(this, worker, msg);
          }
        });
        masterInstance = this;
      }
    };
    var RateLimiterClusterMasterPM2 = class {
      static {
        __name(this, "RateLimiterClusterMasterPM2");
      }
      constructor(pm2) {
        if (masterInstance) {
          return masterInstance;
        }
        this._rateLimiters = {};
        pm2.launchBus((err, pm2Bus) => {
          pm2Bus.on("process:msg", (packet) => {
            const msg = packet.raw;
            if (msg && msg.channel === channel && msg.type === "init") {
              if (typeof this._rateLimiters[msg.opts.keyPrefix] === "undefined") {
                this._rateLimiters[msg.opts.keyPrefix] = new RateLimiterMemory2(msg.opts);
              }
              pm2.sendDataToProcessId(packet.process.pm_id, {
                data: {},
                topic: channel,
                channel,
                type: "init",
                keyPrefix: msg.opts.keyPrefix
              }, (sendErr, res) => {
                if (sendErr) {
                  console.log(sendErr, res);
                }
              });
            } else {
              const worker = {
                send: /* @__PURE__ */ __name((msgData) => {
                  const pm2Message = msgData;
                  pm2Message.topic = channel;
                  if (typeof pm2Message.data === "undefined") {
                    pm2Message.data = {};
                  }
                  pm2.sendDataToProcessId(packet.process.pm_id, pm2Message, (sendErr, res) => {
                    if (sendErr) {
                      console.log(sendErr, res);
                    }
                  });
                }, "send")
              };
              masterProcessMsg.call(this, worker, msg);
            }
          });
        });
        masterInstance = this;
      }
    };
    var RateLimiterClusterWorker = class extends RateLimiterAbstract {
      static {
        __name(this, "RateLimiterClusterWorker");
      }
      get timeoutMs() {
        return this._timeoutMs;
      }
      set timeoutMs(value) {
        this._timeoutMs = typeof value === "undefined" ? 5e3 : Math.abs(parseInt(value));
      }
      constructor(opts = {}) {
        super(opts);
        process.setMaxListeners(0);
        this.timeoutMs = opts.timeoutMs;
        this._initiated = false;
        process.on("message", (msg) => {
          if (msg && msg.channel === channel && msg.type === "init" && msg.keyPrefix === this.keyPrefix) {
            this._initiated = true;
          } else {
            workerProcessMsg.call(this, msg);
          }
        });
        process.send({
          channel,
          type: "init",
          opts: getOpts.call(this)
        });
        this._promises = {};
      }
      consume(key, pointsToConsume = 1, options = {}) {
        return new Promise((resolve, reject) => {
          const promiseId = savePromise.call(this, resolve, reject);
          workerSendToMaster.call(this, "consume", promiseId, key, pointsToConsume, options);
        });
      }
      penalty(key, points = 1, options = {}) {
        return new Promise((resolve, reject) => {
          const promiseId = savePromise.call(this, resolve, reject);
          workerSendToMaster.call(this, "penalty", promiseId, key, points, options);
        });
      }
      reward(key, points = 1, options = {}) {
        return new Promise((resolve, reject) => {
          const promiseId = savePromise.call(this, resolve, reject);
          workerSendToMaster.call(this, "reward", promiseId, key, points, options);
        });
      }
      block(key, secDuration, options = {}) {
        return new Promise((resolve, reject) => {
          const promiseId = savePromise.call(this, resolve, reject);
          workerSendToMaster.call(this, "block", promiseId, key, secDuration, options);
        });
      }
      get(key, options = {}) {
        return new Promise((resolve, reject) => {
          const promiseId = savePromise.call(this, resolve, reject);
          workerSendToMaster.call(this, "get", promiseId, key, options);
        });
      }
      delete(key, options = {}) {
        return new Promise((resolve, reject) => {
          const promiseId = savePromise.call(this, resolve, reject);
          workerSendToMaster.call(this, "delete", promiseId, key, options);
        });
      }
    };
    module.exports = {
      RateLimiterClusterMaster,
      RateLimiterClusterMasterPM2,
      RateLimiterCluster: RateLimiterClusterWorker
    };
  }
});

// node_modules/rate-limiter-flexible/lib/RateLimiterMemcache.js
var require_RateLimiterMemcache = __commonJS({
  "node_modules/rate-limiter-flexible/lib/RateLimiterMemcache.js"(exports, module) {
    init_esbuild_shims();
    var RateLimiterStoreAbstract = require_RateLimiterStoreAbstract();
    var RateLimiterRes = require_RateLimiterRes();
    var RateLimiterMemcache = class extends RateLimiterStoreAbstract {
      static {
        __name(this, "RateLimiterMemcache");
      }
      /**
       *
       * @param {Object} opts
       * Defaults {
       *   ... see other in RateLimiterStoreAbstract
       *
       *   storeClient: memcacheClient
       * }
       */
      constructor(opts) {
        super(opts);
        this.client = opts.storeClient;
      }
      _getRateLimiterRes(rlKey, changedPoints, result) {
        const res = new RateLimiterRes();
        res.consumedPoints = parseInt(result.consumedPoints);
        res.isFirstInDuration = result.consumedPoints === changedPoints;
        res.remainingPoints = Math.max(this.points - res.consumedPoints, 0);
        res.msBeforeNext = result.msBeforeNext;
        return res;
      }
      _upsert(rlKey, points, msDuration, forceExpire = false, options = {}) {
        return new Promise((resolve, reject) => {
          const nowMs = Date.now();
          const secDuration = Math.floor(msDuration / 1e3);
          if (forceExpire) {
            this.client.set(rlKey, points, secDuration, (err) => {
              if (!err) {
                this.client.set(
                  `${rlKey}_expire`,
                  secDuration > 0 ? nowMs + secDuration * 1e3 : -1,
                  secDuration,
                  () => {
                    const res = {
                      consumedPoints: points,
                      msBeforeNext: secDuration > 0 ? secDuration * 1e3 : -1
                    };
                    resolve(res);
                  }
                );
              } else {
                reject(err);
              }
            });
          } else {
            this.client.incr(rlKey, points, (err, consumedPoints) => {
              if (err || consumedPoints === false) {
                this.client.add(rlKey, points, secDuration, (errAddKey, createdNew) => {
                  if (errAddKey || !createdNew) {
                    if (typeof options.attemptNumber === "undefined" || options.attemptNumber < 3) {
                      const nextOptions = Object.assign({}, options);
                      nextOptions.attemptNumber = nextOptions.attemptNumber ? nextOptions.attemptNumber + 1 : 1;
                      this._upsert(rlKey, points, msDuration, forceExpire, nextOptions).then((resUpsert) => resolve(resUpsert)).catch((errUpsert) => reject(errUpsert));
                    } else {
                      reject(new Error("Can not add key"));
                    }
                  } else {
                    this.client.add(
                      `${rlKey}_expire`,
                      secDuration > 0 ? nowMs + secDuration * 1e3 : -1,
                      secDuration,
                      () => {
                        const res = {
                          consumedPoints: points,
                          msBeforeNext: secDuration > 0 ? secDuration * 1e3 : -1
                        };
                        resolve(res);
                      }
                    );
                  }
                });
              } else {
                this.client.get(`${rlKey}_expire`, (errGetExpire, resGetExpireMs) => {
                  if (errGetExpire) {
                    reject(errGetExpire);
                  } else {
                    const expireMs = resGetExpireMs === false ? 0 : resGetExpireMs;
                    const res = {
                      consumedPoints,
                      msBeforeNext: expireMs >= 0 ? Math.max(expireMs - nowMs, 0) : -1
                    };
                    resolve(res);
                  }
                });
              }
            });
          }
        });
      }
      _get(rlKey) {
        return new Promise((resolve, reject) => {
          const nowMs = Date.now();
          this.client.get(rlKey, (err, consumedPoints) => {
            if (!consumedPoints) {
              resolve(null);
            } else {
              this.client.get(`${rlKey}_expire`, (errGetExpire, resGetExpireMs) => {
                if (errGetExpire) {
                  reject(errGetExpire);
                } else {
                  const expireMs = resGetExpireMs === false ? 0 : resGetExpireMs;
                  const res = {
                    consumedPoints,
                    msBeforeNext: expireMs >= 0 ? Math.max(expireMs - nowMs, 0) : -1
                  };
                  resolve(res);
                }
              });
            }
          });
        });
      }
      _delete(rlKey) {
        return new Promise((resolve, reject) => {
          this.client.del(rlKey, (err, res) => {
            if (err) {
              reject(err);
            } else if (res === false) {
              resolve(res);
            } else {
              this.client.del(`${rlKey}_expire`, (errDelExpire) => {
                if (errDelExpire) {
                  reject(errDelExpire);
                } else {
                  resolve(res);
                }
              });
            }
          });
        });
      }
    };
    module.exports = RateLimiterMemcache;
  }
});

// node_modules/rate-limiter-flexible/lib/RLWrapperBlackAndWhite.js
var require_RLWrapperBlackAndWhite = __commonJS({
  "node_modules/rate-limiter-flexible/lib/RLWrapperBlackAndWhite.js"(exports, module) {
    init_esbuild_shims();
    var RateLimiterRes = require_RateLimiterRes();
    module.exports = class RLWrapperBlackAndWhite {
      static {
        __name(this, "RLWrapperBlackAndWhite");
      }
      constructor(opts = {}) {
        this.limiter = opts.limiter;
        this.blackList = opts.blackList;
        this.whiteList = opts.whiteList;
        this.isBlackListed = opts.isBlackListed;
        this.isWhiteListed = opts.isWhiteListed;
        this.runActionAnyway = opts.runActionAnyway;
      }
      get limiter() {
        return this._limiter;
      }
      set limiter(value) {
        if (typeof value === "undefined") {
          throw new Error("limiter is not set");
        }
        this._limiter = value;
      }
      get runActionAnyway() {
        return this._runActionAnyway;
      }
      set runActionAnyway(value) {
        this._runActionAnyway = typeof value === "undefined" ? false : value;
      }
      get blackList() {
        return this._blackList;
      }
      set blackList(value) {
        this._blackList = Array.isArray(value) ? value : [];
      }
      get isBlackListed() {
        return this._isBlackListed;
      }
      set isBlackListed(func) {
        if (typeof func === "undefined") {
          func = /* @__PURE__ */ __name(() => false, "func");
        }
        if (typeof func !== "function") {
          throw new Error("isBlackListed must be function");
        }
        this._isBlackListed = func;
      }
      get whiteList() {
        return this._whiteList;
      }
      set whiteList(value) {
        this._whiteList = Array.isArray(value) ? value : [];
      }
      get isWhiteListed() {
        return this._isWhiteListed;
      }
      set isWhiteListed(func) {
        if (typeof func === "undefined") {
          func = /* @__PURE__ */ __name(() => false, "func");
        }
        if (typeof func !== "function") {
          throw new Error("isWhiteListed must be function");
        }
        this._isWhiteListed = func;
      }
      isBlackListedSomewhere(key) {
        return this.blackList.indexOf(key) >= 0 || this.isBlackListed(key);
      }
      isWhiteListedSomewhere(key) {
        return this.whiteList.indexOf(key) >= 0 || this.isWhiteListed(key);
      }
      getBlackRes() {
        return new RateLimiterRes(0, Number.MAX_SAFE_INTEGER, 0, false);
      }
      getWhiteRes() {
        return new RateLimiterRes(Number.MAX_SAFE_INTEGER, 0, 0, false);
      }
      rejectBlack() {
        return Promise.reject(this.getBlackRes());
      }
      resolveBlack() {
        return Promise.resolve(this.getBlackRes());
      }
      resolveWhite() {
        return Promise.resolve(this.getWhiteRes());
      }
      consume(key, pointsToConsume = 1) {
        let res;
        if (this.isWhiteListedSomewhere(key)) {
          res = this.resolveWhite();
        } else if (this.isBlackListedSomewhere(key)) {
          res = this.rejectBlack();
        }
        if (typeof res === "undefined") {
          return this.limiter.consume(key, pointsToConsume);
        }
        if (this.runActionAnyway) {
          this.limiter.consume(key, pointsToConsume).catch(() => {
          });
        }
        return res;
      }
      block(key, secDuration) {
        let res;
        if (this.isWhiteListedSomewhere(key)) {
          res = this.resolveWhite();
        } else if (this.isBlackListedSomewhere(key)) {
          res = this.resolveBlack();
        }
        if (typeof res === "undefined") {
          return this.limiter.block(key, secDuration);
        }
        if (this.runActionAnyway) {
          this.limiter.block(key, secDuration).catch(() => {
          });
        }
        return res;
      }
      penalty(key, points) {
        let res;
        if (this.isWhiteListedSomewhere(key)) {
          res = this.resolveWhite();
        } else if (this.isBlackListedSomewhere(key)) {
          res = this.resolveBlack();
        }
        if (typeof res === "undefined") {
          return this.limiter.penalty(key, points);
        }
        if (this.runActionAnyway) {
          this.limiter.penalty(key, points).catch(() => {
          });
        }
        return res;
      }
      reward(key, points) {
        let res;
        if (this.isWhiteListedSomewhere(key)) {
          res = this.resolveWhite();
        } else if (this.isBlackListedSomewhere(key)) {
          res = this.resolveBlack();
        }
        if (typeof res === "undefined") {
          return this.limiter.reward(key, points);
        }
        if (this.runActionAnyway) {
          this.limiter.reward(key, points).catch(() => {
          });
        }
        return res;
      }
      get(key) {
        let res;
        if (this.isWhiteListedSomewhere(key)) {
          res = this.resolveWhite();
        } else if (this.isBlackListedSomewhere(key)) {
          res = this.resolveBlack();
        }
        if (typeof res === "undefined" || this.runActionAnyway) {
          return this.limiter.get(key);
        }
        return res;
      }
      delete(key) {
        return this.limiter.delete(key);
      }
    };
  }
});

// node_modules/rate-limiter-flexible/lib/RateLimiterUnion.js
var require_RateLimiterUnion = __commonJS({
  "node_modules/rate-limiter-flexible/lib/RateLimiterUnion.js"(exports, module) {
    init_esbuild_shims();
    var RateLimiterAbstract = require_RateLimiterAbstract();
    module.exports = class RateLimiterUnion {
      static {
        __name(this, "RateLimiterUnion");
      }
      constructor(...limiters) {
        if (limiters.length < 1) {
          throw new Error("RateLimiterUnion: at least one limiter have to be passed");
        }
        limiters.forEach((limiter) => {
          if (!(limiter instanceof RateLimiterAbstract)) {
            throw new Error("RateLimiterUnion: all limiters have to be instance of RateLimiterAbstract");
          }
        });
        this._limiters = limiters;
      }
      consume(key, points = 1) {
        return new Promise((resolve, reject) => {
          const promises = [];
          this._limiters.forEach((limiter) => {
            promises.push(limiter.consume(key, points).catch((rej) => ({ rejected: true, rej })));
          });
          Promise.all(promises).then((res) => {
            const resObj = {};
            let rejected = false;
            res.forEach((item) => {
              if (item.rejected === true) {
                rejected = true;
              }
            });
            for (let i = 0; i < res.length; i++) {
              if (rejected && res[i].rejected === true) {
                resObj[this._limiters[i].keyPrefix] = res[i].rej;
              } else if (!rejected) {
                resObj[this._limiters[i].keyPrefix] = res[i];
              }
            }
            if (rejected) {
              reject(resObj);
            } else {
              resolve(resObj);
            }
          });
        });
      }
    };
  }
});

// node_modules/rate-limiter-flexible/lib/component/RateLimiterQueueError.js
var require_RateLimiterQueueError = __commonJS({
  "node_modules/rate-limiter-flexible/lib/component/RateLimiterQueueError.js"(exports, module) {
    init_esbuild_shims();
    module.exports = class RateLimiterQueueError extends Error {
      static {
        __name(this, "RateLimiterQueueError");
      }
      constructor(message, extra) {
        super();
        if (Error.captureStackTrace) {
          Error.captureStackTrace(this, this.constructor);
        }
        this.name = "CustomError";
        this.message = message;
        if (extra) {
          this.extra = extra;
        }
      }
    };
  }
});

// node_modules/rate-limiter-flexible/lib/RateLimiterQueue.js
var require_RateLimiterQueue = __commonJS({
  "node_modules/rate-limiter-flexible/lib/RateLimiterQueue.js"(exports, module) {
    init_esbuild_shims();
    var RateLimiterQueueError = require_RateLimiterQueueError();
    var MAX_QUEUE_SIZE = 4294967295;
    var KEY_DEFAULT = "limiter";
    module.exports = class RateLimiterQueue {
      static {
        __name(this, "RateLimiterQueue");
      }
      constructor(limiterFlexible, opts = {
        maxQueueSize: MAX_QUEUE_SIZE
      }) {
        this._queueLimiters = {
          KEY_DEFAULT: new RateLimiterQueueInternal(limiterFlexible, opts)
        };
        this._limiterFlexible = limiterFlexible;
        this._maxQueueSize = opts.maxQueueSize;
      }
      getTokensRemaining(key = KEY_DEFAULT) {
        if (this._queueLimiters[key]) {
          return this._queueLimiters[key].getTokensRemaining();
        } else {
          return Promise.resolve(this._limiterFlexible.points);
        }
      }
      removeTokens(tokens, key = KEY_DEFAULT) {
        if (!this._queueLimiters[key]) {
          this._queueLimiters[key] = new RateLimiterQueueInternal(
            this._limiterFlexible,
            {
              key,
              maxQueueSize: this._maxQueueSize
            }
          );
        }
        return this._queueLimiters[key].removeTokens(tokens);
      }
    };
    var RateLimiterQueueInternal = class {
      static {
        __name(this, "RateLimiterQueueInternal");
      }
      constructor(limiterFlexible, opts = {
        maxQueueSize: MAX_QUEUE_SIZE,
        key: KEY_DEFAULT
      }) {
        this._key = opts.key;
        this._waitTimeout = null;
        this._queue = [];
        this._limiterFlexible = limiterFlexible;
        this._maxQueueSize = opts.maxQueueSize;
      }
      getTokensRemaining() {
        return this._limiterFlexible.get(this._key).then((rlRes) => {
          return rlRes !== null ? rlRes.remainingPoints : this._limiterFlexible.points;
        });
      }
      removeTokens(tokens) {
        const _this = this;
        return new Promise((resolve, reject) => {
          if (tokens > _this._limiterFlexible.points) {
            reject(new RateLimiterQueueError(`Requested tokens ${tokens} exceeds maximum ${_this._limiterFlexible.points} tokens per interval`));
            return;
          }
          if (_this._queue.length > 0) {
            _this._queueRequest.call(_this, resolve, reject, tokens);
          } else {
            _this._limiterFlexible.consume(_this._key, tokens).then((res) => {
              resolve(res.remainingPoints);
            }).catch((rej) => {
              if (rej instanceof Error) {
                reject(rej);
              } else {
                _this._queueRequest.call(_this, resolve, reject, tokens);
                if (_this._waitTimeout === null) {
                  _this._waitTimeout = setTimeout(_this._processFIFO.bind(_this), rej.msBeforeNext);
                }
              }
            });
          }
        });
      }
      _queueRequest(resolve, reject, tokens) {
        const _this = this;
        if (_this._queue.length < _this._maxQueueSize) {
          _this._queue.push({ resolve, reject, tokens });
        } else {
          reject(new RateLimiterQueueError(`Number of requests reached it's maximum ${_this._maxQueueSize}`));
        }
      }
      _processFIFO() {
        const _this = this;
        if (_this._waitTimeout !== null) {
          clearTimeout(_this._waitTimeout);
          _this._waitTimeout = null;
        }
        if (_this._queue.length === 0) {
          return;
        }
        const item = _this._queue.shift();
        _this._limiterFlexible.consume(_this._key, item.tokens).then((res) => {
          item.resolve(res.remainingPoints);
          _this._processFIFO.call(_this);
        }).catch((rej) => {
          if (rej instanceof Error) {
            item.reject(rej);
            _this._processFIFO.call(_this);
          } else {
            _this._queue.unshift(item);
            if (_this._waitTimeout === null) {
              _this._waitTimeout = setTimeout(_this._processFIFO.bind(_this), rej.msBeforeNext);
            }
          }
        });
      }
    };
  }
});

// node_modules/rate-limiter-flexible/lib/BurstyRateLimiter.js
var require_BurstyRateLimiter = __commonJS({
  "node_modules/rate-limiter-flexible/lib/BurstyRateLimiter.js"(exports, module) {
    init_esbuild_shims();
    var RateLimiterRes = require_RateLimiterRes();
    module.exports = class BurstyRateLimiter {
      static {
        __name(this, "BurstyRateLimiter");
      }
      constructor(rateLimiter, burstLimiter) {
        this._rateLimiter = rateLimiter;
        this._burstLimiter = burstLimiter;
      }
      /**
       * Merge rate limiter response objects. Responses can be null
       *
       * @param {RateLimiterRes} [rlRes] Rate limiter response
       * @param {RateLimiterRes} [blRes] Bursty limiter response
       */
      _combineRes(rlRes, blRes) {
        if (!rlRes) {
          return null;
        }
        return new RateLimiterRes(
          rlRes.remainingPoints,
          Math.min(rlRes.msBeforeNext, blRes ? blRes.msBeforeNext : 0),
          rlRes.consumedPoints,
          rlRes.isFirstInDuration
        );
      }
      /**
       * @param key
       * @param pointsToConsume
       * @param options
       * @returns {Promise<any>}
       */
      consume(key, pointsToConsume = 1, options = {}) {
        return this._rateLimiter.consume(key, pointsToConsume, options).catch((rlRej) => {
          if (rlRej instanceof RateLimiterRes) {
            return this._burstLimiter.consume(key, pointsToConsume, options).then((blRes) => {
              return Promise.resolve(this._combineRes(rlRej, blRes));
            }).catch(
              (blRej) => {
                if (blRej instanceof RateLimiterRes) {
                  return Promise.reject(this._combineRes(rlRej, blRej));
                } else {
                  return Promise.reject(blRej);
                }
              }
            );
          } else {
            return Promise.reject(rlRej);
          }
        });
      }
      /**
       * It doesn't expose available points from burstLimiter
       *
       * @param key
       * @returns {Promise<RateLimiterRes>}
       */
      get(key) {
        return Promise.all([
          this._rateLimiter.get(key),
          this._burstLimiter.get(key)
        ]).then(([rlRes, blRes]) => {
          return this._combineRes(rlRes, blRes);
        });
      }
      get points() {
        return this._rateLimiter.points;
      }
    };
  }
});

// node_modules/rate-limiter-flexible/lib/RateLimiterDynamo.js
var require_RateLimiterDynamo = __commonJS({
  "node_modules/rate-limiter-flexible/lib/RateLimiterDynamo.js"(exports, module) {
    init_esbuild_shims();
    var RateLimiterRes = require_RateLimiterRes();
    var RateLimiterStoreAbstract = require_RateLimiterStoreAbstract();
    var DynamoItem = class {
      static {
        __name(this, "DynamoItem");
      }
      /**
       * Create a DynamoItem.
       * @param {string} rlKey - The key for the rate limiter.
       * @param {number} points - The number of points.
       * @param {number} expire - The expiration time in seconds.
       */
      constructor(rlKey, points, expire) {
        this.key = rlKey;
        this.points = points;
        this.expire = expire;
      }
    };
    var DEFAULT_READ_CAPACITY_UNITS = 25;
    var DEFAULT_WRITE_CAPACITY_UNITS = 25;
    var RateLimiterDynamo = class extends RateLimiterStoreAbstract {
      static {
        __name(this, "RateLimiterDynamo");
      }
      /**
       * Constructs a new instance of the class.
       * The storeClient MUST be an instance of AWS.DynamoDB NOT of AWS.DynamoDBClient.
       *
       * @param {Object} opts - The options for the constructor.
       * @param {function} cb - The callback function (optional).
       * @return {void}
       */
      constructor(opts, cb = null) {
        super(opts);
        this.client = opts.storeClient;
        this.tableName = opts.tableName;
        this.tableCreated = opts.tableCreated;
        if (!this.tableCreated) {
          this._createTable(opts.dynamoTableOpts).then((data) => {
            this.tableCreated = true;
            this._setTTL().finally(() => {
              if (typeof cb === "function") {
                cb();
              }
            });
          }).catch((err) => {
            if (typeof cb === "function") {
              cb(err);
            } else {
              throw err;
            }
          });
        } else {
          this._setTTL().finally(() => {
            if (typeof cb === "function") {
              cb();
            }
          });
        }
      }
      get tableName() {
        return this._tableName;
      }
      set tableName(value) {
        this._tableName = typeof value === "undefined" ? "node-rate-limiter-flexible" : value;
      }
      get tableCreated() {
        return this._tableCreated;
      }
      set tableCreated(value) {
        this._tableCreated = typeof value === "undefined" ? false : !!value;
      }
      /**
       * Creates a table in the database. Return null if the table already exists.
       * 
       * @param {{readCapacityUnits: number, writeCapacityUnits: number}} tableOpts
       * @return {Promise} A promise that resolves with the result of creating the table.
       */
      async _createTable(tableOpts) {
        const params = {
          TableName: this.tableName,
          AttributeDefinitions: [
            {
              AttributeName: "key",
              AttributeType: "S"
            }
          ],
          KeySchema: [
            {
              AttributeName: "key",
              KeyType: "HASH"
            }
          ],
          ProvisionedThroughput: {
            ReadCapacityUnits: tableOpts && tableOpts.readCapacityUnits ? tableOpts.readCapacityUnits : DEFAULT_READ_CAPACITY_UNITS,
            WriteCapacityUnits: tableOpts && tableOpts.writeCapacityUnits ? tableOpts.writeCapacityUnits : DEFAULT_WRITE_CAPACITY_UNITS
          }
        };
        try {
          const data = await this.client.createTable(params);
          return data;
        } catch (err) {
          if (err.__type && err.__type.includes("ResourceInUseException")) {
            return null;
          } else {
            throw err;
          }
        }
      }
      /**
       * Retrieves an item from the table based on the provided key.
       *
       * @param {string} rlKey - The key used to retrieve the item.
       * @throws {Error} Throws an error if the table is not created yet.
       * @return {DynamoItem|null} - The retrieved item, or null if it doesn't exist.
       */
      async _get(rlKey) {
        if (!this.tableCreated) {
          throw new Error("Table is not created yet");
        }
        const params = {
          TableName: this.tableName,
          Key: {
            key: { S: rlKey }
          }
        };
        const data = await this.client.getItem(params);
        if (data.Item) {
          return new DynamoItem(
            data.Item.key.S,
            Number(data.Item.points.N),
            Number(data.Item.expire.N)
          );
        } else {
          return null;
        }
      }
      /**
       * Deletes an item from the table based on the given rlKey.
       *
       * @param {string} rlKey - The rlKey of the item to delete.
       * @throws {Error} Throws an error if the table is not created yet.
       * @return {boolean} Returns true if the item was successfully deleted, otherwise false.
       */
      async _delete(rlKey) {
        if (!this.tableCreated) {
          throw new Error("Table is not created yet");
        }
        const params = {
          TableName: this.tableName,
          Key: {
            key: { S: rlKey }
          },
          ConditionExpression: "attribute_exists(#k)",
          ExpressionAttributeNames: {
            "#k": "key"
          }
        };
        try {
          const data = await this._client.deleteItem(params);
          return data.$metadata.httpStatusCode === 200;
        } catch (err) {
          if (err.__type && err.__type.includes("ConditionalCheckFailedException")) {
            return false;
          } else {
            throw err;
          }
        }
      }
      /**
       * Implemented with DynamoDB Atomic Counters. 3 calls are made to DynamoDB but each call is atomic.
       * From the documentation: "UpdateItem calls are naturally serialized within DynamoDB,
       * so there are no race condition concerns with making multiple simultaneous calls."
       * See: https://aws.amazon.com/it/blogs/database/implement-resource-counters-with-amazon-dynamodb/
       * @param {*} rlKey 
       * @param {*} points 
       * @param {*} msDuration 
       * @param {*} forceExpire 
       * @param {*} options 
       * @returns
       */
      async _upsert(rlKey, points, msDuration, forceExpire = false, options = {}) {
        if (!this.tableCreated) {
          throw new Error("Table is not created yet");
        }
        const dateNow = Date.now();
        const dateNowSec = dateNow / 1e3;
        const newExpireSec = msDuration > 0 ? (dateNow + msDuration) / 1e3 : -1;
        if (forceExpire) {
          return await this._baseUpsert({
            TableName: this.tableName,
            Key: { key: { S: rlKey } },
            UpdateExpression: "SET points = :points, expire = :expire",
            ExpressionAttributeValues: {
              ":points": { N: points.toString() },
              ":expire": { N: newExpireSec.toString() }
            },
            ReturnValues: "ALL_NEW"
          });
        }
        try {
          return await this._baseUpsert({
            TableName: this.tableName,
            Key: { key: { S: rlKey } },
            UpdateExpression: "SET points = :new_points, expire = :new_expire",
            ExpressionAttributeValues: {
              ":new_points": { N: points.toString() },
              ":new_expire": { N: newExpireSec.toString() },
              ":where_expire": { N: dateNowSec.toString() }
            },
            ConditionExpression: "expire <= :where_expire OR attribute_not_exists(points)",
            ReturnValues: "ALL_NEW"
          });
        } catch (err) {
          return await this._baseUpsert({
            TableName: this.tableName,
            Key: { key: { S: rlKey } },
            UpdateExpression: "SET points = points + :new_points",
            ExpressionAttributeValues: {
              ":new_points": { N: points.toString() },
              ":where_expire": { N: dateNowSec.toString() }
            },
            ConditionExpression: "expire > :where_expire",
            ReturnValues: "ALL_NEW"
          });
        }
      }
      /**
       * Asynchronously upserts data into the table. params is a DynamoDB params object.
       *
       * @param {Object} params - The parameters for the upsert operation.
       * @throws {Error} Throws an error if the table is not created yet.
       * @return {DynamoItem} Returns a DynamoItem object with the updated data.
       */
      async _baseUpsert(params) {
        if (!this.tableCreated) {
          throw new Error("Table is not created yet");
        }
        try {
          const data = await this.client.updateItem(params);
          return new DynamoItem(
            data.Attributes.key.S,
            Number(data.Attributes.points.N),
            Number(data.Attributes.expire.N)
          );
        } catch (err) {
          throw err;
        }
      }
      /**
       * Sets the Time-to-Live (TTL) for the table. TTL use the expire field in the table.
       * See: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/howitworks-ttl.html
       *
       * @return {Promise} A promise that resolves when the TTL is successfully set.
       * @throws {Error} Throws an error if the table is not created yet.
       * @returns {Promise}
       */
      async _setTTL() {
        if (!this.tableCreated) {
          throw new Error("Table is not created yet");
        }
        try {
          const isTTLSet = await this._isTTLSet();
          if (isTTLSet) {
            return;
          }
          const params = {
            TableName: this.tableName,
            TimeToLiveSpecification: {
              AttributeName: "expire",
              Enabled: true
            }
          };
          const res = await this.client.updateTimeToLive(params);
          return res;
        } catch (err) {
          throw err;
        }
      }
      /**
       * Checks if the Time To Live (TTL) feature is set for the DynamoDB table.
       *
       * @return {boolean} Returns true if the TTL feature is enabled for the table, otherwise false.
       * @throws {Error} Throws an error if the table is not created yet or if there is an error while checking the TTL status.
       */
      async _isTTLSet() {
        if (!this.tableCreated) {
          throw new Error("Table is not created yet");
        }
        try {
          const res = await this.client.describeTimeToLive({ TableName: this.tableName });
          return res.$metadata.httpStatusCode == 200 && res.TimeToLiveDescription.TimeToLiveStatus === "ENABLED" && res.TimeToLiveDescription.AttributeName === "expire";
        } catch (err) {
          throw err;
        }
      }
      /**
       * Generate a RateLimiterRes object based on the provided parameters.
       *
       * @param {string} rlKey - The key for the rate limiter.
       * @param {number} changedPoints - The number of points that have changed.
       * @param {DynamoItem} result - The result object of _get() method.
       * @returns {RateLimiterRes} - The generated RateLimiterRes object.
       */
      _getRateLimiterRes(rlKey, changedPoints, result) {
        const res = new RateLimiterRes();
        res.isFirstInDuration = changedPoints === result.points;
        res.consumedPoints = res.isFirstInDuration ? changedPoints : result.points;
        res.remainingPoints = Math.max(this.points - res.consumedPoints, 0);
        res.msBeforeNext = result.expire != -1 ? Math.max(result.expire * 1e3 - Date.now(), 0) : -1;
        return res;
      }
    };
    module.exports = RateLimiterDynamo;
  }
});

// node_modules/rate-limiter-flexible/index.js
var require_rate_limiter_flexible = __commonJS({
  "node_modules/rate-limiter-flexible/index.js"(exports, module) {
    init_esbuild_shims();
    var RateLimiterRedis = require_RateLimiterRedis();
    var RateLimiterMongo = require_RateLimiterMongo();
    var RateLimiterMySQL = require_RateLimiterMySQL();
    var RateLimiterPostgres = require_RateLimiterPostgres();
    var { RateLimiterClusterMaster, RateLimiterClusterMasterPM2, RateLimiterCluster } = require_RateLimiterCluster();
    var RateLimiterMemory2 = require_RateLimiterMemory();
    var RateLimiterMemcache = require_RateLimiterMemcache();
    var RLWrapperBlackAndWhite = require_RLWrapperBlackAndWhite();
    var RateLimiterUnion = require_RateLimiterUnion();
    var RateLimiterQueue2 = require_RateLimiterQueue();
    var BurstyRateLimiter = require_BurstyRateLimiter();
    var RateLimiterRes = require_RateLimiterRes();
    var RateLimiterDynamo = require_RateLimiterDynamo();
    module.exports = {
      RateLimiterRedis,
      RateLimiterMongo,
      RateLimiterMySQL,
      RateLimiterPostgres,
      RateLimiterMemory: RateLimiterMemory2,
      RateLimiterMemcache,
      RateLimiterClusterMaster,
      RateLimiterClusterMasterPM2,
      RateLimiterCluster,
      RLWrapperBlackAndWhite,
      RateLimiterUnion,
      RateLimiterQueue: RateLimiterQueue2,
      BurstyRateLimiter,
      RateLimiterRes,
      RateLimiterDynamo
    };
  }
});

// node_modules/picomatch-browser/lib/constants.js
var require_constants = __commonJS({
  "node_modules/picomatch-browser/lib/constants.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var WIN_SLASH = "\\\\/";
    var WIN_NO_SLASH = `[^${WIN_SLASH}]`;
    var DOT_LITERAL = "\\.";
    var PLUS_LITERAL = "\\+";
    var QMARK_LITERAL = "\\?";
    var SLASH_LITERAL = "\\/";
    var ONE_CHAR = "(?=.)";
    var QMARK = "[^/]";
    var END_ANCHOR = `(?:${SLASH_LITERAL}|$)`;
    var START_ANCHOR = `(?:^|${SLASH_LITERAL})`;
    var DOTS_SLASH = `${DOT_LITERAL}{1,2}${END_ANCHOR}`;
    var NO_DOT = `(?!${DOT_LITERAL})`;
    var NO_DOTS = `(?!${START_ANCHOR}${DOTS_SLASH})`;
    var NO_DOT_SLASH = `(?!${DOT_LITERAL}{0,1}${END_ANCHOR})`;
    var NO_DOTS_SLASH = `(?!${DOTS_SLASH})`;
    var QMARK_NO_DOT = `[^.${SLASH_LITERAL}]`;
    var STAR = `${QMARK}*?`;
    var SEP = "/";
    var POSIX_CHARS = {
      DOT_LITERAL,
      PLUS_LITERAL,
      QMARK_LITERAL,
      SLASH_LITERAL,
      ONE_CHAR,
      QMARK,
      END_ANCHOR,
      DOTS_SLASH,
      NO_DOT,
      NO_DOTS,
      NO_DOT_SLASH,
      NO_DOTS_SLASH,
      QMARK_NO_DOT,
      STAR,
      START_ANCHOR,
      SEP
    };
    var WINDOWS_CHARS = {
      ...POSIX_CHARS,
      SLASH_LITERAL: `[${WIN_SLASH}]`,
      QMARK: WIN_NO_SLASH,
      STAR: `${WIN_NO_SLASH}*?`,
      DOTS_SLASH: `${DOT_LITERAL}{1,2}(?:[${WIN_SLASH}]|$)`,
      NO_DOT: `(?!${DOT_LITERAL})`,
      NO_DOTS: `(?!(?:^|[${WIN_SLASH}])${DOT_LITERAL}{1,2}(?:[${WIN_SLASH}]|$))`,
      NO_DOT_SLASH: `(?!${DOT_LITERAL}{0,1}(?:[${WIN_SLASH}]|$))`,
      NO_DOTS_SLASH: `(?!${DOT_LITERAL}{1,2}(?:[${WIN_SLASH}]|$))`,
      QMARK_NO_DOT: `[^.${WIN_SLASH}]`,
      START_ANCHOR: `(?:^|[${WIN_SLASH}])`,
      END_ANCHOR: `(?:[${WIN_SLASH}]|$)`,
      SEP: "\\"
    };
    var POSIX_REGEX_SOURCE = {
      alnum: "a-zA-Z0-9",
      alpha: "a-zA-Z",
      ascii: "\\x00-\\x7F",
      blank: " \\t",
      cntrl: "\\x00-\\x1F\\x7F",
      digit: "0-9",
      graph: "\\x21-\\x7E",
      lower: "a-z",
      print: "\\x20-\\x7E ",
      punct: "\\-!\"#$%&'()\\*+,./:;<=>?@[\\]^_`{|}~",
      space: " \\t\\r\\n\\v\\f",
      upper: "A-Z",
      word: "A-Za-z0-9_",
      xdigit: "A-Fa-f0-9"
    };
    module.exports = {
      MAX_LENGTH: 1024 * 64,
      POSIX_REGEX_SOURCE,
      // regular expressions
      REGEX_BACKSLASH: /\\(?![*+?^${}(|)[\]])/g,
      REGEX_NON_SPECIAL_CHARS: /^[^@![\].,$*+?^{}()|\\/]+/,
      REGEX_SPECIAL_CHARS: /[-*+?.^${}(|)[\]]/,
      REGEX_SPECIAL_CHARS_BACKREF: /(\\?)((\W)(\3*))/g,
      REGEX_SPECIAL_CHARS_GLOBAL: /([-*+?.^${}(|)[\]])/g,
      REGEX_REMOVE_BACKSLASH: /(?:\[.*?[^\\]\]|\\(?=.))/g,
      // Replace globs with equivalent patterns to reduce parsing time.
      REPLACEMENTS: {
        "***": "*",
        "**/**": "**",
        "**/**/**": "**"
      },
      // Digits
      CHAR_0: 48,
      /* 0 */
      CHAR_9: 57,
      /* 9 */
      // Alphabet chars.
      CHAR_UPPERCASE_A: 65,
      /* A */
      CHAR_LOWERCASE_A: 97,
      /* a */
      CHAR_UPPERCASE_Z: 90,
      /* Z */
      CHAR_LOWERCASE_Z: 122,
      /* z */
      CHAR_LEFT_PARENTHESES: 40,
      /* ( */
      CHAR_RIGHT_PARENTHESES: 41,
      /* ) */
      CHAR_ASTERISK: 42,
      /* * */
      // Non-alphabetic chars.
      CHAR_AMPERSAND: 38,
      /* & */
      CHAR_AT: 64,
      /* @ */
      CHAR_BACKWARD_SLASH: 92,
      /* \ */
      CHAR_CARRIAGE_RETURN: 13,
      /* \r */
      CHAR_CIRCUMFLEX_ACCENT: 94,
      /* ^ */
      CHAR_COLON: 58,
      /* : */
      CHAR_COMMA: 44,
      /* , */
      CHAR_DOT: 46,
      /* . */
      CHAR_DOUBLE_QUOTE: 34,
      /* " */
      CHAR_EQUAL: 61,
      /* = */
      CHAR_EXCLAMATION_MARK: 33,
      /* ! */
      CHAR_FORM_FEED: 12,
      /* \f */
      CHAR_FORWARD_SLASH: 47,
      /* / */
      CHAR_GRAVE_ACCENT: 96,
      /* ` */
      CHAR_HASH: 35,
      /* # */
      CHAR_HYPHEN_MINUS: 45,
      /* - */
      CHAR_LEFT_ANGLE_BRACKET: 60,
      /* < */
      CHAR_LEFT_CURLY_BRACE: 123,
      /* { */
      CHAR_LEFT_SQUARE_BRACKET: 91,
      /* [ */
      CHAR_LINE_FEED: 10,
      /* \n */
      CHAR_NO_BREAK_SPACE: 160,
      /* \u00A0 */
      CHAR_PERCENT: 37,
      /* % */
      CHAR_PLUS: 43,
      /* + */
      CHAR_QUESTION_MARK: 63,
      /* ? */
      CHAR_RIGHT_ANGLE_BRACKET: 62,
      /* > */
      CHAR_RIGHT_CURLY_BRACE: 125,
      /* } */
      CHAR_RIGHT_SQUARE_BRACKET: 93,
      /* ] */
      CHAR_SEMICOLON: 59,
      /* ; */
      CHAR_SINGLE_QUOTE: 39,
      /* ' */
      CHAR_SPACE: 32,
      /*   */
      CHAR_TAB: 9,
      /* \t */
      CHAR_UNDERSCORE: 95,
      /* _ */
      CHAR_VERTICAL_LINE: 124,
      /* | */
      CHAR_ZERO_WIDTH_NOBREAK_SPACE: 65279,
      /* \uFEFF */
      /**
       * Create EXTGLOB_CHARS
       */
      extglobChars(chars) {
        return {
          "!": { type: "negate", open: "(?:(?!(?:", close: `))${chars.STAR})` },
          "?": { type: "qmark", open: "(?:", close: ")?" },
          "+": { type: "plus", open: "(?:", close: ")+" },
          "*": { type: "star", open: "(?:", close: ")*" },
          "@": { type: "at", open: "(?:", close: ")" }
        };
      },
      /**
       * Create GLOB_CHARS
       */
      globChars(win32) {
        return win32 === true ? WINDOWS_CHARS : POSIX_CHARS;
      }
    };
  }
});

// node_modules/picomatch-browser/lib/utils.js
var require_utils = __commonJS({
  "node_modules/picomatch-browser/lib/utils.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var {
      REGEX_BACKSLASH,
      REGEX_REMOVE_BACKSLASH,
      REGEX_SPECIAL_CHARS,
      REGEX_SPECIAL_CHARS_GLOBAL
    } = require_constants();
    exports.isObject = (val) => val !== null && typeof val === "object" && !Array.isArray(val);
    exports.hasRegexChars = (str) => REGEX_SPECIAL_CHARS.test(str);
    exports.isRegexChar = (str) => str.length === 1 && exports.hasRegexChars(str);
    exports.escapeRegex = (str) => str.replace(REGEX_SPECIAL_CHARS_GLOBAL, "\\$1");
    exports.toPosixSlashes = (str) => str.replace(REGEX_BACKSLASH, "/");
    exports.removeBackslashes = (str) => {
      return str.replace(REGEX_REMOVE_BACKSLASH, (match) => {
        return match === "\\" ? "" : match;
      });
    };
    exports.supportsLookbehinds = () => {
      const segs = process.version.slice(1).split(".").map(Number);
      if (segs.length === 3 && segs[0] >= 9 || segs[0] === 8 && segs[1] >= 10) {
        return true;
      }
      return false;
    };
    exports.escapeLast = (input, char, lastIdx) => {
      const idx = input.lastIndexOf(char, lastIdx);
      if (idx === -1) return input;
      if (input[idx - 1] === "\\") return exports.escapeLast(input, char, idx - 1);
      return `${input.slice(0, idx)}\\${input.slice(idx)}`;
    };
    exports.removePrefix = (input, state = {}) => {
      let output = input;
      if (output.startsWith("./")) {
        output = output.slice(2);
        state.prefix = "./";
      }
      return output;
    };
    exports.wrapOutput = (input, state = {}, options = {}) => {
      const prepend = options.contains ? "" : "^";
      const append = options.contains ? "" : "$";
      let output = `${prepend}(?:${input})${append}`;
      if (state.negated === true) {
        output = `(?:^(?!${output}).*$)`;
      }
      return output;
    };
    exports.basename = (path, { windows } = {}) => {
      if (windows) {
        return path.replace(/[\\/]$/, "").replace(/.*[\\/]/, "");
      } else {
        return path.replace(/\/$/, "").replace(/.*\//, "");
      }
    };
  }
});

// node_modules/picomatch-browser/lib/scan.js
var require_scan = __commonJS({
  "node_modules/picomatch-browser/lib/scan.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var utils = require_utils();
    var {
      CHAR_ASTERISK,
      /* * */
      CHAR_AT,
      /* @ */
      CHAR_BACKWARD_SLASH,
      /* \ */
      CHAR_COMMA,
      /* , */
      CHAR_DOT,
      /* . */
      CHAR_EXCLAMATION_MARK,
      /* ! */
      CHAR_FORWARD_SLASH,
      /* / */
      CHAR_LEFT_CURLY_BRACE,
      /* { */
      CHAR_LEFT_PARENTHESES,
      /* ( */
      CHAR_LEFT_SQUARE_BRACKET,
      /* [ */
      CHAR_PLUS,
      /* + */
      CHAR_QUESTION_MARK,
      /* ? */
      CHAR_RIGHT_CURLY_BRACE,
      /* } */
      CHAR_RIGHT_PARENTHESES,
      /* ) */
      CHAR_RIGHT_SQUARE_BRACKET
      /* ] */
    } = require_constants();
    var isPathSeparator = /* @__PURE__ */ __name((code) => {
      return code === CHAR_FORWARD_SLASH || code === CHAR_BACKWARD_SLASH;
    }, "isPathSeparator");
    var depth = /* @__PURE__ */ __name((token) => {
      if (token.isPrefix !== true) {
        token.depth = token.isGlobstar ? Infinity : 1;
      }
    }, "depth");
    var scan = /* @__PURE__ */ __name((input, options) => {
      const opts = options || {};
      const length = input.length - 1;
      const scanToEnd = opts.parts === true || opts.scanToEnd === true;
      const slashes = [];
      const tokens = [];
      const parts = [];
      let str = input;
      let index = -1;
      let start = 0;
      let lastIndex = 0;
      let isBrace = false;
      let isBracket = false;
      let isGlob = false;
      let isExtglob = false;
      let isGlobstar = false;
      let braceEscaped = false;
      let backslashes = false;
      let negated = false;
      let finished = false;
      let braces = 0;
      let prev;
      let code;
      let token = { value: "", depth: 0, isGlob: false };
      const eos = /* @__PURE__ */ __name(() => index >= length, "eos");
      const peek = /* @__PURE__ */ __name(() => str.charCodeAt(index + 1), "peek");
      const advance = /* @__PURE__ */ __name(() => {
        prev = code;
        return str.charCodeAt(++index);
      }, "advance");
      while (index < length) {
        code = advance();
        let next;
        if (code === CHAR_BACKWARD_SLASH) {
          backslashes = token.backslashes = true;
          code = advance();
          if (code === CHAR_LEFT_CURLY_BRACE) {
            braceEscaped = true;
          }
          continue;
        }
        if (braceEscaped === true || code === CHAR_LEFT_CURLY_BRACE) {
          braces++;
          while (eos() !== true && (code = advance())) {
            if (code === CHAR_BACKWARD_SLASH) {
              backslashes = token.backslashes = true;
              advance();
              continue;
            }
            if (code === CHAR_LEFT_CURLY_BRACE) {
              braces++;
              continue;
            }
            if (braceEscaped !== true && code === CHAR_DOT && (code = advance()) === CHAR_DOT) {
              isBrace = token.isBrace = true;
              isGlob = token.isGlob = true;
              finished = true;
              if (scanToEnd === true) {
                continue;
              }
              break;
            }
            if (braceEscaped !== true && code === CHAR_COMMA) {
              isBrace = token.isBrace = true;
              isGlob = token.isGlob = true;
              finished = true;
              if (scanToEnd === true) {
                continue;
              }
              break;
            }
            if (code === CHAR_RIGHT_CURLY_BRACE) {
              braces--;
              if (braces === 0) {
                braceEscaped = false;
                isBrace = token.isBrace = true;
                finished = true;
                break;
              }
            }
          }
          if (scanToEnd === true) {
            continue;
          }
          break;
        }
        if (code === CHAR_FORWARD_SLASH) {
          slashes.push(index);
          tokens.push(token);
          token = { value: "", depth: 0, isGlob: false };
          if (finished === true) continue;
          if (prev === CHAR_DOT && index === start + 1) {
            start += 2;
            continue;
          }
          lastIndex = index + 1;
          continue;
        }
        if (opts.noext !== true) {
          const isExtglobChar = code === CHAR_PLUS || code === CHAR_AT || code === CHAR_ASTERISK || code === CHAR_QUESTION_MARK || code === CHAR_EXCLAMATION_MARK;
          if (isExtglobChar === true && peek() === CHAR_LEFT_PARENTHESES) {
            isGlob = token.isGlob = true;
            isExtglob = token.isExtglob = true;
            finished = true;
            if (scanToEnd === true) {
              while (eos() !== true && (code = advance())) {
                if (code === CHAR_BACKWARD_SLASH) {
                  backslashes = token.backslashes = true;
                  code = advance();
                  continue;
                }
                if (code === CHAR_RIGHT_PARENTHESES) {
                  isGlob = token.isGlob = true;
                  finished = true;
                  break;
                }
              }
              continue;
            }
            break;
          }
        }
        if (code === CHAR_ASTERISK) {
          if (prev === CHAR_ASTERISK) isGlobstar = token.isGlobstar = true;
          isGlob = token.isGlob = true;
          finished = true;
          if (scanToEnd === true) {
            continue;
          }
          break;
        }
        if (code === CHAR_QUESTION_MARK) {
          isGlob = token.isGlob = true;
          finished = true;
          if (scanToEnd === true) {
            continue;
          }
          break;
        }
        if (code === CHAR_LEFT_SQUARE_BRACKET) {
          while (eos() !== true && (next = advance())) {
            if (next === CHAR_BACKWARD_SLASH) {
              backslashes = token.backslashes = true;
              advance();
              continue;
            }
            if (next === CHAR_RIGHT_SQUARE_BRACKET) {
              isBracket = token.isBracket = true;
              isGlob = token.isGlob = true;
              finished = true;
              if (scanToEnd === true) {
                continue;
              }
              break;
            }
          }
        }
        if (opts.nonegate !== true && code === CHAR_EXCLAMATION_MARK && index === start) {
          negated = token.negated = true;
          start++;
          continue;
        }
        if (opts.noparen !== true && code === CHAR_LEFT_PARENTHESES) {
          isGlob = token.isGlob = true;
          if (scanToEnd === true) {
            while (eos() !== true && (code = advance())) {
              if (code === CHAR_LEFT_PARENTHESES) {
                backslashes = token.backslashes = true;
                code = advance();
                continue;
              }
              if (code === CHAR_RIGHT_PARENTHESES) {
                finished = true;
                break;
              }
            }
            continue;
          }
          break;
        }
        if (isGlob === true) {
          finished = true;
          if (scanToEnd === true) {
            continue;
          }
          break;
        }
      }
      if (opts.noext === true) {
        isExtglob = false;
        isGlob = false;
      }
      let base = str;
      let prefix = "";
      let glob = "";
      if (start > 0) {
        prefix = str.slice(0, start);
        str = str.slice(start);
        lastIndex -= start;
      }
      if (base && isGlob === true && lastIndex > 0) {
        base = str.slice(0, lastIndex);
        glob = str.slice(lastIndex);
      } else if (isGlob === true) {
        base = "";
        glob = str;
      } else {
        base = str;
      }
      if (base && base !== "" && base !== "/" && base !== str) {
        if (isPathSeparator(base.charCodeAt(base.length - 1))) {
          base = base.slice(0, -1);
        }
      }
      if (opts.unescape === true) {
        if (glob) glob = utils.removeBackslashes(glob);
        if (base && backslashes === true) {
          base = utils.removeBackslashes(base);
        }
      }
      const state = {
        prefix,
        input,
        start,
        base,
        glob,
        isBrace,
        isBracket,
        isGlob,
        isExtglob,
        isGlobstar,
        negated
      };
      if (opts.tokens === true) {
        state.maxDepth = 0;
        if (!isPathSeparator(code)) {
          tokens.push(token);
        }
        state.tokens = tokens;
      }
      if (opts.parts === true || opts.tokens === true) {
        let prevIndex;
        for (let idx = 0; idx < slashes.length; idx++) {
          const n = prevIndex ? prevIndex + 1 : start;
          const i = slashes[idx];
          const value = input.slice(n, i);
          if (opts.tokens) {
            if (idx === 0 && start !== 0) {
              tokens[idx].isPrefix = true;
              tokens[idx].value = prefix;
            } else {
              tokens[idx].value = value;
            }
            depth(tokens[idx]);
            state.maxDepth += tokens[idx].depth;
          }
          if (idx !== 0 || value !== "") {
            parts.push(value);
          }
          prevIndex = i;
        }
        if (prevIndex && prevIndex + 1 < input.length) {
          const value = input.slice(prevIndex + 1);
          parts.push(value);
          if (opts.tokens) {
            tokens[tokens.length - 1].value = value;
            depth(tokens[tokens.length - 1]);
            state.maxDepth += tokens[tokens.length - 1].depth;
          }
        }
        state.slashes = slashes;
        state.parts = parts;
      }
      return state;
    }, "scan");
    module.exports = scan;
  }
});

// node_modules/picomatch-browser/lib/parse.js
var require_parse = __commonJS({
  "node_modules/picomatch-browser/lib/parse.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var constants = require_constants();
    var utils = require_utils();
    var {
      MAX_LENGTH,
      POSIX_REGEX_SOURCE,
      REGEX_NON_SPECIAL_CHARS,
      REGEX_SPECIAL_CHARS_BACKREF,
      REPLACEMENTS
    } = constants;
    var expandRange = /* @__PURE__ */ __name((args, options) => {
      if (typeof options.expandRange === "function") {
        return options.expandRange(...args, options);
      }
      args.sort();
      const value = `[${args.join("-")}]`;
      try {
        new RegExp(value);
      } catch (ex) {
        return args.map((v) => utils.escapeRegex(v)).join("..");
      }
      return value;
    }, "expandRange");
    var syntaxError = /* @__PURE__ */ __name((type, char) => {
      return `Missing ${type}: "${char}" - use "\\\\${char}" to match literal characters`;
    }, "syntaxError");
    var parse2 = /* @__PURE__ */ __name((input, options) => {
      if (typeof input !== "string") {
        throw new TypeError("Expected a string");
      }
      input = REPLACEMENTS[input] || input;
      const opts = { ...options };
      const max = typeof opts.maxLength === "number" ? Math.min(MAX_LENGTH, opts.maxLength) : MAX_LENGTH;
      let len = input.length;
      if (len > max) {
        throw new SyntaxError(`Input length: ${len}, exceeds maximum allowed length: ${max}`);
      }
      const bos = { type: "bos", value: "", output: opts.prepend || "" };
      const tokens = [bos];
      const capture = opts.capture ? "" : "?:";
      const PLATFORM_CHARS = constants.globChars(opts.windows);
      const EXTGLOB_CHARS = constants.extglobChars(PLATFORM_CHARS);
      const {
        DOT_LITERAL,
        PLUS_LITERAL,
        SLASH_LITERAL,
        ONE_CHAR,
        DOTS_SLASH,
        NO_DOT,
        NO_DOT_SLASH,
        NO_DOTS_SLASH,
        QMARK,
        QMARK_NO_DOT,
        STAR,
        START_ANCHOR
      } = PLATFORM_CHARS;
      const globstar = /* @__PURE__ */ __name((opts2) => {
        return `(${capture}(?:(?!${START_ANCHOR}${opts2.dot ? DOTS_SLASH : DOT_LITERAL}).)*?)`;
      }, "globstar");
      const nodot = opts.dot ? "" : NO_DOT;
      const qmarkNoDot = opts.dot ? QMARK : QMARK_NO_DOT;
      let star = opts.bash === true ? globstar(opts) : STAR;
      if (opts.capture) {
        star = `(${star})`;
      }
      if (typeof opts.noext === "boolean") {
        opts.noextglob = opts.noext;
      }
      const state = {
        input,
        index: -1,
        start: 0,
        dot: opts.dot === true,
        consumed: "",
        output: "",
        prefix: "",
        backtrack: false,
        negated: false,
        brackets: 0,
        braces: 0,
        parens: 0,
        quotes: 0,
        globstar: false,
        tokens
      };
      input = utils.removePrefix(input, state);
      len = input.length;
      const extglobs = [];
      const braces = [];
      const stack = [];
      let prev = bos;
      let value;
      const eos = /* @__PURE__ */ __name(() => state.index === len - 1, "eos");
      const peek = state.peek = (n = 1) => input[state.index + n];
      const advance = state.advance = () => input[++state.index];
      const remaining = /* @__PURE__ */ __name(() => input.slice(state.index + 1), "remaining");
      const consume = /* @__PURE__ */ __name((value2 = "", num = 0) => {
        state.consumed += value2;
        state.index += num;
      }, "consume");
      const append = /* @__PURE__ */ __name((token) => {
        state.output += token.output != null ? token.output : token.value;
        consume(token.value);
      }, "append");
      const negate = /* @__PURE__ */ __name(() => {
        let count = 1;
        while (peek() === "!" && (peek(2) !== "(" || peek(3) === "?")) {
          advance();
          state.start++;
          count++;
        }
        if (count % 2 === 0) {
          return false;
        }
        state.negated = true;
        state.start++;
        return true;
      }, "negate");
      const increment = /* @__PURE__ */ __name((type) => {
        state[type]++;
        stack.push(type);
      }, "increment");
      const decrement = /* @__PURE__ */ __name((type) => {
        state[type]--;
        stack.pop();
      }, "decrement");
      const push = /* @__PURE__ */ __name((tok) => {
        if (prev.type === "globstar") {
          const isBrace = state.braces > 0 && (tok.type === "comma" || tok.type === "brace");
          const isExtglob = tok.extglob === true || extglobs.length && (tok.type === "pipe" || tok.type === "paren");
          if (tok.type !== "slash" && tok.type !== "paren" && !isBrace && !isExtglob) {
            state.output = state.output.slice(0, -prev.output.length);
            prev.type = "star";
            prev.value = "*";
            prev.output = star;
            state.output += prev.output;
          }
        }
        if (extglobs.length && tok.type !== "paren" && !EXTGLOB_CHARS[tok.value]) {
          extglobs[extglobs.length - 1].inner += tok.value;
        }
        if (tok.value || tok.output) append(tok);
        if (prev && prev.type === "text" && tok.type === "text") {
          prev.value += tok.value;
          prev.output = (prev.output || "") + tok.value;
          return;
        }
        tok.prev = prev;
        tokens.push(tok);
        prev = tok;
      }, "push");
      const extglobOpen = /* @__PURE__ */ __name((type, value2) => {
        const token = { ...EXTGLOB_CHARS[value2], conditions: 1, inner: "" };
        token.prev = prev;
        token.parens = state.parens;
        token.output = state.output;
        const output = (opts.capture ? "(" : "") + token.open;
        increment("parens");
        push({ type, value: value2, output: state.output ? "" : ONE_CHAR });
        push({ type: "paren", extglob: true, value: advance(), output });
        extglobs.push(token);
      }, "extglobOpen");
      const extglobClose = /* @__PURE__ */ __name((token) => {
        let output = token.close + (opts.capture ? ")" : "");
        if (token.type === "negate") {
          let extglobStar = star;
          if (token.inner && token.inner.length > 1 && token.inner.includes("/")) {
            extglobStar = globstar(opts);
          }
          if (extglobStar !== star || eos() || /^\)+$/.test(remaining())) {
            output = token.close = `)$))${extglobStar}`;
          }
          if (token.prev.type === "bos" && eos()) {
            state.negatedExtglob = true;
          }
        }
        push({ type: "paren", extglob: true, value, output });
        decrement("parens");
      }, "extglobClose");
      if (opts.fastpaths !== false && !/(^[*!]|[/()[\]{}"])/.test(input)) {
        let backslashes = false;
        let output = input.replace(REGEX_SPECIAL_CHARS_BACKREF, (m, esc, chars, first, rest, index) => {
          if (first === "\\") {
            backslashes = true;
            return m;
          }
          if (first === "?") {
            if (esc) {
              return esc + first + (rest ? QMARK.repeat(rest.length) : "");
            }
            if (index === 0) {
              return qmarkNoDot + (rest ? QMARK.repeat(rest.length) : "");
            }
            return QMARK.repeat(chars.length);
          }
          if (first === ".") {
            return DOT_LITERAL.repeat(chars.length);
          }
          if (first === "*") {
            if (esc) {
              return esc + first + (rest ? star : "");
            }
            return star;
          }
          return esc ? m : `\\${m}`;
        });
        if (backslashes === true) {
          if (opts.unescape === true) {
            output = output.replace(/\\/g, "");
          } else {
            output = output.replace(/\\+/g, (m) => {
              return m.length % 2 === 0 ? "\\\\" : m ? "\\" : "";
            });
          }
        }
        if (output === input && opts.contains === true) {
          state.output = input;
          return state;
        }
        state.output = utils.wrapOutput(output, state, options);
        return state;
      }
      while (!eos()) {
        value = advance();
        if (value === "\0") {
          continue;
        }
        if (value === "\\") {
          const next = peek();
          if (next === "/" && opts.bash !== true) {
            continue;
          }
          if (next === "." || next === ";") {
            continue;
          }
          if (!next) {
            value += "\\";
            push({ type: "text", value });
            continue;
          }
          const match = /^\\+/.exec(remaining());
          let slashes = 0;
          if (match && match[0].length > 2) {
            slashes = match[0].length;
            state.index += slashes;
            if (slashes % 2 !== 0) {
              value += "\\";
            }
          }
          if (opts.unescape === true) {
            value = advance() || "";
          } else {
            value += advance() || "";
          }
          if (state.brackets === 0) {
            push({ type: "text", value });
            continue;
          }
        }
        if (state.brackets > 0 && (value !== "]" || prev.value === "[" || prev.value === "[^")) {
          if (opts.posix !== false && value === ":") {
            const inner = prev.value.slice(1);
            if (inner.includes("[")) {
              prev.posix = true;
              if (inner.includes(":")) {
                const idx = prev.value.lastIndexOf("[");
                const pre = prev.value.slice(0, idx);
                const rest2 = prev.value.slice(idx + 2);
                const posix = POSIX_REGEX_SOURCE[rest2];
                if (posix) {
                  prev.value = pre + posix;
                  state.backtrack = true;
                  advance();
                  if (!bos.output && tokens.indexOf(prev) === 1) {
                    bos.output = ONE_CHAR;
                  }
                  continue;
                }
              }
            }
          }
          if (value === "[" && peek() !== ":" || value === "-" && peek() === "]") {
            value = `\\${value}`;
          }
          if (value === "]" && (prev.value === "[" || prev.value === "[^")) {
            value = `\\${value}`;
          }
          if (opts.posix === true && value === "!" && prev.value === "[") {
            value = "^";
          }
          prev.value += value;
          append({ value });
          continue;
        }
        if (state.quotes === 1 && value !== '"') {
          value = utils.escapeRegex(value);
          prev.value += value;
          append({ value });
          continue;
        }
        if (value === '"') {
          state.quotes = state.quotes === 1 ? 0 : 1;
          if (opts.keepQuotes === true) {
            push({ type: "text", value });
          }
          continue;
        }
        if (value === "(") {
          increment("parens");
          push({ type: "paren", value });
          continue;
        }
        if (value === ")") {
          if (state.parens === 0 && opts.strictBrackets === true) {
            throw new SyntaxError(syntaxError("opening", "("));
          }
          const extglob = extglobs[extglobs.length - 1];
          if (extglob && state.parens === extglob.parens + 1) {
            extglobClose(extglobs.pop());
            continue;
          }
          push({ type: "paren", value, output: state.parens ? ")" : "\\)" });
          decrement("parens");
          continue;
        }
        if (value === "[") {
          if (opts.nobracket === true || !remaining().includes("]")) {
            if (opts.nobracket !== true && opts.strictBrackets === true) {
              throw new SyntaxError(syntaxError("closing", "]"));
            }
            value = `\\${value}`;
          } else {
            increment("brackets");
          }
          push({ type: "bracket", value });
          continue;
        }
        if (value === "]") {
          if (opts.nobracket === true || prev && prev.type === "bracket" && prev.value.length === 1) {
            push({ type: "text", value, output: `\\${value}` });
            continue;
          }
          if (state.brackets === 0) {
            if (opts.strictBrackets === true) {
              throw new SyntaxError(syntaxError("opening", "["));
            }
            push({ type: "text", value, output: `\\${value}` });
            continue;
          }
          decrement("brackets");
          const prevValue = prev.value.slice(1);
          if (prev.posix !== true && prevValue[0] === "^" && !prevValue.includes("/")) {
            value = `/${value}`;
          }
          prev.value += value;
          append({ value });
          if (opts.literalBrackets === false || utils.hasRegexChars(prevValue)) {
            continue;
          }
          const escaped = utils.escapeRegex(prev.value);
          state.output = state.output.slice(0, -prev.value.length);
          if (opts.literalBrackets === true) {
            state.output += escaped;
            prev.value = escaped;
            continue;
          }
          prev.value = `(${capture}${escaped}|${prev.value})`;
          state.output += prev.value;
          continue;
        }
        if (value === "{" && opts.nobrace !== true) {
          increment("braces");
          const open = {
            type: "brace",
            value,
            output: "(",
            outputIndex: state.output.length,
            tokensIndex: state.tokens.length
          };
          braces.push(open);
          push(open);
          continue;
        }
        if (value === "}") {
          const brace = braces[braces.length - 1];
          if (opts.nobrace === true || !brace) {
            push({ type: "text", value, output: value });
            continue;
          }
          let output = ")";
          if (brace.dots === true) {
            const arr = tokens.slice();
            const range = [];
            for (let i = arr.length - 1; i >= 0; i--) {
              tokens.pop();
              if (arr[i].type === "brace") {
                break;
              }
              if (arr[i].type !== "dots") {
                range.unshift(arr[i].value);
              }
            }
            output = expandRange(range, opts);
            state.backtrack = true;
          }
          if (brace.comma !== true && brace.dots !== true) {
            const out = state.output.slice(0, brace.outputIndex);
            const toks = state.tokens.slice(brace.tokensIndex);
            brace.value = brace.output = "\\{";
            value = output = "\\}";
            state.output = out;
            for (const t of toks) {
              state.output += t.output || t.value;
            }
          }
          push({ type: "brace", value, output });
          decrement("braces");
          braces.pop();
          continue;
        }
        if (value === "|") {
          if (extglobs.length > 0) {
            extglobs[extglobs.length - 1].conditions++;
          }
          push({ type: "text", value });
          continue;
        }
        if (value === ",") {
          let output = value;
          const brace = braces[braces.length - 1];
          if (brace && stack[stack.length - 1] === "braces") {
            brace.comma = true;
            output = "|";
          }
          push({ type: "comma", value, output });
          continue;
        }
        if (value === "/") {
          if (prev.type === "dot" && state.index === state.start + 1) {
            state.start = state.index + 1;
            state.consumed = "";
            state.output = "";
            tokens.pop();
            prev = bos;
            continue;
          }
          push({ type: "slash", value, output: SLASH_LITERAL });
          continue;
        }
        if (value === ".") {
          if (state.braces > 0 && prev.type === "dot") {
            if (prev.value === ".") prev.output = DOT_LITERAL;
            const brace = braces[braces.length - 1];
            prev.type = "dots";
            prev.output += value;
            prev.value += value;
            brace.dots = true;
            continue;
          }
          if (state.braces + state.parens === 0 && prev.type !== "bos" && prev.type !== "slash") {
            push({ type: "text", value, output: DOT_LITERAL });
            continue;
          }
          push({ type: "dot", value, output: DOT_LITERAL });
          continue;
        }
        if (value === "?") {
          const isGroup = prev && prev.value === "(";
          if (!isGroup && opts.noextglob !== true && peek() === "(" && peek(2) !== "?") {
            extglobOpen("qmark", value);
            continue;
          }
          if (prev && prev.type === "paren") {
            const next = peek();
            let output = value;
            if (next === "<" && !utils.supportsLookbehinds()) {
              throw new Error("Node.js v10 or higher is required for regex lookbehinds");
            }
            if (prev.value === "(" && !/[!=<:]/.test(next) || next === "<" && !/<([!=]|\w+>)/.test(remaining())) {
              output = `\\${value}`;
            }
            push({ type: "text", value, output });
            continue;
          }
          if (opts.dot !== true && (prev.type === "slash" || prev.type === "bos")) {
            push({ type: "qmark", value, output: QMARK_NO_DOT });
            continue;
          }
          push({ type: "qmark", value, output: QMARK });
          continue;
        }
        if (value === "!") {
          if (opts.noextglob !== true && peek() === "(") {
            if (peek(2) !== "?" || !/[!=<:]/.test(peek(3))) {
              extglobOpen("negate", value);
              continue;
            }
          }
          if (opts.nonegate !== true && state.index === 0) {
            negate();
            continue;
          }
        }
        if (value === "+") {
          if (opts.noextglob !== true && peek() === "(" && peek(2) !== "?") {
            extglobOpen("plus", value);
            continue;
          }
          if (prev && prev.value === "(" || opts.regex === false) {
            push({ type: "plus", value, output: PLUS_LITERAL });
            continue;
          }
          if (prev && (prev.type === "bracket" || prev.type === "paren" || prev.type === "brace") || state.parens > 0) {
            push({ type: "plus", value });
            continue;
          }
          push({ type: "plus", value: PLUS_LITERAL });
          continue;
        }
        if (value === "@") {
          if (opts.noextglob !== true && peek() === "(" && peek(2) !== "?") {
            push({ type: "at", extglob: true, value, output: "" });
            continue;
          }
          push({ type: "text", value });
          continue;
        }
        if (value !== "*") {
          if (value === "$" || value === "^") {
            value = `\\${value}`;
          }
          const match = REGEX_NON_SPECIAL_CHARS.exec(remaining());
          if (match) {
            value += match[0];
            state.index += match[0].length;
          }
          push({ type: "text", value });
          continue;
        }
        if (prev && (prev.type === "globstar" || prev.star === true)) {
          prev.type = "star";
          prev.star = true;
          prev.value += value;
          prev.output = star;
          state.backtrack = true;
          state.globstar = true;
          consume(value);
          continue;
        }
        let rest = remaining();
        if (opts.noextglob !== true && /^\([^?]/.test(rest)) {
          extglobOpen("star", value);
          continue;
        }
        if (prev.type === "star") {
          if (opts.noglobstar === true) {
            consume(value);
            continue;
          }
          const prior = prev.prev;
          const before = prior.prev;
          const isStart = prior.type === "slash" || prior.type === "bos";
          const afterStar = before && (before.type === "star" || before.type === "globstar");
          if (opts.bash === true && (!isStart || rest[0] && rest[0] !== "/")) {
            push({ type: "star", value, output: "" });
            continue;
          }
          const isBrace = state.braces > 0 && (prior.type === "comma" || prior.type === "brace");
          const isExtglob = extglobs.length && (prior.type === "pipe" || prior.type === "paren");
          if (!isStart && prior.type !== "paren" && !isBrace && !isExtglob) {
            push({ type: "star", value, output: "" });
            continue;
          }
          while (rest.slice(0, 3) === "/**") {
            const after = input[state.index + 4];
            if (after && after !== "/") {
              break;
            }
            rest = rest.slice(3);
            consume("/**", 3);
          }
          if (prior.type === "bos" && eos()) {
            prev.type = "globstar";
            prev.value += value;
            prev.output = globstar(opts);
            state.output = prev.output;
            state.globstar = true;
            consume(value);
            continue;
          }
          if (prior.type === "slash" && prior.prev.type !== "bos" && !afterStar && eos()) {
            state.output = state.output.slice(0, -(prior.output + prev.output).length);
            prior.output = `(?:${prior.output}`;
            prev.type = "globstar";
            prev.output = globstar(opts) + (opts.strictSlashes ? ")" : "|$)");
            prev.value += value;
            state.globstar = true;
            state.output += prior.output + prev.output;
            consume(value);
            continue;
          }
          if (prior.type === "slash" && prior.prev.type !== "bos" && rest[0] === "/") {
            const end = rest[1] !== void 0 ? "|$" : "";
            state.output = state.output.slice(0, -(prior.output + prev.output).length);
            prior.output = `(?:${prior.output}`;
            prev.type = "globstar";
            prev.output = `${globstar(opts)}${SLASH_LITERAL}|${SLASH_LITERAL}${end})`;
            prev.value += value;
            state.output += prior.output + prev.output;
            state.globstar = true;
            consume(value + advance());
            push({ type: "slash", value: "/", output: "" });
            continue;
          }
          if (prior.type === "bos" && rest[0] === "/") {
            prev.type = "globstar";
            prev.value += value;
            prev.output = `(?:^|${SLASH_LITERAL}|${globstar(opts)}${SLASH_LITERAL})`;
            state.output = prev.output;
            state.globstar = true;
            consume(value + advance());
            push({ type: "slash", value: "/", output: "" });
            continue;
          }
          state.output = state.output.slice(0, -prev.output.length);
          prev.type = "globstar";
          prev.output = globstar(opts);
          prev.value += value;
          state.output += prev.output;
          state.globstar = true;
          consume(value);
          continue;
        }
        const token = { type: "star", value, output: star };
        if (opts.bash === true) {
          token.output = ".*?";
          if (prev.type === "bos" || prev.type === "slash") {
            token.output = nodot + token.output;
          }
          push(token);
          continue;
        }
        if (prev && (prev.type === "bracket" || prev.type === "paren") && opts.regex === true) {
          token.output = value;
          push(token);
          continue;
        }
        if (state.index === state.start || prev.type === "slash" || prev.type === "dot") {
          if (prev.type === "dot") {
            state.output += NO_DOT_SLASH;
            prev.output += NO_DOT_SLASH;
          } else if (opts.dot === true) {
            state.output += NO_DOTS_SLASH;
            prev.output += NO_DOTS_SLASH;
          } else {
            state.output += nodot;
            prev.output += nodot;
          }
          if (peek() !== "*") {
            state.output += ONE_CHAR;
            prev.output += ONE_CHAR;
          }
        }
        push(token);
      }
      while (state.brackets > 0) {
        if (opts.strictBrackets === true) throw new SyntaxError(syntaxError("closing", "]"));
        state.output = utils.escapeLast(state.output, "[");
        decrement("brackets");
      }
      while (state.parens > 0) {
        if (opts.strictBrackets === true) throw new SyntaxError(syntaxError("closing", ")"));
        state.output = utils.escapeLast(state.output, "(");
        decrement("parens");
      }
      while (state.braces > 0) {
        if (opts.strictBrackets === true) throw new SyntaxError(syntaxError("closing", "}"));
        state.output = utils.escapeLast(state.output, "{");
        decrement("braces");
      }
      if (opts.strictSlashes !== true && (prev.type === "star" || prev.type === "bracket")) {
        push({ type: "maybe_slash", value: "", output: `${SLASH_LITERAL}?` });
      }
      if (state.backtrack === true) {
        state.output = "";
        for (const token of state.tokens) {
          state.output += token.output != null ? token.output : token.value;
          if (token.suffix) {
            state.output += token.suffix;
          }
        }
      }
      return state;
    }, "parse");
    parse2.fastpaths = (input, options) => {
      const opts = { ...options };
      const max = typeof opts.maxLength === "number" ? Math.min(MAX_LENGTH, opts.maxLength) : MAX_LENGTH;
      const len = input.length;
      if (len > max) {
        throw new SyntaxError(`Input length: ${len}, exceeds maximum allowed length: ${max}`);
      }
      input = REPLACEMENTS[input] || input;
      const {
        DOT_LITERAL,
        SLASH_LITERAL,
        ONE_CHAR,
        DOTS_SLASH,
        NO_DOT,
        NO_DOTS,
        NO_DOTS_SLASH,
        STAR,
        START_ANCHOR
      } = constants.globChars(opts.windows);
      const nodot = opts.dot ? NO_DOTS : NO_DOT;
      const slashDot = opts.dot ? NO_DOTS_SLASH : NO_DOT;
      const capture = opts.capture ? "" : "?:";
      const state = { negated: false, prefix: "" };
      let star = opts.bash === true ? ".*?" : STAR;
      if (opts.capture) {
        star = `(${star})`;
      }
      const globstar = /* @__PURE__ */ __name((opts2) => {
        if (opts2.noglobstar === true) return star;
        return `(${capture}(?:(?!${START_ANCHOR}${opts2.dot ? DOTS_SLASH : DOT_LITERAL}).)*?)`;
      }, "globstar");
      const create = /* @__PURE__ */ __name((str) => {
        switch (str) {
          case "*":
            return `${nodot}${ONE_CHAR}${star}`;
          case ".*":
            return `${DOT_LITERAL}${ONE_CHAR}${star}`;
          case "*.*":
            return `${nodot}${star}${DOT_LITERAL}${ONE_CHAR}${star}`;
          case "*/*":
            return `${nodot}${star}${SLASH_LITERAL}${ONE_CHAR}${slashDot}${star}`;
          case "**":
            return nodot + globstar(opts);
          case "**/*":
            return `(?:${nodot}${globstar(opts)}${SLASH_LITERAL})?${slashDot}${ONE_CHAR}${star}`;
          case "**/*.*":
            return `(?:${nodot}${globstar(opts)}${SLASH_LITERAL})?${slashDot}${star}${DOT_LITERAL}${ONE_CHAR}${star}`;
          case "**/.*":
            return `(?:${nodot}${globstar(opts)}${SLASH_LITERAL})?${DOT_LITERAL}${ONE_CHAR}${star}`;
          default: {
            const match = /^(.*?)\.(\w+)$/.exec(str);
            if (!match) return;
            const source2 = create(match[1]);
            if (!source2) return;
            return source2 + DOT_LITERAL + match[2];
          }
        }
      }, "create");
      const output = utils.removePrefix(input, state);
      let source = create(output);
      if (source && opts.strictSlashes !== true) {
        source += `${SLASH_LITERAL}?`;
      }
      return source;
    };
    module.exports = parse2;
  }
});

// node_modules/picomatch-browser/lib/picomatch.js
var require_picomatch = __commonJS({
  "node_modules/picomatch-browser/lib/picomatch.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var scan = require_scan();
    var parse2 = require_parse();
    var utils = require_utils();
    var constants = require_constants();
    var isObject = /* @__PURE__ */ __name((val) => val && typeof val === "object" && !Array.isArray(val), "isObject");
    var picomatch = /* @__PURE__ */ __name((glob, options, returnState = false) => {
      if (Array.isArray(glob)) {
        const fns = glob.map((input) => picomatch(input, options, returnState));
        const arrayMatcher = /* @__PURE__ */ __name((str) => {
          for (const isMatch of fns) {
            const state2 = isMatch(str);
            if (state2) return state2;
          }
          return false;
        }, "arrayMatcher");
        return arrayMatcher;
      }
      const isState = isObject(glob) && glob.tokens && glob.input;
      if (glob === "" || typeof glob !== "string" && !isState) {
        throw new TypeError("Expected pattern to be a non-empty string");
      }
      const opts = options || {};
      const posix = opts.windows;
      const regex = isState ? picomatch.compileRe(glob, options) : picomatch.makeRe(glob, options, false, true);
      const state = regex.state;
      delete regex.state;
      let isIgnored = /* @__PURE__ */ __name(() => false, "isIgnored");
      if (opts.ignore) {
        const ignoreOpts = { ...options, ignore: null, onMatch: null, onResult: null };
        isIgnored = picomatch(opts.ignore, ignoreOpts, returnState);
      }
      const matcher = /* @__PURE__ */ __name((input, returnObject = false) => {
        const { isMatch, match, output } = picomatch.test(input, regex, options, { glob, posix });
        const result = { glob, state, regex, posix, input, output, match, isMatch };
        if (typeof opts.onResult === "function") {
          opts.onResult(result);
        }
        if (isMatch === false) {
          result.isMatch = false;
          return returnObject ? result : false;
        }
        if (isIgnored(input)) {
          if (typeof opts.onIgnore === "function") {
            opts.onIgnore(result);
          }
          result.isMatch = false;
          return returnObject ? result : false;
        }
        if (typeof opts.onMatch === "function") {
          opts.onMatch(result);
        }
        return returnObject ? result : true;
      }, "matcher");
      if (returnState) {
        matcher.state = state;
      }
      return matcher;
    }, "picomatch");
    picomatch.test = (input, regex, options, { glob, posix } = {}) => {
      if (typeof input !== "string") {
        throw new TypeError("Expected input to be a string");
      }
      if (input === "") {
        return { isMatch: false, output: "" };
      }
      const opts = options || {};
      const format = opts.format || (posix ? utils.toPosixSlashes : null);
      let match = input === glob;
      let output = match && format ? format(input) : input;
      if (match === false) {
        output = format ? format(input) : input;
        match = output === glob;
      }
      if (match === false || opts.capture === true) {
        if (opts.matchBase === true || opts.basename === true) {
          match = picomatch.matchBase(input, regex, options, posix);
        } else {
          match = regex.exec(output);
        }
      }
      return { isMatch: Boolean(match), match, output };
    };
    picomatch.matchBase = (input, glob, options) => {
      const regex = glob instanceof RegExp ? glob : picomatch.makeRe(glob, options);
      return regex.test(utils.basename(input));
    };
    picomatch.isMatch = (str, patterns, options) => picomatch(patterns, options)(str);
    picomatch.parse = (pattern, options) => {
      if (Array.isArray(pattern)) return pattern.map((p) => picomatch.parse(p, options));
      return parse2(pattern, { ...options, fastpaths: false });
    };
    picomatch.scan = (input, options) => scan(input, options);
    picomatch.compileRe = (parsed, options, returnOutput = false, returnState = false) => {
      if (returnOutput === true) {
        return parsed.output;
      }
      const opts = options || {};
      const prepend = opts.contains ? "" : "^";
      const append = opts.contains ? "" : "$";
      let source = `${prepend}(?:${parsed.output})${append}`;
      if (parsed && parsed.negated === true) {
        source = `^(?!${source}).*$`;
      }
      const regex = picomatch.toRegex(source, options);
      if (returnState === true) {
        regex.state = parsed;
      }
      return regex;
    };
    picomatch.makeRe = (input, options, returnOutput = false, returnState = false) => {
      if (!input || typeof input !== "string") {
        throw new TypeError("Expected a non-empty string");
      }
      const opts = options || {};
      let parsed = { negated: false, fastpaths: true };
      let prefix = "";
      let output;
      if (input.startsWith("./")) {
        input = input.slice(2);
        prefix = parsed.prefix = "./";
      }
      if (opts.fastpaths !== false && (input[0] === "." || input[0] === "*")) {
        output = parse2.fastpaths(input, options);
      }
      if (output === void 0) {
        parsed = parse2(input, options);
        parsed.prefix = prefix + (parsed.prefix || "");
      } else {
        parsed.output = output;
      }
      return picomatch.compileRe(parsed, options, returnOutput, returnState);
    };
    picomatch.toRegex = (source, options) => {
      try {
        const opts = options || {};
        return new RegExp(source, opts.flags || (opts.nocase ? "i" : ""));
      } catch (err) {
        if (options && options.debug === true) throw err;
        return /$^/;
      }
    };
    picomatch.constants = constants;
    module.exports = picomatch;
  }
});

// node_modules/picomatch-browser/index.js
var require_picomatch_browser = __commonJS({
  "node_modules/picomatch-browser/index.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    module.exports = require_picomatch();
  }
});

// packages/channels/gitlab/dist/index.js
init_esbuild_shims();

// packages/channels/gitlab/dist/GitlabAdapter.js
init_esbuild_shims();
import process2 from "node:process";

// node_modules/@gitbeaker/rest/dist/index.mjs
init_esbuild_shims();

// node_modules/@gitbeaker/core/dist/index.mjs
var dist_exports = {};
__export(dist_exports, {
  AccessLevel: () => AccessLevel,
  Agents: () => Agents,
  AlertManagement: () => AlertManagement,
  ApplicationAppearance: () => ApplicationAppearance,
  ApplicationPlanLimits: () => ApplicationPlanLimits,
  ApplicationSettings: () => ApplicationSettings,
  ApplicationStatistics: () => ApplicationStatistics,
  Applications: () => Applications,
  AuditEvents: () => AuditEvents,
  Avatar: () => Avatar,
  Branches: () => Branches,
  BroadcastMessages: () => BroadcastMessages,
  CodeSuggestions: () => CodeSuggestions,
  CommitDiscussions: () => CommitDiscussions,
  Commits: () => Commits,
  Composer: () => Composer,
  Conan: () => Conan,
  ContainerRegistry: () => ContainerRegistry,
  DashboardAnnotations: () => DashboardAnnotations,
  Debian: () => Debian,
  DependencyProxy: () => DependencyProxy,
  DeployKeys: () => DeployKeys,
  DeployTokens: () => DeployTokens,
  Deployments: () => Deployments,
  DockerfileTemplates: () => DockerfileTemplates,
  Environments: () => Environments,
  EpicAwardEmojis: () => EpicAwardEmojis,
  EpicDiscussions: () => EpicDiscussions,
  EpicIssues: () => EpicIssues,
  EpicLabelEvents: () => EpicLabelEvents,
  EpicLinks: () => EpicLinks,
  EpicNotes: () => EpicNotes,
  Epics: () => Epics,
  ErrorTrackingClientKeys: () => ErrorTrackingClientKeys,
  ErrorTrackingSettings: () => ErrorTrackingSettings,
  Events: () => Events,
  Experiments: () => Experiments,
  ExternalStatusChecks: () => ExternalStatusChecks,
  FeatureFlagUserLists: () => FeatureFlagUserLists,
  FeatureFlags: () => FeatureFlags,
  FreezePeriods: () => FreezePeriods,
  GeoNodes: () => GeoNodes,
  GeoSites: () => GeoSites,
  GitLabCIYMLTemplates: () => GitLabCIYMLTemplates,
  GitignoreTemplates: () => GitignoreTemplates,
  Gitlab: () => Gitlab,
  GitlabPages: () => GitlabPages,
  GoProxy: () => GoProxy,
  GroupAccessRequests: () => GroupAccessRequests,
  GroupAccessTokens: () => GroupAccessTokens,
  GroupActivityAnalytics: () => GroupActivityAnalytics,
  GroupBadges: () => GroupBadges,
  GroupCustomAttributes: () => GroupCustomAttributes,
  GroupDORA4Metrics: () => GroupDORA4Metrics,
  GroupEpicBoards: () => GroupEpicBoards,
  GroupHooks: () => GroupHooks,
  GroupImportExports: () => GroupImportExports,
  GroupInvitations: () => GroupInvitations,
  GroupIssueBoards: () => GroupIssueBoards,
  GroupIterations: () => GroupIterations,
  GroupLDAPLinks: () => GroupLDAPLinks,
  GroupLabels: () => GroupLabels,
  GroupMemberRoles: () => GroupMemberRoles,
  GroupMembers: () => GroupMembers,
  GroupMilestones: () => GroupMilestones,
  GroupProtectedEnvironments: () => GroupProtectedEnvironments,
  GroupPushRules: () => GroupPushRules,
  GroupRelationExports: () => GroupRelationExports,
  GroupReleases: () => GroupReleases,
  GroupRepositoryStorageMoves: () => GroupRepositoryStorageMoves,
  GroupSAMLIdentities: () => GroupSAMLIdentities,
  GroupSAMLLinks: () => GroupSAMLLinks,
  GroupSCIMIdentities: () => GroupSCIMIdentities,
  GroupServiceAccounts: () => GroupServiceAccounts,
  GroupVariables: () => GroupVariables,
  GroupWikis: () => GroupWikis,
  Groups: () => Groups,
  Helm: () => Helm,
  Import: () => Import,
  InstanceLevelCICDVariables: () => InstanceLevelCICDVariables,
  Integrations: () => Integrations,
  IssueAwardEmojis: () => IssueAwardEmojis,
  IssueDiscussions: () => IssueDiscussions,
  IssueIterationEvents: () => IssueIterationEvents,
  IssueLabelEvents: () => IssueLabelEvents,
  IssueLinks: () => IssueLinks,
  IssueMilestoneEvents: () => IssueMilestoneEvents,
  IssueNoteAwardEmojis: () => IssueNoteAwardEmojis,
  IssueNotes: () => IssueNotes,
  IssueStateEvents: () => IssueStateEvents,
  IssueWeightEvents: () => IssueWeightEvents,
  Issues: () => Issues,
  IssuesStatistics: () => IssuesStatistics,
  JobArtifacts: () => JobArtifacts,
  Jobs: () => Jobs,
  Keys: () => Keys,
  License: () => License,
  LicenseTemplates: () => LicenseTemplates,
  LinkedEpics: () => LinkedEpics,
  Lint: () => Lint,
  Markdown: () => Markdown,
  Maven: () => Maven,
  MergeRequestApprovals: () => MergeRequestApprovals,
  MergeRequestAwardEmojis: () => MergeRequestAwardEmojis,
  MergeRequestContextCommits: () => MergeRequestContextCommits,
  MergeRequestDiscussions: () => MergeRequestDiscussions,
  MergeRequestDraftNotes: () => MergeRequestDraftNotes,
  MergeRequestLabelEvents: () => MergeRequestLabelEvents,
  MergeRequestMilestoneEvents: () => MergeRequestMilestoneEvents,
  MergeRequestNoteAwardEmojis: () => MergeRequestNoteAwardEmojis,
  MergeRequestNotes: () => MergeRequestNotes,
  MergeRequests: () => MergeRequests,
  MergeTrains: () => MergeTrains,
  Metadata: () => Metadata,
  Migrations: () => Migrations,
  NPM: () => NPM,
  Namespaces: () => Namespaces,
  NotificationSettings: () => NotificationSettings,
  NuGet: () => NuGet,
  PackageRegistry: () => PackageRegistry,
  Packages: () => Packages,
  PagesDomains: () => PagesDomains,
  PersonalAccessTokens: () => PersonalAccessTokens,
  PipelineScheduleVariables: () => PipelineScheduleVariables,
  PipelineSchedules: () => PipelineSchedules,
  PipelineTriggerTokens: () => PipelineTriggerTokens,
  Pipelines: () => Pipelines,
  ProductAnalytics: () => ProductAnalytics,
  ProjectAccessRequests: () => ProjectAccessRequests,
  ProjectAccessTokens: () => ProjectAccessTokens,
  ProjectAliases: () => ProjectAliases,
  ProjectBadges: () => ProjectBadges,
  ProjectCustomAttributes: () => ProjectCustomAttributes,
  ProjectDORA4Metrics: () => ProjectDORA4Metrics,
  ProjectHooks: () => ProjectHooks,
  ProjectImportExports: () => ProjectImportExports,
  ProjectInvitations: () => ProjectInvitations,
  ProjectIssueBoards: () => ProjectIssueBoards,
  ProjectIterations: () => ProjectIterations,
  ProjectJobTokenScopes: () => ProjectJobTokenScopes,
  ProjectLabels: () => ProjectLabels,
  ProjectMembers: () => ProjectMembers,
  ProjectMilestones: () => ProjectMilestones,
  ProjectProtectedEnvironments: () => ProjectProtectedEnvironments,
  ProjectPushRules: () => ProjectPushRules,
  ProjectRelationsExport: () => ProjectRelationsExport,
  ProjectReleases: () => ProjectReleases,
  ProjectRemoteMirrors: () => ProjectRemoteMirrors,
  ProjectRepositoryStorageMoves: () => ProjectRepositoryStorageMoves,
  ProjectSnippetAwardEmojis: () => ProjectSnippetAwardEmojis,
  ProjectSnippetDiscussions: () => ProjectSnippetDiscussions,
  ProjectSnippetNotes: () => ProjectSnippetNotes,
  ProjectSnippets: () => ProjectSnippets,
  ProjectStatistics: () => ProjectStatistics,
  ProjectTemplates: () => ProjectTemplates,
  ProjectTerraformState: () => ProjectTerraformState,
  ProjectVariables: () => ProjectVariables,
  ProjectVulnerabilities: () => ProjectVulnerabilities,
  ProjectWikis: () => ProjectWikis,
  Projects: () => Projects,
  ProtectedBranches: () => ProtectedBranches,
  ProtectedTags: () => ProtectedTags,
  PyPI: () => PyPI,
  ReleaseLinks: () => ReleaseLinks,
  Repositories: () => Repositories,
  RepositoryFiles: () => RepositoryFiles,
  RepositorySubmodules: () => RepositorySubmodules,
  ResourceGroups: () => ResourceGroups,
  RubyGems: () => RubyGems,
  Runners: () => Runners,
  Search: () => Search,
  SearchAdmin: () => SearchAdmin,
  SecureFiles: () => SecureFiles,
  ServiceAccounts: () => ServiceAccounts,
  ServiceData: () => ServiceData,
  SidekiqMetrics: () => SidekiqMetrics,
  SidekiqQueues: () => SidekiqQueues,
  SnippetRepositoryStorageMoves: () => SnippetRepositoryStorageMoves,
  Snippets: () => Snippets,
  Suggestions: () => Suggestions,
  SystemHooks: () => SystemHooks,
  Tags: () => Tags,
  TodoLists: () => TodoLists,
  Topics: () => Topics,
  UserCustomAttributes: () => UserCustomAttributes,
  UserEmails: () => UserEmails,
  UserGPGKeys: () => UserGPGKeys,
  UserImpersonationTokens: () => UserImpersonationTokens,
  UserSSHKeys: () => UserSSHKeys,
  UserStarredMetricsDashboard: () => UserStarredMetricsDashboard,
  Users: () => Users
});
init_esbuild_shims();

// node_modules/@gitbeaker/requester-utils/dist/index.mjs
init_esbuild_shims();
var import_qs = __toESM(require_lib(), 1);
var import_xcase = __toESM(require_es5(), 1);
var import_rate_limiter_flexible = __toESM(require_rate_limiter_flexible(), 1);
var import_picomatch_browser = __toESM(require_picomatch_browser(), 1);
var { isMatch: isGlobMatch } = import_picomatch_browser.default;
function generateRateLimiterFn(limit, interval) {
  const limiter = new import_rate_limiter_flexible.RateLimiterQueue(
    new import_rate_limiter_flexible.RateLimiterMemory({ points: limit, duration: interval })
  );
  return () => limiter.removeTokens(1);
}
__name(generateRateLimiterFn, "generateRateLimiterFn");
function formatQuery(params = {}) {
  const decamelized = (0, import_xcase.decamelizeKeys)(params);
  return (0, import_qs.stringify)(decamelized, { arrayFormat: "brackets" });
}
__name(formatQuery, "formatQuery");
async function defaultOptionsHandler(resourceOptions, {
  body,
  searchParams,
  sudo,
  signal,
  asStream = false,
  method = "GET"
} = {}) {
  const { headers: preconfiguredHeaders, authHeaders, url: url12 } = resourceOptions;
  const defaultOptions = {
    method,
    asStream,
    signal,
    prefixUrl: url12
  };
  defaultOptions.headers = { ...preconfiguredHeaders };
  if (sudo) defaultOptions.headers.sudo = `${sudo}`;
  if (body) {
    if (body instanceof FormData) {
      defaultOptions.body = body;
    } else {
      defaultOptions.body = JSON.stringify((0, import_xcase.decamelizeKeys)(body));
      defaultOptions.headers["content-type"] = "application/json";
    }
  }
  if (Object.keys(authHeaders).length > 0) {
    const [authHeaderKey, authHeaderFn] = Object.entries(authHeaders)[0];
    defaultOptions.headers[authHeaderKey] = await authHeaderFn();
  }
  const q = formatQuery(searchParams);
  if (q) defaultOptions.searchParams = q;
  return Promise.resolve(defaultOptions);
}
__name(defaultOptionsHandler, "defaultOptionsHandler");
function createRateLimiters(rateLimitOptions = {}) {
  const rateLimiters = {};
  Object.entries(rateLimitOptions).forEach(([key, config]) => {
    if (typeof config === "number") rateLimiters[key] = generateRateLimiterFn(config, 60);
    else
      rateLimiters[key] = {
        method: config.method.toUpperCase(),
        limit: generateRateLimiterFn(config.limit, 60)
      };
  });
  return rateLimiters;
}
__name(createRateLimiters, "createRateLimiters");
function createRequesterFn(optionsHandler, requestHandler) {
  const methods = ["get", "post", "put", "patch", "delete"];
  return (serviceOptions) => {
    const requester = {};
    const rateLimiters = createRateLimiters(serviceOptions.rateLimits);
    methods.forEach((m) => {
      requester[m] = async (endpoint2, options) => {
        const defaultRequestOptions = await defaultOptionsHandler(serviceOptions, {
          ...options,
          method: m.toUpperCase()
        });
        const requestOptions = await optionsHandler(serviceOptions, defaultRequestOptions);
        return requestHandler(endpoint2, { ...requestOptions, rateLimiters });
      };
    });
    return requester;
  };
}
__name(createRequesterFn, "createRequesterFn");
function extendClass(Base, customConfig) {
  return class extends Base {
    constructor(...options) {
      const [config, ...opts] = options;
      super({ ...customConfig, ...config }, ...opts);
    }
  };
}
__name(extendClass, "extendClass");
function presetResourceArguments(resources2, customConfig = {}) {
  const updated = {};
  Object.entries(resources2).filter(([, s]) => typeof s === "function").forEach(([k, r]) => {
    updated[k] = extendClass(r, customConfig);
  });
  return updated;
}
__name(presetResourceArguments, "presetResourceArguments");
function getMatchingRateLimiter(endpoint2, rateLimiters = {}, method = "GET") {
  const sortedEndpoints = Object.keys(rateLimiters).sort().reverse();
  const match = sortedEndpoints.find((ep) => isGlobMatch(endpoint2, ep));
  const rateLimitConfig = match && rateLimiters[match];
  if (typeof rateLimitConfig === "function") return rateLimitConfig;
  if (rateLimitConfig && rateLimitConfig?.method?.toUpperCase() === method.toUpperCase()) {
    return rateLimitConfig.limit;
  }
  return generateRateLimiterFn(3e3, 60);
}
__name(getMatchingRateLimiter, "getMatchingRateLimiter");
function getDynamicToken(tokenArgument) {
  return tokenArgument instanceof Function ? tokenArgument() : Promise.resolve(tokenArgument);
}
__name(getDynamicToken, "getDynamicToken");
var DEFAULT_RATE_LIMITS = Object.freeze({
  // Default rate limit
  "**": 3e3,
  // Import/Export
  "projects/import": 6,
  "projects/*/export": 6,
  "projects/*/download": 1,
  "groups/import": 6,
  "groups/*/export": 6,
  "groups/*/download": 1,
  // Note creation
  "projects/*/issues/*/notes": {
    method: "post",
    limit: 300
  },
  "projects/*/snippets/*/notes": {
    method: "post",
    limit: 300
  },
  "projects/*/merge_requests/*/notes": {
    method: "post",
    limit: 300
  },
  "groups/*/epics/*/notes": {
    method: "post",
    limit: 300
  },
  // Repositories - get file archive
  "projects/*/repository/archive*": 5,
  // Project Jobs
  "projects/*/jobs": 600,
  // Member deletion
  "projects/*/members": 60,
  "groups/*/members": 60
});
var BaseResource = class {
  static {
    __name(this, "BaseResource");
  }
  url;
  requester;
  queryTimeout;
  headers;
  authHeaders;
  camelize;
  rejectUnauthorized;
  constructor({
    sudo,
    profileToken,
    camelize,
    requesterFn: requesterFn2,
    profileMode = "execution",
    host = "https://gitlab.com",
    prefixUrl = "",
    rejectUnauthorized = true,
    queryTimeout = 3e5,
    rateLimits = DEFAULT_RATE_LIMITS,
    ...tokens
  }) {
    if (!requesterFn2) throw new ReferenceError("requesterFn must be passed");
    this.url = [host, "api", "v4", prefixUrl].join("/");
    this.headers = {};
    this.authHeaders = {};
    this.rejectUnauthorized = rejectUnauthorized;
    this.camelize = camelize;
    this.queryTimeout = queryTimeout;
    if ("oauthToken" in tokens)
      this.authHeaders.authorization = async () => {
        const token = await getDynamicToken(tokens.oauthToken);
        return `Bearer ${token}`;
      };
    else if ("jobToken" in tokens)
      this.authHeaders["job-token"] = async () => getDynamicToken(tokens.jobToken);
    else if ("token" in tokens)
      this.authHeaders["private-token"] = async () => getDynamicToken(tokens.token);
    if (profileToken) {
      this.headers["X-Profile-Token"] = profileToken;
      this.headers["X-Profile-Mode"] = profileMode;
    }
    if (sudo) this.headers.Sudo = `${sudo}`;
    this.requester = requesterFn2({ ...this, rateLimits });
  }
};
var GitbeakerRequestError = class extends Error {
  static {
    __name(this, "GitbeakerRequestError");
  }
  cause;
  constructor(message, options) {
    super(message, options);
    this.cause = options?.cause;
    this.name = "GitbeakerRequestError";
  }
};
var GitbeakerTimeoutError = class extends Error {
  static {
    __name(this, "GitbeakerTimeoutError");
  }
  constructor(message, options) {
    super(message, options);
    this.name = "GitbeakerTimeoutError";
  }
};
var GitbeakerRetryError = class extends Error {
  static {
    __name(this, "GitbeakerRetryError");
  }
  constructor(message, options) {
    super(message, options);
    this.name = "GitbeakerRetryError";
  }
};

// node_modules/@gitbeaker/core/dist/index.mjs
var import_xcase2 = __toESM(require_es5(), 1);
var import_qs2 = __toESM(require_lib(), 1);
function appendFormFromObject(object) {
  const form = new FormData();
  Object.entries(object).forEach(([k, v]) => {
    if (v == null) return;
    if (Array.isArray(v)) form.append(k, v[0], v[1]);
    else form.append(k, v);
  });
  return form;
}
__name(appendFormFromObject, "appendFormFromObject");
var RawPathSegment = class {
  static {
    __name(this, "RawPathSegment");
  }
  value;
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
};
function endpoint(strings, ...values) {
  return values.reduce((result, value, index) => {
    const encodedValue = value instanceof RawPathSegment ? value.value : encodeURIComponent(String(value));
    return result + encodedValue + strings[index + 1];
  }, strings[0]);
}
__name(endpoint, "endpoint");
function parseLinkHeader(linkString) {
  const output = {};
  const regex = /<([^>]+)>; rel="([^"]+)"/g;
  let m;
  while (m = regex.exec(linkString)) {
    const [, v, k] = m;
    output[k] = v;
  }
  return output;
}
__name(parseLinkHeader, "parseLinkHeader");
function reformatObjectOptions(obj, prefixKey, decamelizeValues = false) {
  const formatted = decamelizeValues ? (0, import_xcase2.decamelizeKeys)(obj) : obj;
  return import_qs2.default.stringify({ [prefixKey]: formatted }, { encode: false }).split("&").reduce((acc, cur) => {
    const [key, val] = cur.split(/=(.*)/);
    acc[key] = val;
    return acc;
  }, {});
}
__name(reformatObjectOptions, "reformatObjectOptions");
function packageResponse(response, showExpanded) {
  return showExpanded ? {
    data: response.body,
    status: response.status,
    headers: response.headers
  } : response.body;
}
__name(packageResponse, "packageResponse");
function getStream(response, showExpanded) {
  return packageResponse(response, showExpanded);
}
__name(getStream, "getStream");
function getSingle(camelize, response, showExpanded) {
  const { status, headers } = response;
  let { body } = response;
  if (camelize) body = (0, import_xcase2.camelizeKeys)(body);
  return packageResponse({ body, status, headers }, showExpanded);
}
__name(getSingle, "getSingle");
async function getManyMore(camelize, getFn, endpoint2, response, requestOptions, acc) {
  const { sudo, showExpanded, maxPages, pagination, page, perPage, idAfter, orderBy, sort } = requestOptions;
  if (camelize) response.body = (0, import_xcase2.camelizeKeys)(response?.body);
  const newAcc = [...acc || [], ...response.body];
  const withinBounds = maxPages && perPage ? newAcc.length / +perPage < maxPages : true;
  const { next = "" } = parseLinkHeader(response.headers.link);
  if (!(page && (acc || []).length === 0) && next && withinBounds) {
    const parsedQueryString = (0, import_qs2.parse)(next.split("?")[1]);
    const qs = { ...(0, import_xcase2.camelizeKeys)(parsedQueryString) };
    const newOpts = {
      ...qs,
      maxPages,
      sudo,
      showExpanded
    };
    const nextResponse = await getFn(endpoint2, {
      searchParams: qs,
      sudo
    });
    return getManyMore(camelize, getFn, endpoint2, nextResponse, newOpts, newAcc);
  }
  if (!showExpanded) return newAcc;
  const paginationInfo = pagination === "keyset" ? {
    idAfter: idAfter ? +idAfter : null,
    perPage: perPage ? +perPage : null,
    orderBy,
    sort
  } : {
    total: parseInt(response.headers["x-total"], 10),
    next: parseInt(response.headers["x-next-page"], 10) || null,
    current: parseInt(response.headers["x-page"], 10) || 1,
    previous: parseInt(response.headers["x-prev-page"], 10) || null,
    perPage: parseInt(response.headers["x-per-page"], 10),
    totalPages: parseInt(response.headers["x-total-pages"], 10)
  };
  return {
    data: newAcc,
    paginationInfo
  };
}
__name(getManyMore, "getManyMore");
function get() {
  return async (service, endpoint2, options) => {
    const { asStream, sudo, showExpanded, maxPages, ...searchParams } = options || {};
    const signal = service.queryTimeout ? AbortSignal.timeout(service.queryTimeout) : void 0;
    const response = await service.requester.get(endpoint2, {
      searchParams,
      sudo,
      asStream,
      signal
    });
    const camelizeResponseBody = service.camelize || false;
    if (asStream) return getStream(response, showExpanded);
    if (!Array.isArray(response.body))
      return getSingle(
        camelizeResponseBody,
        response,
        showExpanded
      );
    const reqOpts = {
      sudo,
      showExpanded,
      maxPages,
      ...searchParams
    };
    return getManyMore(
      camelizeResponseBody,
      (ep, op) => service.requester.get(ep, { ...op, signal }),
      endpoint2,
      response,
      reqOpts
    );
  };
}
__name(get, "get");
function post() {
  return async (service, endpoint2, { searchParams, isForm, sudo, showExpanded, ...options } = {}) => {
    const body = isForm ? appendFormFromObject(options) : options;
    const response = await service.requester.post(endpoint2, {
      searchParams,
      body,
      sudo,
      signal: service.queryTimeout ? AbortSignal.timeout(service.queryTimeout) : void 0
    });
    if (service.camelize) response.body = (0, import_xcase2.camelizeKeys)(response.body);
    return packageResponse(response, showExpanded);
  };
}
__name(post, "post");
function put() {
  return async (service, endpoint2, { searchParams, isForm, sudo, showExpanded, ...options } = {}) => {
    const body = isForm ? appendFormFromObject(options) : options;
    const response = await service.requester.put(endpoint2, {
      body,
      searchParams,
      sudo,
      signal: service.queryTimeout ? AbortSignal.timeout(service.queryTimeout) : void 0
    });
    if (service.camelize) response.body = (0, import_xcase2.camelizeKeys)(response.body);
    return packageResponse(response, showExpanded);
  };
}
__name(put, "put");
function patch() {
  return async (service, endpoint2, { searchParams, isForm, sudo, showExpanded, ...options } = {}) => {
    const body = isForm ? appendFormFromObject(options) : options;
    const response = await service.requester.patch(endpoint2, {
      body,
      searchParams,
      sudo,
      signal: service.queryTimeout ? AbortSignal.timeout(service.queryTimeout) : void 0
    });
    if (service.camelize) response.body = (0, import_xcase2.camelizeKeys)(response.body);
    return packageResponse(response, showExpanded);
  };
}
__name(patch, "patch");
function del() {
  return async (service, endpoint2, { sudo, showExpanded, searchParams, ...options } = {}) => {
    const response = await service.requester.delete(endpoint2, {
      body: options,
      searchParams,
      sudo,
      signal: service.queryTimeout ? AbortSignal.timeout(service.queryTimeout) : void 0
    });
    return packageResponse(response, showExpanded);
  };
}
__name(del, "del");
var RequestHelper = {
  post,
  put,
  patch,
  get,
  del
};
var Agents = class extends BaseResource {
  static {
    __name(this, "Agents");
  }
  all(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/cluster_agents`,
      options
    );
  }
  allTokens(projectId, agentId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/cluster_agents/${agentId}/tokens`,
      options
    );
  }
  createToken(projectId, agentId, name, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/cluster_agents/${agentId}/tokens`,
      {
        name,
        ...options
      }
    );
  }
  show(projectId, agentId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/cluster_agents/${agentId}`,
      options
    );
  }
  showToken(projectId, agentId, tokenId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/cluster_agents/${agentId}/tokens/${tokenId}`,
      options
    );
  }
  register(projectId, name, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/cluster_agents`,
      {
        name,
        ...options
      }
    );
  }
  removeToken(projectId, agentId, tokenId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/cluster_agents/${agentId}/tokens/${tokenId}`,
      options
    );
  }
  unregister(projectId, agentId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/cluster_agents/${agentId}`,
      options
    );
  }
};
var AlertManagement = class extends BaseResource {
  static {
    __name(this, "AlertManagement");
  }
  allMetricImages(projectId, alertIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/alert_management_alerts/${alertIId}/metric_images`,
      options
    );
  }
  editMetricImage(projectId, alertIId, imageId, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/alert_management_alerts/${alertIId}/metric_images/${imageId}`,
      options
    );
  }
  removeMetricImage(projectId, alertIId, imageId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/alert_management_alerts/${alertIId}/metric_images/${imageId}`,
      options
    );
  }
  uploadMetricImage(projectId, alertIId, metricImage, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/alert_management_alerts/${alertIId}/metric_images`,
      {
        isForm: true,
        file: [metricImage.content, metricImage.filename],
        ...options
      }
    );
  }
};
var ApplicationAppearance = class extends BaseResource {
  static {
    __name(this, "ApplicationAppearance");
  }
  show(options) {
    return RequestHelper.get()(
      this,
      "application/appearence",
      options
    );
  }
  edit({
    logo,
    pwaIcon,
    ...options
  } = {}) {
    if (logo || pwaIcon) {
      const opts = {
        ...options,
        isForm: true
      };
      if (logo) opts.logo = [logo.content, logo.filename];
      if (pwaIcon) opts.pwaIcon = [pwaIcon.content, pwaIcon.filename];
      return RequestHelper.put()(this, "application/appearence", opts);
    }
    return RequestHelper.put()(
      this,
      "application/appearence",
      options
    );
  }
};
var ApplicationPlanLimits = class extends BaseResource {
  static {
    __name(this, "ApplicationPlanLimits");
  }
  show(options) {
    return RequestHelper.get()(
      this,
      "application/plan_limits",
      options
    );
  }
  edit(planName, options = {}) {
    const {
      ciPipelineSize,
      ciActiveJobs,
      ciActivePipelines,
      ciProjectSubscriptions,
      ciPipelineSchedules,
      ciNeedsSizeLimit,
      ciRegisteredGroupRunners,
      ciRegisteredProjectRunners,
      conanMaxFileSize,
      genericPackagesMaxFileSize,
      helmMaxFileSize,
      mavenMaxFileSize,
      npmMaxFileSize,
      nugetMaxFileSize,
      pypiMaxFileSize,
      terraformModuleMaxFileSize,
      storageSizeLimit,
      ...opts
    } = options;
    return RequestHelper.put()(this, "application/plan_limits", {
      ...opts,
      searchParams: {
        planName,
        ciPipelineSize,
        ciActiveJobs,
        ciActivePipelines,
        ciProjectSubscriptions,
        ciPipelineSchedules,
        ciNeedsSizeLimit,
        ciRegisteredGroupRunners,
        ciRegisteredProjectRunners,
        conanMaxFileSize,
        genericPackagesMaxFileSize,
        helmMaxFileSize,
        mavenMaxFileSize,
        npmMaxFileSize,
        nugetMaxFileSize,
        pypiMaxFileSize,
        terraformModuleMaxFileSize,
        storageSizeLimit
      }
    });
  }
};
var ApplicationSettings = class extends BaseResource {
  static {
    __name(this, "ApplicationSettings");
  }
  show(options) {
    return RequestHelper.get()(this, "application/settings", options);
  }
  edit(options) {
    return RequestHelper.put()(this, "application/settings", options);
  }
};
var ApplicationStatistics = class extends BaseResource {
  static {
    __name(this, "ApplicationStatistics");
  }
  show(options) {
    return RequestHelper.get()(this, "application/statistics", options);
  }
};
var Applications = class extends BaseResource {
  static {
    __name(this, "Applications");
  }
  all(options) {
    return RequestHelper.get()(this, "applications", options);
  }
  create(name, redirectUri, scopes, options) {
    return RequestHelper.post()(this, "applications", {
      name,
      redirectUri,
      scopes,
      ...options
    });
  }
  remove(applicationId, options) {
    return RequestHelper.del()(this, `applications/${applicationId}`, options);
  }
};
function url({
  projectId,
  groupId
} = {}) {
  let prefix = "";
  if (projectId) prefix = endpoint`projects/${projectId}/`;
  else if (groupId) prefix = endpoint`groups/${groupId}/`;
  return `${prefix}audit_events`;
}
__name(url, "url");
var AuditEvents = class extends BaseResource {
  static {
    __name(this, "AuditEvents");
  }
  all({
    projectId,
    groupId,
    ...options
  } = {}) {
    const uri = url({ projectId, groupId });
    return RequestHelper.get()(
      this,
      uri,
      options
    );
  }
  show(auditEventId, {
    projectId,
    groupId,
    ...options
  } = {}) {
    const uri = url({ projectId, groupId });
    return RequestHelper.get()(this, `${uri}/${auditEventId}`, options);
  }
};
var Avatar = class extends BaseResource {
  static {
    __name(this, "Avatar");
  }
  show(email, options) {
    return RequestHelper.get()(this, "avatar", { email, ...options });
  }
};
var BroadcastMessages = class extends BaseResource {
  static {
    __name(this, "BroadcastMessages");
  }
  all(options) {
    return RequestHelper.get()(this, "broadcast_messages", options);
  }
  create(options) {
    return RequestHelper.post()(this, "broadcast_messages", options);
  }
  edit(broadcastMessageId, options) {
    return RequestHelper.put()(
      this,
      `broadcast_messages/${broadcastMessageId}`,
      options
    );
  }
  remove(broadcastMessageId, options) {
    return RequestHelper.del()(this, `broadcast_messages/${broadcastMessageId}`, options);
  }
  show(broadcastMessageId, options) {
    return RequestHelper.get()(
      this,
      `broadcast_messages/${broadcastMessageId}`,
      options
    );
  }
};
var CodeSuggestions = class extends BaseResource {
  static {
    __name(this, "CodeSuggestions");
  }
  createAccessToken(options) {
    return RequestHelper.post()(this, "code_suggestions/tokens", options);
  }
  generateCompletion(options) {
    return RequestHelper.post()(
      this,
      "code_suggestions/completions",
      options
    );
  }
};
var Composer = class extends BaseResource {
  static {
    __name(this, "Composer");
  }
  create(projectId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/packages/composer`,
      options
    );
  }
  download(projectId, packageName, sha, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/packages/composer/archives/${packageName}`,
      {
        searchParams: { sha },
        ...options
      }
    );
  }
  showMetadata(groupId, packageName, options) {
    let url12;
    if (options && options.sha) {
      url12 = endpoint`groups/${groupId}/-/packages/composer/${packageName}$${options.sha}`;
    } else {
      url12 = endpoint`groups/${groupId}/-/packages/composer/p2/${packageName}`;
    }
    return RequestHelper.get()(this, url12, options);
  }
  showPackages(groupId, sha, options) {
    return RequestHelper.get()(
      this,
      endpoint`groups/${groupId}/-/packages/composer/p/${sha}`,
      options
    );
  }
  showBaseRepository(groupId, options) {
    const clonedService = { ...this };
    if (options && options.composerVersion === "2") {
      clonedService.headers["User-Agent"] = "Composer/2";
    }
    return RequestHelper.get()(
      clonedService,
      endpoint`groups/${groupId}/-/packages/composer/packages`,
      options
    );
  }
};
function url2(projectId) {
  return projectId ? endpoint`projects/${projectId}/packages/conan/v1` : "packages/conan/v1";
}
__name(url2, "url2");
var Conan = class extends BaseResource {
  static {
    __name(this, "Conan");
  }
  authenticate({
    projectId,
    ...options
  } = {}) {
    return RequestHelper.get()(this, `${url2(projectId)}/users/authenticate`, options);
  }
  checkCredentials({
    projectId,
    ...options
  } = {}) {
    const prefix = url2(projectId);
    return RequestHelper.get()(this, `${prefix}/users/check_credentials`, options);
  }
  downloadPackageFile(packageName, packageVersion, packageUsername, packageChannel, conanPackageReference, recipeRevision, packageRevision, filename, { projectId, ...options } = {}) {
    const prefix = url2(projectId);
    return RequestHelper.get()(
      this,
      `${prefix}/conans/${packageName}/${packageVersion}/${packageUsername}/${packageChannel}/${recipeRevision}/package/${conanPackageReference}/${packageRevision}/${filename}`,
      options
    );
  }
  downloadRecipeFile(packageName, packageVersion, packageUsername, packageChannel, recipeRevision, filename, { projectId, ...options } = {}) {
    const prefix = url2(projectId);
    return RequestHelper.get()(
      this,
      `${prefix}/conans/${packageName}/${packageVersion}/${packageUsername}/${packageChannel}/${recipeRevision}/export/${filename}`,
      options
    );
  }
  showPackageUploadUrls(packageName, packageVersion, packageUsername, packageChannel, conanPackageReference, { projectId, ...options } = {}) {
    const prefix = url2(projectId);
    return RequestHelper.get()(
      this,
      `${prefix}/conans/${packageName}/${packageVersion}/${packageUsername}/${packageChannel}/packages/${conanPackageReference}/upload_urls`,
      options
    );
  }
  showPackageDownloadUrls(packageName, packageVersion, packageUsername, packageChannel, conanPackageReference, { projectId, ...options } = {}) {
    const prefix = url2(projectId);
    return RequestHelper.get()(
      this,
      `${prefix}/conans/${packageName}/${packageVersion}/${packageUsername}/${packageChannel}/packages/${conanPackageReference}/download_urls`,
      options
    );
  }
  showPackageManifest(packageName, packageVersion, packageUsername, packageChannel, conanPackageReference, { projectId, ...options } = {}) {
    const prefix = url2(projectId);
    return RequestHelper.get()(
      this,
      `${prefix}/conans/${packageName}/${packageVersion}/${packageUsername}/${packageChannel}/packages/${conanPackageReference}/digest`,
      options
    );
  }
  showPackageSnapshot(packageName, packageVersion, packageUsername, packageChannel, conanPackageReference, { projectId, ...options } = {}) {
    const prefix = url2(projectId);
    return RequestHelper.get()(
      this,
      `${prefix}/conans/${packageName}/${packageVersion}/${packageUsername}/${packageChannel}/packages/${conanPackageReference}`,
      options
    );
  }
  ping({
    projectId,
    ...options
  } = {}) {
    return RequestHelper.post()(this, `${url2(projectId)}/ping`, options);
  }
  showRecipeUploadUrls(packageName, packageVersion, packageUsername, packageChannel, { projectId, ...options } = {}) {
    const prefix = url2(projectId);
    return RequestHelper.get()(
      this,
      `${prefix}/conans/${packageName}/${packageVersion}/${packageUsername}/${packageChannel}/upload_urls`,
      options
    );
  }
  showRecipeDownloadUrls(packageName, packageVersion, packageUsername, packageChannel, { projectId, ...options } = {}) {
    const prefix = url2(projectId);
    return RequestHelper.get()(
      this,
      `${prefix}/conans/${packageName}/${packageVersion}/${packageUsername}/${packageChannel}/download_urls`,
      options
    );
  }
  showRecipeManifest(packageName, packageVersion, packageUsername, packageChannel, { projectId, ...options } = {}) {
    const prefix = url2(projectId);
    return RequestHelper.get()(
      this,
      `${prefix}/conans/${packageName}/${packageVersion}/${packageUsername}/${packageChannel}/digest`,
      options
    );
  }
  showRecipeSnapshot(packageName, packageVersion, packageUsername, packageChannel, { projectId, ...options } = {}) {
    const prefix = url2(projectId);
    return RequestHelper.get()(
      this,
      `${prefix}/conans/${packageName}/${packageVersion}/${packageUsername}/${packageChannel}`,
      options
    );
  }
  removePackageFile(packageName, packageVersion, packageUsername, packageChannel, { projectId, ...options } = {}) {
    const prefix = url2(projectId);
    return RequestHelper.get()(
      this,
      `${prefix}/conans/${packageName}/${packageVersion}/${packageUsername}/${packageChannel}`,
      options
    );
  }
  search({
    projectId,
    ...options
  } = {}) {
    const prefix = url2(projectId);
    return RequestHelper.get()(this, `${prefix}/conans/search`, options);
  }
  uploadPackageFile(packageFile, packageName, packageVersion, packageUsername, packageChannel, conanPackageReference, recipeRevision, packageRevision, options) {
    const prefix = url2();
    return RequestHelper.get()(
      this,
      `${prefix}/files/${packageName}/${packageVersion}/${packageUsername}/${packageChannel}/${recipeRevision}/package/${conanPackageReference}/${packageRevision}/${packageFile.filename}`,
      {
        isForm: true,
        ...options,
        file: [packageFile.content, packageFile.filename]
      }
    );
  }
  uploadRecipeFile(packageFile, packageName, packageVersion, packageUsername, packageChannel, recipeRevision, options) {
    const prefix = url2();
    return RequestHelper.get()(
      this,
      `${prefix}/files/${packageName}/${packageVersion}/${packageUsername}/${packageChannel}/${recipeRevision}/export/${packageFile.filename}`,
      {
        isForm: true,
        ...options,
        file: [packageFile.content, packageFile.filename]
      }
    );
  }
};
var DashboardAnnotations = class extends BaseResource {
  static {
    __name(this, "DashboardAnnotations");
  }
  create(dashboardPath, startingAt, description, {
    environmentId,
    clusterId,
    ...options
  } = {}) {
    let url12;
    if (environmentId) url12 = endpoint`environments/${environmentId}/metrics_dashboard/annotations`;
    else if (clusterId) url12 = endpoint`clusters/${clusterId}/metrics_dashboard/annotations`;
    else
      throw new Error(
        "Missing required argument. Please supply a environmentId or a cluserId in the options parameter."
      );
    return RequestHelper.post()(this, url12, {
      dashboardPath,
      startingAt,
      description,
      ...options
    });
  }
};
function url3({
  projectId,
  groupId
} = {}) {
  if (projectId) return endpoint`/projects/${projectId}/packages/debian`;
  if (groupId) return endpoint`/groups/${groupId}/-/packages/debian`;
  throw new Error(
    "Missing required argument. Please supply a projectId or a groupId in the options parameter"
  );
}
__name(url3, "url3");
var Debian = class extends BaseResource {
  static {
    __name(this, "Debian");
  }
  downloadBinaryFileIndex(distribution, component, architecture, {
    projectId,
    groupId,
    ...options
  }) {
    const prefix = url3({
      projectId,
      groupId
    });
    return RequestHelper.get()(
      this,
      `${prefix}/dists/${distribution}/${component}/binary-${architecture}/Packages`,
      options
    );
  }
  downloadDistributionReleaseFile(distribution, {
    projectId,
    groupId,
    ...options
  }) {
    const prefix = url3({
      projectId,
      groupId
    });
    return RequestHelper.get()(
      this,
      `${prefix}/dists/${distribution}/Release`,
      options
    );
  }
  downloadSignedDistributionReleaseFile(distribution, {
    projectId,
    groupId,
    ...options
  }) {
    const prefix = url3({
      projectId,
      groupId
    });
    return RequestHelper.get()(
      this,
      `${prefix}/dists/${distribution}/InRelease`,
      options
    );
  }
  downloadReleaseFileSignature(distribution, {
    projectId,
    groupId,
    ...options
  }) {
    const prefix = url3({
      projectId,
      groupId
    });
    return RequestHelper.get()(
      this,
      `${prefix}/dists/${distribution}/Release.gpg`,
      options
    );
  }
  downloadPackageFile(projectId, distribution, letter, packageName, packageVersion, filename, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/packages/debian/pool/${distribution}/${letter}/${packageName}/${packageVersion}/${filename}`,
      options
    );
  }
  uploadPackageFile(projectId, packageFile, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/packages/debian/${packageFile.filename}`,
      {
        isForm: true,
        ...options,
        file: [packageFile.content, packageFile.filename]
      }
    );
  }
};
var DependencyProxy = class extends BaseResource {
  static {
    __name(this, "DependencyProxy");
  }
  remove(groupId, options) {
    return RequestHelper.post()(this, `groups/${groupId}/dependency_proxy/cache`, options);
  }
};
var DeployKeys = class extends BaseResource {
  static {
    __name(this, "DeployKeys");
  }
  all({
    projectId,
    userId,
    ...options
  } = {}) {
    let url12;
    if (projectId) {
      url12 = endpoint`projects/${projectId}/deploy_keys`;
    } else if (userId) {
      url12 = endpoint`users/${userId}/project_deploy_keys`;
    } else {
      url12 = "deploy_keys";
    }
    return RequestHelper.get()(this, url12, options);
  }
  create(projectId, title, key, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/deploy_keys`,
      {
        title,
        key,
        ...options
      }
    );
  }
  edit(projectId, keyId, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/deploy_keys/${keyId}`,
      options
    );
  }
  enable(projectId, keyId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/deploy_keys/${keyId}/enable`,
      options
    );
  }
  remove(projectId, keyId, options) {
    return RequestHelper.del()(this, endpoint`projects/${projectId}/deploy_keys/${keyId}`, options);
  }
  show(projectId, keyId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/deploy_keys/${keyId}`,
      options
    );
  }
};
var DeployTokens = class extends BaseResource {
  static {
    __name(this, "DeployTokens");
  }
  all({
    projectId,
    groupId,
    ...options
  } = {}) {
    let url12;
    if (projectId) url12 = endpoint`projects/${projectId}/deploy_tokens`;
    else if (groupId) url12 = endpoint`groups/${groupId}/deploy_tokens`;
    else url12 = "deploy_tokens";
    return RequestHelper.get()(this, url12, options);
  }
  create(name, scopes, {
    projectId,
    groupId,
    ...options
  } = {}) {
    let url12;
    if (projectId) url12 = endpoint`projects/${projectId}/deploy_tokens`;
    else if (groupId) url12 = endpoint`groups/${groupId}/deploy_tokens`;
    else {
      throw new Error(
        "Missing required argument. Please supply a projectId or a groupId in the options parameter."
      );
    }
    return RequestHelper.post()(this, url12, {
      name,
      scopes,
      ...options
    });
  }
  remove(tokenId, {
    projectId,
    groupId,
    ...options
  } = {}) {
    let url12;
    if (projectId) url12 = endpoint`projects/${projectId}/deploy_tokens/${tokenId}`;
    else if (groupId) url12 = endpoint`groups/${groupId}/deploy_tokens/${tokenId}`;
    else {
      throw new Error(
        "Missing required argument. Please supply a projectId or a groupId in the options parameter."
      );
    }
    return RequestHelper.del()(this, url12, options);
  }
  show(tokenId, {
    projectId,
    groupId,
    ...options
  } = {}) {
    let url12;
    if (projectId) url12 = endpoint`projects/${projectId}/deploy_tokens/${tokenId}`;
    else if (groupId) url12 = endpoint`groups/${groupId}/deploy_tokens/${tokenId}`;
    else {
      throw new Error(
        "Missing required argument. Please supply a projectId or a groupId in the options parameter."
      );
    }
    return RequestHelper.get()(
      this,
      url12,
      options
    );
  }
};
var ResourceAccessRequests = class extends BaseResource {
  static {
    __name(this, "ResourceAccessRequests");
  }
  constructor(resourceType, options) {
    super({ prefixUrl: resourceType, ...options });
  }
  all(resourceId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/access_requests`,
      options
    );
  }
  request(resourceId, options) {
    return RequestHelper.post()(
      this,
      endpoint`${resourceId}/access_requests`,
      options
    );
  }
  approve(resourceId, userId, options) {
    return RequestHelper.put()(
      this,
      endpoint`${resourceId}/access_requests/${userId}/approve`,
      options
    );
  }
  deny(resourceId, userId, options) {
    return RequestHelper.del()(this, endpoint`${resourceId}/access_requests/${userId}`, options);
  }
};
var ResourceAccessTokens = class extends BaseResource {
  static {
    __name(this, "ResourceAccessTokens");
  }
  constructor(resourceType, options) {
    super({ prefixUrl: resourceType, ...options });
  }
  all(resourceId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/access_tokens`,
      options
    );
  }
  create(resourceId, name, scopes, expiresAt, options) {
    return RequestHelper.post()(
      this,
      endpoint`${resourceId}/access_tokens`,
      {
        name,
        scopes,
        expiresAt,
        ...options
      }
    );
  }
  revoke(resourceId, tokenId, options) {
    return RequestHelper.del()(this, endpoint`${resourceId}/access_tokens/${tokenId}`, options);
  }
  rotate(resourceId, tokenId, options) {
    return RequestHelper.post()(
      this,
      endpoint`${resourceId}/access_tokens/${tokenId}/rotate`,
      options
    );
  }
  show(resourceId, tokenId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/access_tokens/${tokenId}`,
      options
    );
  }
};
function url4(resourceId, resourceType2, resourceId2, awardId) {
  const [rId, rId2] = [resourceId, resourceId2].map(encodeURIComponent);
  const output = [rId, resourceType2, rId2];
  output.push("award_emoji");
  if (awardId) output.push(awardId);
  return output.join("/");
}
__name(url4, "url4");
var ResourceAwardEmojis = class extends BaseResource {
  static {
    __name(this, "ResourceAwardEmojis");
  }
  resourceType2;
  constructor(resourceType1, resourceType2, options) {
    super({ prefixUrl: resourceType1, ...options });
    this.resourceType2 = resourceType2;
  }
  all(resourceId, resourceIId, options) {
    return RequestHelper.get()(
      this,
      url4(resourceId, this.resourceType2, resourceIId),
      options
    );
  }
  award(resourceId, resourceIId, name, options) {
    return RequestHelper.post()(
      this,
      url4(resourceId, this.resourceType2, resourceIId),
      {
        name,
        ...options
      }
    );
  }
  remove(resourceId, resourceIId, awardId, options) {
    return RequestHelper.del()(
      this,
      url4(resourceId, this.resourceType2, resourceIId, awardId),
      options
    );
  }
  show(resourceId, resourceIId, awardId, options) {
    return RequestHelper.get()(
      this,
      url4(resourceId, this.resourceType2, resourceIId, awardId),
      options
    );
  }
};
function url5(resourceId, resourceType2, resourceId2, noteId, awardId) {
  const [rId, rId2] = [resourceId, resourceId2].map(encodeURIComponent);
  const output = [rId, resourceType2, rId2];
  output.push("notes");
  output.push(noteId);
  output.push("award_emoji");
  if (awardId) output.push(awardId);
  return output.join("/");
}
__name(url5, "url5");
var ResourceNoteAwardEmojis = class extends BaseResource {
  static {
    __name(this, "ResourceNoteAwardEmojis");
  }
  resourceType;
  constructor(resourceType, options) {
    super({ prefixUrl: "projects", ...options });
    this.resourceType = resourceType;
  }
  all(projectId, resourceIId, noteId, options) {
    return RequestHelper.get()(
      this,
      url5(projectId, this.resourceType, resourceIId, noteId),
      options
    );
  }
  award(projectId, resourceIId, noteId, name, options) {
    return RequestHelper.post()(
      this,
      url5(projectId, this.resourceType, resourceIId, noteId),
      {
        name,
        ...options
      }
    );
  }
  remove(projectId, resourceIId, noteId, awardId, options) {
    return RequestHelper.del()(
      this,
      url5(projectId, this.resourceType, resourceIId, noteId, awardId),
      options
    );
  }
  show(projectId, resourceIId, noteId, awardId, options) {
    return RequestHelper.get()(
      this,
      url5(projectId, this.resourceType, resourceIId, noteId, awardId),
      options
    );
  }
};
var ResourceBadges = class extends BaseResource {
  static {
    __name(this, "ResourceBadges");
  }
  constructor(resourceType, options) {
    super({ prefixUrl: resourceType, ...options });
  }
  add(resourceId, linkUrl, imageUrl, options) {
    return RequestHelper.post()(this, endpoint`${resourceId}/badges`, {
      linkUrl,
      imageUrl,
      ...options
    });
  }
  all(resourceId, options) {
    return RequestHelper.get()(this, endpoint`${resourceId}/badges`, options);
  }
  edit(resourceId, badgeId, options) {
    return RequestHelper.put()(
      this,
      endpoint`${resourceId}/badges/${badgeId}`,
      options
    );
  }
  preview(resourceId, linkUrl, imageUrl, options) {
    return RequestHelper.get()(this, endpoint`${resourceId}/badges/render`, {
      linkUrl,
      imageUrl,
      ...options
    });
  }
  remove(resourceId, badgeId, options) {
    return RequestHelper.del()(this, endpoint`${resourceId}/badges/${badgeId}`, options);
  }
  show(resourceId, badgeId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/badges/${badgeId}`,
      options
    );
  }
};
var ResourceCustomAttributes = class extends BaseResource {
  static {
    __name(this, "ResourceCustomAttributes");
  }
  constructor(resourceType, options) {
    super({ prefixUrl: resourceType, ...options });
  }
  all(resourceId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/custom_attributes`,
      options
    );
  }
  remove(resourceId, customAttributeId, options) {
    return RequestHelper.del()(
      this,
      endpoint`${resourceId}/custom_attributes/${customAttributeId}`,
      options
    );
  }
  set(resourceId, customAttributeId, value, options) {
    return RequestHelper.put()(
      this,
      endpoint`${resourceId}/custom_attributes/${customAttributeId}`,
      {
        value,
        ...options
      }
    );
  }
  show(resourceId, customAttributeId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/custom_attributes/${customAttributeId}`,
      options
    );
  }
};
var ResourceDORA4Metrics = class extends BaseResource {
  static {
    __name(this, "ResourceDORA4Metrics");
  }
  constructor(resourceType, options) {
    super({ prefixUrl: resourceType, ...options });
  }
  all(resourceId, metric, options) {
    return RequestHelper.get()(this, endpoint`${resourceId}/dora/metrics`, {
      metric,
      ...options
    });
  }
};
var ResourceDiscussions = class extends BaseResource {
  static {
    __name(this, "ResourceDiscussions");
  }
  resource2Type;
  constructor(resourceType, resource2Type, options) {
    super({ prefixUrl: resourceType, ...options });
    this.resource2Type = resource2Type;
  }
  addNote(resourceId, resource2Id, discussionId, noteId, body, options) {
    return RequestHelper.post()(
      this,
      endpoint`${resourceId}/${this.resource2Type}/${resource2Id}/discussions/${discussionId}/notes`,
      { ...options, body, noteId }
    );
  }
  all(resourceId, resource2Id, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/${this.resource2Type}/${resource2Id}/discussions`,
      options
    );
  }
  create(resourceId, resource2Id, body, {
    position,
    ...options
  } = {}) {
    const opts = { ...options, body };
    if (position) {
      Object.assign(opts, reformatObjectOptions(position, "position", true));
      opts.isForm = true;
    }
    return RequestHelper.post()(
      this,
      endpoint`${resourceId}/${this.resource2Type}/${resource2Id}/discussions`,
      opts
    );
  }
  editNote(resourceId, resource2Id, discussionId, noteId, options) {
    return RequestHelper.put()(
      this,
      endpoint`${resourceId}/${this.resource2Type}/${resource2Id}/discussions/${discussionId}/notes/${noteId}`,
      options
    );
  }
  removeNote(resourceId, resource2Id, discussionId, noteId, options) {
    return RequestHelper.del()(
      this,
      endpoint`${resourceId}/${this.resource2Type}/${resource2Id}/discussions/${discussionId}/notes/${noteId}`,
      options
    );
  }
  show(resourceId, resource2Id, discussionId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/${this.resource2Type}/${resource2Id}/discussions/${discussionId}`,
      options
    );
  }
};
var ResourceIssueBoards = class extends BaseResource {
  static {
    __name(this, "ResourceIssueBoards");
  }
  constructor(resourceType, options) {
    super({ prefixUrl: resourceType, ...options });
  }
  all(resourceId, options) {
    return RequestHelper.get()(this, endpoint`${resourceId}/boards`, options);
  }
  allLists(resourceId, boardId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/boards/${boardId}/lists`,
      options
    );
  }
  create(resourceId, name, options) {
    return RequestHelper.post()(this, endpoint`${resourceId}/boards`, {
      name,
      ...options
    });
  }
  createList(resourceId, boardId, options) {
    return RequestHelper.post()(
      this,
      endpoint`${resourceId}/boards/${boardId}/lists`,
      options
    );
  }
  edit(resourceId, boardId, options) {
    return RequestHelper.put()(
      this,
      endpoint`${resourceId}/boards/${boardId}`,
      options
    );
  }
  editList(resourceId, boardId, listId, position, options) {
    return RequestHelper.put()(
      this,
      endpoint`${resourceId}/boards/${boardId}/lists/${listId}`,
      {
        position,
        ...options
      }
    );
  }
  remove(resourceId, boardId, options) {
    return RequestHelper.del()(this, endpoint`${resourceId}/boards/${boardId}`, options);
  }
  removeList(resourceId, boardId, listId, options) {
    return RequestHelper.del()(
      this,
      endpoint`${resourceId}/boards/${boardId}/lists/${listId}`,
      options
    );
  }
  show(resourceId, boardId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/boards/${boardId}`,
      options
    );
  }
  showList(resourceId, boardId, listId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/boards/${boardId}/lists/${listId}`,
      options
    );
  }
};
var ResourceLabels = class extends BaseResource {
  static {
    __name(this, "ResourceLabels");
  }
  constructor(resourceType, options) {
    super({ prefixUrl: resourceType, ...options });
  }
  all(resourceId, options) {
    return RequestHelper.get()(this, endpoint`${resourceId}/labels`, options);
  }
  create(resourceId, labelName, color, options) {
    return RequestHelper.post()(this, endpoint`${resourceId}/labels`, {
      name: labelName,
      color,
      ...options
    });
  }
  edit(resourceId, labelId, options) {
    if (!options?.newName && !options?.color)
      throw new Error(
        "Missing required argument. Please supply a color or a newName in the options parameter."
      );
    return RequestHelper.put()(
      this,
      endpoint`${resourceId}/labels/${labelId}`,
      options
    );
  }
  promote(resourceId, labelId, options) {
    return RequestHelper.put()(
      this,
      endpoint`${resourceId}/labels/${labelId}/promote`,
      options
    );
  }
  remove(resourceId, labelId, options) {
    return RequestHelper.del()(this, endpoint`${resourceId}/labels/${labelId}`, options);
  }
  show(resourceId, labelId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/labels/${labelId}`,
      options
    );
  }
  subscribe(resourceId, labelId, options) {
    return RequestHelper.post()(
      this,
      endpoint`${resourceId}/issues/${labelId}/subscribe`,
      options
    );
  }
  unsubscribe(resourceId, labelId, options) {
    return RequestHelper.post()(
      this,
      endpoint`${resourceId}/issues/${labelId}/unsubscribe`,
      options
    );
  }
};
var ResourceMembers = class extends BaseResource {
  static {
    __name(this, "ResourceMembers");
  }
  constructor(resourceType, options) {
    super({ prefixUrl: resourceType, ...options });
  }
  add(resourceId, accessLevel, options) {
    return RequestHelper.post()(this, endpoint`${resourceId}/members`, {
      accessLevel,
      ...options
    });
  }
  all(resourceId, {
    includeInherited,
    ...options
  } = {}) {
    let url12 = endpoint`${resourceId}/members`;
    if (includeInherited) url12 += "/all";
    return RequestHelper.get()(this, url12, options);
  }
  edit(resourceId, userId, accessLevel, options) {
    return RequestHelper.put()(this, endpoint`${resourceId}/members/${userId}`, {
      accessLevel,
      ...options
    });
  }
  show(resourceId, userId, { includeInherited, ...options } = {}) {
    const [rId, uId] = [resourceId, userId].map(encodeURIComponent);
    const url12 = [rId, "members"];
    if (includeInherited) url12.push("all");
    url12.push(uId);
    return RequestHelper.get()(this, url12.join("/"), options);
  }
  remove(resourceId, userId, options) {
    return RequestHelper.del()(this, endpoint`${resourceId}/members/${userId}`, options);
  }
};
var ResourceMilestones = class extends BaseResource {
  static {
    __name(this, "ResourceMilestones");
  }
  constructor(resourceType, options) {
    super({ prefixUrl: resourceType, ...options });
  }
  all(resourceId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/milestones`,
      options
    );
  }
  allAssignedIssues(resourceId, milestoneId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/milestones/${milestoneId}/issues`,
      options
    );
  }
  allAssignedMergeRequests(resourceId, milestoneId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/milestones/${milestoneId}/merge_requests`,
      options
    );
  }
  allBurndownChartEvents(resourceId, milestoneId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/milestones/${milestoneId}/burndown_events`,
      options
    );
  }
  create(resourceId, title, options) {
    return RequestHelper.post()(this, endpoint`${resourceId}/milestones`, {
      title,
      ...options
    });
  }
  edit(resourceId, milestoneId, options) {
    return RequestHelper.put()(
      this,
      endpoint`${resourceId}/milestones/${milestoneId}`,
      options
    );
  }
  remove(resourceId, milestoneId, options) {
    return RequestHelper.del()(this, endpoint`${resourceId}/milestones/${milestoneId}`, options);
  }
  show(resourceId, milestoneId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/milestones/${milestoneId}`,
      options
    );
  }
};
var ResourceNotes = class extends BaseResource {
  static {
    __name(this, "ResourceNotes");
  }
  resource2Type;
  constructor(resourceType, resource2Type, options) {
    super({ prefixUrl: resourceType, ...options });
    this.resource2Type = resource2Type;
  }
  all(resourceId, resource2Id, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/${this.resource2Type}/${resource2Id}/notes`,
      options
    );
  }
  create(resourceId, resource2Id, body, options) {
    return RequestHelper.post()(
      this,
      endpoint`${resourceId}/${this.resource2Type}/${resource2Id}/notes`,
      {
        body,
        ...options
      }
    );
  }
  edit(resourceId, resource2Id, noteId, options) {
    return RequestHelper.put()(
      this,
      endpoint`${resourceId}/${this.resource2Type}/${resource2Id}/notes/${noteId}`,
      options
    );
  }
  remove(resourceId, resource2Id, noteId, options) {
    return RequestHelper.del()(
      this,
      endpoint`${resourceId}/${this.resource2Type}/${resource2Id}/notes/${noteId}`,
      options
    );
  }
  show(resourceId, resource2Id, noteId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/${this.resource2Type}/${resource2Id}/notes/${noteId}`,
      options
    );
  }
};
var ResourceTemplates = class extends BaseResource {
  static {
    __name(this, "ResourceTemplates");
  }
  constructor(resourceType, options) {
    super({ prefixUrl: ["templates", resourceType].join("/"), ...options });
  }
  all(options) {
    process.emitWarning(
      'This API will be deprecated as of Gitlabs v5 API. Please make the switch to "ProjectTemplates".',
      "DeprecationWarning"
    );
    return RequestHelper.get()(this, "", options);
  }
  show(key, options) {
    process.emitWarning(
      'This API will be deprecated as of Gitlabs v5 API. Please make the switch to "ProjectTemplates".',
      "DeprecationWarning"
    );
    return RequestHelper.get()(this, encodeURIComponent(key), options);
  }
};
var ResourceVariables = class extends BaseResource {
  static {
    __name(this, "ResourceVariables");
  }
  constructor(resourceType, options) {
    super({ prefixUrl: resourceType, ...options });
  }
  all(resourceId, options) {
    return RequestHelper.get()(this, endpoint`${resourceId}/variables`, options);
  }
  create(resourceId, key, value, options) {
    return RequestHelper.post()(this, endpoint`${resourceId}/variables`, {
      key,
      value,
      ...options
    });
  }
  edit(resourceId, key, value, options) {
    return RequestHelper.put()(this, endpoint`${resourceId}/variables/${key}`, {
      value,
      ...options
    });
  }
  show(resourceId, key, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/variables/${key}`,
      options
    );
  }
  remove(resourceId, key, options) {
    return RequestHelper.del()(this, endpoint`${resourceId}/variables/${key}`, options);
  }
};
var ResourceWikis = class extends BaseResource {
  static {
    __name(this, "ResourceWikis");
  }
  constructor(resourceType, options) {
    super({ prefixUrl: resourceType, ...options });
  }
  all(resourceId, options) {
    return RequestHelper.get()(this, endpoint`${resourceId}/wikis`, options);
  }
  create(resourceId, content, title, options) {
    return RequestHelper.post()(this, endpoint`${resourceId}/wikis`, {
      content,
      title,
      ...options
    });
  }
  edit(resourceId, slug, options) {
    return RequestHelper.put()(this, endpoint`${resourceId}/wikis/${slug}`, options);
  }
  remove(resourceId, slug, options) {
    return RequestHelper.del()(this, endpoint`${resourceId}/wikis/${slug}`, options);
  }
  show(resourceId, slug, options) {
    return RequestHelper.get()(this, endpoint`${resourceId}/wikis/${slug}`, options);
  }
  uploadAttachment(resourceId, file, options) {
    return RequestHelper.post()(
      this,
      endpoint`${resourceId}/wikis/attachments`,
      {
        ...options,
        isForm: true,
        file: [file.content, file.filename]
      }
    );
  }
};
var ResourceHooks = class extends BaseResource {
  static {
    __name(this, "ResourceHooks");
  }
  constructor(resourceType, options) {
    super({ prefixUrl: resourceType, ...options });
  }
  add(resourceId, url12, options) {
    return RequestHelper.post()(this, endpoint`${resourceId}/hooks`, {
      url: url12,
      ...options
    });
  }
  all(resourceId, options) {
    return RequestHelper.get()(this, endpoint`${resourceId}/hooks`, options);
  }
  edit(resourceId, hookId, url12, options) {
    return RequestHelper.put()(this, endpoint`${resourceId}/hooks/${hookId}`, {
      url: url12,
      ...options
    });
  }
  remove(resourceId, hookId, options) {
    return RequestHelper.del()(this, endpoint`${resourceId}/hooks/${hookId}`, options);
  }
  show(resourceId, hookId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/hooks/${hookId}`,
      options
    );
  }
};
var ResourcePushRules = class extends BaseResource {
  static {
    __name(this, "ResourcePushRules");
  }
  constructor(resourceType, options) {
    super({ prefixUrl: resourceType, ...options });
  }
  create(resourceId, options) {
    return RequestHelper.post()(this, endpoint`${resourceId}/push_rule`, options);
  }
  edit(resourceId, options) {
    return RequestHelper.put()(this, endpoint`${resourceId}/push_rule`, options);
  }
  remove(resourceId, options) {
    return RequestHelper.del()(this, endpoint`${resourceId}/push_rule`, options);
  }
  show(resourceId, options) {
    return RequestHelper.get()(this, endpoint`${resourceId}/push_rule`, options);
  }
};
var ResourceRepositoryStorageMoves = class extends BaseResource {
  static {
    __name(this, "ResourceRepositoryStorageMoves");
  }
  resourceType;
  resourceTypeSingular;
  constructor(resourceType, options) {
    super(options);
    this.resourceType = resourceType;
    this.resourceTypeSingular = resourceType.substring(0, resourceType.length - 1);
  }
  all(options) {
    const resourceId = options?.[`${this.resourceTypeSingular}Id`];
    const url12 = resourceId ? endpoint`${this.resourceType}/${resourceId}/repository_storage_moves` : `${this.resourceTypeSingular}_repository_storage_moves`;
    return RequestHelper.get()(this, url12, options);
  }
  show(repositoryStorageId, options) {
    const resourceId = options?.[`${this.resourceTypeSingular}Id`];
    const url12 = resourceId ? endpoint`${this.resourceType}/${resourceId}/repository_storage_moves` : `${this.resourceTypeSingular}_repository_storage_moves`;
    return RequestHelper.get()(
      this,
      `${url12}/${repositoryStorageId}`,
      options
    );
  }
  schedule(sourceStorageName, options) {
    const resourceId = options?.[`${this.resourceTypeSingular}Id`];
    const url12 = resourceId ? endpoint`${this.resourceType}/${resourceId}/repository_storage_moves` : `${this.resourceTypeSingular}_repository_storage_moves`;
    return RequestHelper.post()(this, url12, {
      sourceStorageName,
      ...options
    });
  }
};
var ResourceInvitations = class extends BaseResource {
  static {
    __name(this, "ResourceInvitations");
  }
  constructor(resourceType, options) {
    super({ prefixUrl: resourceType, ...options });
  }
  add(resourceId, accessLevel, options) {
    if (!options?.email && !options?.userId)
      throw new Error(
        "Missing required argument. Please supply a email or a userId in the options parameter."
      );
    return RequestHelper.post()(this, endpoint`${resourceId}/invitations`, {
      accessLevel,
      ...options
    });
  }
  all(resourceId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/invitations`,
      options
    );
  }
  edit(resourceId, email, options) {
    return RequestHelper.put()(
      this,
      endpoint`${resourceId}/invitations/${email}`,
      options
    );
  }
  remove(resourceId, email, options) {
    return RequestHelper.del()(
      this,
      endpoint`${resourceId}/invitations/${email}`,
      options
    );
  }
};
var ResourceIterations = class extends BaseResource {
  static {
    __name(this, "ResourceIterations");
  }
  constructor(resourceType, options) {
    super({ prefixUrl: resourceType, ...options });
  }
  all(resourceId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/iterations`,
      options
    );
  }
};
var ResourceProtectedEnvironments = class extends BaseResource {
  static {
    __name(this, "ResourceProtectedEnvironments");
  }
  constructor(resourceType, options) {
    super({ prefixUrl: resourceType, ...options });
  }
  all(resourceId, options) {
    return RequestHelper.get()(
      this,
      `${resourceId}/protected_environments`,
      options
    );
  }
  create(resourceId, name, deployAccessLevel, options) {
    return RequestHelper.post()(
      this,
      `${resourceId}/protected_environments`,
      {
        name,
        deployAccessLevel,
        ...options
      }
    );
  }
  edit(resourceId, name, options) {
    return RequestHelper.put()(
      this,
      `${resourceId}/protected_environments/${name}`,
      options
    );
  }
  show(resourceId, name, options) {
    return RequestHelper.get()(
      this,
      `${resourceId}/protected_environments/${name}`,
      options
    );
  }
  remove(resourceId, name, options) {
    return RequestHelper.del()(this, `${resourceId}/protected_environments/${name}`, options);
  }
};
var ResourceIterationEvents = class extends BaseResource {
  static {
    __name(this, "ResourceIterationEvents");
  }
  resource2Type;
  constructor(resourceType, resource2Type, options) {
    super({ prefixUrl: resourceType, ...options });
    this.resource2Type = resource2Type;
  }
  all(resourceId, resource2Id, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/${this.resource2Type}/${resource2Id}/resource_iteration_events`,
      options
    );
  }
  show(resourceId, resource2Id, iterationEventId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/${this.resource2Type}/${resource2Id}/resource_iteration_events/${iterationEventId}`,
      options
    );
  }
};
var ResourceLabelEvents = class extends BaseResource {
  static {
    __name(this, "ResourceLabelEvents");
  }
  resource2Type;
  constructor(resourceType, resource2Type, options) {
    super({ prefixUrl: resourceType, ...options });
    this.resource2Type = resource2Type;
  }
  all(resourceId, resource2Id, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/${this.resource2Type}/${resource2Id}/resource_label_events`,
      options
    );
  }
  show(resourceId, resource2Id, labelEventId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/${this.resource2Type}/${resource2Id}/resource_label_events/${labelEventId}`,
      options
    );
  }
};
var ResourceMilestoneEvents = class extends BaseResource {
  static {
    __name(this, "ResourceMilestoneEvents");
  }
  resource2Type;
  constructor(resourceType, resource2Type, options) {
    super({ prefixUrl: resourceType, ...options });
    this.resource2Type = resource2Type;
  }
  all(resourceId, resource2Id, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/${this.resource2Type}/${resource2Id}/resource_milestone_events`,
      options
    );
  }
  show(resourceId, resource2Id, milestoneEventId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/${this.resource2Type}/${resource2Id}/resource_milestone_events/${milestoneEventId}`,
      options
    );
  }
};
var ResourceStateEvents = class extends BaseResource {
  static {
    __name(this, "ResourceStateEvents");
  }
  resource2Type;
  constructor(resourceType, resource2Type, options) {
    super({ prefixUrl: resourceType, ...options });
    this.resource2Type = resource2Type;
  }
  all(resourceId, resource2Id, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/${this.resource2Type}/${resource2Id}/resource_state_events`,
      options
    );
  }
  show(resourceId, resource2Id, stateEventId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${resourceId}/${this.resource2Type}/${resource2Id}/resource_state_events/${stateEventId}`,
      options
    );
  }
};
var DockerfileTemplates = class extends ResourceTemplates {
  static {
    __name(this, "DockerfileTemplates");
  }
  constructor(options) {
    super("dockerfiles", options);
  }
};
var Events = class extends BaseResource {
  static {
    __name(this, "Events");
  }
  all({
    projectId,
    userId,
    ...options
  } = {}) {
    let url12;
    if (projectId) url12 = endpoint`projects/${projectId}/events`;
    else if (userId) url12 = endpoint`users/${userId}/events`;
    else url12 = "events";
    return RequestHelper.get()(this, url12, options);
  }
};
var Experiments = class extends BaseResource {
  static {
    __name(this, "Experiments");
  }
  all(options) {
    return RequestHelper.get()(this, "experiments", options);
  }
};
var GeoNodes = class extends BaseResource {
  static {
    __name(this, "GeoNodes");
  }
  all(options) {
    return RequestHelper.get()(this, "geo_nodes", options);
  }
  allStatuses(options) {
    return RequestHelper.get()(this, "geo_nodes/statuses", options);
  }
  allFailures(options) {
    return RequestHelper.get()(this, "geo_nodes/current/failures", options);
  }
  create(name, url12, options) {
    return RequestHelper.post()(this, "geo_nodes", { name, url: url12, ...options });
  }
  edit(geonodeId, options) {
    return RequestHelper.put()(this, `geo_nodes/${geonodeId}`, options);
  }
  repair(geonodeId, options) {
    return RequestHelper.post()(this, `geo_nodes/${geonodeId}/repair`, options);
  }
  remove(geonodeId, options) {
    return RequestHelper.del()(this, `geo_nodes/${geonodeId}`, options);
  }
  show(geonodeId, options) {
    return RequestHelper.get()(this, `geo_nodes/${geonodeId}`, options);
  }
  showStatus(geonodeId, options) {
    return RequestHelper.get()(this, `geo_nodes/${geonodeId}/status`, options);
  }
};
var GeoSites = class extends BaseResource {
  static {
    __name(this, "GeoSites");
  }
  all(options) {
    return RequestHelper.get()(this, "geo_sites", options);
  }
  allStatuses(options) {
    return RequestHelper.get()(this, "geo_sites/statuses", options);
  }
  allFailures(options) {
    return RequestHelper.get()(this, "geo_sites/current/failures", options);
  }
  create(name, url12, options) {
    return RequestHelper.post()(this, "geo_sites", { name, url: url12, ...options });
  }
  edit(geositeId, options) {
    return RequestHelper.put()(this, `geo_sites/${geositeId}`, options);
  }
  repair(geositeId, options) {
    return RequestHelper.post()(this, `geo_sites/${geositeId}/repair`, options);
  }
  remove(geositeId, options) {
    return RequestHelper.del()(this, `geo_sites/${geositeId}`, options);
  }
  show(geositeId, options) {
    return RequestHelper.get()(this, `geo_sites/${geositeId}`, options);
  }
  showStatus(geositeId, options) {
    return RequestHelper.get()(this, `geo_sites/${geositeId}/status`, options);
  }
};
var GitLabCIYMLTemplates = class extends ResourceTemplates {
  static {
    __name(this, "GitLabCIYMLTemplates");
  }
  constructor(options) {
    super("gitlab_ci_ymls", options);
  }
};
var GitignoreTemplates = class extends ResourceTemplates {
  static {
    __name(this, "GitignoreTemplates");
  }
  constructor(options) {
    super("gitignores", options);
  }
};
var Import = class extends BaseResource {
  static {
    __name(this, "Import");
  }
  importGithubRepository(personalAccessToken, repositoryId, targetNamespace, options) {
    return RequestHelper.post()(this, "import/github", {
      personalAccessToken,
      repoId: repositoryId,
      targetNamespace,
      ...options
    });
  }
  cancelGithubRepositoryImport(projectId, options) {
    return RequestHelper.post()(this, "import/github/cancel", {
      projectId,
      ...options
    });
  }
  importGithubGists(personalAccessToken, options) {
    return RequestHelper.post()(this, "import/github/gists", {
      personalAccessToken,
      ...options
    });
  }
  importBitbucketServerRepository(bitbucketServerUrl, bitbucketServerUsername, personalAccessToken, bitbucketServerProject, bitbucketServerRepository, options) {
    return RequestHelper.post()(this, "import/bitbucket_server", {
      bitbucketServerUrl,
      bitbucketServerUsername,
      personalAccessToken,
      bitbucketServerProject,
      bitbucketServerRepo: bitbucketServerRepository,
      ...options
    });
  }
};
var InstanceLevelCICDVariables = class extends BaseResource {
  static {
    __name(this, "InstanceLevelCICDVariables");
  }
  all(options) {
    return RequestHelper.get()(this, "admin/ci/variables", options);
  }
  create(key, value, options) {
    return RequestHelper.post()(this, "admin/ci/variables", {
      key,
      value,
      ...options
    });
  }
  edit(keyId, value, options) {
    return RequestHelper.put()(this, endpoint`admin/ci/variables/${keyId}`, {
      value,
      ...options
    });
  }
  show(keyId, options) {
    return RequestHelper.get()(
      this,
      endpoint`admin/ci/variables/${keyId}`,
      options
    );
  }
  remove(keyId, options) {
    return RequestHelper.get()(this, endpoint`admin/ci/variables/${keyId}`, options);
  }
};
var Keys = class extends BaseResource {
  static {
    __name(this, "Keys");
  }
  show({
    keyId,
    fingerprint,
    ...options
  } = {}) {
    let url12;
    if (keyId) url12 = `keys/${keyId}`;
    else if (fingerprint) url12 = `keys?fingerprint=${fingerprint}`;
    else {
      throw new Error(
        "Missing required argument. Please supply a fingerprint or a keyId in the options parameter"
      );
    }
    return RequestHelper.get()(this, url12, options);
  }
};
var License = class extends BaseResource {
  static {
    __name(this, "License");
  }
  add(license, options) {
    return RequestHelper.post()(this, "license", {
      searchParams: { license },
      ...options
    });
  }
  all(options) {
    return RequestHelper.get()(this, "licenses", options);
  }
  show(options) {
    return RequestHelper.get()(this, "license", options);
  }
  remove(licenceId, options) {
    return RequestHelper.del()(this, `license/${licenceId}`, options);
  }
  recalculateBillableUsers(licenceId, options) {
    return RequestHelper.put()(
      this,
      `license/${licenceId}/refresh_billable_users`,
      options
    );
  }
};
var LicenseTemplates = class extends ResourceTemplates {
  static {
    __name(this, "LicenseTemplates");
  }
  constructor(options) {
    super("Licenses", options);
  }
};
var Lint = class extends BaseResource {
  static {
    __name(this, "Lint");
  }
  check(projectId, options) {
    return RequestHelper.get()(this, endpoint`projects/${projectId}/ci/lint`, options);
  }
  lint(projectId, content, options) {
    return RequestHelper.post()(this, endpoint`projects/${projectId}/ci/lint`, {
      ...options,
      content
    });
  }
};
var Markdown = class extends BaseResource {
  static {
    __name(this, "Markdown");
  }
  render(text, options) {
    return RequestHelper.post()(this, "markdown", { text, ...options });
  }
};
var Maven = class extends BaseResource {
  static {
    __name(this, "Maven");
  }
  downloadPackageFile(path, filename, {
    projectId,
    groupId,
    ...options
  }) {
    let url12 = endpoint`packages/maven/${path}/${filename}`;
    if (projectId) url12 = endpoint`projects/${projectId}/${url12}`;
    else if (groupId) url12 = endpoint`groups/${groupId}/-/${url12}`;
    return RequestHelper.get()(this, url12, options);
  }
  uploadPackageFile(projectId, path, packageFile, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/packages/maven/${path}/${packageFile.filename}`,
      {
        isForm: true,
        ...options,
        file: [packageFile.content, packageFile.filename]
      }
    );
  }
};
var Metadata = class extends BaseResource {
  static {
    __name(this, "Metadata");
  }
  show(options) {
    return RequestHelper.get()(this, "metadata", options);
  }
};
var Migrations = class extends BaseResource {
  static {
    __name(this, "Migrations");
  }
  all(options) {
    return RequestHelper.get()(this, "bulk_imports", options);
  }
  create(configuration, entities, options) {
    return RequestHelper.post()(this, "bulk_imports", {
      configuration,
      entities,
      ...options
    });
  }
  allEntities({
    bulkImportId,
    ...options
  } = {}) {
    const url12 = bulkImportId ? endpoint`bulk_imports/${bulkImportId}/entities` : "bulk_imports/entities";
    return RequestHelper.get()(this, url12, options);
  }
  show(bulkImportId, options) {
    return RequestHelper.get()(
      this,
      `bulk_imports/${bulkImportId}`,
      options
    );
  }
  showEntity(bulkImportId, entitityId, options) {
    return RequestHelper.get()(
      this,
      `bulk_imports/${bulkImportId}/entities/${entitityId}`,
      options
    );
  }
};
function url6(projectId) {
  return projectId ? endpoint`/projects/${projectId}/packages/npm` : "packages/npm";
}
__name(url6, "url6");
var NPM = class extends BaseResource {
  static {
    __name(this, "NPM");
  }
  downloadPackageFile(projectId, packageName, filename, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/packages/npm/${packageName}/-/${filename}`,
      options
    );
  }
  removeDistTag(packageName, tag, options) {
    const prefix = url6(options?.projectId);
    return RequestHelper.del()(
      this,
      `${prefix}/-/package/${packageName}/dist-tags/${tag}`,
      options
    );
  }
  setDistTag(packageName, tag, options) {
    const prefix = url6(options?.projectId);
    return RequestHelper.put()(
      this,
      `${prefix}/-/package/${packageName}/dist-tags/${tag}`,
      options
    );
  }
  showDistTags(packageName, options) {
    const prefix = url6(options?.projectId);
    return RequestHelper.get()(
      this,
      `${prefix}/-/package/${packageName}/dist-tags`,
      options
    );
  }
  showMetadata(packageName, options) {
    const prefix = url6(options?.projectId);
    return RequestHelper.get()(this, `${prefix}/${packageName}`, options);
  }
  uploadPackageFile(projectId, packageName, versions, metadata, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/packages/npm/${packageName}`,
      {
        ...options,
        versions,
        ...metadata
      }
    );
  }
};
var Namespaces = class extends BaseResource {
  static {
    __name(this, "Namespaces");
  }
  all(options) {
    return RequestHelper.get()(this, "namespaces", options);
  }
  exists(namespace, options) {
    return RequestHelper.get()(
      this,
      endpoint`namespaces/${namespace}/exists`,
      options
    );
  }
  show(namespaceId, options) {
    return RequestHelper.get()(this, endpoint`namespaces/${namespaceId}`, options);
  }
};
function url7({
  projectId,
  groupId
} = {}) {
  let prefix = "";
  if (projectId) prefix = endpoint`projects/${projectId}/`;
  if (groupId) prefix = endpoint`groups/${groupId}/`;
  return `${prefix}notification_settings`;
}
__name(url7, "url7");
var NotificationSettings = class extends BaseResource {
  static {
    __name(this, "NotificationSettings");
  }
  edit({
    groupId,
    projectId,
    ...options
  } = {}) {
    const uri = url7({ groupId, projectId });
    return RequestHelper.put()(this, uri, options);
  }
  show({
    groupId,
    projectId,
    ...options
  } = {}) {
    const uri = url7({ groupId, projectId });
    return RequestHelper.get()(this, uri, options);
  }
};
function url8({
  projectId,
  groupId
} = {}) {
  if (projectId) return endpoint`/projects/${projectId}/packages/nuget`;
  if (groupId) return endpoint`/groups/${groupId}/-/packages/nuget`;
  throw new Error(
    "Missing required argument. Please supply a projectId or a groupId in the options parameter"
  );
}
__name(url8, "url8");
var NuGet = class extends BaseResource {
  static {
    __name(this, "NuGet");
  }
  downloadPackageFile(projectId, packageName, packageVersion, filename, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/packages/nuget/download/${packageName}/${packageVersion}/${filename}`,
      options
    );
  }
  search(q, {
    projectId,
    groupId,
    ...options
  }) {
    const uri = url8({ projectId, groupId });
    return RequestHelper.get()(this, `${uri}/query`, { q, ...options });
  }
  showMetadata(packageName, {
    projectId,
    groupId,
    ...options
  }) {
    const uri = url8({ projectId, groupId });
    return RequestHelper.get()(
      this,
      `${uri}/metadata/${packageName}/index`,
      options
    );
  }
  showPackageIndex(projectId, packageName, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/packages/nuget/download/${packageName}/index`,
      options
    );
  }
  showServiceIndex({
    projectId,
    groupId,
    ...options
  }) {
    const uri = url8({ projectId, groupId });
    return RequestHelper.get()(
      this,
      `${uri}/index`,
      options
    );
  }
  showVersionMetadata(packageName, packageVersion, {
    projectId,
    groupId,
    ...options
  }) {
    const uri = url8({ projectId, groupId });
    return RequestHelper.get()(
      this,
      `${uri}/metadata/${packageName}/${packageVersion}`,
      options
    );
  }
  uploadPackageFile(projectId, packageName, packageVersion, packageFile, options) {
    return RequestHelper.put()(this, endpoint`projects/${projectId}/packages/nuget`, {
      isForm: true,
      ...options,
      packageName,
      packageVersion,
      file: [packageFile.content, packageFile.filename]
    });
  }
  uploadSymbolPackage(projectId, packageName, packageVersion, packageFile, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/packages/nuget/symbolpackage`,
      {
        isForm: true,
        ...options,
        packageName,
        packageVersion,
        file: [packageFile.content, packageFile.filename]
      }
    );
  }
};
var PersonalAccessTokens = class extends BaseResource {
  static {
    __name(this, "PersonalAccessTokens");
  }
  all(options) {
    return RequestHelper.get()(
      this,
      "personal_access_tokens",
      options
    );
  }
  // Convience method - Also located in Users
  create(userId, name, scopes, options) {
    return RequestHelper.post()(
      this,
      endpoint`users/${userId}/personal_access_tokens`,
      {
        name,
        scopes,
        ...options
      }
    );
  }
  remove({
    tokenId,
    ...options
  } = {}) {
    const url12 = tokenId ? endpoint`personal_access_tokens/${tokenId}` : "personal_access_tokens/self";
    return RequestHelper.del()(this, url12, options);
  }
  rotate(tokenId, options) {
    return RequestHelper.post()(
      this,
      endpoint`personal_access_tokens/${tokenId}/rotate`,
      options
    );
  }
  show({
    tokenId,
    ...options
  } = {}) {
    const url12 = tokenId ? endpoint`personal_access_tokens/${tokenId}` : "personal_access_tokens/self";
    return RequestHelper.get()(this, url12, options);
  }
};
var PyPI = class extends BaseResource {
  static {
    __name(this, "PyPI");
  }
  downloadPackageFile(sha, fileIdentifier, {
    projectId,
    groupId,
    ...options
  } = {}) {
    let url12;
    if (projectId) {
      url12 = endpoint`projects/${projectId}/packages/pypi/files/${sha}/${fileIdentifier}`;
    } else if (groupId) {
      url12 = endpoint`groups/${groupId}/packages/pypi/files/${sha}/${fileIdentifier}`;
    } else {
      throw new Error(
        "Missing required argument. Please supply a projectId or a groupId in the options parameter"
      );
    }
    return RequestHelper.get()(this, url12, options);
  }
  showPackageDescriptor(packageName, {
    projectId,
    groupId,
    ...options
  }) {
    let url12;
    if (projectId) {
      url12 = endpoint`projects/${projectId}/packages/pypi/simple/${packageName}`;
    } else if (groupId) {
      url12 = endpoint`groups/${groupId}/packages/pypi/simple/${packageName}`;
    } else {
      throw new Error(
        "Missing required argument. Please supply a projectId or a groupId in the options parameter"
      );
    }
    return RequestHelper.get()(this, url12, options);
  }
  uploadPackageFile(projectId, packageFile, options) {
    return RequestHelper.put()(this, endpoint`projects/${projectId}/packages/pypi`, {
      ...options,
      isForm: true,
      file: [packageFile.content, packageFile.filename]
    });
  }
};
var RubyGems = class extends BaseResource {
  static {
    __name(this, "RubyGems");
  }
  allDependencies(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/packages/rubygems/api/v1/dependencies`,
      options
    );
  }
  downloadGemFile(projectId, fileName, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/packages/rubygems/gems/${fileName}`,
      options
    );
  }
  uploadGemFile(projectId, packageFile, options) {
    return RequestHelper.post()(this, `projects/${projectId}/packages/rubygems/api/v1/gems`, {
      isForm: true,
      ...options,
      file: [packageFile.content, packageFile.filename]
    });
  }
};
var Search = class extends BaseResource {
  static {
    __name(this, "Search");
  }
  all(scope, search, options) {
    const { projectId, groupId, ...opts } = options || {};
    let url12;
    if (projectId) url12 = endpoint`projects/${projectId}/`;
    else if (groupId) url12 = endpoint`groups/${groupId}/`;
    else url12 = "";
    return RequestHelper.get()(this, `${url12}search`, {
      scope,
      search,
      ...opts
    });
  }
};
var SearchAdmin = class extends BaseResource {
  static {
    __name(this, "SearchAdmin");
  }
  all(options) {
    return RequestHelper.get()(this, "admin/search/migrations", options);
  }
  show(versionOrName, options) {
    return RequestHelper.get()(
      this,
      endpoint`admin/search/migrations/${versionOrName}`,
      options
    );
  }
};
var ServiceAccounts = class extends BaseResource {
  static {
    __name(this, "ServiceAccounts");
  }
  create(options) {
    return RequestHelper.post()(this, endpoint`service_accounts`, options);
  }
};
var ServiceData = class extends BaseResource {
  static {
    __name(this, "ServiceData");
  }
  showMetricDefinitions(options) {
    return RequestHelper.get()(this, "usage_data/metric_definitions", options);
  }
  showServicePingSQLQueries(options) {
    return RequestHelper.get()(this, "usage_data/queries", options);
  }
  showUsageDataNonSQLMetrics(options) {
    return RequestHelper.get()(
      this,
      "usage_data/non_sql_metrics",
      options
    );
  }
};
var SidekiqMetrics = class extends BaseResource {
  static {
    __name(this, "SidekiqMetrics");
  }
  queueMetrics() {
    return RequestHelper.get()(this, "sidekiq/queue_metrics");
  }
  processMetrics() {
    return RequestHelper.get()(this, "sidekiq/process_metrics");
  }
  jobStats() {
    return RequestHelper.get()(this, "sidekiq/job_stats");
  }
  compoundMetrics() {
    return RequestHelper.get()(this, "sidekiq/compound_metrics");
  }
};
var SidekiqQueues = class extends BaseResource {
  static {
    __name(this, "SidekiqQueues");
  }
  remove(queueName, options) {
    return RequestHelper.get()(
      this,
      endpoint`admin/sidekiq/queues/${queueName}`,
      options
    );
  }
};
var SnippetRepositoryStorageMoves = class extends ResourceRepositoryStorageMoves {
  static {
    __name(this, "SnippetRepositoryStorageMoves");
  }
  constructor(options) {
    super("snippets", options);
  }
};
var Snippets = class extends BaseResource {
  static {
    __name(this, "Snippets");
  }
  all({
    public: ppublic,
    ...options
  } = {}) {
    const url12 = ppublic ? "snippets/public" : "snippets";
    return RequestHelper.get()(this, url12, options);
  }
  create(title, options) {
    return RequestHelper.post()(this, "snippets", {
      title,
      ...options
    });
  }
  edit(snippetId, options) {
    return RequestHelper.put()(this, `snippets/${snippetId}`, options);
  }
  remove(snippetId, options) {
    return RequestHelper.del()(this, `snippets/${snippetId}`, options);
  }
  show(snippetId, options) {
    return RequestHelper.get()(this, `snippets/${snippetId}`, options);
  }
  showContent(snippetId, options) {
    return RequestHelper.get()(this, `snippets/${snippetId}/raw`, options);
  }
  showRepositoryFileContent(snippetId, ref, filePath, options) {
    return RequestHelper.get()(
      this,
      endpoint`snippets/${snippetId}/files/${ref}/${filePath}/raw`,
      options
    );
  }
  showUserAgentDetails(snippetId, options) {
    return RequestHelper.get()(
      this,
      `snippets/${snippetId}/user_agent_detail`,
      options
    );
  }
};
var Suggestions = class extends BaseResource {
  static {
    __name(this, "Suggestions");
  }
  edit(suggestionId, options) {
    return RequestHelper.put()(
      this,
      `suggestions/${suggestionId}/apply`,
      options
    );
  }
  editBatch(suggestionIds, options) {
    return RequestHelper.put()(this, `suggestions/batch_apply`, {
      ...options,
      ids: suggestionIds
    });
  }
};
var SystemHooks = class extends BaseResource {
  static {
    __name(this, "SystemHooks");
  }
  all(options) {
    return RequestHelper.get()(this, "hooks", options);
  }
  // Convenience method
  add(url12, options) {
    return this.create(url12, options);
  }
  create(url12, options) {
    return RequestHelper.post()(this, "hooks", {
      url: url12,
      ...options
    });
  }
  test(hookId, options) {
    return RequestHelper.post()(this, `hooks/${hookId}`, options);
  }
  remove(hookId, options) {
    return RequestHelper.del()(this, `hooks/${hookId}`, options);
  }
  show(hookId, options) {
    return RequestHelper.post()(this, `hooks/${hookId}`, options);
  }
};
var TodoLists = class extends BaseResource {
  static {
    __name(this, "TodoLists");
  }
  all(options) {
    return RequestHelper.get()(this, "todos", options);
  }
  done({
    todoId,
    ...options
  } = {}) {
    let prefix = "todos";
    if (todoId) prefix += `/${todoId}`;
    return RequestHelper.post()(
      this,
      `${prefix}/mark_as_done`,
      options
    );
  }
};
var Topics = class extends BaseResource {
  static {
    __name(this, "Topics");
  }
  all(options) {
    return RequestHelper.get()(this, "topics", options);
  }
  create(name, {
    avatar,
    ...options
  } = {}) {
    const opts = {
      name,
      ...options
    };
    if (avatar) {
      opts.isForm = true;
      opts.file = [avatar.content, avatar.filename];
    }
    return RequestHelper.post()(this, "topics", opts);
  }
  edit(topicId, {
    avatar,
    ...options
  } = {}) {
    const opts = { ...options };
    if (avatar) {
      opts.isForm = true;
      opts.file = [avatar.content, avatar.filename];
    }
    return RequestHelper.put()(this, `topics/${topicId}`, opts);
  }
  merge(sourceTopicId, targetTopicId, options) {
    return RequestHelper.post()(this, `topics/merge`, {
      sourceTopicId,
      targetTopicId,
      ...options
    });
  }
  remove(topicId, options) {
    return RequestHelper.del()(this, `topics/${topicId}`, options);
  }
  show(topicId, options) {
    return RequestHelper.get()(this, `topics/${topicId}`, options);
  }
};
var Branches = class extends BaseResource {
  static {
    __name(this, "Branches");
  }
  all(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/repository/branches`,
      options
    );
  }
  create(projectId, branchName, ref, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/repository/branches`,
      {
        branch: branchName,
        ref,
        ...options
      }
    );
  }
  remove(projectId, branchName, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/repository/branches/${branchName}`,
      options
    );
  }
  removeMerged(projectId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/repository/merged_branches`,
      options
    );
  }
  show(projectId, branchName, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/repository/branches/${branchName}`,
      options
    );
  }
};
var CommitDiscussions = class extends ResourceDiscussions {
  static {
    __name(this, "CommitDiscussions");
  }
  constructor(options) {
    super("projects", new RawPathSegment("repository/commits"), options);
  }
};
var Commits = class extends BaseResource {
  static {
    __name(this, "Commits");
  }
  all(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/repository/commits`,
      options
    );
  }
  allComments(projectId, sha, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/repository/commits/${sha}/comments`,
      options
    );
  }
  allDiscussions(projectId, sha, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/repository/commits/${sha}/discussions`,
      options
    );
  }
  allMergeRequests(projectId, sha, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/repository/commits/${sha}/merge_requests`,
      options
    );
  }
  allReferences(projectId, sha, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/repository/commits/${sha}/refs`,
      options
    );
  }
  allStatuses(projectId, sha, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/repository/commits/${sha}/statuses`,
      options
    );
  }
  cherryPick(projectId, sha, branch, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/repository/commits/${sha}/cherry_pick`,
      {
        branch,
        ...options
      }
    );
  }
  create(projectId, branch, message, actions = [], options = {}) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/repository/commits`,
      {
        branch,
        commitMessage: message,
        actions,
        ...options
      }
    );
  }
  createComment(projectId, sha, note, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/repository/commits/${sha}/comments`,
      {
        note,
        ...options
      }
    );
  }
  editStatus(projectId, sha, state, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/statuses/${sha}`,
      {
        state,
        ...options
      }
    );
  }
  revert(projectId, sha, branch, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/repository/commits/${sha}/revert`,
      {
        ...options,
        branch
      }
    );
  }
  show(projectId, sha, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/repository/commits/${sha}`,
      options
    );
  }
  showDiff(projectId, sha, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/repository/commits/${sha}/diff`,
      options
    );
  }
  showGPGSignature(projectId, sha, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/repository/commits/${sha}/signature`,
      options
    );
  }
};
var ContainerRegistry = class extends BaseResource {
  static {
    __name(this, "ContainerRegistry");
  }
  allRepositories({
    groupId,
    projectId,
    ...options
  } = {}) {
    let url12;
    if (groupId) url12 = endpoint`groups/${groupId}/registry/repositories`;
    else if (projectId) url12 = endpoint`projects/${projectId}/registry/repositories`;
    else
      throw new Error(
        "Missing required argument. Please supply a groupId or a projectId in the options parameter."
      );
    return RequestHelper.get()(this, url12, options);
  }
  allTags(projectId, repositoryId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/registry/repositories/${repositoryId}/tags`,
      options
    );
  }
  editRegistryVisibility(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}`,
      options
    );
  }
  removeRepository(projectId, repositoryId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/registry/repositories/${repositoryId}`,
      options
    );
  }
  removeTag(projectId, repositoryId, tagName, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/registry/repositories/${repositoryId}/tags/${tagName}`,
      options
    );
  }
  removeTags(projectId, repositoryId, nameRegexDelete, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/registry/repositories/${repositoryId}/tags`,
      {
        nameRegexDelete,
        ...options
      }
    );
  }
  showRepository(repositoryId, options) {
    return RequestHelper.get()(
      this,
      endpoint`registry/repositories/${repositoryId}`,
      options
    );
  }
  showTag(projectId, repositoryId, tagName, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/registry/repositories/${repositoryId}/tags/${tagName}`,
      options
    );
  }
};
var Deployments = class extends BaseResource {
  static {
    __name(this, "Deployments");
  }
  all(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/deployments`,
      options
    );
  }
  allMergeRequests(projectId, deploymentId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/deployments/${deploymentId}/merge_requests`,
      options
    );
  }
  create(projectId, environment, sha, ref, tag, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/deployments`,
      {
        environment,
        sha,
        ref,
        tag,
        ...options
      }
    );
  }
  edit(projectId, deploymentId, status, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/deployments/${deploymentId}`,
      {
        ...options,
        status
      }
    );
  }
  remove(projectId, deploymentId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/deployments/${deploymentId}`,
      options
    );
  }
  setApproval(projectId, deploymentId, status, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/deployments/${deploymentId}/approval`,
      {
        ...options,
        status
      }
    );
  }
  show(projectId, deploymentId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/deployments/${deploymentId}`,
      options
    );
  }
};
var Environments = class extends BaseResource {
  static {
    __name(this, "Environments");
  }
  all(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/environments`,
      options
    );
  }
  create(projectId, name, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/environments`,
      {
        name,
        ...options
      }
    );
  }
  edit(projectId, environmentId, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/environments/${environmentId}`,
      options
    );
  }
  remove(projectId, environmentId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/environments/${environmentId}`,
      options
    );
  }
  removeReviewApps(projectId, options) {
    return RequestHelper.del()(this, endpoint`projects/${projectId}/environments/review_apps`, options);
  }
  show(projectId, environmentId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/environments/${environmentId}`,
      options
    );
  }
  stop(projectId, environmentId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/environments/${environmentId}/stop`,
      options
    );
  }
  stopStale(projectId, before, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/environments/stop_stale`,
      {
        searchParams: { before },
        ...options
      }
    );
  }
};
var ErrorTrackingClientKeys = class extends BaseResource {
  static {
    __name(this, "ErrorTrackingClientKeys");
  }
  all(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/error_tracking/client_keys`,
      options
    );
  }
  create(projectId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/error_tracking/client_keys`,
      options
    );
  }
  remove(projectId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/error_tracking/client_keys`,
      options
    );
  }
};
var ErrorTrackingSettings = class extends BaseResource {
  static {
    __name(this, "ErrorTrackingSettings");
  }
  create(projectId, active, integrated, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/error_tracking/settings`,
      {
        searchParams: {
          active,
          integrated
        },
        ...options
      }
    );
  }
  edit(projectId, active, { integrated, ...options } = {}) {
    return RequestHelper.patch()(
      this,
      endpoint`projects/${projectId}/error_tracking/settings`,
      {
        searchParams: {
          active,
          integrated
        },
        ...options
      }
    );
  }
  show(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/error_tracking/settings`,
      options
    );
  }
};
var ExternalStatusChecks = class extends BaseResource {
  static {
    __name(this, "ExternalStatusChecks");
  }
  all(projectId, options) {
    const { mergerequestIId, ...opts } = options || {};
    let url12 = endpoint`projects/${projectId}`;
    if (mergerequestIId) {
      url12 += endpoint`/merge_requests/${mergerequestIId}/status_checks`;
    } else {
      url12 += "/external_status_checks";
    }
    return RequestHelper.get()(this, url12, opts);
  }
  create(projectId, name, externalUrl, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/external_status_checks`,
      {
        name,
        externalUrl,
        ...options
      }
    );
  }
  edit(projectId, externalStatusCheckId, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/external_status_checks/${externalStatusCheckId}`,
      options
    );
  }
  remove(projectId, externalStatusCheckId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/external_status_checks/${externalStatusCheckId}`,
      options
    );
  }
  set(projectId, mergerequestIId, sha, externalStatusCheckId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/status_check_responses`,
      {
        sha,
        externalStatusCheckId,
        ...options
      }
    );
  }
};
var FeatureFlagUserLists = class extends BaseResource {
  static {
    __name(this, "FeatureFlagUserLists");
  }
  all(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/feature_flags_user_lists`,
      options
    );
  }
  create(projectId, name, userXids, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/feature_flags_user_lists`,
      {
        name,
        userXids,
        ...options
      }
    );
  }
  edit(projectId, featureFlagUserListIId, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/feature_flags_user_lists/${featureFlagUserListIId}`,
      options
    );
  }
  remove(projectId, featureFlagUserListIId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/feature_flags_user_lists/${featureFlagUserListIId}`,
      options
    );
  }
  show(projectId, featureFlagUserListIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/feature_flags_user_lists/${featureFlagUserListIId}`,
      options
    );
  }
};
var FeatureFlags = class extends BaseResource {
  static {
    __name(this, "FeatureFlags");
  }
  all(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/feature_flags`,
      options
    );
  }
  create(projectId, flagName, version, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/feature_flags`,
      {
        name: flagName,
        version,
        ...options
      }
    );
  }
  edit(projectId, featureFlagName, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/feature_flags/${featureFlagName}`,
      options
    );
  }
  remove(projectId, flagName, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/feature_flags/${flagName}`,
      options
    );
  }
  show(projectId, flagName, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/feature_flags/${flagName}`,
      options
    );
  }
};
var FreezePeriods = class extends BaseResource {
  static {
    __name(this, "FreezePeriods");
  }
  all(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/freeze_periods`,
      options
    );
  }
  create(projectId, freezeStart, freezeEnd, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/freeze_periods`,
      {
        freezeStart,
        freezeEnd,
        ...options
      }
    );
  }
  edit(projectId, freezePeriodId, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/freeze_periods/${freezePeriodId}`,
      options
    );
  }
  remove(projectId, freezePeriodId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/freeze_periods/${freezePeriodId}`,
      options
    );
  }
  show(projectId, freezePeriodId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/freeze_periods/${freezePeriodId}`,
      options
    );
  }
};
var GitlabPages = class extends BaseResource {
  static {
    __name(this, "GitlabPages");
  }
  remove(projectId, options) {
    return RequestHelper.del()(this, endpoint`projects/${projectId}/pages`, options);
  }
  showSettings(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/pages`,
      options
    );
  }
};
var GoProxy = class extends BaseResource {
  static {
    __name(this, "GoProxy");
  }
  all(projectId, moduleName, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/packages/go/${moduleName}/@v/list`,
      options
    );
  }
  showVersionMetadata(projectId, moduleName, moduleVersion, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/packages/go/${moduleName}/@v/${moduleVersion}.info`,
      options
    );
  }
  downloadModuleFile(projectId, moduleName, moduleVersion, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/packages/go/${moduleName}/@v/${moduleVersion}.mod`,
      options
    );
  }
  downloadModuleSource(projectId, moduleName, moduleVersion, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/packages/go/${moduleName}/@v/${moduleVersion}.zip`,
      options
    );
  }
};
var Helm = class extends BaseResource {
  static {
    __name(this, "Helm");
  }
  downloadChartIndex(projectId, channel, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/packages/helm/${channel}/index.yaml`,
      options
    );
  }
  downloadChart(projectId, channel, filename, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/packages/helm/${channel}/charts/${filename}.tgz`,
      options
    );
  }
  import(projectId, channel, chart, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/packages/helm/api/${channel}/charts`,
      {
        isForm: true,
        ...options,
        chart: [chart.content, chart.filename]
      }
    );
  }
};
var Integrations = class extends BaseResource {
  static {
    __name(this, "Integrations");
  }
  all(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/integrations`,
      options
    );
  }
  edit(projectId, integrationName, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/integrations/${integrationName}`,
      options
    );
  }
  disable(projectId, integrationName, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/integrations/${integrationName}`,
      options
    );
  }
  show(projectId, integrationName, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/integrations/${integrationName}`,
      options
    );
  }
};
var IssueAwardEmojis = class extends ResourceAwardEmojis {
  static {
    __name(this, "IssueAwardEmojis");
  }
  constructor(options) {
    super("projects", "issues", options);
  }
};
var IssueDiscussions = class extends ResourceDiscussions {
  static {
    __name(this, "IssueDiscussions");
  }
  constructor(options) {
    super("projects", "issues", options);
  }
};
var IssueIterationEvents = class extends ResourceIterationEvents {
  static {
    __name(this, "IssueIterationEvents");
  }
  constructor(options) {
    super("projects", "issues", options);
  }
};
var IssueLabelEvents = class extends ResourceLabelEvents {
  static {
    __name(this, "IssueLabelEvents");
  }
  constructor(options) {
    super("projects", "issues", options);
  }
};
var IssueLinks = class extends BaseResource {
  static {
    __name(this, "IssueLinks");
  }
  all(projectId, issueIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/issues/${issueIId}/links`,
      options
    );
  }
  create(projectId, issueIId, targetProjectId, targetIssueIId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/issues/${issueIId}/links`,
      {
        targetProjectId,
        targetIssueIid: targetIssueIId,
        ...options
      }
    );
  }
  remove(projectId, issueIId, issueLinkId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/issues/${issueIId}/links/${issueLinkId}`,
      options
    );
  }
};
var IssueMilestoneEvents = class extends ResourceMilestoneEvents {
  static {
    __name(this, "IssueMilestoneEvents");
  }
  constructor(options) {
    super("projects", "issues", options);
  }
};
var IssueNoteAwardEmojis = class extends ResourceNoteAwardEmojis {
  static {
    __name(this, "IssueNoteAwardEmojis");
  }
  constructor(options) {
    super("issues", options);
  }
};
var IssueNotes = class extends ResourceNotes {
  static {
    __name(this, "IssueNotes");
  }
  constructor(options) {
    super("projects", "issues", options);
  }
};
var IssueStateEvents = class extends ResourceStateEvents {
  static {
    __name(this, "IssueStateEvents");
  }
  constructor(options) {
    super("projects", "issues", options);
  }
};
var IssueWeightEvents = class extends ResourceStateEvents {
  static {
    __name(this, "IssueWeightEvents");
  }
  constructor(options) {
    super("projects", "issues", options);
  }
};
var Issues = class extends BaseResource {
  static {
    __name(this, "Issues");
  }
  addSpentTime(projectId, issueIId, duration, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/issues/${issueIId}/add_spent_time`,
      {
        duration,
        ...options
      }
    );
  }
  addTimeEstimate(projectId, issueIId, duration, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/issues/${issueIId}/time_estimate`,
      {
        duration,
        ...options
      }
    );
  }
  all({
    projectId,
    groupId,
    ...options
  } = {}) {
    let url12;
    if (projectId) url12 = endpoint`projects/${projectId}/issues`;
    else if (groupId) url12 = endpoint`groups/${groupId}/issues`;
    else url12 = "issues";
    return RequestHelper.get()(this, url12, options);
  }
  allMetricImages(projectId, issueIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/issues/${issueIId}/metric_images`,
      options
    );
  }
  allParticipants(projectId, issueIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/issues/${issueIId}/participants`,
      options
    );
  }
  allRelatedMergeRequests(projectId, issueIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/issues/${issueIId}/related_merge_requests`,
      options
    );
  }
  create(projectId, title, options) {
    return RequestHelper.post()(this, endpoint`projects/${projectId}/issues`, {
      ...options,
      title
    });
  }
  createTodo(projectId, issueIId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/issues/${issueIId}/todo`,
      options
    );
  }
  clone(projectId, issueIId, destinationProjectId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/issues/${issueIId}/clone`,
      {
        toProjectId: destinationProjectId,
        ...options
      }
    );
  }
  edit(projectId, issueIId, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/issues/${issueIId}`,
      options
    );
  }
  editMetricImage(projectId, issueIId, imageId, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/issues/${issueIId}/metric_images/${imageId}`,
      options
    );
  }
  move(projectId, issueIId, destinationProjectId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/issues/${issueIId}/move`,
      {
        toProjectId: destinationProjectId,
        ...options
      }
    );
  }
  // Includes /promote already!
  promote(projectId, issueIId, body, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/issues/${issueIId}/notes`,
      {
        searchParams: {
          body: `${body} 
 /promote`
        },
        ...options
      }
    );
  }
  remove(projectId, issueIId, options) {
    return RequestHelper.del()(this, endpoint`projects/${projectId}/issues/${issueIId}`, options);
  }
  removeMetricImage(projectId, issueIId, imageId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/issues/${issueIId}/metric_images/${imageId}`,
      options
    );
  }
  reorder(projectId, issueIId, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/issues/${issueIId}/reorder`,
      options
    );
  }
  resetSpentTime(projectId, issueIId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/issues/${issueIId}/reset_spent_time`,
      options
    );
  }
  resetTimeEstimate(projectId, issueIId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/issues/${issueIId}/reset_time_estimate`,
      options
    );
  }
  show(issueId, { projectId, ...options } = {}) {
    const url12 = projectId ? endpoint`projects/${projectId}/issues/${issueId}` : `issues/${issueId}`;
    return RequestHelper.get()(this, url12, options);
  }
  subscribe(projectId, issueIId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/issues/${issueIId}/subscribe`,
      options
    );
  }
  allClosedByMergeRequestst(projectId, issueIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/issues/${issueIId}/closed_by`,
      options
    );
  }
  showTimeStats(projectId, issueIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/issues/${issueIId}/time_stats`,
      options
    );
  }
  unsubscribe(projectId, issueIId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/issues/${issueIId}/unsubscribe`,
      options
    );
  }
  uploadMetricImage(projectId, issueIId, metricImage, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/issues/${issueIId}/metric_images`,
      {
        isForm: true,
        ...options,
        file: [metricImage.content, metricImage.filename]
      }
    );
  }
  showUserAgentDetails(projectId, issueIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/issues/${issueIId}/user_agent_details`,
      options
    );
  }
};
var IssuesStatistics = class extends BaseResource {
  static {
    __name(this, "IssuesStatistics");
  }
  all({
    projectId,
    groupId,
    ...options
  } = {}) {
    let url12;
    if (projectId) url12 = endpoint`projects/${projectId}/issues_statistics`;
    else if (groupId) url12 = endpoint`groups/${groupId}/issues_statistics`;
    else url12 = "issues_statistics";
    return RequestHelper.get()(this, url12, options);
  }
};
function generateDownloadPathForJob(projectId, jobId, artifactPath) {
  let url12 = endpoint`projects/${projectId}/jobs/${jobId}/artifacts`;
  if (artifactPath) url12 += `/${artifactPath}`;
  return url12;
}
__name(generateDownloadPathForJob, "generateDownloadPathForJob");
function generateDownloadPath(projectId, ref, artifactPath) {
  let url12 = endpoint`projects/${projectId}/jobs/artifacts/${ref}`;
  if (artifactPath) {
    url12 += endpoint`/raw/${artifactPath}`;
  } else {
    url12 += endpoint`/download`;
  }
  return url12;
}
__name(generateDownloadPath, "generateDownloadPath");
var JobArtifacts = class extends BaseResource {
  static {
    __name(this, "JobArtifacts");
  }
  downloadArchive(projectId, {
    jobId,
    artifactPath,
    ref,
    ...options
  } = {}) {
    let url12;
    if (jobId) url12 = generateDownloadPathForJob(projectId, jobId, artifactPath);
    else if (options?.job && ref) url12 = generateDownloadPath(projectId, ref, artifactPath);
    else
      throw new Error(
        "Missing one of the required parameters. See typing documentation for available arguments."
      );
    return RequestHelper.get()(this, url12, options);
  }
  keep(projectId, jobId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/jobs/${jobId}/artifacts/keep`,
      options
    );
  }
  remove(projectId, { jobId, ...options } = {}) {
    let url12;
    if (jobId) {
      url12 = endpoint`projects/${projectId}/jobs/${jobId}/artifacts`;
    } else {
      url12 = endpoint`projects/${projectId}/artifacts`;
    }
    return RequestHelper.del()(this, url12, options);
  }
};
var Jobs = class extends BaseResource {
  static {
    __name(this, "Jobs");
  }
  all(projectId, {
    pipelineId,
    ...options
  } = {}) {
    const url12 = pipelineId ? endpoint`projects/${projectId}/pipelines/${pipelineId}/jobs` : endpoint`projects/${projectId}/jobs`;
    return RequestHelper.get()(this, url12, options);
  }
  allPipelineBridges(projectId, pipelineId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/pipelines/${pipelineId}/bridges`,
      options
    );
  }
  cancel(projectId, jobId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/jobs/${jobId}/cancel`,
      options
    );
  }
  erase(projectId, jobId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/jobs/${jobId}/erase`,
      options
    );
  }
  play(projectId, jobId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/jobs/${jobId}/play`,
      options
    );
  }
  retry(projectId, jobId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/jobs/${jobId}/retry`,
      options
    );
  }
  show(projectId, jobId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/jobs/${jobId}`,
      options
    );
  }
  showConnectedJob(options) {
    if (!this.headers["job-token"]) throw new Error('Missing required header "job-token"');
    return RequestHelper.get()(this, "job", options);
  }
  showConnectedJobK8Agents(options) {
    if (!this.headers["job-token"]) throw new Error('Missing required header "job-token"');
    return RequestHelper.get()(this, "job/allowed_agents", options);
  }
  showLog(projectId, jobId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/jobs/${jobId}/trace`,
      options
    );
  }
};
var MergeRequestApprovals = class extends BaseResource {
  static {
    __name(this, "MergeRequestApprovals");
  }
  allApprovalRules(projectId, { mergerequestIId, ...options } = {}) {
    let url12;
    if (mergerequestIId) {
      url12 = endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/approval_rules`;
    } else {
      url12 = endpoint`projects/${projectId}/approval_rules`;
    }
    return RequestHelper.get()(this, url12, options);
  }
  approve(projectId, mergerequestIId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/approve`,
      options
    );
  }
  createApprovalRule(projectId, name, approvalsRequired, {
    mergerequestIId,
    ...options
  } = {}) {
    let url12;
    if (mergerequestIId) {
      url12 = endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/approval_rules`;
    } else {
      url12 = endpoint`projects/${projectId}/approval_rules`;
    }
    return RequestHelper.post()(this, url12, { name, approvalsRequired, ...options });
  }
  editApprovalRule(projectId, approvalRuleId, name, approvalsRequired, {
    mergerequestIId,
    ...options
  } = {}) {
    let url12;
    if (mergerequestIId) {
      url12 = endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/approval_rules/${approvalRuleId}`;
    } else {
      url12 = endpoint`projects/${projectId}/approval_rules/${approvalRuleId}`;
    }
    return RequestHelper.put()(this, url12, { name, approvalsRequired, ...options });
  }
  editConfiguration(projectId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/approvals`,
      options
    );
  }
  removeApprovalRule(projectId, approvalRuleId, {
    mergerequestIId,
    ...options
  } = {}) {
    let url12;
    if (mergerequestIId) {
      url12 = endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/approval_rules/${approvalRuleId}`;
    } else {
      url12 = endpoint`projects/${projectId}/approval_rules/${approvalRuleId}`;
    }
    return RequestHelper.del()(this, url12, options);
  }
  showApprovalRule(projectId, approvalRuleId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/approval_rules/${approvalRuleId}`,
      options
    );
  }
  showApprovalState(projectId, mergerequestIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/approval_state`,
      options
    );
  }
  showConfiguration(projectId, { mergerequestIId, ...options } = {}) {
    let url12;
    if (mergerequestIId) {
      url12 = endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/approvals`;
    } else {
      url12 = endpoint`projects/${projectId}/approvals`;
    }
    return RequestHelper.get()(this, url12, options);
  }
  unapprove(projectId, mergerequestIId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/unapprove`,
      options
    );
  }
};
var MergeRequestAwardEmojis = class extends ResourceAwardEmojis {
  static {
    __name(this, "MergeRequestAwardEmojis");
  }
  constructor(options) {
    super("projects", "merge_requests", options);
  }
};
var MergeRequestContextCommits = class extends BaseResource {
  static {
    __name(this, "MergeRequestContextCommits");
  }
  all(projectId, mergerequestIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/context_commits`,
      options
    );
  }
  create(projectId, commits, { mergerequestIId, ...options } = {}) {
    const prefix = endpoint`projects/${projectId}/merge_requests`;
    const url12 = mergerequestIId ? `${prefix}/${mergerequestIId}/context_commits` : prefix;
    return RequestHelper.post()(this, url12, {
      commits,
      ...options
    });
  }
  remove(projectId, mergerequestIId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/context_commits`,
      options
    );
  }
};
var MergeRequestDiscussions = class extends ResourceDiscussions {
  static {
    __name(this, "MergeRequestDiscussions");
  }
  constructor(options) {
    super("projects", "merge_requests", options);
  }
  resolve(projectId, mergerequestId, discussionId, resolved, options) {
    return RequestHelper.put()(
      this,
      endpoint`${projectId}/merge_requests/${mergerequestId}/discussions/${discussionId}`,
      {
        searchParams: { resolved },
        ...options
      }
    );
  }
};
var MergeRequestDraftNotes = class extends BaseResource {
  static {
    __name(this, "MergeRequestDraftNotes");
  }
  all(projectId, mergerequestIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/draft_notes`,
      options
    );
  }
  create(projectId, mergerequestIId, note, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/draft_notes`,
      {
        ...options,
        note
      }
    );
  }
  edit(projectId, mergerequestIId, draftNoteId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/draft_notes/${draftNoteId}`,
      options
    );
  }
  publish(projectId, mergerequestIId, draftNoteId, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/draft_notes/${draftNoteId}/publish`,
      options
    );
  }
  publishBulk(projectId, mergerequestIId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/draft_notes/bulk_publish`,
      options
    );
  }
  remove(projectId, mergerequestIId, draftNoteId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/draft_notes/${draftNoteId}`,
      options
    );
  }
  show(projectId, mergerequestIId, draftNoteId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/draft_notes/${draftNoteId}`,
      options
    );
  }
};
var MergeRequestLabelEvents = class extends ResourceLabelEvents {
  static {
    __name(this, "MergeRequestLabelEvents");
  }
  constructor(options) {
    super("projects", "merge_requests", options);
  }
};
var MergeRequestMilestoneEvents = class extends ResourceMilestoneEvents {
  static {
    __name(this, "MergeRequestMilestoneEvents");
  }
  constructor(options) {
    super("projects", "merge_requests", options);
  }
};
var MergeRequestNoteAwardEmojis = class extends ResourceNoteAwardEmojis {
  static {
    __name(this, "MergeRequestNoteAwardEmojis");
  }
  constructor(options) {
    super("merge_requests", options);
  }
};
var MergeRequestNotes = class extends ResourceNotes {
  static {
    __name(this, "MergeRequestNotes");
  }
  constructor(options) {
    super("projects", "merge_requests", options);
  }
};
var MergeRequests = class extends BaseResource {
  static {
    __name(this, "MergeRequests");
  }
  // convenience method
  accept(projectId, mergerequestIId, options) {
    return this.merge(projectId, mergerequestIId, options);
  }
  addSpentTime(projectId, mergerequestIId, duration, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/add_spent_time`,
      {
        duration,
        ...options
      }
    );
  }
  all({
    projectId,
    groupId,
    ...options
  } = {}) {
    let prefix = "";
    if (projectId) {
      prefix = endpoint`projects/${projectId}/`;
    } else if (groupId) {
      prefix = endpoint`groups/${groupId}/`;
    }
    return RequestHelper.get()(this, `${prefix}merge_requests`, options);
  }
  allDiffs(projectId, mergerequestIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/diffs`,
      options
    );
  }
  allCommits(projectId, mergerequestIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/commits`,
      options
    );
  }
  allDiffVersions(projectId, mergerequestIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/versions`,
      options
    );
  }
  allIssuesClosed(projectId, mergerequestIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/closes_issues`,
      options
    );
  }
  allIssuesRelated(projectId, mergerequestIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/related_issues`,
      options
    );
  }
  allParticipants(projectId, mergerequestIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/participants`,
      options
    );
  }
  allPipelines(projectId, mergerequestIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/pipelines`,
      options
    );
  }
  cancelOnPipelineSuccess(projectId, mergerequestIId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/cancel_merge_when_pipeline_succeeds`,
      options
    );
  }
  create(projectId, sourceBranch, targetBranch, title, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/merge_requests`,
      {
        sourceBranch,
        targetBranch,
        title,
        ...options
      }
    );
  }
  createPipeline(projectId, mergerequestIId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/pipelines`,
      options
    );
  }
  createTodo(projectId, mergerequestIId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/todo`,
      options
    );
  }
  edit(projectId, mergerequestIId, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}`,
      options
    );
  }
  merge(projectId, mergerequestIId, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/merge`,
      options
    );
  }
  mergeToDefault(projectId, mergerequestIId, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/merge_ref`,
      options
    );
  }
  rebase(projectId, mergerequestIId, { skipCI, ...options } = {}) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/rebase`,
      {
        ...options,
        skipCi: skipCI
      }
    );
  }
  remove(projectId, mergerequestIId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}`,
      options
    );
  }
  resetSpentTime(projectId, mergerequestIId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/reset_spent_time`,
      options
    );
  }
  resetTimeEstimate(projectId, mergerequestIId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/reset_time_estimate`,
      options
    );
  }
  setTimeEstimate(projectId, mergerequestIId, duration, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/time_estimate`,
      {
        duration,
        ...options
      }
    );
  }
  show(projectId, mergerequestIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}`,
      options
    );
  }
  showChanges(projectId, mergerequestIId, options) {
    process.emitWarning(
      'This endpoint was deprecated in Gitlab API 15.7 and will be removed in API v5. Please use the "allDiffs" function instead.',
      "DeprecationWarning"
    );
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/changes`,
      options
    );
  }
  showDiffVersion(projectId, mergerequestIId, versionId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/versions/${versionId}`,
      options
    );
  }
  showTimeStats(projectId, mergerequestIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/time_stats`,
      options
    );
  }
  subscribe(projectId, mergerequestIId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/subscribe`,
      options
    );
  }
  unsubscribe(projectId, mergerequestIId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/merge_requests/${mergerequestIId}/unsubscribe`,
      options
    );
  }
};
var MergeTrains = class extends BaseResource {
  static {
    __name(this, "MergeTrains");
  }
  all(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/merge_trains`,
      options
    );
  }
  showStatus(projectId, mergeRequestIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/merge_trains/merge_requests/${mergeRequestIId}`,
      options
    );
  }
  addMergeRequest(projectId, mergeRequestIId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/merge_trains/merge_requests/${mergeRequestIId}`,
      options
    );
  }
};
var PackageRegistry = class extends BaseResource {
  static {
    __name(this, "PackageRegistry");
  }
  publish(projectId, packageName, packageVersion, packageFile, {
    contentType,
    ...options
  } = {}) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/packages/generic/${packageName}/${packageVersion}/${packageFile.filename}`,
      {
        isForm: true,
        file: [packageFile.content, packageFile.filename],
        ...options
      }
    );
  }
  download(projectId, packageName, packageVersion, filename, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/packages/generic/${packageName}/${packageVersion}/${filename}`,
      options
    );
  }
};
var Packages = class extends BaseResource {
  static {
    __name(this, "Packages");
  }
  all({
    projectId,
    groupId,
    ...options
  } = {}) {
    let url12;
    if (projectId) url12 = endpoint`projects/${projectId}/packages`;
    else if (groupId) url12 = endpoint`groups/${groupId}/packages`;
    else {
      throw new Error(
        "Missing required argument. Please supply a projectId or a groupId in the options parameter."
      );
    }
    return RequestHelper.get()(this, url12, options);
  }
  allFiles(projectId, packageId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/packages/${packageId}/package_files`,
      options
    );
  }
  remove(projectId, packageId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/packages/${packageId}`,
      options
    );
  }
  removeFile(projectId, packageId, projectFileId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/packages/${packageId}/package_files/${projectFileId}`,
      options
    );
  }
  show(projectId, packageId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/packages/${packageId}`,
      options
    );
  }
};
var PagesDomains = class extends BaseResource {
  static {
    __name(this, "PagesDomains");
  }
  all({
    projectId,
    ...options
  } = {}) {
    const prefix = projectId ? endpoint`projects/${projectId}/` : "";
    return RequestHelper.get()(this, `${prefix}pages/domains`, options);
  }
  create(projectId, domain, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/pages/domains`,
      {
        domain,
        ...options
      }
    );
  }
  edit(projectId, domain, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/pages/domains/${domain}`,
      options
    );
  }
  show(projectId, domain, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/pages/domains/${domain}`,
      options
    );
  }
  remove(projectId, domain, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/pages/domains/${domain}`,
      options
    );
  }
};
var PipelineScheduleVariables = class extends BaseResource {
  static {
    __name(this, "PipelineScheduleVariables");
  }
  all(projectId, pipelineScheduleId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/pipeline_schedules/${pipelineScheduleId}/variables`,
      options
    );
  }
  create(projectId, pipelineScheduleId, key, value, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/pipeline_schedules/${pipelineScheduleId}/variables`,
      {
        ...options,
        key,
        value
      }
    );
  }
  edit(projectId, pipelineScheduleId, key, value, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/pipeline_schedules/${pipelineScheduleId}/variables/${key}`,
      {
        ...options,
        value
      }
    );
  }
  remove(projectId, pipelineScheduleId, key, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/pipeline_schedules/${pipelineScheduleId}/variables/${key}`,
      options
    );
  }
};
var PipelineSchedules = class extends BaseResource {
  static {
    __name(this, "PipelineSchedules");
  }
  all(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/pipeline_schedules`,
      options
    );
  }
  allTriggeredPipelines(projectId, pipelineScheduleId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/pipeline_schedules/${pipelineScheduleId}/pipelines`,
      options
    );
  }
  create(projectId, description, ref, cron, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/pipeline_schedules`,
      {
        description,
        ref,
        cron,
        ...options
      }
    );
  }
  edit(projectId, pipelineScheduleId, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/pipeline_schedules/${pipelineScheduleId}`,
      options
    );
  }
  remove(projectId, pipelineScheduleId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/pipeline_schedules/${pipelineScheduleId}`,
      options
    );
  }
  run(projectId, pipelineScheduleId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/pipeline_schedules/${pipelineScheduleId}/play`,
      options
    );
  }
  show(projectId, pipelineScheduleId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/pipeline_schedules/${pipelineScheduleId}`,
      options
    );
  }
  takeOwnership(projectId, pipelineScheduleId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/pipeline_schedules/${pipelineScheduleId}/take_ownership`,
      options
    );
  }
};
var PipelineTriggerTokens = class extends BaseResource {
  static {
    __name(this, "PipelineTriggerTokens");
  }
  all(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/triggers`,
      options
    );
  }
  create(projectId, description, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/triggers`,
      {
        description,
        ...options
      }
    );
  }
  edit(projectId, triggerId, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/triggers/${triggerId}`,
      options
    );
  }
  remove(projectId, triggerId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/triggers/${triggerId}`,
      options
    );
  }
  show(projectId, triggerId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/triggers/${triggerId}`,
      options
    );
  }
  trigger(projectId, ref, token, { variables, ...options } = {}) {
    const opts = {
      ...options,
      searchParams: {
        token,
        ref
      }
    };
    if (variables) {
      opts.isForm = true;
      Object.assign(opts, reformatObjectOptions(variables, "variables"));
    }
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/trigger/pipeline`,
      opts
    );
  }
};
var Pipelines = class extends BaseResource {
  static {
    __name(this, "Pipelines");
  }
  all(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/pipelines`,
      options
    );
  }
  allVariables(projectId, pipelineId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/pipelines/${pipelineId}/variables`,
      options
    );
  }
  cancel(projectId, pipelineId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/pipelines/${pipelineId}/cancel`,
      options
    );
  }
  create(projectId, ref, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/pipeline`,
      {
        ref,
        ...options
      }
    );
  }
  remove(projectId, pipelineId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/pipelines/${pipelineId}`,
      options
    );
  }
  retry(projectId, pipelineId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/pipelines/${pipelineId}/retry`,
      options
    );
  }
  show(projectId, pipelineId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/pipelines/${pipelineId}`,
      options
    );
  }
  showTestReport(projectId, pipelineId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/pipelines/${pipelineId}/test_report`,
      options
    );
  }
  showTestReportSummary(projectId, pipelineId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/pipelines/${pipelineId}/test_report_summary`,
      options
    );
  }
};
var ProductAnalytics = class extends BaseResource {
  static {
    __name(this, "ProductAnalytics");
  }
  allFunnels(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/product_analytics/funnels`,
      options
    );
  }
  load(projectId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/product_analytics/request/load`,
      options
    );
  }
  dryRun(projectId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/product_analytics/request/dry-run`,
      options
    );
  }
  showMetadata(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/product_analytics/request/meta`,
      options
    );
  }
};
var ProjectAccessRequests = class extends ResourceAccessRequests {
  static {
    __name(this, "ProjectAccessRequests");
  }
  constructor(options) {
    super("projects", options);
  }
};
var ProjectAccessTokens = class extends ResourceAccessTokens {
  static {
    __name(this, "ProjectAccessTokens");
  }
  constructor(options) {
    super("projects", options);
  }
};
var ProjectAliases = class extends BaseResource {
  static {
    __name(this, "ProjectAliases");
  }
  all(options) {
    return RequestHelper.get()(this, "project_aliases", options);
  }
  create(projectId, name, options) {
    return RequestHelper.post()(this, "project_aliases", {
      name,
      projectId,
      ...options
    });
  }
  edit(name, options) {
    return RequestHelper.post()(this, `project_aliases/${name}`, options);
  }
  remove(name, options) {
    return RequestHelper.del()(this, `project_aliases/${name}`, options);
  }
};
var ProjectBadges = class extends ResourceBadges {
  static {
    __name(this, "ProjectBadges");
  }
  constructor(options) {
    super("projects", options);
  }
};
var ProjectCustomAttributes = class extends ResourceCustomAttributes {
  static {
    __name(this, "ProjectCustomAttributes");
  }
  constructor(options) {
    super("projects", options);
  }
};
var ProjectDORA4Metrics = class extends ResourceDORA4Metrics {
  static {
    __name(this, "ProjectDORA4Metrics");
  }
  constructor(options) {
    super("projects", options);
  }
};
var ProjectHooks = class extends ResourceHooks {
  static {
    __name(this, "ProjectHooks");
  }
  constructor(options) {
    super("projects", options);
  }
};
var ProjectImportExports = class extends BaseResource {
  static {
    __name(this, "ProjectImportExports");
  }
  download(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/export/download`,
      options
    );
  }
  import(file, path, options) {
    return RequestHelper.post()(this, "projects/import", {
      isForm: true,
      ...options,
      file: [file.content, file.filename],
      path
    });
  }
  importRemote(url12, path, options) {
    return RequestHelper.post()(this, "projects/remote-import", {
      ...options,
      path,
      url: url12
    });
  }
  importRemoteS3(accessKeyId, bucketName, fileKey, path, region, secretAccessKey, options) {
    return RequestHelper.post()(this, "projects/remote-import", {
      ...options,
      accessKeyId,
      bucketName,
      fileKey,
      path,
      region,
      secretAccessKey
    });
  }
  showExportStatus(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/export`,
      options
    );
  }
  showImportStatus(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/import`,
      options
    );
  }
  scheduleExport(projectId, uploadConfig, options) {
    return RequestHelper.post()(this, endpoint`projects/${projectId}/export`, {
      ...options,
      upload: uploadConfig
    });
  }
};
var ProjectInvitations = class extends ResourceInvitations {
  static {
    __name(this, "ProjectInvitations");
  }
  constructor(options) {
    super("projects", options);
  }
};
var ProjectIssueBoards = class extends ResourceIssueBoards {
  static {
    __name(this, "ProjectIssueBoards");
  }
  constructor(options) {
    super("projects", options);
  }
};
var ProjectIterations = class extends ResourceIterations {
  static {
    __name(this, "ProjectIterations");
  }
  constructor(options) {
    super("project", options);
  }
};
var ProjectJobTokenScopes = class extends BaseResource {
  static {
    __name(this, "ProjectJobTokenScopes");
  }
  show(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/job_token_scope`,
      options
    );
  }
  edit(projectId, enabled, options) {
    return RequestHelper.patch()(
      this,
      endpoint`projects/${projectId}/job_token_scope`,
      { ...options, enabled }
    );
  }
  showInboundAllowList(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/job_token_scope/allowlist`,
      options
    );
  }
  addToInboundAllowList(projectId, targetProjectId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/job_token_scope/allowlist`,
      { ...options, targetProjectId }
    );
  }
  removeFromInboundAllowList(projectId, targetProjectId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/job_token_scope/allowlist/${targetProjectId}`,
      options
    );
  }
  showGroupsAllowList(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/job_token_scope/groups_allowlist`,
      options
    );
  }
  addToGroupsAllowList(projectId, targetGroupId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/job_token_scope/groups_allowlist`,
      { ...options, targetGroupId }
    );
  }
  removeFromGroupsAllowList(projectId, targetGroupId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/job_token_scope/groups_allowlist/${targetGroupId}`,
      options
    );
  }
};
var ProjectLabels = class extends ResourceLabels {
  static {
    __name(this, "ProjectLabels");
  }
  constructor(options) {
    super("projects", options);
  }
};
var ProjectMembers = class extends ResourceMembers {
  static {
    __name(this, "ProjectMembers");
  }
  constructor(options) {
    super("projects", options);
  }
};
var ProjectMilestones = class extends ResourceMilestones {
  static {
    __name(this, "ProjectMilestones");
  }
  constructor(options) {
    super("projects", options);
  }
  promote(projectId, milestoneId, options) {
    return RequestHelper.post()(
      this,
      endpoint`${projectId}/milestones/${milestoneId}/promote`,
      options
    );
  }
};
var ProjectProtectedEnvironments = class extends ResourceProtectedEnvironments {
  static {
    __name(this, "ProjectProtectedEnvironments");
  }
  constructor(options) {
    super("projects", options);
  }
};
var ProjectPushRules = class extends ResourcePushRules {
  static {
    __name(this, "ProjectPushRules");
  }
  constructor(options) {
    super("projects", options);
  }
};
var ProjectRelationsExport = class extends BaseResource {
  static {
    __name(this, "ProjectRelationsExport");
  }
  download(projectId, relation, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/export_relations/download`,
      {
        relation,
        ...options
      }
    );
  }
  showExportStatus(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/export_relations/status`,
      options
    );
  }
  scheduleExport(projectId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/export_relations`,
      options
    );
  }
};
var ProjectReleases = class extends BaseResource {
  static {
    __name(this, "ProjectReleases");
  }
  all(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/releases`,
      options
    );
  }
  create(projectId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/releases`,
      options
    );
  }
  createEvidence(projectId, tagName, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/releases/${tagName}/evidence`,
      options
    );
  }
  edit(projectId, tagName, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/releases/${tagName}`,
      options
    );
  }
  download(projectId, tagName, filepath, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/releases/${tagName}/downloads/${filepath}`,
      options
    );
  }
  downloadLatest(projectId, filepath, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/releases/permalink/latest/downloads/${filepath}`,
      options
    );
  }
  remove(projectId, tagName, options) {
    return RequestHelper.del()(this, endpoint`projects/${projectId}/releases/${tagName}`, options);
  }
  show(projectId, tagName, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/releases/${tagName}`,
      options
    );
  }
  showLatest(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/releases/permalink/latest`,
      options
    );
  }
  showLatestEvidence(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/releases/permalink/latest/evidence`,
      options
    );
  }
};
var ProjectRemoteMirrors = class extends BaseResource {
  static {
    __name(this, "ProjectRemoteMirrors");
  }
  all(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/remote_mirrors`,
      options
    );
  }
  // Helper method - Duplicated from Projects
  createPullMirror(projectId, url12, mirror, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/mirror/pull`,
      {
        importUrl: url12,
        mirror,
        ...options
      }
    );
  }
  createPushMirror(projectId, url12, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/remote_mirrors`,
      {
        url: url12,
        ...options
      }
    );
  }
  edit(projectId, mirrorId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/remote_mirrors/${mirrorId}`,
      options
    );
  }
  remove(projectId, mirrorId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/remote_mirrors/${mirrorId}`,
      options
    );
  }
  show(projectId, mirrorId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/remote_mirrors/${mirrorId}`,
      options
    );
  }
  sync(projectId, mirrorId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/remote_mirrors/${mirrorId}/sync`,
      options
    );
  }
};
var ProjectRepositoryStorageMoves = class extends ResourceRepositoryStorageMoves {
  static {
    __name(this, "ProjectRepositoryStorageMoves");
  }
  constructor(options) {
    super("projects", options);
  }
};
var ProjectSnippetAwardEmojis = class extends ResourceAwardEmojis {
  static {
    __name(this, "ProjectSnippetAwardEmojis");
  }
  constructor(options) {
    super("projects", "snippets", options);
  }
};
var ProjectSnippetDiscussions = class extends ResourceDiscussions {
  static {
    __name(this, "ProjectSnippetDiscussions");
  }
  constructor(options) {
    super("projects", "snippets", options);
  }
};
var ProjectSnippetNotes = class extends ResourceNotes {
  static {
    __name(this, "ProjectSnippetNotes");
  }
  constructor(options) {
    super("projects", "snippets", options);
  }
};
var ProjectSnippets = class extends BaseResource {
  static {
    __name(this, "ProjectSnippets");
  }
  all(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/snippets`,
      options
    );
  }
  create(projectId, title, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/snippets`,
      {
        title,
        ...options
      }
    );
  }
  edit(projectId, snippetId, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/snippets/${snippetId}`,
      options
    );
  }
  remove(projectId, snippetId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/snippets/${snippetId}`,
      options
    );
  }
  show(projectId, snippetId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/snippets/${snippetId}`,
      options
    );
  }
  showContent(projectId, snippetId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/snippets/${snippetId}/raw`,
      options
    );
  }
  showRepositoryFileContent(projectId, snippetId, ref, filePath, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/snippets/${snippetId}/files/${ref}/${filePath}/raw`,
      options
    );
  }
  showUserAgentDetails(projectId, snippetId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/snippets/${snippetId}/user_agent_detail`,
      options
    );
  }
};
var ProjectStatistics = class extends BaseResource {
  static {
    __name(this, "ProjectStatistics");
  }
  show(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/statistics`,
      options
    );
  }
};
var ProjectTemplates = class extends BaseResource {
  static {
    __name(this, "ProjectTemplates");
  }
  all(projectId, type, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/templates/${type}`,
      options
    );
  }
  show(projectId, type, name, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/templates/${type}/${name}`,
      options
    );
  }
};
var ProjectTerraformState = class extends BaseResource {
  static {
    __name(this, "ProjectTerraformState");
  }
  show(projectId, name, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/terraform/state/${name}`,
      options
    );
  }
  showVersion(projectId, name, serial, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/terraform/state/${name}/versions/${serial}`,
      options
    );
  }
  removeVersion(projectId, name, serial, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/terraform/state/${name}/versions/${serial}`,
      options
    );
  }
  remove(projectId, name, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/terraform/state/${name}`,
      options
    );
  }
  removeTerraformStateLock(projectId, name, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/terraform/state/${name}/lock`,
      options
    );
  }
  createVersion(projectId, name, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/terraform/state/${name}`,
      options
    );
  }
};
var ProjectVariables = class extends ResourceVariables {
  static {
    __name(this, "ProjectVariables");
  }
  constructor(options) {
    super("projects", options);
  }
};
var ProjectVulnerabilities = class extends BaseResource {
  static {
    __name(this, "ProjectVulnerabilities");
  }
  all(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/vulnerabilities`,
      options
    );
  }
  create(projectId, findingId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/vulnerabilities`,
      {
        ...options,
        searchParams: {
          findingId
        }
      }
    );
  }
};
var ProjectWikis = class extends ResourceWikis {
  static {
    __name(this, "ProjectWikis");
  }
  constructor(options) {
    super("projects", options);
  }
};
var Projects = class extends BaseResource {
  static {
    __name(this, "Projects");
  }
  all({
    userId,
    starredOnly,
    ...options
  } = {}) {
    let uri;
    if (userId && starredOnly) uri = endpoint`users/${userId}/starred_projects`;
    else if (userId) uri = endpoint`users/${userId}/projects`;
    else uri = "projects";
    return RequestHelper.get()(this, uri, options);
  }
  allTransferLocations(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/transfer_locations`,
      options
    );
  }
  allUsers(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/users`,
      options
    );
  }
  allGroups(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/groups`,
      options
    );
  }
  allInvitedGroups(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/invited_groups`,
      options
    );
  }
  allSharableGroups(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/share_locations`,
      options
    );
  }
  allForks(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/forks`,
      options
    );
  }
  allStarrers(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/starrers`,
      options
    );
  }
  allStoragePaths(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/storage`,
      options
    );
  }
  archive(projectId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/archive`,
      options
    );
  }
  create({
    userId,
    avatar,
    ...options
  } = {}) {
    const url12 = userId ? `projects/user/${userId}` : "projects";
    if (avatar) {
      return RequestHelper.post()(this, url12, {
        ...options,
        isForm: true,
        avatar: [avatar.content, avatar.filename]
      });
    }
    return RequestHelper.post()(this, url12, { ...options, avatar });
  }
  createForkRelationship(projectId, forkedFromId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/fork/${forkedFromId}`,
      options
    );
  }
  // Helper method - Duplicated from ProjectRemoteMirrors
  createPullMirror(projectId, url12, mirror, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/mirror/pull`,
      {
        importUrl: url12,
        mirror,
        ...options
      }
    );
  }
  downloadSnapshot(projectId, options) {
    return RequestHelper.get()(this, endpoint`projects/${projectId}/snapshot`, options);
  }
  edit(projectId, { avatar, ...options } = {}) {
    const url12 = endpoint`projects/${projectId}`;
    if (avatar) {
      return RequestHelper.put()(this, url12, {
        ...options,
        isForm: true,
        avatar: [avatar.content, avatar.filename]
      });
    }
    return RequestHelper.put()(this, url12, { ...options, avatar });
  }
  fork(projectId, options) {
    return RequestHelper.post()(this, endpoint`projects/${projectId}/fork`, options);
  }
  housekeeping(projectId, options) {
    return RequestHelper.post()(this, endpoint`projects/${projectId}/housekeeping`, options);
  }
  importProjectMembers(projectId, sourceProjectId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/import_project_members/${sourceProjectId}`,
      options
    );
  }
  remove(projectId, options) {
    return RequestHelper.del()(this, endpoint`projects/${projectId}`, options);
  }
  removeForkRelationship(projectId, options) {
    return RequestHelper.del()(this, endpoint`projects/${projectId}/fork`, options);
  }
  removeAvatar(projectId, options) {
    return RequestHelper.put()(this, endpoint`projects/${projectId}`, {
      ...options,
      avatar: ""
    });
  }
  restore(projectId, options) {
    return RequestHelper.post()(this, endpoint`projects/${projectId}/restore`, options);
  }
  search(projectName, options) {
    return RequestHelper.get()(this, "projects", {
      search: projectName,
      ...options
    });
  }
  share(projectId, groupId, groupAccess, options) {
    return RequestHelper.post()(this, endpoint`projects/${projectId}/share`, {
      groupId,
      groupAccess,
      ...options
    });
  }
  show(projectId, options) {
    return RequestHelper.get()(this, endpoint`projects/${projectId}`, options);
  }
  showLanguages(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/languages`,
      options
    );
  }
  showPullMirror(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/mirror/pull`,
      options
    );
  }
  star(projectId, options) {
    return RequestHelper.post()(this, endpoint`projects/${projectId}/star`, options);
  }
  transfer(projectId, namespaceId, options) {
    return RequestHelper.put()(this, endpoint`projects/${projectId}/transfer`, {
      ...options,
      namespace: namespaceId
    });
  }
  unarchive(projectId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/unarchive`,
      options
    );
  }
  unshare(projectId, groupId, options) {
    return RequestHelper.del()(this, endpoint`projects/${projectId}/share/${groupId}`, options);
  }
  unstar(projectId, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/unstar`,
      options
    );
  }
  /* Upload file to be used a reference within an issue, merge request or
     comment
  */
  uploadForReference(projectId, file, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/uploads`,
      {
        ...options,
        isForm: true,
        file: [file.content, file.filename]
      }
    );
  }
  uploadAvatar(projectId, avatar, options) {
    return RequestHelper.put()(this, endpoint`projects/${projectId}`, {
      ...options,
      isForm: true,
      avatar: [avatar.content, avatar.filename]
    });
  }
};
var ProtectedBranches = class extends BaseResource {
  static {
    __name(this, "ProtectedBranches");
  }
  all(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/protected_branches`,
      options
    );
  }
  create(projectId, branchName, options) {
    const { sudo, showExpanded, ...opts } = options || {};
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/protected_branches`,
      {
        searchParams: {
          ...opts,
          name: branchName
        },
        sudo,
        showExpanded
      }
    );
  }
  // Convenience method - create
  protect(projectId, branchName, options) {
    return this.create(projectId, branchName, options);
  }
  edit(projectId, branchName, options) {
    return RequestHelper.patch()(
      this,
      endpoint`projects/${projectId}/protected_branches/${branchName}`,
      options
    );
  }
  show(projectId, branchName, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/protected_branches/${branchName}`,
      options
    );
  }
  remove(projectId, branchName, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/protected_branches/${branchName}`,
      options
    );
  }
  // Convenience method - remove
  unprotect(projectId, branchName, options) {
    return this.remove(projectId, branchName, options);
  }
};
var ProtectedTags = class extends BaseResource {
  static {
    __name(this, "ProtectedTags");
  }
  all(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/protected_tags`,
      options
    );
  }
  create(projectId, tagName, options) {
    const { sudo, showExpanded, ...opts } = options || {};
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/protected_tags`,
      {
        searchParams: {
          name: tagName,
          ...opts
        },
        sudo,
        showExpanded
      }
    );
  }
  // Convenience method - create
  protect(projectId, tagName, options) {
    return this.create(projectId, tagName, options);
  }
  show(projectId, tagName, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/protected_tags/${tagName}`,
      options
    );
  }
  remove(projectId, tagName, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/protected_tags/${tagName}`,
      options
    );
  }
  // Convenience method - remove
  unprotect(projectId, tagName, options) {
    return this.remove(projectId, tagName, options);
  }
};
var ReleaseLinks = class extends BaseResource {
  static {
    __name(this, "ReleaseLinks");
  }
  all(projectId, tagName, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/releases/${tagName}/assets/links`,
      options
    );
  }
  create(projectId, tagName, name, url12, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/releases/${tagName}/assets/links`,
      {
        name,
        url: url12,
        ...options
      }
    );
  }
  edit(projectId, tagName, linkId, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/releases/${tagName}/assets/links/${linkId}`,
      options
    );
  }
  remove(projectId, tagName, linkId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/releases/${tagName}/assets/links/${linkId}`,
      options
    );
  }
  show(projectId, tagName, linkId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/releases/${tagName}/assets/links/${linkId}`,
      options
    );
  }
};
var Repositories = class extends BaseResource {
  static {
    __name(this, "Repositories");
  }
  allContributors(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/repository/contributors`,
      options
    );
  }
  allRepositoryTrees(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/repository/tree`,
      options
    );
  }
  compare(projectId, from, to, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/repository/compare`,
      {
        from,
        to,
        ...options
      }
    );
  }
  editChangelog(projectId, version, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/repository/changelog`,
      { ...options, version }
    );
  }
  mergeBase(projectId, refs, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/repository/merge_base`,
      {
        ...options,
        refs
      }
    );
  }
  showArchive(projectId, {
    fileType = "tar.gz",
    ...options
  } = {}) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/repository/archive.${fileType}`,
      options
    );
  }
  showBlob(projectId, sha, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/repository/blobs/${sha}`,
      options
    );
  }
  showBlobRaw(projectId, sha, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/repository/blobs/${sha}/raw`,
      options
    );
  }
  showChangelog(projectId, version, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/repository/changelog`,
      { ...options, version }
    );
  }
};
var RepositoryFiles = class extends BaseResource {
  static {
    __name(this, "RepositoryFiles");
  }
  allFileBlames(projectId, filePath, ref, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/repository/files/${filePath}/blame`,
      {
        ref,
        ...options
      }
    );
  }
  create(projectId, filePath, branch, content, commitMessage, options) {
    return RequestHelper.post()(
      this,
      endpoint`projects/${projectId}/repository/files/${filePath}`,
      {
        branch,
        content,
        commitMessage,
        ...options
      }
    );
  }
  edit(projectId, filePath, branch, content, commitMessage, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/repository/files/${filePath}`,
      {
        branch,
        content,
        commitMessage,
        ...options
      }
    );
  }
  remove(projectId, filePath, branch, commitMessage, options) {
    return RequestHelper.del()(this, endpoint`projects/${projectId}/repository/files/${filePath}`, {
      branch,
      commitMessage,
      ...options
    });
  }
  show(projectId, filePath, ref, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/repository/files/${filePath}`,
      {
        ref,
        ...options
      }
    );
  }
  showRaw(projectId, filePath, ref, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/repository/files/${filePath}/raw`,
      {
        ref,
        ...options
      }
    );
  }
};
var RepositorySubmodules = class extends BaseResource {
  static {
    __name(this, "RepositorySubmodules");
  }
  edit(projectId, submodule, branch, commitSha, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/repository/submodules/${submodule}`,
      {
        branch,
        commitSha,
        ...options
      }
    );
  }
};
var ResourceGroups = class extends BaseResource {
  static {
    __name(this, "ResourceGroups");
  }
  all(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/resource_groups`,
      options
    );
  }
  edit(projectId, key, options) {
    return RequestHelper.put()(
      this,
      endpoint`projects/${projectId}/resource_groups/${key}`,
      options
    );
  }
  show(projectId, key, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/resource_groups/${key}`,
      options
    );
  }
  allUpcomingJobs(projectId, key, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/resource_groups/${key}/upcoming_jobs`,
      options
    );
  }
};
var Runners = class extends BaseResource {
  static {
    __name(this, "Runners");
  }
  all({
    projectId,
    groupId,
    owned,
    ...options
  } = {}) {
    let url12;
    if (projectId) url12 = endpoint`projects/${projectId}/runners`;
    else if (groupId) url12 = endpoint`groups/${groupId}/runners`;
    else if (owned) url12 = "runners";
    else url12 = "runners/all";
    return RequestHelper.get()(this, url12, options);
  }
  allJobs(runnerId, options) {
    return RequestHelper.get()(this, `runners/${runnerId}/jobs`, options);
  }
  // https://docs.gitlab.com/15.9/ee/api/runners.html#register-a-new-runner
  create(token, options) {
    return RequestHelper.post()(this, `runners`, {
      token,
      ...options
    });
  }
  edit(runnerId, options) {
    return RequestHelper.put()(this, `runners/${runnerId}`, options);
  }
  enable(projectId, runnerId, options) {
    return RequestHelper.post()(this, endpoint`projects/${projectId}/runners`, {
      runnerId,
      ...options
    });
  }
  disable(projectId, runnerId, options) {
    return RequestHelper.del()(this, endpoint`projects/${projectId}/runners/${runnerId}`, options);
  }
  // Create - Convenience method
  register(token, options) {
    return this.create(token, options);
  }
  remove({
    runnerId,
    token,
    ...options
  }) {
    let url12;
    if (runnerId) url12 = `runners/${runnerId}`;
    else if (token) {
      url12 = "runners";
    } else
      throw new Error(
        "Missing required argument. Please supply a runnerId or a token in the options parameter"
      );
    return RequestHelper.del()(this, url12, {
      token,
      ...options
    });
  }
  resetRegistrationToken({
    runnerId,
    token,
    ...options
  } = {}) {
    let url12;
    if (runnerId) url12 = endpoint`runners/${runnerId}/reset_registration_token`;
    else if (token) url12 = "runners/reset_registration_token";
    else {
      throw new Error("Missing either runnerId or token parameters");
    }
    return RequestHelper.post()(this, url12, {
      token,
      ...options
    });
  }
  show(runnerId, options) {
    return RequestHelper.get()(this, `runners/${runnerId}`, options);
  }
  verify(options) {
    return RequestHelper.post()(this, `runners/verify`, options);
  }
};
var SecureFiles = class extends BaseResource {
  static {
    __name(this, "SecureFiles");
  }
  all(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/secure_files`,
      options
    );
  }
  create(projectId, name, file, options) {
    return RequestHelper.post()(this, `projects/${projectId}/secure_files`, {
      isForm: true,
      ...options,
      file: [file.content, file.filename],
      name
    });
  }
  download(projectId, secureFileId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/secure_files/${secureFileId}/download`,
      options
    );
  }
  remove(projectId, secureFileId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/secure_files/${secureFileId}`,
      options
    );
  }
  show(projectId, secureFileId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/secure_files/${secureFileId}`,
      options
    );
  }
};
var Tags = class extends BaseResource {
  static {
    __name(this, "Tags");
  }
  all(projectId, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/repository/tags`,
      options
    );
  }
  create(projectId, tagName, ref, options) {
    return RequestHelper.post()(this, endpoint`projects/${projectId}/repository/tags`, {
      searchParams: {
        tagName,
        ref
      },
      ...options
    });
  }
  remove(projectId, tagName, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/repository/tags/${tagName}`,
      options
    );
  }
  show(projectId, tagName, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/repository/tags/${tagName}`,
      options
    );
  }
  showSignature(projectId, tagName, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/repository/tags/${tagName}/signature`,
      options
    );
  }
};
var UserStarredMetricsDashboard = class extends BaseResource {
  static {
    __name(this, "UserStarredMetricsDashboard");
  }
  create(projectId, dashboardPath, options) {
    return RequestHelper.get()(
      this,
      endpoint`projects/${projectId}/metrics/user_starred_dashboards`,
      {
        dashboardPath,
        ...options
      }
    );
  }
  remove(projectId, options) {
    return RequestHelper.del()(
      this,
      endpoint`projects/${projectId}/metrics/user_starred_dashboards`,
      options
    );
  }
};
var EpicAwardEmojis = class extends ResourceAwardEmojis {
  static {
    __name(this, "EpicAwardEmojis");
  }
  constructor(options) {
    super("epics", "issues", options);
  }
};
var EpicDiscussions = class extends ResourceDiscussions {
  static {
    __name(this, "EpicDiscussions");
  }
  constructor(options) {
    super("groups", "epics", options);
  }
};
var EpicIssues = class extends BaseResource {
  static {
    __name(this, "EpicIssues");
  }
  all(groupId, epicIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`groups/${groupId}/epics/${epicIId}/issues`,
      options
    );
  }
  assign(groupId, epicIId, epicIssueId, options) {
    return RequestHelper.post()(
      this,
      endpoint`groups/${groupId}/epics/${epicIId}/issues/${epicIssueId}`,
      options
    );
  }
  edit(groupId, epicIId, epicIssueId, options) {
    return RequestHelper.put()(
      this,
      endpoint`groups/${groupId}/epics/${epicIId}/issues/${epicIssueId}`,
      options
    );
  }
  remove(groupId, epicIId, epicIssueId, options) {
    return RequestHelper.del()(
      this,
      endpoint`groups/${groupId}/epics/${epicIId}/issues/${epicIssueId}`,
      options
    );
  }
};
var EpicLabelEvents = class extends ResourceLabelEvents {
  static {
    __name(this, "EpicLabelEvents");
  }
  constructor(options) {
    super("groups", "epics", options);
  }
};
var EpicLinks = class extends BaseResource {
  static {
    __name(this, "EpicLinks");
  }
  all(groupId, epicIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`groups/${groupId}/epics/${epicIId}/links`,
      options
    );
  }
  assign(groupId, epicIId, childEpicId, options) {
    return RequestHelper.post()(
      this,
      endpoint`groups/${groupId}/epics/${epicIId}/links/${childEpicId}`,
      options
    );
  }
  create(groupId, epicIId, title, options) {
    return RequestHelper.post()(
      this,
      endpoint`groups/${groupId}/epics/${epicIId}/links`,
      {
        searchParams: {
          title
        },
        ...options
      }
    );
  }
  reorder(groupId, epicIId, childEpicId, options) {
    return RequestHelper.put()(
      this,
      endpoint`groups/${groupId}/epics/${epicIId}/links/${childEpicId}`,
      options
    );
  }
  unassign(groupId, epicIId, childEpicId, options) {
    return RequestHelper.del()(
      this,
      endpoint`groups/${groupId}/epics/${epicIId}/links/${childEpicId}`,
      options
    );
  }
};
var EpicNotes = class extends ResourceNotes {
  static {
    __name(this, "EpicNotes");
  }
  constructor(options) {
    super("groups", "epics", options);
  }
};
var Epics = class extends BaseResource {
  static {
    __name(this, "Epics");
  }
  all(groupId, options) {
    return RequestHelper.get()(this, endpoint`groups/${groupId}/epics`, options);
  }
  create(groupId, title, options) {
    return RequestHelper.post()(this, endpoint`groups/${groupId}/epics`, {
      title,
      ...options
    });
  }
  createTodo(groupId, epicIId, options) {
    return RequestHelper.post()(
      this,
      endpoint`groups/${groupId}/epics/${epicIId}/todos`,
      options
    );
  }
  edit(groupId, epicIId, options) {
    return RequestHelper.put()(
      this,
      endpoint`groups/${groupId}/epics/${epicIId}`,
      options
    );
  }
  remove(groupId, epicIId, options) {
    return RequestHelper.del()(this, endpoint`groups/${groupId}/epics/${epicIId}`, options);
  }
  show(groupId, epicIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`groups/${groupId}/epics/${epicIId}`,
      options
    );
  }
};
var GroupAccessRequests = class extends ResourceAccessRequests {
  static {
    __name(this, "GroupAccessRequests");
  }
  constructor(options) {
    super("groups", options);
  }
};
var GroupAccessTokens = class extends ResourceAccessTokens {
  static {
    __name(this, "GroupAccessTokens");
  }
  constructor(options) {
    super("groups", options);
  }
};
var GroupActivityAnalytics = class extends BaseResource {
  static {
    __name(this, "GroupActivityAnalytics");
  }
  showIssuesCount(groupPath, options) {
    return RequestHelper.get()(
      this,
      "analytics/group_activity/issues_count",
      {
        searchParams: {
          groupPath
        },
        ...options
      }
    );
  }
  showMergeRequestsCount(groupPath, options) {
    return RequestHelper.get()(
      this,
      "analytics/group_activity/merge_requests_count",
      {
        searchParams: {
          groupPath
        },
        ...options
      }
    );
  }
  showNewMembersCount(groupPath, options) {
    return RequestHelper.get()(
      this,
      "analytics/group_activity/new_members_count",
      {
        searchParams: {
          groupPath
        },
        ...options
      }
    );
  }
};
var GroupBadges = class extends ResourceBadges {
  static {
    __name(this, "GroupBadges");
  }
  constructor(options) {
    super("groups", options);
  }
};
var GroupCustomAttributes = class extends ResourceCustomAttributes {
  static {
    __name(this, "GroupCustomAttributes");
  }
  constructor(options) {
    super("groups", options);
  }
};
var GroupDORA4Metrics = class extends ResourceDORA4Metrics {
  static {
    __name(this, "GroupDORA4Metrics");
  }
  constructor(options) {
    super("groups", options);
  }
};
var GroupEpicBoards = class extends BaseResource {
  static {
    __name(this, "GroupEpicBoards");
  }
  all(groupId, options) {
    return RequestHelper.get()(
      this,
      endpoint`groups/${groupId}/epic_boards`,
      options
    );
  }
  allLists(groupId, boardId, options) {
    return RequestHelper.get()(
      this,
      endpoint`groups/${groupId}/epic_boards/${boardId}/lists`,
      options
    );
  }
  show(groupId, boardId, options) {
    return RequestHelper.get()(
      this,
      endpoint`groups/${groupId}/epic_boards/${boardId}`,
      options
    );
  }
  showList(groupId, boardId, listId, options) {
    return RequestHelper.get()(
      this,
      endpoint`groups/${groupId}/epic_boards/${boardId}/lists/${listId}`,
      options
    );
  }
};
var GroupHooks = class extends ResourceHooks {
  static {
    __name(this, "GroupHooks");
  }
  constructor(options) {
    super("groups", options);
  }
};
var GroupImportExports = class extends BaseResource {
  static {
    __name(this, "GroupImportExports");
  }
  download(groupId, options) {
    return RequestHelper.get()(
      this,
      endpoint`groups/${groupId}/export/download`,
      options
    );
  }
  import(file, path, { parentId, name, ...options }) {
    return RequestHelper.post()(this, "groups/import", {
      isForm: true,
      ...options,
      file: [file.content, file.filename],
      path,
      name: name || path.split("/").at(0),
      parentId
    });
  }
  scheduleExport(groupId, options) {
    return RequestHelper.post()(
      this,
      endpoint`groups/${groupId}/export`,
      options
    );
  }
};
var GroupInvitations = class extends ResourceInvitations {
  static {
    __name(this, "GroupInvitations");
  }
  constructor(options) {
    super("groups", options);
  }
};
var GroupIssueBoards = class extends ResourceIssueBoards {
  static {
    __name(this, "GroupIssueBoards");
  }
  constructor(options) {
    super("groups", options);
  }
};
var GroupIterations = class extends ResourceIterations {
  static {
    __name(this, "GroupIterations");
  }
  constructor(options) {
    super("groups", options);
  }
};
var GroupLDAPLinks = class extends BaseResource {
  static {
    __name(this, "GroupLDAPLinks");
  }
  add(groupId, groupAccess, provider, options) {
    return RequestHelper.post()(this, endpoint`groups/${groupId}/ldap_group_links`, {
      groupAccess,
      provider,
      ...options
    });
  }
  all(groupId, options) {
    return RequestHelper.get()(
      this,
      endpoint`groups/${groupId}/ldap_group_links`,
      options
    );
  }
  remove(groupId, provider, options) {
    return RequestHelper.del()(this, endpoint`groups/${groupId}/ldap_group_links`, {
      provider,
      ...options
    });
  }
  sync(groupId, options) {
    return RequestHelper.post()(this, endpoint`groups/${groupId}/ldap_sync`, options);
  }
};
var GroupLabels = class extends ResourceLabels {
  static {
    __name(this, "GroupLabels");
  }
  constructor(options) {
    super("groups", options);
  }
};
var GroupMemberRoles = class extends BaseResource {
  static {
    __name(this, "GroupMemberRoles");
  }
  add(groupId, baseAccessLevel, options) {
    return RequestHelper.post()(this, endpoint`groups/${groupId}/members`, {
      baseAccessLevel,
      ...options
    });
  }
  all(groupId, options) {
    return RequestHelper.get()(
      this,
      endpoint`groups/${groupId}/member_roles`,
      options
    );
  }
  remove(groupId, memberRoleId, options) {
    return RequestHelper.del()(
      this,
      endpoint`groups/${groupId}/member_roles/${memberRoleId}`,
      options
    );
  }
};
var GroupMembers = class extends ResourceMembers {
  static {
    __name(this, "GroupMembers");
  }
  constructor(options) {
    super("groups", options);
  }
  allBillable(groupId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${groupId}/billable_members`,
      options
    );
  }
  allPending(groupId, options) {
    return RequestHelper.get()(this, endpoint`${groupId}/pending_members`, options);
  }
  allBillableMemberships(groupId, userId, options) {
    return RequestHelper.get()(
      this,
      endpoint`${groupId}/billable_members/${userId}/memberships`,
      options
    );
  }
  approve(groupId, userId, options) {
    return RequestHelper.put()(
      this,
      endpoint`${groupId}/members/${userId}/approve`,
      options
    );
  }
  approveAll(groupId, options) {
    return RequestHelper.put()(
      this,
      endpoint`${groupId}/members/approve_all`,
      options
    );
  }
  removeBillable(groupId, userId, options) {
    return RequestHelper.del()(this, endpoint`${groupId}/billable_members/${userId}`, options);
  }
  removeOverrideFlag(groupId, userId, options) {
    return RequestHelper.del()(
      this,
      endpoint`${groupId}/members/${userId}/override`,
      options
    );
  }
  setOverrideFlag(groupId, userId, options) {
    return RequestHelper.post()(
      this,
      endpoint`${groupId}/members/${userId}/override`,
      options
    );
  }
};
var GroupMilestones = class extends ResourceMilestones {
  static {
    __name(this, "GroupMilestones");
  }
  constructor(options) {
    super("groups", options);
  }
};
var GroupProtectedEnvironments = class extends ResourceProtectedEnvironments {
  static {
    __name(this, "GroupProtectedEnvironments");
  }
  constructor(options) {
    super("groups", options);
  }
};
var GroupPushRules = class extends ResourcePushRules {
  static {
    __name(this, "GroupPushRules");
  }
  constructor(options) {
    super("groups", options);
  }
};
var GroupRelationExports = class extends BaseResource {
  static {
    __name(this, "GroupRelationExports");
  }
  download(groupId, relation, options) {
    return RequestHelper.get()(this, endpoint`groups/${groupId}/export_relations/download`, {
      searchParams: { relation },
      ...options
    });
  }
  exportStatus(groupId, options) {
    return RequestHelper.get()(
      this,
      endpoint`groups/${groupId}/export_relations`,
      options
    );
  }
  scheduleExport(groupId, options) {
    return RequestHelper.post()(
      this,
      endpoint`groups/${groupId}/export_relations`,
      options
    );
  }
};
var GroupReleases = class extends BaseResource {
  static {
    __name(this, "GroupReleases");
  }
  all(groupId, options) {
    return RequestHelper.get()(
      this,
      endpoint`groups/${groupId}/releases`,
      options
    );
  }
};
var GroupRepositoryStorageMoves = class extends ResourceRepositoryStorageMoves {
  static {
    __name(this, "GroupRepositoryStorageMoves");
  }
  constructor(options) {
    super("groups", options);
  }
};
var GroupSAMLIdentities = class extends BaseResource {
  static {
    __name(this, "GroupSAMLIdentities");
  }
  all(groupId, options) {
    return RequestHelper.get()(
      this,
      endpoint`groups/${groupId}/saml/identities`,
      options
    );
  }
  edit(groupId, identityId, options) {
    return RequestHelper.patch()(
      this,
      endpoint`groups/${groupId}/saml/${identityId}`,
      options
    );
  }
};
var GroupSAMLLinks = class extends BaseResource {
  static {
    __name(this, "GroupSAMLLinks");
  }
  all(groupId, options) {
    return RequestHelper.get()(
      this,
      endpoint`groups/${groupId}/saml_group_links`,
      options
    );
  }
  create(groupId, samlGroupName, accessLevel, options) {
    return RequestHelper.post()(
      this,
      endpoint`groups/${groupId}/saml_group_links`,
      {
        accessLevel,
        samlGroupName,
        ...options
      }
    );
  }
  remove(groupId, samlGroupName, options) {
    return RequestHelper.del()(
      this,
      endpoint`groups/${groupId}/saml_group_links/${samlGroupName}`,
      options
    );
  }
  show(groupId, samlGroupName, options) {
    return RequestHelper.get()(
      this,
      endpoint`groups/${groupId}/saml_group_links/${samlGroupName}`,
      options
    );
  }
};
var GroupSCIMIdentities = class extends BaseResource {
  static {
    __name(this, "GroupSCIMIdentities");
  }
  all(groupId, options) {
    return RequestHelper.get()(
      this,
      endpoint`groups/${groupId}/scim/identities`,
      options
    );
  }
  edit(groupId, identityId, options) {
    return RequestHelper.patch()(
      this,
      endpoint`groups/${groupId}/scim/${identityId}`,
      options
    );
  }
};
var GroupServiceAccounts = class extends BaseResource {
  static {
    __name(this, "GroupServiceAccounts");
  }
  create(groupId, options) {
    return RequestHelper.post()(
      this,
      endpoint`groups/${groupId}/service_accounts`,
      options
    );
  }
  // @deprecated In favor of `createPersonalAccessToken`
  addPersonalAccessToken(groupId, serviceAccountId, options) {
    return this.createPersonalAccessToken(groupId, serviceAccountId, options);
  }
  createPersonalAccessToken(groupId, serviceAccountId, options) {
    return RequestHelper.post()(
      this,
      endpoint`groups/${groupId}/service_accounts/${serviceAccountId}`,
      options
    );
  }
  rotatePersonalAccessToken(groupId, serviceAccountId, tokenId, options) {
    return RequestHelper.post()(
      this,
      endpoint`groups/${groupId}/service_accounts/${serviceAccountId}/personal_access_tokens/${tokenId}/rotate`,
      options
    );
  }
};
var GroupVariables = class extends ResourceVariables {
  static {
    __name(this, "GroupVariables");
  }
  constructor(options) {
    super("groups", options);
  }
};
var GroupWikis = class extends ResourceWikis {
  static {
    __name(this, "GroupWikis");
  }
  constructor(options) {
    super("groups", options);
  }
};
var Groups = class extends BaseResource {
  static {
    __name(this, "Groups");
  }
  all(options) {
    return RequestHelper.get()(this, "groups", options);
  }
  allDescendantGroups(groupId, options) {
    return RequestHelper.get()(
      this,
      endpoint`groups/${groupId}/descendant_groups`,
      options
    );
  }
  allProjects(groupId, options) {
    return RequestHelper.get()(
      this,
      endpoint`groups/${groupId}/projects`,
      options
    );
  }
  allSharedProjects(groupId, options) {
    return RequestHelper.get()(
      this,
      endpoint`groups/${groupId}/projects/shared`,
      options
    );
  }
  allSubgroups(groupId, options) {
    return RequestHelper.get()(this, endpoint`groups/${groupId}/subgroups`, options);
  }
  allProvisionedUsers(groupId, options) {
    return RequestHelper.get()(
      this,
      endpoint`groups/${groupId}/provisioned_users`,
      options
    );
  }
  allTransferLocations(groupId, options) {
    return RequestHelper.get()(
      this,
      endpoint`groups/${groupId}/transfer_locations`,
      options
    );
  }
  create(name, path, { avatar, ...options } = {}) {
    if (avatar) {
      return RequestHelper.post()(this, "groups", {
        ...options,
        isForm: true,
        avatar: [avatar.content, avatar.filename],
        name,
        path
      });
    }
    return RequestHelper.post()(this, "groups", { name, path, ...options });
  }
  downloadAvatar(groupId, options) {
    return RequestHelper.get()(this, endpoint`groups/${groupId}/avatar`, options);
  }
  edit(groupId, { avatar, ...options } = {}) {
    if (avatar) {
      return RequestHelper.post()(this, endpoint`groups/${groupId}`, {
        ...options,
        isForm: true,
        avatar: [avatar.content, avatar.filename]
      });
    }
    return RequestHelper.put()(this, endpoint`groups/${groupId}`, options);
  }
  remove(groupId, options) {
    return RequestHelper.del()(this, endpoint`groups/${groupId}`, options);
  }
  removeAvatar(groupId, options) {
    return RequestHelper.put()(this, endpoint`groups/${groupId}`, {
      ...options,
      avatar: ""
    });
  }
  restore(groupId, options) {
    return RequestHelper.post()(this, endpoint`groups/${groupId}/restore`, options);
  }
  search(nameOrPath, options) {
    return RequestHelper.get()(this, "groups", {
      search: nameOrPath,
      ...options
    });
  }
  share(groupId, sharedGroupId, groupAccess, options) {
    return RequestHelper.post()(this, endpoint`groups/${groupId}/share`, {
      groupId: sharedGroupId,
      groupAccess,
      ...options
    });
  }
  show(groupId, options) {
    return RequestHelper.get()(this, endpoint`groups/${groupId}`, options);
  }
  transfer(groupId, options) {
    return RequestHelper.post()(this, endpoint`groups/${groupId}/transfer`, options);
  }
  transferProject(groupId, projectId, options) {
    return RequestHelper.post()(
      this,
      endpoint`groups/${groupId}/projects/${projectId}`,
      options
    );
  }
  unshare(groupId, sharedGroupId, options) {
    return RequestHelper.del()(this, endpoint`groups/${groupId}/share/${sharedGroupId}`, options);
  }
  uploadAvatar(groupId, content, { filename, ...options } = {}) {
    return RequestHelper.put()(this, endpoint`groups/${groupId}/avatar`, {
      isForm: true,
      ...options,
      file: [content, filename]
    });
  }
};
var LinkedEpics = class extends BaseResource {
  static {
    __name(this, "LinkedEpics");
  }
  all(groupId, epicIId, options) {
    return RequestHelper.get()(
      this,
      endpoint`groups/${groupId}/epics/${epicIId}/related_epics`,
      options
    );
  }
  create(groupId, epicIId, targetEpicIId, targetGroupId, options) {
    return RequestHelper.post()(
      this,
      endpoint`groups/${groupId}/epics/${epicIId}/related_epics`,
      {
        searchParams: {
          targetGroupId,
          targetEpicIid: targetEpicIId
        },
        ...options
      }
    );
  }
  remove(groupId, epicIId, relatedEpicLinkId, options) {
    return RequestHelper.del()(
      this,
      endpoint`groups/${groupId}/epics/${epicIId}/related_epics/${relatedEpicLinkId}`,
      options
    );
  }
};
var UserCustomAttributes = class extends ResourceCustomAttributes {
  static {
    __name(this, "UserCustomAttributes");
  }
  constructor(options) {
    super("users", options);
  }
};
var url9 = /* @__PURE__ */ __name((userId) => userId ? `users/${userId}/emails` : "user/emails", "url9");
var UserEmails = class extends BaseResource {
  static {
    __name(this, "UserEmails");
  }
  // Convenience method for create
  add(email, options) {
    return this.create(email, options);
  }
  all({
    userId,
    ...options
  } = {}) {
    return RequestHelper.get()(
      this,
      url9(userId),
      options
    );
  }
  create(email, {
    userId,
    ...options
  } = {}) {
    return RequestHelper.post()(this, url9(userId), {
      email,
      ...options
    });
  }
  show(emailId, options) {
    return RequestHelper.get()(this, `user/emails/${emailId}`, options);
  }
  remove(emailId, { userId, ...options } = {}) {
    return RequestHelper.del()(
      this,
      `${url9(userId)}/${emailId}`,
      options
    );
  }
};
var url10 = /* @__PURE__ */ __name((userId) => userId ? `users/${userId}/gpg_keys` : "user/gpg_keys", "url10");
var UserGPGKeys = class extends BaseResource {
  static {
    __name(this, "UserGPGKeys");
  }
  // Convienence method
  add(key, options) {
    return this.create(key, options);
  }
  all({
    userId,
    ...options
  } = {}) {
    return RequestHelper.get()(this, url10(userId), options);
  }
  create(key, { userId, ...options } = {}) {
    return RequestHelper.post()(this, url10(userId), {
      key,
      ...options
    });
  }
  show(keyId, { userId, ...options } = {}) {
    return RequestHelper.get()(this, `${url10(userId)}/${keyId}`, options);
  }
  remove(keyId, { userId, ...options } = {}) {
    return RequestHelper.del()(this, `${url10(userId)}/${keyId}`, options);
  }
};
var UserImpersonationTokens = class extends BaseResource {
  static {
    __name(this, "UserImpersonationTokens");
  }
  all(userId, options) {
    return RequestHelper.get()(
      this,
      `users/${userId}/impersonation_tokens`,
      options
    );
  }
  create(userId, name, scopes, options) {
    return RequestHelper.post()(
      this,
      `users/${userId}/impersonation_tokens`,
      {
        name,
        scopes,
        ...options
      }
    );
  }
  show(userId, tokenId, options) {
    return RequestHelper.get()(
      this,
      `users/${userId}/impersonation_tokens/${tokenId}`,
      options
    );
  }
  remove(userId, tokenId, options) {
    return RequestHelper.del()(this, `users/${userId}/impersonation_tokens/${tokenId}`, options);
  }
  // Convienence method
  revoke(userId, tokenId, options) {
    return this.remove(userId, tokenId, options);
  }
};
var url11 = /* @__PURE__ */ __name((userId) => userId ? `users/${userId}/keys` : "user/keys", "url11");
var UserSSHKeys = class extends BaseResource {
  static {
    __name(this, "UserSSHKeys");
  }
  // Convienence method for create
  add(title, key, options) {
    return this.create(title, key, options);
  }
  all({
    userId,
    ...options
  } = {}) {
    return RequestHelper.get()(
      this,
      url11(userId),
      options
    );
  }
  create(title, key, {
    userId,
    ...options
  } = {}) {
    return RequestHelper.post()(this, url11(userId), {
      title,
      key,
      ...options
    });
  }
  show(keyId, { userId, ...options } = {}) {
    return RequestHelper.get()(
      this,
      `${url11(userId)}/${keyId}`,
      options
    );
  }
  remove(keyId, { userId, ...options } = {}) {
    return RequestHelper.del()(this, `${url11(userId)}/${keyId}`, options);
  }
};
var Users = class extends BaseResource {
  static {
    __name(this, "Users");
  }
  activate(userId, options) {
    return RequestHelper.post()(this, endpoint`users/${userId}/activate`, options);
  }
  all(options) {
    return RequestHelper.get()(
      this,
      "users",
      options
    );
  }
  allActivities(options) {
    return RequestHelper.get()(this, "user/activities", options);
  }
  allEvents(userId, options) {
    return RequestHelper.get()(this, endpoint`users/${userId}/events`, options);
  }
  allFollowers(userId, options) {
    return RequestHelper.get()(
      this,
      endpoint`users/${userId}/followers`,
      options
    );
  }
  allFollowing(userId, options) {
    return RequestHelper.get()(
      this,
      endpoint`users/${userId}/following`,
      options
    );
  }
  allMemberships(userId, options) {
    return RequestHelper.get()(
      this,
      endpoint`users/${userId}/memberships`,
      options
    );
  }
  allProjects(userId, options) {
    return RequestHelper.get()(this, endpoint`users/${userId}/projects`, options);
  }
  allContributedProjects(userId, options) {
    return RequestHelper.get()(
      this,
      endpoint`users/${userId}/contributed_projects`,
      options
    );
  }
  allStarredProjects(userId, options) {
    return RequestHelper.get()(
      this,
      endpoint`users/${userId}/starred_projects`,
      options
    );
  }
  approve(userId, options) {
    return RequestHelper.post()(
      this,
      endpoint`users/${userId}/approve`,
      options
    );
  }
  ban(userId, options) {
    return RequestHelper.post()(this, endpoint`users/${userId}/ban`, options);
  }
  block(userId, options) {
    return RequestHelper.post()(this, endpoint`users/${userId}/block`, options);
  }
  create(options) {
    return RequestHelper.post()(this, "users", options);
  }
  createPersonalAccessToken(userId, name, scopes, options) {
    return RequestHelper.post()(
      this,
      endpoint`users/${userId}/personal_access_tokens`,
      {
        name,
        scopes,
        ...options
      }
    );
  }
  createCIRunner(runnerType, options) {
    return RequestHelper.post()(this, "user/runners", {
      ...options,
      runnerType
    });
  }
  deactivate(userId, options) {
    return RequestHelper.post()(this, endpoint`users/${userId}/deactivate`, options);
  }
  disableTwoFactor(userId, options) {
    return RequestHelper.patch()(this, endpoint`users/${userId}/disable_two_factor`, options);
  }
  edit(userId, { avatar, ...options } = {}) {
    const opts = {
      ...options,
      isForm: true
    };
    if (avatar) opts.avatar = [avatar.content, avatar.filename];
    return RequestHelper.put()(this, endpoint`users/${userId}`, opts);
  }
  editStatus(options) {
    return RequestHelper.put()(this, "user/status", options);
  }
  editCurrentUserPreferences(viewDiffsFileByFile, showWhitespaceInDiffs, options) {
    return RequestHelper.put()(this, "user/preferences", {
      viewDiffsFileByFile,
      showWhitespaceInDiffs,
      ...options
    });
  }
  follow(userId, options) {
    return RequestHelper.post()(this, endpoint`users/${userId}/follow`, options);
  }
  reject(userId, options) {
    return RequestHelper.post()(
      this,
      endpoint`users/${userId}/reject`,
      options
    );
  }
  show(userId, options) {
    return RequestHelper.get()(
      this,
      endpoint`users/${userId}`,
      options
    );
  }
  showCount(options) {
    return RequestHelper.get()(this, "user_counts", options);
  }
  showAssociationsCount(userId, options) {
    return RequestHelper.get()(
      this,
      `users/${userId}/associations_count`,
      options
    );
  }
  showCurrentUser(options) {
    return RequestHelper.get()(
      this,
      "user",
      options
    );
  }
  showCurrentUserPreferences(options) {
    return RequestHelper.get()(this, "user/preferences", options);
  }
  showStatus({
    iDOrUsername,
    ...options
  } = {}) {
    let url12;
    if (iDOrUsername) url12 = `users/${iDOrUsername}/status`;
    else url12 = "user/status";
    return RequestHelper.get()(this, url12, options);
  }
  remove(userId, options) {
    return RequestHelper.del()(this, endpoint`users/${userId}`, options);
  }
  removeAuthenticationIdentity(userId, provider, options) {
    return RequestHelper.del()(this, endpoint`users/${userId}/identities/${provider}`, options);
  }
  unban(userId, options) {
    return RequestHelper.post()(this, endpoint`users/${userId}/unban`, options);
  }
  unblock(userId, options) {
    return RequestHelper.post()(this, endpoint`users/${userId}/unblock`, options);
  }
  unfollow(userId, options) {
    return RequestHelper.post()(this, endpoint`users/${userId}/unfollow`, options);
  }
};
var resources = {
  Agents,
  AlertManagement,
  ApplicationAppearance,
  ApplicationPlanLimits,
  Applications,
  ApplicationSettings,
  ApplicationStatistics,
  AuditEvents,
  Avatar,
  BroadcastMessages,
  CodeSuggestions,
  Composer,
  Conan,
  DashboardAnnotations,
  Debian,
  DependencyProxy,
  DeployKeys,
  DeployTokens,
  DockerfileTemplates,
  Events,
  Experiments,
  GeoNodes,
  GeoSites,
  GitignoreTemplates,
  GitLabCIYMLTemplates,
  Import,
  InstanceLevelCICDVariables,
  Keys,
  License,
  LicenseTemplates,
  Lint,
  Markdown,
  Maven,
  Metadata,
  Migrations,
  Namespaces,
  NotificationSettings,
  NPM,
  NuGet,
  PersonalAccessTokens,
  PyPI,
  RubyGems,
  Search,
  SearchAdmin,
  ServiceAccounts,
  ServiceData,
  SidekiqMetrics,
  SidekiqQueues,
  SnippetRepositoryStorageMoves,
  Snippets,
  Suggestions,
  SystemHooks,
  TodoLists,
  Topics,
  Branches,
  CommitDiscussions,
  Commits,
  ContainerRegistry,
  Deployments,
  Environments,
  ErrorTrackingClientKeys,
  ErrorTrackingSettings,
  ExternalStatusChecks,
  FeatureFlags,
  FeatureFlagUserLists,
  FreezePeriods,
  GitlabPages,
  GoProxy,
  Helm,
  Integrations,
  IssueAwardEmojis,
  IssueDiscussions,
  IssueIterationEvents,
  IssueLabelEvents,
  IssueLinks,
  IssueMilestoneEvents,
  IssueNoteAwardEmojis,
  IssueNotes,
  Issues,
  IssuesStatistics,
  IssueStateEvents,
  IssueWeightEvents,
  JobArtifacts,
  Jobs,
  MergeRequestApprovals,
  MergeRequestAwardEmojis,
  MergeRequestContextCommits,
  MergeRequestDiscussions,
  MergeRequestLabelEvents,
  MergeRequestMilestoneEvents,
  MergeRequestDraftNotes,
  MergeRequestNotes,
  MergeRequestNoteAwardEmojis,
  MergeRequests,
  MergeTrains,
  PackageRegistry,
  Packages,
  PagesDomains,
  Pipelines,
  PipelineSchedules,
  PipelineScheduleVariables,
  PipelineTriggerTokens,
  ProductAnalytics,
  ProjectAccessRequests,
  ProjectAccessTokens,
  ProjectAliases,
  ProjectBadges,
  ProjectCustomAttributes,
  ProjectDORA4Metrics,
  ProjectHooks,
  ProjectImportExports,
  ProjectInvitations,
  ProjectIssueBoards,
  ProjectIterations,
  ProjectJobTokenScopes,
  ProjectLabels,
  ProjectMembers,
  ProjectMilestones,
  ProjectProtectedEnvironments,
  ProjectPushRules,
  ProjectRelationsExport,
  ProjectReleases,
  ProjectRemoteMirrors,
  ProjectRepositoryStorageMoves,
  Projects,
  ProjectSnippetAwardEmojis,
  ProjectSnippetDiscussions,
  ProjectSnippetNotes,
  ProjectSnippets,
  ProjectStatistics,
  ProjectTemplates,
  ProjectTerraformState,
  ProjectVariables,
  ProjectVulnerabilities,
  ProjectWikis,
  ProtectedBranches,
  ProtectedTags,
  ReleaseLinks,
  Repositories,
  RepositoryFiles,
  RepositorySubmodules,
  ResourceGroups,
  Runners,
  SecureFiles,
  Tags,
  UserStarredMetricsDashboard,
  EpicAwardEmojis,
  EpicDiscussions,
  EpicIssues,
  EpicLabelEvents,
  EpicLinks,
  EpicNotes,
  Epics,
  GroupAccessRequests,
  GroupAccessTokens,
  GroupActivityAnalytics,
  GroupBadges,
  GroupCustomAttributes,
  GroupDORA4Metrics,
  GroupEpicBoards,
  GroupHooks,
  GroupImportExports,
  GroupInvitations,
  GroupIssueBoards,
  GroupIterations,
  GroupLabels,
  GroupLDAPLinks,
  GroupMembers,
  GroupMemberRoles,
  GroupMilestones,
  GroupProtectedEnvironments,
  GroupPushRules,
  GroupRelationExports,
  GroupReleases,
  GroupRepositoryStorageMoves,
  Groups,
  GroupSAMLIdentities,
  GroupSAMLLinks,
  GroupSCIMIdentities,
  GroupServiceAccounts,
  GroupVariables,
  GroupWikis,
  LinkedEpics,
  UserCustomAttributes,
  UserEmails,
  UserGPGKeys,
  UserImpersonationTokens,
  Users,
  UserSSHKeys
};
var Gitlab = class extends BaseResource {
  static {
    __name(this, "Gitlab");
  }
  constructor(options) {
    super(options);
    Object.keys(resources).forEach((s) => {
      this[s] = new resources[s](options);
    });
  }
};
var AccessLevel = /* @__PURE__ */ ((AccessLevel2) => {
  AccessLevel2[AccessLevel2["NO_ACCESS"] = 0] = "NO_ACCESS";
  AccessLevel2[AccessLevel2["MINIMAL_ACCESS"] = 5] = "MINIMAL_ACCESS";
  AccessLevel2[AccessLevel2["GUEST"] = 10] = "GUEST";
  AccessLevel2[AccessLevel2["REPORTER"] = 20] = "REPORTER";
  AccessLevel2[AccessLevel2["DEVELOPER"] = 30] = "DEVELOPER";
  AccessLevel2[AccessLevel2["MAINTAINER"] = 40] = "MAINTAINER";
  AccessLevel2[AccessLevel2["OWNER"] = 50] = "OWNER";
  AccessLevel2[AccessLevel2["ADMIN"] = 60] = "ADMIN";
  return AccessLevel2;
})(AccessLevel || {});

// node_modules/@gitbeaker/rest/dist/index.mjs
async function processBody(response) {
  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim();
  if (contentType === "application/json") {
    return response.json().then((v) => v || {});
  }
  if (contentType.startsWith("text/")) {
    return response.text().then((t) => t || "");
  }
  return response.blob();
}
__name(processBody, "processBody");
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
__name(delay, "delay");
async function parseResponse(response, asStream = false) {
  const { status, headers: rawHeaders } = response;
  const headers = Object.fromEntries(rawHeaders.entries());
  let body;
  if (asStream) {
    body = response.body;
  } else {
    body = status === 204 ? null : await processBody(response);
  }
  return { body, headers, status };
}
__name(parseResponse, "parseResponse");
async function throwFailedRequestError(request, response) {
  const content = await response.text();
  const contentType = response.headers.get("Content-Type");
  let description;
  if (contentType?.includes("application/json")) {
    const output = JSON.parse(content);
    const contentProperty = output?.error || output?.message || "";
    description = typeof contentProperty === "string" ? contentProperty : JSON.stringify(contentProperty);
  } else {
    description = content;
  }
  throw new GitbeakerRequestError(response.statusText, {
    cause: {
      description,
      request,
      response
    }
  });
}
__name(throwFailedRequestError, "throwFailedRequestError");
function getConditionalMode(endpoint2) {
  if (endpoint2.includes("repository/archive")) return "same-origin";
  return void 0;
}
__name(getConditionalMode, "getConditionalMode");
async function defaultRequestHandler(endpoint2, options) {
  const retryCodes = [429, 502];
  const maxRetries = 10;
  const { prefixUrl, asStream, searchParams, rateLimiters, method, ...opts } = options || {};
  const rateLimit = getMatchingRateLimiter(endpoint2, rateLimiters, method);
  let lastStatus;
  let baseUrl;
  if (prefixUrl) baseUrl = prefixUrl.endsWith("/") ? prefixUrl : `${prefixUrl}/`;
  const url12 = new URL(endpoint2, baseUrl);
  url12.search = searchParams || "";
  const mode = getConditionalMode(endpoint2);
  for (let i = 0; i < maxRetries; i += 1) {
    const request = new Request(url12, { ...opts, method, mode });
    await rateLimit();
    const response = await fetch(request).catch((e) => {
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        throw new GitbeakerTimeoutError("Query timeout was reached");
      }
      throw e;
    });
    if (response.ok) return parseResponse(response, asStream);
    if (!retryCodes.includes(response.status)) await throwFailedRequestError(request, response);
    lastStatus = response.status;
    await delay(2 ** i * 0.25);
    continue;
  }
  throw new GitbeakerRetryError(
    `Could not successfully complete this request after ${maxRetries} retries, last status code: ${lastStatus}. ${lastStatus === 429 ? "Check the applicable rate limits for this endpoint" : "Verify the status of the endpoint"}.`
  );
}
__name(defaultRequestHandler, "defaultRequestHandler");
var requesterFn = createRequesterFn(
  (_, reqo) => Promise.resolve(reqo),
  defaultRequestHandler
);
var { AccessLevel: AL, ...Resources } = dist_exports;
var API = presetResourceArguments(Resources, { requesterFn });
var {
  Agents: Agents2,
  AlertManagement: AlertManagement2,
  ApplicationAppearance: ApplicationAppearance2,
  ApplicationPlanLimits: ApplicationPlanLimits2,
  Applications: Applications2,
  ApplicationSettings: ApplicationSettings2,
  ApplicationStatistics: ApplicationStatistics2,
  AuditEvents: AuditEvents2,
  Avatar: Avatar2,
  BroadcastMessages: BroadcastMessages2,
  CodeSuggestions: CodeSuggestions2,
  Composer: Composer2,
  Conan: Conan2,
  DashboardAnnotations: DashboardAnnotations2,
  Debian: Debian2,
  DependencyProxy: DependencyProxy2,
  DeployKeys: DeployKeys2,
  DeployTokens: DeployTokens2,
  DockerfileTemplates: DockerfileTemplates2,
  Events: Events2,
  Experiments: Experiments2,
  GeoNodes: GeoNodes2,
  GeoSites: GeoSites2,
  GitignoreTemplates: GitignoreTemplates2,
  GitLabCIYMLTemplates: GitLabCIYMLTemplates2,
  Import: Import2,
  InstanceLevelCICDVariables: InstanceLevelCICDVariables2,
  Keys: Keys2,
  License: License2,
  LicenseTemplates: LicenseTemplates2,
  Lint: Lint2,
  Markdown: Markdown2,
  Maven: Maven2,
  Metadata: Metadata2,
  Migrations: Migrations2,
  Namespaces: Namespaces2,
  NotificationSettings: NotificationSettings2,
  NPM: NPM2,
  NuGet: NuGet2,
  PersonalAccessTokens: PersonalAccessTokens2,
  PyPI: PyPI2,
  RubyGems: RubyGems2,
  Search: Search2,
  SearchAdmin: SearchAdmin2,
  ServiceAccounts: ServiceAccounts2,
  ServiceData: ServiceData2,
  SidekiqMetrics: SidekiqMetrics2,
  SidekiqQueues: SidekiqQueues2,
  SnippetRepositoryStorageMoves: SnippetRepositoryStorageMoves2,
  Snippets: Snippets2,
  Suggestions: Suggestions2,
  SystemHooks: SystemHooks2,
  TodoLists: TodoLists2,
  Topics: Topics2,
  Branches: Branches2,
  CommitDiscussions: CommitDiscussions2,
  Commits: Commits2,
  ContainerRegistry: ContainerRegistry2,
  Deployments: Deployments2,
  Environments: Environments2,
  ErrorTrackingClientKeys: ErrorTrackingClientKeys2,
  ErrorTrackingSettings: ErrorTrackingSettings2,
  ExternalStatusChecks: ExternalStatusChecks2,
  FeatureFlags: FeatureFlags2,
  FeatureFlagUserLists: FeatureFlagUserLists2,
  FreezePeriods: FreezePeriods2,
  GitlabPages: GitlabPages2,
  GoProxy: GoProxy2,
  Helm: Helm2,
  Integrations: Integrations2,
  IssueAwardEmojis: IssueAwardEmojis2,
  IssueDiscussions: IssueDiscussions2,
  IssueIterationEvents: IssueIterationEvents2,
  IssueLabelEvents: IssueLabelEvents2,
  IssueLinks: IssueLinks2,
  IssueMilestoneEvents: IssueMilestoneEvents2,
  IssueNoteAwardEmojis: IssueNoteAwardEmojis2,
  IssueNotes: IssueNotes2,
  Issues: Issues2,
  IssuesStatistics: IssuesStatistics2,
  IssueStateEvents: IssueStateEvents2,
  IssueWeightEvents: IssueWeightEvents2,
  JobArtifacts: JobArtifacts2,
  Jobs: Jobs2,
  MergeRequestApprovals: MergeRequestApprovals2,
  MergeRequestAwardEmojis: MergeRequestAwardEmojis2,
  MergeRequestContextCommits: MergeRequestContextCommits2,
  MergeRequestDiscussions: MergeRequestDiscussions2,
  MergeRequestLabelEvents: MergeRequestLabelEvents2,
  MergeRequestMilestoneEvents: MergeRequestMilestoneEvents2,
  MergeRequestDraftNotes: MergeRequestDraftNotes2,
  MergeRequestNotes: MergeRequestNotes2,
  MergeRequestNoteAwardEmojis: MergeRequestNoteAwardEmojis2,
  MergeRequests: MergeRequests2,
  MergeTrains: MergeTrains2,
  PackageRegistry: PackageRegistry2,
  Packages: Packages2,
  PagesDomains: PagesDomains2,
  Pipelines: Pipelines2,
  PipelineSchedules: PipelineSchedules2,
  PipelineScheduleVariables: PipelineScheduleVariables2,
  PipelineTriggerTokens: PipelineTriggerTokens2,
  ProductAnalytics: ProductAnalytics2,
  ProjectAccessRequests: ProjectAccessRequests2,
  ProjectAccessTokens: ProjectAccessTokens2,
  ProjectAliases: ProjectAliases2,
  ProjectBadges: ProjectBadges2,
  ProjectCustomAttributes: ProjectCustomAttributes2,
  ProjectDORA4Metrics: ProjectDORA4Metrics2,
  ProjectHooks: ProjectHooks2,
  ProjectImportExports: ProjectImportExports2,
  ProjectInvitations: ProjectInvitations2,
  ProjectIssueBoards: ProjectIssueBoards2,
  ProjectIterations: ProjectIterations2,
  ProjectJobTokenScopes: ProjectJobTokenScopes2,
  ProjectLabels: ProjectLabels2,
  ProjectMembers: ProjectMembers2,
  ProjectMilestones: ProjectMilestones2,
  ProjectProtectedEnvironments: ProjectProtectedEnvironments2,
  ProjectPushRules: ProjectPushRules2,
  ProjectRelationsExport: ProjectRelationsExport2,
  ProjectReleases: ProjectReleases2,
  ProjectRemoteMirrors: ProjectRemoteMirrors2,
  ProjectRepositoryStorageMoves: ProjectRepositoryStorageMoves2,
  Projects: Projects2,
  ProjectSnippetAwardEmojis: ProjectSnippetAwardEmojis2,
  ProjectSnippetDiscussions: ProjectSnippetDiscussions2,
  ProjectSnippetNotes: ProjectSnippetNotes2,
  ProjectSnippets: ProjectSnippets2,
  ProjectStatistics: ProjectStatistics2,
  ProjectTemplates: ProjectTemplates2,
  ProjectTerraformState: ProjectTerraformState2,
  ProjectVariables: ProjectVariables2,
  ProjectVulnerabilities: ProjectVulnerabilities2,
  ProjectWikis: ProjectWikis2,
  ProtectedBranches: ProtectedBranches2,
  ProtectedTags: ProtectedTags2,
  ReleaseLinks: ReleaseLinks2,
  Repositories: Repositories2,
  RepositoryFiles: RepositoryFiles2,
  RepositorySubmodules: RepositorySubmodules2,
  ResourceGroups: ResourceGroups2,
  Runners: Runners2,
  SecureFiles: SecureFiles2,
  Tags: Tags2,
  UserStarredMetricsDashboard: UserStarredMetricsDashboard2,
  EpicAwardEmojis: EpicAwardEmojis2,
  EpicDiscussions: EpicDiscussions2,
  EpicIssues: EpicIssues2,
  EpicLabelEvents: EpicLabelEvents2,
  EpicLinks: EpicLinks2,
  EpicNotes: EpicNotes2,
  Epics: Epics2,
  GroupAccessRequests: GroupAccessRequests2,
  GroupAccessTokens: GroupAccessTokens2,
  GroupActivityAnalytics: GroupActivityAnalytics2,
  GroupBadges: GroupBadges2,
  GroupCustomAttributes: GroupCustomAttributes2,
  GroupDORA4Metrics: GroupDORA4Metrics2,
  GroupEpicBoards: GroupEpicBoards2,
  GroupHooks: GroupHooks2,
  GroupImportExports: GroupImportExports2,
  GroupInvitations: GroupInvitations2,
  GroupIssueBoards: GroupIssueBoards2,
  GroupIterations: GroupIterations2,
  GroupLabels: GroupLabels2,
  GroupLDAPLinks: GroupLDAPLinks2,
  GroupMembers: GroupMembers2,
  GroupMemberRoles: GroupMemberRoles2,
  GroupMilestones: GroupMilestones2,
  GroupProtectedEnvironments: GroupProtectedEnvironments2,
  GroupPushRules: GroupPushRules2,
  GroupRelationExports: GroupRelationExports2,
  GroupReleases: GroupReleases2,
  GroupRepositoryStorageMoves: GroupRepositoryStorageMoves2,
  Groups: Groups2,
  GroupSAMLIdentities: GroupSAMLIdentities2,
  GroupSAMLLinks: GroupSAMLLinks2,
  GroupSCIMIdentities: GroupSCIMIdentities2,
  GroupServiceAccounts: GroupServiceAccounts2,
  GroupVariables: GroupVariables2,
  GroupWikis: GroupWikis2,
  LinkedEpics: LinkedEpics2,
  UserCustomAttributes: UserCustomAttributes2,
  UserEmails: UserEmails2,
  UserGPGKeys: UserGPGKeys2,
  UserImpersonationTokens: UserImpersonationTokens2,
  Users: Users2,
  UserSSHKeys: UserSSHKeys2,
  Gitlab: Gitlab2
} = API;

// packages/channels/gitlab/dist/mention.js
init_esbuild_shims();
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
__name(escapeRegex, "escapeRegex");
var MENTION_LOOKBEHIND = `(?<=\\s|^|[([{<:;"'])`;
var MENTION_LOOKAHEAD = "(?=[^a-zA-Z0-9_./-]|$)";
function testBotMention(text, username) {
  const re = new RegExp(`${MENTION_LOOKBEHIND}@${escapeRegex(username)}${MENTION_LOOKAHEAD}`, "i");
  return re.test(text);
}
__name(testBotMention, "testBotMention");
function stripBotMention(text, username) {
  const re = new RegExp(`${MENTION_LOOKBEHIND}@${escapeRegex(username)}${MENTION_LOOKAHEAD}`, "gi");
  return text.replace(re, "");
}
__name(stripBotMention, "stripBotMention");

// packages/channels/gitlab/dist/GitlabAdapter.js
var cursorSchema = external_exports.object({
  lastProcessedId: external_exports.number(),
  initialized: external_exports.boolean()
});
var GitlabChannel = class extends PollingChannelBase {
  static {
    __name(this, "GitlabChannel");
  }
  api;
  apiHost = "https://gitlab.com";
  botUsername = "";
  descriptionCache = /* @__PURE__ */ new Map();
  reactions = /* @__PURE__ */ new Map();
  constructor(name, config, bridge, options) {
    super(name, config, bridge, options);
  }
  createInitialCursor() {
    return { lastProcessedId: 0, initialized: false };
  }
  validateCursor(parsed) {
    const result = cursorSchema.safeParse(parsed);
    return result.success ? result.data : null;
  }
  async connect() {
    const cfg = this.config;
    this.apiHost = (cfg.baseUrl || "https://gitlab.com").replace(/\/+$/, "");
    if (!cfg.action_prompt_template || Object.keys(cfg.action_prompt_template).length === 0) {
      process2.stderr.write(`[Channel:${this.name}] warning: action_prompt_template is not configured; no todos will be processed
`);
    }
    if (cfg.groupPolicy !== "open" && cfg.groupPolicy !== "allowlist" && cfg.groupPolicy !== "pairing") {
      process2.stderr.write(`[Channel:${this.name}] warning: groupPolicy is "${cfg.groupPolicy ?? "disabled"}"; must be "open", "allowlist" (with the project listed), or "pairing" (after one-time group approval) for todos to be dispatched
`);
    }
    this.api = new Gitlab2({
      host: this.apiHost,
      token: cfg.token
    });
    const user = await this.api.Users.showCurrentUser();
    this.botUsername = user.username;
    const allowed = (this.config.allowedUsers ?? []).map((u) => u.toLowerCase());
    this.config.allowedUsers = allowed;
    this.gate.replaceAllowedUsers(allowed);
    this.startPollLoop();
  }
  disconnect() {
    this.stopPollLoop();
  }
  async sendMessage(_chatId, _text) {
    throw new Error(`[Channel:${this.name}] sendMessage requires a threadId; use sendThreadMessage`);
  }
  async sendThreadMessage(chatId, threadId, text, sourceLabel) {
    if (!threadId) {
      throw new Error(`[Channel:${this.name}] sendThreadMessage requires a threadId (e.g. "issue:42" or "mr:7")`);
    }
    const match = threadId.match(/^(?:issue|mr):(\d+)$/);
    if (!match) {
      throw new Error(`[Channel:${this.name}] invalid threadId format: ${threadId}`);
    }
    const targetType = threadId.startsWith("mr:") ? "mr" : "issue";
    await this.createNote(chatId, targetType, Number(match[1]), this.formatMarkdownAttributedText(text, sourceLabel));
  }
  onPromptStart(chatId, _sessionId, messageId) {
    if (!messageId)
      return;
    const entry = this.reactions.get(messageId);
    if (!entry || entry.award)
      return;
    const api = entry.target.isMr ? this.api.MergeRequestNoteAwardEmojis : this.api.IssueNoteAwardEmojis;
    entry.award = api.award(chatId, entry.target.iid, entry.noteId, "eyes").then((r) => ({ awardId: r.id }));
    void entry.award.catch((err) => {
      entry.award = void 0;
      process2.stderr.write(`[Channel:${this.name}] failed to acknowledge note ${entry.noteId}: ${err}
`);
    });
  }
  onPromptEnd(chatId, _sessionId, messageId) {
    if (!messageId)
      return;
    const entry = this.reactions.get(messageId);
    if (!entry)
      return;
    this.reactions.delete(messageId);
    if (!entry.award)
      return;
    const api = entry.target.isMr ? this.api.MergeRequestNoteAwardEmojis : this.api.IssueNoteAwardEmojis;
    void entry.award.then(({ awardId }) => api.remove(chatId, entry.target.iid, entry.noteId, awardId)).catch((err) => {
      process2.stderr.write(`[Channel:${this.name}] failed to remove acknowledgement from note ${entry.noteId}: ${err}
`);
    });
  }
  async pollOnce() {
    const templates = this.config.action_prompt_template;
    if (!templates || Object.keys(templates).length === 0)
      return;
    this.descriptionCache.clear();
    const lastId = this.cursor.lastProcessedId;
    const allTodos = await this.api.TodoLists.all({
      state: "pending"
    });
    if (!this.cursor.initialized) {
      if (allTodos.length > 0) {
        const maxId = allTodos.reduce((m, t) => t.id > m ? t.id : m, 0);
        for (const t of allTodos) {
          this.api.TodoLists.done({ todoId: t.id }).catch(() => {
          });
        }
        this.cursor.lastProcessedId = maxId;
      }
      this.cursor.initialized = true;
      return;
    }
    const todos = allTodos.filter((t) => t.id > lastId).sort((a, b) => a.id - b.id);
    for (const t of allTodos) {
      if (t.id <= lastId) {
        this.api.TodoLists.done({ todoId: t.id }).catch(() => {
        });
      }
    }
    for (const todo of todos) {
      if (!todo.project || todo.target_type !== "Issue" && todo.target_type !== "MergeRequest") {
        await this.skipTodo(todo);
        continue;
      }
      const raw = todo.target || {};
      if (!raw.iid) {
        await this.skipTodo(todo);
        continue;
      }
      const target = {
        iid: raw.iid,
        title: raw.title ?? "",
        isMr: todo.target_type === "MergeRequest"
      };
      const template = this.resolveTemplate(templates, todo.action_name);
      if (!template) {
        await this.skipTodo(todo);
        continue;
      }
      const chatId = todo.project.path_with_namespace;
      try {
        await this.processTodo(todo, target, template, chatId);
      } catch (err) {
        process2.stderr.write(`[Channel:${this.name}] error processing todo ${todo.id}: ${err}
`);
        try {
          await this.createNote(chatId, target.isMr ? "mr" : "issue", target.iid, "\u26A0\uFE0F Failed to process this request. Please re-mention the bot to retry.");
        } catch {
        }
      }
      this.cursor.lastProcessedId = todo.id;
      try {
        await this.api.TodoLists.done({ todoId: todo.id });
      } catch {
      }
    }
  }
  async skipTodo(todo) {
    try {
      await this.api.TodoLists.done({ todoId: todo.id });
    } catch {
    }
    this.cursor.lastProcessedId = todo.id;
  }
  resolveTemplate(templates, actionName) {
    if (templates[actionName])
      return templates[actionName];
    if (actionName === "directly_addressed")
      return templates["mentioned"];
    return void 0;
  }
  async processTodo(todo, target, template, chatId) {
    if (todo.author.username === this.botUsername)
      return;
    const targetType = target.isMr ? "mr" : "issue";
    const threadId = `${targetType}:${target.iid}`;
    const noteMatch = todo.target_url.match(/#note_(\d+)$/);
    const isNoteMention = noteMatch !== null;
    const messageId = String(todo.id);
    const needsDescription = !isNoteMention || template.includes("%description%");
    let description = "";
    if (needsDescription) {
      if (isNoteMention) {
        try {
          description = await this.fetchDescription(chatId, targetType, target.iid);
        } catch (err) {
          process2.stderr.write(`[Channel:${this.name}] fetchDescription failed (metadata only): ${err}
`);
        }
      } else {
        description = await this.fetchDescription(chatId, targetType, target.iid);
      }
    }
    const text = isNoteMention ? todo.body || "" : description || todo.body || "";
    if (!text)
      return;
    const envelope = this.buildEnvelope(text, todo.author.username, chatId, threadId, messageId, this.buildMetadata(template, todo, target, chatId, todo.author.username, String(todo.id), description), true);
    if (isNoteMention) {
      this.reactions.set(messageId, {
        target,
        noteId: Number(noteMatch[1])
      });
    }
    try {
      await this.handleInbound(envelope);
    } catch (err) {
      process2.stderr.write(`[Channel:${this.name}] error processing todo ${todo.id}: ${err}
`);
      try {
        await this.createNote(chatId, targetType, target.iid, this.formatMarkdownAttributedText("\u26A0\uFE0F Failed to process this request. Please re-mention the bot to retry.", this.getInboundErrorSourceLabel(envelope)));
      } catch {
      }
    } finally {
      this.reactions.delete(messageId);
    }
  }
  async fetchDescription(chatId, targetType, iid) {
    const cacheKey = `${chatId}/${targetType}/${iid}`;
    const cached = this.descriptionCache.get(cacheKey);
    if (cached !== void 0)
      return cached;
    let description;
    if (targetType === "mr") {
      const mr = await this.api.MergeRequests.show(chatId, iid);
      description = mr.description || "";
    } else {
      const issue = await this.api.Issues.show(iid, { projectId: chatId });
      description = issue.description || "";
    }
    this.descriptionCache.set(cacheKey, description);
    return description;
  }
  buildEnvelope(rawBody, authorUsername, chatId, threadId, messageId, metadata, forceMentioned = false) {
    const isMentioned = forceMentioned || testBotMention(rawBody, this.botUsername);
    return {
      channelName: this.name,
      senderId: authorUsername.toLowerCase(),
      senderName: authorUsername,
      chatId,
      threadId,
      messageId,
      text: stripBotMention(rawBody, this.botUsername),
      isGroup: true,
      isMentioned,
      isReplyToBot: false,
      metadata
    };
  }
  buildMetadata(template, todo, target, chatId, author, commentId, description) {
    const vars = {
      project: chatId,
      project_url: `${this.apiHost}/${chatId}`,
      author,
      target_type: todo.target_type,
      iid: String(target.iid),
      title: target.title,
      description,
      todo_id: commentId
    };
    return template.replace(/%%|%(\w+)%/g, (match, key) => {
      if (match === "%%")
        return "%";
      return vars[key] ?? match;
    });
  }
  async createNote(chatId, targetType, iid, body) {
    if (targetType === "mr") {
      await this.api.MergeRequestNotes.create(chatId, iid, body);
    } else {
      await this.api.IssueNotes.create(chatId, iid, body);
    }
  }
};

// packages/channels/gitlab/dist/index.js
var plugin = {
  channelType: "gitlab",
  displayName: "GitLab",
  requiredConfigFields: ["token"],
  envResolvableConfigFields: ["baseUrl"],
  defaultSessionScope: "chat_thread",
  management: {
    fields: [
      {
        key: "token",
        label: "Personal Access Token",
        kind: "secret",
        required: true,
        envResolvable: true,
        description: 'PAT with "read_api" + "api" scopes'
      },
      {
        key: "baseUrl",
        label: "Base URL",
        kind: "string",
        envResolvable: true,
        description: "Self-hosted instance URL (e.g. https://gitlab.example.com). Leave empty for gitlab.com"
      },
      {
        key: "groupPolicy",
        label: "Group Policy",
        kind: "enum",
        required: true,
        description: 'Must be "Open", "Allowlist", or "Pairing" for todos to be processed',
        default: "open",
        options: [
          { value: "open", label: "Open" },
          { value: "allowlist", label: "Allowlist" },
          { value: "pairing", label: "Pairing" },
          { value: "disabled", label: "Disabled" }
        ]
      },
      {
        key: "senderPolicy",
        label: "Sender Policy",
        kind: "enum",
        required: true,
        description: 'Use "Allowlist" with allowed users on public projects',
        options: [
          { value: "allowlist", label: "Allowlist" },
          { value: "pairing", label: "Pairing" },
          { value: "open", label: "Open" }
        ]
      },
      {
        key: "allowedUsers",
        label: "Allowed Users",
        kind: "string-list",
        description: "GitLab usernames, used by Allowlist and Pairing policies"
      },
      {
        key: "action_prompt_template",
        label: "Action Templates",
        kind: "record",
        required: true,
        description: 'Only actions with a template are processed; others are skipped. Template variables: %project%, %project_url%, %author%, %target_type%, %iid%, %title%, %description%, %todo_id%. Use %% for a literal %. Example for "mentioned": Project: %project% | Author: %author% | Title: %title%',
        options: [
          {
            value: "mentioned",
            label: "Mentioned \u2014 @bot in a comment or description"
          },
          {
            value: "directly_addressed",
            label: "Directly Addressed \u2014 comment starts with @bot"
          },
          {
            value: "assigned",
            label: "Assigned \u2014 bot assigned to an issue or MR"
          },
          {
            value: "review_requested",
            label: "Review Requested \u2014 bot requested as MR reviewer"
          },
          {
            value: "approval_required",
            label: "Approval Required \u2014 MR needs bot approval"
          },
          {
            value: "marked",
            label: "Marked \u2014 someone stars bot's comment/issue/MR"
          },
          {
            value: "build_failed",
            label: "Build Failed \u2014 CI/CD pipeline fails on bot branch/MR"
          },
          {
            value: "unmergeable",
            label: "Unmergeable \u2014 MR becomes unmergeable (conflicts)"
          },
          {
            value: "merge_train_removed",
            label: "Merge Train Removed \u2014 MR removed from merge train"
          }
        ]
      }
    ]
  },
  createChannel: /* @__PURE__ */ __name((name, config, bridge, options) => new GitlabChannel(name, config, bridge, options), "createChannel")
};
export {
  GitlabChannel,
  plugin
};
