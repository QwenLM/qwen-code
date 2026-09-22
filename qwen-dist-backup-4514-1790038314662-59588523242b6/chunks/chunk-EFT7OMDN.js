// Force strict mode and setup for ESM
"use strict";
import {
  require_src
} from "./chunk-MATEIJZF.js";
import {
  import_websocket
} from "./chunk-J5TTWBZK.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __commonJS,
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// node_modules/retry/lib/retry_operation.js
var require_retry_operation = __commonJS({
  "node_modules/retry/lib/retry_operation.js"(exports, module) {
    init_esbuild_shims();
    function RetryOperation(timeouts, options) {
      if (typeof options === "boolean") {
        options = { forever: options };
      }
      this._originalTimeouts = JSON.parse(JSON.stringify(timeouts));
      this._timeouts = timeouts;
      this._options = options || {};
      this._maxRetryTime = options && options.maxRetryTime || Infinity;
      this._fn = null;
      this._errors = [];
      this._attempts = 1;
      this._operationTimeout = null;
      this._operationTimeoutCb = null;
      this._timeout = null;
      this._operationStart = null;
      this._timer = null;
      if (this._options.forever) {
        this._cachedTimeouts = this._timeouts.slice(0);
      }
    }
    __name(RetryOperation, "RetryOperation");
    module.exports = RetryOperation;
    RetryOperation.prototype.reset = function() {
      this._attempts = 1;
      this._timeouts = this._originalTimeouts.slice(0);
    };
    RetryOperation.prototype.stop = function() {
      if (this._timeout) {
        clearTimeout(this._timeout);
      }
      if (this._timer) {
        clearTimeout(this._timer);
      }
      this._timeouts = [];
      this._cachedTimeouts = null;
    };
    RetryOperation.prototype.retry = function(err) {
      if (this._timeout) {
        clearTimeout(this._timeout);
      }
      if (!err) {
        return false;
      }
      var currentTime = (/* @__PURE__ */ new Date()).getTime();
      if (err && currentTime - this._operationStart >= this._maxRetryTime) {
        this._errors.push(err);
        this._errors.unshift(new Error("RetryOperation timeout occurred"));
        return false;
      }
      this._errors.push(err);
      var timeout = this._timeouts.shift();
      if (timeout === void 0) {
        if (this._cachedTimeouts) {
          this._errors.splice(0, this._errors.length - 1);
          timeout = this._cachedTimeouts.slice(-1);
        } else {
          return false;
        }
      }
      var self = this;
      this._timer = setTimeout(function() {
        self._attempts++;
        if (self._operationTimeoutCb) {
          self._timeout = setTimeout(function() {
            self._operationTimeoutCb(self._attempts);
          }, self._operationTimeout);
          if (self._options.unref) {
            self._timeout.unref();
          }
        }
        self._fn(self._attempts);
      }, timeout);
      if (this._options.unref) {
        this._timer.unref();
      }
      return true;
    };
    RetryOperation.prototype.attempt = function(fn, timeoutOps) {
      this._fn = fn;
      if (timeoutOps) {
        if (timeoutOps.timeout) {
          this._operationTimeout = timeoutOps.timeout;
        }
        if (timeoutOps.cb) {
          this._operationTimeoutCb = timeoutOps.cb;
        }
      }
      var self = this;
      if (this._operationTimeoutCb) {
        this._timeout = setTimeout(function() {
          self._operationTimeoutCb();
        }, self._operationTimeout);
      }
      this._operationStart = (/* @__PURE__ */ new Date()).getTime();
      this._fn(this._attempts);
    };
    RetryOperation.prototype.try = function(fn) {
      console.log("Using RetryOperation.try() is deprecated");
      this.attempt(fn);
    };
    RetryOperation.prototype.start = function(fn) {
      console.log("Using RetryOperation.start() is deprecated");
      this.attempt(fn);
    };
    RetryOperation.prototype.start = RetryOperation.prototype.try;
    RetryOperation.prototype.errors = function() {
      return this._errors;
    };
    RetryOperation.prototype.attempts = function() {
      return this._attempts;
    };
    RetryOperation.prototype.mainError = function() {
      if (this._errors.length === 0) {
        return null;
      }
      var counts = {};
      var mainError = null;
      var mainErrorCount = 0;
      for (var i = 0; i < this._errors.length; i++) {
        var error = this._errors[i];
        var message = error.message;
        var count = (counts[message] || 0) + 1;
        counts[message] = count;
        if (count >= mainErrorCount) {
          mainError = error;
          mainErrorCount = count;
        }
      }
      return mainError;
    };
  }
});

// node_modules/retry/lib/retry.js
var require_retry = __commonJS({
  "node_modules/retry/lib/retry.js"(exports) {
    init_esbuild_shims();
    var RetryOperation = require_retry_operation();
    exports.operation = function(options) {
      var timeouts = exports.timeouts(options);
      return new RetryOperation(timeouts, {
        forever: options && (options.forever || options.retries === Infinity),
        unref: options && options.unref,
        maxRetryTime: options && options.maxRetryTime
      });
    };
    exports.timeouts = function(options) {
      if (options instanceof Array) {
        return [].concat(options);
      }
      var opts = {
        retries: 10,
        factor: 2,
        minTimeout: 1 * 1e3,
        maxTimeout: Infinity,
        randomize: false
      };
      for (var key in options) {
        opts[key] = options[key];
      }
      if (opts.minTimeout > opts.maxTimeout) {
        throw new Error("minTimeout is greater than maxTimeout");
      }
      var timeouts = [];
      for (var i = 0; i < opts.retries; i++) {
        timeouts.push(this.createTimeout(i, opts));
      }
      if (options && options.forever && !timeouts.length) {
        timeouts.push(this.createTimeout(i, opts));
      }
      timeouts.sort(function(a, b) {
        return a - b;
      });
      return timeouts;
    };
    exports.createTimeout = function(attempt, opts) {
      var random = opts.randomize ? Math.random() + 1 : 1;
      var timeout = Math.round(random * Math.max(opts.minTimeout, 1) * Math.pow(opts.factor, attempt));
      timeout = Math.min(timeout, opts.maxTimeout);
      return timeout;
    };
    exports.wrap = function(obj, options, methods) {
      if (options instanceof Array) {
        methods = options;
        options = null;
      }
      if (!methods) {
        methods = [];
        for (var key in obj) {
          if (typeof obj[key] === "function") {
            methods.push(key);
          }
        }
      }
      for (var i = 0; i < methods.length; i++) {
        var method = methods[i];
        var original = obj[method];
        obj[method] = (/* @__PURE__ */ __name(function retryWrapper(original2) {
          var op = exports.operation(options);
          var args = Array.prototype.slice.call(arguments, 1);
          var callback = args.pop();
          args.push(function(err) {
            if (op.retry(err)) {
              return;
            }
            if (err) {
              arguments[0] = op.mainError();
            }
            callback.apply(this, arguments);
          });
          op.attempt(function() {
            original2.apply(obj, args);
          });
        }, "retryWrapper")).bind(obj, original);
        obj[method].options = options;
      }
    };
  }
});

// node_modules/retry/index.js
var require_retry2 = __commonJS({
  "node_modules/retry/index.js"(exports, module) {
    init_esbuild_shims();
    module.exports = require_retry();
  }
});

// node_modules/p-retry/index.js
var require_p_retry = __commonJS({
  "node_modules/p-retry/index.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var retry = require_retry2();
    var networkErrorMsgs = [
      "Failed to fetch",
      // Chrome
      "NetworkError when attempting to fetch resource.",
      // Firefox
      "The Internet connection appears to be offline.",
      // Safari
      "Network request failed"
      // `cross-fetch`
    ];
    var AbortError2 = class extends Error {
      static {
        __name(this, "AbortError");
      }
      constructor(message) {
        super();
        if (message instanceof Error) {
          this.originalError = message;
          ({ message } = message);
        } else {
          this.originalError = new Error(message);
          this.originalError.stack = this.stack;
        }
        this.name = "AbortError";
        this.message = message;
      }
    };
    var decorateErrorWithCounts = /* @__PURE__ */ __name((error, attemptNumber, options) => {
      const retriesLeft = options.retries - (attemptNumber - 1);
      error.attemptNumber = attemptNumber;
      error.retriesLeft = retriesLeft;
      return error;
    }, "decorateErrorWithCounts");
    var isNetworkError = /* @__PURE__ */ __name((errorMessage) => networkErrorMsgs.includes(errorMessage), "isNetworkError");
    var pRetry2 = /* @__PURE__ */ __name((input, options) => new Promise((resolve, reject) => {
      options = {
        onFailedAttempt: /* @__PURE__ */ __name(() => {
        }, "onFailedAttempt"),
        retries: 10,
        ...options
      };
      const operation = retry.operation(options);
      operation.attempt(async (attemptNumber) => {
        try {
          resolve(await input(attemptNumber));
        } catch (error) {
          if (!(error instanceof Error)) {
            reject(new TypeError(`Non-error was thrown: "${error}". You should only throw errors.`));
            return;
          }
          if (error instanceof AbortError2) {
            operation.stop();
            reject(error.originalError);
          } else if (error instanceof TypeError && !isNetworkError(error.message)) {
            operation.stop();
            reject(error);
          } else {
            decorateErrorWithCounts(error, attemptNumber, options);
            try {
              await options.onFailedAttempt(error);
            } catch (error2) {
              reject(error2);
              return;
            }
            if (!operation.retry(error)) {
              reject(operation.mainError());
            }
          }
        }
      });
    }), "pRetry");
    module.exports = pRetry2;
    module.exports.default = pRetry2;
    module.exports.AbortError = AbortError2;
  }
});

// node_modules/@google/genai/dist/node/index.mjs
init_esbuild_shims();
var import_p_retry = __toESM(require_p_retry(), 1);
var import_google_auth_library = __toESM(require_src(), 1);
import { createWriteStream } from "fs";
import * as fs from "fs/promises";
import { writeFile } from "fs/promises";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import * as path$1 from "path";
var _defaultBaseGeminiUrl = void 0;
var _defaultBaseVertexUrl = void 0;
function setDefaultBaseUrls(baseUrlParams) {
  _defaultBaseGeminiUrl = baseUrlParams.geminiUrl;
  _defaultBaseVertexUrl = baseUrlParams.vertexUrl;
}
__name(setDefaultBaseUrls, "setDefaultBaseUrls");
function getDefaultBaseUrls() {
  return {
    geminiUrl: _defaultBaseGeminiUrl,
    vertexUrl: _defaultBaseVertexUrl
  };
}
__name(getDefaultBaseUrls, "getDefaultBaseUrls");
function getBaseUrl(httpOptions, vertexai, vertexBaseUrlFromEnv, geminiBaseUrlFromEnv) {
  var _a2, _b;
  if (!(httpOptions === null || httpOptions === void 0 ? void 0 : httpOptions.baseUrl)) {
    const defaultBaseUrls = getDefaultBaseUrls();
    if (vertexai) {
      return (_a2 = defaultBaseUrls.vertexUrl) !== null && _a2 !== void 0 ? _a2 : vertexBaseUrlFromEnv;
    } else {
      return (_b = defaultBaseUrls.geminiUrl) !== null && _b !== void 0 ? _b : geminiBaseUrlFromEnv;
    }
  }
  return httpOptions.baseUrl;
}
__name(getBaseUrl, "getBaseUrl");
var BaseModule = class {
  static {
    __name(this, "BaseModule");
  }
};
function formatMap(templateString, valueMap) {
  const regex = /\{([^}]+)\}/g;
  return templateString.replace(regex, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(valueMap, key)) {
      const value = valueMap[key];
      return value !== void 0 && value !== null ? String(value) : "";
    } else {
      throw new Error(`Key '${key}' not found in valueMap.`);
    }
  });
}
__name(formatMap, "formatMap");
function setValueByPath(data, keys, value) {
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (key.endsWith("[]")) {
      const keyName = key.slice(0, -2);
      if (!(keyName in data)) {
        if (Array.isArray(value)) {
          data[keyName] = Array.from({ length: value.length }, () => ({}));
        } else {
          throw new Error(`Value must be a list given an array path ${key}`);
        }
      }
      if (Array.isArray(data[keyName])) {
        const arrayData = data[keyName];
        if (Array.isArray(value)) {
          for (let j = 0; j < arrayData.length; j++) {
            const entry = arrayData[j];
            setValueByPath(entry, keys.slice(i + 1), value[j]);
          }
        } else {
          for (const d of arrayData) {
            setValueByPath(d, keys.slice(i + 1), value);
          }
        }
      }
      return;
    } else if (key.endsWith("[0]")) {
      const keyName = key.slice(0, -3);
      if (!(keyName in data)) {
        data[keyName] = [{}];
      }
      const arrayData = data[keyName];
      setValueByPath(arrayData[0], keys.slice(i + 1), value);
      return;
    }
    if (!data[key] || typeof data[key] !== "object") {
      data[key] = {};
    }
    data = data[key];
  }
  const keyToSet = keys[keys.length - 1];
  const existingData = data[keyToSet];
  if (existingData !== void 0) {
    if (!value || typeof value === "object" && Object.keys(value).length === 0) {
      return;
    }
    if (value === existingData) {
      return;
    }
    if (typeof existingData === "object" && typeof value === "object" && existingData !== null && value !== null) {
      Object.assign(existingData, value);
    } else {
      throw new Error(`Cannot set value for an existing key. Key: ${keyToSet}`);
    }
  } else {
    if (keyToSet === "_self" && typeof value === "object" && value !== null && !Array.isArray(value)) {
      const valueAsRecord = value;
      Object.assign(data, valueAsRecord);
    } else {
      data[keyToSet] = value;
    }
  }
}
__name(setValueByPath, "setValueByPath");
function getValueByPath(data, keys, defaultValue = void 0) {
  try {
    if (keys.length === 1 && keys[0] === "_self") {
      return data;
    }
    for (let i = 0; i < keys.length; i++) {
      if (typeof data !== "object" || data === null) {
        return defaultValue;
      }
      const key = keys[i];
      if (key.endsWith("[]")) {
        const keyName = key.slice(0, -2);
        if (keyName in data) {
          const arrayData = data[keyName];
          if (!Array.isArray(arrayData)) {
            return defaultValue;
          }
          return arrayData.map((d) => getValueByPath(d, keys.slice(i + 1), defaultValue));
        } else {
          return defaultValue;
        }
      } else {
        data = data[key];
      }
    }
    return data;
  } catch (error) {
    if (error instanceof TypeError) {
      return defaultValue;
    }
    throw error;
  }
}
__name(getValueByPath, "getValueByPath");
function moveValueByPath(data, paths) {
  for (const [sourcePath, destPath] of Object.entries(paths)) {
    const sourceKeys = sourcePath.split(".");
    const destKeys = destPath.split(".");
    const excludeKeys = /* @__PURE__ */ new Set();
    let wildcardIdx = -1;
    for (let i = 0; i < sourceKeys.length; i++) {
      if (sourceKeys[i] === "*") {
        wildcardIdx = i;
        break;
      }
    }
    if (wildcardIdx !== -1 && destKeys.length > wildcardIdx) {
      for (let i = wildcardIdx; i < destKeys.length; i++) {
        const key = destKeys[i];
        if (key !== "*" && !key.endsWith("[]") && !key.endsWith("[0]")) {
          excludeKeys.add(key);
        }
      }
    }
    _moveValueRecursive(data, sourceKeys, destKeys, 0, excludeKeys);
  }
}
__name(moveValueByPath, "moveValueByPath");
function _moveValueRecursive(data, sourceKeys, destKeys, keyIdx, excludeKeys) {
  if (keyIdx >= sourceKeys.length) {
    return;
  }
  if (typeof data !== "object" || data === null) {
    return;
  }
  const key = sourceKeys[keyIdx];
  if (key.endsWith("[]")) {
    const keyName = key.slice(0, -2);
    const dataRecord = data;
    if (keyName in dataRecord && Array.isArray(dataRecord[keyName])) {
      for (const item of dataRecord[keyName]) {
        _moveValueRecursive(item, sourceKeys, destKeys, keyIdx + 1, excludeKeys);
      }
    }
  } else if (key === "*") {
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      const dataRecord = data;
      const keysToMove = Object.keys(dataRecord).filter((k) => !k.startsWith("_") && !excludeKeys.has(k));
      const valuesToMove = {};
      for (const k of keysToMove) {
        valuesToMove[k] = dataRecord[k];
      }
      for (const [k, v] of Object.entries(valuesToMove)) {
        const newDestKeys = [];
        for (const dk of destKeys.slice(keyIdx)) {
          if (dk === "*") {
            newDestKeys.push(k);
          } else {
            newDestKeys.push(dk);
          }
        }
        setValueByPath(dataRecord, newDestKeys, v);
      }
      for (const k of keysToMove) {
        delete dataRecord[k];
      }
    }
  } else {
    const dataRecord = data;
    if (key in dataRecord) {
      _moveValueRecursive(dataRecord[key], sourceKeys, destKeys, keyIdx + 1, excludeKeys);
    }
  }
}
__name(_moveValueRecursive, "_moveValueRecursive");
function tBytes$1(fromBytes) {
  if (typeof fromBytes !== "string") {
    throw new Error("fromImageBytes must be a string");
  }
  return fromBytes;
}
__name(tBytes$1, "tBytes$1");
function fetchPredictOperationParametersToVertex(fromObject) {
  const toObject = {};
  const fromOperationName = getValueByPath(fromObject, [
    "operationName"
  ]);
  if (fromOperationName != null) {
    setValueByPath(toObject, ["operationName"], fromOperationName);
  }
  const fromResourceName = getValueByPath(fromObject, ["resourceName"]);
  if (fromResourceName != null) {
    setValueByPath(toObject, ["_url", "resourceName"], fromResourceName);
  }
  return toObject;
}
__name(fetchPredictOperationParametersToVertex, "fetchPredictOperationParametersToVertex");
function generateVideosOperationFromMldev$1(fromObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["name"], fromName);
  }
  const fromMetadata = getValueByPath(fromObject, ["metadata"]);
  if (fromMetadata != null) {
    setValueByPath(toObject, ["metadata"], fromMetadata);
  }
  const fromDone = getValueByPath(fromObject, ["done"]);
  if (fromDone != null) {
    setValueByPath(toObject, ["done"], fromDone);
  }
  const fromError = getValueByPath(fromObject, ["error"]);
  if (fromError != null) {
    setValueByPath(toObject, ["error"], fromError);
  }
  const fromResponse = getValueByPath(fromObject, [
    "response",
    "generateVideoResponse"
  ]);
  if (fromResponse != null) {
    setValueByPath(toObject, ["response"], generateVideosResponseFromMldev$1(fromResponse));
  }
  return toObject;
}
__name(generateVideosOperationFromMldev$1, "generateVideosOperationFromMldev$1");
function generateVideosOperationFromVertex$1(fromObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["name"], fromName);
  }
  const fromMetadata = getValueByPath(fromObject, ["metadata"]);
  if (fromMetadata != null) {
    setValueByPath(toObject, ["metadata"], fromMetadata);
  }
  const fromDone = getValueByPath(fromObject, ["done"]);
  if (fromDone != null) {
    setValueByPath(toObject, ["done"], fromDone);
  }
  const fromError = getValueByPath(fromObject, ["error"]);
  if (fromError != null) {
    setValueByPath(toObject, ["error"], fromError);
  }
  const fromResponse = getValueByPath(fromObject, ["response"]);
  if (fromResponse != null) {
    setValueByPath(toObject, ["response"], generateVideosResponseFromVertex$1(fromResponse));
  }
  return toObject;
}
__name(generateVideosOperationFromVertex$1, "generateVideosOperationFromVertex$1");
function generateVideosResponseFromMldev$1(fromObject) {
  const toObject = {};
  const fromGeneratedVideos = getValueByPath(fromObject, [
    "generatedSamples"
  ]);
  if (fromGeneratedVideos != null) {
    let transformedList = fromGeneratedVideos;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return generatedVideoFromMldev$1(item);
      });
    }
    setValueByPath(toObject, ["generatedVideos"], transformedList);
  }
  const fromRaiMediaFilteredCount = getValueByPath(fromObject, [
    "raiMediaFilteredCount"
  ]);
  if (fromRaiMediaFilteredCount != null) {
    setValueByPath(toObject, ["raiMediaFilteredCount"], fromRaiMediaFilteredCount);
  }
  const fromRaiMediaFilteredReasons = getValueByPath(fromObject, [
    "raiMediaFilteredReasons"
  ]);
  if (fromRaiMediaFilteredReasons != null) {
    setValueByPath(toObject, ["raiMediaFilteredReasons"], fromRaiMediaFilteredReasons);
  }
  return toObject;
}
__name(generateVideosResponseFromMldev$1, "generateVideosResponseFromMldev$1");
function generateVideosResponseFromVertex$1(fromObject) {
  const toObject = {};
  const fromGeneratedVideos = getValueByPath(fromObject, ["videos"]);
  if (fromGeneratedVideos != null) {
    let transformedList = fromGeneratedVideos;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return generatedVideoFromVertex$1(item);
      });
    }
    setValueByPath(toObject, ["generatedVideos"], transformedList);
  }
  const fromRaiMediaFilteredCount = getValueByPath(fromObject, [
    "raiMediaFilteredCount"
  ]);
  if (fromRaiMediaFilteredCount != null) {
    setValueByPath(toObject, ["raiMediaFilteredCount"], fromRaiMediaFilteredCount);
  }
  const fromRaiMediaFilteredReasons = getValueByPath(fromObject, [
    "raiMediaFilteredReasons"
  ]);
  if (fromRaiMediaFilteredReasons != null) {
    setValueByPath(toObject, ["raiMediaFilteredReasons"], fromRaiMediaFilteredReasons);
  }
  return toObject;
}
__name(generateVideosResponseFromVertex$1, "generateVideosResponseFromVertex$1");
function generatedVideoFromMldev$1(fromObject) {
  const toObject = {};
  const fromVideo = getValueByPath(fromObject, ["video"]);
  if (fromVideo != null) {
    setValueByPath(toObject, ["video"], videoFromMldev$1(fromVideo));
  }
  return toObject;
}
__name(generatedVideoFromMldev$1, "generatedVideoFromMldev$1");
function generatedVideoFromVertex$1(fromObject) {
  const toObject = {};
  const fromVideo = getValueByPath(fromObject, ["_self"]);
  if (fromVideo != null) {
    setValueByPath(toObject, ["video"], videoFromVertex$1(fromVideo));
  }
  return toObject;
}
__name(generatedVideoFromVertex$1, "generatedVideoFromVertex$1");
function getOperationParametersToMldev(fromObject) {
  const toObject = {};
  const fromOperationName = getValueByPath(fromObject, [
    "operationName"
  ]);
  if (fromOperationName != null) {
    setValueByPath(toObject, ["_url", "operationName"], fromOperationName);
  }
  return toObject;
}
__name(getOperationParametersToMldev, "getOperationParametersToMldev");
function getOperationParametersToVertex(fromObject) {
  const toObject = {};
  const fromOperationName = getValueByPath(fromObject, [
    "operationName"
  ]);
  if (fromOperationName != null) {
    setValueByPath(toObject, ["_url", "operationName"], fromOperationName);
  }
  return toObject;
}
__name(getOperationParametersToVertex, "getOperationParametersToVertex");
function importFileOperationFromMldev$1(fromObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["name"], fromName);
  }
  const fromMetadata = getValueByPath(fromObject, ["metadata"]);
  if (fromMetadata != null) {
    setValueByPath(toObject, ["metadata"], fromMetadata);
  }
  const fromDone = getValueByPath(fromObject, ["done"]);
  if (fromDone != null) {
    setValueByPath(toObject, ["done"], fromDone);
  }
  const fromError = getValueByPath(fromObject, ["error"]);
  if (fromError != null) {
    setValueByPath(toObject, ["error"], fromError);
  }
  const fromResponse = getValueByPath(fromObject, ["response"]);
  if (fromResponse != null) {
    setValueByPath(toObject, ["response"], importFileResponseFromMldev$1(fromResponse));
  }
  return toObject;
}
__name(importFileOperationFromMldev$1, "importFileOperationFromMldev$1");
function importFileResponseFromMldev$1(fromObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromParent = getValueByPath(fromObject, ["parent"]);
  if (fromParent != null) {
    setValueByPath(toObject, ["parent"], fromParent);
  }
  const fromDocumentName = getValueByPath(fromObject, ["documentName"]);
  if (fromDocumentName != null) {
    setValueByPath(toObject, ["documentName"], fromDocumentName);
  }
  return toObject;
}
__name(importFileResponseFromMldev$1, "importFileResponseFromMldev$1");
function uploadToFileSearchStoreOperationFromMldev(fromObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["name"], fromName);
  }
  const fromMetadata = getValueByPath(fromObject, ["metadata"]);
  if (fromMetadata != null) {
    setValueByPath(toObject, ["metadata"], fromMetadata);
  }
  const fromDone = getValueByPath(fromObject, ["done"]);
  if (fromDone != null) {
    setValueByPath(toObject, ["done"], fromDone);
  }
  const fromError = getValueByPath(fromObject, ["error"]);
  if (fromError != null) {
    setValueByPath(toObject, ["error"], fromError);
  }
  const fromResponse = getValueByPath(fromObject, ["response"]);
  if (fromResponse != null) {
    setValueByPath(toObject, ["response"], uploadToFileSearchStoreResponseFromMldev(fromResponse));
  }
  return toObject;
}
__name(uploadToFileSearchStoreOperationFromMldev, "uploadToFileSearchStoreOperationFromMldev");
function uploadToFileSearchStoreResponseFromMldev(fromObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromParent = getValueByPath(fromObject, ["parent"]);
  if (fromParent != null) {
    setValueByPath(toObject, ["parent"], fromParent);
  }
  const fromDocumentName = getValueByPath(fromObject, ["documentName"]);
  if (fromDocumentName != null) {
    setValueByPath(toObject, ["documentName"], fromDocumentName);
  }
  return toObject;
}
__name(uploadToFileSearchStoreResponseFromMldev, "uploadToFileSearchStoreResponseFromMldev");
function videoFromMldev$1(fromObject) {
  const toObject = {};
  const fromUri = getValueByPath(fromObject, ["uri"]);
  if (fromUri != null) {
    setValueByPath(toObject, ["uri"], fromUri);
  }
  const fromVideoBytes = getValueByPath(fromObject, ["encodedVideo"]);
  if (fromVideoBytes != null) {
    setValueByPath(toObject, ["videoBytes"], tBytes$1(fromVideoBytes));
  }
  const fromMimeType = getValueByPath(fromObject, ["encoding"]);
  if (fromMimeType != null) {
    setValueByPath(toObject, ["mimeType"], fromMimeType);
  }
  return toObject;
}
__name(videoFromMldev$1, "videoFromMldev$1");
function videoFromVertex$1(fromObject) {
  const toObject = {};
  const fromUri = getValueByPath(fromObject, ["gcsUri"]);
  if (fromUri != null) {
    setValueByPath(toObject, ["uri"], fromUri);
  }
  const fromVideoBytes = getValueByPath(fromObject, [
    "bytesBase64Encoded"
  ]);
  if (fromVideoBytes != null) {
    setValueByPath(toObject, ["videoBytes"], tBytes$1(fromVideoBytes));
  }
  const fromMimeType = getValueByPath(fromObject, ["mimeType"]);
  if (fromMimeType != null) {
    setValueByPath(toObject, ["mimeType"], fromMimeType);
  }
  return toObject;
}
__name(videoFromVertex$1, "videoFromVertex$1");
var Outcome;
(function(Outcome2) {
  Outcome2["OUTCOME_UNSPECIFIED"] = "OUTCOME_UNSPECIFIED";
  Outcome2["OUTCOME_OK"] = "OUTCOME_OK";
  Outcome2["OUTCOME_FAILED"] = "OUTCOME_FAILED";
  Outcome2["OUTCOME_DEADLINE_EXCEEDED"] = "OUTCOME_DEADLINE_EXCEEDED";
})(Outcome || (Outcome = {}));
var Language;
(function(Language2) {
  Language2["LANGUAGE_UNSPECIFIED"] = "LANGUAGE_UNSPECIFIED";
  Language2["PYTHON"] = "PYTHON";
})(Language || (Language = {}));
var FunctionResponseScheduling;
(function(FunctionResponseScheduling2) {
  FunctionResponseScheduling2["SCHEDULING_UNSPECIFIED"] = "SCHEDULING_UNSPECIFIED";
  FunctionResponseScheduling2["SILENT"] = "SILENT";
  FunctionResponseScheduling2["WHEN_IDLE"] = "WHEN_IDLE";
  FunctionResponseScheduling2["INTERRUPT"] = "INTERRUPT";
})(FunctionResponseScheduling || (FunctionResponseScheduling = {}));
var Type;
(function(Type2) {
  Type2["TYPE_UNSPECIFIED"] = "TYPE_UNSPECIFIED";
  Type2["STRING"] = "STRING";
  Type2["NUMBER"] = "NUMBER";
  Type2["INTEGER"] = "INTEGER";
  Type2["BOOLEAN"] = "BOOLEAN";
  Type2["ARRAY"] = "ARRAY";
  Type2["OBJECT"] = "OBJECT";
  Type2["NULL"] = "NULL";
})(Type || (Type = {}));
var Environment;
(function(Environment2) {
  Environment2["ENVIRONMENT_UNSPECIFIED"] = "ENVIRONMENT_UNSPECIFIED";
  Environment2["ENVIRONMENT_BROWSER"] = "ENVIRONMENT_BROWSER";
  Environment2["ENVIRONMENT_MOBILE"] = "ENVIRONMENT_MOBILE";
  Environment2["ENVIRONMENT_DESKTOP"] = "ENVIRONMENT_DESKTOP";
})(Environment || (Environment = {}));
var AuthType;
(function(AuthType2) {
  AuthType2["AUTH_TYPE_UNSPECIFIED"] = "AUTH_TYPE_UNSPECIFIED";
  AuthType2["NO_AUTH"] = "NO_AUTH";
  AuthType2["API_KEY_AUTH"] = "API_KEY_AUTH";
  AuthType2["HTTP_BASIC_AUTH"] = "HTTP_BASIC_AUTH";
  AuthType2["GOOGLE_SERVICE_ACCOUNT_AUTH"] = "GOOGLE_SERVICE_ACCOUNT_AUTH";
  AuthType2["OAUTH"] = "OAUTH";
  AuthType2["OIDC_AUTH"] = "OIDC_AUTH";
})(AuthType || (AuthType = {}));
var HttpElementLocation;
(function(HttpElementLocation2) {
  HttpElementLocation2["HTTP_IN_UNSPECIFIED"] = "HTTP_IN_UNSPECIFIED";
  HttpElementLocation2["HTTP_IN_QUERY"] = "HTTP_IN_QUERY";
  HttpElementLocation2["HTTP_IN_HEADER"] = "HTTP_IN_HEADER";
  HttpElementLocation2["HTTP_IN_PATH"] = "HTTP_IN_PATH";
  HttpElementLocation2["HTTP_IN_BODY"] = "HTTP_IN_BODY";
  HttpElementLocation2["HTTP_IN_COOKIE"] = "HTTP_IN_COOKIE";
})(HttpElementLocation || (HttpElementLocation = {}));
var ApiSpec;
(function(ApiSpec2) {
  ApiSpec2["API_SPEC_UNSPECIFIED"] = "API_SPEC_UNSPECIFIED";
  ApiSpec2["SIMPLE_SEARCH"] = "SIMPLE_SEARCH";
  ApiSpec2["ELASTIC_SEARCH"] = "ELASTIC_SEARCH";
})(ApiSpec || (ApiSpec = {}));
var PhishBlockThreshold;
(function(PhishBlockThreshold2) {
  PhishBlockThreshold2["PHISH_BLOCK_THRESHOLD_UNSPECIFIED"] = "PHISH_BLOCK_THRESHOLD_UNSPECIFIED";
  PhishBlockThreshold2["BLOCK_LOW_AND_ABOVE"] = "BLOCK_LOW_AND_ABOVE";
  PhishBlockThreshold2["BLOCK_MEDIUM_AND_ABOVE"] = "BLOCK_MEDIUM_AND_ABOVE";
  PhishBlockThreshold2["BLOCK_HIGH_AND_ABOVE"] = "BLOCK_HIGH_AND_ABOVE";
  PhishBlockThreshold2["BLOCK_HIGHER_AND_ABOVE"] = "BLOCK_HIGHER_AND_ABOVE";
  PhishBlockThreshold2["BLOCK_VERY_HIGH_AND_ABOVE"] = "BLOCK_VERY_HIGH_AND_ABOVE";
  PhishBlockThreshold2["BLOCK_ONLY_EXTREMELY_HIGH"] = "BLOCK_ONLY_EXTREMELY_HIGH";
})(PhishBlockThreshold || (PhishBlockThreshold = {}));
var Behavior;
(function(Behavior2) {
  Behavior2["UNSPECIFIED"] = "UNSPECIFIED";
  Behavior2["BLOCKING"] = "BLOCKING";
  Behavior2["NON_BLOCKING"] = "NON_BLOCKING";
})(Behavior || (Behavior = {}));
var DynamicRetrievalConfigMode;
(function(DynamicRetrievalConfigMode2) {
  DynamicRetrievalConfigMode2["MODE_UNSPECIFIED"] = "MODE_UNSPECIFIED";
  DynamicRetrievalConfigMode2["MODE_DYNAMIC"] = "MODE_DYNAMIC";
})(DynamicRetrievalConfigMode || (DynamicRetrievalConfigMode = {}));
var FunctionCallingConfigMode;
(function(FunctionCallingConfigMode2) {
  FunctionCallingConfigMode2["MODE_UNSPECIFIED"] = "MODE_UNSPECIFIED";
  FunctionCallingConfigMode2["AUTO"] = "AUTO";
  FunctionCallingConfigMode2["ANY"] = "ANY";
  FunctionCallingConfigMode2["NONE"] = "NONE";
  FunctionCallingConfigMode2["VALIDATED"] = "VALIDATED";
})(FunctionCallingConfigMode || (FunctionCallingConfigMode = {}));
var ThinkingLevel;
(function(ThinkingLevel2) {
  ThinkingLevel2["THINKING_LEVEL_UNSPECIFIED"] = "THINKING_LEVEL_UNSPECIFIED";
  ThinkingLevel2["MINIMAL"] = "MINIMAL";
  ThinkingLevel2["LOW"] = "LOW";
  ThinkingLevel2["MEDIUM"] = "MEDIUM";
  ThinkingLevel2["HIGH"] = "HIGH";
})(ThinkingLevel || (ThinkingLevel = {}));
var PersonGeneration;
(function(PersonGeneration2) {
  PersonGeneration2["DONT_ALLOW"] = "DONT_ALLOW";
  PersonGeneration2["ALLOW_ADULT"] = "ALLOW_ADULT";
  PersonGeneration2["ALLOW_ALL"] = "ALLOW_ALL";
})(PersonGeneration || (PersonGeneration = {}));
var ProminentPeople;
(function(ProminentPeople2) {
  ProminentPeople2["PROMINENT_PEOPLE_UNSPECIFIED"] = "PROMINENT_PEOPLE_UNSPECIFIED";
  ProminentPeople2["ALLOW_PROMINENT_PEOPLE"] = "ALLOW_PROMINENT_PEOPLE";
  ProminentPeople2["BLOCK_PROMINENT_PEOPLE"] = "BLOCK_PROMINENT_PEOPLE";
})(ProminentPeople || (ProminentPeople = {}));
var HarmCategory;
(function(HarmCategory2) {
  HarmCategory2["HARM_CATEGORY_UNSPECIFIED"] = "HARM_CATEGORY_UNSPECIFIED";
  HarmCategory2["HARM_CATEGORY_HARASSMENT"] = "HARM_CATEGORY_HARASSMENT";
  HarmCategory2["HARM_CATEGORY_HATE_SPEECH"] = "HARM_CATEGORY_HATE_SPEECH";
  HarmCategory2["HARM_CATEGORY_SEXUALLY_EXPLICIT"] = "HARM_CATEGORY_SEXUALLY_EXPLICIT";
  HarmCategory2["HARM_CATEGORY_DANGEROUS_CONTENT"] = "HARM_CATEGORY_DANGEROUS_CONTENT";
  HarmCategory2["HARM_CATEGORY_CIVIC_INTEGRITY"] = "HARM_CATEGORY_CIVIC_INTEGRITY";
  HarmCategory2["HARM_CATEGORY_IMAGE_HATE"] = "HARM_CATEGORY_IMAGE_HATE";
  HarmCategory2["HARM_CATEGORY_IMAGE_DANGEROUS_CONTENT"] = "HARM_CATEGORY_IMAGE_DANGEROUS_CONTENT";
  HarmCategory2["HARM_CATEGORY_IMAGE_HARASSMENT"] = "HARM_CATEGORY_IMAGE_HARASSMENT";
  HarmCategory2["HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT"] = "HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT";
  HarmCategory2["HARM_CATEGORY_JAILBREAK"] = "HARM_CATEGORY_JAILBREAK";
})(HarmCategory || (HarmCategory = {}));
var HarmBlockMethod;
(function(HarmBlockMethod2) {
  HarmBlockMethod2["HARM_BLOCK_METHOD_UNSPECIFIED"] = "HARM_BLOCK_METHOD_UNSPECIFIED";
  HarmBlockMethod2["SEVERITY"] = "SEVERITY";
  HarmBlockMethod2["PROBABILITY"] = "PROBABILITY";
})(HarmBlockMethod || (HarmBlockMethod = {}));
var HarmBlockThreshold;
(function(HarmBlockThreshold2) {
  HarmBlockThreshold2["HARM_BLOCK_THRESHOLD_UNSPECIFIED"] = "HARM_BLOCK_THRESHOLD_UNSPECIFIED";
  HarmBlockThreshold2["BLOCK_LOW_AND_ABOVE"] = "BLOCK_LOW_AND_ABOVE";
  HarmBlockThreshold2["BLOCK_MEDIUM_AND_ABOVE"] = "BLOCK_MEDIUM_AND_ABOVE";
  HarmBlockThreshold2["BLOCK_ONLY_HIGH"] = "BLOCK_ONLY_HIGH";
  HarmBlockThreshold2["BLOCK_NONE"] = "BLOCK_NONE";
  HarmBlockThreshold2["OFF"] = "OFF";
})(HarmBlockThreshold || (HarmBlockThreshold = {}));
var FinishReason;
(function(FinishReason2) {
  FinishReason2["FINISH_REASON_UNSPECIFIED"] = "FINISH_REASON_UNSPECIFIED";
  FinishReason2["STOP"] = "STOP";
  FinishReason2["MAX_TOKENS"] = "MAX_TOKENS";
  FinishReason2["SAFETY"] = "SAFETY";
  FinishReason2["RECITATION"] = "RECITATION";
  FinishReason2["LANGUAGE"] = "LANGUAGE";
  FinishReason2["OTHER"] = "OTHER";
  FinishReason2["BLOCKLIST"] = "BLOCKLIST";
  FinishReason2["PROHIBITED_CONTENT"] = "PROHIBITED_CONTENT";
  FinishReason2["SPII"] = "SPII";
  FinishReason2["MALFORMED_FUNCTION_CALL"] = "MALFORMED_FUNCTION_CALL";
  FinishReason2["IMAGE_SAFETY"] = "IMAGE_SAFETY";
  FinishReason2["UNEXPECTED_TOOL_CALL"] = "UNEXPECTED_TOOL_CALL";
  FinishReason2["IMAGE_PROHIBITED_CONTENT"] = "IMAGE_PROHIBITED_CONTENT";
  FinishReason2["NO_IMAGE"] = "NO_IMAGE";
  FinishReason2["IMAGE_RECITATION"] = "IMAGE_RECITATION";
  FinishReason2["IMAGE_OTHER"] = "IMAGE_OTHER";
})(FinishReason || (FinishReason = {}));
var HarmProbability;
(function(HarmProbability2) {
  HarmProbability2["HARM_PROBABILITY_UNSPECIFIED"] = "HARM_PROBABILITY_UNSPECIFIED";
  HarmProbability2["NEGLIGIBLE"] = "NEGLIGIBLE";
  HarmProbability2["LOW"] = "LOW";
  HarmProbability2["MEDIUM"] = "MEDIUM";
  HarmProbability2["HIGH"] = "HIGH";
})(HarmProbability || (HarmProbability = {}));
var HarmSeverity;
(function(HarmSeverity2) {
  HarmSeverity2["HARM_SEVERITY_UNSPECIFIED"] = "HARM_SEVERITY_UNSPECIFIED";
  HarmSeverity2["HARM_SEVERITY_NEGLIGIBLE"] = "HARM_SEVERITY_NEGLIGIBLE";
  HarmSeverity2["HARM_SEVERITY_LOW"] = "HARM_SEVERITY_LOW";
  HarmSeverity2["HARM_SEVERITY_MEDIUM"] = "HARM_SEVERITY_MEDIUM";
  HarmSeverity2["HARM_SEVERITY_HIGH"] = "HARM_SEVERITY_HIGH";
})(HarmSeverity || (HarmSeverity = {}));
var UrlRetrievalStatus;
(function(UrlRetrievalStatus2) {
  UrlRetrievalStatus2["URL_RETRIEVAL_STATUS_UNSPECIFIED"] = "URL_RETRIEVAL_STATUS_UNSPECIFIED";
  UrlRetrievalStatus2["URL_RETRIEVAL_STATUS_SUCCESS"] = "URL_RETRIEVAL_STATUS_SUCCESS";
  UrlRetrievalStatus2["URL_RETRIEVAL_STATUS_ERROR"] = "URL_RETRIEVAL_STATUS_ERROR";
  UrlRetrievalStatus2["URL_RETRIEVAL_STATUS_PAYWALL"] = "URL_RETRIEVAL_STATUS_PAYWALL";
  UrlRetrievalStatus2["URL_RETRIEVAL_STATUS_UNSAFE"] = "URL_RETRIEVAL_STATUS_UNSAFE";
})(UrlRetrievalStatus || (UrlRetrievalStatus = {}));
var BlockedReason;
(function(BlockedReason2) {
  BlockedReason2["BLOCKED_REASON_UNSPECIFIED"] = "BLOCKED_REASON_UNSPECIFIED";
  BlockedReason2["SAFETY"] = "SAFETY";
  BlockedReason2["OTHER"] = "OTHER";
  BlockedReason2["BLOCKLIST"] = "BLOCKLIST";
  BlockedReason2["PROHIBITED_CONTENT"] = "PROHIBITED_CONTENT";
  BlockedReason2["IMAGE_SAFETY"] = "IMAGE_SAFETY";
  BlockedReason2["MODEL_ARMOR"] = "MODEL_ARMOR";
  BlockedReason2["JAILBREAK"] = "JAILBREAK";
})(BlockedReason || (BlockedReason = {}));
var TrafficType;
(function(TrafficType2) {
  TrafficType2["TRAFFIC_TYPE_UNSPECIFIED"] = "TRAFFIC_TYPE_UNSPECIFIED";
  TrafficType2["ON_DEMAND"] = "ON_DEMAND";
  TrafficType2["ON_DEMAND_PRIORITY"] = "ON_DEMAND_PRIORITY";
  TrafficType2["ON_DEMAND_FLEX"] = "ON_DEMAND_FLEX";
  TrafficType2["PROVISIONED_THROUGHPUT"] = "PROVISIONED_THROUGHPUT";
})(TrafficType || (TrafficType = {}));
var Modality;
(function(Modality2) {
  Modality2["MODALITY_UNSPECIFIED"] = "MODALITY_UNSPECIFIED";
  Modality2["TEXT"] = "TEXT";
  Modality2["IMAGE"] = "IMAGE";
  Modality2["AUDIO"] = "AUDIO";
  Modality2["VIDEO"] = "VIDEO";
})(Modality || (Modality = {}));
var ModelStage;
(function(ModelStage2) {
  ModelStage2["MODEL_STAGE_UNSPECIFIED"] = "MODEL_STAGE_UNSPECIFIED";
  ModelStage2["UNSTABLE_EXPERIMENTAL"] = "UNSTABLE_EXPERIMENTAL";
  ModelStage2["EXPERIMENTAL"] = "EXPERIMENTAL";
  ModelStage2["PREVIEW"] = "PREVIEW";
  ModelStage2["STABLE"] = "STABLE";
  ModelStage2["LEGACY"] = "LEGACY";
  ModelStage2["DEPRECATED"] = "DEPRECATED";
  ModelStage2["RETIRED"] = "RETIRED";
})(ModelStage || (ModelStage = {}));
var MediaResolution;
(function(MediaResolution2) {
  MediaResolution2["MEDIA_RESOLUTION_UNSPECIFIED"] = "MEDIA_RESOLUTION_UNSPECIFIED";
  MediaResolution2["MEDIA_RESOLUTION_LOW"] = "MEDIA_RESOLUTION_LOW";
  MediaResolution2["MEDIA_RESOLUTION_MEDIUM"] = "MEDIA_RESOLUTION_MEDIUM";
  MediaResolution2["MEDIA_RESOLUTION_HIGH"] = "MEDIA_RESOLUTION_HIGH";
})(MediaResolution || (MediaResolution = {}));
var TuningMode;
(function(TuningMode2) {
  TuningMode2["TUNING_MODE_UNSPECIFIED"] = "TUNING_MODE_UNSPECIFIED";
  TuningMode2["TUNING_MODE_FULL"] = "TUNING_MODE_FULL";
  TuningMode2["TUNING_MODE_PEFT_ADAPTER"] = "TUNING_MODE_PEFT_ADAPTER";
})(TuningMode || (TuningMode = {}));
var AdapterSize;
(function(AdapterSize2) {
  AdapterSize2["ADAPTER_SIZE_UNSPECIFIED"] = "ADAPTER_SIZE_UNSPECIFIED";
  AdapterSize2["ADAPTER_SIZE_ONE"] = "ADAPTER_SIZE_ONE";
  AdapterSize2["ADAPTER_SIZE_TWO"] = "ADAPTER_SIZE_TWO";
  AdapterSize2["ADAPTER_SIZE_FOUR"] = "ADAPTER_SIZE_FOUR";
  AdapterSize2["ADAPTER_SIZE_EIGHT"] = "ADAPTER_SIZE_EIGHT";
  AdapterSize2["ADAPTER_SIZE_SIXTEEN"] = "ADAPTER_SIZE_SIXTEEN";
  AdapterSize2["ADAPTER_SIZE_THIRTY_TWO"] = "ADAPTER_SIZE_THIRTY_TWO";
})(AdapterSize || (AdapterSize = {}));
var JobState;
(function(JobState2) {
  JobState2["JOB_STATE_UNSPECIFIED"] = "JOB_STATE_UNSPECIFIED";
  JobState2["JOB_STATE_QUEUED"] = "JOB_STATE_QUEUED";
  JobState2["JOB_STATE_PENDING"] = "JOB_STATE_PENDING";
  JobState2["JOB_STATE_RUNNING"] = "JOB_STATE_RUNNING";
  JobState2["JOB_STATE_SUCCEEDED"] = "JOB_STATE_SUCCEEDED";
  JobState2["JOB_STATE_FAILED"] = "JOB_STATE_FAILED";
  JobState2["JOB_STATE_CANCELLING"] = "JOB_STATE_CANCELLING";
  JobState2["JOB_STATE_CANCELLED"] = "JOB_STATE_CANCELLED";
  JobState2["JOB_STATE_PAUSED"] = "JOB_STATE_PAUSED";
  JobState2["JOB_STATE_EXPIRED"] = "JOB_STATE_EXPIRED";
  JobState2["JOB_STATE_UPDATING"] = "JOB_STATE_UPDATING";
  JobState2["JOB_STATE_PARTIALLY_SUCCEEDED"] = "JOB_STATE_PARTIALLY_SUCCEEDED";
})(JobState || (JobState = {}));
var TuningJobState;
(function(TuningJobState2) {
  TuningJobState2["TUNING_JOB_STATE_UNSPECIFIED"] = "TUNING_JOB_STATE_UNSPECIFIED";
  TuningJobState2["TUNING_JOB_STATE_WAITING_FOR_QUOTA"] = "TUNING_JOB_STATE_WAITING_FOR_QUOTA";
  TuningJobState2["TUNING_JOB_STATE_PROCESSING_DATASET"] = "TUNING_JOB_STATE_PROCESSING_DATASET";
  TuningJobState2["TUNING_JOB_STATE_WAITING_FOR_CAPACITY"] = "TUNING_JOB_STATE_WAITING_FOR_CAPACITY";
  TuningJobState2["TUNING_JOB_STATE_TUNING"] = "TUNING_JOB_STATE_TUNING";
  TuningJobState2["TUNING_JOB_STATE_POST_PROCESSING"] = "TUNING_JOB_STATE_POST_PROCESSING";
})(TuningJobState || (TuningJobState = {}));
var AggregationMetric;
(function(AggregationMetric2) {
  AggregationMetric2["AGGREGATION_METRIC_UNSPECIFIED"] = "AGGREGATION_METRIC_UNSPECIFIED";
  AggregationMetric2["AVERAGE"] = "AVERAGE";
  AggregationMetric2["MODE"] = "MODE";
  AggregationMetric2["STANDARD_DEVIATION"] = "STANDARD_DEVIATION";
  AggregationMetric2["VARIANCE"] = "VARIANCE";
  AggregationMetric2["MINIMUM"] = "MINIMUM";
  AggregationMetric2["MAXIMUM"] = "MAXIMUM";
  AggregationMetric2["MEDIAN"] = "MEDIAN";
  AggregationMetric2["PERCENTILE_P90"] = "PERCENTILE_P90";
  AggregationMetric2["PERCENTILE_P95"] = "PERCENTILE_P95";
  AggregationMetric2["PERCENTILE_P99"] = "PERCENTILE_P99";
})(AggregationMetric || (AggregationMetric = {}));
var PairwiseChoice;
(function(PairwiseChoice2) {
  PairwiseChoice2["PAIRWISE_CHOICE_UNSPECIFIED"] = "PAIRWISE_CHOICE_UNSPECIFIED";
  PairwiseChoice2["BASELINE"] = "BASELINE";
  PairwiseChoice2["CANDIDATE"] = "CANDIDATE";
  PairwiseChoice2["TIE"] = "TIE";
})(PairwiseChoice || (PairwiseChoice = {}));
var TuningSpeed;
(function(TuningSpeed2) {
  TuningSpeed2["TUNING_SPEED_UNSPECIFIED"] = "TUNING_SPEED_UNSPECIFIED";
  TuningSpeed2["REGULAR"] = "REGULAR";
  TuningSpeed2["FAST"] = "FAST";
})(TuningSpeed || (TuningSpeed = {}));
var TuningTask;
(function(TuningTask2) {
  TuningTask2["TUNING_TASK_UNSPECIFIED"] = "TUNING_TASK_UNSPECIFIED";
  TuningTask2["TUNING_TASK_I2V"] = "TUNING_TASK_I2V";
  TuningTask2["TUNING_TASK_T2V"] = "TUNING_TASK_T2V";
  TuningTask2["TUNING_TASK_R2V"] = "TUNING_TASK_R2V";
})(TuningTask || (TuningTask = {}));
var VideoOrientation;
(function(VideoOrientation2) {
  VideoOrientation2["VIDEO_ORIENTATION_UNSPECIFIED"] = "VIDEO_ORIENTATION_UNSPECIFIED";
  VideoOrientation2["LANDSCAPE"] = "LANDSCAPE";
  VideoOrientation2["PORTRAIT"] = "PORTRAIT";
})(VideoOrientation || (VideoOrientation = {}));
var DocumentState;
(function(DocumentState2) {
  DocumentState2["STATE_UNSPECIFIED"] = "STATE_UNSPECIFIED";
  DocumentState2["STATE_PENDING"] = "STATE_PENDING";
  DocumentState2["STATE_ACTIVE"] = "STATE_ACTIVE";
  DocumentState2["STATE_FAILED"] = "STATE_FAILED";
})(DocumentState || (DocumentState = {}));
var PartMediaResolutionLevel;
(function(PartMediaResolutionLevel2) {
  PartMediaResolutionLevel2["MEDIA_RESOLUTION_UNSPECIFIED"] = "MEDIA_RESOLUTION_UNSPECIFIED";
  PartMediaResolutionLevel2["MEDIA_RESOLUTION_LOW"] = "MEDIA_RESOLUTION_LOW";
  PartMediaResolutionLevel2["MEDIA_RESOLUTION_MEDIUM"] = "MEDIA_RESOLUTION_MEDIUM";
  PartMediaResolutionLevel2["MEDIA_RESOLUTION_HIGH"] = "MEDIA_RESOLUTION_HIGH";
  PartMediaResolutionLevel2["MEDIA_RESOLUTION_ULTRA_HIGH"] = "MEDIA_RESOLUTION_ULTRA_HIGH";
})(PartMediaResolutionLevel || (PartMediaResolutionLevel = {}));
var ToolType;
(function(ToolType2) {
  ToolType2["TOOL_TYPE_UNSPECIFIED"] = "TOOL_TYPE_UNSPECIFIED";
  ToolType2["GOOGLE_SEARCH_WEB"] = "GOOGLE_SEARCH_WEB";
  ToolType2["GOOGLE_SEARCH_IMAGE"] = "GOOGLE_SEARCH_IMAGE";
  ToolType2["URL_CONTEXT"] = "URL_CONTEXT";
  ToolType2["GOOGLE_MAPS"] = "GOOGLE_MAPS";
  ToolType2["FILE_SEARCH"] = "FILE_SEARCH";
})(ToolType || (ToolType = {}));
var ResourceScope;
(function(ResourceScope2) {
  ResourceScope2["COLLECTION"] = "COLLECTION";
})(ResourceScope || (ResourceScope = {}));
var ServiceTier;
(function(ServiceTier2) {
  ServiceTier2["UNSPECIFIED"] = "unspecified";
  ServiceTier2["FLEX"] = "flex";
  ServiceTier2["STANDARD"] = "standard";
  ServiceTier2["PRIORITY"] = "priority";
})(ServiceTier || (ServiceTier = {}));
var FeatureSelectionPreference;
(function(FeatureSelectionPreference2) {
  FeatureSelectionPreference2["FEATURE_SELECTION_PREFERENCE_UNSPECIFIED"] = "FEATURE_SELECTION_PREFERENCE_UNSPECIFIED";
  FeatureSelectionPreference2["PRIORITIZE_QUALITY"] = "PRIORITIZE_QUALITY";
  FeatureSelectionPreference2["BALANCED"] = "BALANCED";
  FeatureSelectionPreference2["PRIORITIZE_COST"] = "PRIORITIZE_COST";
})(FeatureSelectionPreference || (FeatureSelectionPreference = {}));
var EmbeddingApiType;
(function(EmbeddingApiType2) {
  EmbeddingApiType2["PREDICT"] = "PREDICT";
  EmbeddingApiType2["EMBED_CONTENT"] = "EMBED_CONTENT";
})(EmbeddingApiType || (EmbeddingApiType = {}));
var SafetyFilterLevel;
(function(SafetyFilterLevel2) {
  SafetyFilterLevel2["BLOCK_LOW_AND_ABOVE"] = "BLOCK_LOW_AND_ABOVE";
  SafetyFilterLevel2["BLOCK_MEDIUM_AND_ABOVE"] = "BLOCK_MEDIUM_AND_ABOVE";
  SafetyFilterLevel2["BLOCK_ONLY_HIGH"] = "BLOCK_ONLY_HIGH";
  SafetyFilterLevel2["BLOCK_NONE"] = "BLOCK_NONE";
})(SafetyFilterLevel || (SafetyFilterLevel = {}));
var ImagePromptLanguage;
(function(ImagePromptLanguage2) {
  ImagePromptLanguage2["auto"] = "auto";
  ImagePromptLanguage2["en"] = "en";
  ImagePromptLanguage2["ja"] = "ja";
  ImagePromptLanguage2["ko"] = "ko";
  ImagePromptLanguage2["hi"] = "hi";
  ImagePromptLanguage2["zh"] = "zh";
  ImagePromptLanguage2["pt"] = "pt";
  ImagePromptLanguage2["es"] = "es";
})(ImagePromptLanguage || (ImagePromptLanguage = {}));
var MaskReferenceMode;
(function(MaskReferenceMode2) {
  MaskReferenceMode2["MASK_MODE_DEFAULT"] = "MASK_MODE_DEFAULT";
  MaskReferenceMode2["MASK_MODE_USER_PROVIDED"] = "MASK_MODE_USER_PROVIDED";
  MaskReferenceMode2["MASK_MODE_BACKGROUND"] = "MASK_MODE_BACKGROUND";
  MaskReferenceMode2["MASK_MODE_FOREGROUND"] = "MASK_MODE_FOREGROUND";
  MaskReferenceMode2["MASK_MODE_SEMANTIC"] = "MASK_MODE_SEMANTIC";
})(MaskReferenceMode || (MaskReferenceMode = {}));
var ControlReferenceType;
(function(ControlReferenceType2) {
  ControlReferenceType2["CONTROL_TYPE_DEFAULT"] = "CONTROL_TYPE_DEFAULT";
  ControlReferenceType2["CONTROL_TYPE_CANNY"] = "CONTROL_TYPE_CANNY";
  ControlReferenceType2["CONTROL_TYPE_SCRIBBLE"] = "CONTROL_TYPE_SCRIBBLE";
  ControlReferenceType2["CONTROL_TYPE_FACE_MESH"] = "CONTROL_TYPE_FACE_MESH";
})(ControlReferenceType || (ControlReferenceType = {}));
var SubjectReferenceType;
(function(SubjectReferenceType2) {
  SubjectReferenceType2["SUBJECT_TYPE_DEFAULT"] = "SUBJECT_TYPE_DEFAULT";
  SubjectReferenceType2["SUBJECT_TYPE_PERSON"] = "SUBJECT_TYPE_PERSON";
  SubjectReferenceType2["SUBJECT_TYPE_ANIMAL"] = "SUBJECT_TYPE_ANIMAL";
  SubjectReferenceType2["SUBJECT_TYPE_PRODUCT"] = "SUBJECT_TYPE_PRODUCT";
})(SubjectReferenceType || (SubjectReferenceType = {}));
var EditMode;
(function(EditMode2) {
  EditMode2["EDIT_MODE_DEFAULT"] = "EDIT_MODE_DEFAULT";
  EditMode2["EDIT_MODE_INPAINT_REMOVAL"] = "EDIT_MODE_INPAINT_REMOVAL";
  EditMode2["EDIT_MODE_INPAINT_INSERTION"] = "EDIT_MODE_INPAINT_INSERTION";
  EditMode2["EDIT_MODE_OUTPAINT"] = "EDIT_MODE_OUTPAINT";
  EditMode2["EDIT_MODE_CONTROLLED_EDITING"] = "EDIT_MODE_CONTROLLED_EDITING";
  EditMode2["EDIT_MODE_STYLE"] = "EDIT_MODE_STYLE";
  EditMode2["EDIT_MODE_BGSWAP"] = "EDIT_MODE_BGSWAP";
  EditMode2["EDIT_MODE_PRODUCT_IMAGE"] = "EDIT_MODE_PRODUCT_IMAGE";
})(EditMode || (EditMode = {}));
var SegmentMode;
(function(SegmentMode2) {
  SegmentMode2["FOREGROUND"] = "FOREGROUND";
  SegmentMode2["BACKGROUND"] = "BACKGROUND";
  SegmentMode2["PROMPT"] = "PROMPT";
  SegmentMode2["SEMANTIC"] = "SEMANTIC";
  SegmentMode2["INTERACTIVE"] = "INTERACTIVE";
})(SegmentMode || (SegmentMode = {}));
var VideoGenerationReferenceType;
(function(VideoGenerationReferenceType2) {
  VideoGenerationReferenceType2["ASSET"] = "ASSET";
  VideoGenerationReferenceType2["STYLE"] = "STYLE";
})(VideoGenerationReferenceType || (VideoGenerationReferenceType = {}));
var VideoGenerationMaskMode;
(function(VideoGenerationMaskMode2) {
  VideoGenerationMaskMode2["INSERT"] = "INSERT";
  VideoGenerationMaskMode2["REMOVE"] = "REMOVE";
  VideoGenerationMaskMode2["REMOVE_STATIC"] = "REMOVE_STATIC";
  VideoGenerationMaskMode2["OUTPAINT"] = "OUTPAINT";
})(VideoGenerationMaskMode || (VideoGenerationMaskMode = {}));
var VideoCompressionQuality;
(function(VideoCompressionQuality2) {
  VideoCompressionQuality2["OPTIMIZED"] = "OPTIMIZED";
  VideoCompressionQuality2["LOSSLESS"] = "LOSSLESS";
})(VideoCompressionQuality || (VideoCompressionQuality = {}));
var ImageResizeMode;
(function(ImageResizeMode2) {
  ImageResizeMode2["CROP"] = "CROP";
  ImageResizeMode2["PAD"] = "PAD";
})(ImageResizeMode || (ImageResizeMode = {}));
var TuningMethod;
(function(TuningMethod2) {
  TuningMethod2["SUPERVISED_FINE_TUNING"] = "SUPERVISED_FINE_TUNING";
  TuningMethod2["PREFERENCE_TUNING"] = "PREFERENCE_TUNING";
  TuningMethod2["DISTILLATION"] = "DISTILLATION";
})(TuningMethod || (TuningMethod = {}));
var FileState;
(function(FileState2) {
  FileState2["STATE_UNSPECIFIED"] = "STATE_UNSPECIFIED";
  FileState2["PROCESSING"] = "PROCESSING";
  FileState2["ACTIVE"] = "ACTIVE";
  FileState2["FAILED"] = "FAILED";
})(FileState || (FileState = {}));
var FileSource;
(function(FileSource2) {
  FileSource2["SOURCE_UNSPECIFIED"] = "SOURCE_UNSPECIFIED";
  FileSource2["UPLOADED"] = "UPLOADED";
  FileSource2["GENERATED"] = "GENERATED";
  FileSource2["REGISTERED"] = "REGISTERED";
})(FileSource || (FileSource = {}));
var TurnCompleteReason;
(function(TurnCompleteReason2) {
  TurnCompleteReason2["TURN_COMPLETE_REASON_UNSPECIFIED"] = "TURN_COMPLETE_REASON_UNSPECIFIED";
  TurnCompleteReason2["MALFORMED_FUNCTION_CALL"] = "MALFORMED_FUNCTION_CALL";
  TurnCompleteReason2["RESPONSE_REJECTED"] = "RESPONSE_REJECTED";
  TurnCompleteReason2["NEED_MORE_INPUT"] = "NEED_MORE_INPUT";
  TurnCompleteReason2["PROHIBITED_INPUT_CONTENT"] = "PROHIBITED_INPUT_CONTENT";
  TurnCompleteReason2["IMAGE_PROHIBITED_INPUT_CONTENT"] = "IMAGE_PROHIBITED_INPUT_CONTENT";
  TurnCompleteReason2["INPUT_TEXT_CONTAIN_PROMINENT_PERSON_PROHIBITED"] = "INPUT_TEXT_CONTAIN_PROMINENT_PERSON_PROHIBITED";
  TurnCompleteReason2["INPUT_IMAGE_CELEBRITY"] = "INPUT_IMAGE_CELEBRITY";
  TurnCompleteReason2["INPUT_IMAGE_PHOTO_REALISTIC_CHILD_PROHIBITED"] = "INPUT_IMAGE_PHOTO_REALISTIC_CHILD_PROHIBITED";
  TurnCompleteReason2["INPUT_TEXT_NCII_PROHIBITED"] = "INPUT_TEXT_NCII_PROHIBITED";
  TurnCompleteReason2["INPUT_OTHER"] = "INPUT_OTHER";
  TurnCompleteReason2["INPUT_IP_PROHIBITED"] = "INPUT_IP_PROHIBITED";
  TurnCompleteReason2["BLOCKLIST"] = "BLOCKLIST";
  TurnCompleteReason2["UNSAFE_PROMPT_FOR_IMAGE_GENERATION"] = "UNSAFE_PROMPT_FOR_IMAGE_GENERATION";
  TurnCompleteReason2["GENERATED_IMAGE_SAFETY"] = "GENERATED_IMAGE_SAFETY";
  TurnCompleteReason2["GENERATED_CONTENT_SAFETY"] = "GENERATED_CONTENT_SAFETY";
  TurnCompleteReason2["GENERATED_AUDIO_SAFETY"] = "GENERATED_AUDIO_SAFETY";
  TurnCompleteReason2["GENERATED_VIDEO_SAFETY"] = "GENERATED_VIDEO_SAFETY";
  TurnCompleteReason2["GENERATED_CONTENT_PROHIBITED"] = "GENERATED_CONTENT_PROHIBITED";
  TurnCompleteReason2["GENERATED_CONTENT_BLOCKLIST"] = "GENERATED_CONTENT_BLOCKLIST";
  TurnCompleteReason2["GENERATED_IMAGE_PROHIBITED"] = "GENERATED_IMAGE_PROHIBITED";
  TurnCompleteReason2["GENERATED_IMAGE_CELEBRITY"] = "GENERATED_IMAGE_CELEBRITY";
  TurnCompleteReason2["GENERATED_IMAGE_PROMINENT_PEOPLE_DETECTED_BY_REWRITER"] = "GENERATED_IMAGE_PROMINENT_PEOPLE_DETECTED_BY_REWRITER";
  TurnCompleteReason2["GENERATED_IMAGE_IDENTIFIABLE_PEOPLE"] = "GENERATED_IMAGE_IDENTIFIABLE_PEOPLE";
  TurnCompleteReason2["GENERATED_IMAGE_MINORS"] = "GENERATED_IMAGE_MINORS";
  TurnCompleteReason2["OUTPUT_IMAGE_IP_PROHIBITED"] = "OUTPUT_IMAGE_IP_PROHIBITED";
  TurnCompleteReason2["GENERATED_OTHER"] = "GENERATED_OTHER";
  TurnCompleteReason2["MAX_REGENERATION_REACHED"] = "MAX_REGENERATION_REACHED";
})(TurnCompleteReason || (TurnCompleteReason = {}));
var MediaModality;
(function(MediaModality2) {
  MediaModality2["MODALITY_UNSPECIFIED"] = "MODALITY_UNSPECIFIED";
  MediaModality2["TEXT"] = "TEXT";
  MediaModality2["IMAGE"] = "IMAGE";
  MediaModality2["VIDEO"] = "VIDEO";
  MediaModality2["AUDIO"] = "AUDIO";
  MediaModality2["DOCUMENT"] = "DOCUMENT";
})(MediaModality || (MediaModality = {}));
var VadSignalType;
(function(VadSignalType2) {
  VadSignalType2["VAD_SIGNAL_TYPE_UNSPECIFIED"] = "VAD_SIGNAL_TYPE_UNSPECIFIED";
  VadSignalType2["VAD_SIGNAL_TYPE_SOS"] = "VAD_SIGNAL_TYPE_SOS";
  VadSignalType2["VAD_SIGNAL_TYPE_EOS"] = "VAD_SIGNAL_TYPE_EOS";
})(VadSignalType || (VadSignalType = {}));
var VoiceActivityType;
(function(VoiceActivityType2) {
  VoiceActivityType2["TYPE_UNSPECIFIED"] = "TYPE_UNSPECIFIED";
  VoiceActivityType2["ACTIVITY_START"] = "ACTIVITY_START";
  VoiceActivityType2["ACTIVITY_END"] = "ACTIVITY_END";
})(VoiceActivityType || (VoiceActivityType = {}));
var StartSensitivity;
(function(StartSensitivity2) {
  StartSensitivity2["START_SENSITIVITY_UNSPECIFIED"] = "START_SENSITIVITY_UNSPECIFIED";
  StartSensitivity2["START_SENSITIVITY_HIGH"] = "START_SENSITIVITY_HIGH";
  StartSensitivity2["START_SENSITIVITY_LOW"] = "START_SENSITIVITY_LOW";
})(StartSensitivity || (StartSensitivity = {}));
var EndSensitivity;
(function(EndSensitivity2) {
  EndSensitivity2["END_SENSITIVITY_UNSPECIFIED"] = "END_SENSITIVITY_UNSPECIFIED";
  EndSensitivity2["END_SENSITIVITY_HIGH"] = "END_SENSITIVITY_HIGH";
  EndSensitivity2["END_SENSITIVITY_LOW"] = "END_SENSITIVITY_LOW";
})(EndSensitivity || (EndSensitivity = {}));
var ActivityHandling;
(function(ActivityHandling2) {
  ActivityHandling2["ACTIVITY_HANDLING_UNSPECIFIED"] = "ACTIVITY_HANDLING_UNSPECIFIED";
  ActivityHandling2["START_OF_ACTIVITY_INTERRUPTS"] = "START_OF_ACTIVITY_INTERRUPTS";
  ActivityHandling2["NO_INTERRUPTION"] = "NO_INTERRUPTION";
})(ActivityHandling || (ActivityHandling = {}));
var TurnCoverage;
(function(TurnCoverage2) {
  TurnCoverage2["TURN_COVERAGE_UNSPECIFIED"] = "TURN_COVERAGE_UNSPECIFIED";
  TurnCoverage2["TURN_INCLUDES_ONLY_ACTIVITY"] = "TURN_INCLUDES_ONLY_ACTIVITY";
  TurnCoverage2["TURN_INCLUDES_ALL_INPUT"] = "TURN_INCLUDES_ALL_INPUT";
  TurnCoverage2["TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO"] = "TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO";
})(TurnCoverage || (TurnCoverage = {}));
var Scale;
(function(Scale2) {
  Scale2["SCALE_UNSPECIFIED"] = "SCALE_UNSPECIFIED";
  Scale2["C_MAJOR_A_MINOR"] = "C_MAJOR_A_MINOR";
  Scale2["D_FLAT_MAJOR_B_FLAT_MINOR"] = "D_FLAT_MAJOR_B_FLAT_MINOR";
  Scale2["D_MAJOR_B_MINOR"] = "D_MAJOR_B_MINOR";
  Scale2["E_FLAT_MAJOR_C_MINOR"] = "E_FLAT_MAJOR_C_MINOR";
  Scale2["E_MAJOR_D_FLAT_MINOR"] = "E_MAJOR_D_FLAT_MINOR";
  Scale2["F_MAJOR_D_MINOR"] = "F_MAJOR_D_MINOR";
  Scale2["G_FLAT_MAJOR_E_FLAT_MINOR"] = "G_FLAT_MAJOR_E_FLAT_MINOR";
  Scale2["G_MAJOR_E_MINOR"] = "G_MAJOR_E_MINOR";
  Scale2["A_FLAT_MAJOR_F_MINOR"] = "A_FLAT_MAJOR_F_MINOR";
  Scale2["A_MAJOR_G_FLAT_MINOR"] = "A_MAJOR_G_FLAT_MINOR";
  Scale2["B_FLAT_MAJOR_G_MINOR"] = "B_FLAT_MAJOR_G_MINOR";
  Scale2["B_MAJOR_A_FLAT_MINOR"] = "B_MAJOR_A_FLAT_MINOR";
})(Scale || (Scale = {}));
var MusicGenerationMode;
(function(MusicGenerationMode2) {
  MusicGenerationMode2["MUSIC_GENERATION_MODE_UNSPECIFIED"] = "MUSIC_GENERATION_MODE_UNSPECIFIED";
  MusicGenerationMode2["QUALITY"] = "QUALITY";
  MusicGenerationMode2["DIVERSITY"] = "DIVERSITY";
  MusicGenerationMode2["VOCALIZATION"] = "VOCALIZATION";
})(MusicGenerationMode || (MusicGenerationMode = {}));
var LiveMusicPlaybackControl;
(function(LiveMusicPlaybackControl2) {
  LiveMusicPlaybackControl2["PLAYBACK_CONTROL_UNSPECIFIED"] = "PLAYBACK_CONTROL_UNSPECIFIED";
  LiveMusicPlaybackControl2["PLAY"] = "PLAY";
  LiveMusicPlaybackControl2["PAUSE"] = "PAUSE";
  LiveMusicPlaybackControl2["STOP"] = "STOP";
  LiveMusicPlaybackControl2["RESET_CONTEXT"] = "RESET_CONTEXT";
})(LiveMusicPlaybackControl || (LiveMusicPlaybackControl = {}));
var ToolResponse = class {
  static {
    __name(this, "ToolResponse");
  }
};
var FunctionResponseBlob = class {
  static {
    __name(this, "FunctionResponseBlob");
  }
};
var FunctionResponseFileData = class {
  static {
    __name(this, "FunctionResponseFileData");
  }
};
var FunctionResponsePart = class {
  static {
    __name(this, "FunctionResponsePart");
  }
};
function createFunctionResponsePartFromBase64(data, mimeType) {
  return {
    inlineData: {
      data,
      mimeType
    }
  };
}
__name(createFunctionResponsePartFromBase64, "createFunctionResponsePartFromBase64");
function createFunctionResponsePartFromUri(uri, mimeType) {
  return {
    fileData: {
      fileUri: uri,
      mimeType
    }
  };
}
__name(createFunctionResponsePartFromUri, "createFunctionResponsePartFromUri");
var FunctionResponse = class {
  static {
    __name(this, "FunctionResponse");
  }
};
function createPartFromUri(uri, mimeType, mediaResolution) {
  return Object.assign({ fileData: {
    fileUri: uri,
    mimeType
  } }, mediaResolution && { mediaResolution: { level: mediaResolution } });
}
__name(createPartFromUri, "createPartFromUri");
function createPartFromText(text) {
  return {
    text
  };
}
__name(createPartFromText, "createPartFromText");
function createPartFromFunctionCall(name, args) {
  return {
    functionCall: {
      name,
      args
    }
  };
}
__name(createPartFromFunctionCall, "createPartFromFunctionCall");
function createPartFromFunctionResponse(id, name, response, parts = []) {
  return {
    functionResponse: Object.assign({ id, name, response }, parts.length > 0 && { parts })
  };
}
__name(createPartFromFunctionResponse, "createPartFromFunctionResponse");
function createPartFromBase64(data, mimeType, mediaResolution) {
  return Object.assign({ inlineData: {
    data,
    mimeType
  } }, mediaResolution && { mediaResolution: { level: mediaResolution } });
}
__name(createPartFromBase64, "createPartFromBase64");
function createPartFromCodeExecutionResult(outcome, output) {
  return {
    codeExecutionResult: {
      outcome,
      output
    }
  };
}
__name(createPartFromCodeExecutionResult, "createPartFromCodeExecutionResult");
function createPartFromExecutableCode(code, language) {
  return {
    executableCode: {
      code,
      language
    }
  };
}
__name(createPartFromExecutableCode, "createPartFromExecutableCode");
function _isPart(obj) {
  if (typeof obj === "object" && obj !== null) {
    return "fileData" in obj || "text" in obj || "functionCall" in obj || "functionResponse" in obj || "inlineData" in obj || "videoMetadata" in obj || "codeExecutionResult" in obj || "executableCode" in obj;
  }
  return false;
}
__name(_isPart, "_isPart");
function _toParts(partOrString) {
  const parts = [];
  if (typeof partOrString === "string") {
    parts.push(createPartFromText(partOrString));
  } else if (_isPart(partOrString)) {
    parts.push(partOrString);
  } else if (Array.isArray(partOrString)) {
    if (partOrString.length === 0) {
      throw new Error("partOrString cannot be an empty array");
    }
    for (const part of partOrString) {
      if (typeof part === "string") {
        parts.push(createPartFromText(part));
      } else if (_isPart(part)) {
        parts.push(part);
      } else {
        throw new Error("element in PartUnion must be a Part object or string");
      }
    }
  } else {
    throw new Error("partOrString must be a Part object, string, or array");
  }
  return parts;
}
__name(_toParts, "_toParts");
function createUserContent(partOrString) {
  return {
    role: "user",
    parts: _toParts(partOrString)
  };
}
__name(createUserContent, "createUserContent");
function createModelContent(partOrString) {
  return {
    role: "model",
    parts: _toParts(partOrString)
  };
}
__name(createModelContent, "createModelContent");
var HttpResponse = class {
  static {
    __name(this, "HttpResponse");
  }
  constructor(response) {
    const headers = {};
    for (const pair of response.headers.entries()) {
      headers[pair[0]] = pair[1];
    }
    this.headers = headers;
    this.responseInternal = response;
  }
  json() {
    return this.responseInternal.json();
  }
};
var GenerateContentResponsePromptFeedback = class {
  static {
    __name(this, "GenerateContentResponsePromptFeedback");
  }
};
var GenerateContentResponseUsageMetadata = class {
  static {
    __name(this, "GenerateContentResponseUsageMetadata");
  }
};
var GenerateContentResponse = class {
  static {
    __name(this, "GenerateContentResponse");
  }
  /**
   * Returns the concatenation of all text parts from the first candidate in the response.
   *
   * @remarks
   * If there are multiple candidates in the response, the text from the first
   * one will be returned.
   * If there are non-text parts in the response, the concatenation of all text
   * parts will be returned, and a warning will be logged.
   * If there are thought parts in the response, the concatenation of all text
   * parts excluding the thought parts will be returned.
   *
   * @example
   * ```ts
   * const response = await ai.models.generateContent({
   *   model: 'gemini-2.0-flash',
   *   contents:
   *     'Why is the sky blue?',
   * });
   *
   * console.debug(response.text);
   * ```
   */
  get text() {
    var _a2, _b, _c, _d, _e, _f, _g, _h;
    if (((_d = (_c = (_b = (_a2 = this.candidates) === null || _a2 === void 0 ? void 0 : _a2[0]) === null || _b === void 0 ? void 0 : _b.content) === null || _c === void 0 ? void 0 : _c.parts) === null || _d === void 0 ? void 0 : _d.length) === 0) {
      return void 0;
    }
    if (this.candidates && this.candidates.length > 1) {
      console.warn("there are multiple candidates in the response, returning text from the first one.");
    }
    let text = "";
    let anyTextPartText = false;
    const nonTextParts = [];
    for (const part of (_h = (_g = (_f = (_e = this.candidates) === null || _e === void 0 ? void 0 : _e[0]) === null || _f === void 0 ? void 0 : _f.content) === null || _g === void 0 ? void 0 : _g.parts) !== null && _h !== void 0 ? _h : []) {
      for (const [fieldName, fieldValue] of Object.entries(part)) {
        if (fieldName !== "text" && fieldName !== "thought" && fieldName !== "thoughtSignature" && (fieldValue !== null || fieldValue !== void 0)) {
          nonTextParts.push(fieldName);
        }
      }
      if (typeof part.text === "string") {
        if (typeof part.thought === "boolean" && part.thought) {
          continue;
        }
        anyTextPartText = true;
        text += part.text;
      }
    }
    if (nonTextParts.length > 0) {
      console.warn(`there are non-text parts ${nonTextParts} in the response, returning concatenation of all text parts. Please refer to the non text parts for a full response from model.`);
    }
    return anyTextPartText ? text : void 0;
  }
  /**
   * Returns the concatenation of all inline data parts from the first candidate
   * in the response.
   *
   * @remarks
   * If there are multiple candidates in the response, the inline data from the
   * first one will be returned. If there are non-inline data parts in the
   * response, the concatenation of all inline data parts will be returned, and
   * a warning will be logged.
   */
  get data() {
    var _a2, _b, _c, _d, _e, _f, _g, _h;
    if (((_d = (_c = (_b = (_a2 = this.candidates) === null || _a2 === void 0 ? void 0 : _a2[0]) === null || _b === void 0 ? void 0 : _b.content) === null || _c === void 0 ? void 0 : _c.parts) === null || _d === void 0 ? void 0 : _d.length) === 0) {
      return void 0;
    }
    if (this.candidates && this.candidates.length > 1) {
      console.warn("there are multiple candidates in the response, returning data from the first one.");
    }
    let data = "";
    const nonDataParts = [];
    for (const part of (_h = (_g = (_f = (_e = this.candidates) === null || _e === void 0 ? void 0 : _e[0]) === null || _f === void 0 ? void 0 : _f.content) === null || _g === void 0 ? void 0 : _g.parts) !== null && _h !== void 0 ? _h : []) {
      for (const [fieldName, fieldValue] of Object.entries(part)) {
        if (fieldName !== "inlineData" && (fieldValue !== null || fieldValue !== void 0)) {
          nonDataParts.push(fieldName);
        }
      }
      if (part.inlineData && typeof part.inlineData.data === "string") {
        data += atob(part.inlineData.data);
      }
    }
    if (nonDataParts.length > 0) {
      console.warn(`there are non-data parts ${nonDataParts} in the response, returning concatenation of all data parts. Please refer to the non data parts for a full response from model.`);
    }
    return data.length > 0 ? btoa(data) : void 0;
  }
  /**
   * Returns the function calls from the first candidate in the response.
   *
   * @remarks
   * If there are multiple candidates in the response, the function calls from
   * the first one will be returned.
   * If there are no function calls in the response, undefined will be returned.
   *
   * @example
   * ```ts
   * const controlLightFunctionDeclaration: FunctionDeclaration = {
   *   name: 'controlLight',
   *   parameters: {
   *   type: Type.OBJECT,
   *   description: 'Set the brightness and color temperature of a room light.',
   *   properties: {
   *     brightness: {
   *       type: Type.NUMBER,
   *       description:
   *         'Light level from 0 to 100. Zero is off and 100 is full brightness.',
   *     },
   *     colorTemperature: {
   *       type: Type.STRING,
   *       description:
   *         'Color temperature of the light fixture which can be `daylight`, `cool` or `warm`.',
   *     },
   *   },
   *   required: ['brightness', 'colorTemperature'],
   *  };
   *  const response = await ai.models.generateContent({
   *     model: 'gemini-2.0-flash',
   *     contents: 'Dim the lights so the room feels cozy and warm.',
   *     config: {
   *       tools: [{functionDeclarations: [controlLightFunctionDeclaration]}],
   *       toolConfig: {
   *         functionCallingConfig: {
   *           mode: FunctionCallingConfigMode.ANY,
   *           allowedFunctionNames: ['controlLight'],
   *         },
   *       },
   *     },
   *   });
   *  console.debug(JSON.stringify(response.functionCalls));
   * ```
   */
  get functionCalls() {
    var _a2, _b, _c, _d, _e, _f, _g, _h;
    if (((_d = (_c = (_b = (_a2 = this.candidates) === null || _a2 === void 0 ? void 0 : _a2[0]) === null || _b === void 0 ? void 0 : _b.content) === null || _c === void 0 ? void 0 : _c.parts) === null || _d === void 0 ? void 0 : _d.length) === 0) {
      return void 0;
    }
    if (this.candidates && this.candidates.length > 1) {
      console.warn("there are multiple candidates in the response, returning function calls from the first one.");
    }
    const functionCalls = (_h = (_g = (_f = (_e = this.candidates) === null || _e === void 0 ? void 0 : _e[0]) === null || _f === void 0 ? void 0 : _f.content) === null || _g === void 0 ? void 0 : _g.parts) === null || _h === void 0 ? void 0 : _h.filter((part) => part.functionCall).map((part) => part.functionCall).filter((functionCall) => functionCall !== void 0);
    if ((functionCalls === null || functionCalls === void 0 ? void 0 : functionCalls.length) === 0) {
      return void 0;
    }
    return functionCalls;
  }
  /**
   * Returns the first executable code from the first candidate in the response.
   *
   * @remarks
   * If there are multiple candidates in the response, the executable code from
   * the first one will be returned.
   * If there are no executable code in the response, undefined will be
   * returned.
   *
   * @example
   * ```ts
   * const response = await ai.models.generateContent({
   *   model: 'gemini-2.0-flash',
   *   contents:
   *     'What is the sum of the first 50 prime numbers? Generate and run code for the calculation, and make sure you get all 50.'
   *   config: {
   *     tools: [{codeExecution: {}}],
   *   },
   * });
   *
   * console.debug(response.executableCode);
   * ```
   */
  get executableCode() {
    var _a2, _b, _c, _d, _e, _f, _g, _h, _j;
    if (((_d = (_c = (_b = (_a2 = this.candidates) === null || _a2 === void 0 ? void 0 : _a2[0]) === null || _b === void 0 ? void 0 : _b.content) === null || _c === void 0 ? void 0 : _c.parts) === null || _d === void 0 ? void 0 : _d.length) === 0) {
      return void 0;
    }
    if (this.candidates && this.candidates.length > 1) {
      console.warn("there are multiple candidates in the response, returning executable code from the first one.");
    }
    const executableCode = (_h = (_g = (_f = (_e = this.candidates) === null || _e === void 0 ? void 0 : _e[0]) === null || _f === void 0 ? void 0 : _f.content) === null || _g === void 0 ? void 0 : _g.parts) === null || _h === void 0 ? void 0 : _h.filter((part) => part.executableCode).map((part) => part.executableCode).filter((executableCode2) => executableCode2 !== void 0);
    if ((executableCode === null || executableCode === void 0 ? void 0 : executableCode.length) === 0) {
      return void 0;
    }
    return (_j = executableCode === null || executableCode === void 0 ? void 0 : executableCode[0]) === null || _j === void 0 ? void 0 : _j.code;
  }
  /**
   * Returns the first code execution result from the first candidate in the response.
   *
   * @remarks
   * If there are multiple candidates in the response, the code execution result from
   * the first one will be returned.
   * If there are no code execution result in the response, undefined will be returned.
   *
   * @example
   * ```ts
   * const response = await ai.models.generateContent({
   *   model: 'gemini-2.0-flash',
   *   contents:
   *     'What is the sum of the first 50 prime numbers? Generate and run code for the calculation, and make sure you get all 50.'
   *   config: {
   *     tools: [{codeExecution: {}}],
   *   },
   * });
   *
   * console.debug(response.codeExecutionResult);
   * ```
   */
  get codeExecutionResult() {
    var _a2, _b, _c, _d, _e, _f, _g, _h, _j;
    if (((_d = (_c = (_b = (_a2 = this.candidates) === null || _a2 === void 0 ? void 0 : _a2[0]) === null || _b === void 0 ? void 0 : _b.content) === null || _c === void 0 ? void 0 : _c.parts) === null || _d === void 0 ? void 0 : _d.length) === 0) {
      return void 0;
    }
    if (this.candidates && this.candidates.length > 1) {
      console.warn("there are multiple candidates in the response, returning code execution result from the first one.");
    }
    const codeExecutionResult = (_h = (_g = (_f = (_e = this.candidates) === null || _e === void 0 ? void 0 : _e[0]) === null || _f === void 0 ? void 0 : _f.content) === null || _g === void 0 ? void 0 : _g.parts) === null || _h === void 0 ? void 0 : _h.filter((part) => part.codeExecutionResult).map((part) => part.codeExecutionResult).filter((codeExecutionResult2) => codeExecutionResult2 !== void 0);
    if ((codeExecutionResult === null || codeExecutionResult === void 0 ? void 0 : codeExecutionResult.length) === 0) {
      return void 0;
    }
    return (_j = codeExecutionResult === null || codeExecutionResult === void 0 ? void 0 : codeExecutionResult[0]) === null || _j === void 0 ? void 0 : _j.output;
  }
};
var EmbedContentResponse = class {
  static {
    __name(this, "EmbedContentResponse");
  }
};
var GenerateImagesResponse = class {
  static {
    __name(this, "GenerateImagesResponse");
  }
};
var EditImageResponse = class {
  static {
    __name(this, "EditImageResponse");
  }
};
var UpscaleImageResponse = class {
  static {
    __name(this, "UpscaleImageResponse");
  }
};
var RecontextImageResponse = class {
  static {
    __name(this, "RecontextImageResponse");
  }
};
var SegmentImageResponse = class {
  static {
    __name(this, "SegmentImageResponse");
  }
};
var ListModelsResponse = class {
  static {
    __name(this, "ListModelsResponse");
  }
};
var DeleteModelResponse = class {
  static {
    __name(this, "DeleteModelResponse");
  }
};
var CountTokensResponse = class {
  static {
    __name(this, "CountTokensResponse");
  }
};
var ComputeTokensResponse = class {
  static {
    __name(this, "ComputeTokensResponse");
  }
};
var GenerateVideosResponse = class {
  static {
    __name(this, "GenerateVideosResponse");
  }
};
var GenerateVideosOperation = class _GenerateVideosOperation {
  static {
    __name(this, "GenerateVideosOperation");
  }
  /**
   * Instantiates an Operation of the same type as the one being called with the fields set from the API response.
   */
  _fromAPIResponse({ apiResponse, _isVertexAI }) {
    const operation = new _GenerateVideosOperation();
    let response;
    const op = apiResponse;
    if (_isVertexAI) {
      response = generateVideosOperationFromVertex$1(op);
    } else {
      response = generateVideosOperationFromMldev$1(op);
    }
    Object.assign(operation, response);
    return operation;
  }
};
var EvaluateDatasetResponse = class {
  static {
    __name(this, "EvaluateDatasetResponse");
  }
};
var ListTuningJobsResponse = class {
  static {
    __name(this, "ListTuningJobsResponse");
  }
};
var CancelTuningJobResponse = class {
  static {
    __name(this, "CancelTuningJobResponse");
  }
};
var DeleteCachedContentResponse = class {
  static {
    __name(this, "DeleteCachedContentResponse");
  }
};
var ListCachedContentsResponse = class {
  static {
    __name(this, "ListCachedContentsResponse");
  }
};
var ListDocumentsResponse = class {
  static {
    __name(this, "ListDocumentsResponse");
  }
};
var ListFileSearchStoresResponse = class {
  static {
    __name(this, "ListFileSearchStoresResponse");
  }
};
var UploadToFileSearchStoreResumableResponse = class {
  static {
    __name(this, "UploadToFileSearchStoreResumableResponse");
  }
};
var ImportFileResponse = class {
  static {
    __name(this, "ImportFileResponse");
  }
};
var ImportFileOperation = class _ImportFileOperation {
  static {
    __name(this, "ImportFileOperation");
  }
  /**
   * Instantiates an Operation of the same type as the one being called with the fields set from the API response.
   */
  _fromAPIResponse({ apiResponse, _isVertexAI }) {
    const operation = new _ImportFileOperation();
    const op = apiResponse;
    const response = importFileOperationFromMldev$1(op);
    Object.assign(operation, response);
    return operation;
  }
};
var ListFilesResponse = class {
  static {
    __name(this, "ListFilesResponse");
  }
};
var CreateFileResponse = class {
  static {
    __name(this, "CreateFileResponse");
  }
};
var DeleteFileResponse = class {
  static {
    __name(this, "DeleteFileResponse");
  }
};
var RegisterFilesResponse = class {
  static {
    __name(this, "RegisterFilesResponse");
  }
};
var InlinedResponse = class {
  static {
    __name(this, "InlinedResponse");
  }
};
var SingleEmbedContentResponse = class {
  static {
    __name(this, "SingleEmbedContentResponse");
  }
};
var InlinedEmbedContentResponse = class {
  static {
    __name(this, "InlinedEmbedContentResponse");
  }
};
var ListBatchJobsResponse = class {
  static {
    __name(this, "ListBatchJobsResponse");
  }
};
var ReplayResponse = class {
  static {
    __name(this, "ReplayResponse");
  }
};
var RawReferenceImage = class {
  static {
    __name(this, "RawReferenceImage");
  }
  /** Internal method to convert to ReferenceImageAPIInternal. */
  toReferenceImageAPI() {
    const referenceImageAPI = {
      referenceType: "REFERENCE_TYPE_RAW",
      referenceImage: this.referenceImage,
      referenceId: this.referenceId
    };
    return referenceImageAPI;
  }
};
var MaskReferenceImage = class {
  static {
    __name(this, "MaskReferenceImage");
  }
  /** Internal method to convert to ReferenceImageAPIInternal. */
  toReferenceImageAPI() {
    const referenceImageAPI = {
      referenceType: "REFERENCE_TYPE_MASK",
      referenceImage: this.referenceImage,
      referenceId: this.referenceId,
      maskImageConfig: this.config
    };
    return referenceImageAPI;
  }
};
var ControlReferenceImage = class {
  static {
    __name(this, "ControlReferenceImage");
  }
  /** Internal method to convert to ReferenceImageAPIInternal. */
  toReferenceImageAPI() {
    const referenceImageAPI = {
      referenceType: "REFERENCE_TYPE_CONTROL",
      referenceImage: this.referenceImage,
      referenceId: this.referenceId,
      controlImageConfig: this.config
    };
    return referenceImageAPI;
  }
};
var StyleReferenceImage = class {
  static {
    __name(this, "StyleReferenceImage");
  }
  /** Internal method to convert to ReferenceImageAPIInternal. */
  toReferenceImageAPI() {
    const referenceImageAPI = {
      referenceType: "REFERENCE_TYPE_STYLE",
      referenceImage: this.referenceImage,
      referenceId: this.referenceId,
      styleImageConfig: this.config
    };
    return referenceImageAPI;
  }
};
var SubjectReferenceImage = class {
  static {
    __name(this, "SubjectReferenceImage");
  }
  /* Internal method to convert to ReferenceImageAPIInternal. */
  toReferenceImageAPI() {
    const referenceImageAPI = {
      referenceType: "REFERENCE_TYPE_SUBJECT",
      referenceImage: this.referenceImage,
      referenceId: this.referenceId,
      subjectImageConfig: this.config
    };
    return referenceImageAPI;
  }
};
var ContentReferenceImage = class {
  static {
    __name(this, "ContentReferenceImage");
  }
  /** Internal method to convert to ReferenceImageAPIInternal. */
  toReferenceImageAPI() {
    const referenceImageAPI = {
      referenceType: "REFERENCE_TYPE_CONTENT",
      referenceImage: this.referenceImage,
      referenceId: this.referenceId
    };
    return referenceImageAPI;
  }
};
var LiveServerMessage = class {
  static {
    __name(this, "LiveServerMessage");
  }
  /**
   * Returns the concatenation of all text parts from the server content if present.
   *
   * @remarks
   * If there are non-text parts in the response, the concatenation of all text
   * parts will be returned, and a warning will be logged.
   */
  get text() {
    var _a2, _b, _c;
    let text = "";
    let anyTextPartFound = false;
    const nonTextParts = [];
    for (const part of (_c = (_b = (_a2 = this.serverContent) === null || _a2 === void 0 ? void 0 : _a2.modelTurn) === null || _b === void 0 ? void 0 : _b.parts) !== null && _c !== void 0 ? _c : []) {
      for (const [fieldName, fieldValue] of Object.entries(part)) {
        if (fieldName !== "text" && fieldName !== "thought" && fieldValue !== null) {
          nonTextParts.push(fieldName);
        }
      }
      if (typeof part.text === "string") {
        if (typeof part.thought === "boolean" && part.thought) {
          continue;
        }
        anyTextPartFound = true;
        text += part.text;
      }
    }
    if (nonTextParts.length > 0) {
      console.warn(`there are non-text parts ${nonTextParts} in the response, returning concatenation of all text parts. Please refer to the non text parts for a full response from model.`);
    }
    return anyTextPartFound ? text : void 0;
  }
  /**
   * Returns the concatenation of all inline data parts from the server content if present.
   *
   * @remarks
   * If there are non-inline data parts in the
   * response, the concatenation of all inline data parts will be returned, and
   * a warning will be logged.
   */
  get data() {
    var _a2, _b, _c;
    let data = "";
    const nonDataParts = [];
    for (const part of (_c = (_b = (_a2 = this.serverContent) === null || _a2 === void 0 ? void 0 : _a2.modelTurn) === null || _b === void 0 ? void 0 : _b.parts) !== null && _c !== void 0 ? _c : []) {
      for (const [fieldName, fieldValue] of Object.entries(part)) {
        if (fieldName !== "inlineData" && fieldValue !== null) {
          nonDataParts.push(fieldName);
        }
      }
      if (part.inlineData && typeof part.inlineData.data === "string") {
        data += atob(part.inlineData.data);
      }
    }
    if (nonDataParts.length > 0) {
      console.warn(`there are non-data parts ${nonDataParts} in the response, returning concatenation of all data parts. Please refer to the non data parts for a full response from model.`);
    }
    return data.length > 0 ? btoa(data) : void 0;
  }
};
var LiveClientToolResponse = class {
  static {
    __name(this, "LiveClientToolResponse");
  }
};
var LiveSendToolResponseParameters = class {
  static {
    __name(this, "LiveSendToolResponseParameters");
  }
  constructor() {
    this.functionResponses = [];
  }
};
var LiveMusicServerMessage = class {
  static {
    __name(this, "LiveMusicServerMessage");
  }
  /**
   * Returns the first audio chunk from the server content, if present.
   *
   * @remarks
   * If there are no audio chunks in the response, undefined will be returned.
   */
  get audioChunk() {
    if (this.serverContent && this.serverContent.audioChunks && this.serverContent.audioChunks.length > 0) {
      return this.serverContent.audioChunks[0];
    }
    return void 0;
  }
};
var UploadToFileSearchStoreResponse = class {
  static {
    __name(this, "UploadToFileSearchStoreResponse");
  }
};
var UploadToFileSearchStoreOperation = class _UploadToFileSearchStoreOperation {
  static {
    __name(this, "UploadToFileSearchStoreOperation");
  }
  /**
   * Instantiates an Operation of the same type as the one being called with the fields set from the API response.
   */
  _fromAPIResponse({ apiResponse, _isVertexAI }) {
    const operation = new _UploadToFileSearchStoreOperation();
    const op = apiResponse;
    const response = uploadToFileSearchStoreOperationFromMldev(op);
    Object.assign(operation, response);
    return operation;
  }
};
function tModel(apiClient, model) {
  if (!model || typeof model !== "string") {
    throw new Error("model is required and must be a string");
  }
  if (model.includes("..") || model.includes("?") || model.includes("&")) {
    throw new Error("invalid model parameter");
  }
  if (apiClient.isVertexAI()) {
    if (model.startsWith("publishers/") || model.startsWith("projects/") || model.startsWith("models/")) {
      return model;
    } else if (model.indexOf("/") >= 0) {
      const parts = model.split("/", 2);
      return `publishers/${parts[0]}/models/${parts[1]}`;
    } else {
      return `publishers/google/models/${model}`;
    }
  } else {
    if (model.startsWith("models/") || model.startsWith("tunedModels/")) {
      return model;
    } else {
      return `models/${model}`;
    }
  }
}
__name(tModel, "tModel");
function tCachesModel(apiClient, model) {
  const transformedModel = tModel(apiClient, model);
  if (!transformedModel) {
    return "";
  }
  if (transformedModel.startsWith("publishers/") && apiClient.isVertexAI()) {
    return `projects/${apiClient.getProject()}/locations/${apiClient.getLocation()}/${transformedModel}`;
  } else if (transformedModel.startsWith("models/") && apiClient.isVertexAI()) {
    return `projects/${apiClient.getProject()}/locations/${apiClient.getLocation()}/publishers/google/${transformedModel}`;
  } else {
    return transformedModel;
  }
}
__name(tCachesModel, "tCachesModel");
function tBlobs(blobs) {
  if (Array.isArray(blobs)) {
    return blobs.map((blob) => tBlob(blob));
  } else {
    return [tBlob(blobs)];
  }
}
__name(tBlobs, "tBlobs");
function tBlob(blob) {
  if (typeof blob === "object" && blob !== null) {
    return blob;
  }
  throw new Error(`Could not parse input as Blob. Unsupported blob type: ${typeof blob}`);
}
__name(tBlob, "tBlob");
function tImageBlob(blob) {
  const transformedBlob = tBlob(blob);
  if (transformedBlob.mimeType && transformedBlob.mimeType.startsWith("image/")) {
    return transformedBlob;
  }
  throw new Error(`Unsupported mime type: ${transformedBlob.mimeType}`);
}
__name(tImageBlob, "tImageBlob");
function tAudioBlob(blob) {
  const transformedBlob = tBlob(blob);
  if (transformedBlob.mimeType && transformedBlob.mimeType.startsWith("audio/")) {
    return transformedBlob;
  }
  throw new Error(`Unsupported mime type: ${transformedBlob.mimeType}`);
}
__name(tAudioBlob, "tAudioBlob");
function tPart(origin) {
  if (origin === null || origin === void 0) {
    throw new Error("PartUnion is required");
  }
  if (typeof origin === "object") {
    return origin;
  }
  if (typeof origin === "string") {
    return { text: origin };
  }
  throw new Error(`Unsupported part type: ${typeof origin}`);
}
__name(tPart, "tPart");
function tParts(origin) {
  if (origin === null || origin === void 0 || Array.isArray(origin) && origin.length === 0) {
    throw new Error("PartListUnion is required");
  }
  if (Array.isArray(origin)) {
    return origin.map((item) => tPart(item));
  }
  return [tPart(origin)];
}
__name(tParts, "tParts");
function _isContent(origin) {
  return origin !== null && origin !== void 0 && typeof origin === "object" && "parts" in origin && Array.isArray(origin.parts);
}
__name(_isContent, "_isContent");
function _isFunctionCallPart(origin) {
  return origin !== null && origin !== void 0 && typeof origin === "object" && "functionCall" in origin;
}
__name(_isFunctionCallPart, "_isFunctionCallPart");
function _isFunctionResponsePart(origin) {
  return origin !== null && origin !== void 0 && typeof origin === "object" && "functionResponse" in origin;
}
__name(_isFunctionResponsePart, "_isFunctionResponsePart");
function tContent(origin) {
  if (origin === null || origin === void 0) {
    throw new Error("ContentUnion is required");
  }
  if (_isContent(origin)) {
    return origin;
  }
  return {
    role: "user",
    parts: tParts(origin)
  };
}
__name(tContent, "tContent");
function tContentsForEmbed(apiClient, origin) {
  if (!origin) {
    return [];
  }
  if (apiClient.isVertexAI() && Array.isArray(origin)) {
    return origin.flatMap((item) => {
      const content = tContent(item);
      if (content.parts && content.parts.length > 0 && content.parts[0].text !== void 0) {
        return [content.parts[0].text];
      }
      return [];
    });
  } else if (apiClient.isVertexAI()) {
    const content = tContent(origin);
    if (content.parts && content.parts.length > 0 && content.parts[0].text !== void 0) {
      return [content.parts[0].text];
    }
    return [];
  }
  if (Array.isArray(origin)) {
    return origin.map((item) => tContent(item));
  }
  return [tContent(origin)];
}
__name(tContentsForEmbed, "tContentsForEmbed");
function tContents(origin) {
  if (origin === null || origin === void 0 || Array.isArray(origin) && origin.length === 0) {
    throw new Error("contents are required");
  }
  if (!Array.isArray(origin)) {
    if (_isFunctionCallPart(origin) || _isFunctionResponsePart(origin)) {
      throw new Error("To specify functionCall or functionResponse parts, please wrap them in a Content object, specifying the role for them");
    }
    return [tContent(origin)];
  }
  const result = [];
  const accumulatedParts = [];
  const isContentArray = _isContent(origin[0]);
  for (const item of origin) {
    const isContent = _isContent(item);
    if (isContent != isContentArray) {
      throw new Error("Mixing Content and Parts is not supported, please group the parts into a the appropriate Content objects and specify the roles for them");
    }
    if (isContent) {
      result.push(item);
    } else if (_isFunctionCallPart(item) || _isFunctionResponsePart(item)) {
      throw new Error("To specify functionCall or functionResponse parts, please wrap them, and any other parts, in Content objects as appropriate, specifying the role for them");
    } else {
      accumulatedParts.push(item);
    }
  }
  if (!isContentArray) {
    result.push({ role: "user", parts: tParts(accumulatedParts) });
  }
  return result;
}
__name(tContents, "tContents");
function flattenTypeArrayToAnyOf(typeList, resultingSchema) {
  if (typeList.includes("null")) {
    resultingSchema["nullable"] = true;
  }
  const listWithoutNull = typeList.filter((type) => type !== "null");
  if (listWithoutNull.length === 1) {
    resultingSchema["type"] = Object.values(Type).includes(listWithoutNull[0].toUpperCase()) ? listWithoutNull[0].toUpperCase() : Type.TYPE_UNSPECIFIED;
  } else {
    resultingSchema["anyOf"] = [];
    for (const i of listWithoutNull) {
      resultingSchema["anyOf"].push({
        "type": Object.values(Type).includes(i.toUpperCase()) ? i.toUpperCase() : Type.TYPE_UNSPECIFIED
      });
    }
  }
}
__name(flattenTypeArrayToAnyOf, "flattenTypeArrayToAnyOf");
function processJsonSchema(_jsonSchema) {
  const genAISchema = {};
  const schemaFieldNames = ["items"];
  const listSchemaFieldNames = ["anyOf"];
  const dictSchemaFieldNames = ["properties"];
  if (_jsonSchema["type"] && _jsonSchema["anyOf"]) {
    throw new Error("type and anyOf cannot be both populated.");
  }
  const incomingAnyOf = _jsonSchema["anyOf"];
  if (incomingAnyOf != null && incomingAnyOf.length == 2) {
    if (incomingAnyOf[0]["type"] === "null") {
      genAISchema["nullable"] = true;
      _jsonSchema = incomingAnyOf[1];
    } else if (incomingAnyOf[1]["type"] === "null") {
      genAISchema["nullable"] = true;
      _jsonSchema = incomingAnyOf[0];
    }
  }
  if (_jsonSchema["type"] instanceof Array) {
    flattenTypeArrayToAnyOf(_jsonSchema["type"], genAISchema);
  }
  for (const [fieldName, fieldValue] of Object.entries(_jsonSchema)) {
    if (fieldValue == null) {
      continue;
    }
    if (fieldName == "type") {
      if (fieldValue === "null") {
        throw new Error("type: null can not be the only possible type for the field.");
      }
      if (fieldValue instanceof Array) {
        continue;
      }
      genAISchema["type"] = Object.values(Type).includes(fieldValue.toUpperCase()) ? fieldValue.toUpperCase() : Type.TYPE_UNSPECIFIED;
    } else if (schemaFieldNames.includes(fieldName)) {
      genAISchema[fieldName] = processJsonSchema(fieldValue);
    } else if (listSchemaFieldNames.includes(fieldName)) {
      const listSchemaFieldValue = [];
      for (const item of fieldValue) {
        if (item["type"] == "null") {
          genAISchema["nullable"] = true;
          continue;
        }
        listSchemaFieldValue.push(processJsonSchema(item));
      }
      genAISchema[fieldName] = listSchemaFieldValue;
    } else if (dictSchemaFieldNames.includes(fieldName)) {
      const dictSchemaFieldValue = {};
      for (const [key, value] of Object.entries(fieldValue)) {
        dictSchemaFieldValue[key] = processJsonSchema(value);
      }
      genAISchema[fieldName] = dictSchemaFieldValue;
    } else {
      if (fieldName === "additionalProperties") {
        continue;
      }
      genAISchema[fieldName] = fieldValue;
    }
  }
  return genAISchema;
}
__name(processJsonSchema, "processJsonSchema");
function tSchema(schema) {
  return processJsonSchema(schema);
}
__name(tSchema, "tSchema");
function tSpeechConfig(speechConfig) {
  if (typeof speechConfig === "object") {
    return speechConfig;
  } else if (typeof speechConfig === "string") {
    return {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: speechConfig
        }
      }
    };
  } else {
    throw new Error(`Unsupported speechConfig type: ${typeof speechConfig}`);
  }
}
__name(tSpeechConfig, "tSpeechConfig");
function tLiveSpeechConfig(speechConfig) {
  if ("multiSpeakerVoiceConfig" in speechConfig) {
    throw new Error("multiSpeakerVoiceConfig is not supported in the live API.");
  }
  return speechConfig;
}
__name(tLiveSpeechConfig, "tLiveSpeechConfig");
function tTool(tool) {
  if (tool.functionDeclarations) {
    for (const functionDeclaration of tool.functionDeclarations) {
      if (functionDeclaration.parameters) {
        if (!Object.keys(functionDeclaration.parameters).includes("$schema")) {
          functionDeclaration.parameters = processJsonSchema(functionDeclaration.parameters);
        } else {
          if (!functionDeclaration.parametersJsonSchema) {
            functionDeclaration.parametersJsonSchema = functionDeclaration.parameters;
            delete functionDeclaration.parameters;
          }
        }
      }
      if (functionDeclaration.response) {
        if (!Object.keys(functionDeclaration.response).includes("$schema")) {
          functionDeclaration.response = processJsonSchema(functionDeclaration.response);
        } else {
          if (!functionDeclaration.responseJsonSchema) {
            functionDeclaration.responseJsonSchema = functionDeclaration.response;
            delete functionDeclaration.response;
          }
        }
      }
    }
  }
  return tool;
}
__name(tTool, "tTool");
function tTools(tools) {
  if (tools === void 0 || tools === null) {
    throw new Error("tools is required");
  }
  if (!Array.isArray(tools)) {
    throw new Error("tools is required and must be an array of Tools");
  }
  const result = [];
  for (const tool of tools) {
    result.push(tool);
  }
  return result;
}
__name(tTools, "tTools");
function resourceName(client, resourceName2, resourcePrefix, splitsAfterPrefix = 1) {
  const shouldAppendPrefix = !resourceName2.startsWith(`${resourcePrefix}/`) && resourceName2.split("/").length === splitsAfterPrefix;
  if (client.isVertexAI()) {
    if (resourceName2.startsWith("projects/")) {
      return resourceName2;
    } else if (resourceName2.startsWith("locations/")) {
      return `projects/${client.getProject()}/${resourceName2}`;
    } else if (resourceName2.startsWith(`${resourcePrefix}/`)) {
      return `projects/${client.getProject()}/locations/${client.getLocation()}/${resourceName2}`;
    } else if (shouldAppendPrefix) {
      return `projects/${client.getProject()}/locations/${client.getLocation()}/${resourcePrefix}/${resourceName2}`;
    } else {
      return resourceName2;
    }
  }
  if (shouldAppendPrefix) {
    return `${resourcePrefix}/${resourceName2}`;
  }
  return resourceName2;
}
__name(resourceName, "resourceName");
function tCachedContentName(apiClient, name) {
  if (typeof name !== "string") {
    throw new Error("name must be a string");
  }
  return resourceName(apiClient, name, "cachedContents");
}
__name(tCachedContentName, "tCachedContentName");
function tTuningJobStatus(status) {
  switch (status) {
    case "STATE_UNSPECIFIED":
      return "JOB_STATE_UNSPECIFIED";
    case "CREATING":
      return "JOB_STATE_RUNNING";
    case "ACTIVE":
      return "JOB_STATE_SUCCEEDED";
    case "FAILED":
      return "JOB_STATE_FAILED";
    default:
      return status;
  }
}
__name(tTuningJobStatus, "tTuningJobStatus");
function tBytes(fromImageBytes) {
  return tBytes$1(fromImageBytes);
}
__name(tBytes, "tBytes");
function _isFile(origin) {
  return origin !== null && origin !== void 0 && typeof origin === "object" && "name" in origin;
}
__name(_isFile, "_isFile");
function isGeneratedVideo(origin) {
  return origin !== null && origin !== void 0 && typeof origin === "object" && "video" in origin;
}
__name(isGeneratedVideo, "isGeneratedVideo");
function isVideo(origin) {
  return origin !== null && origin !== void 0 && typeof origin === "object" && "uri" in origin;
}
__name(isVideo, "isVideo");
function tFileName(fromName) {
  var _a2;
  let name;
  if (_isFile(fromName)) {
    name = fromName.name;
  }
  if (isVideo(fromName)) {
    name = fromName.uri;
    if (name === void 0) {
      return void 0;
    }
  }
  if (isGeneratedVideo(fromName)) {
    name = (_a2 = fromName.video) === null || _a2 === void 0 ? void 0 : _a2.uri;
    if (name === void 0) {
      return void 0;
    }
  }
  if (typeof fromName === "string") {
    name = fromName;
  }
  if (name === void 0) {
    throw new Error("Could not extract file name from the provided input.");
  }
  if (name.startsWith("https://")) {
    const suffix = name.split("files/")[1];
    const match = suffix.match(/[a-z0-9]+/);
    if (match === null) {
      throw new Error(`Could not extract file name from URI ${name}`);
    }
    name = match[0];
  } else if (name.startsWith("files/")) {
    name = name.split("files/")[1];
  }
  return name;
}
__name(tFileName, "tFileName");
function tModelsUrl(apiClient, baseModels) {
  let res;
  if (apiClient.isVertexAI()) {
    res = baseModels ? "publishers/google/models" : "models";
  } else {
    res = baseModels ? "models" : "tunedModels";
  }
  return res;
}
__name(tModelsUrl, "tModelsUrl");
function tExtractModels(response) {
  for (const key of ["models", "tunedModels", "publisherModels"]) {
    if (hasField(response, key)) {
      return response[key];
    }
  }
  return [];
}
__name(tExtractModels, "tExtractModels");
function hasField(data, fieldName) {
  return data !== null && typeof data === "object" && fieldName in data;
}
__name(hasField, "hasField");
function mcpToGeminiTool(mcpTool, config = {}) {
  const mcpToolSchema = mcpTool;
  const functionDeclaration = {
    name: mcpToolSchema["name"],
    description: mcpToolSchema["description"],
    parametersJsonSchema: mcpToolSchema["inputSchema"]
  };
  if (mcpToolSchema["outputSchema"]) {
    functionDeclaration["responseJsonSchema"] = mcpToolSchema["outputSchema"];
  }
  if (config.behavior) {
    functionDeclaration["behavior"] = config.behavior;
  }
  const geminiTool = {
    functionDeclarations: [
      functionDeclaration
    ]
  };
  return geminiTool;
}
__name(mcpToGeminiTool, "mcpToGeminiTool");
function mcpToolsToGeminiTool(mcpTools, config = {}) {
  const functionDeclarations = [];
  const toolNames = /* @__PURE__ */ new Set();
  for (const mcpTool of mcpTools) {
    const mcpToolName = mcpTool.name;
    if (toolNames.has(mcpToolName)) {
      throw new Error(`Duplicate function name ${mcpToolName} found in MCP tools. Please ensure function names are unique.`);
    }
    toolNames.add(mcpToolName);
    const geminiTool = mcpToGeminiTool(mcpTool, config);
    if (geminiTool.functionDeclarations) {
      functionDeclarations.push(...geminiTool.functionDeclarations);
    }
  }
  return { functionDeclarations };
}
__name(mcpToolsToGeminiTool, "mcpToolsToGeminiTool");
function tBatchJobSource(client, src) {
  let sourceObj;
  if (typeof src === "string") {
    if (client.isVertexAI()) {
      if (src.startsWith("gs://")) {
        sourceObj = { format: "jsonl", gcsUri: [src] };
      } else if (src.startsWith("bq://")) {
        sourceObj = { format: "bigquery", bigqueryUri: src };
      } else if (/^projects\/[^/]+\/locations\/[^/]+\/datasets\/[^/]+$/.test(src)) {
        sourceObj = { format: "vertex-dataset", vertexDatasetName: src };
      } else {
        throw new Error(`Unsupported string source for Vertex AI: ${src}`);
      }
    } else {
      if (src.startsWith("files/")) {
        sourceObj = { fileName: src };
      } else {
        throw new Error(`Unsupported string source for Gemini API: ${src}`);
      }
    }
  } else if (Array.isArray(src)) {
    if (client.isVertexAI()) {
      throw new Error("InlinedRequest[] is not supported in Vertex AI.");
    }
    sourceObj = { inlinedRequests: src };
  } else {
    sourceObj = src;
  }
  const vertexSourcesCount = [
    sourceObj.gcsUri,
    sourceObj.bigqueryUri,
    sourceObj.vertexDatasetName
  ].filter(Boolean).length;
  const mldevSourcesCount = [
    sourceObj.inlinedRequests,
    sourceObj.fileName
  ].filter(Boolean).length;
  if (client.isVertexAI()) {
    if (mldevSourcesCount > 0 || vertexSourcesCount !== 1) {
      throw new Error("Exactly one of `gcsUri`, `bigqueryUri`, or `vertexDatasetName` must be set for Vertex AI.");
    }
  } else {
    if (vertexSourcesCount > 0 || mldevSourcesCount !== 1) {
      throw new Error("Exactly one of `inlinedRequests`, `fileName`, must be set for Gemini API.");
    }
  }
  return sourceObj;
}
__name(tBatchJobSource, "tBatchJobSource");
function tBatchJobDestination(dest) {
  if (typeof dest !== "string") {
    return dest;
  }
  const destString = dest;
  if (destString.startsWith("gs://")) {
    return {
      format: "jsonl",
      gcsUri: destString
    };
  } else if (destString.startsWith("bq://")) {
    return {
      format: "bigquery",
      bigqueryUri: destString
    };
  } else {
    throw new Error(`Unsupported destination: ${destString}`);
  }
}
__name(tBatchJobDestination, "tBatchJobDestination");
function tRecvBatchJobDestination(dest) {
  if (typeof dest !== "object" || dest === null) {
    return {};
  }
  const obj = dest;
  const inlineResponsesVal = obj["inlinedResponses"];
  if (typeof inlineResponsesVal !== "object" || inlineResponsesVal === null) {
    return dest;
  }
  const inlineResponsesObj = inlineResponsesVal;
  const responsesArray = inlineResponsesObj["inlinedResponses"];
  if (!Array.isArray(responsesArray) || responsesArray.length === 0) {
    return dest;
  }
  let hasEmbedding = false;
  for (const responseItem of responsesArray) {
    if (typeof responseItem !== "object" || responseItem === null) {
      continue;
    }
    const responseItemObj = responseItem;
    const responseVal = responseItemObj["response"];
    if (typeof responseVal !== "object" || responseVal === null) {
      continue;
    }
    const responseObj = responseVal;
    if (responseObj["embedding"] !== void 0) {
      hasEmbedding = true;
      break;
    }
  }
  if (hasEmbedding) {
    obj["inlinedEmbedContentResponses"] = obj["inlinedResponses"];
    delete obj["inlinedResponses"];
  }
  return dest;
}
__name(tRecvBatchJobDestination, "tRecvBatchJobDestination");
function tBatchJobName(apiClient, name) {
  const nameString = name;
  if (!apiClient.isVertexAI()) {
    const mldevPattern = /batches\/[^/]+$/;
    if (mldevPattern.test(nameString)) {
      return nameString.split("/").pop();
    } else {
      throw new Error(`Invalid batch job name: ${nameString}.`);
    }
  }
  const vertexPattern = /^projects\/[^/]+\/locations\/[^/]+\/batchPredictionJobs\/[^/]+$/;
  if (vertexPattern.test(nameString)) {
    return nameString.split("/").pop();
  } else if (/^\d+$/.test(nameString)) {
    return nameString;
  } else {
    throw new Error(`Invalid batch job name: ${nameString}.`);
  }
}
__name(tBatchJobName, "tBatchJobName");
function tJobState(state) {
  const stateString = state;
  if (stateString === "BATCH_STATE_UNSPECIFIED") {
    return "JOB_STATE_UNSPECIFIED";
  } else if (stateString === "BATCH_STATE_PENDING") {
    return "JOB_STATE_PENDING";
  } else if (stateString === "BATCH_STATE_RUNNING") {
    return "JOB_STATE_RUNNING";
  } else if (stateString === "BATCH_STATE_SUCCEEDED") {
    return "JOB_STATE_SUCCEEDED";
  } else if (stateString === "BATCH_STATE_FAILED") {
    return "JOB_STATE_FAILED";
  } else if (stateString === "BATCH_STATE_CANCELLED") {
    return "JOB_STATE_CANCELLED";
  } else if (stateString === "BATCH_STATE_EXPIRED") {
    return "JOB_STATE_EXPIRED";
  } else {
    return stateString;
  }
}
__name(tJobState, "tJobState");
function tIsVertexEmbedContentModel(model) {
  return model.includes("gemini") && model !== "gemini-embedding-001" || model.includes("maas");
}
__name(tIsVertexEmbedContentModel, "tIsVertexEmbedContentModel");
function authConfigToMldev$4(fromObject) {
  const toObject = {};
  const fromApiKey = getValueByPath(fromObject, ["apiKey"]);
  if (fromApiKey != null) {
    setValueByPath(toObject, ["apiKey"], fromApiKey);
  }
  if (getValueByPath(fromObject, ["apiKeyConfig"]) !== void 0) {
    throw new Error("apiKeyConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["authType"]) !== void 0) {
    throw new Error("authType parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["googleServiceAccountConfig"]) !== void 0) {
    throw new Error("googleServiceAccountConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["httpBasicAuthConfig"]) !== void 0) {
    throw new Error("httpBasicAuthConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["oauthConfig"]) !== void 0) {
    throw new Error("oauthConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["oidcConfig"]) !== void 0) {
    throw new Error("oidcConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(authConfigToMldev$4, "authConfigToMldev$4");
function batchJobDestinationFromMldev(fromObject) {
  const toObject = {};
  const fromFileName = getValueByPath(fromObject, ["responsesFile"]);
  if (fromFileName != null) {
    setValueByPath(toObject, ["fileName"], fromFileName);
  }
  const fromInlinedResponses = getValueByPath(fromObject, [
    "inlinedResponses",
    "inlinedResponses"
  ]);
  if (fromInlinedResponses != null) {
    let transformedList = fromInlinedResponses;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return inlinedResponseFromMldev(item);
      });
    }
    setValueByPath(toObject, ["inlinedResponses"], transformedList);
  }
  const fromInlinedEmbedContentResponses = getValueByPath(fromObject, [
    "inlinedEmbedContentResponses",
    "inlinedResponses"
  ]);
  if (fromInlinedEmbedContentResponses != null) {
    let transformedList = fromInlinedEmbedContentResponses;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["inlinedEmbedContentResponses"], transformedList);
  }
  return toObject;
}
__name(batchJobDestinationFromMldev, "batchJobDestinationFromMldev");
function batchJobDestinationFromVertex(fromObject) {
  const toObject = {};
  const fromFormat = getValueByPath(fromObject, ["predictionsFormat"]);
  if (fromFormat != null) {
    setValueByPath(toObject, ["format"], fromFormat);
  }
  const fromGcsUri = getValueByPath(fromObject, [
    "gcsDestination",
    "outputUriPrefix"
  ]);
  if (fromGcsUri != null) {
    setValueByPath(toObject, ["gcsUri"], fromGcsUri);
  }
  const fromBigqueryUri = getValueByPath(fromObject, [
    "bigqueryDestination",
    "outputUri"
  ]);
  if (fromBigqueryUri != null) {
    setValueByPath(toObject, ["bigqueryUri"], fromBigqueryUri);
  }
  const fromVertexDataset = getValueByPath(fromObject, [
    "vertexMultimodalDatasetDestination"
  ]);
  if (fromVertexDataset != null) {
    setValueByPath(toObject, ["vertexDataset"], vertexMultimodalDatasetDestinationFromVertex(fromVertexDataset));
  }
  return toObject;
}
__name(batchJobDestinationFromVertex, "batchJobDestinationFromVertex");
function batchJobDestinationToVertex(fromObject) {
  const toObject = {};
  const fromFormat = getValueByPath(fromObject, ["format"]);
  if (fromFormat != null) {
    setValueByPath(toObject, ["predictionsFormat"], fromFormat);
  }
  const fromGcsUri = getValueByPath(fromObject, ["gcsUri"]);
  if (fromGcsUri != null) {
    setValueByPath(toObject, ["gcsDestination", "outputUriPrefix"], fromGcsUri);
  }
  const fromBigqueryUri = getValueByPath(fromObject, ["bigqueryUri"]);
  if (fromBigqueryUri != null) {
    setValueByPath(toObject, ["bigqueryDestination", "outputUri"], fromBigqueryUri);
  }
  if (getValueByPath(fromObject, ["fileName"]) !== void 0) {
    throw new Error("fileName parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  if (getValueByPath(fromObject, ["inlinedResponses"]) !== void 0) {
    throw new Error("inlinedResponses parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  if (getValueByPath(fromObject, ["inlinedEmbedContentResponses"]) !== void 0) {
    throw new Error("inlinedEmbedContentResponses parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  const fromVertexDataset = getValueByPath(fromObject, [
    "vertexDataset"
  ]);
  if (fromVertexDataset != null) {
    setValueByPath(toObject, ["vertexMultimodalDatasetDestination"], vertexMultimodalDatasetDestinationToVertex(fromVertexDataset));
  }
  return toObject;
}
__name(batchJobDestinationToVertex, "batchJobDestinationToVertex");
function batchJobFromMldev(fromObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["name"], fromName);
  }
  const fromDisplayName = getValueByPath(fromObject, [
    "metadata",
    "displayName"
  ]);
  if (fromDisplayName != null) {
    setValueByPath(toObject, ["displayName"], fromDisplayName);
  }
  const fromState = getValueByPath(fromObject, ["metadata", "state"]);
  if (fromState != null) {
    setValueByPath(toObject, ["state"], tJobState(fromState));
  }
  const fromCreateTime = getValueByPath(fromObject, [
    "metadata",
    "createTime"
  ]);
  if (fromCreateTime != null) {
    setValueByPath(toObject, ["createTime"], fromCreateTime);
  }
  const fromEndTime = getValueByPath(fromObject, [
    "metadata",
    "endTime"
  ]);
  if (fromEndTime != null) {
    setValueByPath(toObject, ["endTime"], fromEndTime);
  }
  const fromUpdateTime = getValueByPath(fromObject, [
    "metadata",
    "updateTime"
  ]);
  if (fromUpdateTime != null) {
    setValueByPath(toObject, ["updateTime"], fromUpdateTime);
  }
  const fromModel = getValueByPath(fromObject, ["metadata", "model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["model"], fromModel);
  }
  const fromDest = getValueByPath(fromObject, ["metadata", "output"]);
  if (fromDest != null) {
    setValueByPath(toObject, ["dest"], batchJobDestinationFromMldev(tRecvBatchJobDestination(fromDest)));
  }
  return toObject;
}
__name(batchJobFromMldev, "batchJobFromMldev");
function batchJobFromVertex(fromObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["name"], fromName);
  }
  const fromDisplayName = getValueByPath(fromObject, ["displayName"]);
  if (fromDisplayName != null) {
    setValueByPath(toObject, ["displayName"], fromDisplayName);
  }
  const fromState = getValueByPath(fromObject, ["state"]);
  if (fromState != null) {
    setValueByPath(toObject, ["state"], tJobState(fromState));
  }
  const fromError = getValueByPath(fromObject, ["error"]);
  if (fromError != null) {
    setValueByPath(toObject, ["error"], fromError);
  }
  const fromCreateTime = getValueByPath(fromObject, ["createTime"]);
  if (fromCreateTime != null) {
    setValueByPath(toObject, ["createTime"], fromCreateTime);
  }
  const fromStartTime = getValueByPath(fromObject, ["startTime"]);
  if (fromStartTime != null) {
    setValueByPath(toObject, ["startTime"], fromStartTime);
  }
  const fromEndTime = getValueByPath(fromObject, ["endTime"]);
  if (fromEndTime != null) {
    setValueByPath(toObject, ["endTime"], fromEndTime);
  }
  const fromUpdateTime = getValueByPath(fromObject, ["updateTime"]);
  if (fromUpdateTime != null) {
    setValueByPath(toObject, ["updateTime"], fromUpdateTime);
  }
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["model"], fromModel);
  }
  const fromSrc = getValueByPath(fromObject, ["inputConfig"]);
  if (fromSrc != null) {
    setValueByPath(toObject, ["src"], batchJobSourceFromVertex(fromSrc));
  }
  const fromDest = getValueByPath(fromObject, ["outputConfig"]);
  if (fromDest != null) {
    setValueByPath(toObject, ["dest"], batchJobDestinationFromVertex(tRecvBatchJobDestination(fromDest)));
  }
  const fromCompletionStats = getValueByPath(fromObject, [
    "completionStats"
  ]);
  if (fromCompletionStats != null) {
    setValueByPath(toObject, ["completionStats"], fromCompletionStats);
  }
  const fromOutputInfo = getValueByPath(fromObject, ["outputInfo"]);
  if (fromOutputInfo != null) {
    setValueByPath(toObject, ["outputInfo"], fromOutputInfo);
  }
  return toObject;
}
__name(batchJobFromVertex, "batchJobFromVertex");
function batchJobSourceFromVertex(fromObject) {
  const toObject = {};
  const fromFormat = getValueByPath(fromObject, ["instancesFormat"]);
  if (fromFormat != null) {
    setValueByPath(toObject, ["format"], fromFormat);
  }
  const fromGcsUri = getValueByPath(fromObject, ["gcsSource", "uris"]);
  if (fromGcsUri != null) {
    setValueByPath(toObject, ["gcsUri"], fromGcsUri);
  }
  const fromBigqueryUri = getValueByPath(fromObject, [
    "bigquerySource",
    "inputUri"
  ]);
  if (fromBigqueryUri != null) {
    setValueByPath(toObject, ["bigqueryUri"], fromBigqueryUri);
  }
  const fromVertexDatasetName = getValueByPath(fromObject, [
    "vertexMultimodalDatasetSource",
    "datasetName"
  ]);
  if (fromVertexDatasetName != null) {
    setValueByPath(toObject, ["vertexDatasetName"], fromVertexDatasetName);
  }
  return toObject;
}
__name(batchJobSourceFromVertex, "batchJobSourceFromVertex");
function batchJobSourceToMldev(apiClient, fromObject) {
  const toObject = {};
  if (getValueByPath(fromObject, ["format"]) !== void 0) {
    throw new Error("format parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["gcsUri"]) !== void 0) {
    throw new Error("gcsUri parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["bigqueryUri"]) !== void 0) {
    throw new Error("bigqueryUri parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromFileName = getValueByPath(fromObject, ["fileName"]);
  if (fromFileName != null) {
    setValueByPath(toObject, ["fileName"], fromFileName);
  }
  const fromInlinedRequests = getValueByPath(fromObject, [
    "inlinedRequests"
  ]);
  if (fromInlinedRequests != null) {
    let transformedList = fromInlinedRequests;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return inlinedRequestToMldev(apiClient, item);
      });
    }
    setValueByPath(toObject, ["requests", "requests"], transformedList);
  }
  if (getValueByPath(fromObject, ["vertexDatasetName"]) !== void 0) {
    throw new Error("vertexDatasetName parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(batchJobSourceToMldev, "batchJobSourceToMldev");
function batchJobSourceToVertex(fromObject) {
  const toObject = {};
  const fromFormat = getValueByPath(fromObject, ["format"]);
  if (fromFormat != null) {
    setValueByPath(toObject, ["instancesFormat"], fromFormat);
  }
  const fromGcsUri = getValueByPath(fromObject, ["gcsUri"]);
  if (fromGcsUri != null) {
    setValueByPath(toObject, ["gcsSource", "uris"], fromGcsUri);
  }
  const fromBigqueryUri = getValueByPath(fromObject, ["bigqueryUri"]);
  if (fromBigqueryUri != null) {
    setValueByPath(toObject, ["bigquerySource", "inputUri"], fromBigqueryUri);
  }
  if (getValueByPath(fromObject, ["fileName"]) !== void 0) {
    throw new Error("fileName parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  if (getValueByPath(fromObject, ["inlinedRequests"]) !== void 0) {
    throw new Error("inlinedRequests parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  const fromVertexDatasetName = getValueByPath(fromObject, [
    "vertexDatasetName"
  ]);
  if (fromVertexDatasetName != null) {
    setValueByPath(toObject, ["vertexMultimodalDatasetSource", "datasetName"], fromVertexDatasetName);
  }
  return toObject;
}
__name(batchJobSourceToVertex, "batchJobSourceToVertex");
function blobToMldev$4(fromObject) {
  const toObject = {};
  const fromData = getValueByPath(fromObject, ["data"]);
  if (fromData != null) {
    setValueByPath(toObject, ["data"], fromData);
  }
  if (getValueByPath(fromObject, ["displayName"]) !== void 0) {
    throw new Error("displayName parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromMimeType = getValueByPath(fromObject, ["mimeType"]);
  if (fromMimeType != null) {
    setValueByPath(toObject, ["mimeType"], fromMimeType);
  }
  return toObject;
}
__name(blobToMldev$4, "blobToMldev$4");
function cancelBatchJobParametersToMldev(apiClient, fromObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["_url", "name"], tBatchJobName(apiClient, fromName));
  }
  return toObject;
}
__name(cancelBatchJobParametersToMldev, "cancelBatchJobParametersToMldev");
function cancelBatchJobParametersToVertex(apiClient, fromObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["_url", "name"], tBatchJobName(apiClient, fromName));
  }
  return toObject;
}
__name(cancelBatchJobParametersToVertex, "cancelBatchJobParametersToVertex");
function candidateFromMldev$1(fromObject) {
  const toObject = {};
  const fromContent = getValueByPath(fromObject, ["content"]);
  if (fromContent != null) {
    setValueByPath(toObject, ["content"], fromContent);
  }
  const fromCitationMetadata = getValueByPath(fromObject, [
    "citationMetadata"
  ]);
  if (fromCitationMetadata != null) {
    setValueByPath(toObject, ["citationMetadata"], citationMetadataFromMldev$1(fromCitationMetadata));
  }
  const fromTokenCount = getValueByPath(fromObject, ["tokenCount"]);
  if (fromTokenCount != null) {
    setValueByPath(toObject, ["tokenCount"], fromTokenCount);
  }
  const fromFinishReason = getValueByPath(fromObject, ["finishReason"]);
  if (fromFinishReason != null) {
    setValueByPath(toObject, ["finishReason"], fromFinishReason);
  }
  const fromGroundingMetadata = getValueByPath(fromObject, [
    "groundingMetadata"
  ]);
  if (fromGroundingMetadata != null) {
    setValueByPath(toObject, ["groundingMetadata"], fromGroundingMetadata);
  }
  const fromAvgLogprobs = getValueByPath(fromObject, ["avgLogprobs"]);
  if (fromAvgLogprobs != null) {
    setValueByPath(toObject, ["avgLogprobs"], fromAvgLogprobs);
  }
  const fromIndex = getValueByPath(fromObject, ["index"]);
  if (fromIndex != null) {
    setValueByPath(toObject, ["index"], fromIndex);
  }
  const fromLogprobsResult = getValueByPath(fromObject, [
    "logprobsResult"
  ]);
  if (fromLogprobsResult != null) {
    setValueByPath(toObject, ["logprobsResult"], fromLogprobsResult);
  }
  const fromSafetyRatings = getValueByPath(fromObject, [
    "safetyRatings"
  ]);
  if (fromSafetyRatings != null) {
    let transformedList = fromSafetyRatings;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["safetyRatings"], transformedList);
  }
  const fromUrlContextMetadata = getValueByPath(fromObject, [
    "urlContextMetadata"
  ]);
  if (fromUrlContextMetadata != null) {
    setValueByPath(toObject, ["urlContextMetadata"], fromUrlContextMetadata);
  }
  return toObject;
}
__name(candidateFromMldev$1, "candidateFromMldev$1");
function citationMetadataFromMldev$1(fromObject) {
  const toObject = {};
  const fromCitations = getValueByPath(fromObject, ["citationSources"]);
  if (fromCitations != null) {
    let transformedList = fromCitations;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["citations"], transformedList);
  }
  return toObject;
}
__name(citationMetadataFromMldev$1, "citationMetadataFromMldev$1");
function contentToMldev$4(fromObject) {
  const toObject = {};
  const fromParts = getValueByPath(fromObject, ["parts"]);
  if (fromParts != null) {
    let transformedList = fromParts;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return partToMldev$4(item);
      });
    }
    setValueByPath(toObject, ["parts"], transformedList);
  }
  const fromRole = getValueByPath(fromObject, ["role"]);
  if (fromRole != null) {
    setValueByPath(toObject, ["role"], fromRole);
  }
  return toObject;
}
__name(contentToMldev$4, "contentToMldev$4");
function createBatchJobConfigToMldev(fromObject, parentObject) {
  const toObject = {};
  const fromDisplayName = getValueByPath(fromObject, ["displayName"]);
  if (parentObject !== void 0 && fromDisplayName != null) {
    setValueByPath(parentObject, ["batch", "displayName"], fromDisplayName);
  }
  if (getValueByPath(fromObject, ["dest"]) !== void 0) {
    throw new Error("dest parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromWebhookConfig = getValueByPath(fromObject, [
    "webhookConfig"
  ]);
  if (parentObject !== void 0 && fromWebhookConfig != null) {
    setValueByPath(parentObject, ["batch", "webhookConfig"], fromWebhookConfig);
  }
  return toObject;
}
__name(createBatchJobConfigToMldev, "createBatchJobConfigToMldev");
function createBatchJobConfigToVertex(fromObject, parentObject) {
  const toObject = {};
  const fromDisplayName = getValueByPath(fromObject, ["displayName"]);
  if (parentObject !== void 0 && fromDisplayName != null) {
    setValueByPath(parentObject, ["displayName"], fromDisplayName);
  }
  const fromDest = getValueByPath(fromObject, ["dest"]);
  if (parentObject !== void 0 && fromDest != null) {
    setValueByPath(parentObject, ["outputConfig"], batchJobDestinationToVertex(tBatchJobDestination(fromDest)));
  }
  if (getValueByPath(fromObject, ["webhookConfig"]) !== void 0) {
    throw new Error("webhookConfig parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  return toObject;
}
__name(createBatchJobConfigToVertex, "createBatchJobConfigToVertex");
function createBatchJobParametersToMldev(apiClient, fromObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["_url", "model"], tModel(apiClient, fromModel));
  }
  const fromSrc = getValueByPath(fromObject, ["src"]);
  if (fromSrc != null) {
    setValueByPath(toObject, ["batch", "inputConfig"], batchJobSourceToMldev(apiClient, tBatchJobSource(apiClient, fromSrc)));
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    createBatchJobConfigToMldev(fromConfig, toObject);
  }
  return toObject;
}
__name(createBatchJobParametersToMldev, "createBatchJobParametersToMldev");
function createBatchJobParametersToVertex(apiClient, fromObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["model"], tModel(apiClient, fromModel));
  }
  const fromSrc = getValueByPath(fromObject, ["src"]);
  if (fromSrc != null) {
    setValueByPath(toObject, ["inputConfig"], batchJobSourceToVertex(tBatchJobSource(apiClient, fromSrc)));
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    createBatchJobConfigToVertex(fromConfig, toObject);
  }
  return toObject;
}
__name(createBatchJobParametersToVertex, "createBatchJobParametersToVertex");
function createEmbeddingsBatchJobConfigToMldev(fromObject, parentObject) {
  const toObject = {};
  const fromDisplayName = getValueByPath(fromObject, ["displayName"]);
  if (parentObject !== void 0 && fromDisplayName != null) {
    setValueByPath(parentObject, ["batch", "displayName"], fromDisplayName);
  }
  return toObject;
}
__name(createEmbeddingsBatchJobConfigToMldev, "createEmbeddingsBatchJobConfigToMldev");
function createEmbeddingsBatchJobParametersToMldev(apiClient, fromObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["_url", "model"], tModel(apiClient, fromModel));
  }
  const fromSrc = getValueByPath(fromObject, ["src"]);
  if (fromSrc != null) {
    setValueByPath(toObject, ["batch", "inputConfig"], embeddingsBatchJobSourceToMldev(apiClient, fromSrc));
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    createEmbeddingsBatchJobConfigToMldev(fromConfig, toObject);
  }
  return toObject;
}
__name(createEmbeddingsBatchJobParametersToMldev, "createEmbeddingsBatchJobParametersToMldev");
function deleteBatchJobParametersToMldev(apiClient, fromObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["_url", "name"], tBatchJobName(apiClient, fromName));
  }
  return toObject;
}
__name(deleteBatchJobParametersToMldev, "deleteBatchJobParametersToMldev");
function deleteBatchJobParametersToVertex(apiClient, fromObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["_url", "name"], tBatchJobName(apiClient, fromName));
  }
  return toObject;
}
__name(deleteBatchJobParametersToVertex, "deleteBatchJobParametersToVertex");
function deleteResourceJobFromMldev(fromObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["name"], fromName);
  }
  const fromDone = getValueByPath(fromObject, ["done"]);
  if (fromDone != null) {
    setValueByPath(toObject, ["done"], fromDone);
  }
  const fromError = getValueByPath(fromObject, ["error"]);
  if (fromError != null) {
    setValueByPath(toObject, ["error"], fromError);
  }
  return toObject;
}
__name(deleteResourceJobFromMldev, "deleteResourceJobFromMldev");
function deleteResourceJobFromVertex(fromObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["name"], fromName);
  }
  const fromDone = getValueByPath(fromObject, ["done"]);
  if (fromDone != null) {
    setValueByPath(toObject, ["done"], fromDone);
  }
  const fromError = getValueByPath(fromObject, ["error"]);
  if (fromError != null) {
    setValueByPath(toObject, ["error"], fromError);
  }
  return toObject;
}
__name(deleteResourceJobFromVertex, "deleteResourceJobFromVertex");
function embedContentBatchToMldev(apiClient, fromObject) {
  const toObject = {};
  const fromContents = getValueByPath(fromObject, ["contents"]);
  if (fromContents != null) {
    let transformedList = tContentsForEmbed(apiClient, fromContents);
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["requests[]", "request", "content"], transformedList);
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    setValueByPath(toObject, ["_self"], embedContentConfigToMldev$1(fromConfig, toObject));
    moveValueByPath(toObject, { "requests[].*": "requests[].request.*" });
  }
  return toObject;
}
__name(embedContentBatchToMldev, "embedContentBatchToMldev");
function embedContentConfigToMldev$1(fromObject, parentObject) {
  const toObject = {};
  const fromTaskType = getValueByPath(fromObject, ["taskType"]);
  if (parentObject !== void 0 && fromTaskType != null) {
    setValueByPath(parentObject, ["requests[]", "taskType"], fromTaskType);
  }
  const fromTitle = getValueByPath(fromObject, ["title"]);
  if (parentObject !== void 0 && fromTitle != null) {
    setValueByPath(parentObject, ["requests[]", "title"], fromTitle);
  }
  const fromOutputDimensionality = getValueByPath(fromObject, [
    "outputDimensionality"
  ]);
  if (parentObject !== void 0 && fromOutputDimensionality != null) {
    setValueByPath(parentObject, ["requests[]", "outputDimensionality"], fromOutputDimensionality);
  }
  if (getValueByPath(fromObject, ["mimeType"]) !== void 0) {
    throw new Error("mimeType parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["autoTruncate"]) !== void 0) {
    throw new Error("autoTruncate parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["documentOcr"]) !== void 0) {
    throw new Error("documentOcr parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["audioTrackExtraction"]) !== void 0) {
    throw new Error("audioTrackExtraction parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(embedContentConfigToMldev$1, "embedContentConfigToMldev$1");
function embeddingsBatchJobSourceToMldev(apiClient, fromObject) {
  const toObject = {};
  const fromFileName = getValueByPath(fromObject, ["fileName"]);
  if (fromFileName != null) {
    setValueByPath(toObject, ["file_name"], fromFileName);
  }
  const fromInlinedRequests = getValueByPath(fromObject, [
    "inlinedRequests"
  ]);
  if (fromInlinedRequests != null) {
    setValueByPath(toObject, ["requests"], embedContentBatchToMldev(apiClient, fromInlinedRequests));
  }
  return toObject;
}
__name(embeddingsBatchJobSourceToMldev, "embeddingsBatchJobSourceToMldev");
function fileDataToMldev$4(fromObject) {
  const toObject = {};
  if (getValueByPath(fromObject, ["displayName"]) !== void 0) {
    throw new Error("displayName parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromFileUri = getValueByPath(fromObject, ["fileUri"]);
  if (fromFileUri != null) {
    setValueByPath(toObject, ["fileUri"], fromFileUri);
  }
  const fromMimeType = getValueByPath(fromObject, ["mimeType"]);
  if (fromMimeType != null) {
    setValueByPath(toObject, ["mimeType"], fromMimeType);
  }
  return toObject;
}
__name(fileDataToMldev$4, "fileDataToMldev$4");
function functionCallToMldev$4(fromObject) {
  const toObject = {};
  const fromId = getValueByPath(fromObject, ["id"]);
  if (fromId != null) {
    setValueByPath(toObject, ["id"], fromId);
  }
  const fromArgs = getValueByPath(fromObject, ["args"]);
  if (fromArgs != null) {
    setValueByPath(toObject, ["args"], fromArgs);
  }
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["name"], fromName);
  }
  if (getValueByPath(fromObject, ["partialArgs"]) !== void 0) {
    throw new Error("partialArgs parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["willContinue"]) !== void 0) {
    throw new Error("willContinue parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(functionCallToMldev$4, "functionCallToMldev$4");
function functionCallingConfigToMldev$2(fromObject) {
  const toObject = {};
  const fromAllowedFunctionNames = getValueByPath(fromObject, [
    "allowedFunctionNames"
  ]);
  if (fromAllowedFunctionNames != null) {
    setValueByPath(toObject, ["allowedFunctionNames"], fromAllowedFunctionNames);
  }
  const fromMode = getValueByPath(fromObject, ["mode"]);
  if (fromMode != null) {
    setValueByPath(toObject, ["mode"], fromMode);
  }
  if (getValueByPath(fromObject, ["streamFunctionCallArguments"]) !== void 0) {
    throw new Error("streamFunctionCallArguments parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(functionCallingConfigToMldev$2, "functionCallingConfigToMldev$2");
function generateContentConfigToMldev$1(apiClient, fromObject, parentObject) {
  const toObject = {};
  const fromSystemInstruction = getValueByPath(fromObject, [
    "systemInstruction"
  ]);
  if (parentObject !== void 0 && fromSystemInstruction != null) {
    setValueByPath(parentObject, ["systemInstruction"], contentToMldev$4(tContent(fromSystemInstruction)));
  }
  const fromTemperature = getValueByPath(fromObject, ["temperature"]);
  if (fromTemperature != null) {
    setValueByPath(toObject, ["temperature"], fromTemperature);
  }
  const fromTopP = getValueByPath(fromObject, ["topP"]);
  if (fromTopP != null) {
    setValueByPath(toObject, ["topP"], fromTopP);
  }
  const fromTopK = getValueByPath(fromObject, ["topK"]);
  if (fromTopK != null) {
    setValueByPath(toObject, ["topK"], fromTopK);
  }
  const fromCandidateCount = getValueByPath(fromObject, [
    "candidateCount"
  ]);
  if (fromCandidateCount != null) {
    setValueByPath(toObject, ["candidateCount"], fromCandidateCount);
  }
  const fromMaxOutputTokens = getValueByPath(fromObject, [
    "maxOutputTokens"
  ]);
  if (fromMaxOutputTokens != null) {
    setValueByPath(toObject, ["maxOutputTokens"], fromMaxOutputTokens);
  }
  const fromStopSequences = getValueByPath(fromObject, [
    "stopSequences"
  ]);
  if (fromStopSequences != null) {
    setValueByPath(toObject, ["stopSequences"], fromStopSequences);
  }
  const fromResponseLogprobs = getValueByPath(fromObject, [
    "responseLogprobs"
  ]);
  if (fromResponseLogprobs != null) {
    setValueByPath(toObject, ["responseLogprobs"], fromResponseLogprobs);
  }
  const fromLogprobs = getValueByPath(fromObject, ["logprobs"]);
  if (fromLogprobs != null) {
    setValueByPath(toObject, ["logprobs"], fromLogprobs);
  }
  const fromPresencePenalty = getValueByPath(fromObject, [
    "presencePenalty"
  ]);
  if (fromPresencePenalty != null) {
    setValueByPath(toObject, ["presencePenalty"], fromPresencePenalty);
  }
  const fromFrequencyPenalty = getValueByPath(fromObject, [
    "frequencyPenalty"
  ]);
  if (fromFrequencyPenalty != null) {
    setValueByPath(toObject, ["frequencyPenalty"], fromFrequencyPenalty);
  }
  const fromSeed = getValueByPath(fromObject, ["seed"]);
  if (fromSeed != null) {
    setValueByPath(toObject, ["seed"], fromSeed);
  }
  const fromResponseMimeType = getValueByPath(fromObject, [
    "responseMimeType"
  ]);
  if (fromResponseMimeType != null) {
    setValueByPath(toObject, ["responseMimeType"], fromResponseMimeType);
  }
  const fromResponseSchema = getValueByPath(fromObject, [
    "responseSchema"
  ]);
  if (fromResponseSchema != null) {
    setValueByPath(toObject, ["responseSchema"], tSchema(fromResponseSchema));
  }
  const fromResponseJsonSchema = getValueByPath(fromObject, [
    "responseJsonSchema"
  ]);
  if (fromResponseJsonSchema != null) {
    setValueByPath(toObject, ["responseJsonSchema"], fromResponseJsonSchema);
  }
  if (getValueByPath(fromObject, ["routingConfig"]) !== void 0) {
    throw new Error("routingConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["modelSelectionConfig"]) !== void 0) {
    throw new Error("modelSelectionConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromSafetySettings = getValueByPath(fromObject, [
    "safetySettings"
  ]);
  if (parentObject !== void 0 && fromSafetySettings != null) {
    let transformedList = fromSafetySettings;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return safetySettingToMldev$3(item);
      });
    }
    setValueByPath(parentObject, ["safetySettings"], transformedList);
  }
  const fromTools = getValueByPath(fromObject, ["tools"]);
  if (parentObject !== void 0 && fromTools != null) {
    let transformedList = tTools(fromTools);
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return toolToMldev$4(tTool(item));
      });
    }
    setValueByPath(parentObject, ["tools"], transformedList);
  }
  const fromToolConfig = getValueByPath(fromObject, ["toolConfig"]);
  if (parentObject !== void 0 && fromToolConfig != null) {
    setValueByPath(parentObject, ["toolConfig"], toolConfigToMldev$2(fromToolConfig));
  }
  if (getValueByPath(fromObject, ["labels"]) !== void 0) {
    throw new Error("labels parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromCachedContent = getValueByPath(fromObject, [
    "cachedContent"
  ]);
  if (parentObject !== void 0 && fromCachedContent != null) {
    setValueByPath(parentObject, ["cachedContent"], tCachedContentName(apiClient, fromCachedContent));
  }
  const fromResponseModalities = getValueByPath(fromObject, [
    "responseModalities"
  ]);
  if (fromResponseModalities != null) {
    setValueByPath(toObject, ["responseModalities"], fromResponseModalities);
  }
  const fromMediaResolution = getValueByPath(fromObject, [
    "mediaResolution"
  ]);
  if (fromMediaResolution != null) {
    setValueByPath(toObject, ["mediaResolution"], fromMediaResolution);
  }
  const fromSpeechConfig = getValueByPath(fromObject, ["speechConfig"]);
  if (fromSpeechConfig != null) {
    setValueByPath(toObject, ["speechConfig"], tSpeechConfig(fromSpeechConfig));
  }
  if (getValueByPath(fromObject, ["audioTimestamp"]) !== void 0) {
    throw new Error("audioTimestamp parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromThinkingConfig = getValueByPath(fromObject, [
    "thinkingConfig"
  ]);
  if (fromThinkingConfig != null) {
    setValueByPath(toObject, ["thinkingConfig"], fromThinkingConfig);
  }
  const fromImageConfig = getValueByPath(fromObject, ["imageConfig"]);
  if (fromImageConfig != null) {
    setValueByPath(toObject, ["imageConfig"], imageConfigToMldev$1(fromImageConfig));
  }
  const fromEnableEnhancedCivicAnswers = getValueByPath(fromObject, [
    "enableEnhancedCivicAnswers"
  ]);
  if (fromEnableEnhancedCivicAnswers != null) {
    setValueByPath(toObject, ["enableEnhancedCivicAnswers"], fromEnableEnhancedCivicAnswers);
  }
  if (getValueByPath(fromObject, ["modelArmorConfig"]) !== void 0) {
    throw new Error("modelArmorConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromServiceTier = getValueByPath(fromObject, ["serviceTier"]);
  if (parentObject !== void 0 && fromServiceTier != null) {
    setValueByPath(parentObject, ["serviceTier"], fromServiceTier);
  }
  return toObject;
}
__name(generateContentConfigToMldev$1, "generateContentConfigToMldev$1");
function generateContentResponseFromMldev$1(fromObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromCandidates = getValueByPath(fromObject, ["candidates"]);
  if (fromCandidates != null) {
    let transformedList = fromCandidates;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return candidateFromMldev$1(item);
      });
    }
    setValueByPath(toObject, ["candidates"], transformedList);
  }
  const fromModelVersion = getValueByPath(fromObject, ["modelVersion"]);
  if (fromModelVersion != null) {
    setValueByPath(toObject, ["modelVersion"], fromModelVersion);
  }
  const fromPromptFeedback = getValueByPath(fromObject, [
    "promptFeedback"
  ]);
  if (fromPromptFeedback != null) {
    setValueByPath(toObject, ["promptFeedback"], fromPromptFeedback);
  }
  const fromResponseId = getValueByPath(fromObject, ["responseId"]);
  if (fromResponseId != null) {
    setValueByPath(toObject, ["responseId"], fromResponseId);
  }
  const fromUsageMetadata = getValueByPath(fromObject, [
    "usageMetadata"
  ]);
  if (fromUsageMetadata != null) {
    setValueByPath(toObject, ["usageMetadata"], fromUsageMetadata);
  }
  const fromModelStatus = getValueByPath(fromObject, ["modelStatus"]);
  if (fromModelStatus != null) {
    setValueByPath(toObject, ["modelStatus"], fromModelStatus);
  }
  return toObject;
}
__name(generateContentResponseFromMldev$1, "generateContentResponseFromMldev$1");
function getBatchJobParametersToMldev(apiClient, fromObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["_url", "name"], tBatchJobName(apiClient, fromName));
  }
  return toObject;
}
__name(getBatchJobParametersToMldev, "getBatchJobParametersToMldev");
function getBatchJobParametersToVertex(apiClient, fromObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["_url", "name"], tBatchJobName(apiClient, fromName));
  }
  return toObject;
}
__name(getBatchJobParametersToVertex, "getBatchJobParametersToVertex");
function googleMapsToMldev$4(fromObject) {
  const toObject = {};
  const fromAuthConfig = getValueByPath(fromObject, ["authConfig"]);
  if (fromAuthConfig != null) {
    setValueByPath(toObject, ["authConfig"], authConfigToMldev$4(fromAuthConfig));
  }
  const fromEnableWidget = getValueByPath(fromObject, ["enableWidget"]);
  if (fromEnableWidget != null) {
    setValueByPath(toObject, ["enableWidget"], fromEnableWidget);
  }
  return toObject;
}
__name(googleMapsToMldev$4, "googleMapsToMldev$4");
function googleSearchToMldev$4(fromObject) {
  const toObject = {};
  const fromSearchTypes = getValueByPath(fromObject, ["searchTypes"]);
  if (fromSearchTypes != null) {
    setValueByPath(toObject, ["searchTypes"], fromSearchTypes);
  }
  if (getValueByPath(fromObject, ["blockingConfidence"]) !== void 0) {
    throw new Error("blockingConfidence parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["excludeDomains"]) !== void 0) {
    throw new Error("excludeDomains parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromTimeRangeFilter = getValueByPath(fromObject, [
    "timeRangeFilter"
  ]);
  if (fromTimeRangeFilter != null) {
    setValueByPath(toObject, ["timeRangeFilter"], fromTimeRangeFilter);
  }
  return toObject;
}
__name(googleSearchToMldev$4, "googleSearchToMldev$4");
function imageConfigToMldev$1(fromObject) {
  const toObject = {};
  const fromAspectRatio = getValueByPath(fromObject, ["aspectRatio"]);
  if (fromAspectRatio != null) {
    setValueByPath(toObject, ["aspectRatio"], fromAspectRatio);
  }
  const fromImageSize = getValueByPath(fromObject, ["imageSize"]);
  if (fromImageSize != null) {
    setValueByPath(toObject, ["imageSize"], fromImageSize);
  }
  if (getValueByPath(fromObject, ["personGeneration"]) !== void 0) {
    throw new Error("personGeneration parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["prominentPeople"]) !== void 0) {
    throw new Error("prominentPeople parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["outputMimeType"]) !== void 0) {
    throw new Error("outputMimeType parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["outputCompressionQuality"]) !== void 0) {
    throw new Error("outputCompressionQuality parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["imageOutputOptions"]) !== void 0) {
    throw new Error("imageOutputOptions parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(imageConfigToMldev$1, "imageConfigToMldev$1");
function inlinedRequestToMldev(apiClient, fromObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["request", "model"], tModel(apiClient, fromModel));
  }
  const fromContents = getValueByPath(fromObject, ["contents"]);
  if (fromContents != null) {
    let transformedList = tContents(fromContents);
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return contentToMldev$4(item);
      });
    }
    setValueByPath(toObject, ["request", "contents"], transformedList);
  }
  const fromMetadata = getValueByPath(fromObject, ["metadata"]);
  if (fromMetadata != null) {
    setValueByPath(toObject, ["metadata"], fromMetadata);
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    setValueByPath(toObject, ["request", "generationConfig"], generateContentConfigToMldev$1(apiClient, fromConfig, getValueByPath(toObject, ["request"], {})));
  }
  return toObject;
}
__name(inlinedRequestToMldev, "inlinedRequestToMldev");
function inlinedResponseFromMldev(fromObject) {
  const toObject = {};
  const fromResponse = getValueByPath(fromObject, ["response"]);
  if (fromResponse != null) {
    setValueByPath(toObject, ["response"], generateContentResponseFromMldev$1(fromResponse));
  }
  const fromMetadata = getValueByPath(fromObject, ["metadata"]);
  if (fromMetadata != null) {
    setValueByPath(toObject, ["metadata"], fromMetadata);
  }
  const fromError = getValueByPath(fromObject, ["error"]);
  if (fromError != null) {
    setValueByPath(toObject, ["error"], fromError);
  }
  return toObject;
}
__name(inlinedResponseFromMldev, "inlinedResponseFromMldev");
function listBatchJobsConfigToMldev(fromObject, parentObject) {
  const toObject = {};
  const fromPageSize = getValueByPath(fromObject, ["pageSize"]);
  if (parentObject !== void 0 && fromPageSize != null) {
    setValueByPath(parentObject, ["_query", "pageSize"], fromPageSize);
  }
  const fromPageToken = getValueByPath(fromObject, ["pageToken"]);
  if (parentObject !== void 0 && fromPageToken != null) {
    setValueByPath(parentObject, ["_query", "pageToken"], fromPageToken);
  }
  if (getValueByPath(fromObject, ["filter"]) !== void 0) {
    throw new Error("filter parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(listBatchJobsConfigToMldev, "listBatchJobsConfigToMldev");
function listBatchJobsConfigToVertex(fromObject, parentObject) {
  const toObject = {};
  const fromPageSize = getValueByPath(fromObject, ["pageSize"]);
  if (parentObject !== void 0 && fromPageSize != null) {
    setValueByPath(parentObject, ["_query", "pageSize"], fromPageSize);
  }
  const fromPageToken = getValueByPath(fromObject, ["pageToken"]);
  if (parentObject !== void 0 && fromPageToken != null) {
    setValueByPath(parentObject, ["_query", "pageToken"], fromPageToken);
  }
  const fromFilter = getValueByPath(fromObject, ["filter"]);
  if (parentObject !== void 0 && fromFilter != null) {
    setValueByPath(parentObject, ["_query", "filter"], fromFilter);
  }
  return toObject;
}
__name(listBatchJobsConfigToVertex, "listBatchJobsConfigToVertex");
function listBatchJobsParametersToMldev(fromObject) {
  const toObject = {};
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    listBatchJobsConfigToMldev(fromConfig, toObject);
  }
  return toObject;
}
__name(listBatchJobsParametersToMldev, "listBatchJobsParametersToMldev");
function listBatchJobsParametersToVertex(fromObject) {
  const toObject = {};
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    listBatchJobsConfigToVertex(fromConfig, toObject);
  }
  return toObject;
}
__name(listBatchJobsParametersToVertex, "listBatchJobsParametersToVertex");
function listBatchJobsResponseFromMldev(fromObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromNextPageToken = getValueByPath(fromObject, [
    "nextPageToken"
  ]);
  if (fromNextPageToken != null) {
    setValueByPath(toObject, ["nextPageToken"], fromNextPageToken);
  }
  const fromBatchJobs = getValueByPath(fromObject, ["operations"]);
  if (fromBatchJobs != null) {
    let transformedList = fromBatchJobs;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return batchJobFromMldev(item);
      });
    }
    setValueByPath(toObject, ["batchJobs"], transformedList);
  }
  return toObject;
}
__name(listBatchJobsResponseFromMldev, "listBatchJobsResponseFromMldev");
function listBatchJobsResponseFromVertex(fromObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromNextPageToken = getValueByPath(fromObject, [
    "nextPageToken"
  ]);
  if (fromNextPageToken != null) {
    setValueByPath(toObject, ["nextPageToken"], fromNextPageToken);
  }
  const fromBatchJobs = getValueByPath(fromObject, [
    "batchPredictionJobs"
  ]);
  if (fromBatchJobs != null) {
    let transformedList = fromBatchJobs;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return batchJobFromVertex(item);
      });
    }
    setValueByPath(toObject, ["batchJobs"], transformedList);
  }
  return toObject;
}
__name(listBatchJobsResponseFromVertex, "listBatchJobsResponseFromVertex");
function partToMldev$4(fromObject) {
  const toObject = {};
  const fromMediaResolution = getValueByPath(fromObject, [
    "mediaResolution"
  ]);
  if (fromMediaResolution != null) {
    setValueByPath(toObject, ["mediaResolution"], fromMediaResolution);
  }
  const fromCodeExecutionResult = getValueByPath(fromObject, [
    "codeExecutionResult"
  ]);
  if (fromCodeExecutionResult != null) {
    setValueByPath(toObject, ["codeExecutionResult"], fromCodeExecutionResult);
  }
  const fromExecutableCode = getValueByPath(fromObject, [
    "executableCode"
  ]);
  if (fromExecutableCode != null) {
    setValueByPath(toObject, ["executableCode"], fromExecutableCode);
  }
  const fromFileData = getValueByPath(fromObject, ["fileData"]);
  if (fromFileData != null) {
    setValueByPath(toObject, ["fileData"], fileDataToMldev$4(fromFileData));
  }
  const fromFunctionCall = getValueByPath(fromObject, ["functionCall"]);
  if (fromFunctionCall != null) {
    setValueByPath(toObject, ["functionCall"], functionCallToMldev$4(fromFunctionCall));
  }
  const fromFunctionResponse = getValueByPath(fromObject, [
    "functionResponse"
  ]);
  if (fromFunctionResponse != null) {
    setValueByPath(toObject, ["functionResponse"], fromFunctionResponse);
  }
  const fromInlineData = getValueByPath(fromObject, ["inlineData"]);
  if (fromInlineData != null) {
    setValueByPath(toObject, ["inlineData"], blobToMldev$4(fromInlineData));
  }
  const fromText = getValueByPath(fromObject, ["text"]);
  if (fromText != null) {
    setValueByPath(toObject, ["text"], fromText);
  }
  const fromThought = getValueByPath(fromObject, ["thought"]);
  if (fromThought != null) {
    setValueByPath(toObject, ["thought"], fromThought);
  }
  const fromThoughtSignature = getValueByPath(fromObject, [
    "thoughtSignature"
  ]);
  if (fromThoughtSignature != null) {
    setValueByPath(toObject, ["thoughtSignature"], fromThoughtSignature);
  }
  const fromVideoMetadata = getValueByPath(fromObject, [
    "videoMetadata"
  ]);
  if (fromVideoMetadata != null) {
    setValueByPath(toObject, ["videoMetadata"], fromVideoMetadata);
  }
  const fromToolCall = getValueByPath(fromObject, ["toolCall"]);
  if (fromToolCall != null) {
    setValueByPath(toObject, ["toolCall"], fromToolCall);
  }
  const fromToolResponse = getValueByPath(fromObject, ["toolResponse"]);
  if (fromToolResponse != null) {
    setValueByPath(toObject, ["toolResponse"], fromToolResponse);
  }
  const fromPartMetadata = getValueByPath(fromObject, ["partMetadata"]);
  if (fromPartMetadata != null) {
    setValueByPath(toObject, ["partMetadata"], fromPartMetadata);
  }
  return toObject;
}
__name(partToMldev$4, "partToMldev$4");
function safetySettingToMldev$3(fromObject) {
  const toObject = {};
  const fromCategory = getValueByPath(fromObject, ["category"]);
  if (fromCategory != null) {
    setValueByPath(toObject, ["category"], fromCategory);
  }
  if (getValueByPath(fromObject, ["method"]) !== void 0) {
    throw new Error("method parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromThreshold = getValueByPath(fromObject, ["threshold"]);
  if (fromThreshold != null) {
    setValueByPath(toObject, ["threshold"], fromThreshold);
  }
  return toObject;
}
__name(safetySettingToMldev$3, "safetySettingToMldev$3");
function toolConfigToMldev$2(fromObject) {
  const toObject = {};
  const fromRetrievalConfig = getValueByPath(fromObject, [
    "retrievalConfig"
  ]);
  if (fromRetrievalConfig != null) {
    setValueByPath(toObject, ["retrievalConfig"], fromRetrievalConfig);
  }
  const fromFunctionCallingConfig = getValueByPath(fromObject, [
    "functionCallingConfig"
  ]);
  if (fromFunctionCallingConfig != null) {
    setValueByPath(toObject, ["functionCallingConfig"], functionCallingConfigToMldev$2(fromFunctionCallingConfig));
  }
  const fromIncludeServerSideToolInvocations = getValueByPath(fromObject, ["includeServerSideToolInvocations"]);
  if (fromIncludeServerSideToolInvocations != null) {
    setValueByPath(toObject, ["includeServerSideToolInvocations"], fromIncludeServerSideToolInvocations);
  }
  return toObject;
}
__name(toolConfigToMldev$2, "toolConfigToMldev$2");
function toolToMldev$4(fromObject) {
  const toObject = {};
  if (getValueByPath(fromObject, ["retrieval"]) !== void 0) {
    throw new Error("retrieval parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromComputerUse = getValueByPath(fromObject, ["computerUse"]);
  if (fromComputerUse != null) {
    setValueByPath(toObject, ["computerUse"], fromComputerUse);
  }
  const fromFileSearch = getValueByPath(fromObject, ["fileSearch"]);
  if (fromFileSearch != null) {
    setValueByPath(toObject, ["fileSearch"], fromFileSearch);
  }
  const fromGoogleSearch = getValueByPath(fromObject, ["googleSearch"]);
  if (fromGoogleSearch != null) {
    setValueByPath(toObject, ["googleSearch"], googleSearchToMldev$4(fromGoogleSearch));
  }
  const fromGoogleMaps = getValueByPath(fromObject, ["googleMaps"]);
  if (fromGoogleMaps != null) {
    setValueByPath(toObject, ["googleMaps"], googleMapsToMldev$4(fromGoogleMaps));
  }
  const fromCodeExecution = getValueByPath(fromObject, [
    "codeExecution"
  ]);
  if (fromCodeExecution != null) {
    setValueByPath(toObject, ["codeExecution"], fromCodeExecution);
  }
  if (getValueByPath(fromObject, ["enterpriseWebSearch"]) !== void 0) {
    throw new Error("enterpriseWebSearch parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromFunctionDeclarations = getValueByPath(fromObject, [
    "functionDeclarations"
  ]);
  if (fromFunctionDeclarations != null) {
    let transformedList = fromFunctionDeclarations;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["functionDeclarations"], transformedList);
  }
  const fromGoogleSearchRetrieval = getValueByPath(fromObject, [
    "googleSearchRetrieval"
  ]);
  if (fromGoogleSearchRetrieval != null) {
    setValueByPath(toObject, ["googleSearchRetrieval"], fromGoogleSearchRetrieval);
  }
  if (getValueByPath(fromObject, ["parallelAiSearch"]) !== void 0) {
    throw new Error("parallelAiSearch parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromUrlContext = getValueByPath(fromObject, ["urlContext"]);
  if (fromUrlContext != null) {
    setValueByPath(toObject, ["urlContext"], fromUrlContext);
  }
  const fromMcpServers = getValueByPath(fromObject, ["mcpServers"]);
  if (fromMcpServers != null) {
    let transformedList = fromMcpServers;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["mcpServers"], transformedList);
  }
  return toObject;
}
__name(toolToMldev$4, "toolToMldev$4");
function vertexMultimodalDatasetDestinationFromVertex(fromObject) {
  const toObject = {};
  const fromBigqueryDestination = getValueByPath(fromObject, [
    "bigqueryDestination",
    "outputUri"
  ]);
  if (fromBigqueryDestination != null) {
    setValueByPath(toObject, ["bigqueryDestination"], fromBigqueryDestination);
  }
  const fromDisplayName = getValueByPath(fromObject, ["displayName"]);
  if (fromDisplayName != null) {
    setValueByPath(toObject, ["displayName"], fromDisplayName);
  }
  return toObject;
}
__name(vertexMultimodalDatasetDestinationFromVertex, "vertexMultimodalDatasetDestinationFromVertex");
function vertexMultimodalDatasetDestinationToVertex(fromObject) {
  const toObject = {};
  const fromBigqueryDestination = getValueByPath(fromObject, [
    "bigqueryDestination"
  ]);
  if (fromBigqueryDestination != null) {
    setValueByPath(toObject, ["bigqueryDestination", "outputUri"], fromBigqueryDestination);
  }
  const fromDisplayName = getValueByPath(fromObject, ["displayName"]);
  if (fromDisplayName != null) {
    setValueByPath(toObject, ["displayName"], fromDisplayName);
  }
  return toObject;
}
__name(vertexMultimodalDatasetDestinationToVertex, "vertexMultimodalDatasetDestinationToVertex");
var PagedItem;
(function(PagedItem2) {
  PagedItem2["PAGED_ITEM_BATCH_JOBS"] = "batchJobs";
  PagedItem2["PAGED_ITEM_MODELS"] = "models";
  PagedItem2["PAGED_ITEM_TUNING_JOBS"] = "tuningJobs";
  PagedItem2["PAGED_ITEM_FILES"] = "files";
  PagedItem2["PAGED_ITEM_CACHED_CONTENTS"] = "cachedContents";
  PagedItem2["PAGED_ITEM_FILE_SEARCH_STORES"] = "fileSearchStores";
  PagedItem2["PAGED_ITEM_DOCUMENTS"] = "documents";
})(PagedItem || (PagedItem = {}));
var Pager = class {
  static {
    __name(this, "Pager");
  }
  constructor(name, request, response, params) {
    this.pageInternal = [];
    this.paramsInternal = {};
    this.requestInternal = request;
    this.init(name, response, params);
  }
  init(name, response, params) {
    var _a2, _b;
    this.nameInternal = name;
    this.pageInternal = response[this.nameInternal] || [];
    this.sdkHttpResponseInternal = response === null || response === void 0 ? void 0 : response.sdkHttpResponse;
    this.idxInternal = 0;
    let requestParams = { config: {} };
    if (!params || Object.keys(params).length === 0) {
      requestParams = { config: {} };
    } else if (typeof params === "object") {
      requestParams = Object.assign({}, params);
    } else {
      requestParams = params;
    }
    if (requestParams["config"]) {
      requestParams["config"]["pageToken"] = response["nextPageToken"];
    }
    this.paramsInternal = requestParams;
    this.pageInternalSize = (_b = (_a2 = requestParams["config"]) === null || _a2 === void 0 ? void 0 : _a2["pageSize"]) !== null && _b !== void 0 ? _b : this.pageInternal.length;
  }
  initNextPage(response) {
    this.init(this.nameInternal, response, this.paramsInternal);
  }
  /**
   * Returns the current page, which is a list of items.
   *
   * @remarks
   * The first page is retrieved when the pager is created. The returned list of
   * items could be a subset of the entire list.
   */
  get page() {
    return this.pageInternal;
  }
  /**
   * Returns the type of paged item (for example, ``batch_jobs``).
   */
  get name() {
    return this.nameInternal;
  }
  /**
   * Returns the length of the page fetched each time by this pager.
   *
   * @remarks
   * The number of items in the page is less than or equal to the page length.
   */
  get pageSize() {
    return this.pageInternalSize;
  }
  /**
   * Returns the headers of the API response.
   */
  get sdkHttpResponse() {
    return this.sdkHttpResponseInternal;
  }
  /**
   * Returns the parameters when making the API request for the next page.
   *
   * @remarks
   * Parameters contain a set of optional configs that can be
   * used to customize the API request. For example, the `pageToken` parameter
   * contains the token to request the next page.
   */
  get params() {
    return this.paramsInternal;
  }
  /**
   * Returns the total number of items in the current page.
   */
  get pageLength() {
    return this.pageInternal.length;
  }
  /**
   * Returns the item at the given index.
   */
  getItem(index) {
    return this.pageInternal[index];
  }
  /**
   * Returns an async iterator that support iterating through all items
   * retrieved from the API.
   *
   * @remarks
   * The iterator will automatically fetch the next page if there are more items
   * to fetch from the API.
   *
   * @example
   *
   * ```ts
   * const pager = await ai.files.list({config: {pageSize: 10}});
   * for await (const file of pager) {
   *   console.log(file.name);
   * }
   * ```
   */
  [Symbol.asyncIterator]() {
    return {
      next: /* @__PURE__ */ __name(async () => {
        if (this.idxInternal >= this.pageLength) {
          if (this.hasNextPage()) {
            await this.nextPage();
          } else {
            return { value: void 0, done: true };
          }
        }
        const item = this.getItem(this.idxInternal);
        this.idxInternal += 1;
        return { value: item, done: false };
      }, "next"),
      return: /* @__PURE__ */ __name(async () => {
        return { value: void 0, done: true };
      }, "return")
    };
  }
  /**
   * Fetches the next page of items. This makes a new API request.
   *
   * @throws {Error} If there are no more pages to fetch.
   *
   * @example
   *
   * ```ts
   * const pager = await ai.files.list({config: {pageSize: 10}});
   * let page = pager.page;
   * while (true) {
   *   for (const file of page) {
   *     console.log(file.name);
   *   }
   *   if (!pager.hasNextPage()) {
   *     break;
   *   }
   *   page = await pager.nextPage();
   * }
   * ```
   */
  async nextPage() {
    if (!this.hasNextPage()) {
      throw new Error("No more pages to fetch.");
    }
    const response = await this.requestInternal(this.params);
    this.initNextPage(response);
    return this.page;
  }
  /**
   * Returns true if there are more pages to fetch from the API.
   */
  hasNextPage() {
    var _a2;
    if (((_a2 = this.params["config"]) === null || _a2 === void 0 ? void 0 : _a2["pageToken"]) !== void 0) {
      return true;
    }
    return false;
  }
};
var Batches = class extends BaseModule {
  static {
    __name(this, "Batches");
  }
  constructor(apiClient) {
    super();
    this.apiClient = apiClient;
    this.list = async (params = {}) => {
      return new Pager(PagedItem.PAGED_ITEM_BATCH_JOBS, (x) => this.listInternal(x), await this.listInternal(params), params);
    };
    this.create = async (params) => {
      if (this.apiClient.isVertexAI()) {
        params.config = this.formatDestination(params.src, params.config);
      }
      return this.createInternal(params);
    };
    this.createEmbeddings = async (params) => {
      console.warn("batches.createEmbeddings() is experimental and may change without notice.");
      if (this.apiClient.isVertexAI()) {
        throw new Error("Gemini Enterprise Agent Platform (previously known as Vertex AI) does not support batches.createEmbeddings.");
      }
      return this.createEmbeddingsInternal(params);
    };
  }
  // Helper function to handle inlined generate content requests
  createInlinedGenerateContentRequest(params) {
    const body = createBatchJobParametersToMldev(
      this.apiClient,
      // Use instance apiClient
      params
    );
    const urlParams = body["_url"];
    const path2 = formatMap("{model}:batchGenerateContent", urlParams);
    const batch = body["batch"];
    const inputConfig = batch["inputConfig"];
    const requestsWrapper = inputConfig["requests"];
    const requests = requestsWrapper["requests"];
    const newRequests = [];
    for (const request of requests) {
      const requestDict = Object.assign({}, request);
      if (requestDict["systemInstruction"]) {
        const systemInstructionValue = requestDict["systemInstruction"];
        delete requestDict["systemInstruction"];
        const requestContent = requestDict["request"];
        requestContent["systemInstruction"] = systemInstructionValue;
        requestDict["request"] = requestContent;
      }
      newRequests.push(requestDict);
    }
    requestsWrapper["requests"] = newRequests;
    delete body["config"];
    delete body["_url"];
    delete body["_query"];
    return { path: path2, body };
  }
  // Helper function to get the first GCS URI
  getGcsUri(src) {
    if (typeof src === "string") {
      return src.startsWith("gs://") ? src : void 0;
    }
    if (!Array.isArray(src) && src.gcsUri && src.gcsUri.length > 0) {
      return src.gcsUri[0];
    }
    return void 0;
  }
  // Helper function to get the BigQuery URI
  getBigqueryUri(src) {
    if (typeof src === "string") {
      return src.startsWith("bq://") ? src : void 0;
    }
    if (!Array.isArray(src)) {
      return src.bigqueryUri;
    }
    return void 0;
  }
  // Function to format the destination configuration for Vertex AI
  formatDestination(src, config) {
    const newConfig = config ? Object.assign({}, config) : {};
    const timestampStr = Date.now().toString();
    if (!newConfig.displayName) {
      newConfig.displayName = `genaiBatchJob_${timestampStr}`;
    }
    if (newConfig.dest === void 0) {
      const gcsUri = this.getGcsUri(src);
      const bigqueryUri = this.getBigqueryUri(src);
      if (gcsUri) {
        if (gcsUri.endsWith(".jsonl")) {
          newConfig.dest = `${gcsUri.slice(0, -6)}/dest`;
        } else {
          newConfig.dest = `${gcsUri}_dest_${timestampStr}`;
        }
      } else if (bigqueryUri) {
        newConfig.dest = `${bigqueryUri}_dest_${timestampStr}`;
      } else {
        throw new Error("Unsupported source for Gemini Enterprise Agent Platform (previously known as Vertex AI): No GCS or BigQuery URI found.");
      }
    }
    return newConfig;
  }
  /**
   * Internal method to create batch job.
   *
   * @param params - The parameters for create batch job request.
   * @return The created batch job.
   *
   */
  async createInternal(params) {
    var _a2, _b, _c, _d;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = createBatchJobParametersToVertex(this.apiClient, params);
      path2 = formatMap("batchPredictionJobs", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((apiResponse) => {
        const resp = batchJobFromVertex(apiResponse);
        return resp;
      });
    } else {
      const body = createBatchJobParametersToMldev(this.apiClient, params);
      path2 = formatMap("{model}:batchGenerateContent", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_c = params.config) === null || _c === void 0 ? void 0 : _c.httpOptions,
        abortSignal: (_d = params.config) === null || _d === void 0 ? void 0 : _d.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((apiResponse) => {
        const resp = batchJobFromMldev(apiResponse);
        return resp;
      });
    }
  }
  /**
   * Internal method to create batch job.
   *
   * @param params - The parameters for create batch job request.
   * @return The created batch job.
   *
   */
  async createEmbeddingsInternal(params) {
    var _a2, _b;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      throw new Error("This method is only supported by the Gemini Developer API.");
    } else {
      const body = createEmbeddingsBatchJobParametersToMldev(this.apiClient, params);
      path2 = formatMap("{model}:asyncBatchEmbedContent", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((apiResponse) => {
        const resp = batchJobFromMldev(apiResponse);
        return resp;
      });
    }
  }
  /**
   * Gets batch job configurations.
   *
   * @param params - The parameters for the get request.
   * @return The batch job.
   *
   * @example
   * ```ts
   * await ai.batches.get({name: '...'}); // The server-generated resource name.
   * ```
   */
  async get(params) {
    var _a2, _b, _c, _d;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = getBatchJobParametersToVertex(this.apiClient, params);
      path2 = formatMap("batchPredictionJobs/{name}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "GET",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((apiResponse) => {
        const resp = batchJobFromVertex(apiResponse);
        return resp;
      });
    } else {
      const body = getBatchJobParametersToMldev(this.apiClient, params);
      path2 = formatMap("batches/{name}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "GET",
        httpOptions: (_c = params.config) === null || _c === void 0 ? void 0 : _c.httpOptions,
        abortSignal: (_d = params.config) === null || _d === void 0 ? void 0 : _d.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((apiResponse) => {
        const resp = batchJobFromMldev(apiResponse);
        return resp;
      });
    }
  }
  /**
   * Cancels a batch job.
   *
   * @param params - The parameters for the cancel request.
   * @return The empty response returned by the API.
   *
   * @example
   * ```ts
   * await ai.batches.cancel({name: '...'}); // The server-generated resource name.
   * ```
   */
  async cancel(params) {
    var _a2, _b, _c, _d;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = cancelBatchJobParametersToVertex(this.apiClient, params);
      path2 = formatMap("batchPredictionJobs/{name}:cancel", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      await this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      });
    } else {
      const body = cancelBatchJobParametersToMldev(this.apiClient, params);
      path2 = formatMap("batches/{name}:cancel", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      await this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_c = params.config) === null || _c === void 0 ? void 0 : _c.httpOptions,
        abortSignal: (_d = params.config) === null || _d === void 0 ? void 0 : _d.abortSignal
      });
    }
  }
  async listInternal(params) {
    var _a2, _b, _c, _d;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = listBatchJobsParametersToVertex(params);
      path2 = formatMap("batchPredictionJobs", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "GET",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = listBatchJobsResponseFromVertex(apiResponse);
        const typedResp = new ListBatchJobsResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    } else {
      const body = listBatchJobsParametersToMldev(params);
      path2 = formatMap("batches", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "GET",
        httpOptions: (_c = params.config) === null || _c === void 0 ? void 0 : _c.httpOptions,
        abortSignal: (_d = params.config) === null || _d === void 0 ? void 0 : _d.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = listBatchJobsResponseFromMldev(apiResponse);
        const typedResp = new ListBatchJobsResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    }
  }
  /**
   * Deletes a batch job.
   *
   * @param params - The parameters for the delete request.
   * @return The empty response returned by the API.
   *
   * @example
   * ```ts
   * await ai.batches.delete({name: '...'}); // The server-generated resource name.
   * ```
   */
  async delete(params) {
    var _a2, _b, _c, _d;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = deleteBatchJobParametersToVertex(this.apiClient, params);
      path2 = formatMap("batchPredictionJobs/{name}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "DELETE",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = deleteResourceJobFromVertex(apiResponse);
        return resp;
      });
    } else {
      const body = deleteBatchJobParametersToMldev(this.apiClient, params);
      path2 = formatMap("batches/{name}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "DELETE",
        httpOptions: (_c = params.config) === null || _c === void 0 ? void 0 : _c.httpOptions,
        abortSignal: (_d = params.config) === null || _d === void 0 ? void 0 : _d.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = deleteResourceJobFromMldev(apiResponse);
        return resp;
      });
    }
  }
};
function authConfigToMldev$3(fromObject) {
  const toObject = {};
  const fromApiKey = getValueByPath(fromObject, ["apiKey"]);
  if (fromApiKey != null) {
    setValueByPath(toObject, ["apiKey"], fromApiKey);
  }
  if (getValueByPath(fromObject, ["apiKeyConfig"]) !== void 0) {
    throw new Error("apiKeyConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["authType"]) !== void 0) {
    throw new Error("authType parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["googleServiceAccountConfig"]) !== void 0) {
    throw new Error("googleServiceAccountConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["httpBasicAuthConfig"]) !== void 0) {
    throw new Error("httpBasicAuthConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["oauthConfig"]) !== void 0) {
    throw new Error("oauthConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["oidcConfig"]) !== void 0) {
    throw new Error("oidcConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(authConfigToMldev$3, "authConfigToMldev$3");
function blobToMldev$3(fromObject) {
  const toObject = {};
  const fromData = getValueByPath(fromObject, ["data"]);
  if (fromData != null) {
    setValueByPath(toObject, ["data"], fromData);
  }
  if (getValueByPath(fromObject, ["displayName"]) !== void 0) {
    throw new Error("displayName parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromMimeType = getValueByPath(fromObject, ["mimeType"]);
  if (fromMimeType != null) {
    setValueByPath(toObject, ["mimeType"], fromMimeType);
  }
  return toObject;
}
__name(blobToMldev$3, "blobToMldev$3");
function codeExecutionResultToVertex$2(fromObject) {
  const toObject = {};
  const fromOutcome = getValueByPath(fromObject, ["outcome"]);
  if (fromOutcome != null) {
    setValueByPath(toObject, ["outcome"], fromOutcome);
  }
  const fromOutput = getValueByPath(fromObject, ["output"]);
  if (fromOutput != null) {
    setValueByPath(toObject, ["output"], fromOutput);
  }
  if (getValueByPath(fromObject, ["id"]) !== void 0) {
    throw new Error("id parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  return toObject;
}
__name(codeExecutionResultToVertex$2, "codeExecutionResultToVertex$2");
function computerUseToVertex$2(fromObject) {
  const toObject = {};
  const fromEnvironment = getValueByPath(fromObject, ["environment"]);
  if (fromEnvironment != null) {
    setValueByPath(toObject, ["environment"], fromEnvironment);
  }
  const fromExcludedPredefinedFunctions = getValueByPath(fromObject, [
    "excludedPredefinedFunctions"
  ]);
  if (fromExcludedPredefinedFunctions != null) {
    setValueByPath(toObject, ["excludedPredefinedFunctions"], fromExcludedPredefinedFunctions);
  }
  if (getValueByPath(fromObject, ["enablePromptInjectionDetection"]) !== void 0) {
    throw new Error("enablePromptInjectionDetection parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  return toObject;
}
__name(computerUseToVertex$2, "computerUseToVertex$2");
function contentToMldev$3(fromObject) {
  const toObject = {};
  const fromParts = getValueByPath(fromObject, ["parts"]);
  if (fromParts != null) {
    let transformedList = fromParts;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return partToMldev$3(item);
      });
    }
    setValueByPath(toObject, ["parts"], transformedList);
  }
  const fromRole = getValueByPath(fromObject, ["role"]);
  if (fromRole != null) {
    setValueByPath(toObject, ["role"], fromRole);
  }
  return toObject;
}
__name(contentToMldev$3, "contentToMldev$3");
function contentToVertex$2(fromObject) {
  const toObject = {};
  const fromParts = getValueByPath(fromObject, ["parts"]);
  if (fromParts != null) {
    let transformedList = fromParts;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return partToVertex$2(item);
      });
    }
    setValueByPath(toObject, ["parts"], transformedList);
  }
  const fromRole = getValueByPath(fromObject, ["role"]);
  if (fromRole != null) {
    setValueByPath(toObject, ["role"], fromRole);
  }
  return toObject;
}
__name(contentToVertex$2, "contentToVertex$2");
function createCachedContentConfigToMldev(fromObject, parentObject) {
  const toObject = {};
  const fromTtl = getValueByPath(fromObject, ["ttl"]);
  if (parentObject !== void 0 && fromTtl != null) {
    setValueByPath(parentObject, ["ttl"], fromTtl);
  }
  const fromExpireTime = getValueByPath(fromObject, ["expireTime"]);
  if (parentObject !== void 0 && fromExpireTime != null) {
    setValueByPath(parentObject, ["expireTime"], fromExpireTime);
  }
  const fromDisplayName = getValueByPath(fromObject, ["displayName"]);
  if (parentObject !== void 0 && fromDisplayName != null) {
    setValueByPath(parentObject, ["displayName"], fromDisplayName);
  }
  const fromContents = getValueByPath(fromObject, ["contents"]);
  if (parentObject !== void 0 && fromContents != null) {
    let transformedList = tContents(fromContents);
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return contentToMldev$3(item);
      });
    }
    setValueByPath(parentObject, ["contents"], transformedList);
  }
  const fromSystemInstruction = getValueByPath(fromObject, [
    "systemInstruction"
  ]);
  if (parentObject !== void 0 && fromSystemInstruction != null) {
    setValueByPath(parentObject, ["systemInstruction"], contentToMldev$3(tContent(fromSystemInstruction)));
  }
  const fromTools = getValueByPath(fromObject, ["tools"]);
  if (parentObject !== void 0 && fromTools != null) {
    let transformedList = fromTools;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return toolToMldev$3(item);
      });
    }
    setValueByPath(parentObject, ["tools"], transformedList);
  }
  const fromToolConfig = getValueByPath(fromObject, ["toolConfig"]);
  if (parentObject !== void 0 && fromToolConfig != null) {
    setValueByPath(parentObject, ["toolConfig"], toolConfigToMldev$1(fromToolConfig));
  }
  if (getValueByPath(fromObject, ["kmsKeyName"]) !== void 0) {
    throw new Error("kmsKeyName parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(createCachedContentConfigToMldev, "createCachedContentConfigToMldev");
function createCachedContentConfigToVertex(fromObject, parentObject) {
  const toObject = {};
  const fromTtl = getValueByPath(fromObject, ["ttl"]);
  if (parentObject !== void 0 && fromTtl != null) {
    setValueByPath(parentObject, ["ttl"], fromTtl);
  }
  const fromExpireTime = getValueByPath(fromObject, ["expireTime"]);
  if (parentObject !== void 0 && fromExpireTime != null) {
    setValueByPath(parentObject, ["expireTime"], fromExpireTime);
  }
  const fromDisplayName = getValueByPath(fromObject, ["displayName"]);
  if (parentObject !== void 0 && fromDisplayName != null) {
    setValueByPath(parentObject, ["displayName"], fromDisplayName);
  }
  const fromContents = getValueByPath(fromObject, ["contents"]);
  if (parentObject !== void 0 && fromContents != null) {
    let transformedList = tContents(fromContents);
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return contentToVertex$2(item);
      });
    }
    setValueByPath(parentObject, ["contents"], transformedList);
  }
  const fromSystemInstruction = getValueByPath(fromObject, [
    "systemInstruction"
  ]);
  if (parentObject !== void 0 && fromSystemInstruction != null) {
    setValueByPath(parentObject, ["systemInstruction"], contentToVertex$2(tContent(fromSystemInstruction)));
  }
  const fromTools = getValueByPath(fromObject, ["tools"]);
  if (parentObject !== void 0 && fromTools != null) {
    let transformedList = fromTools;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return toolToVertex$2(item);
      });
    }
    setValueByPath(parentObject, ["tools"], transformedList);
  }
  const fromToolConfig = getValueByPath(fromObject, ["toolConfig"]);
  if (parentObject !== void 0 && fromToolConfig != null) {
    setValueByPath(parentObject, ["toolConfig"], toolConfigToVertex$1(fromToolConfig));
  }
  const fromKmsKeyName = getValueByPath(fromObject, ["kmsKeyName"]);
  if (parentObject !== void 0 && fromKmsKeyName != null) {
    setValueByPath(parentObject, ["encryption_spec", "kmsKeyName"], fromKmsKeyName);
  }
  return toObject;
}
__name(createCachedContentConfigToVertex, "createCachedContentConfigToVertex");
function createCachedContentParametersToMldev(apiClient, fromObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["model"], tCachesModel(apiClient, fromModel));
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    createCachedContentConfigToMldev(fromConfig, toObject);
  }
  return toObject;
}
__name(createCachedContentParametersToMldev, "createCachedContentParametersToMldev");
function createCachedContentParametersToVertex(apiClient, fromObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["model"], tCachesModel(apiClient, fromModel));
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    createCachedContentConfigToVertex(fromConfig, toObject);
  }
  return toObject;
}
__name(createCachedContentParametersToVertex, "createCachedContentParametersToVertex");
function deleteCachedContentParametersToMldev(apiClient, fromObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["_url", "name"], tCachedContentName(apiClient, fromName));
  }
  return toObject;
}
__name(deleteCachedContentParametersToMldev, "deleteCachedContentParametersToMldev");
function deleteCachedContentParametersToVertex(apiClient, fromObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["_url", "name"], tCachedContentName(apiClient, fromName));
  }
  return toObject;
}
__name(deleteCachedContentParametersToVertex, "deleteCachedContentParametersToVertex");
function deleteCachedContentResponseFromMldev(fromObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  return toObject;
}
__name(deleteCachedContentResponseFromMldev, "deleteCachedContentResponseFromMldev");
function deleteCachedContentResponseFromVertex(fromObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  return toObject;
}
__name(deleteCachedContentResponseFromVertex, "deleteCachedContentResponseFromVertex");
function executableCodeToVertex$2(fromObject) {
  const toObject = {};
  const fromCode = getValueByPath(fromObject, ["code"]);
  if (fromCode != null) {
    setValueByPath(toObject, ["code"], fromCode);
  }
  const fromLanguage = getValueByPath(fromObject, ["language"]);
  if (fromLanguage != null) {
    setValueByPath(toObject, ["language"], fromLanguage);
  }
  if (getValueByPath(fromObject, ["id"]) !== void 0) {
    throw new Error("id parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  return toObject;
}
__name(executableCodeToVertex$2, "executableCodeToVertex$2");
function fileDataToMldev$3(fromObject) {
  const toObject = {};
  if (getValueByPath(fromObject, ["displayName"]) !== void 0) {
    throw new Error("displayName parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromFileUri = getValueByPath(fromObject, ["fileUri"]);
  if (fromFileUri != null) {
    setValueByPath(toObject, ["fileUri"], fromFileUri);
  }
  const fromMimeType = getValueByPath(fromObject, ["mimeType"]);
  if (fromMimeType != null) {
    setValueByPath(toObject, ["mimeType"], fromMimeType);
  }
  return toObject;
}
__name(fileDataToMldev$3, "fileDataToMldev$3");
function functionCallToMldev$3(fromObject) {
  const toObject = {};
  const fromId = getValueByPath(fromObject, ["id"]);
  if (fromId != null) {
    setValueByPath(toObject, ["id"], fromId);
  }
  const fromArgs = getValueByPath(fromObject, ["args"]);
  if (fromArgs != null) {
    setValueByPath(toObject, ["args"], fromArgs);
  }
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["name"], fromName);
  }
  if (getValueByPath(fromObject, ["partialArgs"]) !== void 0) {
    throw new Error("partialArgs parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["willContinue"]) !== void 0) {
    throw new Error("willContinue parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(functionCallToMldev$3, "functionCallToMldev$3");
function functionCallingConfigToMldev$1(fromObject) {
  const toObject = {};
  const fromAllowedFunctionNames = getValueByPath(fromObject, [
    "allowedFunctionNames"
  ]);
  if (fromAllowedFunctionNames != null) {
    setValueByPath(toObject, ["allowedFunctionNames"], fromAllowedFunctionNames);
  }
  const fromMode = getValueByPath(fromObject, ["mode"]);
  if (fromMode != null) {
    setValueByPath(toObject, ["mode"], fromMode);
  }
  if (getValueByPath(fromObject, ["streamFunctionCallArguments"]) !== void 0) {
    throw new Error("streamFunctionCallArguments parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(functionCallingConfigToMldev$1, "functionCallingConfigToMldev$1");
function getCachedContentParametersToMldev(apiClient, fromObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["_url", "name"], tCachedContentName(apiClient, fromName));
  }
  return toObject;
}
__name(getCachedContentParametersToMldev, "getCachedContentParametersToMldev");
function getCachedContentParametersToVertex(apiClient, fromObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["_url", "name"], tCachedContentName(apiClient, fromName));
  }
  return toObject;
}
__name(getCachedContentParametersToVertex, "getCachedContentParametersToVertex");
function googleMapsToMldev$3(fromObject) {
  const toObject = {};
  const fromAuthConfig = getValueByPath(fromObject, ["authConfig"]);
  if (fromAuthConfig != null) {
    setValueByPath(toObject, ["authConfig"], authConfigToMldev$3(fromAuthConfig));
  }
  const fromEnableWidget = getValueByPath(fromObject, ["enableWidget"]);
  if (fromEnableWidget != null) {
    setValueByPath(toObject, ["enableWidget"], fromEnableWidget);
  }
  return toObject;
}
__name(googleMapsToMldev$3, "googleMapsToMldev$3");
function googleSearchToMldev$3(fromObject) {
  const toObject = {};
  const fromSearchTypes = getValueByPath(fromObject, ["searchTypes"]);
  if (fromSearchTypes != null) {
    setValueByPath(toObject, ["searchTypes"], fromSearchTypes);
  }
  if (getValueByPath(fromObject, ["blockingConfidence"]) !== void 0) {
    throw new Error("blockingConfidence parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["excludeDomains"]) !== void 0) {
    throw new Error("excludeDomains parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromTimeRangeFilter = getValueByPath(fromObject, [
    "timeRangeFilter"
  ]);
  if (fromTimeRangeFilter != null) {
    setValueByPath(toObject, ["timeRangeFilter"], fromTimeRangeFilter);
  }
  return toObject;
}
__name(googleSearchToMldev$3, "googleSearchToMldev$3");
function listCachedContentsConfigToMldev(fromObject, parentObject) {
  const toObject = {};
  const fromPageSize = getValueByPath(fromObject, ["pageSize"]);
  if (parentObject !== void 0 && fromPageSize != null) {
    setValueByPath(parentObject, ["_query", "pageSize"], fromPageSize);
  }
  const fromPageToken = getValueByPath(fromObject, ["pageToken"]);
  if (parentObject !== void 0 && fromPageToken != null) {
    setValueByPath(parentObject, ["_query", "pageToken"], fromPageToken);
  }
  return toObject;
}
__name(listCachedContentsConfigToMldev, "listCachedContentsConfigToMldev");
function listCachedContentsConfigToVertex(fromObject, parentObject) {
  const toObject = {};
  const fromPageSize = getValueByPath(fromObject, ["pageSize"]);
  if (parentObject !== void 0 && fromPageSize != null) {
    setValueByPath(parentObject, ["_query", "pageSize"], fromPageSize);
  }
  const fromPageToken = getValueByPath(fromObject, ["pageToken"]);
  if (parentObject !== void 0 && fromPageToken != null) {
    setValueByPath(parentObject, ["_query", "pageToken"], fromPageToken);
  }
  return toObject;
}
__name(listCachedContentsConfigToVertex, "listCachedContentsConfigToVertex");
function listCachedContentsParametersToMldev(fromObject) {
  const toObject = {};
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    listCachedContentsConfigToMldev(fromConfig, toObject);
  }
  return toObject;
}
__name(listCachedContentsParametersToMldev, "listCachedContentsParametersToMldev");
function listCachedContentsParametersToVertex(fromObject) {
  const toObject = {};
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    listCachedContentsConfigToVertex(fromConfig, toObject);
  }
  return toObject;
}
__name(listCachedContentsParametersToVertex, "listCachedContentsParametersToVertex");
function listCachedContentsResponseFromMldev(fromObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromNextPageToken = getValueByPath(fromObject, [
    "nextPageToken"
  ]);
  if (fromNextPageToken != null) {
    setValueByPath(toObject, ["nextPageToken"], fromNextPageToken);
  }
  const fromCachedContents = getValueByPath(fromObject, [
    "cachedContents"
  ]);
  if (fromCachedContents != null) {
    let transformedList = fromCachedContents;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["cachedContents"], transformedList);
  }
  return toObject;
}
__name(listCachedContentsResponseFromMldev, "listCachedContentsResponseFromMldev");
function listCachedContentsResponseFromVertex(fromObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromNextPageToken = getValueByPath(fromObject, [
    "nextPageToken"
  ]);
  if (fromNextPageToken != null) {
    setValueByPath(toObject, ["nextPageToken"], fromNextPageToken);
  }
  const fromCachedContents = getValueByPath(fromObject, [
    "cachedContents"
  ]);
  if (fromCachedContents != null) {
    let transformedList = fromCachedContents;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["cachedContents"], transformedList);
  }
  return toObject;
}
__name(listCachedContentsResponseFromVertex, "listCachedContentsResponseFromVertex");
function partToMldev$3(fromObject) {
  const toObject = {};
  const fromMediaResolution = getValueByPath(fromObject, [
    "mediaResolution"
  ]);
  if (fromMediaResolution != null) {
    setValueByPath(toObject, ["mediaResolution"], fromMediaResolution);
  }
  const fromCodeExecutionResult = getValueByPath(fromObject, [
    "codeExecutionResult"
  ]);
  if (fromCodeExecutionResult != null) {
    setValueByPath(toObject, ["codeExecutionResult"], fromCodeExecutionResult);
  }
  const fromExecutableCode = getValueByPath(fromObject, [
    "executableCode"
  ]);
  if (fromExecutableCode != null) {
    setValueByPath(toObject, ["executableCode"], fromExecutableCode);
  }
  const fromFileData = getValueByPath(fromObject, ["fileData"]);
  if (fromFileData != null) {
    setValueByPath(toObject, ["fileData"], fileDataToMldev$3(fromFileData));
  }
  const fromFunctionCall = getValueByPath(fromObject, ["functionCall"]);
  if (fromFunctionCall != null) {
    setValueByPath(toObject, ["functionCall"], functionCallToMldev$3(fromFunctionCall));
  }
  const fromFunctionResponse = getValueByPath(fromObject, [
    "functionResponse"
  ]);
  if (fromFunctionResponse != null) {
    setValueByPath(toObject, ["functionResponse"], fromFunctionResponse);
  }
  const fromInlineData = getValueByPath(fromObject, ["inlineData"]);
  if (fromInlineData != null) {
    setValueByPath(toObject, ["inlineData"], blobToMldev$3(fromInlineData));
  }
  const fromText = getValueByPath(fromObject, ["text"]);
  if (fromText != null) {
    setValueByPath(toObject, ["text"], fromText);
  }
  const fromThought = getValueByPath(fromObject, ["thought"]);
  if (fromThought != null) {
    setValueByPath(toObject, ["thought"], fromThought);
  }
  const fromThoughtSignature = getValueByPath(fromObject, [
    "thoughtSignature"
  ]);
  if (fromThoughtSignature != null) {
    setValueByPath(toObject, ["thoughtSignature"], fromThoughtSignature);
  }
  const fromVideoMetadata = getValueByPath(fromObject, [
    "videoMetadata"
  ]);
  if (fromVideoMetadata != null) {
    setValueByPath(toObject, ["videoMetadata"], fromVideoMetadata);
  }
  const fromToolCall = getValueByPath(fromObject, ["toolCall"]);
  if (fromToolCall != null) {
    setValueByPath(toObject, ["toolCall"], fromToolCall);
  }
  const fromToolResponse = getValueByPath(fromObject, ["toolResponse"]);
  if (fromToolResponse != null) {
    setValueByPath(toObject, ["toolResponse"], fromToolResponse);
  }
  const fromPartMetadata = getValueByPath(fromObject, ["partMetadata"]);
  if (fromPartMetadata != null) {
    setValueByPath(toObject, ["partMetadata"], fromPartMetadata);
  }
  return toObject;
}
__name(partToMldev$3, "partToMldev$3");
function partToVertex$2(fromObject) {
  const toObject = {};
  const fromMediaResolution = getValueByPath(fromObject, [
    "mediaResolution"
  ]);
  if (fromMediaResolution != null) {
    setValueByPath(toObject, ["mediaResolution"], fromMediaResolution);
  }
  const fromCodeExecutionResult = getValueByPath(fromObject, [
    "codeExecutionResult"
  ]);
  if (fromCodeExecutionResult != null) {
    setValueByPath(toObject, ["codeExecutionResult"], codeExecutionResultToVertex$2(fromCodeExecutionResult));
  }
  const fromExecutableCode = getValueByPath(fromObject, [
    "executableCode"
  ]);
  if (fromExecutableCode != null) {
    setValueByPath(toObject, ["executableCode"], executableCodeToVertex$2(fromExecutableCode));
  }
  const fromFileData = getValueByPath(fromObject, ["fileData"]);
  if (fromFileData != null) {
    setValueByPath(toObject, ["fileData"], fromFileData);
  }
  const fromFunctionCall = getValueByPath(fromObject, ["functionCall"]);
  if (fromFunctionCall != null) {
    setValueByPath(toObject, ["functionCall"], fromFunctionCall);
  }
  const fromFunctionResponse = getValueByPath(fromObject, [
    "functionResponse"
  ]);
  if (fromFunctionResponse != null) {
    setValueByPath(toObject, ["functionResponse"], fromFunctionResponse);
  }
  const fromInlineData = getValueByPath(fromObject, ["inlineData"]);
  if (fromInlineData != null) {
    setValueByPath(toObject, ["inlineData"], fromInlineData);
  }
  const fromText = getValueByPath(fromObject, ["text"]);
  if (fromText != null) {
    setValueByPath(toObject, ["text"], fromText);
  }
  const fromThought = getValueByPath(fromObject, ["thought"]);
  if (fromThought != null) {
    setValueByPath(toObject, ["thought"], fromThought);
  }
  const fromThoughtSignature = getValueByPath(fromObject, [
    "thoughtSignature"
  ]);
  if (fromThoughtSignature != null) {
    setValueByPath(toObject, ["thoughtSignature"], fromThoughtSignature);
  }
  const fromVideoMetadata = getValueByPath(fromObject, [
    "videoMetadata"
  ]);
  if (fromVideoMetadata != null) {
    setValueByPath(toObject, ["videoMetadata"], fromVideoMetadata);
  }
  if (getValueByPath(fromObject, ["toolCall"]) !== void 0) {
    throw new Error("toolCall parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  if (getValueByPath(fromObject, ["toolResponse"]) !== void 0) {
    throw new Error("toolResponse parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  if (getValueByPath(fromObject, ["partMetadata"]) !== void 0) {
    throw new Error("partMetadata parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  return toObject;
}
__name(partToVertex$2, "partToVertex$2");
function toolConfigToMldev$1(fromObject) {
  const toObject = {};
  const fromRetrievalConfig = getValueByPath(fromObject, [
    "retrievalConfig"
  ]);
  if (fromRetrievalConfig != null) {
    setValueByPath(toObject, ["retrievalConfig"], fromRetrievalConfig);
  }
  const fromFunctionCallingConfig = getValueByPath(fromObject, [
    "functionCallingConfig"
  ]);
  if (fromFunctionCallingConfig != null) {
    setValueByPath(toObject, ["functionCallingConfig"], functionCallingConfigToMldev$1(fromFunctionCallingConfig));
  }
  const fromIncludeServerSideToolInvocations = getValueByPath(fromObject, ["includeServerSideToolInvocations"]);
  if (fromIncludeServerSideToolInvocations != null) {
    setValueByPath(toObject, ["includeServerSideToolInvocations"], fromIncludeServerSideToolInvocations);
  }
  return toObject;
}
__name(toolConfigToMldev$1, "toolConfigToMldev$1");
function toolConfigToVertex$1(fromObject) {
  const toObject = {};
  const fromRetrievalConfig = getValueByPath(fromObject, [
    "retrievalConfig"
  ]);
  if (fromRetrievalConfig != null) {
    setValueByPath(toObject, ["retrievalConfig"], fromRetrievalConfig);
  }
  const fromFunctionCallingConfig = getValueByPath(fromObject, [
    "functionCallingConfig"
  ]);
  if (fromFunctionCallingConfig != null) {
    setValueByPath(toObject, ["functionCallingConfig"], fromFunctionCallingConfig);
  }
  if (getValueByPath(fromObject, ["includeServerSideToolInvocations"]) !== void 0) {
    throw new Error("includeServerSideToolInvocations parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  return toObject;
}
__name(toolConfigToVertex$1, "toolConfigToVertex$1");
function toolToMldev$3(fromObject) {
  const toObject = {};
  if (getValueByPath(fromObject, ["retrieval"]) !== void 0) {
    throw new Error("retrieval parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromComputerUse = getValueByPath(fromObject, ["computerUse"]);
  if (fromComputerUse != null) {
    setValueByPath(toObject, ["computerUse"], fromComputerUse);
  }
  const fromFileSearch = getValueByPath(fromObject, ["fileSearch"]);
  if (fromFileSearch != null) {
    setValueByPath(toObject, ["fileSearch"], fromFileSearch);
  }
  const fromGoogleSearch = getValueByPath(fromObject, ["googleSearch"]);
  if (fromGoogleSearch != null) {
    setValueByPath(toObject, ["googleSearch"], googleSearchToMldev$3(fromGoogleSearch));
  }
  const fromGoogleMaps = getValueByPath(fromObject, ["googleMaps"]);
  if (fromGoogleMaps != null) {
    setValueByPath(toObject, ["googleMaps"], googleMapsToMldev$3(fromGoogleMaps));
  }
  const fromCodeExecution = getValueByPath(fromObject, [
    "codeExecution"
  ]);
  if (fromCodeExecution != null) {
    setValueByPath(toObject, ["codeExecution"], fromCodeExecution);
  }
  if (getValueByPath(fromObject, ["enterpriseWebSearch"]) !== void 0) {
    throw new Error("enterpriseWebSearch parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromFunctionDeclarations = getValueByPath(fromObject, [
    "functionDeclarations"
  ]);
  if (fromFunctionDeclarations != null) {
    let transformedList = fromFunctionDeclarations;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["functionDeclarations"], transformedList);
  }
  const fromGoogleSearchRetrieval = getValueByPath(fromObject, [
    "googleSearchRetrieval"
  ]);
  if (fromGoogleSearchRetrieval != null) {
    setValueByPath(toObject, ["googleSearchRetrieval"], fromGoogleSearchRetrieval);
  }
  if (getValueByPath(fromObject, ["parallelAiSearch"]) !== void 0) {
    throw new Error("parallelAiSearch parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromUrlContext = getValueByPath(fromObject, ["urlContext"]);
  if (fromUrlContext != null) {
    setValueByPath(toObject, ["urlContext"], fromUrlContext);
  }
  const fromMcpServers = getValueByPath(fromObject, ["mcpServers"]);
  if (fromMcpServers != null) {
    let transformedList = fromMcpServers;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["mcpServers"], transformedList);
  }
  return toObject;
}
__name(toolToMldev$3, "toolToMldev$3");
function toolToVertex$2(fromObject) {
  const toObject = {};
  const fromRetrieval = getValueByPath(fromObject, ["retrieval"]);
  if (fromRetrieval != null) {
    setValueByPath(toObject, ["retrieval"], fromRetrieval);
  }
  const fromComputerUse = getValueByPath(fromObject, ["computerUse"]);
  if (fromComputerUse != null) {
    setValueByPath(toObject, ["computerUse"], computerUseToVertex$2(fromComputerUse));
  }
  if (getValueByPath(fromObject, ["fileSearch"]) !== void 0) {
    throw new Error("fileSearch parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  const fromGoogleSearch = getValueByPath(fromObject, ["googleSearch"]);
  if (fromGoogleSearch != null) {
    setValueByPath(toObject, ["googleSearch"], fromGoogleSearch);
  }
  const fromGoogleMaps = getValueByPath(fromObject, ["googleMaps"]);
  if (fromGoogleMaps != null) {
    setValueByPath(toObject, ["googleMaps"], fromGoogleMaps);
  }
  const fromCodeExecution = getValueByPath(fromObject, [
    "codeExecution"
  ]);
  if (fromCodeExecution != null) {
    setValueByPath(toObject, ["codeExecution"], fromCodeExecution);
  }
  const fromEnterpriseWebSearch = getValueByPath(fromObject, [
    "enterpriseWebSearch"
  ]);
  if (fromEnterpriseWebSearch != null) {
    setValueByPath(toObject, ["enterpriseWebSearch"], fromEnterpriseWebSearch);
  }
  const fromFunctionDeclarations = getValueByPath(fromObject, [
    "functionDeclarations"
  ]);
  if (fromFunctionDeclarations != null) {
    let transformedList = fromFunctionDeclarations;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["functionDeclarations"], transformedList);
  }
  const fromGoogleSearchRetrieval = getValueByPath(fromObject, [
    "googleSearchRetrieval"
  ]);
  if (fromGoogleSearchRetrieval != null) {
    setValueByPath(toObject, ["googleSearchRetrieval"], fromGoogleSearchRetrieval);
  }
  const fromParallelAiSearch = getValueByPath(fromObject, [
    "parallelAiSearch"
  ]);
  if (fromParallelAiSearch != null) {
    setValueByPath(toObject, ["parallelAiSearch"], fromParallelAiSearch);
  }
  const fromUrlContext = getValueByPath(fromObject, ["urlContext"]);
  if (fromUrlContext != null) {
    setValueByPath(toObject, ["urlContext"], fromUrlContext);
  }
  if (getValueByPath(fromObject, ["mcpServers"]) !== void 0) {
    throw new Error("mcpServers parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  return toObject;
}
__name(toolToVertex$2, "toolToVertex$2");
function updateCachedContentConfigToMldev(fromObject, parentObject) {
  const toObject = {};
  const fromTtl = getValueByPath(fromObject, ["ttl"]);
  if (parentObject !== void 0 && fromTtl != null) {
    setValueByPath(parentObject, ["ttl"], fromTtl);
  }
  const fromExpireTime = getValueByPath(fromObject, ["expireTime"]);
  if (parentObject !== void 0 && fromExpireTime != null) {
    setValueByPath(parentObject, ["expireTime"], fromExpireTime);
  }
  return toObject;
}
__name(updateCachedContentConfigToMldev, "updateCachedContentConfigToMldev");
function updateCachedContentConfigToVertex(fromObject, parentObject) {
  const toObject = {};
  const fromTtl = getValueByPath(fromObject, ["ttl"]);
  if (parentObject !== void 0 && fromTtl != null) {
    setValueByPath(parentObject, ["ttl"], fromTtl);
  }
  const fromExpireTime = getValueByPath(fromObject, ["expireTime"]);
  if (parentObject !== void 0 && fromExpireTime != null) {
    setValueByPath(parentObject, ["expireTime"], fromExpireTime);
  }
  return toObject;
}
__name(updateCachedContentConfigToVertex, "updateCachedContentConfigToVertex");
function updateCachedContentParametersToMldev(apiClient, fromObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["_url", "name"], tCachedContentName(apiClient, fromName));
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    updateCachedContentConfigToMldev(fromConfig, toObject);
  }
  return toObject;
}
__name(updateCachedContentParametersToMldev, "updateCachedContentParametersToMldev");
function updateCachedContentParametersToVertex(apiClient, fromObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["_url", "name"], tCachedContentName(apiClient, fromName));
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    updateCachedContentConfigToVertex(fromConfig, toObject);
  }
  return toObject;
}
__name(updateCachedContentParametersToVertex, "updateCachedContentParametersToVertex");
var Caches = class extends BaseModule {
  static {
    __name(this, "Caches");
  }
  constructor(apiClient) {
    super();
    this.apiClient = apiClient;
    this.list = async (params = {}) => {
      return new Pager(PagedItem.PAGED_ITEM_CACHED_CONTENTS, (x) => this.listInternal(x), await this.listInternal(params), params);
    };
  }
  /**
   * Creates a cached contents resource.
   *
   * @remarks
   * Context caching is only supported for specific models. See [Gemini
   * Developer API reference](https://ai.google.dev/gemini-api/docs/caching?lang=node/context-cac)
   * and [Gemini Enterprise Agent Platform reference](https://cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview#supported_models)
   * for more information.
   *
   * @param params - The parameters for the create request.
   * @return The created cached content.
   *
   * @example
   * ```ts
   * const contents = ...; // Initialize the content to cache.
   * const response = await ai.caches.create({
   *   model: 'gemini-2.0-flash-001',
   *   config: {
   *    'contents': contents,
   *    'displayName': 'test cache',
   *    'systemInstruction': 'What is the sum of the two pdfs?',
   *    'ttl': '86400s',
   *  }
   * });
   * ```
   */
  async create(params) {
    var _a2, _b, _c, _d;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = createCachedContentParametersToVertex(this.apiClient, params);
      path2 = formatMap("cachedContents", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((resp) => {
        return resp;
      });
    } else {
      const body = createCachedContentParametersToMldev(this.apiClient, params);
      path2 = formatMap("cachedContents", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_c = params.config) === null || _c === void 0 ? void 0 : _c.httpOptions,
        abortSignal: (_d = params.config) === null || _d === void 0 ? void 0 : _d.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((resp) => {
        return resp;
      });
    }
  }
  /**
   * Gets cached content configurations.
   *
   * @param params - The parameters for the get request.
   * @return The cached content.
   *
   * @example
   * ```ts
   * await ai.caches.get({name: '...'}); // The server-generated resource name.
   * ```
   */
  async get(params) {
    var _a2, _b, _c, _d;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = getCachedContentParametersToVertex(this.apiClient, params);
      path2 = formatMap("{name}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "GET",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((resp) => {
        return resp;
      });
    } else {
      const body = getCachedContentParametersToMldev(this.apiClient, params);
      path2 = formatMap("{name}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "GET",
        httpOptions: (_c = params.config) === null || _c === void 0 ? void 0 : _c.httpOptions,
        abortSignal: (_d = params.config) === null || _d === void 0 ? void 0 : _d.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((resp) => {
        return resp;
      });
    }
  }
  /**
   * Deletes cached content.
   *
   * @param params - The parameters for the delete request.
   * @return The empty response returned by the API.
   *
   * @example
   * ```ts
   * await ai.caches.delete({name: '...'}); // The server-generated resource name.
   * ```
   */
  async delete(params) {
    var _a2, _b, _c, _d;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = deleteCachedContentParametersToVertex(this.apiClient, params);
      path2 = formatMap("{name}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "DELETE",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = deleteCachedContentResponseFromVertex(apiResponse);
        const typedResp = new DeleteCachedContentResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    } else {
      const body = deleteCachedContentParametersToMldev(this.apiClient, params);
      path2 = formatMap("{name}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "DELETE",
        httpOptions: (_c = params.config) === null || _c === void 0 ? void 0 : _c.httpOptions,
        abortSignal: (_d = params.config) === null || _d === void 0 ? void 0 : _d.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = deleteCachedContentResponseFromMldev(apiResponse);
        const typedResp = new DeleteCachedContentResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    }
  }
  /**
   * Updates cached content configurations.
   *
   * @param params - The parameters for the update request.
   * @return The updated cached content.
   *
   * @example
   * ```ts
   * const response = await ai.caches.update({
   *   name: '...',  // The server-generated resource name.
   *   config: {'ttl': '7600s'}
   * });
   * ```
   */
  async update(params) {
    var _a2, _b, _c, _d;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = updateCachedContentParametersToVertex(this.apiClient, params);
      path2 = formatMap("{name}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "PATCH",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((resp) => {
        return resp;
      });
    } else {
      const body = updateCachedContentParametersToMldev(this.apiClient, params);
      path2 = formatMap("{name}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "PATCH",
        httpOptions: (_c = params.config) === null || _c === void 0 ? void 0 : _c.httpOptions,
        abortSignal: (_d = params.config) === null || _d === void 0 ? void 0 : _d.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((resp) => {
        return resp;
      });
    }
  }
  async listInternal(params) {
    var _a2, _b, _c, _d;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = listCachedContentsParametersToVertex(params);
      path2 = formatMap("cachedContents", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "GET",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = listCachedContentsResponseFromVertex(apiResponse);
        const typedResp = new ListCachedContentsResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    } else {
      const body = listCachedContentsParametersToMldev(params);
      path2 = formatMap("cachedContents", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "GET",
        httpOptions: (_c = params.config) === null || _c === void 0 ? void 0 : _c.httpOptions,
        abortSignal: (_d = params.config) === null || _d === void 0 ? void 0 : _d.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = listCachedContentsResponseFromMldev(apiResponse);
        const typedResp = new ListCachedContentsResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    }
  }
};
function __rest(s, e) {
  var t = {};
  for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
    t[p] = s[p];
  if (s != null && typeof Object.getOwnPropertySymbols === "function")
    for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
      if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
        t[p[i]] = s[p[i]];
    }
  return t;
}
__name(__rest, "__rest");
function __values(o) {
  var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
  if (m) return m.call(o);
  if (o && typeof o.length === "number") return {
    next: /* @__PURE__ */ __name(function() {
      if (o && i >= o.length) o = void 0;
      return { value: o && o[i++], done: !o };
    }, "next")
  };
  throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
}
__name(__values, "__values");
function __await(v) {
  return this instanceof __await ? (this.v = v, this) : new __await(v);
}
__name(__await, "__await");
function __asyncGenerator(thisArg, _arguments, generator) {
  if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
  var g = generator.apply(thisArg, _arguments || []), i, q = [];
  return i = Object.create((typeof AsyncIterator === "function" ? AsyncIterator : Object).prototype), verb("next"), verb("throw"), verb("return", awaitReturn), i[Symbol.asyncIterator] = function() {
    return this;
  }, i;
  function awaitReturn(f) {
    return function(v) {
      return Promise.resolve(v).then(f, reject);
    };
  }
  __name(awaitReturn, "awaitReturn");
  function verb(n, f) {
    if (g[n]) {
      i[n] = function(v) {
        return new Promise(function(a, b) {
          q.push([n, v, a, b]) > 1 || resume(n, v);
        });
      };
      if (f) i[n] = f(i[n]);
    }
  }
  __name(verb, "verb");
  function resume(n, v) {
    try {
      step(g[n](v));
    } catch (e) {
      settle(q[0][3], e);
    }
  }
  __name(resume, "resume");
  function step(r) {
    r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r);
  }
  __name(step, "step");
  function fulfill(value) {
    resume("next", value);
  }
  __name(fulfill, "fulfill");
  function reject(value) {
    resume("throw", value);
  }
  __name(reject, "reject");
  function settle(f, v) {
    if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]);
  }
  __name(settle, "settle");
}
__name(__asyncGenerator, "__asyncGenerator");
function __asyncValues(o) {
  if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
  var m = o[Symbol.asyncIterator], i;
  return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function() {
    return this;
  }, i);
  function verb(n) {
    i[n] = o[n] && function(v) {
      return new Promise(function(resolve, reject) {
        v = o[n](v), settle(resolve, reject, v.done, v.value);
      });
    };
  }
  __name(verb, "verb");
  function settle(resolve, reject, d, v) {
    Promise.resolve(v).then(function(v2) {
      resolve({ value: v2, done: d });
    }, reject);
  }
  __name(settle, "settle");
}
__name(__asyncValues, "__asyncValues");
function isValidResponse(response) {
  var _a2;
  if (response.candidates == void 0 || response.candidates.length === 0) {
    return false;
  }
  const content = (_a2 = response.candidates[0]) === null || _a2 === void 0 ? void 0 : _a2.content;
  if (content === void 0) {
    return false;
  }
  return isValidContent(content);
}
__name(isValidResponse, "isValidResponse");
function isValidContent(content) {
  if (content.parts === void 0 || content.parts.length === 0) {
    return false;
  }
  for (const part of content.parts) {
    if (part === void 0 || Object.keys(part).length === 0) {
      return false;
    }
  }
  return true;
}
__name(isValidContent, "isValidContent");
function validateHistory(history) {
  if (history.length === 0) {
    return;
  }
  for (const content of history) {
    if (content.role !== "user" && content.role !== "model") {
      throw new Error(`Role must be user or model, but got ${content.role}.`);
    }
  }
}
__name(validateHistory, "validateHistory");
function extractCuratedHistory(comprehensiveHistory) {
  if (comprehensiveHistory === void 0 || comprehensiveHistory.length === 0) {
    return [];
  }
  const curatedHistory = [];
  const length = comprehensiveHistory.length;
  let i = 0;
  while (i < length) {
    if (comprehensiveHistory[i].role === "user") {
      curatedHistory.push(comprehensiveHistory[i]);
      i++;
    } else {
      const modelOutput = [];
      let isValid = true;
      while (i < length && comprehensiveHistory[i].role === "model") {
        modelOutput.push(comprehensiveHistory[i]);
        if (isValid && !isValidContent(comprehensiveHistory[i])) {
          isValid = false;
        }
        i++;
      }
      if (isValid) {
        curatedHistory.push(...modelOutput);
      } else {
        curatedHistory.pop();
      }
    }
  }
  return curatedHistory;
}
__name(extractCuratedHistory, "extractCuratedHistory");
var Chats = class {
  static {
    __name(this, "Chats");
  }
  constructor(modelsModule, apiClient) {
    this.modelsModule = modelsModule;
    this.apiClient = apiClient;
  }
  /**
   * Creates a new chat session.
   *
   * @remarks
   * The config in the params will be used for all requests within the chat
   * session unless overridden by a per-request `config` in
   * @see {@link types.SendMessageParameters#config}.
   *
   * @param params - Parameters for creating a chat session.
   * @returns A new chat session.
   *
   * @example
   * ```ts
   * const chat = ai.chats.create({
   *   model: 'gemini-2.0-flash'
   *   config: {
   *     temperature: 0.5,
   *     maxOutputTokens: 1024,
   *   }
   * });
   * ```
   */
  create(params) {
    return new Chat(
      this.apiClient,
      this.modelsModule,
      params.model,
      params.config,
      // Deep copy the history to avoid mutating the history outside of the
      // chat session.
      structuredClone(params.history)
    );
  }
};
var Chat = class {
  static {
    __name(this, "Chat");
  }
  constructor(apiClient, modelsModule, model, config = {}, history = []) {
    this.apiClient = apiClient;
    this.modelsModule = modelsModule;
    this.model = model;
    this.config = config;
    this.history = history;
    this.sendPromise = Promise.resolve();
    validateHistory(history);
  }
  /**
   * Sends a message to the model and returns the response.
   *
   * @remarks
   * This method will wait for the previous message to be processed before
   * sending the next message.
   *
   * @see {@link Chat#sendMessageStream} for streaming method.
   * @param params - parameters for sending messages within a chat session.
   * @returns The model's response.
   *
   * @example
   * ```ts
   * const chat = ai.chats.create({model: 'gemini-2.0-flash'});
   * const response = await chat.sendMessage({
   *   message: 'Why is the sky blue?'
   * });
   * console.log(response.text);
   * ```
   */
  async sendMessage(params) {
    var _a2;
    await this.sendPromise;
    const inputContent = tContent(params.message);
    const responsePromise = this.modelsModule.generateContent({
      model: this.model,
      contents: this.getHistory(true).concat(inputContent),
      config: (_a2 = params.config) !== null && _a2 !== void 0 ? _a2 : this.config
    });
    this.sendPromise = (async () => {
      var _a3, _b, _c;
      const response = await responsePromise;
      const outputContent = (_b = (_a3 = response.candidates) === null || _a3 === void 0 ? void 0 : _a3[0]) === null || _b === void 0 ? void 0 : _b.content;
      const fullAutomaticFunctionCallingHistory = response.automaticFunctionCallingHistory;
      const index = this.getHistory(true).length;
      let automaticFunctionCallingHistory = [];
      if (fullAutomaticFunctionCallingHistory != null) {
        automaticFunctionCallingHistory = (_c = fullAutomaticFunctionCallingHistory.slice(index)) !== null && _c !== void 0 ? _c : [];
      }
      const modelOutput = outputContent ? [outputContent] : [];
      this.recordHistory(inputContent, modelOutput, automaticFunctionCallingHistory);
      return;
    })();
    await this.sendPromise.catch(() => {
      this.sendPromise = Promise.resolve();
    });
    return responsePromise;
  }
  /**
   * Sends a message to the model and returns the response in chunks.
   *
   * @remarks
   * This method will wait for the previous message to be processed before
   * sending the next message.
   *
   * @see {@link Chat#sendMessage} for non-streaming method.
   * @param params - parameters for sending the message.
   * @return The model's response.
   *
   * @example
   * ```ts
   * const chat = ai.chats.create({model: 'gemini-2.0-flash'});
   * const response = await chat.sendMessageStream({
   *   message: 'Why is the sky blue?'
   * });
   * for await (const chunk of response) {
   *   console.log(chunk.text);
   * }
   * ```
   */
  async sendMessageStream(params) {
    var _a2;
    await this.sendPromise;
    const inputContent = tContent(params.message);
    const streamResponse = this.modelsModule.generateContentStream({
      model: this.model,
      contents: this.getHistory(true).concat(inputContent),
      config: (_a2 = params.config) !== null && _a2 !== void 0 ? _a2 : this.config
    });
    this.sendPromise = streamResponse.then(() => void 0).catch(() => void 0);
    const response = await streamResponse;
    const result = this.processStreamResponse(response, inputContent);
    return result;
  }
  /**
   * Returns the chat history.
   *
   * @remarks
   * The history is a list of contents alternating between user and model.
   *
   * There are two types of history:
   * - The `curated history` contains only the valid turns between user and
   * model, which will be included in the subsequent requests sent to the model.
   * - The `comprehensive history` contains all turns, including invalid or
   *   empty model outputs, providing a complete record of the history.
   *
   * The history is updated after receiving the response from the model,
   * for streaming response, it means receiving the last chunk of the response.
   *
   * The `comprehensive history` is returned by default. To get the `curated
   * history`, set the `curated` parameter to `true`.
   *
   * @param curated - whether to return the curated history or the comprehensive
   *     history.
   * @return History contents alternating between user and model for the entire
   *     chat session.
   */
  getHistory(curated = false) {
    const history = curated ? extractCuratedHistory(this.history) : this.history;
    return structuredClone(history);
  }
  processStreamResponse(streamResponse, inputContent) {
    return __asyncGenerator(this, arguments, /* @__PURE__ */ __name(function* processStreamResponse_1() {
      var _a2, e_1, _b, _c;
      var _d, _e;
      const outputContent = [];
      try {
        for (var _f = true, streamResponse_1 = __asyncValues(streamResponse), streamResponse_1_1; streamResponse_1_1 = yield __await(streamResponse_1.next()), _a2 = streamResponse_1_1.done, !_a2; _f = true) {
          _c = streamResponse_1_1.value;
          _f = false;
          const chunk = _c;
          if (isValidResponse(chunk)) {
            const content = (_e = (_d = chunk.candidates) === null || _d === void 0 ? void 0 : _d[0]) === null || _e === void 0 ? void 0 : _e.content;
            if (content !== void 0) {
              outputContent.push(content);
            }
          }
          yield yield __await(chunk);
        }
      } catch (e_1_1) {
        e_1 = { error: e_1_1 };
      } finally {
        try {
          if (!_f && !_a2 && (_b = streamResponse_1.return)) yield __await(_b.call(streamResponse_1));
        } finally {
          if (e_1) throw e_1.error;
        }
      }
      this.recordHistory(inputContent, outputContent);
    }, "processStreamResponse_1"));
  }
  recordHistory(userInput, modelOutput, automaticFunctionCallingHistory) {
    let outputContents = [];
    if (modelOutput.length > 0 && modelOutput.every((content) => content.role !== void 0)) {
      outputContents = modelOutput;
    } else {
      outputContents.push({
        role: "model",
        parts: []
      });
    }
    if (automaticFunctionCallingHistory && automaticFunctionCallingHistory.length > 0) {
      this.history.push(...extractCuratedHistory(automaticFunctionCallingHistory));
    } else {
      this.history.push(userInput);
    }
    this.history.push(...outputContents);
  }
};
var ApiError = class _ApiError extends Error {
  static {
    __name(this, "ApiError");
  }
  constructor(options) {
    super(options.message);
    this.name = "ApiError";
    this.status = options.status;
    Object.setPrototypeOf(this, _ApiError.prototype);
  }
};
function createFileParametersToMldev(fromObject) {
  const toObject = {};
  const fromFile = getValueByPath(fromObject, ["file"]);
  if (fromFile != null) {
    setValueByPath(toObject, ["file"], fromFile);
  }
  return toObject;
}
__name(createFileParametersToMldev, "createFileParametersToMldev");
function createFileResponseFromMldev(fromObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  return toObject;
}
__name(createFileResponseFromMldev, "createFileResponseFromMldev");
function deleteFileParametersToMldev(fromObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["_url", "file"], tFileName(fromName));
  }
  return toObject;
}
__name(deleteFileParametersToMldev, "deleteFileParametersToMldev");
function deleteFileResponseFromMldev(fromObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  return toObject;
}
__name(deleteFileResponseFromMldev, "deleteFileResponseFromMldev");
function getFileParametersToMldev(fromObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["_url", "file"], tFileName(fromName));
  }
  return toObject;
}
__name(getFileParametersToMldev, "getFileParametersToMldev");
function internalRegisterFilesParametersToMldev(fromObject) {
  const toObject = {};
  const fromUris = getValueByPath(fromObject, ["uris"]);
  if (fromUris != null) {
    setValueByPath(toObject, ["uris"], fromUris);
  }
  return toObject;
}
__name(internalRegisterFilesParametersToMldev, "internalRegisterFilesParametersToMldev");
function listFilesConfigToMldev(fromObject, parentObject) {
  const toObject = {};
  const fromPageSize = getValueByPath(fromObject, ["pageSize"]);
  if (parentObject !== void 0 && fromPageSize != null) {
    setValueByPath(parentObject, ["_query", "pageSize"], fromPageSize);
  }
  const fromPageToken = getValueByPath(fromObject, ["pageToken"]);
  if (parentObject !== void 0 && fromPageToken != null) {
    setValueByPath(parentObject, ["_query", "pageToken"], fromPageToken);
  }
  return toObject;
}
__name(listFilesConfigToMldev, "listFilesConfigToMldev");
function listFilesParametersToMldev(fromObject) {
  const toObject = {};
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    listFilesConfigToMldev(fromConfig, toObject);
  }
  return toObject;
}
__name(listFilesParametersToMldev, "listFilesParametersToMldev");
function listFilesResponseFromMldev(fromObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromNextPageToken = getValueByPath(fromObject, [
    "nextPageToken"
  ]);
  if (fromNextPageToken != null) {
    setValueByPath(toObject, ["nextPageToken"], fromNextPageToken);
  }
  const fromFiles = getValueByPath(fromObject, ["files"]);
  if (fromFiles != null) {
    let transformedList = fromFiles;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["files"], transformedList);
  }
  return toObject;
}
__name(listFilesResponseFromMldev, "listFilesResponseFromMldev");
function registerFilesResponseFromMldev(fromObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromFiles = getValueByPath(fromObject, ["files"]);
  if (fromFiles != null) {
    let transformedList = fromFiles;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["files"], transformedList);
  }
  return toObject;
}
__name(registerFilesResponseFromMldev, "registerFilesResponseFromMldev");
var Files = class extends BaseModule {
  static {
    __name(this, "Files");
  }
  constructor(apiClient) {
    super();
    this.apiClient = apiClient;
    this.list = async (params = {}) => {
      return new Pager(PagedItem.PAGED_ITEM_FILES, (x) => this.listInternal(x), await this.listInternal(params), params);
    };
  }
  /**
   * Uploads a file asynchronously to the Gemini API.
   * This method is not available in Gemini Enterprise Agent Platform (previously known as Vertex AI).
   * Supported upload sources:
   * - Node.js: File path (string) or Blob object.
   * - Browser: Blob object (e.g., File).
   *
   * @remarks
   * The `mimeType` can be specified in the `config` parameter. If omitted:
   *  - For file path (string) inputs, the `mimeType` will be inferred from the
   *     file extension.
   *  - For Blob object inputs, the `mimeType` will be set to the Blob's `type`
   *     property.
   * Somex eamples for file extension to mimeType mapping:
   * .txt -> text/plain
   * .json -> application/json
   * .jpg  -> image/jpeg
   * .png -> image/png
   * .mp3 -> audio/mpeg
   * .mp4 -> video/mp4
   *
   * This section can contain multiple paragraphs and code examples.
   *
   * @param params - Optional parameters specified in the
   *        `types.UploadFileParameters` interface.
   *         @see {@link types.UploadFileParameters#config} for the optional
   *         config in the parameters.
   * @return A promise that resolves to a `types.File` object.
   * @throws An error if called on a Gemini Enterprise Agent Platform (previously known as Vertex AI) client.
   * @throws An error if the `mimeType` is not provided and can not be inferred,
   * the `mimeType` can be provided in the `params.config` parameter.
   * @throws An error occurs if a suitable upload location cannot be established.
   *
   * @example
   * The following code uploads a file to Gemini API.
   *
   * ```ts
   * const file = await ai.files.upload({file: 'file.txt', config: {
   *   mimeType: 'text/plain',
   * }});
   * console.log(file.name);
   * ```
   */
  async upload(params) {
    if (this.apiClient.isVertexAI()) {
      throw new Error("Gemini Enterprise Agent Platform (previously known as Vertex AI) does not support uploading files. You can share files through a GCS bucket.");
    }
    return this.apiClient.uploadFile(params.file, params.config).then((resp) => {
      return resp;
    });
  }
  /**
   * Downloads a remotely stored file asynchronously to a location specified in
   * the `params` object. This method only works on Node environment, to
   * download files in the browser, use a browser compliant method like an <a>
   * tag.
   *
   * @param params - The parameters for the download request.
   *
   * @example
   * The following code downloads an example file named "files/mehozpxf877d" as
   * "file.txt".
   *
   * ```ts
   * await ai.files.download({file: file.name, downloadPath: 'file.txt'});
   * ```
   */
  async download(params) {
    await this.apiClient.downloadFile(params);
  }
  /**
   * Registers Google Cloud Storage files for use with the API.
   * This method is only available in Node.js environments.
   */
  async registerFiles(params) {
    throw new Error("registerFiles is only supported in Node.js environments.");
  }
  async _registerFiles(params) {
    return this.registerFilesInternal(params);
  }
  async listInternal(params) {
    var _a2, _b;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      throw new Error("This method is only supported by the Gemini Developer API.");
    } else {
      const body = listFilesParametersToMldev(params);
      path2 = formatMap("files", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "GET",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = listFilesResponseFromMldev(apiResponse);
        const typedResp = new ListFilesResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    }
  }
  async createInternal(params) {
    var _a2, _b;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      throw new Error("This method is only supported by the Gemini Developer API.");
    } else {
      const body = createFileParametersToMldev(params);
      path2 = formatMap("upload/v1beta/files", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((apiResponse) => {
        const resp = createFileResponseFromMldev(apiResponse);
        const typedResp = new CreateFileResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    }
  }
  /**
   * Retrieves the file information from the service.
   *
   * @param params - The parameters for the get request
   * @return The Promise that resolves to the types.File object requested.
   *
   * @example
   * ```ts
   * const config: GetFileParameters = {
   *   name: fileName,
   * };
   * file = await ai.files.get(config);
   * console.log(file.name);
   * ```
   */
  async get(params) {
    var _a2, _b;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      throw new Error("This method is only supported by the Gemini Developer API.");
    } else {
      const body = getFileParametersToMldev(params);
      path2 = formatMap("files/{file}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "GET",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((resp) => {
        return resp;
      });
    }
  }
  /**
   * Deletes a remotely stored file.
   *
   * @param params - The parameters for the delete request.
   * @return The DeleteFileResponse, the response for the delete method.
   *
   * @example
   * The following code deletes an example file named "files/mehozpxf877d".
   *
   * ```ts
   * await ai.files.delete({name: file.name});
   * ```
   */
  async delete(params) {
    var _a2, _b;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      throw new Error("This method is only supported by the Gemini Developer API.");
    } else {
      const body = deleteFileParametersToMldev(params);
      path2 = formatMap("files/{file}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "DELETE",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = deleteFileResponseFromMldev(apiResponse);
        const typedResp = new DeleteFileResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    }
  }
  async registerFilesInternal(params) {
    var _a2, _b;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      throw new Error("This method is only supported by the Gemini Developer API.");
    } else {
      const body = internalRegisterFilesParametersToMldev(params);
      path2 = formatMap("files:register", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((apiResponse) => {
        const resp = registerFilesResponseFromMldev(apiResponse);
        const typedResp = new RegisterFilesResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    }
  }
};
function audioTranscriptionConfigToMldev$1(fromObject) {
  const toObject = {};
  if (getValueByPath(fromObject, ["languageCodes"]) !== void 0) {
    throw new Error("languageCodes parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(audioTranscriptionConfigToMldev$1, "audioTranscriptionConfigToMldev$1");
function authConfigToMldev$2(fromObject) {
  const toObject = {};
  const fromApiKey = getValueByPath(fromObject, ["apiKey"]);
  if (fromApiKey != null) {
    setValueByPath(toObject, ["apiKey"], fromApiKey);
  }
  if (getValueByPath(fromObject, ["apiKeyConfig"]) !== void 0) {
    throw new Error("apiKeyConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["authType"]) !== void 0) {
    throw new Error("authType parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["googleServiceAccountConfig"]) !== void 0) {
    throw new Error("googleServiceAccountConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["httpBasicAuthConfig"]) !== void 0) {
    throw new Error("httpBasicAuthConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["oauthConfig"]) !== void 0) {
    throw new Error("oauthConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["oidcConfig"]) !== void 0) {
    throw new Error("oidcConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(authConfigToMldev$2, "authConfigToMldev$2");
function blobToMldev$2(fromObject) {
  const toObject = {};
  const fromData = getValueByPath(fromObject, ["data"]);
  if (fromData != null) {
    setValueByPath(toObject, ["data"], fromData);
  }
  if (getValueByPath(fromObject, ["displayName"]) !== void 0) {
    throw new Error("displayName parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromMimeType = getValueByPath(fromObject, ["mimeType"]);
  if (fromMimeType != null) {
    setValueByPath(toObject, ["mimeType"], fromMimeType);
  }
  return toObject;
}
__name(blobToMldev$2, "blobToMldev$2");
function codeExecutionResultToVertex$1(fromObject) {
  const toObject = {};
  const fromOutcome = getValueByPath(fromObject, ["outcome"]);
  if (fromOutcome != null) {
    setValueByPath(toObject, ["outcome"], fromOutcome);
  }
  const fromOutput = getValueByPath(fromObject, ["output"]);
  if (fromOutput != null) {
    setValueByPath(toObject, ["output"], fromOutput);
  }
  if (getValueByPath(fromObject, ["id"]) !== void 0) {
    throw new Error("id parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  return toObject;
}
__name(codeExecutionResultToVertex$1, "codeExecutionResultToVertex$1");
function computerUseToVertex$1(fromObject) {
  const toObject = {};
  const fromEnvironment = getValueByPath(fromObject, ["environment"]);
  if (fromEnvironment != null) {
    setValueByPath(toObject, ["environment"], fromEnvironment);
  }
  const fromExcludedPredefinedFunctions = getValueByPath(fromObject, [
    "excludedPredefinedFunctions"
  ]);
  if (fromExcludedPredefinedFunctions != null) {
    setValueByPath(toObject, ["excludedPredefinedFunctions"], fromExcludedPredefinedFunctions);
  }
  if (getValueByPath(fromObject, ["enablePromptInjectionDetection"]) !== void 0) {
    throw new Error("enablePromptInjectionDetection parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  return toObject;
}
__name(computerUseToVertex$1, "computerUseToVertex$1");
function contentToMldev$2(fromObject) {
  const toObject = {};
  const fromParts = getValueByPath(fromObject, ["parts"]);
  if (fromParts != null) {
    let transformedList = fromParts;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return partToMldev$2(item);
      });
    }
    setValueByPath(toObject, ["parts"], transformedList);
  }
  const fromRole = getValueByPath(fromObject, ["role"]);
  if (fromRole != null) {
    setValueByPath(toObject, ["role"], fromRole);
  }
  return toObject;
}
__name(contentToMldev$2, "contentToMldev$2");
function contentToVertex$1(fromObject) {
  const toObject = {};
  const fromParts = getValueByPath(fromObject, ["parts"]);
  if (fromParts != null) {
    let transformedList = fromParts;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return partToVertex$1(item);
      });
    }
    setValueByPath(toObject, ["parts"], transformedList);
  }
  const fromRole = getValueByPath(fromObject, ["role"]);
  if (fromRole != null) {
    setValueByPath(toObject, ["role"], fromRole);
  }
  return toObject;
}
__name(contentToVertex$1, "contentToVertex$1");
function executableCodeToVertex$1(fromObject) {
  const toObject = {};
  const fromCode = getValueByPath(fromObject, ["code"]);
  if (fromCode != null) {
    setValueByPath(toObject, ["code"], fromCode);
  }
  const fromLanguage = getValueByPath(fromObject, ["language"]);
  if (fromLanguage != null) {
    setValueByPath(toObject, ["language"], fromLanguage);
  }
  if (getValueByPath(fromObject, ["id"]) !== void 0) {
    throw new Error("id parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  return toObject;
}
__name(executableCodeToVertex$1, "executableCodeToVertex$1");
function fileDataToMldev$2(fromObject) {
  const toObject = {};
  if (getValueByPath(fromObject, ["displayName"]) !== void 0) {
    throw new Error("displayName parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromFileUri = getValueByPath(fromObject, ["fileUri"]);
  if (fromFileUri != null) {
    setValueByPath(toObject, ["fileUri"], fromFileUri);
  }
  const fromMimeType = getValueByPath(fromObject, ["mimeType"]);
  if (fromMimeType != null) {
    setValueByPath(toObject, ["mimeType"], fromMimeType);
  }
  return toObject;
}
__name(fileDataToMldev$2, "fileDataToMldev$2");
function functionCallToMldev$2(fromObject) {
  const toObject = {};
  const fromId = getValueByPath(fromObject, ["id"]);
  if (fromId != null) {
    setValueByPath(toObject, ["id"], fromId);
  }
  const fromArgs = getValueByPath(fromObject, ["args"]);
  if (fromArgs != null) {
    setValueByPath(toObject, ["args"], fromArgs);
  }
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["name"], fromName);
  }
  if (getValueByPath(fromObject, ["partialArgs"]) !== void 0) {
    throw new Error("partialArgs parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["willContinue"]) !== void 0) {
    throw new Error("willContinue parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(functionCallToMldev$2, "functionCallToMldev$2");
function generationConfigToVertex$1(fromObject) {
  const toObject = {};
  const fromModelSelectionConfig = getValueByPath(fromObject, [
    "modelSelectionConfig"
  ]);
  if (fromModelSelectionConfig != null) {
    setValueByPath(toObject, ["modelConfig"], fromModelSelectionConfig);
  }
  const fromResponseJsonSchema = getValueByPath(fromObject, [
    "responseJsonSchema"
  ]);
  if (fromResponseJsonSchema != null) {
    setValueByPath(toObject, ["responseJsonSchema"], fromResponseJsonSchema);
  }
  const fromAudioTimestamp = getValueByPath(fromObject, [
    "audioTimestamp"
  ]);
  if (fromAudioTimestamp != null) {
    setValueByPath(toObject, ["audioTimestamp"], fromAudioTimestamp);
  }
  const fromCandidateCount = getValueByPath(fromObject, [
    "candidateCount"
  ]);
  if (fromCandidateCount != null) {
    setValueByPath(toObject, ["candidateCount"], fromCandidateCount);
  }
  const fromEnableAffectiveDialog = getValueByPath(fromObject, [
    "enableAffectiveDialog"
  ]);
  if (fromEnableAffectiveDialog != null) {
    setValueByPath(toObject, ["enableAffectiveDialog"], fromEnableAffectiveDialog);
  }
  const fromFrequencyPenalty = getValueByPath(fromObject, [
    "frequencyPenalty"
  ]);
  if (fromFrequencyPenalty != null) {
    setValueByPath(toObject, ["frequencyPenalty"], fromFrequencyPenalty);
  }
  const fromLogprobs = getValueByPath(fromObject, ["logprobs"]);
  if (fromLogprobs != null) {
    setValueByPath(toObject, ["logprobs"], fromLogprobs);
  }
  const fromMaxOutputTokens = getValueByPath(fromObject, [
    "maxOutputTokens"
  ]);
  if (fromMaxOutputTokens != null) {
    setValueByPath(toObject, ["maxOutputTokens"], fromMaxOutputTokens);
  }
  const fromMediaResolution = getValueByPath(fromObject, [
    "mediaResolution"
  ]);
  if (fromMediaResolution != null) {
    setValueByPath(toObject, ["mediaResolution"], fromMediaResolution);
  }
  const fromPresencePenalty = getValueByPath(fromObject, [
    "presencePenalty"
  ]);
  if (fromPresencePenalty != null) {
    setValueByPath(toObject, ["presencePenalty"], fromPresencePenalty);
  }
  const fromResponseLogprobs = getValueByPath(fromObject, [
    "responseLogprobs"
  ]);
  if (fromResponseLogprobs != null) {
    setValueByPath(toObject, ["responseLogprobs"], fromResponseLogprobs);
  }
  const fromResponseMimeType = getValueByPath(fromObject, [
    "responseMimeType"
  ]);
  if (fromResponseMimeType != null) {
    setValueByPath(toObject, ["responseMimeType"], fromResponseMimeType);
  }
  const fromResponseModalities = getValueByPath(fromObject, [
    "responseModalities"
  ]);
  if (fromResponseModalities != null) {
    setValueByPath(toObject, ["responseModalities"], fromResponseModalities);
  }
  const fromResponseSchema = getValueByPath(fromObject, [
    "responseSchema"
  ]);
  if (fromResponseSchema != null) {
    setValueByPath(toObject, ["responseSchema"], fromResponseSchema);
  }
  const fromRoutingConfig = getValueByPath(fromObject, [
    "routingConfig"
  ]);
  if (fromRoutingConfig != null) {
    setValueByPath(toObject, ["routingConfig"], fromRoutingConfig);
  }
  const fromSeed = getValueByPath(fromObject, ["seed"]);
  if (fromSeed != null) {
    setValueByPath(toObject, ["seed"], fromSeed);
  }
  const fromSpeechConfig = getValueByPath(fromObject, ["speechConfig"]);
  if (fromSpeechConfig != null) {
    setValueByPath(toObject, ["speechConfig"], fromSpeechConfig);
  }
  const fromStopSequences = getValueByPath(fromObject, [
    "stopSequences"
  ]);
  if (fromStopSequences != null) {
    setValueByPath(toObject, ["stopSequences"], fromStopSequences);
  }
  const fromTemperature = getValueByPath(fromObject, ["temperature"]);
  if (fromTemperature != null) {
    setValueByPath(toObject, ["temperature"], fromTemperature);
  }
  const fromThinkingConfig = getValueByPath(fromObject, [
    "thinkingConfig"
  ]);
  if (fromThinkingConfig != null) {
    setValueByPath(toObject, ["thinkingConfig"], fromThinkingConfig);
  }
  const fromTopK = getValueByPath(fromObject, ["topK"]);
  if (fromTopK != null) {
    setValueByPath(toObject, ["topK"], fromTopK);
  }
  const fromTopP = getValueByPath(fromObject, ["topP"]);
  if (fromTopP != null) {
    setValueByPath(toObject, ["topP"], fromTopP);
  }
  if (getValueByPath(fromObject, ["enableEnhancedCivicAnswers"]) !== void 0) {
    throw new Error("enableEnhancedCivicAnswers parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  return toObject;
}
__name(generationConfigToVertex$1, "generationConfigToVertex$1");
function googleMapsToMldev$2(fromObject) {
  const toObject = {};
  const fromAuthConfig = getValueByPath(fromObject, ["authConfig"]);
  if (fromAuthConfig != null) {
    setValueByPath(toObject, ["authConfig"], authConfigToMldev$2(fromAuthConfig));
  }
  const fromEnableWidget = getValueByPath(fromObject, ["enableWidget"]);
  if (fromEnableWidget != null) {
    setValueByPath(toObject, ["enableWidget"], fromEnableWidget);
  }
  return toObject;
}
__name(googleMapsToMldev$2, "googleMapsToMldev$2");
function googleSearchToMldev$2(fromObject) {
  const toObject = {};
  const fromSearchTypes = getValueByPath(fromObject, ["searchTypes"]);
  if (fromSearchTypes != null) {
    setValueByPath(toObject, ["searchTypes"], fromSearchTypes);
  }
  if (getValueByPath(fromObject, ["blockingConfidence"]) !== void 0) {
    throw new Error("blockingConfidence parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["excludeDomains"]) !== void 0) {
    throw new Error("excludeDomains parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromTimeRangeFilter = getValueByPath(fromObject, [
    "timeRangeFilter"
  ]);
  if (fromTimeRangeFilter != null) {
    setValueByPath(toObject, ["timeRangeFilter"], fromTimeRangeFilter);
  }
  return toObject;
}
__name(googleSearchToMldev$2, "googleSearchToMldev$2");
function liveConnectConfigToMldev$1(fromObject, parentObject) {
  const toObject = {};
  const fromGenerationConfig = getValueByPath(fromObject, [
    "generationConfig"
  ]);
  if (parentObject !== void 0 && fromGenerationConfig != null) {
    setValueByPath(parentObject, ["setup", "generationConfig"], fromGenerationConfig);
  }
  const fromResponseModalities = getValueByPath(fromObject, [
    "responseModalities"
  ]);
  if (parentObject !== void 0 && fromResponseModalities != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "responseModalities"], fromResponseModalities);
  }
  const fromTemperature = getValueByPath(fromObject, ["temperature"]);
  if (parentObject !== void 0 && fromTemperature != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "temperature"], fromTemperature);
  }
  const fromTopP = getValueByPath(fromObject, ["topP"]);
  if (parentObject !== void 0 && fromTopP != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "topP"], fromTopP);
  }
  const fromTopK = getValueByPath(fromObject, ["topK"]);
  if (parentObject !== void 0 && fromTopK != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "topK"], fromTopK);
  }
  const fromMaxOutputTokens = getValueByPath(fromObject, [
    "maxOutputTokens"
  ]);
  if (parentObject !== void 0 && fromMaxOutputTokens != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "maxOutputTokens"], fromMaxOutputTokens);
  }
  const fromMediaResolution = getValueByPath(fromObject, [
    "mediaResolution"
  ]);
  if (parentObject !== void 0 && fromMediaResolution != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "mediaResolution"], fromMediaResolution);
  }
  const fromSeed = getValueByPath(fromObject, ["seed"]);
  if (parentObject !== void 0 && fromSeed != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "seed"], fromSeed);
  }
  const fromSpeechConfig = getValueByPath(fromObject, ["speechConfig"]);
  if (parentObject !== void 0 && fromSpeechConfig != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "speechConfig"], tLiveSpeechConfig(fromSpeechConfig));
  }
  const fromThinkingConfig = getValueByPath(fromObject, [
    "thinkingConfig"
  ]);
  if (parentObject !== void 0 && fromThinkingConfig != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "thinkingConfig"], fromThinkingConfig);
  }
  const fromEnableAffectiveDialog = getValueByPath(fromObject, [
    "enableAffectiveDialog"
  ]);
  if (parentObject !== void 0 && fromEnableAffectiveDialog != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "enableAffectiveDialog"], fromEnableAffectiveDialog);
  }
  const fromSystemInstruction = getValueByPath(fromObject, [
    "systemInstruction"
  ]);
  if (parentObject !== void 0 && fromSystemInstruction != null) {
    setValueByPath(parentObject, ["setup", "systemInstruction"], contentToMldev$2(tContent(fromSystemInstruction)));
  }
  const fromTools = getValueByPath(fromObject, ["tools"]);
  if (parentObject !== void 0 && fromTools != null) {
    let transformedList = tTools(fromTools);
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return toolToMldev$2(tTool(item));
      });
    }
    setValueByPath(parentObject, ["setup", "tools"], transformedList);
  }
  const fromSessionResumption = getValueByPath(fromObject, [
    "sessionResumption"
  ]);
  if (parentObject !== void 0 && fromSessionResumption != null) {
    setValueByPath(parentObject, ["setup", "sessionResumption"], sessionResumptionConfigToMldev$1(fromSessionResumption));
  }
  const fromInputAudioTranscription = getValueByPath(fromObject, [
    "inputAudioTranscription"
  ]);
  if (parentObject !== void 0 && fromInputAudioTranscription != null) {
    setValueByPath(parentObject, ["setup", "inputAudioTranscription"], audioTranscriptionConfigToMldev$1(fromInputAudioTranscription));
  }
  const fromOutputAudioTranscription = getValueByPath(fromObject, [
    "outputAudioTranscription"
  ]);
  if (parentObject !== void 0 && fromOutputAudioTranscription != null) {
    setValueByPath(parentObject, ["setup", "outputAudioTranscription"], audioTranscriptionConfigToMldev$1(fromOutputAudioTranscription));
  }
  const fromRealtimeInputConfig = getValueByPath(fromObject, [
    "realtimeInputConfig"
  ]);
  if (parentObject !== void 0 && fromRealtimeInputConfig != null) {
    setValueByPath(parentObject, ["setup", "realtimeInputConfig"], fromRealtimeInputConfig);
  }
  const fromContextWindowCompression = getValueByPath(fromObject, [
    "contextWindowCompression"
  ]);
  if (parentObject !== void 0 && fromContextWindowCompression != null) {
    setValueByPath(parentObject, ["setup", "contextWindowCompression"], fromContextWindowCompression);
  }
  const fromProactivity = getValueByPath(fromObject, ["proactivity"]);
  if (parentObject !== void 0 && fromProactivity != null) {
    setValueByPath(parentObject, ["setup", "proactivity"], fromProactivity);
  }
  if (getValueByPath(fromObject, ["explicitVadSignal"]) !== void 0) {
    throw new Error("explicitVadSignal parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromAvatarConfig = getValueByPath(fromObject, ["avatarConfig"]);
  if (parentObject !== void 0 && fromAvatarConfig != null) {
    setValueByPath(parentObject, ["setup", "avatarConfig"], fromAvatarConfig);
  }
  const fromSafetySettings = getValueByPath(fromObject, [
    "safetySettings"
  ]);
  if (parentObject !== void 0 && fromSafetySettings != null) {
    let transformedList = fromSafetySettings;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return safetySettingToMldev$2(item);
      });
    }
    setValueByPath(parentObject, ["setup", "safetySettings"], transformedList);
  }
  const fromStreamTranslationConfig = getValueByPath(fromObject, [
    "streamTranslationConfig"
  ]);
  if (parentObject !== void 0 && fromStreamTranslationConfig != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "streamTranslationConfig"], fromStreamTranslationConfig);
  }
  return toObject;
}
__name(liveConnectConfigToMldev$1, "liveConnectConfigToMldev$1");
function liveConnectConfigToVertex(fromObject, parentObject) {
  const toObject = {};
  const fromGenerationConfig = getValueByPath(fromObject, [
    "generationConfig"
  ]);
  if (parentObject !== void 0 && fromGenerationConfig != null) {
    setValueByPath(parentObject, ["setup", "generationConfig"], generationConfigToVertex$1(fromGenerationConfig));
  }
  const fromResponseModalities = getValueByPath(fromObject, [
    "responseModalities"
  ]);
  if (parentObject !== void 0 && fromResponseModalities != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "responseModalities"], fromResponseModalities);
  }
  const fromTemperature = getValueByPath(fromObject, ["temperature"]);
  if (parentObject !== void 0 && fromTemperature != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "temperature"], fromTemperature);
  }
  const fromTopP = getValueByPath(fromObject, ["topP"]);
  if (parentObject !== void 0 && fromTopP != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "topP"], fromTopP);
  }
  const fromTopK = getValueByPath(fromObject, ["topK"]);
  if (parentObject !== void 0 && fromTopK != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "topK"], fromTopK);
  }
  const fromMaxOutputTokens = getValueByPath(fromObject, [
    "maxOutputTokens"
  ]);
  if (parentObject !== void 0 && fromMaxOutputTokens != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "maxOutputTokens"], fromMaxOutputTokens);
  }
  const fromMediaResolution = getValueByPath(fromObject, [
    "mediaResolution"
  ]);
  if (parentObject !== void 0 && fromMediaResolution != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "mediaResolution"], fromMediaResolution);
  }
  const fromSeed = getValueByPath(fromObject, ["seed"]);
  if (parentObject !== void 0 && fromSeed != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "seed"], fromSeed);
  }
  const fromSpeechConfig = getValueByPath(fromObject, ["speechConfig"]);
  if (parentObject !== void 0 && fromSpeechConfig != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "speechConfig"], tLiveSpeechConfig(fromSpeechConfig));
  }
  const fromThinkingConfig = getValueByPath(fromObject, [
    "thinkingConfig"
  ]);
  if (parentObject !== void 0 && fromThinkingConfig != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "thinkingConfig"], fromThinkingConfig);
  }
  const fromEnableAffectiveDialog = getValueByPath(fromObject, [
    "enableAffectiveDialog"
  ]);
  if (parentObject !== void 0 && fromEnableAffectiveDialog != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "enableAffectiveDialog"], fromEnableAffectiveDialog);
  }
  const fromSystemInstruction = getValueByPath(fromObject, [
    "systemInstruction"
  ]);
  if (parentObject !== void 0 && fromSystemInstruction != null) {
    setValueByPath(parentObject, ["setup", "systemInstruction"], contentToVertex$1(tContent(fromSystemInstruction)));
  }
  const fromTools = getValueByPath(fromObject, ["tools"]);
  if (parentObject !== void 0 && fromTools != null) {
    let transformedList = tTools(fromTools);
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return toolToVertex$1(tTool(item));
      });
    }
    setValueByPath(parentObject, ["setup", "tools"], transformedList);
  }
  const fromSessionResumption = getValueByPath(fromObject, [
    "sessionResumption"
  ]);
  if (parentObject !== void 0 && fromSessionResumption != null) {
    setValueByPath(parentObject, ["setup", "sessionResumption"], fromSessionResumption);
  }
  const fromInputAudioTranscription = getValueByPath(fromObject, [
    "inputAudioTranscription"
  ]);
  if (parentObject !== void 0 && fromInputAudioTranscription != null) {
    setValueByPath(parentObject, ["setup", "inputAudioTranscription"], fromInputAudioTranscription);
  }
  const fromOutputAudioTranscription = getValueByPath(fromObject, [
    "outputAudioTranscription"
  ]);
  if (parentObject !== void 0 && fromOutputAudioTranscription != null) {
    setValueByPath(parentObject, ["setup", "outputAudioTranscription"], fromOutputAudioTranscription);
  }
  const fromRealtimeInputConfig = getValueByPath(fromObject, [
    "realtimeInputConfig"
  ]);
  if (parentObject !== void 0 && fromRealtimeInputConfig != null) {
    setValueByPath(parentObject, ["setup", "realtimeInputConfig"], fromRealtimeInputConfig);
  }
  const fromContextWindowCompression = getValueByPath(fromObject, [
    "contextWindowCompression"
  ]);
  if (parentObject !== void 0 && fromContextWindowCompression != null) {
    setValueByPath(parentObject, ["setup", "contextWindowCompression"], fromContextWindowCompression);
  }
  const fromProactivity = getValueByPath(fromObject, ["proactivity"]);
  if (parentObject !== void 0 && fromProactivity != null) {
    setValueByPath(parentObject, ["setup", "proactivity"], fromProactivity);
  }
  const fromExplicitVadSignal = getValueByPath(fromObject, [
    "explicitVadSignal"
  ]);
  if (parentObject !== void 0 && fromExplicitVadSignal != null) {
    setValueByPath(parentObject, ["setup", "explicitVadSignal"], fromExplicitVadSignal);
  }
  const fromAvatarConfig = getValueByPath(fromObject, ["avatarConfig"]);
  if (parentObject !== void 0 && fromAvatarConfig != null) {
    setValueByPath(parentObject, ["setup", "avatarConfig"], fromAvatarConfig);
  }
  const fromSafetySettings = getValueByPath(fromObject, [
    "safetySettings"
  ]);
  if (parentObject !== void 0 && fromSafetySettings != null) {
    let transformedList = fromSafetySettings;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(parentObject, ["setup", "safetySettings"], transformedList);
  }
  if (getValueByPath(fromObject, ["streamTranslationConfig"]) !== void 0) {
    throw new Error("streamTranslationConfig parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  return toObject;
}
__name(liveConnectConfigToVertex, "liveConnectConfigToVertex");
function liveConnectParametersToMldev(apiClient, fromObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["setup", "model"], tModel(apiClient, fromModel));
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    setValueByPath(toObject, ["config"], liveConnectConfigToMldev$1(fromConfig, toObject));
  }
  return toObject;
}
__name(liveConnectParametersToMldev, "liveConnectParametersToMldev");
function liveConnectParametersToVertex(apiClient, fromObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["setup", "model"], tModel(apiClient, fromModel));
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    setValueByPath(toObject, ["config"], liveConnectConfigToVertex(fromConfig, toObject));
  }
  return toObject;
}
__name(liveConnectParametersToVertex, "liveConnectParametersToVertex");
function liveMusicSetConfigParametersToMldev(fromObject) {
  const toObject = {};
  const fromMusicGenerationConfig = getValueByPath(fromObject, [
    "musicGenerationConfig"
  ]);
  if (fromMusicGenerationConfig != null) {
    setValueByPath(toObject, ["musicGenerationConfig"], fromMusicGenerationConfig);
  }
  return toObject;
}
__name(liveMusicSetConfigParametersToMldev, "liveMusicSetConfigParametersToMldev");
function liveMusicSetWeightedPromptsParametersToMldev(fromObject) {
  const toObject = {};
  const fromWeightedPrompts = getValueByPath(fromObject, [
    "weightedPrompts"
  ]);
  if (fromWeightedPrompts != null) {
    let transformedList = fromWeightedPrompts;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["weightedPrompts"], transformedList);
  }
  return toObject;
}
__name(liveMusicSetWeightedPromptsParametersToMldev, "liveMusicSetWeightedPromptsParametersToMldev");
function liveSendRealtimeInputParametersToMldev(fromObject) {
  const toObject = {};
  const fromMedia = getValueByPath(fromObject, ["media"]);
  if (fromMedia != null) {
    let transformedList = tBlobs(fromMedia);
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return blobToMldev$2(item);
      });
    }
    setValueByPath(toObject, ["mediaChunks"], transformedList);
  }
  const fromAudio = getValueByPath(fromObject, ["audio"]);
  if (fromAudio != null) {
    setValueByPath(toObject, ["audio"], blobToMldev$2(tAudioBlob(fromAudio)));
  }
  const fromAudioStreamEnd = getValueByPath(fromObject, [
    "audioStreamEnd"
  ]);
  if (fromAudioStreamEnd != null) {
    setValueByPath(toObject, ["audioStreamEnd"], fromAudioStreamEnd);
  }
  const fromVideo = getValueByPath(fromObject, ["video"]);
  if (fromVideo != null) {
    setValueByPath(toObject, ["video"], blobToMldev$2(tImageBlob(fromVideo)));
  }
  const fromText = getValueByPath(fromObject, ["text"]);
  if (fromText != null) {
    setValueByPath(toObject, ["text"], fromText);
  }
  const fromActivityStart = getValueByPath(fromObject, [
    "activityStart"
  ]);
  if (fromActivityStart != null) {
    setValueByPath(toObject, ["activityStart"], fromActivityStart);
  }
  const fromActivityEnd = getValueByPath(fromObject, ["activityEnd"]);
  if (fromActivityEnd != null) {
    setValueByPath(toObject, ["activityEnd"], fromActivityEnd);
  }
  return toObject;
}
__name(liveSendRealtimeInputParametersToMldev, "liveSendRealtimeInputParametersToMldev");
function liveSendRealtimeInputParametersToVertex(fromObject) {
  const toObject = {};
  const fromMedia = getValueByPath(fromObject, ["media"]);
  if (fromMedia != null) {
    let transformedList = tBlobs(fromMedia);
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["mediaChunks"], transformedList);
  }
  const fromAudio = getValueByPath(fromObject, ["audio"]);
  if (fromAudio != null) {
    setValueByPath(toObject, ["audio"], tAudioBlob(fromAudio));
  }
  const fromAudioStreamEnd = getValueByPath(fromObject, [
    "audioStreamEnd"
  ]);
  if (fromAudioStreamEnd != null) {
    setValueByPath(toObject, ["audioStreamEnd"], fromAudioStreamEnd);
  }
  const fromVideo = getValueByPath(fromObject, ["video"]);
  if (fromVideo != null) {
    setValueByPath(toObject, ["video"], tImageBlob(fromVideo));
  }
  const fromText = getValueByPath(fromObject, ["text"]);
  if (fromText != null) {
    setValueByPath(toObject, ["text"], fromText);
  }
  const fromActivityStart = getValueByPath(fromObject, [
    "activityStart"
  ]);
  if (fromActivityStart != null) {
    setValueByPath(toObject, ["activityStart"], fromActivityStart);
  }
  const fromActivityEnd = getValueByPath(fromObject, ["activityEnd"]);
  if (fromActivityEnd != null) {
    setValueByPath(toObject, ["activityEnd"], fromActivityEnd);
  }
  return toObject;
}
__name(liveSendRealtimeInputParametersToVertex, "liveSendRealtimeInputParametersToVertex");
function liveServerMessageFromVertex(fromObject) {
  const toObject = {};
  const fromSetupComplete = getValueByPath(fromObject, [
    "setupComplete"
  ]);
  if (fromSetupComplete != null) {
    setValueByPath(toObject, ["setupComplete"], fromSetupComplete);
  }
  const fromServerContent = getValueByPath(fromObject, [
    "serverContent"
  ]);
  if (fromServerContent != null) {
    setValueByPath(toObject, ["serverContent"], fromServerContent);
  }
  const fromToolCall = getValueByPath(fromObject, ["toolCall"]);
  if (fromToolCall != null) {
    setValueByPath(toObject, ["toolCall"], fromToolCall);
  }
  const fromToolCallCancellation = getValueByPath(fromObject, [
    "toolCallCancellation"
  ]);
  if (fromToolCallCancellation != null) {
    setValueByPath(toObject, ["toolCallCancellation"], fromToolCallCancellation);
  }
  const fromUsageMetadata = getValueByPath(fromObject, [
    "usageMetadata"
  ]);
  if (fromUsageMetadata != null) {
    setValueByPath(toObject, ["usageMetadata"], usageMetadataFromVertex(fromUsageMetadata));
  }
  const fromGoAway = getValueByPath(fromObject, ["goAway"]);
  if (fromGoAway != null) {
    setValueByPath(toObject, ["goAway"], fromGoAway);
  }
  const fromSessionResumptionUpdate = getValueByPath(fromObject, [
    "sessionResumptionUpdate"
  ]);
  if (fromSessionResumptionUpdate != null) {
    setValueByPath(toObject, ["sessionResumptionUpdate"], fromSessionResumptionUpdate);
  }
  const fromVoiceActivityDetectionSignal = getValueByPath(fromObject, [
    "voiceActivityDetectionSignal"
  ]);
  if (fromVoiceActivityDetectionSignal != null) {
    setValueByPath(toObject, ["voiceActivityDetectionSignal"], fromVoiceActivityDetectionSignal);
  }
  const fromVoiceActivity = getValueByPath(fromObject, [
    "voiceActivity"
  ]);
  if (fromVoiceActivity != null) {
    setValueByPath(toObject, ["voiceActivity"], voiceActivityFromVertex(fromVoiceActivity));
  }
  return toObject;
}
__name(liveServerMessageFromVertex, "liveServerMessageFromVertex");
function partToMldev$2(fromObject) {
  const toObject = {};
  const fromMediaResolution = getValueByPath(fromObject, [
    "mediaResolution"
  ]);
  if (fromMediaResolution != null) {
    setValueByPath(toObject, ["mediaResolution"], fromMediaResolution);
  }
  const fromCodeExecutionResult = getValueByPath(fromObject, [
    "codeExecutionResult"
  ]);
  if (fromCodeExecutionResult != null) {
    setValueByPath(toObject, ["codeExecutionResult"], fromCodeExecutionResult);
  }
  const fromExecutableCode = getValueByPath(fromObject, [
    "executableCode"
  ]);
  if (fromExecutableCode != null) {
    setValueByPath(toObject, ["executableCode"], fromExecutableCode);
  }
  const fromFileData = getValueByPath(fromObject, ["fileData"]);
  if (fromFileData != null) {
    setValueByPath(toObject, ["fileData"], fileDataToMldev$2(fromFileData));
  }
  const fromFunctionCall = getValueByPath(fromObject, ["functionCall"]);
  if (fromFunctionCall != null) {
    setValueByPath(toObject, ["functionCall"], functionCallToMldev$2(fromFunctionCall));
  }
  const fromFunctionResponse = getValueByPath(fromObject, [
    "functionResponse"
  ]);
  if (fromFunctionResponse != null) {
    setValueByPath(toObject, ["functionResponse"], fromFunctionResponse);
  }
  const fromInlineData = getValueByPath(fromObject, ["inlineData"]);
  if (fromInlineData != null) {
    setValueByPath(toObject, ["inlineData"], blobToMldev$2(fromInlineData));
  }
  const fromText = getValueByPath(fromObject, ["text"]);
  if (fromText != null) {
    setValueByPath(toObject, ["text"], fromText);
  }
  const fromThought = getValueByPath(fromObject, ["thought"]);
  if (fromThought != null) {
    setValueByPath(toObject, ["thought"], fromThought);
  }
  const fromThoughtSignature = getValueByPath(fromObject, [
    "thoughtSignature"
  ]);
  if (fromThoughtSignature != null) {
    setValueByPath(toObject, ["thoughtSignature"], fromThoughtSignature);
  }
  const fromVideoMetadata = getValueByPath(fromObject, [
    "videoMetadata"
  ]);
  if (fromVideoMetadata != null) {
    setValueByPath(toObject, ["videoMetadata"], fromVideoMetadata);
  }
  const fromToolCall = getValueByPath(fromObject, ["toolCall"]);
  if (fromToolCall != null) {
    setValueByPath(toObject, ["toolCall"], fromToolCall);
  }
  const fromToolResponse = getValueByPath(fromObject, ["toolResponse"]);
  if (fromToolResponse != null) {
    setValueByPath(toObject, ["toolResponse"], fromToolResponse);
  }
  const fromPartMetadata = getValueByPath(fromObject, ["partMetadata"]);
  if (fromPartMetadata != null) {
    setValueByPath(toObject, ["partMetadata"], fromPartMetadata);
  }
  return toObject;
}
__name(partToMldev$2, "partToMldev$2");
function partToVertex$1(fromObject) {
  const toObject = {};
  const fromMediaResolution = getValueByPath(fromObject, [
    "mediaResolution"
  ]);
  if (fromMediaResolution != null) {
    setValueByPath(toObject, ["mediaResolution"], fromMediaResolution);
  }
  const fromCodeExecutionResult = getValueByPath(fromObject, [
    "codeExecutionResult"
  ]);
  if (fromCodeExecutionResult != null) {
    setValueByPath(toObject, ["codeExecutionResult"], codeExecutionResultToVertex$1(fromCodeExecutionResult));
  }
  const fromExecutableCode = getValueByPath(fromObject, [
    "executableCode"
  ]);
  if (fromExecutableCode != null) {
    setValueByPath(toObject, ["executableCode"], executableCodeToVertex$1(fromExecutableCode));
  }
  const fromFileData = getValueByPath(fromObject, ["fileData"]);
  if (fromFileData != null) {
    setValueByPath(toObject, ["fileData"], fromFileData);
  }
  const fromFunctionCall = getValueByPath(fromObject, ["functionCall"]);
  if (fromFunctionCall != null) {
    setValueByPath(toObject, ["functionCall"], fromFunctionCall);
  }
  const fromFunctionResponse = getValueByPath(fromObject, [
    "functionResponse"
  ]);
  if (fromFunctionResponse != null) {
    setValueByPath(toObject, ["functionResponse"], fromFunctionResponse);
  }
  const fromInlineData = getValueByPath(fromObject, ["inlineData"]);
  if (fromInlineData != null) {
    setValueByPath(toObject, ["inlineData"], fromInlineData);
  }
  const fromText = getValueByPath(fromObject, ["text"]);
  if (fromText != null) {
    setValueByPath(toObject, ["text"], fromText);
  }
  const fromThought = getValueByPath(fromObject, ["thought"]);
  if (fromThought != null) {
    setValueByPath(toObject, ["thought"], fromThought);
  }
  const fromThoughtSignature = getValueByPath(fromObject, [
    "thoughtSignature"
  ]);
  if (fromThoughtSignature != null) {
    setValueByPath(toObject, ["thoughtSignature"], fromThoughtSignature);
  }
  const fromVideoMetadata = getValueByPath(fromObject, [
    "videoMetadata"
  ]);
  if (fromVideoMetadata != null) {
    setValueByPath(toObject, ["videoMetadata"], fromVideoMetadata);
  }
  if (getValueByPath(fromObject, ["toolCall"]) !== void 0) {
    throw new Error("toolCall parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  if (getValueByPath(fromObject, ["toolResponse"]) !== void 0) {
    throw new Error("toolResponse parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  if (getValueByPath(fromObject, ["partMetadata"]) !== void 0) {
    throw new Error("partMetadata parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  return toObject;
}
__name(partToVertex$1, "partToVertex$1");
function safetySettingToMldev$2(fromObject) {
  const toObject = {};
  const fromCategory = getValueByPath(fromObject, ["category"]);
  if (fromCategory != null) {
    setValueByPath(toObject, ["category"], fromCategory);
  }
  if (getValueByPath(fromObject, ["method"]) !== void 0) {
    throw new Error("method parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromThreshold = getValueByPath(fromObject, ["threshold"]);
  if (fromThreshold != null) {
    setValueByPath(toObject, ["threshold"], fromThreshold);
  }
  return toObject;
}
__name(safetySettingToMldev$2, "safetySettingToMldev$2");
function sessionResumptionConfigToMldev$1(fromObject) {
  const toObject = {};
  const fromHandle = getValueByPath(fromObject, ["handle"]);
  if (fromHandle != null) {
    setValueByPath(toObject, ["handle"], fromHandle);
  }
  if (getValueByPath(fromObject, ["transparent"]) !== void 0) {
    throw new Error("transparent parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(sessionResumptionConfigToMldev$1, "sessionResumptionConfigToMldev$1");
function toolToMldev$2(fromObject) {
  const toObject = {};
  if (getValueByPath(fromObject, ["retrieval"]) !== void 0) {
    throw new Error("retrieval parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromComputerUse = getValueByPath(fromObject, ["computerUse"]);
  if (fromComputerUse != null) {
    setValueByPath(toObject, ["computerUse"], fromComputerUse);
  }
  const fromFileSearch = getValueByPath(fromObject, ["fileSearch"]);
  if (fromFileSearch != null) {
    setValueByPath(toObject, ["fileSearch"], fromFileSearch);
  }
  const fromGoogleSearch = getValueByPath(fromObject, ["googleSearch"]);
  if (fromGoogleSearch != null) {
    setValueByPath(toObject, ["googleSearch"], googleSearchToMldev$2(fromGoogleSearch));
  }
  const fromGoogleMaps = getValueByPath(fromObject, ["googleMaps"]);
  if (fromGoogleMaps != null) {
    setValueByPath(toObject, ["googleMaps"], googleMapsToMldev$2(fromGoogleMaps));
  }
  const fromCodeExecution = getValueByPath(fromObject, [
    "codeExecution"
  ]);
  if (fromCodeExecution != null) {
    setValueByPath(toObject, ["codeExecution"], fromCodeExecution);
  }
  if (getValueByPath(fromObject, ["enterpriseWebSearch"]) !== void 0) {
    throw new Error("enterpriseWebSearch parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromFunctionDeclarations = getValueByPath(fromObject, [
    "functionDeclarations"
  ]);
  if (fromFunctionDeclarations != null) {
    let transformedList = fromFunctionDeclarations;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["functionDeclarations"], transformedList);
  }
  const fromGoogleSearchRetrieval = getValueByPath(fromObject, [
    "googleSearchRetrieval"
  ]);
  if (fromGoogleSearchRetrieval != null) {
    setValueByPath(toObject, ["googleSearchRetrieval"], fromGoogleSearchRetrieval);
  }
  if (getValueByPath(fromObject, ["parallelAiSearch"]) !== void 0) {
    throw new Error("parallelAiSearch parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromUrlContext = getValueByPath(fromObject, ["urlContext"]);
  if (fromUrlContext != null) {
    setValueByPath(toObject, ["urlContext"], fromUrlContext);
  }
  const fromMcpServers = getValueByPath(fromObject, ["mcpServers"]);
  if (fromMcpServers != null) {
    let transformedList = fromMcpServers;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["mcpServers"], transformedList);
  }
  return toObject;
}
__name(toolToMldev$2, "toolToMldev$2");
function toolToVertex$1(fromObject) {
  const toObject = {};
  const fromRetrieval = getValueByPath(fromObject, ["retrieval"]);
  if (fromRetrieval != null) {
    setValueByPath(toObject, ["retrieval"], fromRetrieval);
  }
  const fromComputerUse = getValueByPath(fromObject, ["computerUse"]);
  if (fromComputerUse != null) {
    setValueByPath(toObject, ["computerUse"], computerUseToVertex$1(fromComputerUse));
  }
  if (getValueByPath(fromObject, ["fileSearch"]) !== void 0) {
    throw new Error("fileSearch parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  const fromGoogleSearch = getValueByPath(fromObject, ["googleSearch"]);
  if (fromGoogleSearch != null) {
    setValueByPath(toObject, ["googleSearch"], fromGoogleSearch);
  }
  const fromGoogleMaps = getValueByPath(fromObject, ["googleMaps"]);
  if (fromGoogleMaps != null) {
    setValueByPath(toObject, ["googleMaps"], fromGoogleMaps);
  }
  const fromCodeExecution = getValueByPath(fromObject, [
    "codeExecution"
  ]);
  if (fromCodeExecution != null) {
    setValueByPath(toObject, ["codeExecution"], fromCodeExecution);
  }
  const fromEnterpriseWebSearch = getValueByPath(fromObject, [
    "enterpriseWebSearch"
  ]);
  if (fromEnterpriseWebSearch != null) {
    setValueByPath(toObject, ["enterpriseWebSearch"], fromEnterpriseWebSearch);
  }
  const fromFunctionDeclarations = getValueByPath(fromObject, [
    "functionDeclarations"
  ]);
  if (fromFunctionDeclarations != null) {
    let transformedList = fromFunctionDeclarations;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["functionDeclarations"], transformedList);
  }
  const fromGoogleSearchRetrieval = getValueByPath(fromObject, [
    "googleSearchRetrieval"
  ]);
  if (fromGoogleSearchRetrieval != null) {
    setValueByPath(toObject, ["googleSearchRetrieval"], fromGoogleSearchRetrieval);
  }
  const fromParallelAiSearch = getValueByPath(fromObject, [
    "parallelAiSearch"
  ]);
  if (fromParallelAiSearch != null) {
    setValueByPath(toObject, ["parallelAiSearch"], fromParallelAiSearch);
  }
  const fromUrlContext = getValueByPath(fromObject, ["urlContext"]);
  if (fromUrlContext != null) {
    setValueByPath(toObject, ["urlContext"], fromUrlContext);
  }
  if (getValueByPath(fromObject, ["mcpServers"]) !== void 0) {
    throw new Error("mcpServers parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  return toObject;
}
__name(toolToVertex$1, "toolToVertex$1");
function usageMetadataFromVertex(fromObject) {
  const toObject = {};
  const fromPromptTokenCount = getValueByPath(fromObject, [
    "promptTokenCount"
  ]);
  if (fromPromptTokenCount != null) {
    setValueByPath(toObject, ["promptTokenCount"], fromPromptTokenCount);
  }
  const fromCachedContentTokenCount = getValueByPath(fromObject, [
    "cachedContentTokenCount"
  ]);
  if (fromCachedContentTokenCount != null) {
    setValueByPath(toObject, ["cachedContentTokenCount"], fromCachedContentTokenCount);
  }
  const fromResponseTokenCount = getValueByPath(fromObject, [
    "candidatesTokenCount"
  ]);
  if (fromResponseTokenCount != null) {
    setValueByPath(toObject, ["responseTokenCount"], fromResponseTokenCount);
  }
  const fromToolUsePromptTokenCount = getValueByPath(fromObject, [
    "toolUsePromptTokenCount"
  ]);
  if (fromToolUsePromptTokenCount != null) {
    setValueByPath(toObject, ["toolUsePromptTokenCount"], fromToolUsePromptTokenCount);
  }
  const fromThoughtsTokenCount = getValueByPath(fromObject, [
    "thoughtsTokenCount"
  ]);
  if (fromThoughtsTokenCount != null) {
    setValueByPath(toObject, ["thoughtsTokenCount"], fromThoughtsTokenCount);
  }
  const fromTotalTokenCount = getValueByPath(fromObject, [
    "totalTokenCount"
  ]);
  if (fromTotalTokenCount != null) {
    setValueByPath(toObject, ["totalTokenCount"], fromTotalTokenCount);
  }
  const fromPromptTokensDetails = getValueByPath(fromObject, [
    "promptTokensDetails"
  ]);
  if (fromPromptTokensDetails != null) {
    let transformedList = fromPromptTokensDetails;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["promptTokensDetails"], transformedList);
  }
  const fromCacheTokensDetails = getValueByPath(fromObject, [
    "cacheTokensDetails"
  ]);
  if (fromCacheTokensDetails != null) {
    let transformedList = fromCacheTokensDetails;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["cacheTokensDetails"], transformedList);
  }
  const fromResponseTokensDetails = getValueByPath(fromObject, [
    "candidatesTokensDetails"
  ]);
  if (fromResponseTokensDetails != null) {
    let transformedList = fromResponseTokensDetails;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["responseTokensDetails"], transformedList);
  }
  const fromToolUsePromptTokensDetails = getValueByPath(fromObject, [
    "toolUsePromptTokensDetails"
  ]);
  if (fromToolUsePromptTokensDetails != null) {
    let transformedList = fromToolUsePromptTokensDetails;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["toolUsePromptTokensDetails"], transformedList);
  }
  const fromTrafficType = getValueByPath(fromObject, ["trafficType"]);
  if (fromTrafficType != null) {
    setValueByPath(toObject, ["trafficType"], fromTrafficType);
  }
  return toObject;
}
__name(usageMetadataFromVertex, "usageMetadataFromVertex");
function voiceActivityFromVertex(fromObject) {
  const toObject = {};
  const fromVoiceActivityType = getValueByPath(fromObject, ["type"]);
  if (fromVoiceActivityType != null) {
    setValueByPath(toObject, ["voiceActivityType"], fromVoiceActivityType);
  }
  return toObject;
}
__name(voiceActivityFromVertex, "voiceActivityFromVertex");
function authConfigToMldev$1(fromObject, _rootObject) {
  const toObject = {};
  const fromApiKey = getValueByPath(fromObject, ["apiKey"]);
  if (fromApiKey != null) {
    setValueByPath(toObject, ["apiKey"], fromApiKey);
  }
  if (getValueByPath(fromObject, ["apiKeyConfig"]) !== void 0) {
    throw new Error("apiKeyConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["authType"]) !== void 0) {
    throw new Error("authType parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["googleServiceAccountConfig"]) !== void 0) {
    throw new Error("googleServiceAccountConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["httpBasicAuthConfig"]) !== void 0) {
    throw new Error("httpBasicAuthConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["oauthConfig"]) !== void 0) {
    throw new Error("oauthConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["oidcConfig"]) !== void 0) {
    throw new Error("oidcConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(authConfigToMldev$1, "authConfigToMldev$1");
function blobToMldev$1(fromObject, _rootObject) {
  const toObject = {};
  const fromData = getValueByPath(fromObject, ["data"]);
  if (fromData != null) {
    setValueByPath(toObject, ["data"], fromData);
  }
  if (getValueByPath(fromObject, ["displayName"]) !== void 0) {
    throw new Error("displayName parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromMimeType = getValueByPath(fromObject, ["mimeType"]);
  if (fromMimeType != null) {
    setValueByPath(toObject, ["mimeType"], fromMimeType);
  }
  return toObject;
}
__name(blobToMldev$1, "blobToMldev$1");
function candidateFromMldev(fromObject, rootObject) {
  const toObject = {};
  const fromContent = getValueByPath(fromObject, ["content"]);
  if (fromContent != null) {
    setValueByPath(toObject, ["content"], fromContent);
  }
  const fromCitationMetadata = getValueByPath(fromObject, [
    "citationMetadata"
  ]);
  if (fromCitationMetadata != null) {
    setValueByPath(toObject, ["citationMetadata"], citationMetadataFromMldev(fromCitationMetadata));
  }
  const fromTokenCount = getValueByPath(fromObject, ["tokenCount"]);
  if (fromTokenCount != null) {
    setValueByPath(toObject, ["tokenCount"], fromTokenCount);
  }
  const fromFinishReason = getValueByPath(fromObject, ["finishReason"]);
  if (fromFinishReason != null) {
    setValueByPath(toObject, ["finishReason"], fromFinishReason);
  }
  const fromGroundingMetadata = getValueByPath(fromObject, [
    "groundingMetadata"
  ]);
  if (fromGroundingMetadata != null) {
    setValueByPath(toObject, ["groundingMetadata"], fromGroundingMetadata);
  }
  const fromAvgLogprobs = getValueByPath(fromObject, ["avgLogprobs"]);
  if (fromAvgLogprobs != null) {
    setValueByPath(toObject, ["avgLogprobs"], fromAvgLogprobs);
  }
  const fromIndex = getValueByPath(fromObject, ["index"]);
  if (fromIndex != null) {
    setValueByPath(toObject, ["index"], fromIndex);
  }
  const fromLogprobsResult = getValueByPath(fromObject, [
    "logprobsResult"
  ]);
  if (fromLogprobsResult != null) {
    setValueByPath(toObject, ["logprobsResult"], fromLogprobsResult);
  }
  const fromSafetyRatings = getValueByPath(fromObject, [
    "safetyRatings"
  ]);
  if (fromSafetyRatings != null) {
    let transformedList = fromSafetyRatings;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["safetyRatings"], transformedList);
  }
  const fromUrlContextMetadata = getValueByPath(fromObject, [
    "urlContextMetadata"
  ]);
  if (fromUrlContextMetadata != null) {
    setValueByPath(toObject, ["urlContextMetadata"], fromUrlContextMetadata);
  }
  return toObject;
}
__name(candidateFromMldev, "candidateFromMldev");
function citationMetadataFromMldev(fromObject, _rootObject) {
  const toObject = {};
  const fromCitations = getValueByPath(fromObject, ["citationSources"]);
  if (fromCitations != null) {
    let transformedList = fromCitations;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["citations"], transformedList);
  }
  return toObject;
}
__name(citationMetadataFromMldev, "citationMetadataFromMldev");
function codeExecutionResultToVertex(fromObject, _rootObject) {
  const toObject = {};
  const fromOutcome = getValueByPath(fromObject, ["outcome"]);
  if (fromOutcome != null) {
    setValueByPath(toObject, ["outcome"], fromOutcome);
  }
  const fromOutput = getValueByPath(fromObject, ["output"]);
  if (fromOutput != null) {
    setValueByPath(toObject, ["output"], fromOutput);
  }
  if (getValueByPath(fromObject, ["id"]) !== void 0) {
    throw new Error("id parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  return toObject;
}
__name(codeExecutionResultToVertex, "codeExecutionResultToVertex");
function computeTokensParametersToVertex(apiClient, fromObject, rootObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["_url", "model"], tModel(apiClient, fromModel));
  }
  const fromContents = getValueByPath(fromObject, ["contents"]);
  if (fromContents != null) {
    let transformedList = tContents(fromContents);
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return contentToVertex(item);
      });
    }
    setValueByPath(toObject, ["contents"], transformedList);
  }
  return toObject;
}
__name(computeTokensParametersToVertex, "computeTokensParametersToVertex");
function computeTokensResponseFromVertex(fromObject, _rootObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromTokensInfo = getValueByPath(fromObject, ["tokensInfo"]);
  if (fromTokensInfo != null) {
    let transformedList = fromTokensInfo;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["tokensInfo"], transformedList);
  }
  return toObject;
}
__name(computeTokensResponseFromVertex, "computeTokensResponseFromVertex");
function computerUseToVertex(fromObject, _rootObject) {
  const toObject = {};
  const fromEnvironment = getValueByPath(fromObject, ["environment"]);
  if (fromEnvironment != null) {
    setValueByPath(toObject, ["environment"], fromEnvironment);
  }
  const fromExcludedPredefinedFunctions = getValueByPath(fromObject, [
    "excludedPredefinedFunctions"
  ]);
  if (fromExcludedPredefinedFunctions != null) {
    setValueByPath(toObject, ["excludedPredefinedFunctions"], fromExcludedPredefinedFunctions);
  }
  if (getValueByPath(fromObject, ["enablePromptInjectionDetection"]) !== void 0) {
    throw new Error("enablePromptInjectionDetection parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  return toObject;
}
__name(computerUseToVertex, "computerUseToVertex");
function contentEmbeddingFromVertex(fromObject, rootObject) {
  const toObject = {};
  const fromValues = getValueByPath(fromObject, ["values"]);
  if (fromValues != null) {
    setValueByPath(toObject, ["values"], fromValues);
  }
  const fromStatistics = getValueByPath(fromObject, ["statistics"]);
  if (fromStatistics != null) {
    setValueByPath(toObject, ["statistics"], contentEmbeddingStatisticsFromVertex(fromStatistics));
  }
  return toObject;
}
__name(contentEmbeddingFromVertex, "contentEmbeddingFromVertex");
function contentEmbeddingStatisticsFromVertex(fromObject, _rootObject) {
  const toObject = {};
  const fromTruncated = getValueByPath(fromObject, ["truncated"]);
  if (fromTruncated != null) {
    setValueByPath(toObject, ["truncated"], fromTruncated);
  }
  const fromTokenCount = getValueByPath(fromObject, ["token_count"]);
  if (fromTokenCount != null) {
    setValueByPath(toObject, ["tokenCount"], fromTokenCount);
  }
  return toObject;
}
__name(contentEmbeddingStatisticsFromVertex, "contentEmbeddingStatisticsFromVertex");
function contentToMldev$1(fromObject, rootObject) {
  const toObject = {};
  const fromParts = getValueByPath(fromObject, ["parts"]);
  if (fromParts != null) {
    let transformedList = fromParts;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return partToMldev$1(item);
      });
    }
    setValueByPath(toObject, ["parts"], transformedList);
  }
  const fromRole = getValueByPath(fromObject, ["role"]);
  if (fromRole != null) {
    setValueByPath(toObject, ["role"], fromRole);
  }
  return toObject;
}
__name(contentToMldev$1, "contentToMldev$1");
function contentToVertex(fromObject, rootObject) {
  const toObject = {};
  const fromParts = getValueByPath(fromObject, ["parts"]);
  if (fromParts != null) {
    let transformedList = fromParts;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return partToVertex(item);
      });
    }
    setValueByPath(toObject, ["parts"], transformedList);
  }
  const fromRole = getValueByPath(fromObject, ["role"]);
  if (fromRole != null) {
    setValueByPath(toObject, ["role"], fromRole);
  }
  return toObject;
}
__name(contentToVertex, "contentToVertex");
function controlReferenceConfigToVertex(fromObject, _rootObject) {
  const toObject = {};
  const fromControlType = getValueByPath(fromObject, ["controlType"]);
  if (fromControlType != null) {
    setValueByPath(toObject, ["controlType"], fromControlType);
  }
  const fromEnableControlImageComputation = getValueByPath(fromObject, [
    "enableControlImageComputation"
  ]);
  if (fromEnableControlImageComputation != null) {
    setValueByPath(toObject, ["computeControl"], fromEnableControlImageComputation);
  }
  return toObject;
}
__name(controlReferenceConfigToVertex, "controlReferenceConfigToVertex");
function countTokensConfigToMldev(fromObject, _rootObject) {
  const toObject = {};
  if (getValueByPath(fromObject, ["systemInstruction"]) !== void 0) {
    throw new Error("systemInstruction parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["tools"]) !== void 0) {
    throw new Error("tools parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["generationConfig"]) !== void 0) {
    throw new Error("generationConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(countTokensConfigToMldev, "countTokensConfigToMldev");
function countTokensConfigToVertex(fromObject, parentObject, rootObject) {
  const toObject = {};
  const fromSystemInstruction = getValueByPath(fromObject, [
    "systemInstruction"
  ]);
  if (parentObject !== void 0 && fromSystemInstruction != null) {
    setValueByPath(parentObject, ["systemInstruction"], contentToVertex(tContent(fromSystemInstruction)));
  }
  const fromTools = getValueByPath(fromObject, ["tools"]);
  if (parentObject !== void 0 && fromTools != null) {
    let transformedList = fromTools;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return toolToVertex(item);
      });
    }
    setValueByPath(parentObject, ["tools"], transformedList);
  }
  const fromGenerationConfig = getValueByPath(fromObject, [
    "generationConfig"
  ]);
  if (parentObject !== void 0 && fromGenerationConfig != null) {
    setValueByPath(parentObject, ["generationConfig"], generationConfigToVertex(fromGenerationConfig));
  }
  return toObject;
}
__name(countTokensConfigToVertex, "countTokensConfigToVertex");
function countTokensParametersToMldev(apiClient, fromObject, rootObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["_url", "model"], tModel(apiClient, fromModel));
  }
  const fromContents = getValueByPath(fromObject, ["contents"]);
  if (fromContents != null) {
    let transformedList = tContents(fromContents);
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return contentToMldev$1(item);
      });
    }
    setValueByPath(toObject, ["contents"], transformedList);
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    countTokensConfigToMldev(fromConfig);
  }
  return toObject;
}
__name(countTokensParametersToMldev, "countTokensParametersToMldev");
function countTokensParametersToVertex(apiClient, fromObject, rootObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["_url", "model"], tModel(apiClient, fromModel));
  }
  const fromContents = getValueByPath(fromObject, ["contents"]);
  if (fromContents != null) {
    let transformedList = tContents(fromContents);
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return contentToVertex(item);
      });
    }
    setValueByPath(toObject, ["contents"], transformedList);
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    countTokensConfigToVertex(fromConfig, toObject);
  }
  return toObject;
}
__name(countTokensParametersToVertex, "countTokensParametersToVertex");
function countTokensResponseFromMldev(fromObject, _rootObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromTotalTokens = getValueByPath(fromObject, ["totalTokens"]);
  if (fromTotalTokens != null) {
    setValueByPath(toObject, ["totalTokens"], fromTotalTokens);
  }
  const fromCachedContentTokenCount = getValueByPath(fromObject, [
    "cachedContentTokenCount"
  ]);
  if (fromCachedContentTokenCount != null) {
    setValueByPath(toObject, ["cachedContentTokenCount"], fromCachedContentTokenCount);
  }
  return toObject;
}
__name(countTokensResponseFromMldev, "countTokensResponseFromMldev");
function countTokensResponseFromVertex(fromObject, _rootObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromTotalTokens = getValueByPath(fromObject, ["totalTokens"]);
  if (fromTotalTokens != null) {
    setValueByPath(toObject, ["totalTokens"], fromTotalTokens);
  }
  return toObject;
}
__name(countTokensResponseFromVertex, "countTokensResponseFromVertex");
function deleteModelParametersToMldev(apiClient, fromObject, _rootObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["_url", "name"], tModel(apiClient, fromModel));
  }
  return toObject;
}
__name(deleteModelParametersToMldev, "deleteModelParametersToMldev");
function deleteModelParametersToVertex(apiClient, fromObject, _rootObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["_url", "name"], tModel(apiClient, fromModel));
  }
  return toObject;
}
__name(deleteModelParametersToVertex, "deleteModelParametersToVertex");
function deleteModelResponseFromMldev(fromObject, _rootObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  return toObject;
}
__name(deleteModelResponseFromMldev, "deleteModelResponseFromMldev");
function deleteModelResponseFromVertex(fromObject, _rootObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  return toObject;
}
__name(deleteModelResponseFromVertex, "deleteModelResponseFromVertex");
function editImageConfigToVertex(fromObject, parentObject, _rootObject) {
  const toObject = {};
  const fromOutputGcsUri = getValueByPath(fromObject, ["outputGcsUri"]);
  if (parentObject !== void 0 && fromOutputGcsUri != null) {
    setValueByPath(parentObject, ["parameters", "storageUri"], fromOutputGcsUri);
  }
  const fromNegativePrompt = getValueByPath(fromObject, [
    "negativePrompt"
  ]);
  if (parentObject !== void 0 && fromNegativePrompt != null) {
    setValueByPath(parentObject, ["parameters", "negativePrompt"], fromNegativePrompt);
  }
  const fromNumberOfImages = getValueByPath(fromObject, [
    "numberOfImages"
  ]);
  if (parentObject !== void 0 && fromNumberOfImages != null) {
    setValueByPath(parentObject, ["parameters", "sampleCount"], fromNumberOfImages);
  }
  const fromAspectRatio = getValueByPath(fromObject, ["aspectRatio"]);
  if (parentObject !== void 0 && fromAspectRatio != null) {
    setValueByPath(parentObject, ["parameters", "aspectRatio"], fromAspectRatio);
  }
  const fromGuidanceScale = getValueByPath(fromObject, [
    "guidanceScale"
  ]);
  if (parentObject !== void 0 && fromGuidanceScale != null) {
    setValueByPath(parentObject, ["parameters", "guidanceScale"], fromGuidanceScale);
  }
  const fromSeed = getValueByPath(fromObject, ["seed"]);
  if (parentObject !== void 0 && fromSeed != null) {
    setValueByPath(parentObject, ["parameters", "seed"], fromSeed);
  }
  const fromSafetyFilterLevel = getValueByPath(fromObject, [
    "safetyFilterLevel"
  ]);
  if (parentObject !== void 0 && fromSafetyFilterLevel != null) {
    setValueByPath(parentObject, ["parameters", "safetySetting"], fromSafetyFilterLevel);
  }
  const fromPersonGeneration = getValueByPath(fromObject, [
    "personGeneration"
  ]);
  if (parentObject !== void 0 && fromPersonGeneration != null) {
    setValueByPath(parentObject, ["parameters", "personGeneration"], fromPersonGeneration);
  }
  const fromIncludeSafetyAttributes = getValueByPath(fromObject, [
    "includeSafetyAttributes"
  ]);
  if (parentObject !== void 0 && fromIncludeSafetyAttributes != null) {
    setValueByPath(parentObject, ["parameters", "includeSafetyAttributes"], fromIncludeSafetyAttributes);
  }
  const fromIncludeRaiReason = getValueByPath(fromObject, [
    "includeRaiReason"
  ]);
  if (parentObject !== void 0 && fromIncludeRaiReason != null) {
    setValueByPath(parentObject, ["parameters", "includeRaiReason"], fromIncludeRaiReason);
  }
  const fromLanguage = getValueByPath(fromObject, ["language"]);
  if (parentObject !== void 0 && fromLanguage != null) {
    setValueByPath(parentObject, ["parameters", "language"], fromLanguage);
  }
  const fromOutputMimeType = getValueByPath(fromObject, [
    "outputMimeType"
  ]);
  if (parentObject !== void 0 && fromOutputMimeType != null) {
    setValueByPath(parentObject, ["parameters", "outputOptions", "mimeType"], fromOutputMimeType);
  }
  const fromOutputCompressionQuality = getValueByPath(fromObject, [
    "outputCompressionQuality"
  ]);
  if (parentObject !== void 0 && fromOutputCompressionQuality != null) {
    setValueByPath(parentObject, ["parameters", "outputOptions", "compressionQuality"], fromOutputCompressionQuality);
  }
  const fromAddWatermark = getValueByPath(fromObject, ["addWatermark"]);
  if (parentObject !== void 0 && fromAddWatermark != null) {
    setValueByPath(parentObject, ["parameters", "addWatermark"], fromAddWatermark);
  }
  const fromLabels = getValueByPath(fromObject, ["labels"]);
  if (parentObject !== void 0 && fromLabels != null) {
    setValueByPath(parentObject, ["labels"], fromLabels);
  }
  const fromEditMode = getValueByPath(fromObject, ["editMode"]);
  if (parentObject !== void 0 && fromEditMode != null) {
    setValueByPath(parentObject, ["parameters", "editMode"], fromEditMode);
  }
  const fromBaseSteps = getValueByPath(fromObject, ["baseSteps"]);
  if (parentObject !== void 0 && fromBaseSteps != null) {
    setValueByPath(parentObject, ["parameters", "editConfig", "baseSteps"], fromBaseSteps);
  }
  return toObject;
}
__name(editImageConfigToVertex, "editImageConfigToVertex");
function editImageParametersInternalToVertex(apiClient, fromObject, rootObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["_url", "model"], tModel(apiClient, fromModel));
  }
  const fromPrompt = getValueByPath(fromObject, ["prompt"]);
  if (fromPrompt != null) {
    setValueByPath(toObject, ["instances[0]", "prompt"], fromPrompt);
  }
  const fromReferenceImages = getValueByPath(fromObject, [
    "referenceImages"
  ]);
  if (fromReferenceImages != null) {
    let transformedList = fromReferenceImages;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return referenceImageAPIInternalToVertex(item);
      });
    }
    setValueByPath(toObject, ["instances[0]", "referenceImages"], transformedList);
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    editImageConfigToVertex(fromConfig, toObject);
  }
  return toObject;
}
__name(editImageParametersInternalToVertex, "editImageParametersInternalToVertex");
function editImageResponseFromVertex(fromObject, rootObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromGeneratedImages = getValueByPath(fromObject, [
    "predictions"
  ]);
  if (fromGeneratedImages != null) {
    let transformedList = fromGeneratedImages;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return generatedImageFromVertex(item);
      });
    }
    setValueByPath(toObject, ["generatedImages"], transformedList);
  }
  return toObject;
}
__name(editImageResponseFromVertex, "editImageResponseFromVertex");
function embedContentConfigToMldev(fromObject, parentObject, _rootObject) {
  const toObject = {};
  const fromTaskType = getValueByPath(fromObject, ["taskType"]);
  if (parentObject !== void 0 && fromTaskType != null) {
    setValueByPath(parentObject, ["requests[]", "taskType"], fromTaskType);
  }
  const fromTitle = getValueByPath(fromObject, ["title"]);
  if (parentObject !== void 0 && fromTitle != null) {
    setValueByPath(parentObject, ["requests[]", "title"], fromTitle);
  }
  const fromOutputDimensionality = getValueByPath(fromObject, [
    "outputDimensionality"
  ]);
  if (parentObject !== void 0 && fromOutputDimensionality != null) {
    setValueByPath(parentObject, ["requests[]", "outputDimensionality"], fromOutputDimensionality);
  }
  if (getValueByPath(fromObject, ["mimeType"]) !== void 0) {
    throw new Error("mimeType parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["autoTruncate"]) !== void 0) {
    throw new Error("autoTruncate parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["documentOcr"]) !== void 0) {
    throw new Error("documentOcr parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["audioTrackExtraction"]) !== void 0) {
    throw new Error("audioTrackExtraction parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(embedContentConfigToMldev, "embedContentConfigToMldev");
function embedContentConfigToVertex(fromObject, parentObject, rootObject) {
  const toObject = {};
  let discriminatorTaskType = getValueByPath(rootObject, [
    "embeddingApiType"
  ]);
  if (discriminatorTaskType === void 0) {
    discriminatorTaskType = "PREDICT";
  }
  if (discriminatorTaskType === "PREDICT") {
    const fromTaskType = getValueByPath(fromObject, ["taskType"]);
    if (parentObject !== void 0 && fromTaskType != null) {
      setValueByPath(parentObject, ["instances[]", "task_type"], fromTaskType);
    }
  } else if (discriminatorTaskType === "EMBED_CONTENT") {
    const fromTaskType = getValueByPath(fromObject, ["taskType"]);
    if (parentObject !== void 0 && fromTaskType != null) {
      setValueByPath(parentObject, ["embedContentConfig", "taskType"], fromTaskType);
    }
  }
  let discriminatorTitle = getValueByPath(rootObject, [
    "embeddingApiType"
  ]);
  if (discriminatorTitle === void 0) {
    discriminatorTitle = "PREDICT";
  }
  if (discriminatorTitle === "PREDICT") {
    const fromTitle = getValueByPath(fromObject, ["title"]);
    if (parentObject !== void 0 && fromTitle != null) {
      setValueByPath(parentObject, ["instances[]", "title"], fromTitle);
    }
  } else if (discriminatorTitle === "EMBED_CONTENT") {
    const fromTitle = getValueByPath(fromObject, ["title"]);
    if (parentObject !== void 0 && fromTitle != null) {
      setValueByPath(parentObject, ["embedContentConfig", "title"], fromTitle);
    }
  }
  let discriminatorOutputDimensionality = getValueByPath(rootObject, [
    "embeddingApiType"
  ]);
  if (discriminatorOutputDimensionality === void 0) {
    discriminatorOutputDimensionality = "PREDICT";
  }
  if (discriminatorOutputDimensionality === "PREDICT") {
    const fromOutputDimensionality = getValueByPath(fromObject, [
      "outputDimensionality"
    ]);
    if (parentObject !== void 0 && fromOutputDimensionality != null) {
      setValueByPath(parentObject, ["parameters", "outputDimensionality"], fromOutputDimensionality);
    }
  } else if (discriminatorOutputDimensionality === "EMBED_CONTENT") {
    const fromOutputDimensionality = getValueByPath(fromObject, [
      "outputDimensionality"
    ]);
    if (parentObject !== void 0 && fromOutputDimensionality != null) {
      setValueByPath(parentObject, ["embedContentConfig", "outputDimensionality"], fromOutputDimensionality);
    }
  }
  let discriminatorMimeType = getValueByPath(rootObject, [
    "embeddingApiType"
  ]);
  if (discriminatorMimeType === void 0) {
    discriminatorMimeType = "PREDICT";
  }
  if (discriminatorMimeType === "PREDICT") {
    const fromMimeType = getValueByPath(fromObject, ["mimeType"]);
    if (parentObject !== void 0 && fromMimeType != null) {
      setValueByPath(parentObject, ["instances[]", "mimeType"], fromMimeType);
    }
  }
  let discriminatorAutoTruncate = getValueByPath(rootObject, [
    "embeddingApiType"
  ]);
  if (discriminatorAutoTruncate === void 0) {
    discriminatorAutoTruncate = "PREDICT";
  }
  if (discriminatorAutoTruncate === "PREDICT") {
    const fromAutoTruncate = getValueByPath(fromObject, [
      "autoTruncate"
    ]);
    if (parentObject !== void 0 && fromAutoTruncate != null) {
      setValueByPath(parentObject, ["parameters", "autoTruncate"], fromAutoTruncate);
    }
  } else if (discriminatorAutoTruncate === "EMBED_CONTENT") {
    const fromAutoTruncate = getValueByPath(fromObject, [
      "autoTruncate"
    ]);
    if (parentObject !== void 0 && fromAutoTruncate != null) {
      setValueByPath(parentObject, ["embedContentConfig", "autoTruncate"], fromAutoTruncate);
    }
  }
  let discriminatorDocumentOcr = getValueByPath(rootObject, [
    "embeddingApiType"
  ]);
  if (discriminatorDocumentOcr === void 0) {
    discriminatorDocumentOcr = "PREDICT";
  }
  if (discriminatorDocumentOcr === "EMBED_CONTENT") {
    const fromDocumentOcr = getValueByPath(fromObject, ["documentOcr"]);
    if (parentObject !== void 0 && fromDocumentOcr != null) {
      setValueByPath(parentObject, ["embedContentConfig", "documentOcr"], fromDocumentOcr);
    }
  }
  let discriminatorAudioTrackExtraction = getValueByPath(rootObject, [
    "embeddingApiType"
  ]);
  if (discriminatorAudioTrackExtraction === void 0) {
    discriminatorAudioTrackExtraction = "PREDICT";
  }
  if (discriminatorAudioTrackExtraction === "EMBED_CONTENT") {
    const fromAudioTrackExtraction = getValueByPath(fromObject, [
      "audioTrackExtraction"
    ]);
    if (parentObject !== void 0 && fromAudioTrackExtraction != null) {
      setValueByPath(parentObject, ["embedContentConfig", "audioTrackExtraction"], fromAudioTrackExtraction);
    }
  }
  return toObject;
}
__name(embedContentConfigToVertex, "embedContentConfigToVertex");
function embedContentParametersPrivateToMldev(apiClient, fromObject, rootObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["_url", "model"], tModel(apiClient, fromModel));
  }
  const fromContents = getValueByPath(fromObject, ["contents"]);
  if (fromContents != null) {
    let transformedList = tContentsForEmbed(apiClient, fromContents);
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["requests[]", "content"], transformedList);
  }
  const fromContent = getValueByPath(fromObject, ["content"]);
  if (fromContent != null) {
    contentToMldev$1(tContent(fromContent));
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    embedContentConfigToMldev(fromConfig, toObject);
  }
  const fromModelForEmbedContent = getValueByPath(fromObject, ["model"]);
  if (fromModelForEmbedContent !== void 0) {
    setValueByPath(toObject, ["requests[]", "model"], tModel(apiClient, fromModelForEmbedContent));
  }
  return toObject;
}
__name(embedContentParametersPrivateToMldev, "embedContentParametersPrivateToMldev");
function embedContentParametersPrivateToVertex(apiClient, fromObject, rootObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["_url", "model"], tModel(apiClient, fromModel));
  }
  let discriminatorContents = getValueByPath(rootObject, [
    "embeddingApiType"
  ]);
  if (discriminatorContents === void 0) {
    discriminatorContents = "PREDICT";
  }
  if (discriminatorContents === "PREDICT") {
    const fromContents = getValueByPath(fromObject, ["contents"]);
    if (fromContents != null) {
      let transformedList = tContentsForEmbed(apiClient, fromContents);
      if (Array.isArray(transformedList)) {
        transformedList = transformedList.map((item) => {
          return item;
        });
      }
      setValueByPath(toObject, ["instances[]", "content"], transformedList);
    }
  }
  let discriminatorContent = getValueByPath(rootObject, [
    "embeddingApiType"
  ]);
  if (discriminatorContent === void 0) {
    discriminatorContent = "PREDICT";
  }
  if (discriminatorContent === "EMBED_CONTENT") {
    const fromContent = getValueByPath(fromObject, ["content"]);
    if (fromContent != null) {
      setValueByPath(toObject, ["content"], contentToVertex(tContent(fromContent)));
    }
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    embedContentConfigToVertex(fromConfig, toObject, rootObject);
  }
  return toObject;
}
__name(embedContentParametersPrivateToVertex, "embedContentParametersPrivateToVertex");
function embedContentResponseFromMldev(fromObject, _rootObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromEmbeddings = getValueByPath(fromObject, ["embeddings"]);
  if (fromEmbeddings != null) {
    let transformedList = fromEmbeddings;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["embeddings"], transformedList);
  }
  const fromMetadata = getValueByPath(fromObject, ["metadata"]);
  if (fromMetadata != null) {
    setValueByPath(toObject, ["metadata"], fromMetadata);
  }
  return toObject;
}
__name(embedContentResponseFromMldev, "embedContentResponseFromMldev");
function embedContentResponseFromVertex(fromObject, rootObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromEmbeddings = getValueByPath(fromObject, [
    "predictions[]",
    "embeddings"
  ]);
  if (fromEmbeddings != null) {
    let transformedList = fromEmbeddings;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return contentEmbeddingFromVertex(item);
      });
    }
    setValueByPath(toObject, ["embeddings"], transformedList);
  }
  const fromMetadata = getValueByPath(fromObject, ["metadata"]);
  if (fromMetadata != null) {
    setValueByPath(toObject, ["metadata"], fromMetadata);
  }
  if (rootObject && getValueByPath(rootObject, ["embeddingApiType"]) === "EMBED_CONTENT") {
    const embedding = getValueByPath(fromObject, ["embedding"]);
    const usageMetadata = getValueByPath(fromObject, ["usageMetadata"]);
    const truncated = getValueByPath(fromObject, ["truncated"]);
    if (embedding) {
      const stats = {};
      if (usageMetadata && usageMetadata["promptTokenCount"]) {
        stats.tokenCount = usageMetadata["promptTokenCount"];
      }
      if (truncated) {
        stats.truncated = truncated;
      }
      embedding.statistics = stats;
      setValueByPath(toObject, ["embeddings"], [embedding]);
    }
  }
  return toObject;
}
__name(embedContentResponseFromVertex, "embedContentResponseFromVertex");
function endpointFromVertex(fromObject, _rootObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["endpoint"]);
  if (fromName != null) {
    setValueByPath(toObject, ["name"], fromName);
  }
  const fromDeployedModelId = getValueByPath(fromObject, [
    "deployedModelId"
  ]);
  if (fromDeployedModelId != null) {
    setValueByPath(toObject, ["deployedModelId"], fromDeployedModelId);
  }
  return toObject;
}
__name(endpointFromVertex, "endpointFromVertex");
function executableCodeToVertex(fromObject, _rootObject) {
  const toObject = {};
  const fromCode = getValueByPath(fromObject, ["code"]);
  if (fromCode != null) {
    setValueByPath(toObject, ["code"], fromCode);
  }
  const fromLanguage = getValueByPath(fromObject, ["language"]);
  if (fromLanguage != null) {
    setValueByPath(toObject, ["language"], fromLanguage);
  }
  if (getValueByPath(fromObject, ["id"]) !== void 0) {
    throw new Error("id parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  return toObject;
}
__name(executableCodeToVertex, "executableCodeToVertex");
function fileDataToMldev$1(fromObject, _rootObject) {
  const toObject = {};
  if (getValueByPath(fromObject, ["displayName"]) !== void 0) {
    throw new Error("displayName parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromFileUri = getValueByPath(fromObject, ["fileUri"]);
  if (fromFileUri != null) {
    setValueByPath(toObject, ["fileUri"], fromFileUri);
  }
  const fromMimeType = getValueByPath(fromObject, ["mimeType"]);
  if (fromMimeType != null) {
    setValueByPath(toObject, ["mimeType"], fromMimeType);
  }
  return toObject;
}
__name(fileDataToMldev$1, "fileDataToMldev$1");
function functionCallToMldev$1(fromObject, _rootObject) {
  const toObject = {};
  const fromId = getValueByPath(fromObject, ["id"]);
  if (fromId != null) {
    setValueByPath(toObject, ["id"], fromId);
  }
  const fromArgs = getValueByPath(fromObject, ["args"]);
  if (fromArgs != null) {
    setValueByPath(toObject, ["args"], fromArgs);
  }
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["name"], fromName);
  }
  if (getValueByPath(fromObject, ["partialArgs"]) !== void 0) {
    throw new Error("partialArgs parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["willContinue"]) !== void 0) {
    throw new Error("willContinue parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(functionCallToMldev$1, "functionCallToMldev$1");
function functionCallingConfigToMldev(fromObject, _rootObject) {
  const toObject = {};
  const fromAllowedFunctionNames = getValueByPath(fromObject, [
    "allowedFunctionNames"
  ]);
  if (fromAllowedFunctionNames != null) {
    setValueByPath(toObject, ["allowedFunctionNames"], fromAllowedFunctionNames);
  }
  const fromMode = getValueByPath(fromObject, ["mode"]);
  if (fromMode != null) {
    setValueByPath(toObject, ["mode"], fromMode);
  }
  if (getValueByPath(fromObject, ["streamFunctionCallArguments"]) !== void 0) {
    throw new Error("streamFunctionCallArguments parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(functionCallingConfigToMldev, "functionCallingConfigToMldev");
function generateContentConfigToMldev(apiClient, fromObject, parentObject, rootObject) {
  const toObject = {};
  const fromSystemInstruction = getValueByPath(fromObject, [
    "systemInstruction"
  ]);
  if (parentObject !== void 0 && fromSystemInstruction != null) {
    setValueByPath(parentObject, ["systemInstruction"], contentToMldev$1(tContent(fromSystemInstruction)));
  }
  const fromTemperature = getValueByPath(fromObject, ["temperature"]);
  if (fromTemperature != null) {
    setValueByPath(toObject, ["temperature"], fromTemperature);
  }
  const fromTopP = getValueByPath(fromObject, ["topP"]);
  if (fromTopP != null) {
    setValueByPath(toObject, ["topP"], fromTopP);
  }
  const fromTopK = getValueByPath(fromObject, ["topK"]);
  if (fromTopK != null) {
    setValueByPath(toObject, ["topK"], fromTopK);
  }
  const fromCandidateCount = getValueByPath(fromObject, [
    "candidateCount"
  ]);
  if (fromCandidateCount != null) {
    setValueByPath(toObject, ["candidateCount"], fromCandidateCount);
  }
  const fromMaxOutputTokens = getValueByPath(fromObject, [
    "maxOutputTokens"
  ]);
  if (fromMaxOutputTokens != null) {
    setValueByPath(toObject, ["maxOutputTokens"], fromMaxOutputTokens);
  }
  const fromStopSequences = getValueByPath(fromObject, [
    "stopSequences"
  ]);
  if (fromStopSequences != null) {
    setValueByPath(toObject, ["stopSequences"], fromStopSequences);
  }
  const fromResponseLogprobs = getValueByPath(fromObject, [
    "responseLogprobs"
  ]);
  if (fromResponseLogprobs != null) {
    setValueByPath(toObject, ["responseLogprobs"], fromResponseLogprobs);
  }
  const fromLogprobs = getValueByPath(fromObject, ["logprobs"]);
  if (fromLogprobs != null) {
    setValueByPath(toObject, ["logprobs"], fromLogprobs);
  }
  const fromPresencePenalty = getValueByPath(fromObject, [
    "presencePenalty"
  ]);
  if (fromPresencePenalty != null) {
    setValueByPath(toObject, ["presencePenalty"], fromPresencePenalty);
  }
  const fromFrequencyPenalty = getValueByPath(fromObject, [
    "frequencyPenalty"
  ]);
  if (fromFrequencyPenalty != null) {
    setValueByPath(toObject, ["frequencyPenalty"], fromFrequencyPenalty);
  }
  const fromSeed = getValueByPath(fromObject, ["seed"]);
  if (fromSeed != null) {
    setValueByPath(toObject, ["seed"], fromSeed);
  }
  const fromResponseMimeType = getValueByPath(fromObject, [
    "responseMimeType"
  ]);
  if (fromResponseMimeType != null) {
    setValueByPath(toObject, ["responseMimeType"], fromResponseMimeType);
  }
  const fromResponseSchema = getValueByPath(fromObject, [
    "responseSchema"
  ]);
  if (fromResponseSchema != null) {
    setValueByPath(toObject, ["responseSchema"], tSchema(fromResponseSchema));
  }
  const fromResponseJsonSchema = getValueByPath(fromObject, [
    "responseJsonSchema"
  ]);
  if (fromResponseJsonSchema != null) {
    setValueByPath(toObject, ["responseJsonSchema"], fromResponseJsonSchema);
  }
  if (getValueByPath(fromObject, ["routingConfig"]) !== void 0) {
    throw new Error("routingConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["modelSelectionConfig"]) !== void 0) {
    throw new Error("modelSelectionConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromSafetySettings = getValueByPath(fromObject, [
    "safetySettings"
  ]);
  if (parentObject !== void 0 && fromSafetySettings != null) {
    let transformedList = fromSafetySettings;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return safetySettingToMldev$1(item);
      });
    }
    setValueByPath(parentObject, ["safetySettings"], transformedList);
  }
  const fromTools = getValueByPath(fromObject, ["tools"]);
  if (parentObject !== void 0 && fromTools != null) {
    let transformedList = tTools(fromTools);
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return toolToMldev$1(tTool(item));
      });
    }
    setValueByPath(parentObject, ["tools"], transformedList);
  }
  const fromToolConfig = getValueByPath(fromObject, ["toolConfig"]);
  if (parentObject !== void 0 && fromToolConfig != null) {
    setValueByPath(parentObject, ["toolConfig"], toolConfigToMldev(fromToolConfig));
  }
  if (getValueByPath(fromObject, ["labels"]) !== void 0) {
    throw new Error("labels parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromCachedContent = getValueByPath(fromObject, [
    "cachedContent"
  ]);
  if (parentObject !== void 0 && fromCachedContent != null) {
    setValueByPath(parentObject, ["cachedContent"], tCachedContentName(apiClient, fromCachedContent));
  }
  const fromResponseModalities = getValueByPath(fromObject, [
    "responseModalities"
  ]);
  if (fromResponseModalities != null) {
    setValueByPath(toObject, ["responseModalities"], fromResponseModalities);
  }
  const fromMediaResolution = getValueByPath(fromObject, [
    "mediaResolution"
  ]);
  if (fromMediaResolution != null) {
    setValueByPath(toObject, ["mediaResolution"], fromMediaResolution);
  }
  const fromSpeechConfig = getValueByPath(fromObject, ["speechConfig"]);
  if (fromSpeechConfig != null) {
    setValueByPath(toObject, ["speechConfig"], tSpeechConfig(fromSpeechConfig));
  }
  if (getValueByPath(fromObject, ["audioTimestamp"]) !== void 0) {
    throw new Error("audioTimestamp parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromThinkingConfig = getValueByPath(fromObject, [
    "thinkingConfig"
  ]);
  if (fromThinkingConfig != null) {
    setValueByPath(toObject, ["thinkingConfig"], fromThinkingConfig);
  }
  const fromImageConfig = getValueByPath(fromObject, ["imageConfig"]);
  if (fromImageConfig != null) {
    setValueByPath(toObject, ["imageConfig"], imageConfigToMldev(fromImageConfig));
  }
  const fromEnableEnhancedCivicAnswers = getValueByPath(fromObject, [
    "enableEnhancedCivicAnswers"
  ]);
  if (fromEnableEnhancedCivicAnswers != null) {
    setValueByPath(toObject, ["enableEnhancedCivicAnswers"], fromEnableEnhancedCivicAnswers);
  }
  if (getValueByPath(fromObject, ["modelArmorConfig"]) !== void 0) {
    throw new Error("modelArmorConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromServiceTier = getValueByPath(fromObject, ["serviceTier"]);
  if (parentObject !== void 0 && fromServiceTier != null) {
    setValueByPath(parentObject, ["serviceTier"], fromServiceTier);
  }
  return toObject;
}
__name(generateContentConfigToMldev, "generateContentConfigToMldev");
function generateContentConfigToVertex(apiClient, fromObject, parentObject, rootObject) {
  const toObject = {};
  const fromSystemInstruction = getValueByPath(fromObject, [
    "systemInstruction"
  ]);
  if (parentObject !== void 0 && fromSystemInstruction != null) {
    setValueByPath(parentObject, ["systemInstruction"], contentToVertex(tContent(fromSystemInstruction)));
  }
  const fromTemperature = getValueByPath(fromObject, ["temperature"]);
  if (fromTemperature != null) {
    setValueByPath(toObject, ["temperature"], fromTemperature);
  }
  const fromTopP = getValueByPath(fromObject, ["topP"]);
  if (fromTopP != null) {
    setValueByPath(toObject, ["topP"], fromTopP);
  }
  const fromTopK = getValueByPath(fromObject, ["topK"]);
  if (fromTopK != null) {
    setValueByPath(toObject, ["topK"], fromTopK);
  }
  const fromCandidateCount = getValueByPath(fromObject, [
    "candidateCount"
  ]);
  if (fromCandidateCount != null) {
    setValueByPath(toObject, ["candidateCount"], fromCandidateCount);
  }
  const fromMaxOutputTokens = getValueByPath(fromObject, [
    "maxOutputTokens"
  ]);
  if (fromMaxOutputTokens != null) {
    setValueByPath(toObject, ["maxOutputTokens"], fromMaxOutputTokens);
  }
  const fromStopSequences = getValueByPath(fromObject, [
    "stopSequences"
  ]);
  if (fromStopSequences != null) {
    setValueByPath(toObject, ["stopSequences"], fromStopSequences);
  }
  const fromResponseLogprobs = getValueByPath(fromObject, [
    "responseLogprobs"
  ]);
  if (fromResponseLogprobs != null) {
    setValueByPath(toObject, ["responseLogprobs"], fromResponseLogprobs);
  }
  const fromLogprobs = getValueByPath(fromObject, ["logprobs"]);
  if (fromLogprobs != null) {
    setValueByPath(toObject, ["logprobs"], fromLogprobs);
  }
  const fromPresencePenalty = getValueByPath(fromObject, [
    "presencePenalty"
  ]);
  if (fromPresencePenalty != null) {
    setValueByPath(toObject, ["presencePenalty"], fromPresencePenalty);
  }
  const fromFrequencyPenalty = getValueByPath(fromObject, [
    "frequencyPenalty"
  ]);
  if (fromFrequencyPenalty != null) {
    setValueByPath(toObject, ["frequencyPenalty"], fromFrequencyPenalty);
  }
  const fromSeed = getValueByPath(fromObject, ["seed"]);
  if (fromSeed != null) {
    setValueByPath(toObject, ["seed"], fromSeed);
  }
  const fromResponseMimeType = getValueByPath(fromObject, [
    "responseMimeType"
  ]);
  if (fromResponseMimeType != null) {
    setValueByPath(toObject, ["responseMimeType"], fromResponseMimeType);
  }
  const fromResponseSchema = getValueByPath(fromObject, [
    "responseSchema"
  ]);
  if (fromResponseSchema != null) {
    setValueByPath(toObject, ["responseSchema"], tSchema(fromResponseSchema));
  }
  const fromResponseJsonSchema = getValueByPath(fromObject, [
    "responseJsonSchema"
  ]);
  if (fromResponseJsonSchema != null) {
    setValueByPath(toObject, ["responseJsonSchema"], fromResponseJsonSchema);
  }
  const fromRoutingConfig = getValueByPath(fromObject, [
    "routingConfig"
  ]);
  if (fromRoutingConfig != null) {
    setValueByPath(toObject, ["routingConfig"], fromRoutingConfig);
  }
  const fromModelSelectionConfig = getValueByPath(fromObject, [
    "modelSelectionConfig"
  ]);
  if (fromModelSelectionConfig != null) {
    setValueByPath(toObject, ["modelConfig"], fromModelSelectionConfig);
  }
  const fromSafetySettings = getValueByPath(fromObject, [
    "safetySettings"
  ]);
  if (parentObject !== void 0 && fromSafetySettings != null) {
    let transformedList = fromSafetySettings;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(parentObject, ["safetySettings"], transformedList);
  }
  const fromTools = getValueByPath(fromObject, ["tools"]);
  if (parentObject !== void 0 && fromTools != null) {
    let transformedList = tTools(fromTools);
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return toolToVertex(tTool(item));
      });
    }
    setValueByPath(parentObject, ["tools"], transformedList);
  }
  const fromToolConfig = getValueByPath(fromObject, ["toolConfig"]);
  if (parentObject !== void 0 && fromToolConfig != null) {
    setValueByPath(parentObject, ["toolConfig"], toolConfigToVertex(fromToolConfig));
  }
  const fromLabels = getValueByPath(fromObject, ["labels"]);
  if (parentObject !== void 0 && fromLabels != null) {
    setValueByPath(parentObject, ["labels"], fromLabels);
  }
  const fromCachedContent = getValueByPath(fromObject, [
    "cachedContent"
  ]);
  if (parentObject !== void 0 && fromCachedContent != null) {
    setValueByPath(parentObject, ["cachedContent"], tCachedContentName(apiClient, fromCachedContent));
  }
  const fromResponseModalities = getValueByPath(fromObject, [
    "responseModalities"
  ]);
  if (fromResponseModalities != null) {
    setValueByPath(toObject, ["responseModalities"], fromResponseModalities);
  }
  const fromMediaResolution = getValueByPath(fromObject, [
    "mediaResolution"
  ]);
  if (fromMediaResolution != null) {
    setValueByPath(toObject, ["mediaResolution"], fromMediaResolution);
  }
  const fromSpeechConfig = getValueByPath(fromObject, ["speechConfig"]);
  if (fromSpeechConfig != null) {
    setValueByPath(toObject, ["speechConfig"], tSpeechConfig(fromSpeechConfig));
  }
  const fromAudioTimestamp = getValueByPath(fromObject, [
    "audioTimestamp"
  ]);
  if (fromAudioTimestamp != null) {
    setValueByPath(toObject, ["audioTimestamp"], fromAudioTimestamp);
  }
  const fromThinkingConfig = getValueByPath(fromObject, [
    "thinkingConfig"
  ]);
  if (fromThinkingConfig != null) {
    setValueByPath(toObject, ["thinkingConfig"], fromThinkingConfig);
  }
  const fromImageConfig = getValueByPath(fromObject, ["imageConfig"]);
  if (fromImageConfig != null) {
    setValueByPath(toObject, ["imageConfig"], imageConfigToVertex(fromImageConfig));
  }
  if (getValueByPath(fromObject, ["enableEnhancedCivicAnswers"]) !== void 0) {
    throw new Error("enableEnhancedCivicAnswers parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  const fromModelArmorConfig = getValueByPath(fromObject, [
    "modelArmorConfig"
  ]);
  if (parentObject !== void 0 && fromModelArmorConfig != null) {
    setValueByPath(parentObject, ["modelArmorConfig"], fromModelArmorConfig);
  }
  const fromServiceTier = getValueByPath(fromObject, ["serviceTier"]);
  if (parentObject !== void 0 && fromServiceTier != null) {
    setValueByPath(parentObject, ["serviceTier"], fromServiceTier);
  }
  return toObject;
}
__name(generateContentConfigToVertex, "generateContentConfigToVertex");
function generateContentParametersToMldev(apiClient, fromObject, rootObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["_url", "model"], tModel(apiClient, fromModel));
  }
  const fromContents = getValueByPath(fromObject, ["contents"]);
  if (fromContents != null) {
    let transformedList = tContents(fromContents);
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return contentToMldev$1(item);
      });
    }
    setValueByPath(toObject, ["contents"], transformedList);
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    setValueByPath(toObject, ["generationConfig"], generateContentConfigToMldev(apiClient, fromConfig, toObject));
  }
  return toObject;
}
__name(generateContentParametersToMldev, "generateContentParametersToMldev");
function generateContentParametersToVertex(apiClient, fromObject, rootObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["_url", "model"], tModel(apiClient, fromModel));
  }
  const fromContents = getValueByPath(fromObject, ["contents"]);
  if (fromContents != null) {
    let transformedList = tContents(fromContents);
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return contentToVertex(item);
      });
    }
    setValueByPath(toObject, ["contents"], transformedList);
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    setValueByPath(toObject, ["generationConfig"], generateContentConfigToVertex(apiClient, fromConfig, toObject));
  }
  return toObject;
}
__name(generateContentParametersToVertex, "generateContentParametersToVertex");
function generateContentResponseFromMldev(fromObject, rootObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromCandidates = getValueByPath(fromObject, ["candidates"]);
  if (fromCandidates != null) {
    let transformedList = fromCandidates;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return candidateFromMldev(item);
      });
    }
    setValueByPath(toObject, ["candidates"], transformedList);
  }
  const fromModelVersion = getValueByPath(fromObject, ["modelVersion"]);
  if (fromModelVersion != null) {
    setValueByPath(toObject, ["modelVersion"], fromModelVersion);
  }
  const fromPromptFeedback = getValueByPath(fromObject, [
    "promptFeedback"
  ]);
  if (fromPromptFeedback != null) {
    setValueByPath(toObject, ["promptFeedback"], fromPromptFeedback);
  }
  const fromResponseId = getValueByPath(fromObject, ["responseId"]);
  if (fromResponseId != null) {
    setValueByPath(toObject, ["responseId"], fromResponseId);
  }
  const fromUsageMetadata = getValueByPath(fromObject, [
    "usageMetadata"
  ]);
  if (fromUsageMetadata != null) {
    setValueByPath(toObject, ["usageMetadata"], fromUsageMetadata);
  }
  const fromModelStatus = getValueByPath(fromObject, ["modelStatus"]);
  if (fromModelStatus != null) {
    setValueByPath(toObject, ["modelStatus"], fromModelStatus);
  }
  return toObject;
}
__name(generateContentResponseFromMldev, "generateContentResponseFromMldev");
function generateContentResponseFromVertex(fromObject, _rootObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromCandidates = getValueByPath(fromObject, ["candidates"]);
  if (fromCandidates != null) {
    let transformedList = fromCandidates;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["candidates"], transformedList);
  }
  const fromCreateTime = getValueByPath(fromObject, ["createTime"]);
  if (fromCreateTime != null) {
    setValueByPath(toObject, ["createTime"], fromCreateTime);
  }
  const fromModelVersion = getValueByPath(fromObject, ["modelVersion"]);
  if (fromModelVersion != null) {
    setValueByPath(toObject, ["modelVersion"], fromModelVersion);
  }
  const fromPromptFeedback = getValueByPath(fromObject, [
    "promptFeedback"
  ]);
  if (fromPromptFeedback != null) {
    setValueByPath(toObject, ["promptFeedback"], fromPromptFeedback);
  }
  const fromResponseId = getValueByPath(fromObject, ["responseId"]);
  if (fromResponseId != null) {
    setValueByPath(toObject, ["responseId"], fromResponseId);
  }
  const fromUsageMetadata = getValueByPath(fromObject, [
    "usageMetadata"
  ]);
  if (fromUsageMetadata != null) {
    setValueByPath(toObject, ["usageMetadata"], fromUsageMetadata);
  }
  return toObject;
}
__name(generateContentResponseFromVertex, "generateContentResponseFromVertex");
function generateImagesConfigToMldev(fromObject, parentObject, _rootObject) {
  const toObject = {};
  if (getValueByPath(fromObject, ["outputGcsUri"]) !== void 0) {
    throw new Error("outputGcsUri parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["negativePrompt"]) !== void 0) {
    throw new Error("negativePrompt parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromNumberOfImages = getValueByPath(fromObject, [
    "numberOfImages"
  ]);
  if (parentObject !== void 0 && fromNumberOfImages != null) {
    setValueByPath(parentObject, ["parameters", "sampleCount"], fromNumberOfImages);
  }
  const fromAspectRatio = getValueByPath(fromObject, ["aspectRatio"]);
  if (parentObject !== void 0 && fromAspectRatio != null) {
    setValueByPath(parentObject, ["parameters", "aspectRatio"], fromAspectRatio);
  }
  const fromGuidanceScale = getValueByPath(fromObject, [
    "guidanceScale"
  ]);
  if (parentObject !== void 0 && fromGuidanceScale != null) {
    setValueByPath(parentObject, ["parameters", "guidanceScale"], fromGuidanceScale);
  }
  if (getValueByPath(fromObject, ["seed"]) !== void 0) {
    throw new Error("seed parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromSafetyFilterLevel = getValueByPath(fromObject, [
    "safetyFilterLevel"
  ]);
  if (parentObject !== void 0 && fromSafetyFilterLevel != null) {
    setValueByPath(parentObject, ["parameters", "safetySetting"], fromSafetyFilterLevel);
  }
  const fromPersonGeneration = getValueByPath(fromObject, [
    "personGeneration"
  ]);
  if (parentObject !== void 0 && fromPersonGeneration != null) {
    setValueByPath(parentObject, ["parameters", "personGeneration"], fromPersonGeneration);
  }
  const fromIncludeSafetyAttributes = getValueByPath(fromObject, [
    "includeSafetyAttributes"
  ]);
  if (parentObject !== void 0 && fromIncludeSafetyAttributes != null) {
    setValueByPath(parentObject, ["parameters", "includeSafetyAttributes"], fromIncludeSafetyAttributes);
  }
  const fromIncludeRaiReason = getValueByPath(fromObject, [
    "includeRaiReason"
  ]);
  if (parentObject !== void 0 && fromIncludeRaiReason != null) {
    setValueByPath(parentObject, ["parameters", "includeRaiReason"], fromIncludeRaiReason);
  }
  const fromLanguage = getValueByPath(fromObject, ["language"]);
  if (parentObject !== void 0 && fromLanguage != null) {
    setValueByPath(parentObject, ["parameters", "language"], fromLanguage);
  }
  const fromOutputMimeType = getValueByPath(fromObject, [
    "outputMimeType"
  ]);
  if (parentObject !== void 0 && fromOutputMimeType != null) {
    setValueByPath(parentObject, ["parameters", "outputOptions", "mimeType"], fromOutputMimeType);
  }
  const fromOutputCompressionQuality = getValueByPath(fromObject, [
    "outputCompressionQuality"
  ]);
  if (parentObject !== void 0 && fromOutputCompressionQuality != null) {
    setValueByPath(parentObject, ["parameters", "outputOptions", "compressionQuality"], fromOutputCompressionQuality);
  }
  if (getValueByPath(fromObject, ["addWatermark"]) !== void 0) {
    throw new Error("addWatermark parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["labels"]) !== void 0) {
    throw new Error("labels parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromImageSize = getValueByPath(fromObject, ["imageSize"]);
  if (parentObject !== void 0 && fromImageSize != null) {
    setValueByPath(parentObject, ["parameters", "sampleImageSize"], fromImageSize);
  }
  if (getValueByPath(fromObject, ["enhancePrompt"]) !== void 0) {
    throw new Error("enhancePrompt parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(generateImagesConfigToMldev, "generateImagesConfigToMldev");
function generateImagesConfigToVertex(fromObject, parentObject, _rootObject) {
  const toObject = {};
  const fromOutputGcsUri = getValueByPath(fromObject, ["outputGcsUri"]);
  if (parentObject !== void 0 && fromOutputGcsUri != null) {
    setValueByPath(parentObject, ["parameters", "storageUri"], fromOutputGcsUri);
  }
  const fromNegativePrompt = getValueByPath(fromObject, [
    "negativePrompt"
  ]);
  if (parentObject !== void 0 && fromNegativePrompt != null) {
    setValueByPath(parentObject, ["parameters", "negativePrompt"], fromNegativePrompt);
  }
  const fromNumberOfImages = getValueByPath(fromObject, [
    "numberOfImages"
  ]);
  if (parentObject !== void 0 && fromNumberOfImages != null) {
    setValueByPath(parentObject, ["parameters", "sampleCount"], fromNumberOfImages);
  }
  const fromAspectRatio = getValueByPath(fromObject, ["aspectRatio"]);
  if (parentObject !== void 0 && fromAspectRatio != null) {
    setValueByPath(parentObject, ["parameters", "aspectRatio"], fromAspectRatio);
  }
  const fromGuidanceScale = getValueByPath(fromObject, [
    "guidanceScale"
  ]);
  if (parentObject !== void 0 && fromGuidanceScale != null) {
    setValueByPath(parentObject, ["parameters", "guidanceScale"], fromGuidanceScale);
  }
  const fromSeed = getValueByPath(fromObject, ["seed"]);
  if (parentObject !== void 0 && fromSeed != null) {
    setValueByPath(parentObject, ["parameters", "seed"], fromSeed);
  }
  const fromSafetyFilterLevel = getValueByPath(fromObject, [
    "safetyFilterLevel"
  ]);
  if (parentObject !== void 0 && fromSafetyFilterLevel != null) {
    setValueByPath(parentObject, ["parameters", "safetySetting"], fromSafetyFilterLevel);
  }
  const fromPersonGeneration = getValueByPath(fromObject, [
    "personGeneration"
  ]);
  if (parentObject !== void 0 && fromPersonGeneration != null) {
    setValueByPath(parentObject, ["parameters", "personGeneration"], fromPersonGeneration);
  }
  const fromIncludeSafetyAttributes = getValueByPath(fromObject, [
    "includeSafetyAttributes"
  ]);
  if (parentObject !== void 0 && fromIncludeSafetyAttributes != null) {
    setValueByPath(parentObject, ["parameters", "includeSafetyAttributes"], fromIncludeSafetyAttributes);
  }
  const fromIncludeRaiReason = getValueByPath(fromObject, [
    "includeRaiReason"
  ]);
  if (parentObject !== void 0 && fromIncludeRaiReason != null) {
    setValueByPath(parentObject, ["parameters", "includeRaiReason"], fromIncludeRaiReason);
  }
  const fromLanguage = getValueByPath(fromObject, ["language"]);
  if (parentObject !== void 0 && fromLanguage != null) {
    setValueByPath(parentObject, ["parameters", "language"], fromLanguage);
  }
  const fromOutputMimeType = getValueByPath(fromObject, [
    "outputMimeType"
  ]);
  if (parentObject !== void 0 && fromOutputMimeType != null) {
    setValueByPath(parentObject, ["parameters", "outputOptions", "mimeType"], fromOutputMimeType);
  }
  const fromOutputCompressionQuality = getValueByPath(fromObject, [
    "outputCompressionQuality"
  ]);
  if (parentObject !== void 0 && fromOutputCompressionQuality != null) {
    setValueByPath(parentObject, ["parameters", "outputOptions", "compressionQuality"], fromOutputCompressionQuality);
  }
  const fromAddWatermark = getValueByPath(fromObject, ["addWatermark"]);
  if (parentObject !== void 0 && fromAddWatermark != null) {
    setValueByPath(parentObject, ["parameters", "addWatermark"], fromAddWatermark);
  }
  const fromLabels = getValueByPath(fromObject, ["labels"]);
  if (parentObject !== void 0 && fromLabels != null) {
    setValueByPath(parentObject, ["labels"], fromLabels);
  }
  const fromImageSize = getValueByPath(fromObject, ["imageSize"]);
  if (parentObject !== void 0 && fromImageSize != null) {
    setValueByPath(parentObject, ["parameters", "sampleImageSize"], fromImageSize);
  }
  const fromEnhancePrompt = getValueByPath(fromObject, [
    "enhancePrompt"
  ]);
  if (parentObject !== void 0 && fromEnhancePrompt != null) {
    setValueByPath(parentObject, ["parameters", "enhancePrompt"], fromEnhancePrompt);
  }
  return toObject;
}
__name(generateImagesConfigToVertex, "generateImagesConfigToVertex");
function generateImagesParametersToMldev(apiClient, fromObject, rootObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["_url", "model"], tModel(apiClient, fromModel));
  }
  const fromPrompt = getValueByPath(fromObject, ["prompt"]);
  if (fromPrompt != null) {
    setValueByPath(toObject, ["instances[0]", "prompt"], fromPrompt);
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    generateImagesConfigToMldev(fromConfig, toObject);
  }
  return toObject;
}
__name(generateImagesParametersToMldev, "generateImagesParametersToMldev");
function generateImagesParametersToVertex(apiClient, fromObject, rootObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["_url", "model"], tModel(apiClient, fromModel));
  }
  const fromPrompt = getValueByPath(fromObject, ["prompt"]);
  if (fromPrompt != null) {
    setValueByPath(toObject, ["instances[0]", "prompt"], fromPrompt);
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    generateImagesConfigToVertex(fromConfig, toObject);
  }
  return toObject;
}
__name(generateImagesParametersToVertex, "generateImagesParametersToVertex");
function generateImagesResponseFromMldev(fromObject, rootObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromGeneratedImages = getValueByPath(fromObject, [
    "predictions"
  ]);
  if (fromGeneratedImages != null) {
    let transformedList = fromGeneratedImages;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return generatedImageFromMldev(item);
      });
    }
    setValueByPath(toObject, ["generatedImages"], transformedList);
  }
  const fromPositivePromptSafetyAttributes = getValueByPath(fromObject, [
    "positivePromptSafetyAttributes"
  ]);
  if (fromPositivePromptSafetyAttributes != null) {
    setValueByPath(toObject, ["positivePromptSafetyAttributes"], safetyAttributesFromMldev(fromPositivePromptSafetyAttributes));
  }
  return toObject;
}
__name(generateImagesResponseFromMldev, "generateImagesResponseFromMldev");
function generateImagesResponseFromVertex(fromObject, rootObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromGeneratedImages = getValueByPath(fromObject, [
    "predictions"
  ]);
  if (fromGeneratedImages != null) {
    let transformedList = fromGeneratedImages;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return generatedImageFromVertex(item);
      });
    }
    setValueByPath(toObject, ["generatedImages"], transformedList);
  }
  const fromPositivePromptSafetyAttributes = getValueByPath(fromObject, [
    "positivePromptSafetyAttributes"
  ]);
  if (fromPositivePromptSafetyAttributes != null) {
    setValueByPath(toObject, ["positivePromptSafetyAttributes"], safetyAttributesFromVertex(fromPositivePromptSafetyAttributes));
  }
  return toObject;
}
__name(generateImagesResponseFromVertex, "generateImagesResponseFromVertex");
function generateVideosConfigToMldev(fromObject, parentObject, rootObject) {
  const toObject = {};
  const fromNumberOfVideos = getValueByPath(fromObject, [
    "numberOfVideos"
  ]);
  if (parentObject !== void 0 && fromNumberOfVideos != null) {
    setValueByPath(parentObject, ["parameters", "sampleCount"], fromNumberOfVideos);
  }
  if (getValueByPath(fromObject, ["outputGcsUri"]) !== void 0) {
    throw new Error("outputGcsUri parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["fps"]) !== void 0) {
    throw new Error("fps parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromDurationSeconds = getValueByPath(fromObject, [
    "durationSeconds"
  ]);
  if (parentObject !== void 0 && fromDurationSeconds != null) {
    setValueByPath(parentObject, ["parameters", "durationSeconds"], fromDurationSeconds);
  }
  if (getValueByPath(fromObject, ["seed"]) !== void 0) {
    throw new Error("seed parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromAspectRatio = getValueByPath(fromObject, ["aspectRatio"]);
  if (parentObject !== void 0 && fromAspectRatio != null) {
    setValueByPath(parentObject, ["parameters", "aspectRatio"], fromAspectRatio);
  }
  const fromResolution = getValueByPath(fromObject, ["resolution"]);
  if (parentObject !== void 0 && fromResolution != null) {
    setValueByPath(parentObject, ["parameters", "resolution"], fromResolution);
  }
  const fromPersonGeneration = getValueByPath(fromObject, [
    "personGeneration"
  ]);
  if (parentObject !== void 0 && fromPersonGeneration != null) {
    setValueByPath(parentObject, ["parameters", "personGeneration"], fromPersonGeneration);
  }
  if (getValueByPath(fromObject, ["pubsubTopic"]) !== void 0) {
    throw new Error("pubsubTopic parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromNegativePrompt = getValueByPath(fromObject, [
    "negativePrompt"
  ]);
  if (parentObject !== void 0 && fromNegativePrompt != null) {
    setValueByPath(parentObject, ["parameters", "negativePrompt"], fromNegativePrompt);
  }
  const fromEnhancePrompt = getValueByPath(fromObject, [
    "enhancePrompt"
  ]);
  if (parentObject !== void 0 && fromEnhancePrompt != null) {
    setValueByPath(parentObject, ["parameters", "enhancePrompt"], fromEnhancePrompt);
  }
  if (getValueByPath(fromObject, ["generateAudio"]) !== void 0) {
    throw new Error("generateAudio parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromLastFrame = getValueByPath(fromObject, ["lastFrame"]);
  if (parentObject !== void 0 && fromLastFrame != null) {
    setValueByPath(parentObject, ["instances[0]", "lastFrame"], imageToMldev(fromLastFrame));
  }
  const fromReferenceImages = getValueByPath(fromObject, [
    "referenceImages"
  ]);
  if (parentObject !== void 0 && fromReferenceImages != null) {
    let transformedList = fromReferenceImages;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return videoGenerationReferenceImageToMldev(item);
      });
    }
    setValueByPath(parentObject, ["instances[0]", "referenceImages"], transformedList);
  }
  if (getValueByPath(fromObject, ["mask"]) !== void 0) {
    throw new Error("mask parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["compressionQuality"]) !== void 0) {
    throw new Error("compressionQuality parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["labels"]) !== void 0) {
    throw new Error("labels parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromWebhookConfig = getValueByPath(fromObject, [
    "webhookConfig"
  ]);
  if (parentObject !== void 0 && fromWebhookConfig != null) {
    setValueByPath(parentObject, ["webhookConfig"], fromWebhookConfig);
  }
  if (getValueByPath(fromObject, ["resizeMode"]) !== void 0) {
    throw new Error("resizeMode parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(generateVideosConfigToMldev, "generateVideosConfigToMldev");
function generateVideosConfigToVertex(fromObject, parentObject, rootObject) {
  const toObject = {};
  const fromNumberOfVideos = getValueByPath(fromObject, [
    "numberOfVideos"
  ]);
  if (parentObject !== void 0 && fromNumberOfVideos != null) {
    setValueByPath(parentObject, ["parameters", "sampleCount"], fromNumberOfVideos);
  }
  const fromOutputGcsUri = getValueByPath(fromObject, ["outputGcsUri"]);
  if (parentObject !== void 0 && fromOutputGcsUri != null) {
    setValueByPath(parentObject, ["parameters", "storageUri"], fromOutputGcsUri);
  }
  const fromFps = getValueByPath(fromObject, ["fps"]);
  if (parentObject !== void 0 && fromFps != null) {
    setValueByPath(parentObject, ["parameters", "fps"], fromFps);
  }
  const fromDurationSeconds = getValueByPath(fromObject, [
    "durationSeconds"
  ]);
  if (parentObject !== void 0 && fromDurationSeconds != null) {
    setValueByPath(parentObject, ["parameters", "durationSeconds"], fromDurationSeconds);
  }
  const fromSeed = getValueByPath(fromObject, ["seed"]);
  if (parentObject !== void 0 && fromSeed != null) {
    setValueByPath(parentObject, ["parameters", "seed"], fromSeed);
  }
  const fromAspectRatio = getValueByPath(fromObject, ["aspectRatio"]);
  if (parentObject !== void 0 && fromAspectRatio != null) {
    setValueByPath(parentObject, ["parameters", "aspectRatio"], fromAspectRatio);
  }
  const fromResolution = getValueByPath(fromObject, ["resolution"]);
  if (parentObject !== void 0 && fromResolution != null) {
    setValueByPath(parentObject, ["parameters", "resolution"], fromResolution);
  }
  const fromPersonGeneration = getValueByPath(fromObject, [
    "personGeneration"
  ]);
  if (parentObject !== void 0 && fromPersonGeneration != null) {
    setValueByPath(parentObject, ["parameters", "personGeneration"], fromPersonGeneration);
  }
  const fromPubsubTopic = getValueByPath(fromObject, ["pubsubTopic"]);
  if (parentObject !== void 0 && fromPubsubTopic != null) {
    setValueByPath(parentObject, ["parameters", "pubsubTopic"], fromPubsubTopic);
  }
  const fromNegativePrompt = getValueByPath(fromObject, [
    "negativePrompt"
  ]);
  if (parentObject !== void 0 && fromNegativePrompt != null) {
    setValueByPath(parentObject, ["parameters", "negativePrompt"], fromNegativePrompt);
  }
  const fromEnhancePrompt = getValueByPath(fromObject, [
    "enhancePrompt"
  ]);
  if (parentObject !== void 0 && fromEnhancePrompt != null) {
    setValueByPath(parentObject, ["parameters", "enhancePrompt"], fromEnhancePrompt);
  }
  const fromGenerateAudio = getValueByPath(fromObject, [
    "generateAudio"
  ]);
  if (parentObject !== void 0 && fromGenerateAudio != null) {
    setValueByPath(parentObject, ["parameters", "generateAudio"], fromGenerateAudio);
  }
  const fromLastFrame = getValueByPath(fromObject, ["lastFrame"]);
  if (parentObject !== void 0 && fromLastFrame != null) {
    setValueByPath(parentObject, ["instances[0]", "lastFrame"], imageToVertex(fromLastFrame));
  }
  const fromReferenceImages = getValueByPath(fromObject, [
    "referenceImages"
  ]);
  if (parentObject !== void 0 && fromReferenceImages != null) {
    let transformedList = fromReferenceImages;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return videoGenerationReferenceImageToVertex(item);
      });
    }
    setValueByPath(parentObject, ["instances[0]", "referenceImages"], transformedList);
  }
  const fromMask = getValueByPath(fromObject, ["mask"]);
  if (parentObject !== void 0 && fromMask != null) {
    setValueByPath(parentObject, ["instances[0]", "mask"], videoGenerationMaskToVertex(fromMask));
  }
  const fromCompressionQuality = getValueByPath(fromObject, [
    "compressionQuality"
  ]);
  if (parentObject !== void 0 && fromCompressionQuality != null) {
    setValueByPath(parentObject, ["parameters", "compressionQuality"], fromCompressionQuality);
  }
  const fromLabels = getValueByPath(fromObject, ["labels"]);
  if (parentObject !== void 0 && fromLabels != null) {
    setValueByPath(parentObject, ["labels"], fromLabels);
  }
  if (getValueByPath(fromObject, ["webhookConfig"]) !== void 0) {
    throw new Error("webhookConfig parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  const fromResizeMode = getValueByPath(fromObject, ["resizeMode"]);
  if (parentObject !== void 0 && fromResizeMode != null) {
    setValueByPath(parentObject, ["parameters", "resizeMode"], fromResizeMode);
  }
  return toObject;
}
__name(generateVideosConfigToVertex, "generateVideosConfigToVertex");
function generateVideosOperationFromMldev(fromObject, rootObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["name"], fromName);
  }
  const fromMetadata = getValueByPath(fromObject, ["metadata"]);
  if (fromMetadata != null) {
    setValueByPath(toObject, ["metadata"], fromMetadata);
  }
  const fromDone = getValueByPath(fromObject, ["done"]);
  if (fromDone != null) {
    setValueByPath(toObject, ["done"], fromDone);
  }
  const fromError = getValueByPath(fromObject, ["error"]);
  if (fromError != null) {
    setValueByPath(toObject, ["error"], fromError);
  }
  const fromResponse = getValueByPath(fromObject, [
    "response",
    "generateVideoResponse"
  ]);
  if (fromResponse != null) {
    setValueByPath(toObject, ["response"], generateVideosResponseFromMldev(fromResponse));
  }
  return toObject;
}
__name(generateVideosOperationFromMldev, "generateVideosOperationFromMldev");
function generateVideosOperationFromVertex(fromObject, rootObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["name"], fromName);
  }
  const fromMetadata = getValueByPath(fromObject, ["metadata"]);
  if (fromMetadata != null) {
    setValueByPath(toObject, ["metadata"], fromMetadata);
  }
  const fromDone = getValueByPath(fromObject, ["done"]);
  if (fromDone != null) {
    setValueByPath(toObject, ["done"], fromDone);
  }
  const fromError = getValueByPath(fromObject, ["error"]);
  if (fromError != null) {
    setValueByPath(toObject, ["error"], fromError);
  }
  const fromResponse = getValueByPath(fromObject, ["response"]);
  if (fromResponse != null) {
    setValueByPath(toObject, ["response"], generateVideosResponseFromVertex(fromResponse));
  }
  return toObject;
}
__name(generateVideosOperationFromVertex, "generateVideosOperationFromVertex");
function generateVideosParametersToMldev(apiClient, fromObject, rootObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["_url", "model"], tModel(apiClient, fromModel));
  }
  const fromPrompt = getValueByPath(fromObject, ["prompt"]);
  if (fromPrompt != null) {
    setValueByPath(toObject, ["instances[0]", "prompt"], fromPrompt);
  }
  const fromImage = getValueByPath(fromObject, ["image"]);
  if (fromImage != null) {
    setValueByPath(toObject, ["instances[0]", "image"], imageToMldev(fromImage));
  }
  const fromVideo = getValueByPath(fromObject, ["video"]);
  if (fromVideo != null) {
    setValueByPath(toObject, ["instances[0]", "video"], videoToMldev(fromVideo));
  }
  const fromSource = getValueByPath(fromObject, ["source"]);
  if (fromSource != null) {
    generateVideosSourceToMldev(fromSource, toObject);
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    generateVideosConfigToMldev(fromConfig, toObject);
  }
  return toObject;
}
__name(generateVideosParametersToMldev, "generateVideosParametersToMldev");
function generateVideosParametersToVertex(apiClient, fromObject, rootObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["_url", "model"], tModel(apiClient, fromModel));
  }
  const fromPrompt = getValueByPath(fromObject, ["prompt"]);
  if (fromPrompt != null) {
    setValueByPath(toObject, ["instances[0]", "prompt"], fromPrompt);
  }
  const fromImage = getValueByPath(fromObject, ["image"]);
  if (fromImage != null) {
    setValueByPath(toObject, ["instances[0]", "image"], imageToVertex(fromImage));
  }
  const fromVideo = getValueByPath(fromObject, ["video"]);
  if (fromVideo != null) {
    setValueByPath(toObject, ["instances[0]", "video"], videoToVertex(fromVideo));
  }
  const fromSource = getValueByPath(fromObject, ["source"]);
  if (fromSource != null) {
    generateVideosSourceToVertex(fromSource, toObject);
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    generateVideosConfigToVertex(fromConfig, toObject);
  }
  return toObject;
}
__name(generateVideosParametersToVertex, "generateVideosParametersToVertex");
function generateVideosResponseFromMldev(fromObject, rootObject) {
  const toObject = {};
  const fromGeneratedVideos = getValueByPath(fromObject, [
    "generatedSamples"
  ]);
  if (fromGeneratedVideos != null) {
    let transformedList = fromGeneratedVideos;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return generatedVideoFromMldev(item);
      });
    }
    setValueByPath(toObject, ["generatedVideos"], transformedList);
  }
  const fromRaiMediaFilteredCount = getValueByPath(fromObject, [
    "raiMediaFilteredCount"
  ]);
  if (fromRaiMediaFilteredCount != null) {
    setValueByPath(toObject, ["raiMediaFilteredCount"], fromRaiMediaFilteredCount);
  }
  const fromRaiMediaFilteredReasons = getValueByPath(fromObject, [
    "raiMediaFilteredReasons"
  ]);
  if (fromRaiMediaFilteredReasons != null) {
    setValueByPath(toObject, ["raiMediaFilteredReasons"], fromRaiMediaFilteredReasons);
  }
  return toObject;
}
__name(generateVideosResponseFromMldev, "generateVideosResponseFromMldev");
function generateVideosResponseFromVertex(fromObject, rootObject) {
  const toObject = {};
  const fromGeneratedVideos = getValueByPath(fromObject, ["videos"]);
  if (fromGeneratedVideos != null) {
    let transformedList = fromGeneratedVideos;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return generatedVideoFromVertex(item);
      });
    }
    setValueByPath(toObject, ["generatedVideos"], transformedList);
  }
  const fromRaiMediaFilteredCount = getValueByPath(fromObject, [
    "raiMediaFilteredCount"
  ]);
  if (fromRaiMediaFilteredCount != null) {
    setValueByPath(toObject, ["raiMediaFilteredCount"], fromRaiMediaFilteredCount);
  }
  const fromRaiMediaFilteredReasons = getValueByPath(fromObject, [
    "raiMediaFilteredReasons"
  ]);
  if (fromRaiMediaFilteredReasons != null) {
    setValueByPath(toObject, ["raiMediaFilteredReasons"], fromRaiMediaFilteredReasons);
  }
  return toObject;
}
__name(generateVideosResponseFromVertex, "generateVideosResponseFromVertex");
function generateVideosSourceToMldev(fromObject, parentObject, rootObject) {
  const toObject = {};
  const fromPrompt = getValueByPath(fromObject, ["prompt"]);
  if (parentObject !== void 0 && fromPrompt != null) {
    setValueByPath(parentObject, ["instances[0]", "prompt"], fromPrompt);
  }
  const fromImage = getValueByPath(fromObject, ["image"]);
  if (parentObject !== void 0 && fromImage != null) {
    setValueByPath(parentObject, ["instances[0]", "image"], imageToMldev(fromImage));
  }
  const fromVideo = getValueByPath(fromObject, ["video"]);
  if (parentObject !== void 0 && fromVideo != null) {
    setValueByPath(parentObject, ["instances[0]", "video"], videoToMldev(fromVideo));
  }
  return toObject;
}
__name(generateVideosSourceToMldev, "generateVideosSourceToMldev");
function generateVideosSourceToVertex(fromObject, parentObject, rootObject) {
  const toObject = {};
  const fromPrompt = getValueByPath(fromObject, ["prompt"]);
  if (parentObject !== void 0 && fromPrompt != null) {
    setValueByPath(parentObject, ["instances[0]", "prompt"], fromPrompt);
  }
  const fromImage = getValueByPath(fromObject, ["image"]);
  if (parentObject !== void 0 && fromImage != null) {
    setValueByPath(parentObject, ["instances[0]", "image"], imageToVertex(fromImage));
  }
  const fromVideo = getValueByPath(fromObject, ["video"]);
  if (parentObject !== void 0 && fromVideo != null) {
    setValueByPath(parentObject, ["instances[0]", "video"], videoToVertex(fromVideo));
  }
  return toObject;
}
__name(generateVideosSourceToVertex, "generateVideosSourceToVertex");
function generatedImageFromMldev(fromObject, rootObject) {
  const toObject = {};
  const fromImage = getValueByPath(fromObject, ["_self"]);
  if (fromImage != null) {
    setValueByPath(toObject, ["image"], imageFromMldev(fromImage));
  }
  const fromRaiFilteredReason = getValueByPath(fromObject, [
    "raiFilteredReason"
  ]);
  if (fromRaiFilteredReason != null) {
    setValueByPath(toObject, ["raiFilteredReason"], fromRaiFilteredReason);
  }
  const fromSafetyAttributes = getValueByPath(fromObject, ["_self"]);
  if (fromSafetyAttributes != null) {
    setValueByPath(toObject, ["safetyAttributes"], safetyAttributesFromMldev(fromSafetyAttributes));
  }
  return toObject;
}
__name(generatedImageFromMldev, "generatedImageFromMldev");
function generatedImageFromVertex(fromObject, rootObject) {
  const toObject = {};
  const fromImage = getValueByPath(fromObject, ["_self"]);
  if (fromImage != null) {
    setValueByPath(toObject, ["image"], imageFromVertex(fromImage));
  }
  const fromRaiFilteredReason = getValueByPath(fromObject, [
    "raiFilteredReason"
  ]);
  if (fromRaiFilteredReason != null) {
    setValueByPath(toObject, ["raiFilteredReason"], fromRaiFilteredReason);
  }
  const fromSafetyAttributes = getValueByPath(fromObject, ["_self"]);
  if (fromSafetyAttributes != null) {
    setValueByPath(toObject, ["safetyAttributes"], safetyAttributesFromVertex(fromSafetyAttributes));
  }
  const fromEnhancedPrompt = getValueByPath(fromObject, ["prompt"]);
  if (fromEnhancedPrompt != null) {
    setValueByPath(toObject, ["enhancedPrompt"], fromEnhancedPrompt);
  }
  return toObject;
}
__name(generatedImageFromVertex, "generatedImageFromVertex");
function generatedImageMaskFromVertex(fromObject, rootObject) {
  const toObject = {};
  const fromMask = getValueByPath(fromObject, ["_self"]);
  if (fromMask != null) {
    setValueByPath(toObject, ["mask"], imageFromVertex(fromMask));
  }
  const fromLabels = getValueByPath(fromObject, ["labels"]);
  if (fromLabels != null) {
    let transformedList = fromLabels;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["labels"], transformedList);
  }
  return toObject;
}
__name(generatedImageMaskFromVertex, "generatedImageMaskFromVertex");
function generatedVideoFromMldev(fromObject, rootObject) {
  const toObject = {};
  const fromVideo = getValueByPath(fromObject, ["video"]);
  if (fromVideo != null) {
    setValueByPath(toObject, ["video"], videoFromMldev(fromVideo));
  }
  return toObject;
}
__name(generatedVideoFromMldev, "generatedVideoFromMldev");
function generatedVideoFromVertex(fromObject, rootObject) {
  const toObject = {};
  const fromVideo = getValueByPath(fromObject, ["_self"]);
  if (fromVideo != null) {
    setValueByPath(toObject, ["video"], videoFromVertex(fromVideo));
  }
  return toObject;
}
__name(generatedVideoFromVertex, "generatedVideoFromVertex");
function generationConfigToVertex(fromObject, _rootObject) {
  const toObject = {};
  const fromModelSelectionConfig = getValueByPath(fromObject, [
    "modelSelectionConfig"
  ]);
  if (fromModelSelectionConfig != null) {
    setValueByPath(toObject, ["modelConfig"], fromModelSelectionConfig);
  }
  const fromResponseJsonSchema = getValueByPath(fromObject, [
    "responseJsonSchema"
  ]);
  if (fromResponseJsonSchema != null) {
    setValueByPath(toObject, ["responseJsonSchema"], fromResponseJsonSchema);
  }
  const fromAudioTimestamp = getValueByPath(fromObject, [
    "audioTimestamp"
  ]);
  if (fromAudioTimestamp != null) {
    setValueByPath(toObject, ["audioTimestamp"], fromAudioTimestamp);
  }
  const fromCandidateCount = getValueByPath(fromObject, [
    "candidateCount"
  ]);
  if (fromCandidateCount != null) {
    setValueByPath(toObject, ["candidateCount"], fromCandidateCount);
  }
  const fromEnableAffectiveDialog = getValueByPath(fromObject, [
    "enableAffectiveDialog"
  ]);
  if (fromEnableAffectiveDialog != null) {
    setValueByPath(toObject, ["enableAffectiveDialog"], fromEnableAffectiveDialog);
  }
  const fromFrequencyPenalty = getValueByPath(fromObject, [
    "frequencyPenalty"
  ]);
  if (fromFrequencyPenalty != null) {
    setValueByPath(toObject, ["frequencyPenalty"], fromFrequencyPenalty);
  }
  const fromLogprobs = getValueByPath(fromObject, ["logprobs"]);
  if (fromLogprobs != null) {
    setValueByPath(toObject, ["logprobs"], fromLogprobs);
  }
  const fromMaxOutputTokens = getValueByPath(fromObject, [
    "maxOutputTokens"
  ]);
  if (fromMaxOutputTokens != null) {
    setValueByPath(toObject, ["maxOutputTokens"], fromMaxOutputTokens);
  }
  const fromMediaResolution = getValueByPath(fromObject, [
    "mediaResolution"
  ]);
  if (fromMediaResolution != null) {
    setValueByPath(toObject, ["mediaResolution"], fromMediaResolution);
  }
  const fromPresencePenalty = getValueByPath(fromObject, [
    "presencePenalty"
  ]);
  if (fromPresencePenalty != null) {
    setValueByPath(toObject, ["presencePenalty"], fromPresencePenalty);
  }
  const fromResponseLogprobs = getValueByPath(fromObject, [
    "responseLogprobs"
  ]);
  if (fromResponseLogprobs != null) {
    setValueByPath(toObject, ["responseLogprobs"], fromResponseLogprobs);
  }
  const fromResponseMimeType = getValueByPath(fromObject, [
    "responseMimeType"
  ]);
  if (fromResponseMimeType != null) {
    setValueByPath(toObject, ["responseMimeType"], fromResponseMimeType);
  }
  const fromResponseModalities = getValueByPath(fromObject, [
    "responseModalities"
  ]);
  if (fromResponseModalities != null) {
    setValueByPath(toObject, ["responseModalities"], fromResponseModalities);
  }
  const fromResponseSchema = getValueByPath(fromObject, [
    "responseSchema"
  ]);
  if (fromResponseSchema != null) {
    setValueByPath(toObject, ["responseSchema"], fromResponseSchema);
  }
  const fromRoutingConfig = getValueByPath(fromObject, [
    "routingConfig"
  ]);
  if (fromRoutingConfig != null) {
    setValueByPath(toObject, ["routingConfig"], fromRoutingConfig);
  }
  const fromSeed = getValueByPath(fromObject, ["seed"]);
  if (fromSeed != null) {
    setValueByPath(toObject, ["seed"], fromSeed);
  }
  const fromSpeechConfig = getValueByPath(fromObject, ["speechConfig"]);
  if (fromSpeechConfig != null) {
    setValueByPath(toObject, ["speechConfig"], fromSpeechConfig);
  }
  const fromStopSequences = getValueByPath(fromObject, [
    "stopSequences"
  ]);
  if (fromStopSequences != null) {
    setValueByPath(toObject, ["stopSequences"], fromStopSequences);
  }
  const fromTemperature = getValueByPath(fromObject, ["temperature"]);
  if (fromTemperature != null) {
    setValueByPath(toObject, ["temperature"], fromTemperature);
  }
  const fromThinkingConfig = getValueByPath(fromObject, [
    "thinkingConfig"
  ]);
  if (fromThinkingConfig != null) {
    setValueByPath(toObject, ["thinkingConfig"], fromThinkingConfig);
  }
  const fromTopK = getValueByPath(fromObject, ["topK"]);
  if (fromTopK != null) {
    setValueByPath(toObject, ["topK"], fromTopK);
  }
  const fromTopP = getValueByPath(fromObject, ["topP"]);
  if (fromTopP != null) {
    setValueByPath(toObject, ["topP"], fromTopP);
  }
  if (getValueByPath(fromObject, ["enableEnhancedCivicAnswers"]) !== void 0) {
    throw new Error("enableEnhancedCivicAnswers parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  return toObject;
}
__name(generationConfigToVertex, "generationConfigToVertex");
function getModelParametersToMldev(apiClient, fromObject, _rootObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["_url", "name"], tModel(apiClient, fromModel));
  }
  return toObject;
}
__name(getModelParametersToMldev, "getModelParametersToMldev");
function getModelParametersToVertex(apiClient, fromObject, _rootObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["_url", "name"], tModel(apiClient, fromModel));
  }
  return toObject;
}
__name(getModelParametersToVertex, "getModelParametersToVertex");
function googleMapsToMldev$1(fromObject, rootObject) {
  const toObject = {};
  const fromAuthConfig = getValueByPath(fromObject, ["authConfig"]);
  if (fromAuthConfig != null) {
    setValueByPath(toObject, ["authConfig"], authConfigToMldev$1(fromAuthConfig));
  }
  const fromEnableWidget = getValueByPath(fromObject, ["enableWidget"]);
  if (fromEnableWidget != null) {
    setValueByPath(toObject, ["enableWidget"], fromEnableWidget);
  }
  return toObject;
}
__name(googleMapsToMldev$1, "googleMapsToMldev$1");
function googleSearchToMldev$1(fromObject, _rootObject) {
  const toObject = {};
  const fromSearchTypes = getValueByPath(fromObject, ["searchTypes"]);
  if (fromSearchTypes != null) {
    setValueByPath(toObject, ["searchTypes"], fromSearchTypes);
  }
  if (getValueByPath(fromObject, ["blockingConfidence"]) !== void 0) {
    throw new Error("blockingConfidence parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["excludeDomains"]) !== void 0) {
    throw new Error("excludeDomains parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromTimeRangeFilter = getValueByPath(fromObject, [
    "timeRangeFilter"
  ]);
  if (fromTimeRangeFilter != null) {
    setValueByPath(toObject, ["timeRangeFilter"], fromTimeRangeFilter);
  }
  return toObject;
}
__name(googleSearchToMldev$1, "googleSearchToMldev$1");
function imageConfigToMldev(fromObject, _rootObject) {
  const toObject = {};
  const fromAspectRatio = getValueByPath(fromObject, ["aspectRatio"]);
  if (fromAspectRatio != null) {
    setValueByPath(toObject, ["aspectRatio"], fromAspectRatio);
  }
  const fromImageSize = getValueByPath(fromObject, ["imageSize"]);
  if (fromImageSize != null) {
    setValueByPath(toObject, ["imageSize"], fromImageSize);
  }
  if (getValueByPath(fromObject, ["personGeneration"]) !== void 0) {
    throw new Error("personGeneration parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["prominentPeople"]) !== void 0) {
    throw new Error("prominentPeople parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["outputMimeType"]) !== void 0) {
    throw new Error("outputMimeType parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["outputCompressionQuality"]) !== void 0) {
    throw new Error("outputCompressionQuality parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["imageOutputOptions"]) !== void 0) {
    throw new Error("imageOutputOptions parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(imageConfigToMldev, "imageConfigToMldev");
function imageConfigToVertex(fromObject, _rootObject) {
  const toObject = {};
  const fromAspectRatio = getValueByPath(fromObject, ["aspectRatio"]);
  if (fromAspectRatio != null) {
    setValueByPath(toObject, ["aspectRatio"], fromAspectRatio);
  }
  const fromImageSize = getValueByPath(fromObject, ["imageSize"]);
  if (fromImageSize != null) {
    setValueByPath(toObject, ["imageSize"], fromImageSize);
  }
  const fromPersonGeneration = getValueByPath(fromObject, [
    "personGeneration"
  ]);
  if (fromPersonGeneration != null) {
    setValueByPath(toObject, ["personGeneration"], fromPersonGeneration);
  }
  const fromProminentPeople = getValueByPath(fromObject, [
    "prominentPeople"
  ]);
  if (fromProminentPeople != null) {
    setValueByPath(toObject, ["prominentPeople"], fromProminentPeople);
  }
  const fromOutputMimeType = getValueByPath(fromObject, [
    "outputMimeType"
  ]);
  if (fromOutputMimeType != null) {
    setValueByPath(toObject, ["imageOutputOptions", "mimeType"], fromOutputMimeType);
  }
  const fromOutputCompressionQuality = getValueByPath(fromObject, [
    "outputCompressionQuality"
  ]);
  if (fromOutputCompressionQuality != null) {
    setValueByPath(toObject, ["imageOutputOptions", "compressionQuality"], fromOutputCompressionQuality);
  }
  const fromImageOutputOptions = getValueByPath(fromObject, [
    "imageOutputOptions"
  ]);
  if (fromImageOutputOptions != null) {
    setValueByPath(toObject, ["imageOutputOptions"], fromImageOutputOptions);
  }
  return toObject;
}
__name(imageConfigToVertex, "imageConfigToVertex");
function imageFromMldev(fromObject, _rootObject) {
  const toObject = {};
  const fromImageBytes = getValueByPath(fromObject, [
    "bytesBase64Encoded"
  ]);
  if (fromImageBytes != null) {
    setValueByPath(toObject, ["imageBytes"], tBytes(fromImageBytes));
  }
  const fromMimeType = getValueByPath(fromObject, ["mimeType"]);
  if (fromMimeType != null) {
    setValueByPath(toObject, ["mimeType"], fromMimeType);
  }
  return toObject;
}
__name(imageFromMldev, "imageFromMldev");
function imageFromVertex(fromObject, _rootObject) {
  const toObject = {};
  const fromGcsUri = getValueByPath(fromObject, ["gcsUri"]);
  if (fromGcsUri != null) {
    setValueByPath(toObject, ["gcsUri"], fromGcsUri);
  }
  const fromImageBytes = getValueByPath(fromObject, [
    "bytesBase64Encoded"
  ]);
  if (fromImageBytes != null) {
    setValueByPath(toObject, ["imageBytes"], tBytes(fromImageBytes));
  }
  const fromMimeType = getValueByPath(fromObject, ["mimeType"]);
  if (fromMimeType != null) {
    setValueByPath(toObject, ["mimeType"], fromMimeType);
  }
  return toObject;
}
__name(imageFromVertex, "imageFromVertex");
function imageToMldev(fromObject, _rootObject) {
  const toObject = {};
  if (getValueByPath(fromObject, ["gcsUri"]) !== void 0) {
    throw new Error("gcsUri parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromImageBytes = getValueByPath(fromObject, ["imageBytes"]);
  if (fromImageBytes != null) {
    setValueByPath(toObject, ["bytesBase64Encoded"], tBytes(fromImageBytes));
  }
  const fromMimeType = getValueByPath(fromObject, ["mimeType"]);
  if (fromMimeType != null) {
    setValueByPath(toObject, ["mimeType"], fromMimeType);
  }
  return toObject;
}
__name(imageToMldev, "imageToMldev");
function imageToVertex(fromObject, _rootObject) {
  const toObject = {};
  const fromGcsUri = getValueByPath(fromObject, ["gcsUri"]);
  if (fromGcsUri != null) {
    setValueByPath(toObject, ["gcsUri"], fromGcsUri);
  }
  const fromImageBytes = getValueByPath(fromObject, ["imageBytes"]);
  if (fromImageBytes != null) {
    setValueByPath(toObject, ["bytesBase64Encoded"], tBytes(fromImageBytes));
  }
  const fromMimeType = getValueByPath(fromObject, ["mimeType"]);
  if (fromMimeType != null) {
    setValueByPath(toObject, ["mimeType"], fromMimeType);
  }
  return toObject;
}
__name(imageToVertex, "imageToVertex");
function listModelsConfigToMldev(apiClient, fromObject, parentObject, _rootObject) {
  const toObject = {};
  const fromPageSize = getValueByPath(fromObject, ["pageSize"]);
  if (parentObject !== void 0 && fromPageSize != null) {
    setValueByPath(parentObject, ["_query", "pageSize"], fromPageSize);
  }
  const fromPageToken = getValueByPath(fromObject, ["pageToken"]);
  if (parentObject !== void 0 && fromPageToken != null) {
    setValueByPath(parentObject, ["_query", "pageToken"], fromPageToken);
  }
  const fromFilter = getValueByPath(fromObject, ["filter"]);
  if (parentObject !== void 0 && fromFilter != null) {
    setValueByPath(parentObject, ["_query", "filter"], fromFilter);
  }
  const fromQueryBase = getValueByPath(fromObject, ["queryBase"]);
  if (parentObject !== void 0 && fromQueryBase != null) {
    setValueByPath(parentObject, ["_url", "models_url"], tModelsUrl(apiClient, fromQueryBase));
  }
  return toObject;
}
__name(listModelsConfigToMldev, "listModelsConfigToMldev");
function listModelsConfigToVertex(apiClient, fromObject, parentObject, _rootObject) {
  const toObject = {};
  const fromPageSize = getValueByPath(fromObject, ["pageSize"]);
  if (parentObject !== void 0 && fromPageSize != null) {
    setValueByPath(parentObject, ["_query", "pageSize"], fromPageSize);
  }
  const fromPageToken = getValueByPath(fromObject, ["pageToken"]);
  if (parentObject !== void 0 && fromPageToken != null) {
    setValueByPath(parentObject, ["_query", "pageToken"], fromPageToken);
  }
  const fromFilter = getValueByPath(fromObject, ["filter"]);
  if (parentObject !== void 0 && fromFilter != null) {
    setValueByPath(parentObject, ["_query", "filter"], fromFilter);
  }
  const fromQueryBase = getValueByPath(fromObject, ["queryBase"]);
  if (parentObject !== void 0 && fromQueryBase != null) {
    setValueByPath(parentObject, ["_url", "models_url"], tModelsUrl(apiClient, fromQueryBase));
  }
  return toObject;
}
__name(listModelsConfigToVertex, "listModelsConfigToVertex");
function listModelsParametersToMldev(apiClient, fromObject, rootObject) {
  const toObject = {};
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    listModelsConfigToMldev(apiClient, fromConfig, toObject);
  }
  return toObject;
}
__name(listModelsParametersToMldev, "listModelsParametersToMldev");
function listModelsParametersToVertex(apiClient, fromObject, rootObject) {
  const toObject = {};
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    listModelsConfigToVertex(apiClient, fromConfig, toObject);
  }
  return toObject;
}
__name(listModelsParametersToVertex, "listModelsParametersToVertex");
function listModelsResponseFromMldev(fromObject, rootObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromNextPageToken = getValueByPath(fromObject, [
    "nextPageToken"
  ]);
  if (fromNextPageToken != null) {
    setValueByPath(toObject, ["nextPageToken"], fromNextPageToken);
  }
  const fromModels = getValueByPath(fromObject, ["_self"]);
  if (fromModels != null) {
    let transformedList = tExtractModels(fromModels);
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return modelFromMldev(item);
      });
    }
    setValueByPath(toObject, ["models"], transformedList);
  }
  return toObject;
}
__name(listModelsResponseFromMldev, "listModelsResponseFromMldev");
function listModelsResponseFromVertex(fromObject, rootObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromNextPageToken = getValueByPath(fromObject, [
    "nextPageToken"
  ]);
  if (fromNextPageToken != null) {
    setValueByPath(toObject, ["nextPageToken"], fromNextPageToken);
  }
  const fromModels = getValueByPath(fromObject, ["_self"]);
  if (fromModels != null) {
    let transformedList = tExtractModels(fromModels);
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return modelFromVertex(item);
      });
    }
    setValueByPath(toObject, ["models"], transformedList);
  }
  return toObject;
}
__name(listModelsResponseFromVertex, "listModelsResponseFromVertex");
function maskReferenceConfigToVertex(fromObject, _rootObject) {
  const toObject = {};
  const fromMaskMode = getValueByPath(fromObject, ["maskMode"]);
  if (fromMaskMode != null) {
    setValueByPath(toObject, ["maskMode"], fromMaskMode);
  }
  const fromSegmentationClasses = getValueByPath(fromObject, [
    "segmentationClasses"
  ]);
  if (fromSegmentationClasses != null) {
    setValueByPath(toObject, ["maskClasses"], fromSegmentationClasses);
  }
  const fromMaskDilation = getValueByPath(fromObject, ["maskDilation"]);
  if (fromMaskDilation != null) {
    setValueByPath(toObject, ["dilation"], fromMaskDilation);
  }
  return toObject;
}
__name(maskReferenceConfigToVertex, "maskReferenceConfigToVertex");
function modelFromMldev(fromObject, rootObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["name"], fromName);
  }
  const fromDisplayName = getValueByPath(fromObject, ["displayName"]);
  if (fromDisplayName != null) {
    setValueByPath(toObject, ["displayName"], fromDisplayName);
  }
  const fromDescription = getValueByPath(fromObject, ["description"]);
  if (fromDescription != null) {
    setValueByPath(toObject, ["description"], fromDescription);
  }
  const fromVersion = getValueByPath(fromObject, ["version"]);
  if (fromVersion != null) {
    setValueByPath(toObject, ["version"], fromVersion);
  }
  const fromTunedModelInfo = getValueByPath(fromObject, ["_self"]);
  if (fromTunedModelInfo != null) {
    setValueByPath(toObject, ["tunedModelInfo"], tunedModelInfoFromMldev(fromTunedModelInfo));
  }
  const fromInputTokenLimit = getValueByPath(fromObject, [
    "inputTokenLimit"
  ]);
  if (fromInputTokenLimit != null) {
    setValueByPath(toObject, ["inputTokenLimit"], fromInputTokenLimit);
  }
  const fromOutputTokenLimit = getValueByPath(fromObject, [
    "outputTokenLimit"
  ]);
  if (fromOutputTokenLimit != null) {
    setValueByPath(toObject, ["outputTokenLimit"], fromOutputTokenLimit);
  }
  const fromSupportedActions = getValueByPath(fromObject, [
    "supportedGenerationMethods"
  ]);
  if (fromSupportedActions != null) {
    setValueByPath(toObject, ["supportedActions"], fromSupportedActions);
  }
  const fromTemperature = getValueByPath(fromObject, ["temperature"]);
  if (fromTemperature != null) {
    setValueByPath(toObject, ["temperature"], fromTemperature);
  }
  const fromMaxTemperature = getValueByPath(fromObject, [
    "maxTemperature"
  ]);
  if (fromMaxTemperature != null) {
    setValueByPath(toObject, ["maxTemperature"], fromMaxTemperature);
  }
  const fromTopP = getValueByPath(fromObject, ["topP"]);
  if (fromTopP != null) {
    setValueByPath(toObject, ["topP"], fromTopP);
  }
  const fromTopK = getValueByPath(fromObject, ["topK"]);
  if (fromTopK != null) {
    setValueByPath(toObject, ["topK"], fromTopK);
  }
  const fromThinking = getValueByPath(fromObject, ["thinking"]);
  if (fromThinking != null) {
    setValueByPath(toObject, ["thinking"], fromThinking);
  }
  return toObject;
}
__name(modelFromMldev, "modelFromMldev");
function modelFromVertex(fromObject, rootObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["name"], fromName);
  }
  const fromDisplayName = getValueByPath(fromObject, ["displayName"]);
  if (fromDisplayName != null) {
    setValueByPath(toObject, ["displayName"], fromDisplayName);
  }
  const fromDescription = getValueByPath(fromObject, ["description"]);
  if (fromDescription != null) {
    setValueByPath(toObject, ["description"], fromDescription);
  }
  const fromVersion = getValueByPath(fromObject, ["versionId"]);
  if (fromVersion != null) {
    setValueByPath(toObject, ["version"], fromVersion);
  }
  const fromEndpoints = getValueByPath(fromObject, ["deployedModels"]);
  if (fromEndpoints != null) {
    let transformedList = fromEndpoints;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return endpointFromVertex(item);
      });
    }
    setValueByPath(toObject, ["endpoints"], transformedList);
  }
  const fromLabels = getValueByPath(fromObject, ["labels"]);
  if (fromLabels != null) {
    setValueByPath(toObject, ["labels"], fromLabels);
  }
  const fromTunedModelInfo = getValueByPath(fromObject, ["_self"]);
  if (fromTunedModelInfo != null) {
    setValueByPath(toObject, ["tunedModelInfo"], tunedModelInfoFromVertex(fromTunedModelInfo));
  }
  const fromDefaultCheckpointId = getValueByPath(fromObject, [
    "defaultCheckpointId"
  ]);
  if (fromDefaultCheckpointId != null) {
    setValueByPath(toObject, ["defaultCheckpointId"], fromDefaultCheckpointId);
  }
  const fromCheckpoints = getValueByPath(fromObject, ["checkpoints"]);
  if (fromCheckpoints != null) {
    let transformedList = fromCheckpoints;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["checkpoints"], transformedList);
  }
  return toObject;
}
__name(modelFromVertex, "modelFromVertex");
function partToMldev$1(fromObject, rootObject) {
  const toObject = {};
  const fromMediaResolution = getValueByPath(fromObject, [
    "mediaResolution"
  ]);
  if (fromMediaResolution != null) {
    setValueByPath(toObject, ["mediaResolution"], fromMediaResolution);
  }
  const fromCodeExecutionResult = getValueByPath(fromObject, [
    "codeExecutionResult"
  ]);
  if (fromCodeExecutionResult != null) {
    setValueByPath(toObject, ["codeExecutionResult"], fromCodeExecutionResult);
  }
  const fromExecutableCode = getValueByPath(fromObject, [
    "executableCode"
  ]);
  if (fromExecutableCode != null) {
    setValueByPath(toObject, ["executableCode"], fromExecutableCode);
  }
  const fromFileData = getValueByPath(fromObject, ["fileData"]);
  if (fromFileData != null) {
    setValueByPath(toObject, ["fileData"], fileDataToMldev$1(fromFileData));
  }
  const fromFunctionCall = getValueByPath(fromObject, ["functionCall"]);
  if (fromFunctionCall != null) {
    setValueByPath(toObject, ["functionCall"], functionCallToMldev$1(fromFunctionCall));
  }
  const fromFunctionResponse = getValueByPath(fromObject, [
    "functionResponse"
  ]);
  if (fromFunctionResponse != null) {
    setValueByPath(toObject, ["functionResponse"], fromFunctionResponse);
  }
  const fromInlineData = getValueByPath(fromObject, ["inlineData"]);
  if (fromInlineData != null) {
    setValueByPath(toObject, ["inlineData"], blobToMldev$1(fromInlineData));
  }
  const fromText = getValueByPath(fromObject, ["text"]);
  if (fromText != null) {
    setValueByPath(toObject, ["text"], fromText);
  }
  const fromThought = getValueByPath(fromObject, ["thought"]);
  if (fromThought != null) {
    setValueByPath(toObject, ["thought"], fromThought);
  }
  const fromThoughtSignature = getValueByPath(fromObject, [
    "thoughtSignature"
  ]);
  if (fromThoughtSignature != null) {
    setValueByPath(toObject, ["thoughtSignature"], fromThoughtSignature);
  }
  const fromVideoMetadata = getValueByPath(fromObject, [
    "videoMetadata"
  ]);
  if (fromVideoMetadata != null) {
    setValueByPath(toObject, ["videoMetadata"], fromVideoMetadata);
  }
  const fromToolCall = getValueByPath(fromObject, ["toolCall"]);
  if (fromToolCall != null) {
    setValueByPath(toObject, ["toolCall"], fromToolCall);
  }
  const fromToolResponse = getValueByPath(fromObject, ["toolResponse"]);
  if (fromToolResponse != null) {
    setValueByPath(toObject, ["toolResponse"], fromToolResponse);
  }
  const fromPartMetadata = getValueByPath(fromObject, ["partMetadata"]);
  if (fromPartMetadata != null) {
    setValueByPath(toObject, ["partMetadata"], fromPartMetadata);
  }
  return toObject;
}
__name(partToMldev$1, "partToMldev$1");
function partToVertex(fromObject, rootObject) {
  const toObject = {};
  const fromMediaResolution = getValueByPath(fromObject, [
    "mediaResolution"
  ]);
  if (fromMediaResolution != null) {
    setValueByPath(toObject, ["mediaResolution"], fromMediaResolution);
  }
  const fromCodeExecutionResult = getValueByPath(fromObject, [
    "codeExecutionResult"
  ]);
  if (fromCodeExecutionResult != null) {
    setValueByPath(toObject, ["codeExecutionResult"], codeExecutionResultToVertex(fromCodeExecutionResult));
  }
  const fromExecutableCode = getValueByPath(fromObject, [
    "executableCode"
  ]);
  if (fromExecutableCode != null) {
    setValueByPath(toObject, ["executableCode"], executableCodeToVertex(fromExecutableCode));
  }
  const fromFileData = getValueByPath(fromObject, ["fileData"]);
  if (fromFileData != null) {
    setValueByPath(toObject, ["fileData"], fromFileData);
  }
  const fromFunctionCall = getValueByPath(fromObject, ["functionCall"]);
  if (fromFunctionCall != null) {
    setValueByPath(toObject, ["functionCall"], fromFunctionCall);
  }
  const fromFunctionResponse = getValueByPath(fromObject, [
    "functionResponse"
  ]);
  if (fromFunctionResponse != null) {
    setValueByPath(toObject, ["functionResponse"], fromFunctionResponse);
  }
  const fromInlineData = getValueByPath(fromObject, ["inlineData"]);
  if (fromInlineData != null) {
    setValueByPath(toObject, ["inlineData"], fromInlineData);
  }
  const fromText = getValueByPath(fromObject, ["text"]);
  if (fromText != null) {
    setValueByPath(toObject, ["text"], fromText);
  }
  const fromThought = getValueByPath(fromObject, ["thought"]);
  if (fromThought != null) {
    setValueByPath(toObject, ["thought"], fromThought);
  }
  const fromThoughtSignature = getValueByPath(fromObject, [
    "thoughtSignature"
  ]);
  if (fromThoughtSignature != null) {
    setValueByPath(toObject, ["thoughtSignature"], fromThoughtSignature);
  }
  const fromVideoMetadata = getValueByPath(fromObject, [
    "videoMetadata"
  ]);
  if (fromVideoMetadata != null) {
    setValueByPath(toObject, ["videoMetadata"], fromVideoMetadata);
  }
  if (getValueByPath(fromObject, ["toolCall"]) !== void 0) {
    throw new Error("toolCall parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  if (getValueByPath(fromObject, ["toolResponse"]) !== void 0) {
    throw new Error("toolResponse parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  if (getValueByPath(fromObject, ["partMetadata"]) !== void 0) {
    throw new Error("partMetadata parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  return toObject;
}
__name(partToVertex, "partToVertex");
function productImageToVertex(fromObject, rootObject) {
  const toObject = {};
  const fromProductImage = getValueByPath(fromObject, ["productImage"]);
  if (fromProductImage != null) {
    setValueByPath(toObject, ["image"], imageToVertex(fromProductImage));
  }
  return toObject;
}
__name(productImageToVertex, "productImageToVertex");
function recontextImageConfigToVertex(fromObject, parentObject, _rootObject) {
  const toObject = {};
  const fromNumberOfImages = getValueByPath(fromObject, [
    "numberOfImages"
  ]);
  if (parentObject !== void 0 && fromNumberOfImages != null) {
    setValueByPath(parentObject, ["parameters", "sampleCount"], fromNumberOfImages);
  }
  const fromBaseSteps = getValueByPath(fromObject, ["baseSteps"]);
  if (parentObject !== void 0 && fromBaseSteps != null) {
    setValueByPath(parentObject, ["parameters", "baseSteps"], fromBaseSteps);
  }
  const fromOutputGcsUri = getValueByPath(fromObject, ["outputGcsUri"]);
  if (parentObject !== void 0 && fromOutputGcsUri != null) {
    setValueByPath(parentObject, ["parameters", "storageUri"], fromOutputGcsUri);
  }
  const fromSeed = getValueByPath(fromObject, ["seed"]);
  if (parentObject !== void 0 && fromSeed != null) {
    setValueByPath(parentObject, ["parameters", "seed"], fromSeed);
  }
  const fromSafetyFilterLevel = getValueByPath(fromObject, [
    "safetyFilterLevel"
  ]);
  if (parentObject !== void 0 && fromSafetyFilterLevel != null) {
    setValueByPath(parentObject, ["parameters", "safetySetting"], fromSafetyFilterLevel);
  }
  const fromPersonGeneration = getValueByPath(fromObject, [
    "personGeneration"
  ]);
  if (parentObject !== void 0 && fromPersonGeneration != null) {
    setValueByPath(parentObject, ["parameters", "personGeneration"], fromPersonGeneration);
  }
  const fromAddWatermark = getValueByPath(fromObject, ["addWatermark"]);
  if (parentObject !== void 0 && fromAddWatermark != null) {
    setValueByPath(parentObject, ["parameters", "addWatermark"], fromAddWatermark);
  }
  const fromOutputMimeType = getValueByPath(fromObject, [
    "outputMimeType"
  ]);
  if (parentObject !== void 0 && fromOutputMimeType != null) {
    setValueByPath(parentObject, ["parameters", "outputOptions", "mimeType"], fromOutputMimeType);
  }
  const fromOutputCompressionQuality = getValueByPath(fromObject, [
    "outputCompressionQuality"
  ]);
  if (parentObject !== void 0 && fromOutputCompressionQuality != null) {
    setValueByPath(parentObject, ["parameters", "outputOptions", "compressionQuality"], fromOutputCompressionQuality);
  }
  const fromEnhancePrompt = getValueByPath(fromObject, [
    "enhancePrompt"
  ]);
  if (parentObject !== void 0 && fromEnhancePrompt != null) {
    setValueByPath(parentObject, ["parameters", "enhancePrompt"], fromEnhancePrompt);
  }
  const fromLabels = getValueByPath(fromObject, ["labels"]);
  if (parentObject !== void 0 && fromLabels != null) {
    setValueByPath(parentObject, ["labels"], fromLabels);
  }
  return toObject;
}
__name(recontextImageConfigToVertex, "recontextImageConfigToVertex");
function recontextImageParametersToVertex(apiClient, fromObject, rootObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["_url", "model"], tModel(apiClient, fromModel));
  }
  const fromSource = getValueByPath(fromObject, ["source"]);
  if (fromSource != null) {
    recontextImageSourceToVertex(fromSource, toObject);
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    recontextImageConfigToVertex(fromConfig, toObject);
  }
  return toObject;
}
__name(recontextImageParametersToVertex, "recontextImageParametersToVertex");
function recontextImageResponseFromVertex(fromObject, rootObject) {
  const toObject = {};
  const fromGeneratedImages = getValueByPath(fromObject, [
    "predictions"
  ]);
  if (fromGeneratedImages != null) {
    let transformedList = fromGeneratedImages;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return generatedImageFromVertex(item);
      });
    }
    setValueByPath(toObject, ["generatedImages"], transformedList);
  }
  return toObject;
}
__name(recontextImageResponseFromVertex, "recontextImageResponseFromVertex");
function recontextImageSourceToVertex(fromObject, parentObject, rootObject) {
  const toObject = {};
  const fromPrompt = getValueByPath(fromObject, ["prompt"]);
  if (parentObject !== void 0 && fromPrompt != null) {
    setValueByPath(parentObject, ["instances[0]", "prompt"], fromPrompt);
  }
  const fromPersonImage = getValueByPath(fromObject, ["personImage"]);
  if (parentObject !== void 0 && fromPersonImage != null) {
    setValueByPath(parentObject, ["instances[0]", "personImage", "image"], imageToVertex(fromPersonImage));
  }
  const fromProductImages = getValueByPath(fromObject, [
    "productImages"
  ]);
  if (parentObject !== void 0 && fromProductImages != null) {
    let transformedList = fromProductImages;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return productImageToVertex(item);
      });
    }
    setValueByPath(parentObject, ["instances[0]", "productImages"], transformedList);
  }
  return toObject;
}
__name(recontextImageSourceToVertex, "recontextImageSourceToVertex");
function referenceImageAPIInternalToVertex(fromObject, rootObject) {
  const toObject = {};
  const fromReferenceImage = getValueByPath(fromObject, [
    "referenceImage"
  ]);
  if (fromReferenceImage != null) {
    setValueByPath(toObject, ["referenceImage"], imageToVertex(fromReferenceImage));
  }
  const fromReferenceId = getValueByPath(fromObject, ["referenceId"]);
  if (fromReferenceId != null) {
    setValueByPath(toObject, ["referenceId"], fromReferenceId);
  }
  const fromReferenceType = getValueByPath(fromObject, [
    "referenceType"
  ]);
  if (fromReferenceType != null) {
    setValueByPath(toObject, ["referenceType"], fromReferenceType);
  }
  const fromMaskImageConfig = getValueByPath(fromObject, [
    "maskImageConfig"
  ]);
  if (fromMaskImageConfig != null) {
    setValueByPath(toObject, ["maskImageConfig"], maskReferenceConfigToVertex(fromMaskImageConfig));
  }
  const fromControlImageConfig = getValueByPath(fromObject, [
    "controlImageConfig"
  ]);
  if (fromControlImageConfig != null) {
    setValueByPath(toObject, ["controlImageConfig"], controlReferenceConfigToVertex(fromControlImageConfig));
  }
  const fromStyleImageConfig = getValueByPath(fromObject, [
    "styleImageConfig"
  ]);
  if (fromStyleImageConfig != null) {
    setValueByPath(toObject, ["styleImageConfig"], fromStyleImageConfig);
  }
  const fromSubjectImageConfig = getValueByPath(fromObject, [
    "subjectImageConfig"
  ]);
  if (fromSubjectImageConfig != null) {
    setValueByPath(toObject, ["subjectImageConfig"], fromSubjectImageConfig);
  }
  return toObject;
}
__name(referenceImageAPIInternalToVertex, "referenceImageAPIInternalToVertex");
function safetyAttributesFromMldev(fromObject, _rootObject) {
  const toObject = {};
  const fromCategories = getValueByPath(fromObject, [
    "safetyAttributes",
    "categories"
  ]);
  if (fromCategories != null) {
    setValueByPath(toObject, ["categories"], fromCategories);
  }
  const fromScores = getValueByPath(fromObject, [
    "safetyAttributes",
    "scores"
  ]);
  if (fromScores != null) {
    setValueByPath(toObject, ["scores"], fromScores);
  }
  const fromContentType = getValueByPath(fromObject, ["contentType"]);
  if (fromContentType != null) {
    setValueByPath(toObject, ["contentType"], fromContentType);
  }
  return toObject;
}
__name(safetyAttributesFromMldev, "safetyAttributesFromMldev");
function safetyAttributesFromVertex(fromObject, _rootObject) {
  const toObject = {};
  const fromCategories = getValueByPath(fromObject, [
    "safetyAttributes",
    "categories"
  ]);
  if (fromCategories != null) {
    setValueByPath(toObject, ["categories"], fromCategories);
  }
  const fromScores = getValueByPath(fromObject, [
    "safetyAttributes",
    "scores"
  ]);
  if (fromScores != null) {
    setValueByPath(toObject, ["scores"], fromScores);
  }
  const fromContentType = getValueByPath(fromObject, ["contentType"]);
  if (fromContentType != null) {
    setValueByPath(toObject, ["contentType"], fromContentType);
  }
  return toObject;
}
__name(safetyAttributesFromVertex, "safetyAttributesFromVertex");
function safetySettingToMldev$1(fromObject, _rootObject) {
  const toObject = {};
  const fromCategory = getValueByPath(fromObject, ["category"]);
  if (fromCategory != null) {
    setValueByPath(toObject, ["category"], fromCategory);
  }
  if (getValueByPath(fromObject, ["method"]) !== void 0) {
    throw new Error("method parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromThreshold = getValueByPath(fromObject, ["threshold"]);
  if (fromThreshold != null) {
    setValueByPath(toObject, ["threshold"], fromThreshold);
  }
  return toObject;
}
__name(safetySettingToMldev$1, "safetySettingToMldev$1");
function scribbleImageToVertex(fromObject, rootObject) {
  const toObject = {};
  const fromImage = getValueByPath(fromObject, ["image"]);
  if (fromImage != null) {
    setValueByPath(toObject, ["image"], imageToVertex(fromImage));
  }
  return toObject;
}
__name(scribbleImageToVertex, "scribbleImageToVertex");
function segmentImageConfigToVertex(fromObject, parentObject, _rootObject) {
  const toObject = {};
  const fromMode = getValueByPath(fromObject, ["mode"]);
  if (parentObject !== void 0 && fromMode != null) {
    setValueByPath(parentObject, ["parameters", "mode"], fromMode);
  }
  const fromMaxPredictions = getValueByPath(fromObject, [
    "maxPredictions"
  ]);
  if (parentObject !== void 0 && fromMaxPredictions != null) {
    setValueByPath(parentObject, ["parameters", "maxPredictions"], fromMaxPredictions);
  }
  const fromConfidenceThreshold = getValueByPath(fromObject, [
    "confidenceThreshold"
  ]);
  if (parentObject !== void 0 && fromConfidenceThreshold != null) {
    setValueByPath(parentObject, ["parameters", "confidenceThreshold"], fromConfidenceThreshold);
  }
  const fromMaskDilation = getValueByPath(fromObject, ["maskDilation"]);
  if (parentObject !== void 0 && fromMaskDilation != null) {
    setValueByPath(parentObject, ["parameters", "maskDilation"], fromMaskDilation);
  }
  const fromBinaryColorThreshold = getValueByPath(fromObject, [
    "binaryColorThreshold"
  ]);
  if (parentObject !== void 0 && fromBinaryColorThreshold != null) {
    setValueByPath(parentObject, ["parameters", "binaryColorThreshold"], fromBinaryColorThreshold);
  }
  const fromLabels = getValueByPath(fromObject, ["labels"]);
  if (parentObject !== void 0 && fromLabels != null) {
    setValueByPath(parentObject, ["labels"], fromLabels);
  }
  return toObject;
}
__name(segmentImageConfigToVertex, "segmentImageConfigToVertex");
function segmentImageParametersToVertex(apiClient, fromObject, rootObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["_url", "model"], tModel(apiClient, fromModel));
  }
  const fromSource = getValueByPath(fromObject, ["source"]);
  if (fromSource != null) {
    segmentImageSourceToVertex(fromSource, toObject);
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    segmentImageConfigToVertex(fromConfig, toObject);
  }
  return toObject;
}
__name(segmentImageParametersToVertex, "segmentImageParametersToVertex");
function segmentImageResponseFromVertex(fromObject, rootObject) {
  const toObject = {};
  const fromGeneratedMasks = getValueByPath(fromObject, ["predictions"]);
  if (fromGeneratedMasks != null) {
    let transformedList = fromGeneratedMasks;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return generatedImageMaskFromVertex(item);
      });
    }
    setValueByPath(toObject, ["generatedMasks"], transformedList);
  }
  return toObject;
}
__name(segmentImageResponseFromVertex, "segmentImageResponseFromVertex");
function segmentImageSourceToVertex(fromObject, parentObject, rootObject) {
  const toObject = {};
  const fromPrompt = getValueByPath(fromObject, ["prompt"]);
  if (parentObject !== void 0 && fromPrompt != null) {
    setValueByPath(parentObject, ["instances[0]", "prompt"], fromPrompt);
  }
  const fromImage = getValueByPath(fromObject, ["image"]);
  if (parentObject !== void 0 && fromImage != null) {
    setValueByPath(parentObject, ["instances[0]", "image"], imageToVertex(fromImage));
  }
  const fromScribbleImage = getValueByPath(fromObject, [
    "scribbleImage"
  ]);
  if (parentObject !== void 0 && fromScribbleImage != null) {
    setValueByPath(parentObject, ["instances[0]", "scribble"], scribbleImageToVertex(fromScribbleImage));
  }
  return toObject;
}
__name(segmentImageSourceToVertex, "segmentImageSourceToVertex");
function toolConfigToMldev(fromObject, rootObject) {
  const toObject = {};
  const fromRetrievalConfig = getValueByPath(fromObject, [
    "retrievalConfig"
  ]);
  if (fromRetrievalConfig != null) {
    setValueByPath(toObject, ["retrievalConfig"], fromRetrievalConfig);
  }
  const fromFunctionCallingConfig = getValueByPath(fromObject, [
    "functionCallingConfig"
  ]);
  if (fromFunctionCallingConfig != null) {
    setValueByPath(toObject, ["functionCallingConfig"], functionCallingConfigToMldev(fromFunctionCallingConfig));
  }
  const fromIncludeServerSideToolInvocations = getValueByPath(fromObject, ["includeServerSideToolInvocations"]);
  if (fromIncludeServerSideToolInvocations != null) {
    setValueByPath(toObject, ["includeServerSideToolInvocations"], fromIncludeServerSideToolInvocations);
  }
  return toObject;
}
__name(toolConfigToMldev, "toolConfigToMldev");
function toolConfigToVertex(fromObject, _rootObject) {
  const toObject = {};
  const fromRetrievalConfig = getValueByPath(fromObject, [
    "retrievalConfig"
  ]);
  if (fromRetrievalConfig != null) {
    setValueByPath(toObject, ["retrievalConfig"], fromRetrievalConfig);
  }
  const fromFunctionCallingConfig = getValueByPath(fromObject, [
    "functionCallingConfig"
  ]);
  if (fromFunctionCallingConfig != null) {
    setValueByPath(toObject, ["functionCallingConfig"], fromFunctionCallingConfig);
  }
  if (getValueByPath(fromObject, ["includeServerSideToolInvocations"]) !== void 0) {
    throw new Error("includeServerSideToolInvocations parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  return toObject;
}
__name(toolConfigToVertex, "toolConfigToVertex");
function toolToMldev$1(fromObject, rootObject) {
  const toObject = {};
  if (getValueByPath(fromObject, ["retrieval"]) !== void 0) {
    throw new Error("retrieval parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromComputerUse = getValueByPath(fromObject, ["computerUse"]);
  if (fromComputerUse != null) {
    setValueByPath(toObject, ["computerUse"], fromComputerUse);
  }
  const fromFileSearch = getValueByPath(fromObject, ["fileSearch"]);
  if (fromFileSearch != null) {
    setValueByPath(toObject, ["fileSearch"], fromFileSearch);
  }
  const fromGoogleSearch = getValueByPath(fromObject, ["googleSearch"]);
  if (fromGoogleSearch != null) {
    setValueByPath(toObject, ["googleSearch"], googleSearchToMldev$1(fromGoogleSearch));
  }
  const fromGoogleMaps = getValueByPath(fromObject, ["googleMaps"]);
  if (fromGoogleMaps != null) {
    setValueByPath(toObject, ["googleMaps"], googleMapsToMldev$1(fromGoogleMaps));
  }
  const fromCodeExecution = getValueByPath(fromObject, [
    "codeExecution"
  ]);
  if (fromCodeExecution != null) {
    setValueByPath(toObject, ["codeExecution"], fromCodeExecution);
  }
  if (getValueByPath(fromObject, ["enterpriseWebSearch"]) !== void 0) {
    throw new Error("enterpriseWebSearch parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromFunctionDeclarations = getValueByPath(fromObject, [
    "functionDeclarations"
  ]);
  if (fromFunctionDeclarations != null) {
    let transformedList = fromFunctionDeclarations;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["functionDeclarations"], transformedList);
  }
  const fromGoogleSearchRetrieval = getValueByPath(fromObject, [
    "googleSearchRetrieval"
  ]);
  if (fromGoogleSearchRetrieval != null) {
    setValueByPath(toObject, ["googleSearchRetrieval"], fromGoogleSearchRetrieval);
  }
  if (getValueByPath(fromObject, ["parallelAiSearch"]) !== void 0) {
    throw new Error("parallelAiSearch parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromUrlContext = getValueByPath(fromObject, ["urlContext"]);
  if (fromUrlContext != null) {
    setValueByPath(toObject, ["urlContext"], fromUrlContext);
  }
  const fromMcpServers = getValueByPath(fromObject, ["mcpServers"]);
  if (fromMcpServers != null) {
    let transformedList = fromMcpServers;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["mcpServers"], transformedList);
  }
  return toObject;
}
__name(toolToMldev$1, "toolToMldev$1");
function toolToVertex(fromObject, rootObject) {
  const toObject = {};
  const fromRetrieval = getValueByPath(fromObject, ["retrieval"]);
  if (fromRetrieval != null) {
    setValueByPath(toObject, ["retrieval"], fromRetrieval);
  }
  const fromComputerUse = getValueByPath(fromObject, ["computerUse"]);
  if (fromComputerUse != null) {
    setValueByPath(toObject, ["computerUse"], computerUseToVertex(fromComputerUse));
  }
  if (getValueByPath(fromObject, ["fileSearch"]) !== void 0) {
    throw new Error("fileSearch parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  const fromGoogleSearch = getValueByPath(fromObject, ["googleSearch"]);
  if (fromGoogleSearch != null) {
    setValueByPath(toObject, ["googleSearch"], fromGoogleSearch);
  }
  const fromGoogleMaps = getValueByPath(fromObject, ["googleMaps"]);
  if (fromGoogleMaps != null) {
    setValueByPath(toObject, ["googleMaps"], fromGoogleMaps);
  }
  const fromCodeExecution = getValueByPath(fromObject, [
    "codeExecution"
  ]);
  if (fromCodeExecution != null) {
    setValueByPath(toObject, ["codeExecution"], fromCodeExecution);
  }
  const fromEnterpriseWebSearch = getValueByPath(fromObject, [
    "enterpriseWebSearch"
  ]);
  if (fromEnterpriseWebSearch != null) {
    setValueByPath(toObject, ["enterpriseWebSearch"], fromEnterpriseWebSearch);
  }
  const fromFunctionDeclarations = getValueByPath(fromObject, [
    "functionDeclarations"
  ]);
  if (fromFunctionDeclarations != null) {
    let transformedList = fromFunctionDeclarations;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["functionDeclarations"], transformedList);
  }
  const fromGoogleSearchRetrieval = getValueByPath(fromObject, [
    "googleSearchRetrieval"
  ]);
  if (fromGoogleSearchRetrieval != null) {
    setValueByPath(toObject, ["googleSearchRetrieval"], fromGoogleSearchRetrieval);
  }
  const fromParallelAiSearch = getValueByPath(fromObject, [
    "parallelAiSearch"
  ]);
  if (fromParallelAiSearch != null) {
    setValueByPath(toObject, ["parallelAiSearch"], fromParallelAiSearch);
  }
  const fromUrlContext = getValueByPath(fromObject, ["urlContext"]);
  if (fromUrlContext != null) {
    setValueByPath(toObject, ["urlContext"], fromUrlContext);
  }
  if (getValueByPath(fromObject, ["mcpServers"]) !== void 0) {
    throw new Error("mcpServers parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  return toObject;
}
__name(toolToVertex, "toolToVertex");
function tunedModelInfoFromMldev(fromObject, _rootObject) {
  const toObject = {};
  const fromBaseModel = getValueByPath(fromObject, ["baseModel"]);
  if (fromBaseModel != null) {
    setValueByPath(toObject, ["baseModel"], fromBaseModel);
  }
  const fromCreateTime = getValueByPath(fromObject, ["createTime"]);
  if (fromCreateTime != null) {
    setValueByPath(toObject, ["createTime"], fromCreateTime);
  }
  const fromUpdateTime = getValueByPath(fromObject, ["updateTime"]);
  if (fromUpdateTime != null) {
    setValueByPath(toObject, ["updateTime"], fromUpdateTime);
  }
  return toObject;
}
__name(tunedModelInfoFromMldev, "tunedModelInfoFromMldev");
function tunedModelInfoFromVertex(fromObject, _rootObject) {
  const toObject = {};
  const fromBaseModel = getValueByPath(fromObject, [
    "labels",
    "google-vertex-llm-tuning-base-model-id"
  ]);
  if (fromBaseModel != null) {
    setValueByPath(toObject, ["baseModel"], fromBaseModel);
  }
  const fromCreateTime = getValueByPath(fromObject, ["createTime"]);
  if (fromCreateTime != null) {
    setValueByPath(toObject, ["createTime"], fromCreateTime);
  }
  const fromUpdateTime = getValueByPath(fromObject, ["updateTime"]);
  if (fromUpdateTime != null) {
    setValueByPath(toObject, ["updateTime"], fromUpdateTime);
  }
  return toObject;
}
__name(tunedModelInfoFromVertex, "tunedModelInfoFromVertex");
function updateModelConfigToMldev(fromObject, parentObject, _rootObject) {
  const toObject = {};
  const fromDisplayName = getValueByPath(fromObject, ["displayName"]);
  if (parentObject !== void 0 && fromDisplayName != null) {
    setValueByPath(parentObject, ["displayName"], fromDisplayName);
  }
  const fromDescription = getValueByPath(fromObject, ["description"]);
  if (parentObject !== void 0 && fromDescription != null) {
    setValueByPath(parentObject, ["description"], fromDescription);
  }
  const fromDefaultCheckpointId = getValueByPath(fromObject, [
    "defaultCheckpointId"
  ]);
  if (parentObject !== void 0 && fromDefaultCheckpointId != null) {
    setValueByPath(parentObject, ["defaultCheckpointId"], fromDefaultCheckpointId);
  }
  return toObject;
}
__name(updateModelConfigToMldev, "updateModelConfigToMldev");
function updateModelConfigToVertex(fromObject, parentObject, _rootObject) {
  const toObject = {};
  const fromDisplayName = getValueByPath(fromObject, ["displayName"]);
  if (parentObject !== void 0 && fromDisplayName != null) {
    setValueByPath(parentObject, ["displayName"], fromDisplayName);
  }
  const fromDescription = getValueByPath(fromObject, ["description"]);
  if (parentObject !== void 0 && fromDescription != null) {
    setValueByPath(parentObject, ["description"], fromDescription);
  }
  const fromDefaultCheckpointId = getValueByPath(fromObject, [
    "defaultCheckpointId"
  ]);
  if (parentObject !== void 0 && fromDefaultCheckpointId != null) {
    setValueByPath(parentObject, ["defaultCheckpointId"], fromDefaultCheckpointId);
  }
  return toObject;
}
__name(updateModelConfigToVertex, "updateModelConfigToVertex");
function updateModelParametersToMldev(apiClient, fromObject, rootObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["_url", "name"], tModel(apiClient, fromModel));
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    updateModelConfigToMldev(fromConfig, toObject);
  }
  return toObject;
}
__name(updateModelParametersToMldev, "updateModelParametersToMldev");
function updateModelParametersToVertex(apiClient, fromObject, rootObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["_url", "model"], tModel(apiClient, fromModel));
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    updateModelConfigToVertex(fromConfig, toObject);
  }
  return toObject;
}
__name(updateModelParametersToVertex, "updateModelParametersToVertex");
function upscaleImageAPIConfigInternalToVertex(fromObject, parentObject, _rootObject) {
  const toObject = {};
  const fromOutputGcsUri = getValueByPath(fromObject, ["outputGcsUri"]);
  if (parentObject !== void 0 && fromOutputGcsUri != null) {
    setValueByPath(parentObject, ["parameters", "storageUri"], fromOutputGcsUri);
  }
  const fromSafetyFilterLevel = getValueByPath(fromObject, [
    "safetyFilterLevel"
  ]);
  if (parentObject !== void 0 && fromSafetyFilterLevel != null) {
    setValueByPath(parentObject, ["parameters", "safetySetting"], fromSafetyFilterLevel);
  }
  const fromPersonGeneration = getValueByPath(fromObject, [
    "personGeneration"
  ]);
  if (parentObject !== void 0 && fromPersonGeneration != null) {
    setValueByPath(parentObject, ["parameters", "personGeneration"], fromPersonGeneration);
  }
  const fromIncludeRaiReason = getValueByPath(fromObject, [
    "includeRaiReason"
  ]);
  if (parentObject !== void 0 && fromIncludeRaiReason != null) {
    setValueByPath(parentObject, ["parameters", "includeRaiReason"], fromIncludeRaiReason);
  }
  const fromOutputMimeType = getValueByPath(fromObject, [
    "outputMimeType"
  ]);
  if (parentObject !== void 0 && fromOutputMimeType != null) {
    setValueByPath(parentObject, ["parameters", "outputOptions", "mimeType"], fromOutputMimeType);
  }
  const fromOutputCompressionQuality = getValueByPath(fromObject, [
    "outputCompressionQuality"
  ]);
  if (parentObject !== void 0 && fromOutputCompressionQuality != null) {
    setValueByPath(parentObject, ["parameters", "outputOptions", "compressionQuality"], fromOutputCompressionQuality);
  }
  const fromEnhanceInputImage = getValueByPath(fromObject, [
    "enhanceInputImage"
  ]);
  if (parentObject !== void 0 && fromEnhanceInputImage != null) {
    setValueByPath(parentObject, ["parameters", "upscaleConfig", "enhanceInputImage"], fromEnhanceInputImage);
  }
  const fromImagePreservationFactor = getValueByPath(fromObject, [
    "imagePreservationFactor"
  ]);
  if (parentObject !== void 0 && fromImagePreservationFactor != null) {
    setValueByPath(parentObject, ["parameters", "upscaleConfig", "imagePreservationFactor"], fromImagePreservationFactor);
  }
  const fromLabels = getValueByPath(fromObject, ["labels"]);
  if (parentObject !== void 0 && fromLabels != null) {
    setValueByPath(parentObject, ["labels"], fromLabels);
  }
  const fromNumberOfImages = getValueByPath(fromObject, [
    "numberOfImages"
  ]);
  if (parentObject !== void 0 && fromNumberOfImages != null) {
    setValueByPath(parentObject, ["parameters", "sampleCount"], fromNumberOfImages);
  }
  const fromMode = getValueByPath(fromObject, ["mode"]);
  if (parentObject !== void 0 && fromMode != null) {
    setValueByPath(parentObject, ["parameters", "mode"], fromMode);
  }
  return toObject;
}
__name(upscaleImageAPIConfigInternalToVertex, "upscaleImageAPIConfigInternalToVertex");
function upscaleImageAPIParametersInternalToVertex(apiClient, fromObject, rootObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["_url", "model"], tModel(apiClient, fromModel));
  }
  const fromImage = getValueByPath(fromObject, ["image"]);
  if (fromImage != null) {
    setValueByPath(toObject, ["instances[0]", "image"], imageToVertex(fromImage));
  }
  const fromUpscaleFactor = getValueByPath(fromObject, [
    "upscaleFactor"
  ]);
  if (fromUpscaleFactor != null) {
    setValueByPath(toObject, ["parameters", "upscaleConfig", "upscaleFactor"], fromUpscaleFactor);
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    upscaleImageAPIConfigInternalToVertex(fromConfig, toObject);
  }
  return toObject;
}
__name(upscaleImageAPIParametersInternalToVertex, "upscaleImageAPIParametersInternalToVertex");
function upscaleImageResponseFromVertex(fromObject, rootObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromGeneratedImages = getValueByPath(fromObject, [
    "predictions"
  ]);
  if (fromGeneratedImages != null) {
    let transformedList = fromGeneratedImages;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return generatedImageFromVertex(item);
      });
    }
    setValueByPath(toObject, ["generatedImages"], transformedList);
  }
  return toObject;
}
__name(upscaleImageResponseFromVertex, "upscaleImageResponseFromVertex");
function videoFromMldev(fromObject, _rootObject) {
  const toObject = {};
  const fromUri = getValueByPath(fromObject, ["uri"]);
  if (fromUri != null) {
    setValueByPath(toObject, ["uri"], fromUri);
  }
  const fromVideoBytes = getValueByPath(fromObject, ["encodedVideo"]);
  if (fromVideoBytes != null) {
    setValueByPath(toObject, ["videoBytes"], tBytes(fromVideoBytes));
  }
  const fromMimeType = getValueByPath(fromObject, ["encoding"]);
  if (fromMimeType != null) {
    setValueByPath(toObject, ["mimeType"], fromMimeType);
  }
  return toObject;
}
__name(videoFromMldev, "videoFromMldev");
function videoFromVertex(fromObject, _rootObject) {
  const toObject = {};
  const fromUri = getValueByPath(fromObject, ["gcsUri"]);
  if (fromUri != null) {
    setValueByPath(toObject, ["uri"], fromUri);
  }
  const fromVideoBytes = getValueByPath(fromObject, [
    "bytesBase64Encoded"
  ]);
  if (fromVideoBytes != null) {
    setValueByPath(toObject, ["videoBytes"], tBytes(fromVideoBytes));
  }
  const fromMimeType = getValueByPath(fromObject, ["mimeType"]);
  if (fromMimeType != null) {
    setValueByPath(toObject, ["mimeType"], fromMimeType);
  }
  return toObject;
}
__name(videoFromVertex, "videoFromVertex");
function videoGenerationMaskToVertex(fromObject, rootObject) {
  const toObject = {};
  const fromImage = getValueByPath(fromObject, ["image"]);
  if (fromImage != null) {
    setValueByPath(toObject, ["_self"], imageToVertex(fromImage));
  }
  const fromMaskMode = getValueByPath(fromObject, ["maskMode"]);
  if (fromMaskMode != null) {
    setValueByPath(toObject, ["maskMode"], fromMaskMode);
  }
  return toObject;
}
__name(videoGenerationMaskToVertex, "videoGenerationMaskToVertex");
function videoGenerationReferenceImageToMldev(fromObject, rootObject) {
  const toObject = {};
  const fromImage = getValueByPath(fromObject, ["image"]);
  if (fromImage != null) {
    setValueByPath(toObject, ["image"], imageToMldev(fromImage));
  }
  const fromReferenceType = getValueByPath(fromObject, [
    "referenceType"
  ]);
  if (fromReferenceType != null) {
    setValueByPath(toObject, ["referenceType"], fromReferenceType);
  }
  return toObject;
}
__name(videoGenerationReferenceImageToMldev, "videoGenerationReferenceImageToMldev");
function videoGenerationReferenceImageToVertex(fromObject, rootObject) {
  const toObject = {};
  const fromImage = getValueByPath(fromObject, ["image"]);
  if (fromImage != null) {
    setValueByPath(toObject, ["image"], imageToVertex(fromImage));
  }
  const fromReferenceType = getValueByPath(fromObject, [
    "referenceType"
  ]);
  if (fromReferenceType != null) {
    setValueByPath(toObject, ["referenceType"], fromReferenceType);
  }
  return toObject;
}
__name(videoGenerationReferenceImageToVertex, "videoGenerationReferenceImageToVertex");
function videoToMldev(fromObject, _rootObject) {
  const toObject = {};
  const fromUri = getValueByPath(fromObject, ["uri"]);
  if (fromUri != null) {
    setValueByPath(toObject, ["uri"], fromUri);
  }
  const fromVideoBytes = getValueByPath(fromObject, ["videoBytes"]);
  if (fromVideoBytes != null) {
    setValueByPath(toObject, ["encodedVideo"], tBytes(fromVideoBytes));
  }
  const fromMimeType = getValueByPath(fromObject, ["mimeType"]);
  if (fromMimeType != null) {
    setValueByPath(toObject, ["encoding"], fromMimeType);
  }
  return toObject;
}
__name(videoToMldev, "videoToMldev");
function videoToVertex(fromObject, _rootObject) {
  const toObject = {};
  const fromUri = getValueByPath(fromObject, ["uri"]);
  if (fromUri != null) {
    setValueByPath(toObject, ["gcsUri"], fromUri);
  }
  const fromVideoBytes = getValueByPath(fromObject, ["videoBytes"]);
  if (fromVideoBytes != null) {
    setValueByPath(toObject, ["bytesBase64Encoded"], tBytes(fromVideoBytes));
  }
  const fromMimeType = getValueByPath(fromObject, ["mimeType"]);
  if (fromMimeType != null) {
    setValueByPath(toObject, ["mimeType"], fromMimeType);
  }
  return toObject;
}
__name(videoToVertex, "videoToVertex");
function createFileSearchStoreConfigToMldev(apiClient, fromObject, parentObject) {
  const toObject = {};
  const fromDisplayName = getValueByPath(fromObject, ["displayName"]);
  if (parentObject !== void 0 && fromDisplayName != null) {
    setValueByPath(parentObject, ["displayName"], fromDisplayName);
  }
  const fromEmbeddingModel = getValueByPath(fromObject, [
    "embeddingModel"
  ]);
  if (parentObject !== void 0 && fromEmbeddingModel != null) {
    setValueByPath(parentObject, ["embeddingModel"], tModel(apiClient, fromEmbeddingModel));
  }
  return toObject;
}
__name(createFileSearchStoreConfigToMldev, "createFileSearchStoreConfigToMldev");
function createFileSearchStoreParametersToMldev(apiClient, fromObject) {
  const toObject = {};
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    createFileSearchStoreConfigToMldev(apiClient, fromConfig, toObject);
  }
  return toObject;
}
__name(createFileSearchStoreParametersToMldev, "createFileSearchStoreParametersToMldev");
function deleteFileSearchStoreConfigToMldev(fromObject, parentObject) {
  const toObject = {};
  const fromForce = getValueByPath(fromObject, ["force"]);
  if (parentObject !== void 0 && fromForce != null) {
    setValueByPath(parentObject, ["_query", "force"], fromForce);
  }
  return toObject;
}
__name(deleteFileSearchStoreConfigToMldev, "deleteFileSearchStoreConfigToMldev");
function deleteFileSearchStoreParametersToMldev(fromObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["_url", "name"], fromName);
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    deleteFileSearchStoreConfigToMldev(fromConfig, toObject);
  }
  return toObject;
}
__name(deleteFileSearchStoreParametersToMldev, "deleteFileSearchStoreParametersToMldev");
function getFileSearchStoreParametersToMldev(fromObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["_url", "name"], fromName);
  }
  return toObject;
}
__name(getFileSearchStoreParametersToMldev, "getFileSearchStoreParametersToMldev");
function importFileConfigToMldev(fromObject, parentObject) {
  const toObject = {};
  const fromCustomMetadata = getValueByPath(fromObject, [
    "customMetadata"
  ]);
  if (parentObject !== void 0 && fromCustomMetadata != null) {
    let transformedList = fromCustomMetadata;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(parentObject, ["customMetadata"], transformedList);
  }
  const fromChunkingConfig = getValueByPath(fromObject, [
    "chunkingConfig"
  ]);
  if (parentObject !== void 0 && fromChunkingConfig != null) {
    setValueByPath(parentObject, ["chunkingConfig"], fromChunkingConfig);
  }
  return toObject;
}
__name(importFileConfigToMldev, "importFileConfigToMldev");
function importFileOperationFromMldev(fromObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["name"], fromName);
  }
  const fromMetadata = getValueByPath(fromObject, ["metadata"]);
  if (fromMetadata != null) {
    setValueByPath(toObject, ["metadata"], fromMetadata);
  }
  const fromDone = getValueByPath(fromObject, ["done"]);
  if (fromDone != null) {
    setValueByPath(toObject, ["done"], fromDone);
  }
  const fromError = getValueByPath(fromObject, ["error"]);
  if (fromError != null) {
    setValueByPath(toObject, ["error"], fromError);
  }
  const fromResponse = getValueByPath(fromObject, ["response"]);
  if (fromResponse != null) {
    setValueByPath(toObject, ["response"], importFileResponseFromMldev(fromResponse));
  }
  return toObject;
}
__name(importFileOperationFromMldev, "importFileOperationFromMldev");
function importFileParametersToMldev(fromObject) {
  const toObject = {};
  const fromFileSearchStoreName = getValueByPath(fromObject, [
    "fileSearchStoreName"
  ]);
  if (fromFileSearchStoreName != null) {
    setValueByPath(toObject, ["_url", "file_search_store_name"], fromFileSearchStoreName);
  }
  const fromFileName = getValueByPath(fromObject, ["fileName"]);
  if (fromFileName != null) {
    setValueByPath(toObject, ["fileName"], fromFileName);
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    importFileConfigToMldev(fromConfig, toObject);
  }
  return toObject;
}
__name(importFileParametersToMldev, "importFileParametersToMldev");
function importFileResponseFromMldev(fromObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromParent = getValueByPath(fromObject, ["parent"]);
  if (fromParent != null) {
    setValueByPath(toObject, ["parent"], fromParent);
  }
  const fromDocumentName = getValueByPath(fromObject, ["documentName"]);
  if (fromDocumentName != null) {
    setValueByPath(toObject, ["documentName"], fromDocumentName);
  }
  return toObject;
}
__name(importFileResponseFromMldev, "importFileResponseFromMldev");
function listFileSearchStoresConfigToMldev(fromObject, parentObject) {
  const toObject = {};
  const fromPageSize = getValueByPath(fromObject, ["pageSize"]);
  if (parentObject !== void 0 && fromPageSize != null) {
    setValueByPath(parentObject, ["_query", "pageSize"], fromPageSize);
  }
  const fromPageToken = getValueByPath(fromObject, ["pageToken"]);
  if (parentObject !== void 0 && fromPageToken != null) {
    setValueByPath(parentObject, ["_query", "pageToken"], fromPageToken);
  }
  return toObject;
}
__name(listFileSearchStoresConfigToMldev, "listFileSearchStoresConfigToMldev");
function listFileSearchStoresParametersToMldev(fromObject) {
  const toObject = {};
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    listFileSearchStoresConfigToMldev(fromConfig, toObject);
  }
  return toObject;
}
__name(listFileSearchStoresParametersToMldev, "listFileSearchStoresParametersToMldev");
function listFileSearchStoresResponseFromMldev(fromObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromNextPageToken = getValueByPath(fromObject, [
    "nextPageToken"
  ]);
  if (fromNextPageToken != null) {
    setValueByPath(toObject, ["nextPageToken"], fromNextPageToken);
  }
  const fromFileSearchStores = getValueByPath(fromObject, [
    "fileSearchStores"
  ]);
  if (fromFileSearchStores != null) {
    let transformedList = fromFileSearchStores;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["fileSearchStores"], transformedList);
  }
  return toObject;
}
__name(listFileSearchStoresResponseFromMldev, "listFileSearchStoresResponseFromMldev");
function uploadToFileSearchStoreConfigToMldev(fromObject, parentObject) {
  const toObject = {};
  const fromMimeType = getValueByPath(fromObject, ["mimeType"]);
  if (parentObject !== void 0 && fromMimeType != null) {
    setValueByPath(parentObject, ["mimeType"], fromMimeType);
  }
  const fromDisplayName = getValueByPath(fromObject, ["displayName"]);
  if (parentObject !== void 0 && fromDisplayName != null) {
    setValueByPath(parentObject, ["displayName"], fromDisplayName);
  }
  const fromCustomMetadata = getValueByPath(fromObject, [
    "customMetadata"
  ]);
  if (parentObject !== void 0 && fromCustomMetadata != null) {
    let transformedList = fromCustomMetadata;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(parentObject, ["customMetadata"], transformedList);
  }
  const fromChunkingConfig = getValueByPath(fromObject, [
    "chunkingConfig"
  ]);
  if (parentObject !== void 0 && fromChunkingConfig != null) {
    setValueByPath(parentObject, ["chunkingConfig"], fromChunkingConfig);
  }
  return toObject;
}
__name(uploadToFileSearchStoreConfigToMldev, "uploadToFileSearchStoreConfigToMldev");
function uploadToFileSearchStoreParametersToMldev(fromObject) {
  const toObject = {};
  const fromFileSearchStoreName = getValueByPath(fromObject, [
    "fileSearchStoreName"
  ]);
  if (fromFileSearchStoreName != null) {
    setValueByPath(toObject, ["_url", "file_search_store_name"], fromFileSearchStoreName);
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    uploadToFileSearchStoreConfigToMldev(fromConfig, toObject);
  }
  return toObject;
}
__name(uploadToFileSearchStoreParametersToMldev, "uploadToFileSearchStoreParametersToMldev");
function uploadToFileSearchStoreResumableResponseFromMldev(fromObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  return toObject;
}
__name(uploadToFileSearchStoreResumableResponseFromMldev, "uploadToFileSearchStoreResumableResponseFromMldev");
var CONTENT_TYPE_HEADER = "Content-Type";
var SERVER_TIMEOUT_HEADER = "X-Server-Timeout";
var USER_AGENT_HEADER = "User-Agent";
var GOOGLE_API_CLIENT_HEADER = "x-goog-api-client";
var SDK_VERSION = "2.6.0";
var LIBRARY_LABEL = `google-genai-sdk/${SDK_VERSION}`;
var VERTEX_AI_API_DEFAULT_VERSION = "v1beta1";
var GOOGLE_AI_API_DEFAULT_VERSION = "v1beta";
var MULTI_REGIONAL_LOCATIONS = /* @__PURE__ */ new Set(["us", "eu"]);
var DEFAULT_RETRY_ATTEMPTS = 5;
var DEFAULT_RETRY_HTTP_STATUS_CODES = [
  408,
  // Request timeout
  429,
  // Too many requests
  500,
  // Internal server error
  502,
  // Bad gateway
  503,
  // Service unavailable
  504
  // Gateway timeout
];
var ApiClient = class {
  static {
    __name(this, "ApiClient");
  }
  constructor(opts) {
    var _a2, _b, _c;
    this.clientOptions = Object.assign({}, opts);
    this.customBaseUrl = (_a2 = opts.httpOptions) === null || _a2 === void 0 ? void 0 : _a2.baseUrl;
    if (this.clientOptions.vertexai) {
      if (this.clientOptions.project && this.clientOptions.location) {
        this.clientOptions.apiKey = void 0;
      } else if (this.clientOptions.apiKey) {
        this.clientOptions.project = void 0;
        this.clientOptions.location = void 0;
      }
    }
    const initHttpOptions = {};
    if (this.clientOptions.vertexai) {
      if (!this.clientOptions.location && !this.clientOptions.apiKey && !this.customBaseUrl) {
        this.clientOptions.location = "global";
      }
      const hasSufficientAuth = this.clientOptions.project && this.clientOptions.location || this.clientOptions.apiKey;
      if (!hasSufficientAuth && !this.customBaseUrl) {
        throw new Error("Authentication is not set up. Please provide either a project and location, or an API key, or a custom base URL.");
      }
      const hasConstructorAuth = opts.project && opts.location || !!opts.apiKey;
      if (this.customBaseUrl && !hasConstructorAuth) {
        initHttpOptions.baseUrl = this.customBaseUrl;
        this.clientOptions.project = void 0;
        this.clientOptions.location = void 0;
      } else if (this.clientOptions.apiKey || this.clientOptions.location === "global") {
        initHttpOptions.baseUrl = "https://aiplatform.googleapis.com/";
      } else if (this.clientOptions.project && this.clientOptions.location && MULTI_REGIONAL_LOCATIONS.has(this.clientOptions.location)) {
        initHttpOptions.baseUrl = `https://aiplatform.${this.clientOptions.location}.rep.googleapis.com/`;
      } else if (this.clientOptions.project && this.clientOptions.location) {
        initHttpOptions.baseUrl = `https://${this.clientOptions.location}-aiplatform.googleapis.com/`;
      }
      initHttpOptions.apiVersion = (_b = this.clientOptions.apiVersion) !== null && _b !== void 0 ? _b : VERTEX_AI_API_DEFAULT_VERSION;
    } else {
      if (!this.clientOptions.apiKey) {
        console.warn("API key should be set when using the Gemini API.");
      }
      initHttpOptions.apiVersion = (_c = this.clientOptions.apiVersion) !== null && _c !== void 0 ? _c : GOOGLE_AI_API_DEFAULT_VERSION;
      initHttpOptions.baseUrl = `https://generativelanguage.googleapis.com/`;
    }
    initHttpOptions.headers = this.getDefaultHeaders();
    this.clientOptions.httpOptions = initHttpOptions;
    if (opts.httpOptions) {
      this.clientOptions.httpOptions = this.patchHttpOptions(initHttpOptions, opts.httpOptions);
    }
  }
  isVertexAI() {
    var _a2;
    return (_a2 = this.clientOptions.vertexai) !== null && _a2 !== void 0 ? _a2 : false;
  }
  getProject() {
    return this.clientOptions.project;
  }
  getLocation() {
    return this.clientOptions.location;
  }
  getCustomBaseUrl() {
    return this.customBaseUrl;
  }
  async getAuthHeaders() {
    const headers = new Headers();
    await this.clientOptions.auth.addAuthHeaders(headers);
    return headers;
  }
  getApiVersion() {
    if (this.clientOptions.httpOptions && this.clientOptions.httpOptions.apiVersion !== void 0) {
      return this.clientOptions.httpOptions.apiVersion;
    }
    throw new Error("API version is not set.");
  }
  getBaseUrl() {
    if (this.clientOptions.httpOptions && this.clientOptions.httpOptions.baseUrl !== void 0) {
      return this.clientOptions.httpOptions.baseUrl;
    }
    throw new Error("Base URL is not set.");
  }
  getRequestUrl() {
    return this.getRequestUrlInternal(this.clientOptions.httpOptions);
  }
  getHeaders() {
    if (this.clientOptions.httpOptions && this.clientOptions.httpOptions.headers !== void 0) {
      return this.clientOptions.httpOptions.headers;
    } else {
      throw new Error("Headers are not set.");
    }
  }
  getRequestUrlInternal(httpOptions) {
    if (!httpOptions || httpOptions.baseUrl === void 0 || httpOptions.apiVersion === void 0) {
      throw new Error("HTTP options are not correctly set.");
    }
    const baseUrl = httpOptions.baseUrl.endsWith("/") ? httpOptions.baseUrl.slice(0, -1) : httpOptions.baseUrl;
    const urlElement = [baseUrl];
    if (httpOptions.apiVersion && httpOptions.apiVersion !== "") {
      urlElement.push(httpOptions.apiVersion);
    }
    return urlElement.join("/");
  }
  getBaseResourcePath() {
    return `projects/${this.clientOptions.project}/locations/${this.clientOptions.location}`;
  }
  getApiKey() {
    return this.clientOptions.apiKey;
  }
  getWebsocketBaseUrl() {
    const baseUrl = this.getBaseUrl();
    const urlParts = new URL(baseUrl);
    urlParts.protocol = urlParts.protocol == "http:" ? "ws" : "wss";
    return urlParts.toString();
  }
  setBaseUrl(url) {
    if (this.clientOptions.httpOptions) {
      this.clientOptions.httpOptions.baseUrl = url;
    } else {
      throw new Error("HTTP options are not correctly set.");
    }
  }
  constructUrl(path2, httpOptions, prependProjectLocation) {
    const urlElement = [this.getRequestUrlInternal(httpOptions)];
    if (prependProjectLocation) {
      urlElement.push(this.getBaseResourcePath());
    }
    if (path2 !== "") {
      urlElement.push(path2);
    }
    const url = new URL(`${urlElement.join("/")}`);
    return url;
  }
  shouldPrependVertexProjectPath(request, httpOptions) {
    if (httpOptions.baseUrl && httpOptions.baseUrlResourceScope === ResourceScope.COLLECTION) {
      return false;
    }
    if (this.clientOptions.apiKey) {
      return false;
    }
    if (!this.clientOptions.vertexai) {
      return false;
    }
    if (request.path.startsWith("projects/")) {
      return false;
    }
    if (request.httpMethod === "GET" && request.path.startsWith("publishers/google/models")) {
      return false;
    }
    return true;
  }
  async request(request) {
    let patchedHttpOptions = this.clientOptions.httpOptions;
    if (request.httpOptions) {
      patchedHttpOptions = this.patchHttpOptions(this.clientOptions.httpOptions, request.httpOptions);
    }
    const prependProjectLocation = this.shouldPrependVertexProjectPath(request, patchedHttpOptions);
    const url = this.constructUrl(request.path, patchedHttpOptions, prependProjectLocation);
    if (request.queryParams) {
      for (const [key, value] of Object.entries(request.queryParams)) {
        url.searchParams.append(key, String(value));
      }
    }
    let requestInit = {};
    if (request.httpMethod === "GET") {
      if (request.body && request.body !== "{}") {
        throw new Error("Request body should be empty for GET request, but got non empty request body");
      }
    } else {
      requestInit.body = request.body;
    }
    requestInit = await this.includeExtraHttpOptionsToRequestInit(requestInit, patchedHttpOptions, url.toString(), request.abortSignal);
    return this.unaryApiCall(url, requestInit, request.httpMethod);
  }
  patchHttpOptions(baseHttpOptions, requestHttpOptions) {
    const patchedHttpOptions = JSON.parse(JSON.stringify(baseHttpOptions));
    for (const [key, value] of Object.entries(requestHttpOptions)) {
      if (typeof value === "object") {
        patchedHttpOptions[key] = Object.assign(Object.assign({}, patchedHttpOptions[key]), value);
      } else if (value !== void 0) {
        patchedHttpOptions[key] = value;
      }
    }
    return patchedHttpOptions;
  }
  async requestStream(request) {
    let patchedHttpOptions = this.clientOptions.httpOptions;
    if (request.httpOptions) {
      patchedHttpOptions = this.patchHttpOptions(this.clientOptions.httpOptions, request.httpOptions);
    }
    const prependProjectLocation = this.shouldPrependVertexProjectPath(request, patchedHttpOptions);
    const url = this.constructUrl(request.path, patchedHttpOptions, prependProjectLocation);
    if (!url.searchParams.has("alt") || url.searchParams.get("alt") !== "sse") {
      url.searchParams.set("alt", "sse");
    }
    let requestInit = {};
    requestInit.body = request.body;
    requestInit = await this.includeExtraHttpOptionsToRequestInit(requestInit, patchedHttpOptions, url.toString(), request.abortSignal);
    return this.streamApiCall(url, requestInit, request.httpMethod);
  }
  async includeExtraHttpOptionsToRequestInit(requestInit, httpOptions, url, abortSignal) {
    if (httpOptions && httpOptions.timeout || abortSignal) {
      const abortController = new AbortController();
      const signal = abortController.signal;
      if (httpOptions.timeout && (httpOptions === null || httpOptions === void 0 ? void 0 : httpOptions.timeout) > 0) {
        const dispatcherSymbol = Symbol.for("undici.globalDispatcher.1");
        const globalDispatcher = globalThis[dispatcherSymbol];
        if (globalDispatcher) {
          const symbols = Object.getOwnPropertySymbols(globalDispatcher);
          for (const sym of symbols) {
            const desc = sym.description;
            if ((desc === null || desc === void 0 ? void 0 : desc.includes("headers timeout")) || (desc === null || desc === void 0 ? void 0 : desc.includes("body timeout"))) {
              const currentTimeout = globalDispatcher[sym];
              if (typeof currentTimeout === "number") {
                globalDispatcher[sym] = Math.max(currentTimeout, httpOptions.timeout);
              }
            }
          }
        }
        const timeoutHandle = setTimeout(() => abortController.abort(), httpOptions.timeout);
        if (timeoutHandle && typeof timeoutHandle.unref === "function") {
          timeoutHandle.unref();
        }
      }
      if (abortSignal) {
        abortSignal.addEventListener("abort", () => {
          abortController.abort();
        });
      }
      requestInit.signal = signal;
    }
    if (httpOptions && httpOptions.extraBody !== null) {
      includeExtraBodyToRequestInit(requestInit, httpOptions.extraBody);
    }
    requestInit.headers = await this.getHeadersInternal(httpOptions, url);
    return requestInit;
  }
  async unaryApiCall(url, requestInit, httpMethod) {
    return this.apiCall(url.toString(), Object.assign(Object.assign({}, requestInit), { method: httpMethod })).then(async (response) => {
      await throwErrorIfNotOK(response);
      return new HttpResponse(response);
    }).catch((e) => {
      if (e instanceof Error) {
        throw e;
      } else {
        throw new Error(`exception ${e} sending request`, { cause: e });
      }
    });
  }
  async streamApiCall(url, requestInit, httpMethod) {
    return this.apiCall(url.toString(), Object.assign(Object.assign({}, requestInit), { method: httpMethod })).then(async (response) => {
      await throwErrorIfNotOK(response);
      return this.processStreamResponse(response);
    }).catch((e) => {
      if (e instanceof Error) {
        throw e;
      } else {
        throw new Error(`exception ${e} sending request`, { cause: e });
      }
    });
  }
  processStreamResponse(response) {
    return __asyncGenerator(this, arguments, /* @__PURE__ */ __name(function* processStreamResponse_1() {
      var _a2;
      const reader = (_a2 = response === null || response === void 0 ? void 0 : response.body) === null || _a2 === void 0 ? void 0 : _a2.getReader();
      const decoder = new TextDecoder("utf-8");
      if (!reader) {
        throw new Error("Response body is empty");
      }
      try {
        let buffer = "";
        const dataPrefix = "data:";
        const delimiters = ["\n\n", "\r\r", "\r\n\r\n"];
        while (true) {
          const { done, value } = yield __await(reader.read());
          if (done) {
            if (buffer.trim().length > 0) {
              throw new Error("Incomplete JSON segment at the end");
            }
            break;
          }
          const chunkString = decoder.decode(value, { stream: true });
          try {
            const chunkJson = JSON.parse(chunkString);
            if ("error" in chunkJson) {
              const errorJson = JSON.parse(JSON.stringify(chunkJson["error"]));
              const status = errorJson["status"];
              const code = errorJson["code"];
              const errorMessage = `got status: ${status}. ${JSON.stringify(chunkJson)}`;
              if (code >= 400 && code < 600) {
                const apiError = new ApiError({
                  message: errorMessage,
                  status: code
                });
                throw apiError;
              }
            }
          } catch (e) {
            const error = e;
            if (error.name === "ApiError") {
              throw e;
            }
          }
          buffer += chunkString;
          let delimiterIndex = -1;
          let delimiterLength = 0;
          while (true) {
            delimiterIndex = -1;
            delimiterLength = 0;
            for (const delimiter of delimiters) {
              const index = buffer.indexOf(delimiter);
              if (index !== -1 && (delimiterIndex === -1 || index < delimiterIndex)) {
                delimiterIndex = index;
                delimiterLength = delimiter.length;
              }
            }
            if (delimiterIndex === -1) {
              break;
            }
            const eventString = buffer.substring(0, delimiterIndex);
            buffer = buffer.substring(delimiterIndex + delimiterLength);
            const trimmedEvent = eventString.trim();
            if (trimmedEvent.startsWith(dataPrefix)) {
              const processedChunkString = trimmedEvent.substring(dataPrefix.length).trim();
              try {
                const partialResponse = new Response(processedChunkString, {
                  headers: response === null || response === void 0 ? void 0 : response.headers,
                  status: response === null || response === void 0 ? void 0 : response.status,
                  statusText: response === null || response === void 0 ? void 0 : response.statusText
                });
                yield yield __await(new HttpResponse(partialResponse));
              } catch (e) {
                throw new Error(`exception parsing stream chunk ${processedChunkString}. ${e}`);
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    }, "processStreamResponse_1"));
  }
  async apiCall(url, requestInit) {
    var _a2;
    if (!this.clientOptions.httpOptions || !this.clientOptions.httpOptions.retryOptions) {
      return fetch(url, requestInit);
    }
    const retryOptions = this.clientOptions.httpOptions.retryOptions;
    const runFetch = /* @__PURE__ */ __name(async () => {
      const response = await fetch(url, requestInit);
      if (response.ok) {
        return response;
      }
      if (DEFAULT_RETRY_HTTP_STATUS_CODES.includes(response.status)) {
        throw new Error(`Retryable HTTP Error: ${response.statusText}`);
      }
      throw new import_p_retry.AbortError(`Non-retryable exception ${response.statusText} sending request`);
    }, "runFetch");
    return (0, import_p_retry.default)(runFetch, {
      // Retry attempts is one less than the number of total attempts.
      retries: ((_a2 = retryOptions.attempts) !== null && _a2 !== void 0 ? _a2 : DEFAULT_RETRY_ATTEMPTS) - 1
    });
  }
  getDefaultHeaders() {
    const headers = {};
    const versionHeaderValue = LIBRARY_LABEL + " " + this.clientOptions.userAgentExtra;
    headers[USER_AGENT_HEADER] = versionHeaderValue;
    headers[GOOGLE_API_CLIENT_HEADER] = versionHeaderValue;
    headers[CONTENT_TYPE_HEADER] = "application/json";
    return headers;
  }
  async getHeadersInternal(httpOptions, url) {
    const headers = new Headers();
    if (httpOptions && httpOptions.headers) {
      for (const [key, value] of Object.entries(httpOptions.headers)) {
        headers.append(key, value);
      }
    }
    if ((httpOptions === null || httpOptions === void 0 ? void 0 : httpOptions.timeout) && httpOptions.timeout > 0) {
      headers.append(SERVER_TIMEOUT_HEADER, String(Math.ceil(httpOptions.timeout / 1e3)));
    }
    await this.clientOptions.auth.addAuthHeaders(headers, url);
    return headers;
  }
  getFileName(file) {
    var _a2;
    let fileName = "";
    if (typeof file === "string") {
      fileName = file.replace(/[/\\]+$/, "");
      fileName = (_a2 = fileName.split(/[/\\]/).pop()) !== null && _a2 !== void 0 ? _a2 : "";
    }
    return fileName;
  }
  /**
   * Uploads a file asynchronously using Gemini API only, this is not supported
   * in Vertex AI.
   *
   * @param file The string path to the file to be uploaded or a Blob object.
   * @param config Optional parameters specified in the `UploadFileConfig`
   *     interface. @see {@link types.UploadFileConfig}
   * @return A promise that resolves to a `File` object.
   * @throws An error if called on a Vertex AI client.
   * @throws An error if the `mimeType` is not provided and can not be inferred,
   */
  async uploadFile(file, config) {
    var _a2;
    const fileToUpload = {};
    if (config != null) {
      fileToUpload.mimeType = config.mimeType;
      fileToUpload.name = config.name;
      fileToUpload.displayName = config.displayName;
    }
    if (fileToUpload.name && !fileToUpload.name.startsWith("files/")) {
      fileToUpload.name = `files/${fileToUpload.name}`;
    }
    const uploader = this.clientOptions.uploader;
    const fileStat = await uploader.stat(file);
    fileToUpload.sizeBytes = String(fileStat.size);
    const mimeType = (_a2 = config === null || config === void 0 ? void 0 : config.mimeType) !== null && _a2 !== void 0 ? _a2 : fileStat.type;
    if (mimeType === void 0 || mimeType === "") {
      throw new Error("Can not determine mimeType. Please provide mimeType in the config.");
    }
    fileToUpload.mimeType = mimeType;
    const body = {
      file: fileToUpload
    };
    const fileName = this.getFileName(file);
    const path2 = formatMap("upload/v1beta/files", body["_url"]);
    const uploadUrl = await this.fetchUploadUrl(path2, fileToUpload.sizeBytes, fileToUpload.mimeType, fileName, body, config === null || config === void 0 ? void 0 : config.httpOptions);
    return uploader.upload(file, uploadUrl, this);
  }
  /**
   * Uploads a file to a given file search store asynchronously using Gemini API only, this is not supported
   * in Vertex AI.
   *
   * @param fileSearchStoreName The name of the file search store to upload the file to.
   * @param file The string path to the file to be uploaded or a Blob object.
   * @param config Optional parameters specified in the `UploadFileConfig`
   *     interface. @see {@link UploadFileConfig}
   * @return A promise that resolves to a `File` object.
   * @throws An error if called on a Vertex AI client.
   * @throws An error if the `mimeType` is not provided and can not be inferred,
   */
  async uploadFileToFileSearchStore(fileSearchStoreName, file, config) {
    var _a2;
    const uploader = this.clientOptions.uploader;
    const fileStat = await uploader.stat(file);
    const sizeBytes = String(fileStat.size);
    const mimeType = (_a2 = config === null || config === void 0 ? void 0 : config.mimeType) !== null && _a2 !== void 0 ? _a2 : fileStat.type;
    if (mimeType === void 0 || mimeType === "") {
      throw new Error("Can not determine mimeType. Please provide mimeType in the config.");
    }
    const path2 = `upload/v1beta/${fileSearchStoreName}:uploadToFileSearchStore`;
    const fileName = this.getFileName(file);
    const body = {};
    if (config != null) {
      uploadToFileSearchStoreConfigToMldev(config, body);
    }
    const uploadUrl = await this.fetchUploadUrl(path2, sizeBytes, mimeType, fileName, body, config === null || config === void 0 ? void 0 : config.httpOptions);
    return uploader.uploadToFileSearchStore(file, uploadUrl, this);
  }
  /**
   * Downloads a file asynchronously to the specified path.
   *
   * @params params - The parameters for the download request, see {@link
   * types.DownloadFileParameters}
   */
  async downloadFile(params) {
    const downloader = this.clientOptions.downloader;
    await downloader.download(params, this);
  }
  async fetchUploadUrl(path2, sizeBytes, mimeType, fileName, body, configHttpOptions) {
    var _a2;
    let httpOptions = {};
    if (configHttpOptions) {
      httpOptions = configHttpOptions;
    } else {
      httpOptions = {
        apiVersion: "",
        // api-version is set in the path.
        headers: Object.assign({ "Content-Type": "application/json", "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start", "X-Goog-Upload-Header-Content-Length": `${sizeBytes}`, "X-Goog-Upload-Header-Content-Type": `${mimeType}` }, fileName ? { "X-Goog-Upload-File-Name": fileName } : {})
      };
    }
    const httpResponse = await this.request({
      path: path2,
      body: JSON.stringify(body),
      httpMethod: "POST",
      httpOptions
    });
    if (!httpResponse || !(httpResponse === null || httpResponse === void 0 ? void 0 : httpResponse.headers)) {
      throw new Error("Server did not return an HttpResponse or the returned HttpResponse did not have headers.");
    }
    const uploadUrl = (_a2 = httpResponse === null || httpResponse === void 0 ? void 0 : httpResponse.headers) === null || _a2 === void 0 ? void 0 : _a2["x-goog-upload-url"];
    if (uploadUrl === void 0) {
      throw new Error("Failed to get upload url. Server did not return the x-google-upload-url in the headers");
    }
    return uploadUrl;
  }
};
async function throwErrorIfNotOK(response) {
  var _a2;
  if (response === void 0) {
    throw new Error("response is undefined");
  }
  if (!response.ok) {
    const status = response.status;
    let errorBody;
    if ((_a2 = response.headers.get("content-type")) === null || _a2 === void 0 ? void 0 : _a2.includes("application/json")) {
      errorBody = await response.json();
    } else {
      errorBody = {
        error: {
          message: await response.text(),
          code: response.status,
          status: response.statusText
        }
      };
    }
    const errorMessage = JSON.stringify(errorBody);
    if (status >= 400 && status < 600) {
      const apiError = new ApiError({
        message: errorMessage,
        status
      });
      throw apiError;
    }
    throw new Error(errorMessage);
  }
}
__name(throwErrorIfNotOK, "throwErrorIfNotOK");
function includeExtraBodyToRequestInit(requestInit, extraBody) {
  if (!extraBody || Object.keys(extraBody).length === 0) {
    return;
  }
  if (requestInit.body instanceof Blob) {
    console.warn("includeExtraBodyToRequestInit: extraBody provided but current request body is a Blob. extraBody will be ignored as merging is not supported for Blob bodies.");
    return;
  }
  let currentBodyObject = {};
  if (typeof requestInit.body === "string" && requestInit.body.length > 0) {
    try {
      const parsedBody = JSON.parse(requestInit.body);
      if (typeof parsedBody === "object" && parsedBody !== null && !Array.isArray(parsedBody)) {
        currentBodyObject = parsedBody;
      } else {
        console.warn("includeExtraBodyToRequestInit: Original request body is valid JSON but not a non-array object. Skip applying extraBody to the request body.");
        return;
      }
    } catch (e) {
      console.warn("includeExtraBodyToRequestInit: Original request body is not valid JSON. Skip applying extraBody to the request body.");
      return;
    }
  }
  function deepMerge(target, source) {
    const output = Object.assign({}, target);
    for (const key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        const sourceValue = source[key];
        const targetValue = output[key];
        if (sourceValue && typeof sourceValue === "object" && !Array.isArray(sourceValue) && targetValue && typeof targetValue === "object" && !Array.isArray(targetValue)) {
          output[key] = deepMerge(targetValue, sourceValue);
        } else {
          if (targetValue && sourceValue && typeof targetValue !== typeof sourceValue) {
            console.warn(`includeExtraBodyToRequestInit:deepMerge: Type mismatch for key "${key}". Original type: ${typeof targetValue}, New type: ${typeof sourceValue}. Overwriting.`);
          }
          output[key] = sourceValue;
        }
      }
    }
    return output;
  }
  __name(deepMerge, "deepMerge");
  const mergedBody = deepMerge(currentBodyObject, extraBody);
  requestInit.body = JSON.stringify(mergedBody);
}
__name(includeExtraBodyToRequestInit, "includeExtraBodyToRequestInit");
var MCP_LABEL = "mcp_used/unknown";
var hasMcpToolUsageFromMcpToTool = false;
function hasMcpToolUsage(tools) {
  for (const tool of tools) {
    if (isMcpCallableTool(tool)) {
      return true;
    }
    if (typeof tool === "object" && "inputSchema" in tool) {
      return true;
    }
  }
  return hasMcpToolUsageFromMcpToTool;
}
__name(hasMcpToolUsage, "hasMcpToolUsage");
function setMcpUsageHeader(headers) {
  var _a2;
  const existingHeader = (_a2 = headers[GOOGLE_API_CLIENT_HEADER]) !== null && _a2 !== void 0 ? _a2 : "";
  headers[GOOGLE_API_CLIENT_HEADER] = (existingHeader + ` ${MCP_LABEL}`).trimStart();
}
__name(setMcpUsageHeader, "setMcpUsageHeader");
function isMcpCallableTool(object) {
  return object !== null && typeof object === "object" && object instanceof McpCallableTool;
}
__name(isMcpCallableTool, "isMcpCallableTool");
function listAllTools(mcpClient_1) {
  return __asyncGenerator(this, arguments, /* @__PURE__ */ __name(function* listAllTools_1(mcpClient, maxTools = 100) {
    let cursor = void 0;
    let numTools = 0;
    while (numTools < maxTools) {
      const t = yield __await(mcpClient.listTools({ cursor }));
      for (const tool of t.tools) {
        yield yield __await(tool);
        numTools++;
      }
      if (!t.nextCursor) {
        break;
      }
      cursor = t.nextCursor;
    }
  }, "listAllTools_1"));
}
__name(listAllTools, "listAllTools");
var McpCallableTool = class _McpCallableTool {
  static {
    __name(this, "McpCallableTool");
  }
  constructor(mcpClients = [], config) {
    this.mcpTools = [];
    this.functionNameToMcpClient = {};
    this.mcpClients = mcpClients;
    this.config = config;
  }
  /**
   * Creates a McpCallableTool.
   */
  static create(mcpClients, config) {
    return new _McpCallableTool(mcpClients, config);
  }
  /**
   * Validates the function names are not duplicate and initialize the function
   * name to MCP client mapping.
   *
   * @throws {Error} if the MCP tools from the MCP clients have duplicate tool
   *     names.
   */
  async initialize() {
    var _a2, e_1, _b, _c;
    if (this.mcpTools.length > 0) {
      return;
    }
    const functionMap = {};
    const mcpTools = [];
    for (const mcpClient of this.mcpClients) {
      try {
        for (var _d = true, _e = (e_1 = void 0, __asyncValues(listAllTools(mcpClient))), _f; _f = await _e.next(), _a2 = _f.done, !_a2; _d = true) {
          _c = _f.value;
          _d = false;
          const mcpTool = _c;
          mcpTools.push(mcpTool);
          const mcpToolName = mcpTool.name;
          if (functionMap[mcpToolName]) {
            throw new Error(`Duplicate function name ${mcpToolName} found in MCP tools. Please ensure function names are unique.`);
          }
          functionMap[mcpToolName] = mcpClient;
        }
      } catch (e_1_1) {
        e_1 = { error: e_1_1 };
      } finally {
        try {
          if (!_d && !_a2 && (_b = _e.return)) await _b.call(_e);
        } finally {
          if (e_1) throw e_1.error;
        }
      }
    }
    this.mcpTools = mcpTools;
    this.functionNameToMcpClient = functionMap;
  }
  async tool() {
    await this.initialize();
    return mcpToolsToGeminiTool(this.mcpTools, this.config);
  }
  async callTool(functionCalls) {
    await this.initialize();
    const functionCallResponseParts = [];
    for (const functionCall of functionCalls) {
      if (functionCall.name in this.functionNameToMcpClient) {
        const mcpClient = this.functionNameToMcpClient[functionCall.name];
        let requestOptions = void 0;
        if (this.config.timeout) {
          requestOptions = {
            timeout: this.config.timeout
          };
        }
        const callToolResponse = await mcpClient.callTool(
          {
            name: functionCall.name,
            arguments: functionCall.args
          },
          // Set the result schema to undefined to allow MCP to rely on the
          // default schema.
          void 0,
          requestOptions
        );
        functionCallResponseParts.push({
          functionResponse: {
            name: functionCall.name,
            response: callToolResponse.isError ? { error: callToolResponse } : callToolResponse
          }
        });
      }
    }
    return functionCallResponseParts;
  }
};
function isMcpClient(client) {
  return client !== null && typeof client === "object" && "listTools" in client && typeof client.listTools === "function";
}
__name(isMcpClient, "isMcpClient");
function mcpToTool(...args) {
  hasMcpToolUsageFromMcpToTool = true;
  if (args.length === 0) {
    throw new Error("No MCP clients provided");
  }
  const maybeConfig = args[args.length - 1];
  if (isMcpClient(maybeConfig)) {
    return McpCallableTool.create(args, {});
  }
  return McpCallableTool.create(args.slice(0, args.length - 1), maybeConfig);
}
__name(mcpToTool, "mcpToTool");
async function handleWebSocketMessage$1(apiClient, onmessage, event) {
  const serverMessage = new LiveMusicServerMessage();
  let data;
  if (event.data instanceof Blob) {
    data = JSON.parse(await event.data.text());
  } else {
    data = JSON.parse(event.data);
  }
  Object.assign(serverMessage, data);
  onmessage(serverMessage);
}
__name(handleWebSocketMessage$1, "handleWebSocketMessage$1");
var LiveMusic = class {
  static {
    __name(this, "LiveMusic");
  }
  constructor(apiClient, auth, webSocketFactory) {
    this.apiClient = apiClient;
    this.auth = auth;
    this.webSocketFactory = webSocketFactory;
  }
  /**
       Establishes a connection to the specified model and returns a
       LiveMusicSession object representing that connection.
  
       @experimental
  
       @remarks
  
       @param params - The parameters for establishing a connection to the model.
       @return A live session.
  
       @example
       ```ts
       let model = 'models/lyria-realtime-exp';
       const session = await ai.live.music.connect({
         model: model,
         callbacks: {
           onmessage: (e: MessageEvent) => {
             console.log('Received message from the server: %s\n', debug(e.data));
           },
           onerror: (e: ErrorEvent) => {
             console.log('Error occurred: %s\n', debug(e.error));
           },
           onclose: (e: CloseEvent) => {
             console.log('Connection closed.');
           },
         },
       });
       ```
      */
  async connect(params) {
    var _a2, _b;
    if (this.apiClient.isVertexAI()) {
      throw new Error("Live music is not supported for Vertex AI.");
    }
    console.warn("Live music generation is experimental and may change in future versions.");
    const websocketBaseUrl = this.apiClient.getWebsocketBaseUrl();
    const apiVersion = this.apiClient.getApiVersion();
    const headers = mapToHeaders$1(this.apiClient.getDefaultHeaders());
    const apiKey = this.apiClient.getApiKey();
    const url = `${websocketBaseUrl}/ws/google.ai.generativelanguage.${apiVersion}.GenerativeService.BidiGenerateMusic?key=${apiKey}`;
    let onopenResolve = /* @__PURE__ */ __name(() => {
    }, "onopenResolve");
    const onopenPromise = new Promise((resolve) => {
      onopenResolve = resolve;
    });
    const callbacks = params.callbacks;
    const onopenAwaitedCallback = /* @__PURE__ */ __name(function() {
      onopenResolve({});
    }, "onopenAwaitedCallback");
    const apiClient = this.apiClient;
    const websocketCallbacks = {
      onopen: onopenAwaitedCallback,
      onmessage: /* @__PURE__ */ __name((event) => {
        void handleWebSocketMessage$1(apiClient, callbacks.onmessage, event);
      }, "onmessage"),
      onerror: (_a2 = callbacks === null || callbacks === void 0 ? void 0 : callbacks.onerror) !== null && _a2 !== void 0 ? _a2 : function(e) {
      },
      onclose: (_b = callbacks === null || callbacks === void 0 ? void 0 : callbacks.onclose) !== null && _b !== void 0 ? _b : function(e) {
      }
    };
    const conn = this.webSocketFactory.create(url, headersToMap$1(headers), websocketCallbacks);
    conn.connect();
    await onopenPromise;
    const model = tModel(this.apiClient, params.model);
    const setup = { model };
    const clientMessage = { setup };
    conn.send(JSON.stringify(clientMessage));
    return new LiveMusicSession(conn, this.apiClient);
  }
};
var LiveMusicSession = class {
  static {
    __name(this, "LiveMusicSession");
  }
  constructor(conn, apiClient) {
    this.conn = conn;
    this.apiClient = apiClient;
  }
  /**
      Sets inputs to steer music generation. Updates the session's current
      weighted prompts.
  
      @param params - Contains one property, `weightedPrompts`.
  
        - `weightedPrompts` to send to the model; weights are normalized to
          sum to 1.0.
  
      @experimental
     */
  async setWeightedPrompts(params) {
    if (!params.weightedPrompts || Object.keys(params.weightedPrompts).length === 0) {
      throw new Error("Weighted prompts must be set and contain at least one entry.");
    }
    const clientContent = liveMusicSetWeightedPromptsParametersToMldev(params);
    this.conn.send(JSON.stringify({ clientContent }));
  }
  /**
      Sets a configuration to the model. Updates the session's current
      music generation config.
  
      @param params - Contains one property, `musicGenerationConfig`.
  
        - `musicGenerationConfig` to set in the model. Passing an empty or
      undefined config to the model will reset the config to defaults.
  
      @experimental
     */
  async setMusicGenerationConfig(params) {
    if (!params.musicGenerationConfig) {
      params.musicGenerationConfig = {};
    }
    const setConfigParameters = liveMusicSetConfigParametersToMldev(params);
    this.conn.send(JSON.stringify(setConfigParameters));
  }
  sendPlaybackControl(playbackControl) {
    const clientMessage = { playbackControl };
    this.conn.send(JSON.stringify(clientMessage));
  }
  /**
   * Start the music stream.
   *
   * @experimental
   */
  play() {
    this.sendPlaybackControl(LiveMusicPlaybackControl.PLAY);
  }
  /**
   * Temporarily halt the music stream. Use `play` to resume from the current
   * position.
   *
   * @experimental
   */
  pause() {
    this.sendPlaybackControl(LiveMusicPlaybackControl.PAUSE);
  }
  /**
   * Stop the music stream and reset the state. Retains the current prompts
   * and config.
   *
   * @experimental
   */
  stop() {
    this.sendPlaybackControl(LiveMusicPlaybackControl.STOP);
  }
  /**
   * Resets the context of the music generation without stopping it.
   * Retains the current prompts and config.
   *
   * @experimental
   */
  resetContext() {
    this.sendPlaybackControl(LiveMusicPlaybackControl.RESET_CONTEXT);
  }
  /**
       Terminates the WebSocket connection.
  
       @experimental
     */
  close() {
    this.conn.close();
  }
};
function headersToMap$1(headers) {
  const headerMap = {};
  headers.forEach((value, key) => {
    headerMap[key] = value;
  });
  return headerMap;
}
__name(headersToMap$1, "headersToMap$1");
function mapToHeaders$1(map) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(map)) {
    headers.append(key, value);
  }
  return headers;
}
__name(mapToHeaders$1, "mapToHeaders$1");
var FUNCTION_RESPONSE_REQUIRES_ID = "FunctionResponse request must have an `id` field from the response of a ToolCall.FunctionalCalls in Google AI.";
async function handleWebSocketMessage(apiClient, onmessage, event) {
  const serverMessage = new LiveServerMessage();
  let jsonData;
  if (event.data instanceof Blob) {
    jsonData = await event.data.text();
  } else if (event.data instanceof ArrayBuffer) {
    jsonData = new TextDecoder().decode(event.data);
  } else {
    jsonData = event.data;
  }
  const data = JSON.parse(jsonData);
  if (apiClient.isVertexAI()) {
    const resp = liveServerMessageFromVertex(data);
    Object.assign(serverMessage, resp);
  } else {
    const resp = data;
    Object.assign(serverMessage, resp);
  }
  onmessage(serverMessage);
}
__name(handleWebSocketMessage, "handleWebSocketMessage");
var Live = class {
  static {
    __name(this, "Live");
  }
  constructor(apiClient, auth, webSocketFactory) {
    this.apiClient = apiClient;
    this.auth = auth;
    this.webSocketFactory = webSocketFactory;
    this.music = new LiveMusic(this.apiClient, this.auth, this.webSocketFactory);
  }
  /**
       Establishes a connection to the specified model with the given
       configuration and returns a Session object representing that connection.
  
       @experimental Built-in MCP support is an experimental feature, may change in
       future versions.
  
       @remarks
  
       @param params - The parameters for establishing a connection to the model.
       @return A live session.
  
       @example
       ```ts
       let model: string;
       if (GOOGLE_GENAI_USE_VERTEXAI) {
         model = 'gemini-2.0-flash-live-preview-04-09';
       } else {
         model = 'gemini-live-2.5-flash-preview';
       }
       const session = await ai.live.connect({
         model: model,
         config: {
           responseModalities: [Modality.AUDIO],
         },
         callbacks: {
           onopen: () => {
             console.log('Connected to the socket.');
           },
           onmessage: (e: MessageEvent) => {
             console.log('Received message from the server: %s\n', debug(e.data));
           },
           onerror: (e: ErrorEvent) => {
             console.log('Error occurred: %s\n', debug(e.error));
           },
           onclose: (e: CloseEvent) => {
             console.log('Connection closed.');
           },
         },
       });
       ```
      */
  async connect(params) {
    var _a2, _b, _c, _d, _e, _f;
    if (params.config && params.config.httpOptions) {
      throw new Error("The Live module does not support httpOptions at request-level in LiveConnectConfig yet. Please use the client-level httpOptions configuration instead.");
    }
    const websocketBaseUrl = this.apiClient.getWebsocketBaseUrl();
    const apiVersion = this.apiClient.getApiVersion();
    let url;
    const clientHeaders = this.apiClient.getHeaders();
    if (params.config && params.config.tools && hasMcpToolUsage(params.config.tools)) {
      setMcpUsageHeader(clientHeaders);
    }
    const headers = mapToHeaders(clientHeaders);
    if (this.apiClient.isVertexAI()) {
      const project = this.apiClient.getProject();
      const location = this.apiClient.getLocation();
      const apiKey = this.apiClient.getApiKey();
      const hasStandardAuth = !!project && !!location || !!apiKey;
      if (this.apiClient.getCustomBaseUrl() && !hasStandardAuth) {
        url = websocketBaseUrl;
      } else {
        url = `${websocketBaseUrl}/ws/google.cloud.aiplatform.${apiVersion}.LlmBidiService/BidiGenerateContent`;
        await this.auth.addAuthHeaders(headers, url);
      }
    } else {
      const apiKey = this.apiClient.getApiKey();
      let method = "BidiGenerateContent";
      let keyName = "key";
      if (apiKey === null || apiKey === void 0 ? void 0 : apiKey.startsWith("auth_tokens/")) {
        console.warn("Warning: Ephemeral token support is experimental and may change in future versions.");
        if (apiVersion !== "v1alpha") {
          console.warn("Warning: The SDK's ephemeral token support is in v1alpha only. Please use const ai = new GoogleGenAI({apiKey: token.name, httpOptions: { apiVersion: 'v1alpha' }}); before session connection.");
        }
        method = "BidiGenerateContentConstrained";
        keyName = "access_token";
      }
      url = `${websocketBaseUrl}/ws/google.ai.generativelanguage.${apiVersion}.GenerativeService.${method}?${keyName}=${apiKey}`;
    }
    let onopenResolve = /* @__PURE__ */ __name(() => {
    }, "onopenResolve");
    const onopenPromise = new Promise((resolve) => {
      onopenResolve = resolve;
    });
    const callbacks = params.callbacks;
    const onopenAwaitedCallback = /* @__PURE__ */ __name(function() {
      var _a3;
      (_a3 = callbacks === null || callbacks === void 0 ? void 0 : callbacks.onopen) === null || _a3 === void 0 ? void 0 : _a3.call(callbacks);
      onopenResolve({});
    }, "onopenAwaitedCallback");
    const apiClient = this.apiClient;
    const websocketCallbacks = {
      onopen: onopenAwaitedCallback,
      onmessage: /* @__PURE__ */ __name((event) => {
        void handleWebSocketMessage(apiClient, callbacks.onmessage, event);
      }, "onmessage"),
      onerror: (_a2 = callbacks === null || callbacks === void 0 ? void 0 : callbacks.onerror) !== null && _a2 !== void 0 ? _a2 : function(e) {
      },
      onclose: (_b = callbacks === null || callbacks === void 0 ? void 0 : callbacks.onclose) !== null && _b !== void 0 ? _b : function(e) {
      }
    };
    const conn = this.webSocketFactory.create(url, headersToMap(headers), websocketCallbacks);
    conn.connect();
    await onopenPromise;
    let transformedModel = tModel(this.apiClient, params.model);
    if (this.apiClient.isVertexAI() && transformedModel.startsWith("publishers/")) {
      const project = this.apiClient.getProject();
      const location = this.apiClient.getLocation();
      if (project && location) {
        transformedModel = `projects/${project}/locations/${location}/` + transformedModel;
      }
    }
    let clientMessage = {};
    if (this.apiClient.isVertexAI() && ((_c = params.config) === null || _c === void 0 ? void 0 : _c.responseModalities) === void 0) {
      if (params.config === void 0) {
        params.config = { responseModalities: [Modality.AUDIO] };
      } else {
        params.config.responseModalities = [Modality.AUDIO];
      }
    }
    if ((_d = params.config) === null || _d === void 0 ? void 0 : _d.generationConfig) {
      console.warn("Setting `LiveConnectConfig.generation_config` is deprecated, please set the fields on `LiveConnectConfig` directly. This will become an error in a future version (not before Q3 2025).");
    }
    const inputTools = (_f = (_e = params.config) === null || _e === void 0 ? void 0 : _e.tools) !== null && _f !== void 0 ? _f : [];
    const convertedTools = [];
    for (const tool of inputTools) {
      if (this.isCallableTool(tool)) {
        const callableTool = tool;
        convertedTools.push(await callableTool.tool());
      } else {
        convertedTools.push(tool);
      }
    }
    if (convertedTools.length > 0) {
      params.config.tools = convertedTools;
    }
    const liveConnectParameters = {
      model: transformedModel,
      config: params.config,
      callbacks: params.callbacks
    };
    if (this.apiClient.isVertexAI()) {
      clientMessage = liveConnectParametersToVertex(this.apiClient, liveConnectParameters);
    } else {
      clientMessage = liveConnectParametersToMldev(this.apiClient, liveConnectParameters);
    }
    delete clientMessage["config"];
    conn.send(JSON.stringify(clientMessage));
    return new Session(conn, this.apiClient);
  }
  // TODO: b/416041229 - Abstract this method to a common place.
  isCallableTool(tool) {
    return "callTool" in tool && typeof tool.callTool === "function";
  }
};
var defaultLiveSendClientContentParamerters = {
  turnComplete: true
};
var Session = class {
  static {
    __name(this, "Session");
  }
  constructor(conn, apiClient) {
    this.conn = conn;
    this.apiClient = apiClient;
  }
  tLiveClientContent(apiClient, params) {
    if (params.turns !== null && params.turns !== void 0) {
      let contents = [];
      try {
        contents = tContents(params.turns);
        if (!apiClient.isVertexAI()) {
          contents = contents.map((item) => contentToMldev$1(item));
        }
      } catch (_a2) {
        throw new Error(`Failed to parse client content "turns", type: '${typeof params.turns}'`);
      }
      return {
        clientContent: { turns: contents, turnComplete: params.turnComplete }
      };
    }
    return {
      clientContent: { turnComplete: params.turnComplete }
    };
  }
  tLiveClienttToolResponse(apiClient, params) {
    let functionResponses = [];
    if (params.functionResponses == null) {
      throw new Error("functionResponses is required.");
    }
    if (!Array.isArray(params.functionResponses)) {
      functionResponses = [params.functionResponses];
    } else {
      functionResponses = params.functionResponses;
    }
    if (functionResponses.length === 0) {
      throw new Error("functionResponses is required.");
    }
    for (const functionResponse of functionResponses) {
      if (typeof functionResponse !== "object" || functionResponse === null || !("name" in functionResponse) || !("response" in functionResponse)) {
        throw new Error(`Could not parse function response, type '${typeof functionResponse}'.`);
      }
      if (!apiClient.isVertexAI() && !("id" in functionResponse)) {
        throw new Error(FUNCTION_RESPONSE_REQUIRES_ID);
      }
    }
    const clientMessage = {
      toolResponse: { "functionResponses": functionResponses }
    };
    return clientMessage;
  }
  /**
      Send a message over the established connection.
  
      @param params - Contains two **optional** properties, `turns` and
          `turnComplete`.
  
        - `turns` will be converted to a `Content[]`
        - `turnComplete: true` [default] indicates that you are done sending
          content and expect a response. If `turnComplete: false`, the server
          will wait for additional messages before starting generation.
  
      @experimental
  
      @remarks
      There are two ways to send messages to the live API:
      `sendClientContent` and `sendRealtimeInput`.
  
      `sendClientContent` messages are added to the model context **in order**.
      Having a conversation using `sendClientContent` messages is roughly
      equivalent to using the `Chat.sendMessageStream`, except that the state of
      the `chat` history is stored on the API server instead of locally.
  
      Because of `sendClientContent`'s order guarantee, the model cannot respons
      as quickly to `sendClientContent` messages as to `sendRealtimeInput`
      messages. This makes the biggest difference when sending objects that have
      significant preprocessing time (typically images).
  
      The `sendClientContent` message sends a `Content[]`
      which has more options than the `Blob` sent by `sendRealtimeInput`.
  
      So the main use-cases for `sendClientContent` over `sendRealtimeInput` are:
  
      - Sending anything that can't be represented as a `Blob` (text,
      `sendClientContent({turns="Hello?"}`)).
      - Managing turns when not using audio input and voice activity detection.
        (`sendClientContent({turnComplete:true})` or the short form
      `sendClientContent()`)
      - Prefilling a conversation context
        ```
        sendClientContent({
            turns: [
              Content({role:user, parts:...}),
              Content({role:user, parts:...}),
              ...
            ]
        })
        ```
      @experimental
     */
  sendClientContent(params) {
    params = Object.assign(Object.assign({}, defaultLiveSendClientContentParamerters), params);
    const clientMessage = this.tLiveClientContent(this.apiClient, params);
    this.conn.send(JSON.stringify(clientMessage));
  }
  /**
      Send a realtime message over the established connection.
  
      @param params - Contains one property, `media`.
  
        - `media` will be converted to a `Blob`
  
      @experimental
  
      @remarks
      Use `sendRealtimeInput` for realtime audio chunks and video frames (images).
  
      With `sendRealtimeInput` the api will respond to audio automatically
      based on voice activity detection (VAD).
  
      `sendRealtimeInput` is optimized for responsivness at the expense of
      deterministic ordering guarantees. Audio and video tokens are to the
      context when they become available.
  
      Note: The Call signature expects a `Blob` object, but only a subset
      of audio and image mimetypes are allowed.
     */
  sendRealtimeInput(params) {
    let clientMessage = {};
    if (this.apiClient.isVertexAI()) {
      clientMessage = {
        "realtimeInput": liveSendRealtimeInputParametersToVertex(params)
      };
    } else {
      clientMessage = {
        "realtimeInput": liveSendRealtimeInputParametersToMldev(params)
      };
    }
    this.conn.send(JSON.stringify(clientMessage));
  }
  /**
      Send a function response message over the established connection.
  
      @param params - Contains property `functionResponses`.
  
        - `functionResponses` will be converted to a `functionResponses[]`
  
      @remarks
      Use `sendFunctionResponse` to reply to `LiveServerToolCall` from the server.
  
      Use {@link types.LiveConnectConfig#tools} to configure the callable functions.
  
      @experimental
     */
  sendToolResponse(params) {
    if (params.functionResponses == null) {
      throw new Error("Tool response parameters are required.");
    }
    const clientMessage = this.tLiveClienttToolResponse(this.apiClient, params);
    this.conn.send(JSON.stringify(clientMessage));
  }
  /**
       Terminates the WebSocket connection.
  
       @experimental
  
       @example
       ```ts
       let model: string;
       if (GOOGLE_GENAI_USE_VERTEXAI) {
         model = 'gemini-2.0-flash-live-preview-04-09';
       } else {
         model = 'gemini-live-2.5-flash-preview';
       }
       const session = await ai.live.connect({
         model: model,
         config: {
           responseModalities: [Modality.AUDIO],
         }
       });
  
       session.close();
       ```
     */
  close() {
    this.conn.close();
  }
};
function headersToMap(headers) {
  const headerMap = {};
  headers.forEach((value, key) => {
    headerMap[key] = value;
  });
  return headerMap;
}
__name(headersToMap, "headersToMap");
function mapToHeaders(map) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(map)) {
    headers.append(key, value);
  }
  return headers;
}
__name(mapToHeaders, "mapToHeaders");
var DEFAULT_MAX_REMOTE_CALLS = 10;
function shouldDisableAfc(config) {
  var _a2, _b, _c;
  if ((_a2 = config === null || config === void 0 ? void 0 : config.automaticFunctionCalling) === null || _a2 === void 0 ? void 0 : _a2.disable) {
    return true;
  }
  let callableToolsPresent = false;
  for (const tool of (_b = config === null || config === void 0 ? void 0 : config.tools) !== null && _b !== void 0 ? _b : []) {
    if (isCallableTool(tool)) {
      callableToolsPresent = true;
      break;
    }
  }
  if (!callableToolsPresent) {
    return true;
  }
  const maxCalls = (_c = config === null || config === void 0 ? void 0 : config.automaticFunctionCalling) === null || _c === void 0 ? void 0 : _c.maximumRemoteCalls;
  if (maxCalls && (maxCalls < 0 || !Number.isInteger(maxCalls)) || maxCalls == 0) {
    console.warn("Invalid maximumRemoteCalls value provided for automatic function calling. Disabled automatic function calling. Please provide a valid integer value greater than 0. maximumRemoteCalls provided:", maxCalls);
    return true;
  }
  return false;
}
__name(shouldDisableAfc, "shouldDisableAfc");
function isCallableTool(tool) {
  return "callTool" in tool && typeof tool.callTool === "function";
}
__name(isCallableTool, "isCallableTool");
function hasCallableTools(params) {
  var _a2, _b, _c;
  return (_c = (_b = (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.tools) === null || _b === void 0 ? void 0 : _b.some((tool) => isCallableTool(tool))) !== null && _c !== void 0 ? _c : false;
}
__name(hasCallableTools, "hasCallableTools");
function findAfcIncompatibleToolIndexes(params) {
  var _a2;
  const afcIncompatibleToolIndexes = [];
  if (!((_a2 = params === null || params === void 0 ? void 0 : params.config) === null || _a2 === void 0 ? void 0 : _a2.tools)) {
    return afcIncompatibleToolIndexes;
  }
  params.config.tools.forEach((tool, index) => {
    if (isCallableTool(tool)) {
      return;
    }
    const geminiTool = tool;
    if (geminiTool.functionDeclarations && geminiTool.functionDeclarations.length > 0) {
      afcIncompatibleToolIndexes.push(index);
    }
  });
  return afcIncompatibleToolIndexes;
}
__name(findAfcIncompatibleToolIndexes, "findAfcIncompatibleToolIndexes");
function shouldAppendAfcHistory(config) {
  var _a2;
  return !((_a2 = config === null || config === void 0 ? void 0 : config.automaticFunctionCalling) === null || _a2 === void 0 ? void 0 : _a2.ignoreCallHistory);
}
__name(shouldAppendAfcHistory, "shouldAppendAfcHistory");
var Models = class extends BaseModule {
  static {
    __name(this, "Models");
  }
  constructor(apiClient) {
    super();
    this.apiClient = apiClient;
    this.embedContent = async (params) => {
      if (!this.apiClient.isVertexAI()) {
        const isGeminiEmbedding2Model = params.model.includes("gemini-embedding-2");
        if (isGeminiEmbedding2Model) {
          params.contents = tContents(params.contents);
        }
        return await this.embedContentInternal(params);
      }
      const isVertexEmbedContentModel = params.model.includes("gemini") && params.model !== "gemini-embedding-001" || params.model.includes("maas");
      if (isVertexEmbedContentModel) {
        const contents = tContents(params.contents);
        if (contents.length > 1) {
          throw new Error("The embedContent API for this model only supports one content at a time.");
        }
        const paramsPrivate = Object.assign(Object.assign({}, params), { content: contents[0], embeddingApiType: EmbeddingApiType.EMBED_CONTENT });
        return await this.embedContentInternal(paramsPrivate);
      } else {
        const paramsPrivate = Object.assign(Object.assign({}, params), { embeddingApiType: EmbeddingApiType.PREDICT });
        return await this.embedContentInternal(paramsPrivate);
      }
    };
    this.generateContent = async (params) => {
      var _a2, _b, _c, _d, _e;
      const transformedParams = await this.processParamsMaybeAddMcpUsage(params);
      this.maybeMoveToResponseJsonSchem(params);
      if (!hasCallableTools(params) || shouldDisableAfc(params.config)) {
        return await this.generateContentInternal(transformedParams);
      }
      const incompatibleToolIndexes = findAfcIncompatibleToolIndexes(params);
      if (incompatibleToolIndexes.length > 0) {
        const formattedIndexes = incompatibleToolIndexes.map((index) => `tools[${index}]`).join(", ");
        throw new Error(`Automatic function calling with CallableTools (or MCP objects) and basic FunctionDeclarations is not yet supported. Incompatible tools found at ${formattedIndexes}.`);
      }
      let response;
      let functionResponseContent;
      const automaticFunctionCallingHistory = tContents(transformedParams.contents);
      const maxRemoteCalls = (_c = (_b = (_a2 = transformedParams.config) === null || _a2 === void 0 ? void 0 : _a2.automaticFunctionCalling) === null || _b === void 0 ? void 0 : _b.maximumRemoteCalls) !== null && _c !== void 0 ? _c : DEFAULT_MAX_REMOTE_CALLS;
      let remoteCalls = 0;
      while (remoteCalls < maxRemoteCalls) {
        response = await this.generateContentInternal(transformedParams);
        if (!response.functionCalls || response.functionCalls.length === 0) {
          break;
        }
        const responseContent = response.candidates[0].content;
        const functionResponseParts = [];
        for (const tool of (_e = (_d = params.config) === null || _d === void 0 ? void 0 : _d.tools) !== null && _e !== void 0 ? _e : []) {
          if (isCallableTool(tool)) {
            const callableTool = tool;
            const parts = await callableTool.callTool(response.functionCalls);
            functionResponseParts.push(...parts);
          }
        }
        remoteCalls++;
        functionResponseContent = {
          role: "user",
          parts: functionResponseParts
        };
        transformedParams.contents = tContents(transformedParams.contents);
        transformedParams.contents.push(responseContent);
        transformedParams.contents.push(functionResponseContent);
        if (shouldAppendAfcHistory(transformedParams.config)) {
          automaticFunctionCallingHistory.push(responseContent);
          automaticFunctionCallingHistory.push(functionResponseContent);
        }
      }
      if (shouldAppendAfcHistory(transformedParams.config)) {
        response.automaticFunctionCallingHistory = automaticFunctionCallingHistory;
      }
      return response;
    };
    this.generateContentStream = async (params) => {
      var _a2, _b, _c, _d, _e;
      this.maybeMoveToResponseJsonSchem(params);
      if (shouldDisableAfc(params.config)) {
        const transformedParams = await this.processParamsMaybeAddMcpUsage(params);
        return await this.generateContentStreamInternal(transformedParams);
      }
      const incompatibleToolIndexes = findAfcIncompatibleToolIndexes(params);
      if (incompatibleToolIndexes.length > 0) {
        const formattedIndexes = incompatibleToolIndexes.map((index) => `tools[${index}]`).join(", ");
        throw new Error(`Incompatible tools found at ${formattedIndexes}. Automatic function calling with CallableTools (or MCP objects) and basic FunctionDeclarations" is not yet supported.`);
      }
      const streamFunctionCall = (_c = (_b = (_a2 = params === null || params === void 0 ? void 0 : params.config) === null || _a2 === void 0 ? void 0 : _a2.toolConfig) === null || _b === void 0 ? void 0 : _b.functionCallingConfig) === null || _c === void 0 ? void 0 : _c.streamFunctionCallArguments;
      const disableAfc = (_e = (_d = params === null || params === void 0 ? void 0 : params.config) === null || _d === void 0 ? void 0 : _d.automaticFunctionCalling) === null || _e === void 0 ? void 0 : _e.disable;
      if (streamFunctionCall && !disableAfc) {
        throw new Error("Running in streaming mode with 'streamFunctionCallArguments' enabled, this feature is not compatible with automatic function calling (AFC). Please set 'config.automaticFunctionCalling.disable' to true to disable AFC or leave 'config.toolConfig.functionCallingConfig.streamFunctionCallArguments' to be undefined or set to false to disable streaming function call arguments feature.");
      }
      return await this.processAfcStream(params);
    };
    this.generateImages = async (params) => {
      return await this.generateImagesInternal(params).then((apiResponse) => {
        var _a2;
        let positivePromptSafetyAttributes;
        const generatedImages = [];
        if (apiResponse === null || apiResponse === void 0 ? void 0 : apiResponse.generatedImages) {
          for (const generatedImage of apiResponse.generatedImages) {
            if (generatedImage && (generatedImage === null || generatedImage === void 0 ? void 0 : generatedImage.safetyAttributes) && ((_a2 = generatedImage === null || generatedImage === void 0 ? void 0 : generatedImage.safetyAttributes) === null || _a2 === void 0 ? void 0 : _a2.contentType) === "Positive Prompt") {
              positivePromptSafetyAttributes = generatedImage === null || generatedImage === void 0 ? void 0 : generatedImage.safetyAttributes;
            } else {
              generatedImages.push(generatedImage);
            }
          }
        }
        let response;
        if (positivePromptSafetyAttributes) {
          response = {
            generatedImages,
            positivePromptSafetyAttributes,
            sdkHttpResponse: apiResponse.sdkHttpResponse
          };
        } else {
          response = {
            generatedImages,
            sdkHttpResponse: apiResponse.sdkHttpResponse
          };
        }
        return response;
      });
    };
    this.list = async (params) => {
      var _a2;
      const defaultConfig = {
        queryBase: true
      };
      const actualConfig = Object.assign(Object.assign({}, defaultConfig), params === null || params === void 0 ? void 0 : params.config);
      const actualParams = {
        config: actualConfig
      };
      if (this.apiClient.isVertexAI()) {
        if (!actualParams.config.queryBase) {
          if ((_a2 = actualParams.config) === null || _a2 === void 0 ? void 0 : _a2.filter) {
            throw new Error("Filtering tuned models list is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
          } else {
            actualParams.config.filter = "labels.tune-type:*";
          }
        }
      }
      return new Pager(PagedItem.PAGED_ITEM_MODELS, (x) => this.listInternal(x), await this.listInternal(actualParams), actualParams);
    };
    this.editImage = async (params) => {
      const paramsInternal = {
        model: params.model,
        prompt: params.prompt,
        referenceImages: [],
        config: params.config
      };
      if (params.referenceImages) {
        if (params.referenceImages) {
          paramsInternal.referenceImages = params.referenceImages.map((img) => img.toReferenceImageAPI());
        }
      }
      return await this.editImageInternal(paramsInternal);
    };
    this.upscaleImage = async (params) => {
      let apiConfig = {
        numberOfImages: 1,
        mode: "upscale"
      };
      if (params.config) {
        apiConfig = Object.assign(Object.assign({}, apiConfig), params.config);
      }
      const apiParams = {
        model: params.model,
        image: params.image,
        upscaleFactor: params.upscaleFactor,
        config: apiConfig
      };
      return await this.upscaleImageInternal(apiParams);
    };
    this.generateVideos = async (params) => {
      var _a2, _b, _c, _d, _e, _f;
      if ((params.prompt || params.image || params.video) && params.source) {
        throw new Error("Source and prompt/image/video are mutually exclusive. Please only use source.");
      }
      if (!this.apiClient.isVertexAI()) {
        if (((_a2 = params.video) === null || _a2 === void 0 ? void 0 : _a2.uri) && ((_b = params.video) === null || _b === void 0 ? void 0 : _b.videoBytes)) {
          params.video = {
            uri: params.video.uri,
            mimeType: params.video.mimeType
          };
        } else if (((_d = (_c = params.source) === null || _c === void 0 ? void 0 : _c.video) === null || _d === void 0 ? void 0 : _d.uri) && ((_f = (_e = params.source) === null || _e === void 0 ? void 0 : _e.video) === null || _f === void 0 ? void 0 : _f.videoBytes)) {
          params.source.video = {
            uri: params.source.video.uri,
            mimeType: params.source.video.mimeType
          };
        }
      }
      return await this.generateVideosInternal(params);
    };
  }
  /**
   * This logic is needed for GenerateContentConfig only.
   * Previously we made GenerateContentConfig.responseSchema field to accept
   * unknown. Since v1.9.0, we switch to use backend JSON schema support.
   * To maintain backward compatibility, we move the data that was treated as
   * JSON schema from the responseSchema field to the responseJsonSchema field.
   */
  maybeMoveToResponseJsonSchem(params) {
    if (params.config && params.config.responseSchema) {
      if (!params.config.responseJsonSchema) {
        if (Object.keys(params.config.responseSchema).includes("$schema")) {
          params.config.responseJsonSchema = params.config.responseSchema;
          delete params.config.responseSchema;
        }
      }
    }
    return;
  }
  /**
   * Transforms the CallableTools in the parameters to be simply Tools, it
   * copies the params into a new object and replaces the tools, it does not
   * modify the original params. Also sets the MCP usage header if there are
   * MCP tools in the parameters.
   */
  async processParamsMaybeAddMcpUsage(params) {
    var _a2, _b, _c;
    const tools = (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.tools;
    if (!tools) {
      return params;
    }
    const transformedTools = await Promise.all(tools.map(async (tool) => {
      if (isCallableTool(tool)) {
        const callableTool = tool;
        return await callableTool.tool();
      }
      return tool;
    }));
    const newParams = {
      model: params.model,
      contents: params.contents,
      config: Object.assign(Object.assign({}, params.config), { tools: transformedTools })
    };
    newParams.config.tools = transformedTools;
    if (params.config && params.config.tools && hasMcpToolUsage(params.config.tools)) {
      const headers = (_c = (_b = params.config.httpOptions) === null || _b === void 0 ? void 0 : _b.headers) !== null && _c !== void 0 ? _c : {};
      let newHeaders = Object.assign({}, headers);
      if (Object.keys(newHeaders).length === 0) {
        newHeaders = this.apiClient.getDefaultHeaders();
      }
      setMcpUsageHeader(newHeaders);
      newParams.config.httpOptions = Object.assign(Object.assign({}, params.config.httpOptions), { headers: newHeaders });
    }
    return newParams;
  }
  async initAfcToolsMap(params) {
    var _a2, _b, _c;
    const afcTools = /* @__PURE__ */ new Map();
    for (const tool of (_b = (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.tools) !== null && _b !== void 0 ? _b : []) {
      if (isCallableTool(tool)) {
        const callableTool = tool;
        const toolDeclaration = await callableTool.tool();
        for (const declaration of (_c = toolDeclaration.functionDeclarations) !== null && _c !== void 0 ? _c : []) {
          if (!declaration.name) {
            throw new Error("Function declaration name is required.");
          }
          if (afcTools.has(declaration.name)) {
            throw new Error(`Duplicate tool declaration name: ${declaration.name}`);
          }
          afcTools.set(declaration.name, callableTool);
        }
      }
    }
    return afcTools;
  }
  async processAfcStream(params) {
    var _a2, _b, _c;
    const maxRemoteCalls = (_c = (_b = (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.automaticFunctionCalling) === null || _b === void 0 ? void 0 : _b.maximumRemoteCalls) !== null && _c !== void 0 ? _c : DEFAULT_MAX_REMOTE_CALLS;
    let wereFunctionsCalled = false;
    let remoteCallCount = 0;
    const afcToolsMap = await this.initAfcToolsMap(params);
    return function(models, afcTools, params2) {
      return __asyncGenerator(this, arguments, function* () {
        var _a3, e_1, _b2, _c2;
        var _d, _e;
        while (remoteCallCount < maxRemoteCalls) {
          if (wereFunctionsCalled) {
            remoteCallCount++;
            wereFunctionsCalled = false;
          }
          const transformedParams = yield __await(models.processParamsMaybeAddMcpUsage(params2));
          const response = yield __await(models.generateContentStreamInternal(transformedParams));
          const functionResponses = [];
          const responseContents = [];
          try {
            for (var _f = true, response_1 = (e_1 = void 0, __asyncValues(response)), response_1_1; response_1_1 = yield __await(response_1.next()), _a3 = response_1_1.done, !_a3; _f = true) {
              _c2 = response_1_1.value;
              _f = false;
              const chunk = _c2;
              yield yield __await(chunk);
              if (chunk.candidates && ((_d = chunk.candidates[0]) === null || _d === void 0 ? void 0 : _d.content)) {
                responseContents.push(chunk.candidates[0].content);
                for (const part of (_e = chunk.candidates[0].content.parts) !== null && _e !== void 0 ? _e : []) {
                  if (remoteCallCount < maxRemoteCalls && part.functionCall) {
                    if (!part.functionCall.name) {
                      throw new Error("Function call name was not returned by the model.");
                    }
                    if (!afcTools.has(part.functionCall.name)) {
                      throw new Error(`Automatic function calling was requested, but not all the tools the model used implement the CallableTool interface. Available tools: ${afcTools.keys()}, mising tool: ${part.functionCall.name}`);
                    } else {
                      const responseParts = yield __await(afcTools.get(part.functionCall.name).callTool([part.functionCall]));
                      functionResponses.push(...responseParts);
                    }
                  }
                }
              }
            }
          } catch (e_1_1) {
            e_1 = { error: e_1_1 };
          } finally {
            try {
              if (!_f && !_a3 && (_b2 = response_1.return)) yield __await(_b2.call(response_1));
            } finally {
              if (e_1) throw e_1.error;
            }
          }
          if (functionResponses.length > 0) {
            wereFunctionsCalled = true;
            const typedResponseChunk = new GenerateContentResponse();
            typedResponseChunk.candidates = [
              {
                content: {
                  role: "user",
                  parts: functionResponses
                }
              }
            ];
            yield yield __await(typedResponseChunk);
            const newContents = [];
            newContents.push(...responseContents);
            newContents.push({
              role: "user",
              parts: functionResponses
            });
            const updatedContents = tContents(params2.contents).concat(newContents);
            params2.contents = updatedContents;
          } else {
            break;
          }
        }
      });
    }(this, afcToolsMap, params);
  }
  async generateContentInternal(params) {
    var _a2, _b, _c, _d;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = generateContentParametersToVertex(this.apiClient, params);
      path2 = formatMap("{model}:generateContent", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = generateContentResponseFromVertex(apiResponse);
        const typedResp = new GenerateContentResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    } else {
      const body = generateContentParametersToMldev(this.apiClient, params);
      path2 = formatMap("{model}:generateContent", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_c = params.config) === null || _c === void 0 ? void 0 : _c.httpOptions,
        abortSignal: (_d = params.config) === null || _d === void 0 ? void 0 : _d.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = generateContentResponseFromMldev(apiResponse);
        const typedResp = new GenerateContentResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    }
  }
  async generateContentStreamInternal(params) {
    var _a2, _b, _c, _d;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = generateContentParametersToVertex(this.apiClient, params);
      path2 = formatMap("{model}:streamGenerateContent?alt=sse", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      const apiClient = this.apiClient;
      response = apiClient.requestStream({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      });
      return response.then(function(apiResponse) {
        return __asyncGenerator(this, arguments, function* () {
          var _a3, e_2, _b2, _c2;
          try {
            for (var _d2 = true, apiResponse_1 = __asyncValues(apiResponse), apiResponse_1_1; apiResponse_1_1 = yield __await(apiResponse_1.next()), _a3 = apiResponse_1_1.done, !_a3; _d2 = true) {
              _c2 = apiResponse_1_1.value;
              _d2 = false;
              const chunk = _c2;
              const resp = generateContentResponseFromVertex(yield __await(chunk.json()), params);
              resp["sdkHttpResponse"] = {
                headers: chunk.headers
              };
              const typedResp = new GenerateContentResponse();
              Object.assign(typedResp, resp);
              yield yield __await(typedResp);
            }
          } catch (e_2_1) {
            e_2 = { error: e_2_1 };
          } finally {
            try {
              if (!_d2 && !_a3 && (_b2 = apiResponse_1.return)) yield __await(_b2.call(apiResponse_1));
            } finally {
              if (e_2) throw e_2.error;
            }
          }
        });
      });
    } else {
      const body = generateContentParametersToMldev(this.apiClient, params);
      path2 = formatMap("{model}:streamGenerateContent?alt=sse", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      const apiClient = this.apiClient;
      response = apiClient.requestStream({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_c = params.config) === null || _c === void 0 ? void 0 : _c.httpOptions,
        abortSignal: (_d = params.config) === null || _d === void 0 ? void 0 : _d.abortSignal
      });
      return response.then(function(apiResponse) {
        return __asyncGenerator(this, arguments, function* () {
          var _a3, e_3, _b2, _c2;
          try {
            for (var _d2 = true, apiResponse_2 = __asyncValues(apiResponse), apiResponse_2_1; apiResponse_2_1 = yield __await(apiResponse_2.next()), _a3 = apiResponse_2_1.done, !_a3; _d2 = true) {
              _c2 = apiResponse_2_1.value;
              _d2 = false;
              const chunk = _c2;
              const resp = generateContentResponseFromMldev(yield __await(chunk.json()), params);
              resp["sdkHttpResponse"] = {
                headers: chunk.headers
              };
              const typedResp = new GenerateContentResponse();
              Object.assign(typedResp, resp);
              yield yield __await(typedResp);
            }
          } catch (e_3_1) {
            e_3 = { error: e_3_1 };
          } finally {
            try {
              if (!_d2 && !_a3 && (_b2 = apiResponse_2.return)) yield __await(_b2.call(apiResponse_2));
            } finally {
              if (e_3) throw e_3.error;
            }
          }
        });
      });
    }
  }
  /**
   * Calculates embeddings for the given contents. Only text is supported.
   *
   * @param params - The parameters for embedding contents.
   * @return The response from the API.
   *
   * @example
   * ```ts
   * const response = await ai.models.embedContent({
   *  model: 'text-embedding-004',
   *  contents: [
   *    'What is your name?',
   *    'What is your favorite color?',
   *  ],
   *  config: {
   *    outputDimensionality: 64,
   *  },
   * });
   * console.log(response);
   * ```
   */
  async embedContentInternal(params) {
    var _a2, _b, _c, _d;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = embedContentParametersPrivateToVertex(this.apiClient, params, params);
      const endpointUrl = tIsVertexEmbedContentModel(params.model) ? "{model}:embedContent" : "{model}:predict";
      path2 = formatMap(endpointUrl, body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = embedContentResponseFromVertex(apiResponse, params);
        const typedResp = new EmbedContentResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    } else {
      const body = embedContentParametersPrivateToMldev(this.apiClient, params);
      path2 = formatMap("{model}:batchEmbedContents", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_c = params.config) === null || _c === void 0 ? void 0 : _c.httpOptions,
        abortSignal: (_d = params.config) === null || _d === void 0 ? void 0 : _d.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = embedContentResponseFromMldev(apiResponse);
        const typedResp = new EmbedContentResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    }
  }
  /**
   * Private method for generating images.
   */
  async generateImagesInternal(params) {
    var _a2, _b, _c, _d;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = generateImagesParametersToVertex(this.apiClient, params);
      path2 = formatMap("{model}:predict", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = generateImagesResponseFromVertex(apiResponse);
        const typedResp = new GenerateImagesResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    } else {
      const body = generateImagesParametersToMldev(this.apiClient, params);
      path2 = formatMap("{model}:predict", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_c = params.config) === null || _c === void 0 ? void 0 : _c.httpOptions,
        abortSignal: (_d = params.config) === null || _d === void 0 ? void 0 : _d.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = generateImagesResponseFromMldev(apiResponse);
        const typedResp = new GenerateImagesResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    }
  }
  /**
   * Private method for editing an image.
   */
  async editImageInternal(params) {
    var _a2, _b;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = editImageParametersInternalToVertex(this.apiClient, params);
      path2 = formatMap("{model}:predict", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = editImageResponseFromVertex(apiResponse);
        const typedResp = new EditImageResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    } else {
      throw new Error("This method is only supported by the Gemini Enterprise Agent Platform (previously known as Vertex AI).");
    }
  }
  /**
   * Private method for upscaling an image.
   */
  async upscaleImageInternal(params) {
    var _a2, _b;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = upscaleImageAPIParametersInternalToVertex(this.apiClient, params);
      path2 = formatMap("{model}:predict", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = upscaleImageResponseFromVertex(apiResponse);
        const typedResp = new UpscaleImageResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    } else {
      throw new Error("This method is only supported by the Gemini Enterprise Agent Platform (previously known as Vertex AI).");
    }
  }
  /**
   * Recontextualizes an image.
   *
   * There is one type of recontextualization currently supported:
   * 1) Virtual Try-On: Generate images of persons modeling fashion products.
   *
   * @param params - The parameters for recontextualizing an image.
   * @return The response from the API.
   *
   * @example
   * ```ts
   * const response = await ai.models.recontextImage({
   *  model: 'virtual-try-on-001',
   *  source: {
   *    personImage: personImage,
   *    productImages: [productImage],
   *  },
   *  config: {
   *    numberOfImages: 1,
   *  },
   * });
   * console.log(response?.generatedImages?.[0]?.image?.imageBytes);
   * ```
   */
  async recontextImage(params) {
    var _a2, _b;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = recontextImageParametersToVertex(this.apiClient, params);
      path2 = formatMap("{model}:predict", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((apiResponse) => {
        const resp = recontextImageResponseFromVertex(apiResponse);
        const typedResp = new RecontextImageResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    } else {
      throw new Error("This method is only supported by the Gemini Enterprise Agent Platform (previously known as Vertex AI).");
    }
  }
  /**
   * Segments an image, creating a mask of a specified area.
   *
   * @param params - The parameters for segmenting an image.
   * @return The response from the API.
   *
   * @example
   * ```ts
   * const response = await ai.models.segmentImage({
   *  model: 'image-segmentation-001',
   *  source: {
   *    image: image,
   *  },
   *  config: {
   *    mode: 'foreground',
   *  },
   * });
   * console.log(response?.generatedMasks?.[0]?.mask?.imageBytes);
   * ```
   */
  async segmentImage(params) {
    var _a2, _b;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = segmentImageParametersToVertex(this.apiClient, params);
      path2 = formatMap("{model}:predict", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((apiResponse) => {
        const resp = segmentImageResponseFromVertex(apiResponse);
        const typedResp = new SegmentImageResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    } else {
      throw new Error("This method is only supported by the Gemini Enterprise Agent Platform (previously known as Vertex AI).");
    }
  }
  /**
   * Fetches information about a model by name.
   *
   * @example
   * ```ts
   * const modelInfo = await ai.models.get({model: 'gemini-2.0-flash'});
   * ```
   */
  async get(params) {
    var _a2, _b, _c, _d;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = getModelParametersToVertex(this.apiClient, params);
      path2 = formatMap("{name}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "GET",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((apiResponse) => {
        const resp = modelFromVertex(apiResponse);
        return resp;
      });
    } else {
      const body = getModelParametersToMldev(this.apiClient, params);
      path2 = formatMap("{name}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "GET",
        httpOptions: (_c = params.config) === null || _c === void 0 ? void 0 : _c.httpOptions,
        abortSignal: (_d = params.config) === null || _d === void 0 ? void 0 : _d.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((apiResponse) => {
        const resp = modelFromMldev(apiResponse);
        return resp;
      });
    }
  }
  async listInternal(params) {
    var _a2, _b, _c, _d;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = listModelsParametersToVertex(this.apiClient, params);
      path2 = formatMap("{models_url}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "GET",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = listModelsResponseFromVertex(apiResponse);
        const typedResp = new ListModelsResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    } else {
      const body = listModelsParametersToMldev(this.apiClient, params);
      path2 = formatMap("{models_url}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "GET",
        httpOptions: (_c = params.config) === null || _c === void 0 ? void 0 : _c.httpOptions,
        abortSignal: (_d = params.config) === null || _d === void 0 ? void 0 : _d.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = listModelsResponseFromMldev(apiResponse);
        const typedResp = new ListModelsResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    }
  }
  /**
   * Updates a tuned model by its name.
   *
   * @param params - The parameters for updating the model.
   * @return The response from the API.
   *
   * @example
   * ```ts
   * const response = await ai.models.update({
   *   model: 'tuned-model-name',
   *   config: {
   *     displayName: 'New display name',
   *     description: 'New description',
   *   },
   * });
   * ```
   */
  async update(params) {
    var _a2, _b, _c, _d;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = updateModelParametersToVertex(this.apiClient, params);
      path2 = formatMap("{model}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "PATCH",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((apiResponse) => {
        const resp = modelFromVertex(apiResponse);
        return resp;
      });
    } else {
      const body = updateModelParametersToMldev(this.apiClient, params);
      path2 = formatMap("{name}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "PATCH",
        httpOptions: (_c = params.config) === null || _c === void 0 ? void 0 : _c.httpOptions,
        abortSignal: (_d = params.config) === null || _d === void 0 ? void 0 : _d.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((apiResponse) => {
        const resp = modelFromMldev(apiResponse);
        return resp;
      });
    }
  }
  /**
   * Deletes a tuned model by its name.
   *
   * @param params - The parameters for deleting the model.
   * @return The response from the API.
   *
   * @example
   * ```ts
   * const response = await ai.models.delete({model: 'tuned-model-name'});
   * ```
   */
  async delete(params) {
    var _a2, _b, _c, _d;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = deleteModelParametersToVertex(this.apiClient, params);
      path2 = formatMap("{name}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "DELETE",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = deleteModelResponseFromVertex(apiResponse);
        const typedResp = new DeleteModelResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    } else {
      const body = deleteModelParametersToMldev(this.apiClient, params);
      path2 = formatMap("{name}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "DELETE",
        httpOptions: (_c = params.config) === null || _c === void 0 ? void 0 : _c.httpOptions,
        abortSignal: (_d = params.config) === null || _d === void 0 ? void 0 : _d.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = deleteModelResponseFromMldev(apiResponse);
        const typedResp = new DeleteModelResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    }
  }
  /**
   * Counts the number of tokens in the given contents. Multimodal input is
   * supported for Gemini models.
   *
   * @param params - The parameters for counting tokens.
   * @return The response from the API.
   *
   * @example
   * ```ts
   * const response = await ai.models.countTokens({
   *  model: 'gemini-2.0-flash',
   *  contents: 'The quick brown fox jumps over the lazy dog.'
   * });
   * console.log(response);
   * ```
   */
  async countTokens(params) {
    var _a2, _b, _c, _d;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = countTokensParametersToVertex(this.apiClient, params);
      path2 = formatMap("{model}:countTokens", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = countTokensResponseFromVertex(apiResponse);
        const typedResp = new CountTokensResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    } else {
      const body = countTokensParametersToMldev(this.apiClient, params);
      path2 = formatMap("{model}:countTokens", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_c = params.config) === null || _c === void 0 ? void 0 : _c.httpOptions,
        abortSignal: (_d = params.config) === null || _d === void 0 ? void 0 : _d.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = countTokensResponseFromMldev(apiResponse);
        const typedResp = new CountTokensResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    }
  }
  /**
   * Given a list of contents, returns a corresponding TokensInfo containing
   * the list of tokens and list of token ids.
   *
   * This method is not supported by the Gemini Developer API.
   *
   * @param params - The parameters for computing tokens.
   * @return The response from the API.
   *
   * @example
   * ```ts
   * const response = await ai.models.computeTokens({
   *  model: 'gemini-2.0-flash',
   *  contents: 'What is your name?'
   * });
   * console.log(response);
   * ```
   */
  async computeTokens(params) {
    var _a2, _b;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = computeTokensParametersToVertex(this.apiClient, params);
      path2 = formatMap("{model}:computeTokens", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = computeTokensResponseFromVertex(apiResponse);
        const typedResp = new ComputeTokensResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    } else {
      throw new Error("This method is only supported by the Gemini Enterprise Agent Platform (previously known as Vertex AI).");
    }
  }
  /**
   * Private method for generating videos.
   */
  async generateVideosInternal(params) {
    var _a2, _b, _c, _d;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = generateVideosParametersToVertex(this.apiClient, params);
      path2 = formatMap("{model}:predictLongRunning", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((apiResponse) => {
        const resp = generateVideosOperationFromVertex(apiResponse);
        const typedResp = new GenerateVideosOperation();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    } else {
      const body = generateVideosParametersToMldev(this.apiClient, params);
      path2 = formatMap("{model}:predictLongRunning", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_c = params.config) === null || _c === void 0 ? void 0 : _c.httpOptions,
        abortSignal: (_d = params.config) === null || _d === void 0 ? void 0 : _d.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((apiResponse) => {
        const resp = generateVideosOperationFromMldev(apiResponse);
        const typedResp = new GenerateVideosOperation();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    }
  }
};
var Operations = class extends BaseModule {
  static {
    __name(this, "Operations");
  }
  constructor(apiClient) {
    super();
    this.apiClient = apiClient;
  }
  /**
   * Gets the status of a long-running operation.
   *
   * @param parameters The parameters for the get operation request.
   * @return The updated Operation object, with the latest status or result.
   */
  async getVideosOperation(parameters) {
    const operation = parameters.operation;
    const config = parameters.config;
    if (operation.name === void 0 || operation.name === "") {
      throw new Error("Operation name is required.");
    }
    if (this.apiClient.isVertexAI()) {
      const resourceName2 = operation.name.split("/operations/")[0];
      let httpOptions = void 0;
      if (config && "httpOptions" in config) {
        httpOptions = config.httpOptions;
      }
      const rawOperation = await this.fetchPredictVideosOperationInternal({
        operationName: operation.name,
        resourceName: resourceName2,
        config: { httpOptions }
      });
      return operation._fromAPIResponse({
        apiResponse: rawOperation,
        _isVertexAI: true
      });
    } else {
      const rawOperation = await this.getVideosOperationInternal({
        operationName: operation.name,
        config
      });
      return operation._fromAPIResponse({
        apiResponse: rawOperation,
        _isVertexAI: false
      });
    }
  }
  /**
   * Gets the status of a long-running operation.
   *
   * @param parameters The parameters for the get operation request.
   * @return The updated Operation object, with the latest status or result.
   */
  async get(parameters) {
    const operation = parameters.operation;
    const config = parameters.config;
    if (operation.name === void 0 || operation.name === "") {
      throw new Error("Operation name is required.");
    }
    if (this.apiClient.isVertexAI()) {
      const resourceName2 = operation.name.split("/operations/")[0];
      let httpOptions = void 0;
      if (config && "httpOptions" in config) {
        httpOptions = config.httpOptions;
      }
      const rawOperation = await this.fetchPredictVideosOperationInternal({
        operationName: operation.name,
        resourceName: resourceName2,
        config: { httpOptions }
      });
      return operation._fromAPIResponse({
        apiResponse: rawOperation,
        _isVertexAI: true
      });
    } else {
      const rawOperation = await this.getVideosOperationInternal({
        operationName: operation.name,
        config
      });
      return operation._fromAPIResponse({
        apiResponse: rawOperation,
        _isVertexAI: false
      });
    }
  }
  async getVideosOperationInternal(params) {
    var _a2, _b, _c, _d;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = getOperationParametersToVertex(params);
      path2 = formatMap("{operationName}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "GET",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response;
    } else {
      const body = getOperationParametersToMldev(params);
      path2 = formatMap("{operationName}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "GET",
        httpOptions: (_c = params.config) === null || _c === void 0 ? void 0 : _c.httpOptions,
        abortSignal: (_d = params.config) === null || _d === void 0 ? void 0 : _d.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response;
    }
  }
  async fetchPredictVideosOperationInternal(params) {
    var _a2, _b;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = fetchPredictOperationParametersToVertex(params);
      path2 = formatMap("{resourceName}:fetchPredictOperation", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response;
    } else {
      throw new Error("This method is only supported by the Gemini Enterprise Agent Platform (previously known as Vertex AI).");
    }
  }
};
function audioTranscriptionConfigToMldev(fromObject) {
  const toObject = {};
  if (getValueByPath(fromObject, ["languageCodes"]) !== void 0) {
    throw new Error("languageCodes parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(audioTranscriptionConfigToMldev, "audioTranscriptionConfigToMldev");
function authConfigToMldev(fromObject) {
  const toObject = {};
  const fromApiKey = getValueByPath(fromObject, ["apiKey"]);
  if (fromApiKey != null) {
    setValueByPath(toObject, ["apiKey"], fromApiKey);
  }
  if (getValueByPath(fromObject, ["apiKeyConfig"]) !== void 0) {
    throw new Error("apiKeyConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["authType"]) !== void 0) {
    throw new Error("authType parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["googleServiceAccountConfig"]) !== void 0) {
    throw new Error("googleServiceAccountConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["httpBasicAuthConfig"]) !== void 0) {
    throw new Error("httpBasicAuthConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["oauthConfig"]) !== void 0) {
    throw new Error("oauthConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["oidcConfig"]) !== void 0) {
    throw new Error("oidcConfig parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(authConfigToMldev, "authConfigToMldev");
function blobToMldev(fromObject) {
  const toObject = {};
  const fromData = getValueByPath(fromObject, ["data"]);
  if (fromData != null) {
    setValueByPath(toObject, ["data"], fromData);
  }
  if (getValueByPath(fromObject, ["displayName"]) !== void 0) {
    throw new Error("displayName parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromMimeType = getValueByPath(fromObject, ["mimeType"]);
  if (fromMimeType != null) {
    setValueByPath(toObject, ["mimeType"], fromMimeType);
  }
  return toObject;
}
__name(blobToMldev, "blobToMldev");
function contentToMldev(fromObject) {
  const toObject = {};
  const fromParts = getValueByPath(fromObject, ["parts"]);
  if (fromParts != null) {
    let transformedList = fromParts;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return partToMldev(item);
      });
    }
    setValueByPath(toObject, ["parts"], transformedList);
  }
  const fromRole = getValueByPath(fromObject, ["role"]);
  if (fromRole != null) {
    setValueByPath(toObject, ["role"], fromRole);
  }
  return toObject;
}
__name(contentToMldev, "contentToMldev");
function createAuthTokenConfigToMldev(apiClient, fromObject, parentObject) {
  const toObject = {};
  const fromExpireTime = getValueByPath(fromObject, ["expireTime"]);
  if (parentObject !== void 0 && fromExpireTime != null) {
    setValueByPath(parentObject, ["expireTime"], fromExpireTime);
  }
  const fromNewSessionExpireTime = getValueByPath(fromObject, [
    "newSessionExpireTime"
  ]);
  if (parentObject !== void 0 && fromNewSessionExpireTime != null) {
    setValueByPath(parentObject, ["newSessionExpireTime"], fromNewSessionExpireTime);
  }
  const fromUses = getValueByPath(fromObject, ["uses"]);
  if (parentObject !== void 0 && fromUses != null) {
    setValueByPath(parentObject, ["uses"], fromUses);
  }
  const fromLiveConnectConstraints = getValueByPath(fromObject, [
    "liveConnectConstraints"
  ]);
  if (parentObject !== void 0 && fromLiveConnectConstraints != null) {
    setValueByPath(parentObject, ["bidiGenerateContentSetup"], liveConnectConstraintsToMldev(apiClient, fromLiveConnectConstraints));
  }
  const fromLockAdditionalFields = getValueByPath(fromObject, [
    "lockAdditionalFields"
  ]);
  if (parentObject !== void 0 && fromLockAdditionalFields != null) {
    setValueByPath(parentObject, ["fieldMask"], fromLockAdditionalFields);
  }
  return toObject;
}
__name(createAuthTokenConfigToMldev, "createAuthTokenConfigToMldev");
function createAuthTokenParametersToMldev(apiClient, fromObject) {
  const toObject = {};
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    setValueByPath(toObject, ["config"], createAuthTokenConfigToMldev(apiClient, fromConfig, toObject));
  }
  return toObject;
}
__name(createAuthTokenParametersToMldev, "createAuthTokenParametersToMldev");
function fileDataToMldev(fromObject) {
  const toObject = {};
  if (getValueByPath(fromObject, ["displayName"]) !== void 0) {
    throw new Error("displayName parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromFileUri = getValueByPath(fromObject, ["fileUri"]);
  if (fromFileUri != null) {
    setValueByPath(toObject, ["fileUri"], fromFileUri);
  }
  const fromMimeType = getValueByPath(fromObject, ["mimeType"]);
  if (fromMimeType != null) {
    setValueByPath(toObject, ["mimeType"], fromMimeType);
  }
  return toObject;
}
__name(fileDataToMldev, "fileDataToMldev");
function functionCallToMldev(fromObject) {
  const toObject = {};
  const fromId = getValueByPath(fromObject, ["id"]);
  if (fromId != null) {
    setValueByPath(toObject, ["id"], fromId);
  }
  const fromArgs = getValueByPath(fromObject, ["args"]);
  if (fromArgs != null) {
    setValueByPath(toObject, ["args"], fromArgs);
  }
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["name"], fromName);
  }
  if (getValueByPath(fromObject, ["partialArgs"]) !== void 0) {
    throw new Error("partialArgs parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["willContinue"]) !== void 0) {
    throw new Error("willContinue parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(functionCallToMldev, "functionCallToMldev");
function googleMapsToMldev(fromObject) {
  const toObject = {};
  const fromAuthConfig = getValueByPath(fromObject, ["authConfig"]);
  if (fromAuthConfig != null) {
    setValueByPath(toObject, ["authConfig"], authConfigToMldev(fromAuthConfig));
  }
  const fromEnableWidget = getValueByPath(fromObject, ["enableWidget"]);
  if (fromEnableWidget != null) {
    setValueByPath(toObject, ["enableWidget"], fromEnableWidget);
  }
  return toObject;
}
__name(googleMapsToMldev, "googleMapsToMldev");
function googleSearchToMldev(fromObject) {
  const toObject = {};
  const fromSearchTypes = getValueByPath(fromObject, ["searchTypes"]);
  if (fromSearchTypes != null) {
    setValueByPath(toObject, ["searchTypes"], fromSearchTypes);
  }
  if (getValueByPath(fromObject, ["blockingConfidence"]) !== void 0) {
    throw new Error("blockingConfidence parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["excludeDomains"]) !== void 0) {
    throw new Error("excludeDomains parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromTimeRangeFilter = getValueByPath(fromObject, [
    "timeRangeFilter"
  ]);
  if (fromTimeRangeFilter != null) {
    setValueByPath(toObject, ["timeRangeFilter"], fromTimeRangeFilter);
  }
  return toObject;
}
__name(googleSearchToMldev, "googleSearchToMldev");
function liveConnectConfigToMldev(fromObject, parentObject) {
  const toObject = {};
  const fromGenerationConfig = getValueByPath(fromObject, [
    "generationConfig"
  ]);
  if (parentObject !== void 0 && fromGenerationConfig != null) {
    setValueByPath(parentObject, ["setup", "generationConfig"], fromGenerationConfig);
  }
  const fromResponseModalities = getValueByPath(fromObject, [
    "responseModalities"
  ]);
  if (parentObject !== void 0 && fromResponseModalities != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "responseModalities"], fromResponseModalities);
  }
  const fromTemperature = getValueByPath(fromObject, ["temperature"]);
  if (parentObject !== void 0 && fromTemperature != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "temperature"], fromTemperature);
  }
  const fromTopP = getValueByPath(fromObject, ["topP"]);
  if (parentObject !== void 0 && fromTopP != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "topP"], fromTopP);
  }
  const fromTopK = getValueByPath(fromObject, ["topK"]);
  if (parentObject !== void 0 && fromTopK != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "topK"], fromTopK);
  }
  const fromMaxOutputTokens = getValueByPath(fromObject, [
    "maxOutputTokens"
  ]);
  if (parentObject !== void 0 && fromMaxOutputTokens != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "maxOutputTokens"], fromMaxOutputTokens);
  }
  const fromMediaResolution = getValueByPath(fromObject, [
    "mediaResolution"
  ]);
  if (parentObject !== void 0 && fromMediaResolution != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "mediaResolution"], fromMediaResolution);
  }
  const fromSeed = getValueByPath(fromObject, ["seed"]);
  if (parentObject !== void 0 && fromSeed != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "seed"], fromSeed);
  }
  const fromSpeechConfig = getValueByPath(fromObject, ["speechConfig"]);
  if (parentObject !== void 0 && fromSpeechConfig != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "speechConfig"], tLiveSpeechConfig(fromSpeechConfig));
  }
  const fromThinkingConfig = getValueByPath(fromObject, [
    "thinkingConfig"
  ]);
  if (parentObject !== void 0 && fromThinkingConfig != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "thinkingConfig"], fromThinkingConfig);
  }
  const fromEnableAffectiveDialog = getValueByPath(fromObject, [
    "enableAffectiveDialog"
  ]);
  if (parentObject !== void 0 && fromEnableAffectiveDialog != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "enableAffectiveDialog"], fromEnableAffectiveDialog);
  }
  const fromSystemInstruction = getValueByPath(fromObject, [
    "systemInstruction"
  ]);
  if (parentObject !== void 0 && fromSystemInstruction != null) {
    setValueByPath(parentObject, ["setup", "systemInstruction"], contentToMldev(tContent(fromSystemInstruction)));
  }
  const fromTools = getValueByPath(fromObject, ["tools"]);
  if (parentObject !== void 0 && fromTools != null) {
    let transformedList = tTools(fromTools);
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return toolToMldev(tTool(item));
      });
    }
    setValueByPath(parentObject, ["setup", "tools"], transformedList);
  }
  const fromSessionResumption = getValueByPath(fromObject, [
    "sessionResumption"
  ]);
  if (parentObject !== void 0 && fromSessionResumption != null) {
    setValueByPath(parentObject, ["setup", "sessionResumption"], sessionResumptionConfigToMldev(fromSessionResumption));
  }
  const fromInputAudioTranscription = getValueByPath(fromObject, [
    "inputAudioTranscription"
  ]);
  if (parentObject !== void 0 && fromInputAudioTranscription != null) {
    setValueByPath(parentObject, ["setup", "inputAudioTranscription"], audioTranscriptionConfigToMldev(fromInputAudioTranscription));
  }
  const fromOutputAudioTranscription = getValueByPath(fromObject, [
    "outputAudioTranscription"
  ]);
  if (parentObject !== void 0 && fromOutputAudioTranscription != null) {
    setValueByPath(parentObject, ["setup", "outputAudioTranscription"], audioTranscriptionConfigToMldev(fromOutputAudioTranscription));
  }
  const fromRealtimeInputConfig = getValueByPath(fromObject, [
    "realtimeInputConfig"
  ]);
  if (parentObject !== void 0 && fromRealtimeInputConfig != null) {
    setValueByPath(parentObject, ["setup", "realtimeInputConfig"], fromRealtimeInputConfig);
  }
  const fromContextWindowCompression = getValueByPath(fromObject, [
    "contextWindowCompression"
  ]);
  if (parentObject !== void 0 && fromContextWindowCompression != null) {
    setValueByPath(parentObject, ["setup", "contextWindowCompression"], fromContextWindowCompression);
  }
  const fromProactivity = getValueByPath(fromObject, ["proactivity"]);
  if (parentObject !== void 0 && fromProactivity != null) {
    setValueByPath(parentObject, ["setup", "proactivity"], fromProactivity);
  }
  if (getValueByPath(fromObject, ["explicitVadSignal"]) !== void 0) {
    throw new Error("explicitVadSignal parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromAvatarConfig = getValueByPath(fromObject, ["avatarConfig"]);
  if (parentObject !== void 0 && fromAvatarConfig != null) {
    setValueByPath(parentObject, ["setup", "avatarConfig"], fromAvatarConfig);
  }
  const fromSafetySettings = getValueByPath(fromObject, [
    "safetySettings"
  ]);
  if (parentObject !== void 0 && fromSafetySettings != null) {
    let transformedList = fromSafetySettings;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return safetySettingToMldev(item);
      });
    }
    setValueByPath(parentObject, ["setup", "safetySettings"], transformedList);
  }
  const fromStreamTranslationConfig = getValueByPath(fromObject, [
    "streamTranslationConfig"
  ]);
  if (parentObject !== void 0 && fromStreamTranslationConfig != null) {
    setValueByPath(parentObject, ["setup", "generationConfig", "streamTranslationConfig"], fromStreamTranslationConfig);
  }
  return toObject;
}
__name(liveConnectConfigToMldev, "liveConnectConfigToMldev");
function liveConnectConstraintsToMldev(apiClient, fromObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["model"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["setup", "model"], tModel(apiClient, fromModel));
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    setValueByPath(toObject, ["config"], liveConnectConfigToMldev(fromConfig, toObject));
  }
  return toObject;
}
__name(liveConnectConstraintsToMldev, "liveConnectConstraintsToMldev");
function partToMldev(fromObject) {
  const toObject = {};
  const fromMediaResolution = getValueByPath(fromObject, [
    "mediaResolution"
  ]);
  if (fromMediaResolution != null) {
    setValueByPath(toObject, ["mediaResolution"], fromMediaResolution);
  }
  const fromCodeExecutionResult = getValueByPath(fromObject, [
    "codeExecutionResult"
  ]);
  if (fromCodeExecutionResult != null) {
    setValueByPath(toObject, ["codeExecutionResult"], fromCodeExecutionResult);
  }
  const fromExecutableCode = getValueByPath(fromObject, [
    "executableCode"
  ]);
  if (fromExecutableCode != null) {
    setValueByPath(toObject, ["executableCode"], fromExecutableCode);
  }
  const fromFileData = getValueByPath(fromObject, ["fileData"]);
  if (fromFileData != null) {
    setValueByPath(toObject, ["fileData"], fileDataToMldev(fromFileData));
  }
  const fromFunctionCall = getValueByPath(fromObject, ["functionCall"]);
  if (fromFunctionCall != null) {
    setValueByPath(toObject, ["functionCall"], functionCallToMldev(fromFunctionCall));
  }
  const fromFunctionResponse = getValueByPath(fromObject, [
    "functionResponse"
  ]);
  if (fromFunctionResponse != null) {
    setValueByPath(toObject, ["functionResponse"], fromFunctionResponse);
  }
  const fromInlineData = getValueByPath(fromObject, ["inlineData"]);
  if (fromInlineData != null) {
    setValueByPath(toObject, ["inlineData"], blobToMldev(fromInlineData));
  }
  const fromText = getValueByPath(fromObject, ["text"]);
  if (fromText != null) {
    setValueByPath(toObject, ["text"], fromText);
  }
  const fromThought = getValueByPath(fromObject, ["thought"]);
  if (fromThought != null) {
    setValueByPath(toObject, ["thought"], fromThought);
  }
  const fromThoughtSignature = getValueByPath(fromObject, [
    "thoughtSignature"
  ]);
  if (fromThoughtSignature != null) {
    setValueByPath(toObject, ["thoughtSignature"], fromThoughtSignature);
  }
  const fromVideoMetadata = getValueByPath(fromObject, [
    "videoMetadata"
  ]);
  if (fromVideoMetadata != null) {
    setValueByPath(toObject, ["videoMetadata"], fromVideoMetadata);
  }
  const fromToolCall = getValueByPath(fromObject, ["toolCall"]);
  if (fromToolCall != null) {
    setValueByPath(toObject, ["toolCall"], fromToolCall);
  }
  const fromToolResponse = getValueByPath(fromObject, ["toolResponse"]);
  if (fromToolResponse != null) {
    setValueByPath(toObject, ["toolResponse"], fromToolResponse);
  }
  const fromPartMetadata = getValueByPath(fromObject, ["partMetadata"]);
  if (fromPartMetadata != null) {
    setValueByPath(toObject, ["partMetadata"], fromPartMetadata);
  }
  return toObject;
}
__name(partToMldev, "partToMldev");
function safetySettingToMldev(fromObject) {
  const toObject = {};
  const fromCategory = getValueByPath(fromObject, ["category"]);
  if (fromCategory != null) {
    setValueByPath(toObject, ["category"], fromCategory);
  }
  if (getValueByPath(fromObject, ["method"]) !== void 0) {
    throw new Error("method parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromThreshold = getValueByPath(fromObject, ["threshold"]);
  if (fromThreshold != null) {
    setValueByPath(toObject, ["threshold"], fromThreshold);
  }
  return toObject;
}
__name(safetySettingToMldev, "safetySettingToMldev");
function sessionResumptionConfigToMldev(fromObject) {
  const toObject = {};
  const fromHandle = getValueByPath(fromObject, ["handle"]);
  if (fromHandle != null) {
    setValueByPath(toObject, ["handle"], fromHandle);
  }
  if (getValueByPath(fromObject, ["transparent"]) !== void 0) {
    throw new Error("transparent parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(sessionResumptionConfigToMldev, "sessionResumptionConfigToMldev");
function toolToMldev(fromObject) {
  const toObject = {};
  if (getValueByPath(fromObject, ["retrieval"]) !== void 0) {
    throw new Error("retrieval parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromComputerUse = getValueByPath(fromObject, ["computerUse"]);
  if (fromComputerUse != null) {
    setValueByPath(toObject, ["computerUse"], fromComputerUse);
  }
  const fromFileSearch = getValueByPath(fromObject, ["fileSearch"]);
  if (fromFileSearch != null) {
    setValueByPath(toObject, ["fileSearch"], fromFileSearch);
  }
  const fromGoogleSearch = getValueByPath(fromObject, ["googleSearch"]);
  if (fromGoogleSearch != null) {
    setValueByPath(toObject, ["googleSearch"], googleSearchToMldev(fromGoogleSearch));
  }
  const fromGoogleMaps = getValueByPath(fromObject, ["googleMaps"]);
  if (fromGoogleMaps != null) {
    setValueByPath(toObject, ["googleMaps"], googleMapsToMldev(fromGoogleMaps));
  }
  const fromCodeExecution = getValueByPath(fromObject, [
    "codeExecution"
  ]);
  if (fromCodeExecution != null) {
    setValueByPath(toObject, ["codeExecution"], fromCodeExecution);
  }
  if (getValueByPath(fromObject, ["enterpriseWebSearch"]) !== void 0) {
    throw new Error("enterpriseWebSearch parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromFunctionDeclarations = getValueByPath(fromObject, [
    "functionDeclarations"
  ]);
  if (fromFunctionDeclarations != null) {
    let transformedList = fromFunctionDeclarations;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["functionDeclarations"], transformedList);
  }
  const fromGoogleSearchRetrieval = getValueByPath(fromObject, [
    "googleSearchRetrieval"
  ]);
  if (fromGoogleSearchRetrieval != null) {
    setValueByPath(toObject, ["googleSearchRetrieval"], fromGoogleSearchRetrieval);
  }
  if (getValueByPath(fromObject, ["parallelAiSearch"]) !== void 0) {
    throw new Error("parallelAiSearch parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromUrlContext = getValueByPath(fromObject, ["urlContext"]);
  if (fromUrlContext != null) {
    setValueByPath(toObject, ["urlContext"], fromUrlContext);
  }
  const fromMcpServers = getValueByPath(fromObject, ["mcpServers"]);
  if (fromMcpServers != null) {
    let transformedList = fromMcpServers;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["mcpServers"], transformedList);
  }
  return toObject;
}
__name(toolToMldev, "toolToMldev");
function getFieldMasks(setup) {
  const fields = [];
  for (const key in setup) {
    if (Object.prototype.hasOwnProperty.call(setup, key)) {
      const value = setup[key];
      if (typeof value === "object" && value != null && Object.keys(value).length > 0) {
        const field = Object.keys(value).map((kk) => `${key}.${kk}`);
        fields.push(...field);
      } else {
        fields.push(key);
      }
    }
  }
  return fields.join(",");
}
__name(getFieldMasks, "getFieldMasks");
function convertBidiSetupToTokenSetup(requestDict, config) {
  let setupForMaskGeneration = null;
  const bidiGenerateContentSetupValue = requestDict["bidiGenerateContentSetup"];
  if (typeof bidiGenerateContentSetupValue === "object" && bidiGenerateContentSetupValue !== null && "setup" in bidiGenerateContentSetupValue) {
    const innerSetup = bidiGenerateContentSetupValue.setup;
    if (typeof innerSetup === "object" && innerSetup !== null) {
      requestDict["bidiGenerateContentSetup"] = innerSetup;
      setupForMaskGeneration = innerSetup;
    } else {
      delete requestDict["bidiGenerateContentSetup"];
    }
  } else if (bidiGenerateContentSetupValue !== void 0) {
    delete requestDict["bidiGenerateContentSetup"];
  }
  const preExistingFieldMask = requestDict["fieldMask"];
  if (setupForMaskGeneration) {
    const generatedMaskFromBidi = getFieldMasks(setupForMaskGeneration);
    if (Array.isArray(config === null || config === void 0 ? void 0 : config.lockAdditionalFields) && (config === null || config === void 0 ? void 0 : config.lockAdditionalFields.length) === 0) {
      if (generatedMaskFromBidi) {
        requestDict["fieldMask"] = generatedMaskFromBidi;
      } else {
        delete requestDict["fieldMask"];
      }
    } else if ((config === null || config === void 0 ? void 0 : config.lockAdditionalFields) && config.lockAdditionalFields.length > 0 && preExistingFieldMask !== null && Array.isArray(preExistingFieldMask) && preExistingFieldMask.length > 0) {
      const generationConfigFields = [
        "temperature",
        "topK",
        "topP",
        "maxOutputTokens",
        "responseModalities",
        "seed",
        "speechConfig"
      ];
      let mappedFieldsFromPreExisting = [];
      if (preExistingFieldMask.length > 0) {
        mappedFieldsFromPreExisting = preExistingFieldMask.map((field) => {
          if (generationConfigFields.includes(field)) {
            return `generationConfig.${field}`;
          }
          return field;
        });
      }
      const finalMaskParts = [];
      if (generatedMaskFromBidi) {
        finalMaskParts.push(generatedMaskFromBidi);
      }
      if (mappedFieldsFromPreExisting.length > 0) {
        finalMaskParts.push(...mappedFieldsFromPreExisting);
      }
      if (finalMaskParts.length > 0) {
        requestDict["fieldMask"] = finalMaskParts.join(",");
      } else {
        delete requestDict["fieldMask"];
      }
    } else {
      delete requestDict["fieldMask"];
    }
  } else {
    if (preExistingFieldMask !== null && Array.isArray(preExistingFieldMask) && preExistingFieldMask.length > 0) {
      requestDict["fieldMask"] = preExistingFieldMask.join(",");
    } else {
      delete requestDict["fieldMask"];
    }
  }
  return requestDict;
}
__name(convertBidiSetupToTokenSetup, "convertBidiSetupToTokenSetup");
var Tokens = class extends BaseModule {
  static {
    __name(this, "Tokens");
  }
  constructor(apiClient) {
    super();
    this.apiClient = apiClient;
  }
  /**
   * Creates an ephemeral auth token resource.
   *
   * @experimental
   *
   * @remarks
   * Ephemeral auth tokens is only supported in the Gemini Developer API.
   * It can be used for the session connection to the Live constrained API.
   * Support in v1alpha only.
   *
   * @param params - The parameters for the create request.
   * @return The created auth token.
   *
   * @example
   * ```ts
   * const ai = new GoogleGenAI({
   *     apiKey: token.name,
   *     httpOptions: { apiVersion: 'v1alpha' }  // Support in v1alpha only.
   * });
   *
   * // Case 1: If LiveEphemeralParameters is unset, unlock LiveConnectConfig
   * // when using the token in Live API sessions. Each session connection can
   * // use a different configuration.
   * const config: CreateAuthTokenConfig = {
   *     uses: 3,
   *     expireTime: '2025-05-01T00:00:00Z',
   * }
   * const token = await ai.tokens.create(config);
   *
   * // Case 2: If LiveEphemeralParameters is set, lock all fields in
   * // LiveConnectConfig when using the token in Live API sessions. For
   * // example, changing `outputAudioTranscription` in the Live API
   * // connection will be ignored by the API.
   * const config: CreateAuthTokenConfig =
   *     uses: 3,
   *     expireTime: '2025-05-01T00:00:00Z',
   *     LiveEphemeralParameters: {
   *        model: 'gemini-2.0-flash-001',
   *        config: {
   *           'responseModalities': ['AUDIO'],
   *           'systemInstruction': 'Always answer in English.',
   *        }
   *     }
   * }
   * const token = await ai.tokens.create(config);
   *
   * // Case 3: If LiveEphemeralParameters is set and lockAdditionalFields is
   * // set, lock LiveConnectConfig with set and additional fields (e.g.
   * // responseModalities, systemInstruction, temperature in this example) when
   * // using the token in Live API sessions.
   * const config: CreateAuthTokenConfig =
   *     uses: 3,
   *     expireTime: '2025-05-01T00:00:00Z',
   *     LiveEphemeralParameters: {
   *        model: 'gemini-2.0-flash-001',
   *        config: {
   *           'responseModalities': ['AUDIO'],
   *           'systemInstruction': 'Always answer in English.',
   *        }
   *     },
   *     lockAdditionalFields: ['temperature'],
   * }
   * const token = await ai.tokens.create(config);
   *
   * // Case 4: If LiveEphemeralParameters is set and lockAdditionalFields is
   * // empty array, lock LiveConnectConfig with set fields (e.g.
   * // responseModalities, systemInstruction in this example) when using the
   * // token in Live API sessions.
   * const config: CreateAuthTokenConfig =
   *     uses: 3,
   *     expireTime: '2025-05-01T00:00:00Z',
   *     LiveEphemeralParameters: {
   *        model: 'gemini-2.0-flash-001',
   *        config: {
   *           'responseModalities': ['AUDIO'],
   *           'systemInstruction': 'Always answer in English.',
   *        }
   *     },
   *     lockAdditionalFields: [],
   * }
   * const token = await ai.tokens.create(config);
   * ```
   */
  async create(params) {
    var _a2, _b;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      throw new Error("The client.tokens.create method is only supported by the Gemini Developer API.");
    } else {
      const body = createAuthTokenParametersToMldev(this.apiClient, params);
      path2 = formatMap("auth_tokens", body["_url"]);
      queryParams = body["_query"];
      delete body["config"];
      delete body["_url"];
      delete body["_query"];
      const transformedBody = convertBidiSetupToTokenSetup(body, params.config);
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(transformedBody),
        httpMethod: "POST",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((resp) => {
        return resp;
      });
    }
  }
};
function deleteDocumentConfigToMldev(fromObject, parentObject) {
  const toObject = {};
  const fromForce = getValueByPath(fromObject, ["force"]);
  if (parentObject !== void 0 && fromForce != null) {
    setValueByPath(parentObject, ["_query", "force"], fromForce);
  }
  return toObject;
}
__name(deleteDocumentConfigToMldev, "deleteDocumentConfigToMldev");
function deleteDocumentParametersToMldev(fromObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["_url", "name"], fromName);
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    deleteDocumentConfigToMldev(fromConfig, toObject);
  }
  return toObject;
}
__name(deleteDocumentParametersToMldev, "deleteDocumentParametersToMldev");
function getDocumentParametersToMldev(fromObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["_url", "name"], fromName);
  }
  return toObject;
}
__name(getDocumentParametersToMldev, "getDocumentParametersToMldev");
function listDocumentsConfigToMldev(fromObject, parentObject) {
  const toObject = {};
  const fromPageSize = getValueByPath(fromObject, ["pageSize"]);
  if (parentObject !== void 0 && fromPageSize != null) {
    setValueByPath(parentObject, ["_query", "pageSize"], fromPageSize);
  }
  const fromPageToken = getValueByPath(fromObject, ["pageToken"]);
  if (parentObject !== void 0 && fromPageToken != null) {
    setValueByPath(parentObject, ["_query", "pageToken"], fromPageToken);
  }
  return toObject;
}
__name(listDocumentsConfigToMldev, "listDocumentsConfigToMldev");
function listDocumentsParametersToMldev(fromObject) {
  const toObject = {};
  const fromParent = getValueByPath(fromObject, ["parent"]);
  if (fromParent != null) {
    setValueByPath(toObject, ["_url", "parent"], fromParent);
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    listDocumentsConfigToMldev(fromConfig, toObject);
  }
  return toObject;
}
__name(listDocumentsParametersToMldev, "listDocumentsParametersToMldev");
function listDocumentsResponseFromMldev(fromObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromNextPageToken = getValueByPath(fromObject, [
    "nextPageToken"
  ]);
  if (fromNextPageToken != null) {
    setValueByPath(toObject, ["nextPageToken"], fromNextPageToken);
  }
  const fromDocuments = getValueByPath(fromObject, ["documents"]);
  if (fromDocuments != null) {
    let transformedList = fromDocuments;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["documents"], transformedList);
  }
  return toObject;
}
__name(listDocumentsResponseFromMldev, "listDocumentsResponseFromMldev");
var Documents = class extends BaseModule {
  static {
    __name(this, "Documents");
  }
  constructor(apiClient) {
    super();
    this.apiClient = apiClient;
    this.list = async (params) => {
      return new Pager(PagedItem.PAGED_ITEM_DOCUMENTS, (x) => this.listInternal({ parent: params.parent, config: x.config }), await this.listInternal(params), params);
    };
  }
  /**
   * Gets a Document.
   *
   * @param params - The parameters for getting a document.
   * @return Document.
   */
  async get(params) {
    var _a2, _b;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      throw new Error("This method is only supported by the Gemini Developer API.");
    } else {
      const body = getDocumentParametersToMldev(params);
      path2 = formatMap("{name}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "GET",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((resp) => {
        return resp;
      });
    }
  }
  /**
   * Deletes a Document.
   *
   * @param params - The parameters for deleting a document.
   */
  async delete(params) {
    var _a2, _b;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      throw new Error("This method is only supported by the Gemini Developer API.");
    } else {
      const body = deleteDocumentParametersToMldev(params);
      path2 = formatMap("{name}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      await this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "DELETE",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      });
    }
  }
  async listInternal(params) {
    var _a2, _b;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      throw new Error("This method is only supported by the Gemini Developer API.");
    } else {
      const body = listDocumentsParametersToMldev(params);
      path2 = formatMap("{parent}/documents", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "GET",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((apiResponse) => {
        const resp = listDocumentsResponseFromMldev(apiResponse);
        const typedResp = new ListDocumentsResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    }
  }
};
var FileSearchStores = class extends BaseModule {
  static {
    __name(this, "FileSearchStores");
  }
  constructor(apiClient, documents = new Documents(apiClient)) {
    super();
    this.apiClient = apiClient;
    this.documents = documents;
    this.list = async (params = {}) => {
      return new Pager(PagedItem.PAGED_ITEM_FILE_SEARCH_STORES, (x) => this.listInternal(x), await this.listInternal(params), params);
    };
  }
  /**
   * Uploads a file asynchronously to a given File Search Store.
   * This method is not available in Gemini Enterprise Agent Platform (previously known as Vertex AI).
   * Supported upload sources:
   * - Node.js: File path (string) or Blob object.
   * - Browser: Blob object (e.g., File).
   *
   * @remarks
   * The `mimeType` can be specified in the `config` parameter. If omitted:
   *  - For file path (string) inputs, the `mimeType` will be inferred from the
   *     file extension.
   *  - For Blob object inputs, the `mimeType` will be set to the Blob's `type`
   *     property.
   *
   * This section can contain multiple paragraphs and code examples.
   *
   * @param params - Optional parameters specified in the
   *        `types.UploadToFileSearchStoreParameters` interface.
   *         @see {@link types.UploadToFileSearchStoreParameters#config} for the optional
   *         config in the parameters.
   * @return A promise that resolves to a long running operation.
   * @throws An error if called on a Gemini Enterprise Agent Platform (previously known as Vertex AI) client.
   * @throws An error if the `mimeType` is not provided and can not be inferred,
   * the `mimeType` can be provided in the `params.config` parameter.
   * @throws An error occurs if a suitable upload location cannot be established.
   *
   * @example
   * The following code uploads a file to a given file search store.
   *
   * ```ts
   * const operation = await ai.fileSearchStores.upload({fileSearchStoreName: 'fileSearchStores/foo-bar', file: 'file.txt', config: {
   *   mimeType: 'text/plain',
   * }});
   * console.log(operation.name);
   * ```
   */
  async uploadToFileSearchStore(params) {
    if (this.apiClient.isVertexAI()) {
      throw new Error("Gemini Enterprise Agent Platform (previously known as Vertex AI) does not support uploading files to a file search store.");
    }
    return this.apiClient.uploadFileToFileSearchStore(params.fileSearchStoreName, params.file, params.config);
  }
  /**
   * Downloads media using a Media ID or URI.
   * This method is only supported in the Gemini Developer client.
   *
   * @param uri - The URI or Media ID of the blob.
   * @param config - Optional configuration for the download.
   * @returns A promise that resolves to the blob data as a Uint8Array.
   */
  async downloadMedia(uri, config) {
    if (this.apiClient.isVertexAI()) {
      throw new Error("This method is only supported in the Gemini Developer client.");
    }
    const parsedUri = new URL(uri, "http://dummy.com");
    let pathname = parsedUri.pathname;
    if (pathname.startsWith("/")) {
      pathname = pathname.slice(1);
    }
    if (!pathname.includes("/media/")) {
      throw new Error(`Invalid uri format: ${uri}. Expected to contain /media/`);
    }
    const queryParams = {};
    parsedUri.searchParams.forEach((value, key) => {
      queryParams[key] = value;
    });
    queryParams["alt"] = "media";
    const httpOptions = Object.assign({}, config === null || config === void 0 ? void 0 : config.httpOptions);
    const response = await this.apiClient.request({
      path: pathname,
      httpMethod: "GET",
      queryParams,
      httpOptions
    });
    if (response instanceof HttpResponse) {
      const arrayBuffer = await response.responseInternal.arrayBuffer();
      return new Uint8Array(arrayBuffer);
    } else {
      throw new Error("Unexpected response type from downloadMedia");
    }
  }
  /**
   * Creates a File Search Store.
   *
   * @param params - The parameters for creating a File Search Store.
   * @return FileSearchStore.
   */
  async create(params) {
    var _a2, _b;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      throw new Error("This method is only supported by the Gemini Developer API.");
    } else {
      const body = createFileSearchStoreParametersToMldev(this.apiClient, params);
      path2 = formatMap("fileSearchStores", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((resp) => {
        return resp;
      });
    }
  }
  /**
   * Gets a File Search Store.
   *
   * @param params - The parameters for getting a File Search Store.
   * @return FileSearchStore.
   */
  async get(params) {
    var _a2, _b;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      throw new Error("This method is only supported by the Gemini Developer API.");
    } else {
      const body = getFileSearchStoreParametersToMldev(params);
      path2 = formatMap("{name}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "GET",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((resp) => {
        return resp;
      });
    }
  }
  /**
   * Deletes a File Search Store.
   *
   * @param params - The parameters for deleting a File Search Store.
   */
  async delete(params) {
    var _a2, _b;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      throw new Error("This method is only supported by the Gemini Developer API.");
    } else {
      const body = deleteFileSearchStoreParametersToMldev(params);
      path2 = formatMap("{name}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      await this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "DELETE",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      });
    }
  }
  async listInternal(params) {
    var _a2, _b;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      throw new Error("This method is only supported by the Gemini Developer API.");
    } else {
      const body = listFileSearchStoresParametersToMldev(params);
      path2 = formatMap("fileSearchStores", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "GET",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((apiResponse) => {
        const resp = listFileSearchStoresResponseFromMldev(apiResponse);
        const typedResp = new ListFileSearchStoresResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    }
  }
  async uploadToFileSearchStoreInternal(params) {
    var _a2, _b;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      throw new Error("This method is only supported by the Gemini Developer API.");
    } else {
      const body = uploadToFileSearchStoreParametersToMldev(params);
      path2 = formatMap("upload/v1beta/{file_search_store_name}:uploadToFileSearchStore", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((apiResponse) => {
        const resp = uploadToFileSearchStoreResumableResponseFromMldev(apiResponse);
        const typedResp = new UploadToFileSearchStoreResumableResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    }
  }
  /**
   * Imports a File from File Service to a FileSearchStore.
   *
   * This is a long-running operation, see aip.dev/151
   *
   * @param params - The parameters for importing a file to a file search store.
   * @return ImportFileOperation.
   */
  async importFile(params) {
    var _a2, _b;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      throw new Error("This method is only supported by the Gemini Developer API.");
    } else {
      const body = importFileParametersToMldev(params);
      path2 = formatMap("{file_search_store_name}:importFile", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json();
      });
      return response.then((apiResponse) => {
        const resp = importFileOperationFromMldev(apiResponse);
        const typedResp = new ImportFileOperation();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    }
  }
};
var uuid4Internal = /* @__PURE__ */ __name(function() {
  const { crypto } = globalThis;
  if (crypto === null || crypto === void 0 ? void 0 : crypto.randomUUID) {
    uuid4Internal = crypto.randomUUID.bind(crypto);
    return crypto.randomUUID();
  }
  const u8 = new Uint8Array(1);
  const randomByte = crypto ? () => crypto.getRandomValues(u8)[0] : () => Math.random() * 255 & 255;
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (+c ^ randomByte() & 15 >> +c / 4).toString(16));
}, "uuid4Internal");
var uuid4 = /* @__PURE__ */ __name(() => uuid4Internal(), "uuid4");
function isAbortError(err) {
  return typeof err === "object" && err !== null && // Spec-compliant fetch implementations
  ("name" in err && err.name === "AbortError" || // Expo fetch
  "message" in err && String(err.message).includes("FetchRequestCanceledException"));
}
__name(isAbortError, "isAbortError");
var castToError = /* @__PURE__ */ __name((err) => {
  if (err instanceof Error)
    return err;
  if (typeof err === "object" && err !== null) {
    try {
      if (Object.prototype.toString.call(err) === "[object Error]") {
        const error = new Error(err.message, err.cause ? { cause: err.cause } : {});
        if (err.stack)
          error.stack = err.stack;
        if (err.cause && !error.cause)
          error.cause = err.cause;
        if (err.name)
          error.name = err.name;
        return error;
      }
    } catch (_a2) {
    }
    try {
      return new Error(JSON.stringify(err));
    } catch (_b) {
    }
  }
  return new Error(err);
}, "castToError");
var GeminiNextGenAPIClientError = class extends Error {
  static {
    __name(this, "GeminiNextGenAPIClientError");
  }
};
var APIError = class _APIError extends GeminiNextGenAPIClientError {
  static {
    __name(this, "APIError");
  }
  constructor(status, error, message, headers) {
    super(`${_APIError.makeMessage(status, error, message)}`);
    this.status = status;
    this.headers = headers;
    this.error = error;
  }
  static makeMessage(status, error, message) {
    const msg = (error === null || error === void 0 ? void 0 : error.message) ? typeof error.message === "string" ? error.message : JSON.stringify(error.message) : error ? JSON.stringify(error) : message;
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
    super({
      message: message !== null && message !== void 0 ? message : "Request timed out. This is a client-side timeout. You can increase the timeout by setting the `timeout` argument in your request or client http options."
    });
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
var startsWithSchemeRegexp = /^[a-z][a-z0-9+.-]*:/i;
var isAbsoluteURL = /* @__PURE__ */ __name((url) => {
  return startsWithSchemeRegexp.test(url);
}, "isAbsoluteURL");
var isArrayInternal = /* @__PURE__ */ __name((val) => (isArrayInternal = Array.isArray, isArrayInternal(val)), "isArrayInternal");
var isArray = isArrayInternal;
var isReadonlyArrayInternal = isArray;
var isReadonlyArray = isReadonlyArrayInternal;
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
var validatePositiveInteger = /* @__PURE__ */ __name((name, n) => {
  if (typeof n !== "number" || !Number.isInteger(n)) {
    throw new GeminiNextGenAPIClientError(`${name} must be an integer`);
  }
  if (n < 0) {
    throw new GeminiNextGenAPIClientError(`${name} must be a positive integer`);
  }
  return n;
}, "validatePositiveInteger");
var safeJSON = /* @__PURE__ */ __name((text) => {
  try {
    return JSON.parse(text);
  } catch (err) {
    return void 0;
  }
}, "safeJSON");
var sleep$1 = /* @__PURE__ */ __name((ms) => new Promise((resolve) => setTimeout(resolve, ms)), "sleep$1");
function getDefaultFetch() {
  if (typeof fetch !== "undefined") {
    return fetch;
  }
  throw new Error("`fetch` is not defined as a global; Either pass `fetch` to the client, `new GeminiNextGenAPIClient({ fetch })` or polyfill the global, `globalThis.fetch = fetch`");
}
__name(getDefaultFetch, "getDefaultFetch");
function makeReadableStream(...args) {
  const ReadableStream = globalThis.ReadableStream;
  if (typeof ReadableStream === "undefined") {
    throw new Error("`ReadableStream` is not defined as a global; You will need to polyfill it, `globalThis.ReadableStream = ReadableStream`");
  }
  return new ReadableStream(...args);
}
__name(makeReadableStream, "makeReadableStream");
function ReadableStreamFrom(iterable) {
  let iter = Symbol.asyncIterator in iterable ? iterable[Symbol.asyncIterator]() : iterable[Symbol.iterator]();
  return makeReadableStream({
    start() {
    },
    async pull(controller) {
      const { done, value } = await iter.next();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    async cancel() {
      var _a2;
      await ((_a2 = iter.return) === null || _a2 === void 0 ? void 0 : _a2.call(iter));
    }
  });
}
__name(ReadableStreamFrom, "ReadableStreamFrom");
function ReadableStreamToAsyncIterable(stream) {
  if (stream[Symbol.asyncIterator])
    return stream;
  const reader = stream.getReader();
  return {
    async next() {
      try {
        const result = await reader.read();
        if (result === null || result === void 0 ? void 0 : result.done)
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
async function CancelReadableStream(stream) {
  var _a2, _b;
  if (stream === null || typeof stream !== "object")
    return;
  if (stream[Symbol.asyncIterator]) {
    await ((_b = (_a2 = stream[Symbol.asyncIterator]()).return) === null || _b === void 0 ? void 0 : _b.call(_a2));
    return;
  }
  const reader = stream.getReader();
  const cancelPromise = reader.cancel();
  reader.releaseLock();
  await cancelPromise;
}
__name(CancelReadableStream, "CancelReadableStream");
var FallbackEncoder = /* @__PURE__ */ __name(({ headers, body }) => {
  return {
    bodyHeaders: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  };
}, "FallbackEncoder");
function stringifyQuery(query) {
  return Object.entries(query).filter(([_, value]) => typeof value !== "undefined").map(([key, value]) => {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    }
    if (value === null) {
      return `${encodeURIComponent(key)}=`;
    }
    throw new GeminiNextGenAPIClientError(`Cannot stringify type ${typeof value}; Expected string, number, boolean, or null. If you need to pass nested query parameters, you can manually encode them, e.g. { query: { 'foo[key1]': value1, 'foo[key2]': value2 } }, and please open a GitHub issue requesting better support for your use case.`);
  }).join("&");
}
__name(stringifyQuery, "stringifyQuery");
var VERSION = "0.0.1";
var checkFileSupport = /* @__PURE__ */ __name(() => {
  var _a2;
  if (typeof File === "undefined") {
    const { process: process2 } = globalThis;
    const isOldNode = typeof ((_a2 = process2 === null || process2 === void 0 ? void 0 : process2.versions) === null || _a2 === void 0 ? void 0 : _a2.node) === "string" && parseInt(process2.versions.node.split(".")) < 20;
    throw new Error("`File` is not defined as a global, which is required for file uploads." + (isOldNode ? " Update to Node 20 LTS or newer, or set `globalThis.File` to `import('node:buffer').File`." : ""));
  }
}, "checkFileSupport");
function makeFile(fileBits, fileName, options) {
  checkFileSupport();
  return new File(fileBits, fileName !== null && fileName !== void 0 ? fileName : "unknown_file", options);
}
__name(makeFile, "makeFile");
function getName(value) {
  return (typeof value === "object" && value !== null && ("name" in value && value.name && String(value.name) || "url" in value && value.url && String(value.url) || "filename" in value && value.filename && String(value.filename) || "path" in value && value.path && String(value.path)) || "").split(/[\\/]/).pop() || void 0;
}
__name(getName, "getName");
var isAsyncIterable = /* @__PURE__ */ __name((value) => value != null && typeof value === "object" && typeof value[Symbol.asyncIterator] === "function", "isAsyncIterable");
var isBlobLike = /* @__PURE__ */ __name((value) => value != null && typeof value === "object" && typeof value.size === "number" && typeof value.type === "string" && typeof value.text === "function" && typeof value.slice === "function" && typeof value.arrayBuffer === "function", "isBlobLike");
var isFileLike = /* @__PURE__ */ __name((value) => value != null && typeof value === "object" && typeof value.name === "string" && typeof value.lastModified === "number" && isBlobLike(value), "isFileLike");
var isResponseLike = /* @__PURE__ */ __name((value) => value != null && typeof value === "object" && typeof value.url === "string" && typeof value.blob === "function", "isResponseLike");
async function toFile(value, name, options) {
  checkFileSupport();
  value = await value;
  if (isFileLike(value)) {
    if (value instanceof File) {
      return value;
    }
    return makeFile([await value.arrayBuffer()], value.name);
  }
  if (isResponseLike(value)) {
    const blob = await value.blob();
    name || (name = new URL(value.url).pathname.split(/[\\/]/).pop());
    return makeFile(await getBytes(blob), name, options);
  }
  const parts = await getBytes(value);
  name || (name = getName(value));
  if (!(options === null || options === void 0 ? void 0 : options.type)) {
    const type = parts.find((part) => typeof part === "object" && "type" in part && part.type);
    if (typeof type === "string") {
      options = Object.assign(Object.assign({}, options), { type });
    }
  }
  return makeFile(parts, name, options);
}
__name(toFile, "toFile");
async function getBytes(value) {
  var _a2, e_1, _b, _c;
  var _d;
  let parts = [];
  if (typeof value === "string" || ArrayBuffer.isView(value) || // includes Uint8Array, Buffer, etc.
  value instanceof ArrayBuffer) {
    parts.push(value);
  } else if (isBlobLike(value)) {
    parts.push(value instanceof Blob ? value : await value.arrayBuffer());
  } else if (isAsyncIterable(value)) {
    try {
      for (var _e = true, value_1 = __asyncValues(value), value_1_1; value_1_1 = await value_1.next(), _a2 = value_1_1.done, !_a2; _e = true) {
        _c = value_1_1.value;
        _e = false;
        const chunk = _c;
        parts.push(...await getBytes(chunk));
      }
    } catch (e_1_1) {
      e_1 = { error: e_1_1 };
    } finally {
      try {
        if (!_e && !_a2 && (_b = value_1.return)) await _b.call(value_1);
      } finally {
        if (e_1) throw e_1.error;
      }
    }
  } else {
    const constructor = (_d = value === null || value === void 0 ? void 0 : value.constructor) === null || _d === void 0 ? void 0 : _d.name;
    throw new Error(`Unexpected data type: ${typeof value}${constructor ? `; constructor: ${constructor}` : ""}${propsForError(value)}`);
  }
  return parts;
}
__name(getBytes, "getBytes");
function propsForError(value) {
  if (typeof value !== "object" || value === null)
    return "";
  const props = Object.getOwnPropertyNames(value);
  return `; props: [${props.map((p) => `"${p}"`).join(", ")}]`;
}
__name(propsForError, "propsForError");
var APIResource = class {
  static {
    __name(this, "APIResource");
  }
  constructor(client) {
    this._client = client;
  }
};
APIResource._key = [];
function encodeURIPath(str) {
  return str.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@]+/g, encodeURIComponent);
}
__name(encodeURIPath, "encodeURIPath");
var EMPTY = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.create(null));
var createPathTagFunction = /* @__PURE__ */ __name((pathEncoder = encodeURIPath) => /* @__PURE__ */ __name(function path2(statics, ...params) {
  if (statics.length === 1)
    return statics[0];
  let postPath = false;
  const invalidSegments = [];
  const path3 = statics.reduce((previousValue, currentValue, index) => {
    var _a2, _b, _c;
    if (/[?#]/.test(currentValue)) {
      postPath = true;
    }
    const value = params[index];
    let encoded = (postPath ? encodeURIComponent : pathEncoder)("" + value);
    if (index !== params.length && (value == null || typeof value === "object" && // handle values from other realms
    value.toString === ((_c = Object.getPrototypeOf((_b = Object.getPrototypeOf((_a2 = value.hasOwnProperty) !== null && _a2 !== void 0 ? _a2 : EMPTY)) !== null && _b !== void 0 ? _b : EMPTY)) === null || _c === void 0 ? void 0 : _c.toString))) {
      encoded = value + "";
      invalidSegments.push({
        start: previousValue.length + currentValue.length,
        length: encoded.length,
        error: `Value of type ${Object.prototype.toString.call(value).slice(8, -1)} is not a valid path parameter`
      });
    }
    return previousValue + currentValue + (index === params.length ? "" : encoded);
  }, "");
  const pathOnly = path3.split(/[?#]/, 1)[0];
  const invalidSegmentPattern = /(^|\/)(?:\.|%2e){1,2}(?=\/|$)/gi;
  let match;
  while ((match = invalidSegmentPattern.exec(pathOnly)) !== null) {
    const hasLeadingSlash = match[0].startsWith("/");
    const offset = hasLeadingSlash ? 1 : 0;
    const cleanMatch = hasLeadingSlash ? match[0].slice(1) : match[0];
    invalidSegments.push({
      start: match.index + offset,
      length: cleanMatch.length,
      error: `Value "${cleanMatch}" can't be safely passed as a path parameter`
    });
  }
  invalidSegments.sort((a, b) => a.start - b.start);
  if (invalidSegments.length > 0) {
    let lastEnd = 0;
    const underline = invalidSegments.reduce((acc, segment) => {
      const spaces = " ".repeat(segment.start - lastEnd);
      const arrows = "^".repeat(segment.length);
      lastEnd = segment.start + segment.length;
      return acc + spaces + arrows;
    }, "");
    throw new GeminiNextGenAPIClientError(`Path parameters result in path with invalid segments:
${invalidSegments.map((e) => e.error).join("\n")}
${path3}
${underline}`);
  }
  return path3;
}, "path"), "createPathTagFunction");
var path = /* @__PURE__ */ createPathTagFunction(encodeURIPath);
var BaseAgents = class extends APIResource {
  static {
    __name(this, "BaseAgents");
  }
  /**
   * Creates a new Agent (Typed version for SDK).
   */
  create(params = {}, options) {
    const _a2 = params !== null && params !== void 0 ? params : {}, { api_version = this._client.apiVersion } = _a2, body = __rest(_a2, ["api_version"]);
    return this._client.post(path`/${api_version}/agents`, Object.assign({ body }, options));
  }
  /**
   * Lists all Agents.
   */
  list(params = {}, options) {
    const _a2 = params !== null && params !== void 0 ? params : {}, { api_version = this._client.apiVersion } = _a2, query = __rest(_a2, ["api_version"]);
    return this._client.get(path`/${api_version}/agents`, Object.assign({ query }, options));
  }
  /**
   * Deletes an Agent.
   */
  delete(id, params = {}, options) {
    const { api_version = this._client.apiVersion } = params !== null && params !== void 0 ? params : {};
    return this._client.delete(path`/${api_version}/agents/${id}`, options);
  }
  /**
   * Gets a specific Agent.
   */
  get(id, params = {}, options) {
    const { api_version = this._client.apiVersion } = params !== null && params !== void 0 ? params : {};
    return this._client.get(path`/${api_version}/agents/${id}`, options);
  }
};
BaseAgents._key = Object.freeze(["agents"]);
var Agents = class extends BaseAgents {
  static {
    __name(this, "Agents");
  }
};
function concatBytes(buffers) {
  let length = 0;
  for (const buffer of buffers) {
    length += buffer.length;
  }
  const output = new Uint8Array(length);
  let index = 0;
  for (const buffer of buffers) {
    output.set(buffer, index);
    index += buffer.length;
  }
  return output;
}
__name(concatBytes, "concatBytes");
var encodeUTF8_;
function encodeUTF8(str) {
  let encoder;
  return (encodeUTF8_ !== null && encodeUTF8_ !== void 0 ? encodeUTF8_ : (encoder = new globalThis.TextEncoder(), encodeUTF8_ = encoder.encode.bind(encoder)))(str);
}
__name(encodeUTF8, "encodeUTF8");
var decodeUTF8_;
function decodeUTF8(bytes) {
  let decoder;
  return (decodeUTF8_ !== null && decodeUTF8_ !== void 0 ? decodeUTF8_ : (decoder = new globalThis.TextDecoder(), decodeUTF8_ = decoder.decode.bind(decoder)))(bytes);
}
__name(decodeUTF8, "decodeUTF8");
var LineDecoder = class {
  static {
    __name(this, "LineDecoder");
  }
  constructor() {
    this.buffer = new Uint8Array();
    this.carriageReturnIndex = null;
    this.searchIndex = 0;
  }
  decode(chunk) {
    var _a2;
    if (chunk == null) {
      return [];
    }
    const binaryChunk = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : typeof chunk === "string" ? encodeUTF8(chunk) : chunk;
    this.buffer = concatBytes([this.buffer, binaryChunk]);
    const lines = [];
    let patternIndex;
    while ((patternIndex = findNewlineIndex(this.buffer, (_a2 = this.carriageReturnIndex) !== null && _a2 !== void 0 ? _a2 : this.searchIndex)) != null) {
      if (patternIndex.carriage && this.carriageReturnIndex == null) {
        this.carriageReturnIndex = patternIndex.index;
        continue;
      }
      if (this.carriageReturnIndex != null && (patternIndex.index !== this.carriageReturnIndex + 1 || patternIndex.carriage)) {
        lines.push(decodeUTF8(this.buffer.subarray(0, this.carriageReturnIndex - 1)));
        this.buffer = this.buffer.subarray(this.carriageReturnIndex);
        this.carriageReturnIndex = null;
        this.searchIndex = 0;
        continue;
      }
      const endIndex = this.carriageReturnIndex !== null ? patternIndex.preceding - 1 : patternIndex.preceding;
      const line = decodeUTF8(this.buffer.subarray(0, endIndex));
      lines.push(line);
      this.buffer = this.buffer.subarray(patternIndex.index);
      this.carriageReturnIndex = null;
      this.searchIndex = 0;
    }
    this.searchIndex = Math.max(0, this.buffer.length - 1);
    return lines;
  }
  flush() {
    if (!this.buffer.length) {
      return [];
    }
    return this.decode("\n");
  }
};
LineDecoder.NEWLINE_CHARS = /* @__PURE__ */ new Set(["\n", "\r"]);
LineDecoder.NEWLINE_REGEXP = /\r\n|[\n\r]/g;
function findNewlineIndex(buffer, startIndex) {
  const newline = 10;
  const carriage = 13;
  const start = startIndex !== null && startIndex !== void 0 ? startIndex : 0;
  const nextNewline = buffer.indexOf(newline, start);
  const nextCarriage = buffer.indexOf(carriage, start);
  if (nextNewline === -1 && nextCarriage === -1) {
    return null;
  }
  let i;
  if (nextNewline !== -1 && nextCarriage !== -1) {
    i = Math.min(nextNewline, nextCarriage);
  } else {
    i = nextNewline !== -1 ? nextNewline : nextCarriage;
  }
  if (buffer[i] === newline) {
    return { preceding: i, index: i + 1, carriage: false };
  }
  return { preceding: i, index: i + 1, carriage: true };
}
__name(findNewlineIndex, "findNewlineIndex");
var levelNumbers = {
  off: 0,
  error: 200,
  warn: 300,
  info: 400,
  debug: 500
};
var parseLogLevel = /* @__PURE__ */ __name((maybeLevel, sourceName, client) => {
  if (!maybeLevel) {
    return void 0;
  }
  if (hasOwn(levelNumbers, maybeLevel)) {
    return maybeLevel;
  }
  loggerFor(client).warn(`${sourceName} was set to ${JSON.stringify(maybeLevel)}, expected one of ${JSON.stringify(Object.keys(levelNumbers))}`);
  return void 0;
}, "parseLogLevel");
function noop() {
}
__name(noop, "noop");
function makeLogFn(fnLevel, logger, logLevel) {
  if (!logger || levelNumbers[fnLevel] > levelNumbers[logLevel]) {
    return noop;
  } else {
    return logger[fnLevel].bind(logger);
  }
}
__name(makeLogFn, "makeLogFn");
var noopLogger = {
  error: noop,
  warn: noop,
  info: noop,
  debug: noop
};
var cachedLoggers = /* @__PURE__ */ new WeakMap();
function loggerFor(client) {
  var _a2;
  const logger = client.logger;
  const logLevel = (_a2 = client.logLevel) !== null && _a2 !== void 0 ? _a2 : "off";
  if (!logger) {
    return noopLogger;
  }
  const cachedLogger = cachedLoggers.get(logger);
  if (cachedLogger && cachedLogger[0] === logLevel) {
    return cachedLogger[1];
  }
  const levelLogger = {
    error: makeLogFn("error", logger, logLevel),
    warn: makeLogFn("warn", logger, logLevel),
    info: makeLogFn("info", logger, logLevel),
    debug: makeLogFn("debug", logger, logLevel)
  };
  cachedLoggers.set(logger, [logLevel, levelLogger]);
  return levelLogger;
}
__name(loggerFor, "loggerFor");
var formatRequestDetails = /* @__PURE__ */ __name((details) => {
  if (details.options) {
    details.options = Object.assign({}, details.options);
    delete details.options["headers"];
  }
  if (details.headers) {
    details.headers = Object.fromEntries((details.headers instanceof Headers ? [...details.headers] : Object.entries(details.headers)).map(([name, value]) => [
      name,
      name.toLowerCase() === "x-goog-api-key" || name.toLowerCase() === "authorization" || name.toLowerCase() === "cookie" || name.toLowerCase() === "set-cookie" ? "***" : value
    ]));
  }
  if ("retryOfRequestLogID" in details) {
    if (details.retryOfRequestLogID) {
      details.retryOf = details.retryOfRequestLogID;
    }
    delete details.retryOfRequestLogID;
  }
  return details;
}, "formatRequestDetails");
var Stream = class _Stream {
  static {
    __name(this, "Stream");
  }
  constructor(iterator, controller, client) {
    this.iterator = iterator;
    this.controller = controller;
    this.client = client;
  }
  static fromSSEResponse(response, controller, client) {
    let consumed = false;
    const logger = client ? loggerFor(client) : console;
    function iterator() {
      return __asyncGenerator(this, arguments, /* @__PURE__ */ __name(function* iterator_1() {
        var _a2, e_1, _b, _c;
        if (consumed) {
          throw new GeminiNextGenAPIClientError("Cannot iterate over a consumed stream, use `.tee()` to split the stream.");
        }
        consumed = true;
        let done = false;
        try {
          try {
            for (var _d = true, _e = __asyncValues(_iterSSEMessages(response, controller)), _f; _f = yield __await(_e.next()), _a2 = _f.done, !_a2; _d = true) {
              _c = _f.value;
              _d = false;
              const sse = _c;
              if (done)
                continue;
              if (sse.data.startsWith("[DONE]")) {
                done = true;
                continue;
              } else {
                try {
                  yield yield __await(JSON.parse(sse.data));
                } catch (e) {
                  logger.error(`Could not parse message into JSON:`, sse.data);
                  logger.error(`From chunk:`, sse.raw);
                  throw e;
                }
              }
            }
          } catch (e_1_1) {
            e_1 = { error: e_1_1 };
          } finally {
            try {
              if (!_d && !_a2 && (_b = _e.return)) yield __await(_b.call(_e));
            } finally {
              if (e_1) throw e_1.error;
            }
          }
          done = true;
        } catch (e) {
          if (isAbortError(e))
            return yield __await(void 0);
          throw e;
        } finally {
          if (!done)
            controller.abort();
        }
      }, "iterator_1"));
    }
    __name(iterator, "iterator");
    return new _Stream(iterator, controller, client);
  }
  /**
   * Generates a Stream from a newline-separated ReadableStream
   * where each item is a JSON value.
   */
  static fromReadableStream(readableStream, controller, client) {
    let consumed = false;
    function iterLines() {
      return __asyncGenerator(this, arguments, /* @__PURE__ */ __name(function* iterLines_1() {
        var _a2, e_2, _b, _c;
        const lineDecoder = new LineDecoder();
        const iter = ReadableStreamToAsyncIterable(readableStream);
        try {
          for (var _d = true, iter_1 = __asyncValues(iter), iter_1_1; iter_1_1 = yield __await(iter_1.next()), _a2 = iter_1_1.done, !_a2; _d = true) {
            _c = iter_1_1.value;
            _d = false;
            const chunk = _c;
            for (const line of lineDecoder.decode(chunk)) {
              yield yield __await(line);
            }
          }
        } catch (e_2_1) {
          e_2 = { error: e_2_1 };
        } finally {
          try {
            if (!_d && !_a2 && (_b = iter_1.return)) yield __await(_b.call(iter_1));
          } finally {
            if (e_2) throw e_2.error;
          }
        }
        for (const line of lineDecoder.flush()) {
          yield yield __await(line);
        }
      }, "iterLines_1"));
    }
    __name(iterLines, "iterLines");
    function iterator() {
      return __asyncGenerator(this, arguments, /* @__PURE__ */ __name(function* iterator_2() {
        var _a2, e_3, _b, _c;
        if (consumed) {
          throw new GeminiNextGenAPIClientError("Cannot iterate over a consumed stream, use `.tee()` to split the stream.");
        }
        consumed = true;
        let done = false;
        try {
          try {
            for (var _d = true, _e = __asyncValues(iterLines()), _f; _f = yield __await(_e.next()), _a2 = _f.done, !_a2; _d = true) {
              _c = _f.value;
              _d = false;
              const line = _c;
              if (done)
                continue;
              if (line)
                yield yield __await(JSON.parse(line));
            }
          } catch (e_3_1) {
            e_3 = { error: e_3_1 };
          } finally {
            try {
              if (!_d && !_a2 && (_b = _e.return)) yield __await(_b.call(_e));
            } finally {
              if (e_3) throw e_3.error;
            }
          }
          done = true;
        } catch (e) {
          if (isAbortError(e))
            return yield __await(void 0);
          throw e;
        } finally {
          if (!done)
            controller.abort();
        }
      }, "iterator_2"));
    }
    __name(iterator, "iterator");
    return new _Stream(iterator, controller, client);
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
      new _Stream(() => teeIterator(left), this.controller, this.client),
      new _Stream(() => teeIterator(right), this.controller, this.client)
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
    return makeReadableStream({
      async start() {
        iter = self[Symbol.asyncIterator]();
      },
      async pull(ctrl) {
        try {
          const { value, done } = await iter.next();
          if (done)
            return ctrl.close();
          const bytes = encodeUTF8(JSON.stringify(value) + "\n");
          ctrl.enqueue(bytes);
        } catch (err) {
          ctrl.error(err);
        }
      },
      async cancel() {
        var _a2;
        await ((_a2 = iter.return) === null || _a2 === void 0 ? void 0 : _a2.call(iter));
      }
    });
  }
};
function _iterSSEMessages(response, controller) {
  return __asyncGenerator(this, arguments, /* @__PURE__ */ __name(function* _iterSSEMessages_1() {
    var _a2, e_4, _b, _c;
    if (!response.body) {
      controller.abort();
      if (typeof globalThis.navigator !== "undefined" && globalThis.navigator.product === "ReactNative") {
        throw new GeminiNextGenAPIClientError(`The default react-native fetch implementation does not support streaming. Please use expo/fetch: https://docs.expo.dev/versions/latest/sdk/expo/#expofetch-api`);
      }
      throw new GeminiNextGenAPIClientError(`Attempted to iterate over a response with no body`);
    }
    const sseDecoder = new SSEDecoder();
    const lineDecoder = new LineDecoder();
    const iter = ReadableStreamToAsyncIterable(response.body);
    try {
      for (var _d = true, _e = __asyncValues(iterBinaryChunks(iter)), _f; _f = yield __await(_e.next()), _a2 = _f.done, !_a2; _d = true) {
        _c = _f.value;
        _d = false;
        const sseChunk = _c;
        for (const line of lineDecoder.decode(sseChunk)) {
          const sse = sseDecoder.decode(line);
          if (sse)
            yield yield __await(sse);
        }
      }
    } catch (e_4_1) {
      e_4 = { error: e_4_1 };
    } finally {
      try {
        if (!_d && !_a2 && (_b = _e.return)) yield __await(_b.call(_e));
      } finally {
        if (e_4) throw e_4.error;
      }
    }
    for (const line of lineDecoder.flush()) {
      const sse = sseDecoder.decode(line);
      if (sse)
        yield yield __await(sse);
    }
  }, "_iterSSEMessages_1"));
}
__name(_iterSSEMessages, "_iterSSEMessages");
function iterBinaryChunks(iterator) {
  return __asyncGenerator(this, arguments, /* @__PURE__ */ __name(function* iterBinaryChunks_1() {
    var _a2, e_5, _b, _c;
    try {
      for (var _d = true, iterator_3 = __asyncValues(iterator), iterator_3_1; iterator_3_1 = yield __await(iterator_3.next()), _a2 = iterator_3_1.done, !_a2; _d = true) {
        _c = iterator_3_1.value;
        _d = false;
        const chunk = _c;
        if (chunk == null) {
          continue;
        }
        const binaryChunk = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : typeof chunk === "string" ? encodeUTF8(chunk) : chunk;
        yield yield __await(binaryChunk);
      }
    } catch (e_5_1) {
      e_5 = { error: e_5_1 };
    } finally {
      try {
        if (!_d && !_a2 && (_b = iterator_3.return)) yield __await(_b.call(iterator_3));
      } finally {
        if (e_5) throw e_5.error;
      }
    }
  }, "iterBinaryChunks_1"));
}
__name(iterBinaryChunks, "iterBinaryChunks");
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
var LEGACY_LYRIA_MODELS = /* @__PURE__ */ new Set([
  "lyria-3-pro-preview",
  "lyria-3-clip-preview"
]);
var LEGACY_EVENT_TYPE_RENAMES = {
  "interaction.start": "interaction.created",
  "content.start": "step.start",
  "content.delta": "step.delta",
  "content.stop": "step.stop",
  "interaction.complete": "interaction.completed"
};
function isLegacyLyriaRequest({ isVertex, model }) {
  return Boolean(isVertex) && typeof model === "string" && LEGACY_LYRIA_MODELS.has(model);
}
__name(isLegacyLyriaRequest, "isLegacyLyriaRequest");
function isVertexClient(client) {
  const adapter = client.clientAdapter;
  return Boolean(adapter && adapter.isVertexAI());
}
__name(isVertexClient, "isVertexClient");
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isPlainObject, "isPlainObject");
function wrapOutputsAsSteps(data) {
  if (!("outputs" in data) || "steps" in data) {
    return data;
  }
  const { outputs } = data, rest = __rest(data, ["outputs"]);
  return Object.assign(Object.assign({}, rest), { steps: [{ type: "model_output", content: outputs }] });
}
__name(wrapOutputsAsSteps, "wrapOutputsAsSteps");
function coerceLegacyInteractionResponse(data) {
  if (!isPlainObject(data))
    return data;
  return wrapOutputsAsSteps(data);
}
__name(coerceLegacyInteractionResponse, "coerceLegacyInteractionResponse");
function maybeRemapLegacyStreamEvent(data) {
  if (!isPlainObject(data))
    return data;
  const eventType = data["event_type"];
  if (typeof eventType !== "string" || !(eventType in LEGACY_EVENT_TYPE_RENAMES)) {
    return data;
  }
  const renamed = Object.assign(Object.assign({}, data), { event_type: LEGACY_EVENT_TYPE_RENAMES[eventType] });
  if (eventType === "content.start") {
    const { content } = renamed, rest = __rest(renamed, ["content"]);
    let stepContent;
    if (content == null) {
      stepContent = [];
    } else if (Array.isArray(content)) {
      stepContent = content;
    } else {
      stepContent = [content];
    }
    return Object.assign(Object.assign({}, rest), { step: { type: "model_output", content: stepContent } });
  }
  if (eventType === "interaction.start" || eventType === "interaction.complete") {
    const inner = renamed["interaction"];
    if (isPlainObject(inner)) {
      renamed["interaction"] = wrapOutputsAsSteps(inner);
    }
  }
  return renamed;
}
__name(maybeRemapLegacyStreamEvent, "maybeRemapLegacyStreamEvent");
var LegacyLyriaStream = class _LegacyLyriaStream extends Stream {
  static {
    __name(this, "LegacyLyriaStream");
  }
  static fromSSEResponse(response, controller, client) {
    const base = Stream.fromSSEResponse(response, controller, client);
    function wrappedIterator() {
      return __asyncGenerator(this, arguments, /* @__PURE__ */ __name(function* wrappedIterator_1() {
        var _a2, e_1, _b, _c;
        try {
          for (var _d = true, base_1 = __asyncValues(base), base_1_1; base_1_1 = yield __await(base_1.next()), _a2 = base_1_1.done, !_a2; _d = true) {
            _c = base_1_1.value;
            _d = false;
            const item = _c;
            yield yield __await(maybeRemapLegacyStreamEvent(item));
          }
        } catch (e_1_1) {
          e_1 = { error: e_1_1 };
        } finally {
          try {
            if (!_d && !_a2 && (_b = base_1.return)) yield __await(_b.call(base_1));
          } finally {
            if (e_1) throw e_1.error;
          }
        }
      }, "wrappedIterator_1"));
    }
    __name(wrappedIterator, "wrappedIterator");
    return new _LegacyLyriaStream(wrappedIterator, controller, client);
  }
};
var BaseInteractions = class extends APIResource {
  static {
    __name(this, "BaseInteractions");
  }
  create(params, options) {
    var _a2;
    const { api_version = this._client.apiVersion } = params, body = __rest(params, ["api_version"]);
    if ("model" in body && "agent_config" in body) {
      throw new GeminiNextGenAPIClientError(`Invalid request: specified \`model\` and \`agent_config\`. If specifying \`model\`, use \`generation_config\`.`);
    }
    if ("agent" in body && "generation_config" in body) {
      throw new GeminiNextGenAPIClientError(`Invalid request: specified \`agent\` and \`generation_config\`. If specifying \`agent\`, use \`agent_config\`.`);
    }
    const needsLegacyLyriaShim = isLegacyLyriaRequest({
      isVertex: isVertexClient(this._client),
      model: "model" in body ? body.model : void 0
    });
    const isStreaming = (_a2 = params.stream) !== null && _a2 !== void 0 ? _a2 : false;
    const promise = this._client.post(path`/${api_version}/interactions`, Object.assign(Object.assign(Object.assign({ body }, options), { stream: isStreaming }), needsLegacyLyriaShim && isStreaming ? { __streamClass: LegacyLyriaStream } : {}));
    if (isStreaming) {
      return promise;
    }
    let nonStreaming = promise;
    if (needsLegacyLyriaShim) {
      nonStreaming = nonStreaming._thenUnwrap((data) => coerceLegacyInteractionResponse(data));
    }
    return nonStreaming._thenUnwrap(addOutputProperties);
  }
  /**
   * Deletes the interaction by id.
   *
   * @example
   * ```ts
   * const interaction = await client.interactions.delete('id', {
   *   api_version: 'api_version',
   * });
   * ```
   */
  delete(id, params = {}, options) {
    const { api_version = this._client.apiVersion } = params !== null && params !== void 0 ? params : {};
    return this._client.delete(path`/${api_version}/interactions/${id}`, options);
  }
  /**
   * Cancels an interaction by id. This only applies to background interactions that
   * are still running.
   *
   * @example
   * ```ts
   * const interaction = await client.interactions.cancel('id', {
   *   api_version: 'api_version',
   * });
   * ```
   */
  cancel(id, params = {}, options) {
    const { api_version = this._client.apiVersion } = params !== null && params !== void 0 ? params : {};
    return this._client.post(path`/${api_version}/interactions/${id}/cancel`, options)._thenUnwrap(addOutputProperties);
  }
  get(id, params = {}, options) {
    var _a2;
    const _b = params !== null && params !== void 0 ? params : {}, { api_version = this._client.apiVersion } = _b, query = __rest(_b, ["api_version"]);
    const response = this._client.get(path`/${api_version}/interactions/${id}`, Object.assign(Object.assign({ query }, options), { stream: (_a2 = params === null || params === void 0 ? void 0 : params.stream) !== null && _a2 !== void 0 ? _a2 : false }));
    if (params === null || params === void 0 ? void 0 : params.stream) {
      return response;
    }
    return response._thenUnwrap(addOutputProperties);
  }
};
BaseInteractions._key = Object.freeze(["interactions"]);
var Interactions = class extends BaseInteractions {
  static {
    __name(this, "Interactions");
  }
};
function addOutputProperties(interaction) {
  var _a2, _b;
  const steps = (_a2 = interaction.steps) !== null && _a2 !== void 0 ? _a2 : [];
  const textParts = [];
  let collecting = false;
  outer: for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.type === "user_input")
      break;
    if (step.type !== "model_output" || !step.content) {
      if (collecting)
        break outer;
      continue;
    }
    const content = step.content;
    for (let j = content.length - 1; j >= 0; j--) {
      const item = content[j];
      if (item.type === "text") {
        collecting = true;
        textParts.push((_b = item.text) !== null && _b !== void 0 ? _b : "");
      } else if (collecting) {
        break outer;
      }
    }
  }
  const output_text = textParts.reverse().join("");
  let output_image;
  let output_audio;
  let output_video;
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    const anyStep = step;
    if (anyStep.type === "user_input") {
      break;
    }
    if (anyStep.type === "model_output" && anyStep.content) {
      for (let j = anyStep.content.length - 1; j >= 0; j--) {
        const content = anyStep.content[j];
        if (content.type === "image" && !output_image) {
          output_image = content;
        }
        if (content.type === "audio" && !output_audio) {
          output_audio = content;
        }
        if (content.type === "video" && !output_video) {
          output_video = content;
        }
      }
    }
  }
  return Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, interaction), output_text && { output_text }), output_image && { output_image }), output_audio && { output_audio }), output_video && { output_video });
}
__name(addOutputProperties, "addOutputProperties");
var BaseWebhooks = class extends APIResource {
  static {
    __name(this, "BaseWebhooks");
  }
  /**
   * Creates a new Webhook.
   */
  create(params, options) {
    const { api_version = this._client.apiVersion } = params, body = __rest(params, ["api_version"]);
    return this._client.post(path`/${api_version}/webhooks`, Object.assign({ body }, options));
  }
  /**
   * Updates an existing Webhook.
   */
  update(id, params = {}, options) {
    const _a2 = params !== null && params !== void 0 ? params : {}, { api_version = this._client.apiVersion, update_mask } = _a2, body = __rest(_a2, ["api_version", "update_mask"]);
    return this._client.patch(path`/${api_version}/webhooks/${id}`, Object.assign({ query: { update_mask }, body }, options));
  }
  /**
   * Lists all Webhooks.
   */
  list(params = {}, options) {
    const _a2 = params !== null && params !== void 0 ? params : {}, { api_version = this._client.apiVersion } = _a2, query = __rest(_a2, ["api_version"]);
    return this._client.get(path`/${api_version}/webhooks`, Object.assign({ query }, options));
  }
  /**
   * Deletes a Webhook.
   */
  delete(id, params = {}, options) {
    const { api_version = this._client.apiVersion } = params !== null && params !== void 0 ? params : {};
    return this._client.delete(path`/${api_version}/webhooks/${id}`, options);
  }
  /**
   * Gets a specific Webhook.
   */
  get(id, params = {}, options) {
    const { api_version = this._client.apiVersion } = params !== null && params !== void 0 ? params : {};
    return this._client.get(path`/${api_version}/webhooks/${id}`, options);
  }
  /**
   * Sends a ping event to a Webhook.
   */
  ping(id, params = void 0, options) {
    const { api_version = this._client.apiVersion, body } = params !== null && params !== void 0 ? params : {};
    return this._client.post(path`/${api_version}/webhooks/${id}:ping`, Object.assign({ body }, options));
  }
  /**
   * Generates a new signing secret for a Webhook.
   */
  rotateSigningSecret(id, params = {}, options) {
    const _a2 = params !== null && params !== void 0 ? params : {}, { api_version = this._client.apiVersion } = _a2, body = __rest(_a2, ["api_version"]);
    return this._client.post(path`/${api_version}/webhooks/${id}:rotateSigningSecret`, Object.assign({ body }, options));
  }
};
BaseWebhooks._key = Object.freeze(["webhooks"]);
var Webhooks = class extends BaseWebhooks {
  static {
    __name(this, "Webhooks");
  }
};
async function defaultParseResponse(client, props) {
  const { response, requestLogID, retryOfRequestLogID, startTime } = props;
  const body = await (async () => {
    var _a2;
    if (props.options.stream) {
      loggerFor(client).debug("response", response.status, response.url, response.headers, response.body);
      if (props.options.__streamClass) {
        return props.options.__streamClass.fromSSEResponse(response, props.controller, client);
      }
      return Stream.fromSSEResponse(response, props.controller, client);
    }
    if (response.status === 204) {
      return null;
    }
    if (props.options.__binaryResponse) {
      return response;
    }
    const contentType = response.headers.get("content-type");
    const mediaType = (_a2 = contentType === null || contentType === void 0 ? void 0 : contentType.split(";")[0]) === null || _a2 === void 0 ? void 0 : _a2.trim();
    const isJSON = (mediaType === null || mediaType === void 0 ? void 0 : mediaType.includes("application/json")) || (mediaType === null || mediaType === void 0 ? void 0 : mediaType.endsWith("+json"));
    if (isJSON) {
      const contentLength = response.headers.get("content-length");
      if (contentLength === "0") {
        return void 0;
      }
      const json = await response.json();
      return json;
    }
    const text = await response.text();
    return text;
  })();
  loggerFor(client).debug(`[${requestLogID}] response parsed`, formatRequestDetails({
    retryOfRequestLogID,
    url: response.url,
    status: response.status,
    body,
    durationMs: Date.now() - startTime
  }));
  return body;
}
__name(defaultParseResponse, "defaultParseResponse");
var APIPromise = class _APIPromise extends Promise {
  static {
    __name(this, "APIPromise");
  }
  constructor(client, responsePromise, parseResponse = defaultParseResponse) {
    super((resolve) => {
      resolve(null);
    });
    this.responsePromise = responsePromise;
    this.parseResponse = parseResponse;
    this.client = client;
  }
  _thenUnwrap(transform) {
    return new _APIPromise(this.client, this.responsePromise, async (client, props) => transform(await this.parseResponse(client, props), props));
  }
  /**
   * Gets the raw `Response` instance instead of parsing the response
   * data.
   *
   * If you want to parse the response body but still get the `Response`
   * instance, you can use {@link withResponse()}.
   *
   * 👋 Getting the wrong TypeScript type for `Response`?
   * Try setting `"moduleResolution": "NodeNext"` or add `"lib": ["DOM"]`
   * to your `tsconfig.json`.
   */
  asResponse() {
    return this.responsePromise.then((p) => p.response);
  }
  /**
   * Gets the parsed response data and the raw `Response` instance.
   *
   * If you just want to get the raw `Response` instance without parsing it,
   * you can use {@link asResponse()}.
   *
   * 👋 Getting the wrong TypeScript type for `Response`?
   * Try setting `"moduleResolution": "NodeNext"` or add `"lib": ["DOM"]`
   * to your `tsconfig.json`.
   */
  async withResponse() {
    const [data, response] = await Promise.all([this.parse(), this.asResponse()]);
    return { data, response };
  }
  parse() {
    if (!this.parsedPromise) {
      this.parsedPromise = this.responsePromise.then((data) => this.parseResponse(this.client, data));
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
var brand_privateNullableHeaders = /* @__PURE__ */ Symbol("brand.privateNullableHeaders");
function* iterateHeaders(headers) {
  if (!headers)
    return;
  if (brand_privateNullableHeaders in headers) {
    const { values, nulls } = headers;
    yield* values.entries();
    for (const name of nulls) {
      yield [name, null];
    }
    return;
  }
  let shouldClear = false;
  let iter;
  if (headers instanceof Headers) {
    iter = headers.entries();
  } else if (isReadonlyArray(headers)) {
    iter = headers;
  } else {
    shouldClear = true;
    iter = Object.entries(headers !== null && headers !== void 0 ? headers : {});
  }
  for (let row of iter) {
    const name = row[0];
    if (typeof name !== "string")
      throw new TypeError("expected header name to be a string");
    const values = isReadonlyArray(row[1]) ? row[1] : [row[1]];
    let didClear = false;
    for (const value of values) {
      if (value === void 0)
        continue;
      if (shouldClear && !didClear) {
        didClear = true;
        yield [name, null];
      }
      yield [name, value];
    }
  }
}
__name(iterateHeaders, "iterateHeaders");
var buildHeaders = /* @__PURE__ */ __name((newHeaders) => {
  const targetHeaders = new Headers();
  const nullHeaders = /* @__PURE__ */ new Set();
  for (const headers of newHeaders) {
    const seenHeaders = /* @__PURE__ */ new Set();
    for (const [name, value] of iterateHeaders(headers)) {
      const lowerName = name.toLowerCase();
      if (!seenHeaders.has(lowerName)) {
        targetHeaders.delete(name);
        seenHeaders.add(lowerName);
      }
      if (value === null) {
        targetHeaders.delete(name);
        nullHeaders.add(lowerName);
      } else {
        targetHeaders.append(name, value);
        nullHeaders.delete(lowerName);
      }
    }
  }
  return { [brand_privateNullableHeaders]: true, values: targetHeaders, nulls: nullHeaders };
}, "buildHeaders");
var readEnv = /* @__PURE__ */ __name((env) => {
  var _a2, _b, _c, _d, _e;
  if (typeof globalThis.process !== "undefined") {
    return ((_b = (_a2 = globalThis.process.env) === null || _a2 === void 0 ? void 0 : _a2[env]) === null || _b === void 0 ? void 0 : _b.trim()) || void 0;
  }
  if (typeof globalThis.Deno !== "undefined") {
    return ((_e = (_d = (_c = globalThis.Deno.env) === null || _c === void 0 ? void 0 : _c.get) === null || _d === void 0 ? void 0 : _d.call(_c, env)) === null || _e === void 0 ? void 0 : _e.trim()) || void 0;
  }
  return void 0;
}, "readEnv");
var _a;
var BaseGeminiNextGenAPIClient = class _BaseGeminiNextGenAPIClient {
  static {
    __name(this, "BaseGeminiNextGenAPIClient");
  }
  /**
   * API Client for interfacing with the Gemini Next Gen API API.
   *
   * @param {string | null | undefined} [opts.apiKey=process.env['GEMINI_API_KEY'] ?? null]
   * @param {string | undefined} [opts.apiVersion=v1beta]
   * @param {string} [opts.baseURL=process.env['GEMINI_NEXT_GEN_API_BASE_URL'] ?? https://generativelanguage.googleapis.com] - Override the default base URL for the API.
   * @param {number} [opts.timeout=1 minute] - The maximum amount of time (in milliseconds) the client will wait for a response before timing out.
   * @param {MergedRequestInit} [opts.fetchOptions] - Additional `RequestInit` options to be passed to `fetch` calls.
   * @param {Fetch} [opts.fetch] - Specify a custom `fetch` function implementation.
   * @param {number} [opts.maxRetries=2] - The maximum number of times the client will retry a request.
   * @param {HeadersLike} opts.defaultHeaders - Default headers to include with every request to the API.
   * @param {Record<string, string | undefined>} opts.defaultQuery - Default query parameters to include with every request to the API.
   */
  constructor(_b) {
    var _c, _d, _e, _f, _g, _h, _j;
    var { baseURL = readEnv("GEMINI_NEXT_GEN_API_BASE_URL"), apiKey = (_c = readEnv("GEMINI_API_KEY")) !== null && _c !== void 0 ? _c : null, apiVersion = "v1beta" } = _b, opts = __rest(_b, ["baseURL", "apiKey", "apiVersion"]);
    const options = Object.assign(Object.assign({
      apiKey,
      apiVersion
    }, opts), { baseURL: baseURL || `https://generativelanguage.googleapis.com` });
    this.baseURL = options.baseURL;
    this.timeout = (_d = options.timeout) !== null && _d !== void 0 ? _d : _BaseGeminiNextGenAPIClient.DEFAULT_TIMEOUT;
    this.logger = (_e = options.logger) !== null && _e !== void 0 ? _e : console;
    const defaultLogLevel = "warn";
    this.logLevel = defaultLogLevel;
    this.logLevel = (_g = (_f = parseLogLevel(options.logLevel, "ClientOptions.logLevel", this)) !== null && _f !== void 0 ? _f : parseLogLevel(readEnv("GEMINI_NEXT_GEN_API_LOG"), "process.env['GEMINI_NEXT_GEN_API_LOG']", this)) !== null && _g !== void 0 ? _g : defaultLogLevel;
    this.fetchOptions = options.fetchOptions;
    this.maxRetries = (_h = options.maxRetries) !== null && _h !== void 0 ? _h : 2;
    this.fetch = (_j = options.fetch) !== null && _j !== void 0 ? _j : getDefaultFetch();
    this.encoder = FallbackEncoder;
    this._options = options;
    this.apiKey = apiKey;
    this.apiVersion = apiVersion;
    this.clientAdapter = options.clientAdapter;
  }
  /**
   * Create a new client instance re-using the same options given to the current client with optional overriding.
   */
  withOptions(options) {
    const client = new this.constructor(Object.assign(Object.assign(Object.assign({}, this._options), { baseURL: this.baseURL, maxRetries: this.maxRetries, timeout: this.timeout, logger: this.logger, logLevel: this.logLevel, fetch: this.fetch, fetchOptions: this.fetchOptions, apiKey: this.apiKey, apiVersion: this.apiVersion }), options));
    return client;
  }
  /**
   * Check whether the base URL is set to its default.
   */
  baseURLOverridden() {
    return this.baseURL !== "https://generativelanguage.googleapis.com";
  }
  defaultQuery() {
    return this._options.defaultQuery;
  }
  validateHeaders({ values, nulls }) {
    if (values.has("authorization") || values.has("x-goog-api-key")) {
      return;
    }
    if (this.apiKey && values.get("x-goog-api-key")) {
      return;
    }
    if (nulls.has("x-goog-api-key")) {
      return;
    }
    throw new Error('Could not resolve authentication method. Expected the apiKey to be set. Or for the "x-goog-api-key" headers to be explicitly omitted');
  }
  async authHeaders(opts) {
    const existingHeaders = buildHeaders([opts.headers]);
    if (existingHeaders.values.has("authorization") || existingHeaders.values.has("x-goog-api-key")) {
      return void 0;
    }
    if (this.apiKey) {
      return buildHeaders([{ "x-goog-api-key": this.apiKey }]);
    }
    if (this.clientAdapter && this.clientAdapter.isVertexAI()) {
      return buildHeaders([await this.clientAdapter.getAuthHeaders()]);
    }
    return void 0;
  }
  /**
   * Basic re-implementation of `qs.stringify` for primitive types.
   */
  stringifyQuery(query) {
    return stringifyQuery(query);
  }
  getUserAgent() {
    return `${this.constructor.name}/JS ${VERSION}`;
  }
  defaultIdempotencyKey() {
    return `stainless-node-retry-${uuid4()}`;
  }
  makeStatusError(status, error, message, headers) {
    return APIError.generate(status, error, message, headers);
  }
  buildURL(path2, query, defaultBaseURL) {
    const baseURL = !this.baseURLOverridden() && defaultBaseURL || this.baseURL;
    const url = isAbsoluteURL(path2) ? new URL(path2) : new URL(baseURL + (baseURL.endsWith("/") && path2.startsWith("/") ? path2.slice(1) : path2));
    const defaultQuery = this.defaultQuery();
    const pathQuery = Object.fromEntries(url.searchParams);
    if (!isEmptyObj(defaultQuery) || !isEmptyObj(pathQuery)) {
      query = Object.assign(Object.assign(Object.assign({}, pathQuery), defaultQuery), query);
    }
    if (typeof query === "object" && query && !Array.isArray(query)) {
      url.search = this.stringifyQuery(query);
    }
    return url.toString();
  }
  /**
     * Used as a callback for mutating the given `FinalRequestOptions` object.
  
     */
  async prepareOptions(options) {
    if (this.clientAdapter && this.clientAdapter.isVertexAI() && !options.path.startsWith(`/${this.apiVersion}/projects/`)) {
      const oldPath = options.path.slice(this.apiVersion.length + 1);
      options.path = `/${this.apiVersion}/projects/${this.clientAdapter.getProject()}/locations/${this.clientAdapter.getLocation()}${oldPath}`;
    }
  }
  /**
   * Used as a callback for mutating the given `RequestInit` object.
   *
   * This is useful for cases where you want to add certain headers based off of
   * the request properties, e.g. `method` or `url`.
   */
  async prepareRequest(request, { url, options }) {
  }
  get(path2, opts) {
    return this.methodRequest("get", path2, opts);
  }
  post(path2, opts) {
    return this.methodRequest("post", path2, opts);
  }
  patch(path2, opts) {
    return this.methodRequest("patch", path2, opts);
  }
  put(path2, opts) {
    return this.methodRequest("put", path2, opts);
  }
  delete(path2, opts) {
    return this.methodRequest("delete", path2, opts);
  }
  methodRequest(method, path2, opts) {
    return this.request(Promise.resolve(opts).then((opts2) => {
      return Object.assign({ method, path: path2 }, opts2);
    }));
  }
  request(options, remainingRetries = null) {
    return new APIPromise(this, this.makeRequest(options, remainingRetries, void 0));
  }
  async makeRequest(optionsInput, retriesRemaining, retryOfRequestLogID) {
    var _b, _c, _d;
    const options = await optionsInput;
    const maxRetries = (_b = options.maxRetries) !== null && _b !== void 0 ? _b : this.maxRetries;
    if (retriesRemaining == null) {
      retriesRemaining = maxRetries;
    }
    await this.prepareOptions(options);
    const { req, url, timeout } = await this.buildRequest(options, {
      retryCount: maxRetries - retriesRemaining
    });
    await this.prepareRequest(req, { url, options });
    const requestLogID = "log_" + (Math.random() * (1 << 24) | 0).toString(16).padStart(6, "0");
    const retryLogStr = retryOfRequestLogID === void 0 ? "" : `, retryOf: ${retryOfRequestLogID}`;
    const startTime = Date.now();
    loggerFor(this).debug(`[${requestLogID}] sending request`, formatRequestDetails({
      retryOfRequestLogID,
      method: options.method,
      url,
      options,
      headers: req.headers
    }));
    if ((_c = options.signal) === null || _c === void 0 ? void 0 : _c.aborted) {
      throw new APIUserAbortError();
    }
    const controller = new AbortController();
    const response = await this.fetchWithTimeout(url, req, timeout, controller).catch(castToError);
    const headersTime = Date.now();
    if (response instanceof globalThis.Error) {
      const retryMessage = `retrying, ${retriesRemaining} attempts remaining`;
      if ((_d = options.signal) === null || _d === void 0 ? void 0 : _d.aborted) {
        throw new APIUserAbortError();
      }
      const isTimeout = isAbortError(response) || /timed? ?out/i.test(String(response) + ("cause" in response ? String(response.cause) : ""));
      if (retriesRemaining) {
        loggerFor(this).info(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} - ${retryMessage}`);
        loggerFor(this).debug(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} (${retryMessage})`, formatRequestDetails({
          retryOfRequestLogID,
          url,
          durationMs: headersTime - startTime,
          message: response.message
        }));
        return this.retryRequest(options, retriesRemaining, retryOfRequestLogID !== null && retryOfRequestLogID !== void 0 ? retryOfRequestLogID : requestLogID);
      }
      loggerFor(this).info(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} - error; no more retries left`);
      loggerFor(this).debug(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} (error; no more retries left)`, formatRequestDetails({
        retryOfRequestLogID,
        url,
        durationMs: headersTime - startTime,
        message: response.message
      }));
      if (isTimeout) {
        throw new APIConnectionTimeoutError();
      }
      throw new APIConnectionError({ cause: response });
    }
    const responseInfo = `[${requestLogID}${retryLogStr}] ${req.method} ${url} ${response.ok ? "succeeded" : "failed"} with status ${response.status} in ${headersTime - startTime}ms`;
    if (!response.ok) {
      const shouldRetry = await this.shouldRetry(response);
      if (retriesRemaining && shouldRetry) {
        const retryMessage2 = `retrying, ${retriesRemaining} attempts remaining`;
        await CancelReadableStream(response.body);
        loggerFor(this).info(`${responseInfo} - ${retryMessage2}`);
        loggerFor(this).debug(`[${requestLogID}] response error (${retryMessage2})`, formatRequestDetails({
          retryOfRequestLogID,
          url: response.url,
          status: response.status,
          headers: response.headers,
          durationMs: headersTime - startTime
        }));
        return this.retryRequest(options, retriesRemaining, retryOfRequestLogID !== null && retryOfRequestLogID !== void 0 ? retryOfRequestLogID : requestLogID, response.headers);
      }
      const retryMessage = shouldRetry ? `error; no more retries left` : `error; not retryable`;
      loggerFor(this).info(`${responseInfo} - ${retryMessage}`);
      const errText = await response.text().catch((err2) => castToError(err2).message);
      const errJSON = safeJSON(errText);
      const errMessage = errJSON ? void 0 : errText;
      loggerFor(this).debug(`[${requestLogID}] response error (${retryMessage})`, formatRequestDetails({
        retryOfRequestLogID,
        url: response.url,
        status: response.status,
        headers: response.headers,
        message: errMessage,
        durationMs: Date.now() - startTime
      }));
      const err = this.makeStatusError(response.status, errJSON, errMessage, response.headers);
      throw err;
    }
    loggerFor(this).info(responseInfo);
    loggerFor(this).debug(`[${requestLogID}] response start`, formatRequestDetails({
      retryOfRequestLogID,
      url: response.url,
      status: response.status,
      headers: response.headers,
      durationMs: headersTime - startTime
    }));
    return { response, options, controller, requestLogID, retryOfRequestLogID, startTime };
  }
  async fetchWithTimeout(url, init, ms, controller) {
    const _b = init || {}, { signal, method } = _b, options = __rest(_b, ["signal", "method"]);
    const abort = this._makeAbort(controller);
    if (signal)
      signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, ms);
    const isReadableBody = globalThis.ReadableStream && options.body instanceof globalThis.ReadableStream || typeof options.body === "object" && options.body !== null && Symbol.asyncIterator in options.body;
    const fetchOptions = Object.assign(Object.assign(Object.assign({ signal: controller.signal }, isReadableBody ? { duplex: "half" } : {}), { method: "GET" }), options);
    if (method) {
      fetchOptions.method = method.toUpperCase();
    }
    try {
      return await this.fetch.call(void 0, url, fetchOptions);
    } finally {
      clearTimeout(timeout);
    }
  }
  async shouldRetry(response) {
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
  async retryRequest(options, retriesRemaining, requestLogID, responseHeaders) {
    var _b;
    let timeoutMillis;
    const retryAfterMillisHeader = responseHeaders === null || responseHeaders === void 0 ? void 0 : responseHeaders.get("retry-after-ms");
    if (retryAfterMillisHeader) {
      const timeoutMs = parseFloat(retryAfterMillisHeader);
      if (!Number.isNaN(timeoutMs)) {
        timeoutMillis = timeoutMs;
      }
    }
    const retryAfterHeader = responseHeaders === null || responseHeaders === void 0 ? void 0 : responseHeaders.get("retry-after");
    if (retryAfterHeader && !timeoutMillis) {
      const timeoutSeconds = parseFloat(retryAfterHeader);
      if (!Number.isNaN(timeoutSeconds)) {
        timeoutMillis = timeoutSeconds * 1e3;
      } else {
        timeoutMillis = Date.parse(retryAfterHeader) - Date.now();
      }
    }
    if (timeoutMillis === void 0) {
      const maxRetries = (_b = options.maxRetries) !== null && _b !== void 0 ? _b : this.maxRetries;
      timeoutMillis = this.calculateDefaultRetryTimeoutMillis(retriesRemaining, maxRetries);
    }
    await sleep$1(timeoutMillis);
    return this.makeRequest(options, retriesRemaining - 1, requestLogID);
  }
  calculateDefaultRetryTimeoutMillis(retriesRemaining, maxRetries) {
    const initialRetryDelay = 0.5;
    const maxRetryDelay = 8;
    const numRetries = maxRetries - retriesRemaining;
    const sleepSeconds = Math.min(initialRetryDelay * Math.pow(2, numRetries), maxRetryDelay);
    const jitter = 1 - Math.random() * 0.25;
    return sleepSeconds * jitter * 1e3;
  }
  async buildRequest(inputOptions, { retryCount = 0 } = {}) {
    var _b, _c, _d;
    const options = Object.assign({}, inputOptions);
    const { method, path: path2, query, defaultBaseURL } = options;
    const url = this.buildURL(path2, query, defaultBaseURL);
    if ("timeout" in options)
      validatePositiveInteger("timeout", options.timeout);
    options.timeout = (_b = options.timeout) !== null && _b !== void 0 ? _b : this.timeout;
    const { bodyHeaders, body } = this.buildBody({ options });
    const reqHeaders = await this.buildHeaders({ options: inputOptions, method, bodyHeaders, retryCount });
    const req = Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({ method, headers: reqHeaders }, options.signal && { signal: options.signal }), globalThis.ReadableStream && body instanceof globalThis.ReadableStream && { duplex: "half" }), body && { body }), (_c = this.fetchOptions) !== null && _c !== void 0 ? _c : {}), (_d = options.fetchOptions) !== null && _d !== void 0 ? _d : {});
    return { req, url, timeout: options.timeout };
  }
  async buildHeaders({ options, method, bodyHeaders, retryCount }) {
    let idempotencyHeaders = {};
    if (this.idempotencyHeader && method !== "get") {
      if (!options.idempotencyKey)
        options.idempotencyKey = this.defaultIdempotencyKey();
      idempotencyHeaders[this.idempotencyHeader] = options.idempotencyKey;
    }
    const authHeaders = await this.authHeaders(options);
    let headers = buildHeaders([
      idempotencyHeaders,
      { Accept: "application/json", "User-Agent": this.getUserAgent(), "Api-Revision": "2026-05-20" },
      this._options.defaultHeaders,
      bodyHeaders,
      options.headers,
      authHeaders
    ]);
    this.validateHeaders(headers);
    return headers.values;
  }
  _makeAbort(controller) {
    return () => controller.abort();
  }
  buildBody({ options: { body, headers: rawHeaders } }) {
    if (!body) {
      return { bodyHeaders: void 0, body: void 0 };
    }
    const headers = buildHeaders([rawHeaders]);
    if (
      // Pass raw type verbatim
      ArrayBuffer.isView(body) || body instanceof ArrayBuffer || body instanceof DataView || typeof body === "string" && // Preserve legacy string encoding behavior for now
      headers.values.has("content-type") || // `Blob` is superset of `File`
      globalThis.Blob && body instanceof globalThis.Blob || // `FormData` -> `multipart/form-data`
      body instanceof FormData || // `URLSearchParams` -> `application/x-www-form-urlencoded`
      body instanceof URLSearchParams || // Send chunked stream (each chunk has own `length`)
      globalThis.ReadableStream && body instanceof globalThis.ReadableStream
    ) {
      return { bodyHeaders: void 0, body };
    } else if (typeof body === "object" && (Symbol.asyncIterator in body || Symbol.iterator in body && "next" in body && typeof body.next === "function")) {
      return { bodyHeaders: void 0, body: ReadableStreamFrom(body) };
    } else if (typeof body === "object" && headers.values.get("content-type") === "application/x-www-form-urlencoded") {
      return {
        bodyHeaders: { "content-type": "application/x-www-form-urlencoded" },
        body: this.stringifyQuery(body)
      };
    } else {
      return this.encoder({ body, headers });
    }
  }
};
BaseGeminiNextGenAPIClient.DEFAULT_TIMEOUT = 6e4;
var GeminiNextGenAPIClient = class extends BaseGeminiNextGenAPIClient {
  static {
    __name(this, "GeminiNextGenAPIClient");
  }
  constructor() {
    super(...arguments);
    this.interactions = new Interactions(this);
    this.webhooks = new Webhooks(this);
    this.agents = new Agents(this);
  }
};
_a = GeminiNextGenAPIClient;
GeminiNextGenAPIClient.GeminiNextGenAPIClient = _a;
GeminiNextGenAPIClient.GeminiNextGenAPIClientError = GeminiNextGenAPIClientError;
GeminiNextGenAPIClient.APIError = APIError;
GeminiNextGenAPIClient.APIConnectionError = APIConnectionError;
GeminiNextGenAPIClient.APIConnectionTimeoutError = APIConnectionTimeoutError;
GeminiNextGenAPIClient.APIUserAbortError = APIUserAbortError;
GeminiNextGenAPIClient.NotFoundError = NotFoundError;
GeminiNextGenAPIClient.ConflictError = ConflictError;
GeminiNextGenAPIClient.RateLimitError = RateLimitError;
GeminiNextGenAPIClient.BadRequestError = BadRequestError;
GeminiNextGenAPIClient.AuthenticationError = AuthenticationError;
GeminiNextGenAPIClient.InternalServerError = InternalServerError;
GeminiNextGenAPIClient.PermissionDeniedError = PermissionDeniedError;
GeminiNextGenAPIClient.UnprocessableEntityError = UnprocessableEntityError;
GeminiNextGenAPIClient.toFile = toFile;
GeminiNextGenAPIClient.Interactions = Interactions;
GeminiNextGenAPIClient.Webhooks = Webhooks;
GeminiNextGenAPIClient.Agents = Agents;
var GOOGLE_API_KEY_HEADER = "x-goog-api-key";
var REQUIRED_VERTEX_AI_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
var NodeAuth = class {
  static {
    __name(this, "NodeAuth");
  }
  constructor(opts) {
    if (opts.apiKey !== void 0) {
      this.apiKey = opts.apiKey;
      return;
    }
    const vertexAuthOptions = buildGoogleAuthOptions(opts.googleAuthOptions);
    this.googleAuth = new import_google_auth_library.GoogleAuth(vertexAuthOptions);
  }
  async addAuthHeaders(headers, url) {
    if (this.apiKey !== void 0) {
      if (this.apiKey.startsWith("auth_tokens/")) {
        throw new Error("Ephemeral tokens are only supported by the live API.");
      }
      this.addKeyHeader(headers);
      return;
    }
    return this.addGoogleAuthHeaders(headers, url);
  }
  addKeyHeader(headers) {
    if (headers.get(GOOGLE_API_KEY_HEADER) !== null) {
      return;
    }
    if (this.apiKey === void 0) {
      throw new Error("Trying to set API key header but apiKey is not set");
    }
    headers.append(GOOGLE_API_KEY_HEADER, this.apiKey);
  }
  async addGoogleAuthHeaders(headers, url) {
    if (this.googleAuth === void 0) {
      throw new Error("Trying to set google-auth headers but googleAuth is unset");
    }
    const authHeaders = await this.googleAuth.getRequestHeaders(url);
    for (const [key, value] of authHeaders) {
      if (headers.get(key) !== null) {
        continue;
      }
      headers.append(key, value);
    }
  }
};
function buildGoogleAuthOptions(googleAuthOptions) {
  let authOptions;
  if (!googleAuthOptions) {
    authOptions = {
      scopes: [REQUIRED_VERTEX_AI_SCOPE]
    };
    return authOptions;
  } else {
    authOptions = googleAuthOptions;
    if (!authOptions.scopes) {
      authOptions.scopes = [REQUIRED_VERTEX_AI_SCOPE];
      return authOptions;
    } else if (typeof authOptions.scopes === "string" && authOptions.scopes !== REQUIRED_VERTEX_AI_SCOPE || Array.isArray(authOptions.scopes) && authOptions.scopes.indexOf(REQUIRED_VERTEX_AI_SCOPE) < 0) {
      throw new Error(`Invalid auth scopes. Scopes must include: ${REQUIRED_VERTEX_AI_SCOPE}`);
    }
    return authOptions;
  }
}
__name(buildGoogleAuthOptions, "buildGoogleAuthOptions");
var NodeDownloader = class {
  static {
    __name(this, "NodeDownloader");
  }
  async download(params, apiClient) {
    if (params.downloadPath) {
      const response = await downloadFile(params, apiClient);
      if (response instanceof HttpResponse) {
        const writer = createWriteStream(params.downloadPath);
        const body = Readable.fromWeb(response.responseInternal.body);
        body.pipe(writer);
        await finished(writer);
      } else {
        try {
          await writeFile(params.downloadPath, response, {
            encoding: "base64"
          });
        } catch (error) {
          throw new Error(`Failed to write file to ${params.downloadPath}: ${error}`);
        }
      }
    }
  }
};
async function downloadFile(params, apiClient) {
  var _a2, _b, _c;
  const name = tFileName(params.file);
  if (name !== void 0) {
    return await apiClient.request({
      path: `files/${name}:download`,
      httpMethod: "GET",
      queryParams: {
        "alt": "media"
      },
      httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
      abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
    });
  } else if (isGeneratedVideo(params.file)) {
    const videoBytes = (_c = params.file.video) === null || _c === void 0 ? void 0 : _c.videoBytes;
    if (typeof videoBytes === "string") {
      return videoBytes;
    } else {
      throw new Error("Failed to download generated video, Uri or videoBytes not found.");
    }
  } else if (isVideo(params.file)) {
    const videoBytes = params.file.videoBytes;
    if (typeof videoBytes === "string") {
      return videoBytes;
    } else {
      throw new Error("Failed to download video, Uri or videoBytes not found.");
    }
  } else {
    throw new Error("Unsupported file type");
  }
}
__name(downloadFile, "downloadFile");
var NodeWebSocketFactory = class {
  static {
    __name(this, "NodeWebSocketFactory");
  }
  create(url, headers, callbacks) {
    return new NodeWebSocket(url, headers, callbacks);
  }
};
var NodeWebSocket = class {
  static {
    __name(this, "NodeWebSocket");
  }
  constructor(url, headers, callbacks) {
    this.url = url;
    this.headers = headers;
    this.callbacks = callbacks;
  }
  connect() {
    this.ws = new import_websocket.default(this.url, { headers: this.headers });
    this.ws.onopen = this.callbacks.onopen;
    this.ws.onerror = this.callbacks.onerror;
    this.ws.onclose = this.callbacks.onclose;
    this.ws.onmessage = this.callbacks.onmessage;
  }
  send(message) {
    if (this.ws === void 0) {
      throw new Error("WebSocket is not connected");
    }
    this.ws.send(message);
  }
  close() {
    if (this.ws === void 0) {
      throw new Error("WebSocket is not connected");
    }
    this.ws.close();
  }
};
function cancelTuningJobParametersToMldev(fromObject, _rootObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["_url", "name"], fromName);
  }
  return toObject;
}
__name(cancelTuningJobParametersToMldev, "cancelTuningJobParametersToMldev");
function cancelTuningJobParametersToVertex(fromObject, _rootObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["_url", "name"], fromName);
  }
  return toObject;
}
__name(cancelTuningJobParametersToVertex, "cancelTuningJobParametersToVertex");
function cancelTuningJobResponseFromMldev(fromObject, _rootObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  return toObject;
}
__name(cancelTuningJobResponseFromMldev, "cancelTuningJobResponseFromMldev");
function cancelTuningJobResponseFromVertex(fromObject, _rootObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  return toObject;
}
__name(cancelTuningJobResponseFromVertex, "cancelTuningJobResponseFromVertex");
function createTuningJobConfigToMldev(fromObject, parentObject, _rootObject) {
  const toObject = {};
  if (getValueByPath(fromObject, ["validationDataset"]) !== void 0) {
    throw new Error("validationDataset parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromTunedModelDisplayName = getValueByPath(fromObject, [
    "tunedModelDisplayName"
  ]);
  if (parentObject !== void 0 && fromTunedModelDisplayName != null) {
    setValueByPath(parentObject, ["displayName"], fromTunedModelDisplayName);
  }
  if (getValueByPath(fromObject, ["description"]) !== void 0) {
    throw new Error("description parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromEpochCount = getValueByPath(fromObject, ["epochCount"]);
  if (parentObject !== void 0 && fromEpochCount != null) {
    setValueByPath(parentObject, ["tuningTask", "hyperparameters", "epochCount"], fromEpochCount);
  }
  const fromLearningRateMultiplier = getValueByPath(fromObject, [
    "learningRateMultiplier"
  ]);
  if (fromLearningRateMultiplier != null) {
    setValueByPath(toObject, ["tuningTask", "hyperparameters", "learningRateMultiplier"], fromLearningRateMultiplier);
  }
  if (getValueByPath(fromObject, ["exportLastCheckpointOnly"]) !== void 0) {
    throw new Error("exportLastCheckpointOnly parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["preTunedModelCheckpointId"]) !== void 0) {
    throw new Error("preTunedModelCheckpointId parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["adapterSize"]) !== void 0) {
    throw new Error("adapterSize parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["tuningMode"]) !== void 0) {
    throw new Error("tuningMode parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["customBaseModel"]) !== void 0) {
    throw new Error("customBaseModel parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromBatchSize = getValueByPath(fromObject, ["batchSize"]);
  if (parentObject !== void 0 && fromBatchSize != null) {
    setValueByPath(parentObject, ["tuningTask", "hyperparameters", "batchSize"], fromBatchSize);
  }
  const fromLearningRate = getValueByPath(fromObject, ["learningRate"]);
  if (parentObject !== void 0 && fromLearningRate != null) {
    setValueByPath(parentObject, ["tuningTask", "hyperparameters", "learningRate"], fromLearningRate);
  }
  if (getValueByPath(fromObject, ["labels"]) !== void 0) {
    throw new Error("labels parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["beta"]) !== void 0) {
    throw new Error("beta parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["baseTeacherModel"]) !== void 0) {
    throw new Error("baseTeacherModel parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["tunedTeacherModelSource"]) !== void 0) {
    throw new Error("tunedTeacherModelSource parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["sftLossWeightMultiplier"]) !== void 0) {
    throw new Error("sftLossWeightMultiplier parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["outputUri"]) !== void 0) {
    throw new Error("outputUri parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["encryptionSpec"]) !== void 0) {
    throw new Error("encryptionSpec parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  return toObject;
}
__name(createTuningJobConfigToMldev, "createTuningJobConfigToMldev");
function createTuningJobConfigToVertex(fromObject, parentObject, rootObject) {
  const toObject = {};
  let discriminatorValidationDataset = getValueByPath(rootObject, [
    "config",
    "method"
  ]);
  if (discriminatorValidationDataset === void 0) {
    discriminatorValidationDataset = "SUPERVISED_FINE_TUNING";
  }
  if (discriminatorValidationDataset === "SUPERVISED_FINE_TUNING") {
    const fromValidationDataset = getValueByPath(fromObject, [
      "validationDataset"
    ]);
    if (parentObject !== void 0 && fromValidationDataset != null) {
      setValueByPath(parentObject, ["supervisedTuningSpec"], tuningValidationDatasetToVertex(fromValidationDataset));
    }
  } else if (discriminatorValidationDataset === "PREFERENCE_TUNING") {
    const fromValidationDataset = getValueByPath(fromObject, [
      "validationDataset"
    ]);
    if (parentObject !== void 0 && fromValidationDataset != null) {
      setValueByPath(parentObject, ["preferenceOptimizationSpec"], tuningValidationDatasetToVertex(fromValidationDataset));
    }
  } else if (discriminatorValidationDataset === "DISTILLATION") {
    const fromValidationDataset = getValueByPath(fromObject, [
      "validationDataset"
    ]);
    if (parentObject !== void 0 && fromValidationDataset != null) {
      setValueByPath(parentObject, ["distillationSpec"], tuningValidationDatasetToVertex(fromValidationDataset));
    }
  }
  const fromTunedModelDisplayName = getValueByPath(fromObject, [
    "tunedModelDisplayName"
  ]);
  if (parentObject !== void 0 && fromTunedModelDisplayName != null) {
    setValueByPath(parentObject, ["tunedModelDisplayName"], fromTunedModelDisplayName);
  }
  const fromDescription = getValueByPath(fromObject, ["description"]);
  if (parentObject !== void 0 && fromDescription != null) {
    setValueByPath(parentObject, ["description"], fromDescription);
  }
  let discriminatorEpochCount = getValueByPath(rootObject, [
    "config",
    "method"
  ]);
  if (discriminatorEpochCount === void 0) {
    discriminatorEpochCount = "SUPERVISED_FINE_TUNING";
  }
  if (discriminatorEpochCount === "SUPERVISED_FINE_TUNING") {
    const fromEpochCount = getValueByPath(fromObject, ["epochCount"]);
    if (parentObject !== void 0 && fromEpochCount != null) {
      setValueByPath(parentObject, ["supervisedTuningSpec", "hyperParameters", "epochCount"], fromEpochCount);
    }
  } else if (discriminatorEpochCount === "PREFERENCE_TUNING") {
    const fromEpochCount = getValueByPath(fromObject, ["epochCount"]);
    if (parentObject !== void 0 && fromEpochCount != null) {
      setValueByPath(parentObject, ["preferenceOptimizationSpec", "hyperParameters", "epochCount"], fromEpochCount);
    }
  } else if (discriminatorEpochCount === "DISTILLATION") {
    const fromEpochCount = getValueByPath(fromObject, ["epochCount"]);
    if (parentObject !== void 0 && fromEpochCount != null) {
      setValueByPath(parentObject, ["distillationSpec", "hyperParameters", "epochCount"], fromEpochCount);
    }
  }
  let discriminatorLearningRateMultiplier = getValueByPath(rootObject, [
    "config",
    "method"
  ]);
  if (discriminatorLearningRateMultiplier === void 0) {
    discriminatorLearningRateMultiplier = "SUPERVISED_FINE_TUNING";
  }
  if (discriminatorLearningRateMultiplier === "SUPERVISED_FINE_TUNING") {
    const fromLearningRateMultiplier = getValueByPath(fromObject, [
      "learningRateMultiplier"
    ]);
    if (parentObject !== void 0 && fromLearningRateMultiplier != null) {
      setValueByPath(parentObject, ["supervisedTuningSpec", "hyperParameters", "learningRateMultiplier"], fromLearningRateMultiplier);
    }
  } else if (discriminatorLearningRateMultiplier === "PREFERENCE_TUNING") {
    const fromLearningRateMultiplier = getValueByPath(fromObject, [
      "learningRateMultiplier"
    ]);
    if (parentObject !== void 0 && fromLearningRateMultiplier != null) {
      setValueByPath(parentObject, [
        "preferenceOptimizationSpec",
        "hyperParameters",
        "learningRateMultiplier"
      ], fromLearningRateMultiplier);
    }
  } else if (discriminatorLearningRateMultiplier === "DISTILLATION") {
    const fromLearningRateMultiplier = getValueByPath(fromObject, [
      "learningRateMultiplier"
    ]);
    if (parentObject !== void 0 && fromLearningRateMultiplier != null) {
      setValueByPath(parentObject, ["distillationSpec", "hyperParameters", "learningRateMultiplier"], fromLearningRateMultiplier);
    }
  }
  let discriminatorExportLastCheckpointOnly = getValueByPath(rootObject, ["config", "method"]);
  if (discriminatorExportLastCheckpointOnly === void 0) {
    discriminatorExportLastCheckpointOnly = "SUPERVISED_FINE_TUNING";
  }
  if (discriminatorExportLastCheckpointOnly === "SUPERVISED_FINE_TUNING") {
    const fromExportLastCheckpointOnly = getValueByPath(fromObject, [
      "exportLastCheckpointOnly"
    ]);
    if (parentObject !== void 0 && fromExportLastCheckpointOnly != null) {
      setValueByPath(parentObject, ["supervisedTuningSpec", "exportLastCheckpointOnly"], fromExportLastCheckpointOnly);
    }
  } else if (discriminatorExportLastCheckpointOnly === "PREFERENCE_TUNING") {
    const fromExportLastCheckpointOnly = getValueByPath(fromObject, [
      "exportLastCheckpointOnly"
    ]);
    if (parentObject !== void 0 && fromExportLastCheckpointOnly != null) {
      setValueByPath(parentObject, ["preferenceOptimizationSpec", "exportLastCheckpointOnly"], fromExportLastCheckpointOnly);
    }
  } else if (discriminatorExportLastCheckpointOnly === "DISTILLATION") {
    const fromExportLastCheckpointOnly = getValueByPath(fromObject, [
      "exportLastCheckpointOnly"
    ]);
    if (parentObject !== void 0 && fromExportLastCheckpointOnly != null) {
      setValueByPath(parentObject, ["distillationSpec", "exportLastCheckpointOnly"], fromExportLastCheckpointOnly);
    }
  }
  let discriminatorAdapterSize = getValueByPath(rootObject, [
    "config",
    "method"
  ]);
  if (discriminatorAdapterSize === void 0) {
    discriminatorAdapterSize = "SUPERVISED_FINE_TUNING";
  }
  if (discriminatorAdapterSize === "SUPERVISED_FINE_TUNING") {
    const fromAdapterSize = getValueByPath(fromObject, ["adapterSize"]);
    if (parentObject !== void 0 && fromAdapterSize != null) {
      setValueByPath(parentObject, ["supervisedTuningSpec", "hyperParameters", "adapterSize"], fromAdapterSize);
    }
  } else if (discriminatorAdapterSize === "PREFERENCE_TUNING") {
    const fromAdapterSize = getValueByPath(fromObject, ["adapterSize"]);
    if (parentObject !== void 0 && fromAdapterSize != null) {
      setValueByPath(parentObject, ["preferenceOptimizationSpec", "hyperParameters", "adapterSize"], fromAdapterSize);
    }
  } else if (discriminatorAdapterSize === "DISTILLATION") {
    const fromAdapterSize = getValueByPath(fromObject, ["adapterSize"]);
    if (parentObject !== void 0 && fromAdapterSize != null) {
      setValueByPath(parentObject, ["distillationSpec", "hyperParameters", "adapterSize"], fromAdapterSize);
    }
  }
  let discriminatorTuningMode = getValueByPath(rootObject, [
    "config",
    "method"
  ]);
  if (discriminatorTuningMode === void 0) {
    discriminatorTuningMode = "SUPERVISED_FINE_TUNING";
  }
  if (discriminatorTuningMode === "SUPERVISED_FINE_TUNING") {
    const fromTuningMode = getValueByPath(fromObject, ["tuningMode"]);
    if (parentObject !== void 0 && fromTuningMode != null) {
      setValueByPath(parentObject, ["supervisedTuningSpec", "tuningMode"], fromTuningMode);
    }
  } else if (discriminatorTuningMode === "DISTILLATION") {
    const fromTuningMode = getValueByPath(fromObject, ["tuningMode"]);
    if (parentObject !== void 0 && fromTuningMode != null) {
      setValueByPath(parentObject, ["distillationSpec", "tuningMode"], fromTuningMode);
    }
  }
  const fromCustomBaseModel = getValueByPath(fromObject, [
    "customBaseModel"
  ]);
  if (parentObject !== void 0 && fromCustomBaseModel != null) {
    setValueByPath(parentObject, ["customBaseModel"], fromCustomBaseModel);
  }
  let discriminatorBatchSize = getValueByPath(rootObject, [
    "config",
    "method"
  ]);
  if (discriminatorBatchSize === void 0) {
    discriminatorBatchSize = "SUPERVISED_FINE_TUNING";
  }
  if (discriminatorBatchSize === "SUPERVISED_FINE_TUNING") {
    const fromBatchSize = getValueByPath(fromObject, ["batchSize"]);
    if (parentObject !== void 0 && fromBatchSize != null) {
      setValueByPath(parentObject, ["supervisedTuningSpec", "hyperParameters", "batchSize"], fromBatchSize);
    }
  } else if (discriminatorBatchSize === "DISTILLATION") {
    const fromBatchSize = getValueByPath(fromObject, ["batchSize"]);
    if (parentObject !== void 0 && fromBatchSize != null) {
      setValueByPath(parentObject, ["distillationSpec", "hyperParameters", "batchSize"], fromBatchSize);
    }
  }
  let discriminatorLearningRate = getValueByPath(rootObject, [
    "config",
    "method"
  ]);
  if (discriminatorLearningRate === void 0) {
    discriminatorLearningRate = "SUPERVISED_FINE_TUNING";
  }
  if (discriminatorLearningRate === "SUPERVISED_FINE_TUNING") {
    const fromLearningRate = getValueByPath(fromObject, [
      "learningRate"
    ]);
    if (parentObject !== void 0 && fromLearningRate != null) {
      setValueByPath(parentObject, ["supervisedTuningSpec", "hyperParameters", "learningRate"], fromLearningRate);
    }
  } else if (discriminatorLearningRate === "DISTILLATION") {
    const fromLearningRate = getValueByPath(fromObject, [
      "learningRate"
    ]);
    if (parentObject !== void 0 && fromLearningRate != null) {
      setValueByPath(parentObject, ["distillationSpec", "hyperParameters", "learningRate"], fromLearningRate);
    }
  }
  const fromLabels = getValueByPath(fromObject, ["labels"]);
  if (parentObject !== void 0 && fromLabels != null) {
    setValueByPath(parentObject, ["labels"], fromLabels);
  }
  const fromBeta = getValueByPath(fromObject, ["beta"]);
  if (parentObject !== void 0 && fromBeta != null) {
    setValueByPath(parentObject, ["preferenceOptimizationSpec", "hyperParameters", "beta"], fromBeta);
  }
  const fromBaseTeacherModel = getValueByPath(fromObject, [
    "baseTeacherModel"
  ]);
  if (parentObject !== void 0 && fromBaseTeacherModel != null) {
    setValueByPath(parentObject, ["distillationSpec", "baseTeacherModel"], fromBaseTeacherModel);
  }
  const fromTunedTeacherModelSource = getValueByPath(fromObject, [
    "tunedTeacherModelSource"
  ]);
  if (parentObject !== void 0 && fromTunedTeacherModelSource != null) {
    setValueByPath(parentObject, ["distillationSpec", "tunedTeacherModelSource"], fromTunedTeacherModelSource);
  }
  const fromSftLossWeightMultiplier = getValueByPath(fromObject, [
    "sftLossWeightMultiplier"
  ]);
  if (parentObject !== void 0 && fromSftLossWeightMultiplier != null) {
    setValueByPath(parentObject, ["distillationSpec", "hyperParameters", "sftLossWeightMultiplier"], fromSftLossWeightMultiplier);
  }
  const fromOutputUri = getValueByPath(fromObject, ["outputUri"]);
  if (parentObject !== void 0 && fromOutputUri != null) {
    setValueByPath(parentObject, ["outputUri"], fromOutputUri);
  }
  const fromEncryptionSpec = getValueByPath(fromObject, [
    "encryptionSpec"
  ]);
  if (parentObject !== void 0 && fromEncryptionSpec != null) {
    setValueByPath(parentObject, ["encryptionSpec"], fromEncryptionSpec);
  }
  return toObject;
}
__name(createTuningJobConfigToVertex, "createTuningJobConfigToVertex");
function createTuningJobParametersPrivateToMldev(fromObject, rootObject) {
  const toObject = {};
  const fromBaseModel = getValueByPath(fromObject, ["baseModel"]);
  if (fromBaseModel != null) {
    setValueByPath(toObject, ["baseModel"], fromBaseModel);
  }
  const fromPreTunedModel = getValueByPath(fromObject, [
    "preTunedModel"
  ]);
  if (fromPreTunedModel != null) {
    setValueByPath(toObject, ["preTunedModel"], fromPreTunedModel);
  }
  const fromTrainingDataset = getValueByPath(fromObject, [
    "trainingDataset"
  ]);
  if (fromTrainingDataset != null) {
    tuningDatasetToMldev(fromTrainingDataset);
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    createTuningJobConfigToMldev(fromConfig, toObject);
  }
  return toObject;
}
__name(createTuningJobParametersPrivateToMldev, "createTuningJobParametersPrivateToMldev");
function createTuningJobParametersPrivateToVertex(fromObject, rootObject) {
  const toObject = {};
  const fromBaseModel = getValueByPath(fromObject, ["baseModel"]);
  if (fromBaseModel != null) {
    setValueByPath(toObject, ["baseModel"], fromBaseModel);
  }
  const fromPreTunedModel = getValueByPath(fromObject, [
    "preTunedModel"
  ]);
  if (fromPreTunedModel != null) {
    setValueByPath(toObject, ["preTunedModel"], fromPreTunedModel);
  }
  const fromTrainingDataset = getValueByPath(fromObject, [
    "trainingDataset"
  ]);
  if (fromTrainingDataset != null) {
    tuningDatasetToVertex(fromTrainingDataset, toObject, rootObject);
  }
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    createTuningJobConfigToVertex(fromConfig, toObject, rootObject);
  }
  return toObject;
}
__name(createTuningJobParametersPrivateToVertex, "createTuningJobParametersPrivateToVertex");
function distillationHyperParametersFromVertex(fromObject, rootObject) {
  const toObject = {};
  const fromAdapterSize = getValueByPath(fromObject, ["adapterSize"]);
  if (fromAdapterSize != null) {
    setValueByPath(toObject, ["adapterSize"], fromAdapterSize);
  }
  const fromEpochCount = getValueByPath(fromObject, ["epochCount"]);
  if (fromEpochCount != null) {
    setValueByPath(toObject, ["epochCount"], fromEpochCount);
  }
  const fromLearningRateMultiplier = getValueByPath(fromObject, [
    "learningRateMultiplier"
  ]);
  if (fromLearningRateMultiplier != null) {
    setValueByPath(toObject, ["learningRateMultiplier"], fromLearningRateMultiplier);
  }
  const fromGenerationConfig = getValueByPath(fromObject, [
    "generationConfig"
  ]);
  if (fromGenerationConfig != null) {
    setValueByPath(toObject, ["generationConfig"], generationConfigFromVertex(fromGenerationConfig));
  }
  const fromLearningRate = getValueByPath(fromObject, ["learningRate"]);
  if (fromLearningRate != null) {
    setValueByPath(toObject, ["learningRate"], fromLearningRate);
  }
  const fromBatchSize = getValueByPath(fromObject, ["batchSize"]);
  if (fromBatchSize != null) {
    setValueByPath(toObject, ["batchSize"], fromBatchSize);
  }
  return toObject;
}
__name(distillationHyperParametersFromVertex, "distillationHyperParametersFromVertex");
function distillationSamplingSpecFromVertex(fromObject, rootObject) {
  const toObject = {};
  const fromBaseTeacherModel = getValueByPath(fromObject, [
    "baseTeacherModel"
  ]);
  if (fromBaseTeacherModel != null) {
    setValueByPath(toObject, ["baseTeacherModel"], fromBaseTeacherModel);
  }
  const fromTunedTeacherModelSource = getValueByPath(fromObject, [
    "tunedTeacherModelSource"
  ]);
  if (fromTunedTeacherModelSource != null) {
    setValueByPath(toObject, ["tunedTeacherModelSource"], fromTunedTeacherModelSource);
  }
  const fromValidationDatasetUri = getValueByPath(fromObject, [
    "validationDatasetUri"
  ]);
  if (fromValidationDatasetUri != null) {
    setValueByPath(toObject, ["validationDatasetUri"], fromValidationDatasetUri);
  }
  const fromPromptDatasetUri = getValueByPath(fromObject, [
    "promptDatasetUri"
  ]);
  if (fromPromptDatasetUri != null) {
    setValueByPath(toObject, ["promptDatasetUri"], fromPromptDatasetUri);
  }
  const fromHyperparameters = getValueByPath(fromObject, [
    "hyperparameters"
  ]);
  if (fromHyperparameters != null) {
    setValueByPath(toObject, ["hyperparameters"], distillationHyperParametersFromVertex(fromHyperparameters));
  }
  return toObject;
}
__name(distillationSamplingSpecFromVertex, "distillationSamplingSpecFromVertex");
function distillationSpecFromVertex(fromObject, rootObject) {
  const toObject = {};
  const fromPromptDatasetUri = getValueByPath(fromObject, [
    "promptDatasetUri"
  ]);
  if (fromPromptDatasetUri != null) {
    setValueByPath(toObject, ["promptDatasetUri"], fromPromptDatasetUri);
  }
  const fromBaseTeacherModel = getValueByPath(fromObject, [
    "baseTeacherModel"
  ]);
  if (fromBaseTeacherModel != null) {
    setValueByPath(toObject, ["baseTeacherModel"], fromBaseTeacherModel);
  }
  const fromHyperParameters = getValueByPath(fromObject, [
    "hyperParameters"
  ]);
  if (fromHyperParameters != null) {
    setValueByPath(toObject, ["hyperParameters"], distillationHyperParametersFromVertex(fromHyperParameters));
  }
  const fromPipelineRootDirectory = getValueByPath(fromObject, [
    "pipelineRootDirectory"
  ]);
  if (fromPipelineRootDirectory != null) {
    setValueByPath(toObject, ["pipelineRootDirectory"], fromPipelineRootDirectory);
  }
  const fromStudentModel = getValueByPath(fromObject, ["studentModel"]);
  if (fromStudentModel != null) {
    setValueByPath(toObject, ["studentModel"], fromStudentModel);
  }
  const fromTrainingDatasetUri = getValueByPath(fromObject, [
    "trainingDatasetUri"
  ]);
  if (fromTrainingDatasetUri != null) {
    setValueByPath(toObject, ["trainingDatasetUri"], fromTrainingDatasetUri);
  }
  const fromTunedTeacherModelSource = getValueByPath(fromObject, [
    "tunedTeacherModelSource"
  ]);
  if (fromTunedTeacherModelSource != null) {
    setValueByPath(toObject, ["tunedTeacherModelSource"], fromTunedTeacherModelSource);
  }
  const fromValidationDatasetUri = getValueByPath(fromObject, [
    "validationDatasetUri"
  ]);
  if (fromValidationDatasetUri != null) {
    setValueByPath(toObject, ["validationDatasetUri"], fromValidationDatasetUri);
  }
  const fromTuningMode = getValueByPath(fromObject, ["tuningMode"]);
  if (fromTuningMode != null) {
    setValueByPath(toObject, ["tuningMode"], fromTuningMode);
  }
  return toObject;
}
__name(distillationSpecFromVertex, "distillationSpecFromVertex");
function generationConfigFromVertex(fromObject, _rootObject) {
  const toObject = {};
  const fromModelSelectionConfig = getValueByPath(fromObject, [
    "modelConfig"
  ]);
  if (fromModelSelectionConfig != null) {
    setValueByPath(toObject, ["modelSelectionConfig"], fromModelSelectionConfig);
  }
  const fromResponseJsonSchema = getValueByPath(fromObject, [
    "responseJsonSchema"
  ]);
  if (fromResponseJsonSchema != null) {
    setValueByPath(toObject, ["responseJsonSchema"], fromResponseJsonSchema);
  }
  const fromAudioTimestamp = getValueByPath(fromObject, [
    "audioTimestamp"
  ]);
  if (fromAudioTimestamp != null) {
    setValueByPath(toObject, ["audioTimestamp"], fromAudioTimestamp);
  }
  const fromCandidateCount = getValueByPath(fromObject, [
    "candidateCount"
  ]);
  if (fromCandidateCount != null) {
    setValueByPath(toObject, ["candidateCount"], fromCandidateCount);
  }
  const fromEnableAffectiveDialog = getValueByPath(fromObject, [
    "enableAffectiveDialog"
  ]);
  if (fromEnableAffectiveDialog != null) {
    setValueByPath(toObject, ["enableAffectiveDialog"], fromEnableAffectiveDialog);
  }
  const fromFrequencyPenalty = getValueByPath(fromObject, [
    "frequencyPenalty"
  ]);
  if (fromFrequencyPenalty != null) {
    setValueByPath(toObject, ["frequencyPenalty"], fromFrequencyPenalty);
  }
  const fromLogprobs = getValueByPath(fromObject, ["logprobs"]);
  if (fromLogprobs != null) {
    setValueByPath(toObject, ["logprobs"], fromLogprobs);
  }
  const fromMaxOutputTokens = getValueByPath(fromObject, [
    "maxOutputTokens"
  ]);
  if (fromMaxOutputTokens != null) {
    setValueByPath(toObject, ["maxOutputTokens"], fromMaxOutputTokens);
  }
  const fromMediaResolution = getValueByPath(fromObject, [
    "mediaResolution"
  ]);
  if (fromMediaResolution != null) {
    setValueByPath(toObject, ["mediaResolution"], fromMediaResolution);
  }
  const fromPresencePenalty = getValueByPath(fromObject, [
    "presencePenalty"
  ]);
  if (fromPresencePenalty != null) {
    setValueByPath(toObject, ["presencePenalty"], fromPresencePenalty);
  }
  const fromResponseLogprobs = getValueByPath(fromObject, [
    "responseLogprobs"
  ]);
  if (fromResponseLogprobs != null) {
    setValueByPath(toObject, ["responseLogprobs"], fromResponseLogprobs);
  }
  const fromResponseMimeType = getValueByPath(fromObject, [
    "responseMimeType"
  ]);
  if (fromResponseMimeType != null) {
    setValueByPath(toObject, ["responseMimeType"], fromResponseMimeType);
  }
  const fromResponseModalities = getValueByPath(fromObject, [
    "responseModalities"
  ]);
  if (fromResponseModalities != null) {
    setValueByPath(toObject, ["responseModalities"], fromResponseModalities);
  }
  const fromResponseSchema = getValueByPath(fromObject, [
    "responseSchema"
  ]);
  if (fromResponseSchema != null) {
    setValueByPath(toObject, ["responseSchema"], fromResponseSchema);
  }
  const fromRoutingConfig = getValueByPath(fromObject, [
    "routingConfig"
  ]);
  if (fromRoutingConfig != null) {
    setValueByPath(toObject, ["routingConfig"], fromRoutingConfig);
  }
  const fromSeed = getValueByPath(fromObject, ["seed"]);
  if (fromSeed != null) {
    setValueByPath(toObject, ["seed"], fromSeed);
  }
  const fromSpeechConfig = getValueByPath(fromObject, ["speechConfig"]);
  if (fromSpeechConfig != null) {
    setValueByPath(toObject, ["speechConfig"], fromSpeechConfig);
  }
  const fromStopSequences = getValueByPath(fromObject, [
    "stopSequences"
  ]);
  if (fromStopSequences != null) {
    setValueByPath(toObject, ["stopSequences"], fromStopSequences);
  }
  const fromTemperature = getValueByPath(fromObject, ["temperature"]);
  if (fromTemperature != null) {
    setValueByPath(toObject, ["temperature"], fromTemperature);
  }
  const fromThinkingConfig = getValueByPath(fromObject, [
    "thinkingConfig"
  ]);
  if (fromThinkingConfig != null) {
    setValueByPath(toObject, ["thinkingConfig"], fromThinkingConfig);
  }
  const fromTopK = getValueByPath(fromObject, ["topK"]);
  if (fromTopK != null) {
    setValueByPath(toObject, ["topK"], fromTopK);
  }
  const fromTopP = getValueByPath(fromObject, ["topP"]);
  if (fromTopP != null) {
    setValueByPath(toObject, ["topP"], fromTopP);
  }
  return toObject;
}
__name(generationConfigFromVertex, "generationConfigFromVertex");
function getTuningJobParametersToMldev(fromObject, _rootObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["_url", "name"], fromName);
  }
  return toObject;
}
__name(getTuningJobParametersToMldev, "getTuningJobParametersToMldev");
function getTuningJobParametersToVertex(fromObject, _rootObject) {
  const toObject = {};
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["_url", "name"], fromName);
  }
  return toObject;
}
__name(getTuningJobParametersToVertex, "getTuningJobParametersToVertex");
function listTuningJobsConfigToVertex(fromObject, parentObject, _rootObject) {
  const toObject = {};
  const fromPageSize = getValueByPath(fromObject, ["pageSize"]);
  if (parentObject !== void 0 && fromPageSize != null) {
    setValueByPath(parentObject, ["_query", "pageSize"], fromPageSize);
  }
  const fromPageToken = getValueByPath(fromObject, ["pageToken"]);
  if (parentObject !== void 0 && fromPageToken != null) {
    setValueByPath(parentObject, ["_query", "pageToken"], fromPageToken);
  }
  const fromFilter = getValueByPath(fromObject, ["filter"]);
  if (parentObject !== void 0 && fromFilter != null) {
    setValueByPath(parentObject, ["_query", "filter"], fromFilter);
  }
  return toObject;
}
__name(listTuningJobsConfigToVertex, "listTuningJobsConfigToVertex");
function listTuningJobsParametersToVertex(fromObject, rootObject) {
  const toObject = {};
  const fromConfig = getValueByPath(fromObject, ["config"]);
  if (fromConfig != null) {
    listTuningJobsConfigToVertex(fromConfig, toObject);
  }
  return toObject;
}
__name(listTuningJobsParametersToVertex, "listTuningJobsParametersToVertex");
function listTuningJobsResponseFromVertex(fromObject, rootObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromNextPageToken = getValueByPath(fromObject, [
    "nextPageToken"
  ]);
  if (fromNextPageToken != null) {
    setValueByPath(toObject, ["nextPageToken"], fromNextPageToken);
  }
  const fromTuningJobs = getValueByPath(fromObject, ["tuningJobs"]);
  if (fromTuningJobs != null) {
    let transformedList = fromTuningJobs;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return tuningJobFromVertex(item);
      });
    }
    setValueByPath(toObject, ["tuningJobs"], transformedList);
  }
  return toObject;
}
__name(listTuningJobsResponseFromVertex, "listTuningJobsResponseFromVertex");
function tunedModelFromMldev(fromObject, _rootObject) {
  const toObject = {};
  const fromModel = getValueByPath(fromObject, ["name"]);
  if (fromModel != null) {
    setValueByPath(toObject, ["model"], fromModel);
  }
  const fromEndpoint = getValueByPath(fromObject, ["name"]);
  if (fromEndpoint != null) {
    setValueByPath(toObject, ["endpoint"], fromEndpoint);
  }
  return toObject;
}
__name(tunedModelFromMldev, "tunedModelFromMldev");
function tuningDatasetToMldev(fromObject, _rootObject) {
  const toObject = {};
  if (getValueByPath(fromObject, ["gcsUri"]) !== void 0) {
    throw new Error("gcsUri parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  if (getValueByPath(fromObject, ["vertexDatasetResource"]) !== void 0) {
    throw new Error("vertexDatasetResource parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
  }
  const fromExamples = getValueByPath(fromObject, ["examples"]);
  if (fromExamples != null) {
    let transformedList = fromExamples;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["examples", "examples"], transformedList);
  }
  return toObject;
}
__name(tuningDatasetToMldev, "tuningDatasetToMldev");
function tuningDatasetToVertex(fromObject, parentObject, rootObject) {
  const toObject = {};
  let discriminatorGcsUri = getValueByPath(rootObject, [
    "config",
    "method"
  ]);
  if (discriminatorGcsUri === void 0) {
    discriminatorGcsUri = "SUPERVISED_FINE_TUNING";
  }
  if (discriminatorGcsUri === "SUPERVISED_FINE_TUNING") {
    const fromGcsUri = getValueByPath(fromObject, ["gcsUri"]);
    if (parentObject !== void 0 && fromGcsUri != null) {
      setValueByPath(parentObject, ["supervisedTuningSpec", "trainingDatasetUri"], fromGcsUri);
    }
  } else if (discriminatorGcsUri === "PREFERENCE_TUNING") {
    const fromGcsUri = getValueByPath(fromObject, ["gcsUri"]);
    if (parentObject !== void 0 && fromGcsUri != null) {
      setValueByPath(parentObject, ["preferenceOptimizationSpec", "trainingDatasetUri"], fromGcsUri);
    }
  } else if (discriminatorGcsUri === "DISTILLATION") {
    const fromGcsUri = getValueByPath(fromObject, ["gcsUri"]);
    if (parentObject !== void 0 && fromGcsUri != null) {
      setValueByPath(parentObject, ["distillationSpec", "promptDatasetUri"], fromGcsUri);
    }
  }
  let discriminatorVertexDatasetResource = getValueByPath(rootObject, [
    "config",
    "method"
  ]);
  if (discriminatorVertexDatasetResource === void 0) {
    discriminatorVertexDatasetResource = "SUPERVISED_FINE_TUNING";
  }
  if (discriminatorVertexDatasetResource === "SUPERVISED_FINE_TUNING") {
    const fromVertexDatasetResource = getValueByPath(fromObject, [
      "vertexDatasetResource"
    ]);
    if (parentObject !== void 0 && fromVertexDatasetResource != null) {
      setValueByPath(parentObject, ["supervisedTuningSpec", "trainingDatasetUri"], fromVertexDatasetResource);
    }
  } else if (discriminatorVertexDatasetResource === "PREFERENCE_TUNING") {
    const fromVertexDatasetResource = getValueByPath(fromObject, [
      "vertexDatasetResource"
    ]);
    if (parentObject !== void 0 && fromVertexDatasetResource != null) {
      setValueByPath(parentObject, ["preferenceOptimizationSpec", "trainingDatasetUri"], fromVertexDatasetResource);
    }
  } else if (discriminatorVertexDatasetResource === "DISTILLATION") {
    const fromVertexDatasetResource = getValueByPath(fromObject, [
      "vertexDatasetResource"
    ]);
    if (parentObject !== void 0 && fromVertexDatasetResource != null) {
      setValueByPath(parentObject, ["distillationSpec", "promptDatasetUri"], fromVertexDatasetResource);
    }
  }
  if (getValueByPath(fromObject, ["examples"]) !== void 0) {
    throw new Error("examples parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.");
  }
  return toObject;
}
__name(tuningDatasetToVertex, "tuningDatasetToVertex");
function tuningJobFromMldev(fromObject, rootObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["name"], fromName);
  }
  const fromState = getValueByPath(fromObject, ["state"]);
  if (fromState != null) {
    setValueByPath(toObject, ["state"], tTuningJobStatus(fromState));
  }
  const fromCreateTime = getValueByPath(fromObject, ["createTime"]);
  if (fromCreateTime != null) {
    setValueByPath(toObject, ["createTime"], fromCreateTime);
  }
  const fromStartTime = getValueByPath(fromObject, [
    "tuningTask",
    "startTime"
  ]);
  if (fromStartTime != null) {
    setValueByPath(toObject, ["startTime"], fromStartTime);
  }
  const fromEndTime = getValueByPath(fromObject, [
    "tuningTask",
    "completeTime"
  ]);
  if (fromEndTime != null) {
    setValueByPath(toObject, ["endTime"], fromEndTime);
  }
  const fromUpdateTime = getValueByPath(fromObject, ["updateTime"]);
  if (fromUpdateTime != null) {
    setValueByPath(toObject, ["updateTime"], fromUpdateTime);
  }
  const fromDescription = getValueByPath(fromObject, ["description"]);
  if (fromDescription != null) {
    setValueByPath(toObject, ["description"], fromDescription);
  }
  const fromBaseModel = getValueByPath(fromObject, ["baseModel"]);
  if (fromBaseModel != null) {
    setValueByPath(toObject, ["baseModel"], fromBaseModel);
  }
  const fromTunedModel = getValueByPath(fromObject, ["_self"]);
  if (fromTunedModel != null) {
    setValueByPath(toObject, ["tunedModel"], tunedModelFromMldev(fromTunedModel));
  }
  return toObject;
}
__name(tuningJobFromMldev, "tuningJobFromMldev");
function tuningJobFromVertex(fromObject, rootObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["name"], fromName);
  }
  const fromState = getValueByPath(fromObject, ["state"]);
  if (fromState != null) {
    setValueByPath(toObject, ["state"], tTuningJobStatus(fromState));
  }
  const fromCreateTime = getValueByPath(fromObject, ["createTime"]);
  if (fromCreateTime != null) {
    setValueByPath(toObject, ["createTime"], fromCreateTime);
  }
  const fromStartTime = getValueByPath(fromObject, ["startTime"]);
  if (fromStartTime != null) {
    setValueByPath(toObject, ["startTime"], fromStartTime);
  }
  const fromEndTime = getValueByPath(fromObject, ["endTime"]);
  if (fromEndTime != null) {
    setValueByPath(toObject, ["endTime"], fromEndTime);
  }
  const fromUpdateTime = getValueByPath(fromObject, ["updateTime"]);
  if (fromUpdateTime != null) {
    setValueByPath(toObject, ["updateTime"], fromUpdateTime);
  }
  const fromError = getValueByPath(fromObject, ["error"]);
  if (fromError != null) {
    setValueByPath(toObject, ["error"], fromError);
  }
  const fromDescription = getValueByPath(fromObject, ["description"]);
  if (fromDescription != null) {
    setValueByPath(toObject, ["description"], fromDescription);
  }
  const fromBaseModel = getValueByPath(fromObject, ["baseModel"]);
  if (fromBaseModel != null) {
    setValueByPath(toObject, ["baseModel"], fromBaseModel);
  }
  const fromTunedModel = getValueByPath(fromObject, ["tunedModel"]);
  if (fromTunedModel != null) {
    setValueByPath(toObject, ["tunedModel"], fromTunedModel);
  }
  const fromPreTunedModel = getValueByPath(fromObject, [
    "preTunedModel"
  ]);
  if (fromPreTunedModel != null) {
    setValueByPath(toObject, ["preTunedModel"], fromPreTunedModel);
  }
  const fromSupervisedTuningSpec = getValueByPath(fromObject, [
    "supervisedTuningSpec"
  ]);
  if (fromSupervisedTuningSpec != null) {
    setValueByPath(toObject, ["supervisedTuningSpec"], fromSupervisedTuningSpec);
  }
  const fromPreferenceOptimizationSpec = getValueByPath(fromObject, [
    "preferenceOptimizationSpec"
  ]);
  if (fromPreferenceOptimizationSpec != null) {
    setValueByPath(toObject, ["preferenceOptimizationSpec"], fromPreferenceOptimizationSpec);
  }
  const fromDistillationSpec = getValueByPath(fromObject, [
    "distillationSpec"
  ]);
  if (fromDistillationSpec != null) {
    setValueByPath(toObject, ["distillationSpec"], distillationSpecFromVertex(fromDistillationSpec));
  }
  const fromTuningDataStats = getValueByPath(fromObject, [
    "tuningDataStats"
  ]);
  if (fromTuningDataStats != null) {
    setValueByPath(toObject, ["tuningDataStats"], fromTuningDataStats);
  }
  const fromEncryptionSpec = getValueByPath(fromObject, [
    "encryptionSpec"
  ]);
  if (fromEncryptionSpec != null) {
    setValueByPath(toObject, ["encryptionSpec"], fromEncryptionSpec);
  }
  const fromPartnerModelTuningSpec = getValueByPath(fromObject, [
    "partnerModelTuningSpec"
  ]);
  if (fromPartnerModelTuningSpec != null) {
    setValueByPath(toObject, ["partnerModelTuningSpec"], fromPartnerModelTuningSpec);
  }
  const fromCustomBaseModel = getValueByPath(fromObject, [
    "customBaseModel"
  ]);
  if (fromCustomBaseModel != null) {
    setValueByPath(toObject, ["customBaseModel"], fromCustomBaseModel);
  }
  const fromEvaluateDatasetRuns = getValueByPath(fromObject, [
    "evaluateDatasetRuns"
  ]);
  if (fromEvaluateDatasetRuns != null) {
    let transformedList = fromEvaluateDatasetRuns;
    if (Array.isArray(transformedList)) {
      transformedList = transformedList.map((item) => {
        return item;
      });
    }
    setValueByPath(toObject, ["evaluateDatasetRuns"], transformedList);
  }
  const fromExperiment = getValueByPath(fromObject, ["experiment"]);
  if (fromExperiment != null) {
    setValueByPath(toObject, ["experiment"], fromExperiment);
  }
  const fromFullFineTuningSpec = getValueByPath(fromObject, [
    "fullFineTuningSpec"
  ]);
  if (fromFullFineTuningSpec != null) {
    setValueByPath(toObject, ["fullFineTuningSpec"], fromFullFineTuningSpec);
  }
  const fromLabels = getValueByPath(fromObject, ["labels"]);
  if (fromLabels != null) {
    setValueByPath(toObject, ["labels"], fromLabels);
  }
  const fromOutputUri = getValueByPath(fromObject, ["outputUri"]);
  if (fromOutputUri != null) {
    setValueByPath(toObject, ["outputUri"], fromOutputUri);
  }
  const fromPipelineJob = getValueByPath(fromObject, ["pipelineJob"]);
  if (fromPipelineJob != null) {
    setValueByPath(toObject, ["pipelineJob"], fromPipelineJob);
  }
  const fromServiceAccount = getValueByPath(fromObject, [
    "serviceAccount"
  ]);
  if (fromServiceAccount != null) {
    setValueByPath(toObject, ["serviceAccount"], fromServiceAccount);
  }
  const fromTunedModelDisplayName = getValueByPath(fromObject, [
    "tunedModelDisplayName"
  ]);
  if (fromTunedModelDisplayName != null) {
    setValueByPath(toObject, ["tunedModelDisplayName"], fromTunedModelDisplayName);
  }
  const fromTuningJobState = getValueByPath(fromObject, [
    "tuningJobState"
  ]);
  if (fromTuningJobState != null) {
    setValueByPath(toObject, ["tuningJobState"], fromTuningJobState);
  }
  const fromVeoTuningSpec = getValueByPath(fromObject, [
    "veoTuningSpec"
  ]);
  if (fromVeoTuningSpec != null) {
    setValueByPath(toObject, ["veoTuningSpec"], fromVeoTuningSpec);
  }
  const fromTuningJobMetadata = getValueByPath(fromObject, [
    "tuningJobMetadata"
  ]);
  if (fromTuningJobMetadata != null) {
    setValueByPath(toObject, ["tuningJobMetadata"], fromTuningJobMetadata);
  }
  const fromVeoLoraTuningSpec = getValueByPath(fromObject, [
    "veoLoraTuningSpec"
  ]);
  if (fromVeoLoraTuningSpec != null) {
    setValueByPath(toObject, ["veoLoraTuningSpec"], fromVeoLoraTuningSpec);
  }
  const fromDistillationSamplingSpec = getValueByPath(fromObject, [
    "distillationSamplingSpec"
  ]);
  if (fromDistillationSamplingSpec != null) {
    setValueByPath(toObject, ["distillationSamplingSpec"], distillationSamplingSpecFromVertex(fromDistillationSamplingSpec));
  }
  return toObject;
}
__name(tuningJobFromVertex, "tuningJobFromVertex");
function tuningOperationFromMldev(fromObject, _rootObject) {
  const toObject = {};
  const fromSdkHttpResponse = getValueByPath(fromObject, [
    "sdkHttpResponse"
  ]);
  if (fromSdkHttpResponse != null) {
    setValueByPath(toObject, ["sdkHttpResponse"], fromSdkHttpResponse);
  }
  const fromName = getValueByPath(fromObject, ["name"]);
  if (fromName != null) {
    setValueByPath(toObject, ["name"], fromName);
  }
  const fromMetadata = getValueByPath(fromObject, ["metadata"]);
  if (fromMetadata != null) {
    setValueByPath(toObject, ["metadata"], fromMetadata);
  }
  const fromDone = getValueByPath(fromObject, ["done"]);
  if (fromDone != null) {
    setValueByPath(toObject, ["done"], fromDone);
  }
  const fromError = getValueByPath(fromObject, ["error"]);
  if (fromError != null) {
    setValueByPath(toObject, ["error"], fromError);
  }
  return toObject;
}
__name(tuningOperationFromMldev, "tuningOperationFromMldev");
function tuningValidationDatasetToVertex(fromObject, _rootObject) {
  const toObject = {};
  const fromGcsUri = getValueByPath(fromObject, ["gcsUri"]);
  if (fromGcsUri != null) {
    setValueByPath(toObject, ["validationDatasetUri"], fromGcsUri);
  }
  const fromVertexDatasetResource = getValueByPath(fromObject, [
    "vertexDatasetResource"
  ]);
  if (fromVertexDatasetResource != null) {
    setValueByPath(toObject, ["validationDatasetUri"], fromVertexDatasetResource);
  }
  return toObject;
}
__name(tuningValidationDatasetToVertex, "tuningValidationDatasetToVertex");
var Tunings = class extends BaseModule {
  static {
    __name(this, "Tunings");
  }
  constructor(apiClient) {
    super();
    this.apiClient = apiClient;
    this.list = async (params = {}) => {
      return new Pager(PagedItem.PAGED_ITEM_TUNING_JOBS, (x) => this.listInternal(x), await this.listInternal(params), params);
    };
    this.get = async (params) => {
      return await this.getInternal(params);
    };
    this.tune = async (params) => {
      var _a2;
      if (this.apiClient.isVertexAI()) {
        if (params.baseModel.startsWith("projects/")) {
          const preTunedModel = {
            tunedModelName: params.baseModel
          };
          if ((_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.preTunedModelCheckpointId) {
            preTunedModel.checkpointId = params.config.preTunedModelCheckpointId;
          }
          const paramsPrivate = Object.assign(Object.assign({}, params), { preTunedModel });
          paramsPrivate.baseModel = void 0;
          return await this.tuneInternal(paramsPrivate);
        } else {
          const paramsPrivate = Object.assign({}, params);
          return await this.tuneInternal(paramsPrivate);
        }
      } else {
        const paramsPrivate = Object.assign({}, params);
        const operation = await this.tuneMldevInternal(paramsPrivate);
        let tunedModelName = "";
        if (operation["metadata"] !== void 0 && operation["metadata"]["tunedModel"] !== void 0) {
          tunedModelName = operation["metadata"]["tunedModel"];
        } else if (operation["name"] !== void 0 && operation["name"].includes("/operations/")) {
          tunedModelName = operation["name"].split("/operations/")[0];
        }
        const tuningJob = {
          name: tunedModelName,
          state: JobState.JOB_STATE_QUEUED
        };
        return tuningJob;
      }
    };
  }
  async getInternal(params) {
    var _a2, _b, _c, _d;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = getTuningJobParametersToVertex(params);
      path2 = formatMap("{name}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "GET",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = tuningJobFromVertex(apiResponse);
        return resp;
      });
    } else {
      const body = getTuningJobParametersToMldev(params);
      path2 = formatMap("{name}", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "GET",
        httpOptions: (_c = params.config) === null || _c === void 0 ? void 0 : _c.httpOptions,
        abortSignal: (_d = params.config) === null || _d === void 0 ? void 0 : _d.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = tuningJobFromMldev(apiResponse);
        return resp;
      });
    }
  }
  async listInternal(params) {
    var _a2, _b;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = listTuningJobsParametersToVertex(params);
      path2 = formatMap("tuningJobs", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "GET",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = listTuningJobsResponseFromVertex(apiResponse);
        const typedResp = new ListTuningJobsResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    } else {
      throw new Error("This method is only supported by the Gemini Enterprise Agent Platform (previously known as Vertex AI).");
    }
  }
  /**
   * Cancels a tuning job.
   *
   * @param params - The parameters for the cancel request.
   * @return The empty response returned by the API.
   *
   * @example
   * ```ts
   * await ai.tunings.cancel({name: '...'}); // The server-generated resource name.
   * ```
   */
  async cancel(params) {
    var _a2, _b, _c, _d;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = cancelTuningJobParametersToVertex(params);
      path2 = formatMap("{name}:cancel", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = cancelTuningJobResponseFromVertex(apiResponse);
        const typedResp = new CancelTuningJobResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    } else {
      const body = cancelTuningJobParametersToMldev(params);
      path2 = formatMap("{name}:cancel", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_c = params.config) === null || _c === void 0 ? void 0 : _c.httpOptions,
        abortSignal: (_d = params.config) === null || _d === void 0 ? void 0 : _d.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = cancelTuningJobResponseFromMldev(apiResponse);
        const typedResp = new CancelTuningJobResponse();
        Object.assign(typedResp, resp);
        return typedResp;
      });
    }
  }
  async tuneInternal(params) {
    var _a2, _b;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      const body = createTuningJobParametersPrivateToVertex(params, params);
      path2 = formatMap("tuningJobs", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = tuningJobFromVertex(apiResponse);
        return resp;
      });
    } else {
      throw new Error("This method is only supported by the Gemini Enterprise Agent Platform (previously known as Vertex AI).");
    }
  }
  async tuneMldevInternal(params) {
    var _a2, _b;
    let response;
    let path2 = "";
    let queryParams = {};
    if (this.apiClient.isVertexAI()) {
      throw new Error("This method is only supported by the Gemini Developer API.");
    } else {
      const body = createTuningJobParametersPrivateToMldev(params);
      path2 = formatMap("tunedModels", body["_url"]);
      queryParams = body["_query"];
      delete body["_url"];
      delete body["_query"];
      response = this.apiClient.request({
        path: path2,
        queryParams,
        body: JSON.stringify(body),
        httpMethod: "POST",
        httpOptions: (_a2 = params.config) === null || _a2 === void 0 ? void 0 : _a2.httpOptions,
        abortSignal: (_b = params.config) === null || _b === void 0 ? void 0 : _b.abortSignal
      }).then((httpResponse) => {
        return httpResponse.json().then((jsonResponse) => {
          const response2 = jsonResponse;
          response2.sdkHttpResponse = {
            headers: httpResponse.headers
          };
          return response2;
        });
      });
      return response.then((apiResponse) => {
        const resp = tuningOperationFromMldev(apiResponse);
        return resp;
      });
    }
  }
};
var MAX_CHUNK_SIZE = 1024 * 1024 * 8;
var MAX_RETRY_COUNT = 3;
var INITIAL_RETRY_DELAY_MS = 1e3;
var DELAY_MULTIPLIER = 2;
var X_GOOG_UPLOAD_STATUS_HEADER_FIELD = "x-goog-upload-status";
async function uploadBlob(file, uploadUrl, apiClient, httpOptions) {
  var _a2;
  const response = await uploadBlobInternal(file, uploadUrl, apiClient, httpOptions);
  const responseJson = await (response === null || response === void 0 ? void 0 : response.json());
  if (((_a2 = response === null || response === void 0 ? void 0 : response.headers) === null || _a2 === void 0 ? void 0 : _a2[X_GOOG_UPLOAD_STATUS_HEADER_FIELD]) !== "final") {
    throw new Error("Failed to upload file: Upload status is not finalized.");
  }
  return responseJson["file"];
}
__name(uploadBlob, "uploadBlob");
async function uploadBlobToFileSearchStore(file, uploadUrl, apiClient, httpOptions) {
  var _a2;
  const response = await uploadBlobInternal(file, uploadUrl, apiClient, httpOptions);
  const responseJson = await (response === null || response === void 0 ? void 0 : response.json());
  if (((_a2 = response === null || response === void 0 ? void 0 : response.headers) === null || _a2 === void 0 ? void 0 : _a2[X_GOOG_UPLOAD_STATUS_HEADER_FIELD]) !== "final") {
    throw new Error("Failed to upload file: Upload status is not finalized.");
  }
  const resp = uploadToFileSearchStoreOperationFromMldev(responseJson);
  const typedResp = new UploadToFileSearchStoreOperation();
  Object.assign(typedResp, resp);
  return typedResp;
}
__name(uploadBlobToFileSearchStore, "uploadBlobToFileSearchStore");
async function uploadBlobInternal(file, uploadUrl, apiClient, httpOptions) {
  var _a2, _b, _c;
  let finalUrl = uploadUrl;
  const effectiveBaseUrl = (httpOptions === null || httpOptions === void 0 ? void 0 : httpOptions.baseUrl) || ((_a2 = apiClient.clientOptions.httpOptions) === null || _a2 === void 0 ? void 0 : _a2.baseUrl);
  if (effectiveBaseUrl) {
    const baseUri = new URL(effectiveBaseUrl);
    const uploadUri = new URL(uploadUrl);
    uploadUri.protocol = baseUri.protocol;
    uploadUri.host = baseUri.host;
    uploadUri.port = baseUri.port;
    finalUrl = uploadUri.toString();
  }
  let fileSize = 0;
  let offset = 0;
  let response = new HttpResponse(new Response());
  let uploadCommand = "upload";
  fileSize = file.size;
  while (offset < fileSize) {
    const chunkSize = Math.min(MAX_CHUNK_SIZE, fileSize - offset);
    const chunk = file.slice(offset, offset + chunkSize);
    if (offset + chunkSize >= fileSize) {
      uploadCommand += ", finalize";
    }
    let retryCount = 0;
    let currentDelayMs = INITIAL_RETRY_DELAY_MS;
    while (retryCount < MAX_RETRY_COUNT) {
      const mergedHeaders = Object.assign(Object.assign({}, (httpOptions === null || httpOptions === void 0 ? void 0 : httpOptions.headers) || {}), { "X-Goog-Upload-Command": uploadCommand, "X-Goog-Upload-Offset": String(offset), "Content-Length": String(chunkSize) });
      response = await apiClient.request({
        path: "",
        body: chunk,
        httpMethod: "POST",
        httpOptions: Object.assign(Object.assign({}, httpOptions), { apiVersion: "", baseUrl: finalUrl, headers: mergedHeaders })
      });
      if ((_b = response === null || response === void 0 ? void 0 : response.headers) === null || _b === void 0 ? void 0 : _b[X_GOOG_UPLOAD_STATUS_HEADER_FIELD]) {
        break;
      }
      retryCount++;
      await sleep(currentDelayMs);
      currentDelayMs = currentDelayMs * DELAY_MULTIPLIER;
    }
    offset += chunkSize;
    if (((_c = response === null || response === void 0 ? void 0 : response.headers) === null || _c === void 0 ? void 0 : _c[X_GOOG_UPLOAD_STATUS_HEADER_FIELD]) !== "active") {
      break;
    }
    if (fileSize <= offset) {
      throw new Error("All content has been uploaded, but the upload status is not finalized.");
    }
  }
  return response;
}
__name(uploadBlobInternal, "uploadBlobInternal");
async function getBlobStat(file) {
  const fileStat = { size: file.size, type: file.type };
  return fileStat;
}
__name(getBlobStat, "getBlobStat");
function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
__name(sleep, "sleep");
var NodeUploader = class {
  static {
    __name(this, "NodeUploader");
  }
  async stat(file) {
    const fileStat = { size: 0, type: void 0 };
    if (typeof file === "string") {
      const originalStat = await fs.stat(file);
      fileStat.size = originalStat.size;
      fileStat.type = this.inferMimeType(file);
      return fileStat;
    } else {
      return await getBlobStat(file);
    }
  }
  async upload(file, uploadUrl, apiClient, httpOptions) {
    if (typeof file === "string") {
      return await this.uploadFileFromPath(file, uploadUrl, apiClient, httpOptions);
    } else {
      return uploadBlob(file, uploadUrl, apiClient, httpOptions);
    }
  }
  async uploadToFileSearchStore(file, uploadUrl, apiClient, httpOptions) {
    if (typeof file === "string") {
      return await this.uploadFileToFileSearchStoreFromPath(file, uploadUrl, apiClient, httpOptions);
    } else {
      return uploadBlobToFileSearchStore(file, uploadUrl, apiClient, httpOptions);
    }
  }
  /**
   * Infers the MIME type of a file based on its extension.
   *
   * @param filePath The path to the file.
   * @returns The MIME type of the file, or undefined if it cannot be inferred.
   */
  inferMimeType(filePath) {
    const fileExtension = filePath.slice(filePath.lastIndexOf(".") + 1);
    const mimeTypes = {
      "aac": "audio/aac",
      "abw": "application/x-abiword",
      "arc": "application/x-freearc",
      "avi": "video/x-msvideo",
      "azw": "application/vnd.amazon.ebook",
      "bin": "application/octet-stream",
      "bmp": "image/bmp",
      "bz": "application/x-bzip",
      "bz2": "application/x-bzip2",
      "csh": "application/x-csh",
      "css": "text/css",
      "csv": "text/csv",
      "doc": "application/msword",
      "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "eot": "application/vnd.ms-fontobject",
      "epub": "application/epub+zip",
      "gz": "application/gzip",
      "gif": "image/gif",
      "htm": "text/html",
      "html": "text/html",
      "ico": "image/vnd.microsoft.icon",
      "ics": "text/calendar",
      "jar": "application/java-archive",
      "jpeg": "image/jpeg",
      "jpg": "image/jpeg",
      "js": "text/javascript",
      "json": "application/json",
      "jsonld": "application/ld+json",
      "kml": "application/vnd.google-earth.kml+xml",
      "kmz": "application/vnd.google-earth.kmz+xml",
      "mjs": "text/javascript",
      "mp3": "audio/mpeg",
      "mp4": "video/mp4",
      "mpeg": "video/mpeg",
      "mpkg": "application/vnd.apple.installer+xml",
      "odt": "application/vnd.oasis.opendocument.text",
      "oga": "audio/ogg",
      "ogv": "video/ogg",
      "ogx": "application/ogg",
      "opus": "audio/opus",
      "otf": "font/otf",
      "png": "image/png",
      "pdf": "application/pdf",
      "php": "application/x-httpd-php",
      "ppt": "application/vnd.ms-powerpoint",
      "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "rar": "application/vnd.rar",
      "rtf": "application/rtf",
      "sh": "application/x-sh",
      "svg": "image/svg+xml",
      "swf": "application/x-shockwave-flash",
      "tar": "application/x-tar",
      "tif": "image/tiff",
      "tiff": "image/tiff",
      "ts": "video/mp2t",
      "ttf": "font/ttf",
      "txt": "text/plain",
      "vsd": "application/vnd.visio",
      "wav": "audio/wav",
      "weba": "audio/webm",
      "webm": "video/webm",
      "webp": "image/webp",
      "woff": "font/woff",
      "woff2": "font/woff2",
      "xhtml": "application/xhtml+xml",
      "xls": "application/vnd.ms-excel",
      "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "xml": "application/xml",
      "xul": "application/vnd.mozilla.xul+xml",
      "zip": "application/zip",
      "3gp": "video/3gpp",
      "3g2": "video/3gpp2",
      "7z": "application/x-7z-compressed"
    };
    const mimeType = mimeTypes[fileExtension.toLowerCase()];
    return mimeType;
  }
  async uploadFileFromPath(file, uploadUrl, apiClient, httpOptions) {
    var _a2;
    const response = await this.uploadFileFromPathInternal(file, uploadUrl, apiClient, httpOptions);
    const responseJson = await (response === null || response === void 0 ? void 0 : response.json());
    if (((_a2 = response === null || response === void 0 ? void 0 : response.headers) === null || _a2 === void 0 ? void 0 : _a2[X_GOOG_UPLOAD_STATUS_HEADER_FIELD]) !== "final") {
      throw new Error("Failed to upload file: Upload status is not finalized.");
    }
    return responseJson["file"];
  }
  async uploadFileToFileSearchStoreFromPath(file, uploadUrl, apiClient, httpOptions) {
    var _a2;
    const response = await this.uploadFileFromPathInternal(file, uploadUrl, apiClient, httpOptions);
    const responseJson = await (response === null || response === void 0 ? void 0 : response.json());
    if (((_a2 = response === null || response === void 0 ? void 0 : response.headers) === null || _a2 === void 0 ? void 0 : _a2[X_GOOG_UPLOAD_STATUS_HEADER_FIELD]) !== "final") {
      throw new Error("Failed to upload file: Upload status is not finalized.");
    }
    const resp = uploadToFileSearchStoreOperationFromMldev(responseJson);
    const typedResp = new UploadToFileSearchStoreOperation();
    Object.assign(typedResp, resp);
    return typedResp;
  }
  async uploadFileFromPathInternal(file, uploadUrl, apiClient, httpOptions) {
    var _a2, _b, _c;
    let finalUrl = uploadUrl;
    const effectiveBaseUrl = (httpOptions === null || httpOptions === void 0 ? void 0 : httpOptions.baseUrl) || ((_a2 = apiClient.clientOptions.httpOptions) === null || _a2 === void 0 ? void 0 : _a2.baseUrl);
    if (effectiveBaseUrl) {
      const baseUri = new URL(effectiveBaseUrl);
      const uploadUri = new URL(uploadUrl);
      uploadUri.protocol = baseUri.protocol;
      uploadUri.host = baseUri.host;
      uploadUri.port = baseUri.port;
      finalUrl = uploadUri.toString();
    }
    let fileSize = 0;
    let offset = 0;
    let response = new HttpResponse(new Response());
    let uploadCommand = "upload";
    let fileHandle;
    const fileName = path$1.basename(file);
    try {
      fileHandle = await fs.open(file, "r");
      if (!fileHandle) {
        throw new Error(`Failed to open file`);
      }
      fileSize = (await fileHandle.stat()).size;
      while (offset < fileSize) {
        const chunkSize = Math.min(MAX_CHUNK_SIZE, fileSize - offset);
        if (offset + chunkSize >= fileSize) {
          uploadCommand += ", finalize";
        }
        const buffer = new Uint8Array(chunkSize);
        const { bytesRead } = await fileHandle.read(buffer, 0, chunkSize, offset);
        if (bytesRead !== chunkSize) {
          throw new Error(`Failed to read ${chunkSize} bytes from file at offset ${offset}. bytes actually read: ${bytesRead}`);
        }
        const chunk = new Blob([buffer]);
        let retryCount = 0;
        let currentDelayMs = INITIAL_RETRY_DELAY_MS;
        while (retryCount < MAX_RETRY_COUNT) {
          const mergedHeaders = Object.assign(Object.assign({}, (httpOptions === null || httpOptions === void 0 ? void 0 : httpOptions.headers) || {}), { "X-Goog-Upload-Command": uploadCommand, "X-Goog-Upload-Offset": String(offset), "Content-Length": String(bytesRead), "X-Goog-Upload-File-Name": fileName });
          response = await apiClient.request({
            path: "",
            body: chunk,
            httpMethod: "POST",
            httpOptions: Object.assign(Object.assign({}, httpOptions), { apiVersion: "", baseUrl: finalUrl, headers: mergedHeaders })
          });
          if ((_b = response === null || response === void 0 ? void 0 : response.headers) === null || _b === void 0 ? void 0 : _b[X_GOOG_UPLOAD_STATUS_HEADER_FIELD]) {
            break;
          }
          retryCount++;
          await sleep(currentDelayMs);
          currentDelayMs = currentDelayMs * DELAY_MULTIPLIER;
        }
        offset += bytesRead;
        if (((_c = response === null || response === void 0 ? void 0 : response.headers) === null || _c === void 0 ? void 0 : _c[X_GOOG_UPLOAD_STATUS_HEADER_FIELD]) !== "active") {
          break;
        }
        if (fileSize <= offset) {
          throw new Error("All content has been uploaded, but the upload status is not finalized.");
        }
      }
      return response;
    } finally {
      if (fileHandle) {
        await fileHandle.close();
      }
    }
  }
};
var NodeFiles = class extends Files {
  static {
    __name(this, "NodeFiles");
  }
  /**
   * Registers Google Cloud Storage files for use with the API.
   * This method is only available in Node.js environments.
   */
  async registerFiles(params) {
    if (typeof process === "undefined" || !process.versions || !process.versions.node) {
      throw new Error("registerFiles is only supported in Node.js environments.");
    }
    const googleAuth = params.auth;
    const authHeaders = await googleAuth.getRequestHeaders();
    const config = params.config || {};
    const httpOptions = config.httpOptions || {};
    const headers = Object.assign({}, httpOptions.headers || {});
    if (authHeaders) {
      if (typeof authHeaders[Symbol.iterator] === "function") {
        for (const [key, value] of authHeaders) {
          headers[key] = value;
        }
      } else {
        for (const [key, value] of Object.entries(authHeaders)) {
          headers[key] = value;
        }
      }
    }
    return this._registerFiles({
      uris: params.uris,
      config: Object.assign(Object.assign({}, config), { httpOptions: Object.assign(Object.assign({}, httpOptions), { headers }) })
    });
  }
};
var LANGUAGE_LABEL_PREFIX = "gl-node/";
function resolveCloudFlag(options) {
  var _a2;
  if (options.enterprise !== void 0 || options.vertexai !== void 0) {
    if (options.enterprise !== void 0 && options.vertexai !== void 0 && options.enterprise !== options.vertexai) {
      throw new Error("enterprise and vertexAI flags have conflicting values, please set enterprise value only.");
    }
    return (_a2 = options.enterprise) !== null && _a2 !== void 0 ? _a2 : options.vertexai;
  }
  const envEnterpriseStr = getEnv("GOOGLE_GENAI_USE_ENTERPRISE");
  const envVertexaiStr = getEnv("GOOGLE_GENAI_USE_VERTEXAI");
  const useEnterpriseEnv = stringToBoolean(envEnterpriseStr);
  const useVertexaiEnv = stringToBoolean(envVertexaiStr);
  if (envEnterpriseStr !== void 0 && envVertexaiStr !== void 0 && useEnterpriseEnv !== useVertexaiEnv) {
    console.warn("Warning: Both GOOGLE_GENAI_USE_ENTERPRISE and GOOGLE_GENAI_USE_VERTEXAI are set with conflicting values. The value of GOOGLE_GENAI_USE_ENTERPRISE will be used.");
  }
  if (envEnterpriseStr !== void 0) {
    return useEnterpriseEnv;
  }
  if (envVertexaiStr !== void 0) {
    return useVertexaiEnv;
  }
  return false;
}
__name(resolveCloudFlag, "resolveCloudFlag");
var GoogleGenAI = class {
  static {
    __name(this, "GoogleGenAI");
  }
  getNextGenClient() {
    var _a2;
    const httpOpts = this.httpOptions;
    if (this._nextGenClient === void 0) {
      this._nextGenClient = new GeminiNextGenAPIClient({
        baseURL: this.apiClient.getBaseUrl(),
        apiKey: this.apiKey,
        apiVersion: this.apiClient.getApiVersion(),
        clientAdapter: this.apiClient,
        defaultHeaders: this.apiClient.getDefaultHeaders(),
        timeout: httpOpts === null || httpOpts === void 0 ? void 0 : httpOpts.timeout,
        maxRetries: (_a2 = httpOpts === null || httpOpts === void 0 ? void 0 : httpOpts.retryOptions) === null || _a2 === void 0 ? void 0 : _a2.attempts
      });
    }
    if (httpOpts === null || httpOpts === void 0 ? void 0 : httpOpts.extraBody) {
      console.warn("GoogleGenAI.interactions: Client level httpOptions.extraBody is not supported by the interactions client and will be ignored.");
    }
    return this._nextGenClient;
  }
  get interactions() {
    if (this._interactions !== void 0) {
      return this._interactions;
    }
    console.warn("GoogleGenAI.interactions: Interactions usage is experimental and may change in future versions.");
    this._interactions = this.getNextGenClient().interactions;
    return this._interactions;
  }
  get webhooks() {
    if (this._webhooks !== void 0) {
      return this._webhooks;
    }
    this._webhooks = this.getNextGenClient().webhooks;
    return this._webhooks;
  }
  get agents() {
    if (this._agents !== void 0) {
      return this._agents;
    }
    console.warn("GoogleGenAI.agents: Agents usage is experimental and may change in future versions.");
    this._agents = this.getNextGenClient().agents;
    return this._agents;
  }
  constructor(options) {
    var _a2, _b, _c, _d;
    if ((options.project || options.location) && options.apiKey) {
      throw new Error("Project/location and API key are mutually exclusive in the client initializer.");
    }
    this.vertexai = resolveCloudFlag(options);
    const envApiKey = getApiKeyFromEnv();
    const envProject = getEnv("GOOGLE_CLOUD_PROJECT");
    const envLocation = getEnv("GOOGLE_CLOUD_LOCATION");
    this.apiKey = (_a2 = options.apiKey) !== null && _a2 !== void 0 ? _a2 : envApiKey;
    this.project = (_b = options.project) !== null && _b !== void 0 ? _b : envProject;
    this.location = (_c = options.location) !== null && _c !== void 0 ? _c : envLocation;
    if (!this.vertexai && !this.apiKey) {
      console.warn("API key should be set when using the Gemini API.");
    }
    if (this.vertexai) {
      if ((_d = options.googleAuthOptions) === null || _d === void 0 ? void 0 : _d.credentials) {
        console.debug("The user provided Google Cloud credentials will take precedence over the API key from the environment variable.");
        this.apiKey = void 0;
      }
      if ((envProject || envLocation) && options.apiKey) {
        console.debug("The user provided Vertex AI API key will take precedence over the project/location from the environment variables.");
        this.project = void 0;
        this.location = void 0;
      } else if ((options.project || options.location) && envApiKey) {
        console.debug("The user provided project/location will take precedence over the API key from the environment variables.");
        this.apiKey = void 0;
      } else if ((envProject || envLocation) && envApiKey) {
        console.debug("The project/location from the environment variables will take precedence over the API key from the environment variables.");
        this.apiKey = void 0;
      }
      if (!this.location && !this.apiKey) {
        this.location = "global";
      }
    }
    const baseUrl = getBaseUrl(options.httpOptions, this.vertexai, getEnv("GOOGLE_VERTEX_BASE_URL"), getEnv("GOOGLE_GEMINI_BASE_URL"));
    if (baseUrl) {
      if (options.httpOptions) {
        options.httpOptions.baseUrl = baseUrl;
      } else {
        options.httpOptions = { baseUrl };
      }
    }
    this.apiVersion = options.apiVersion;
    this.httpOptions = options.httpOptions;
    const auth = new NodeAuth({
      apiKey: this.apiKey,
      googleAuthOptions: options.googleAuthOptions
    });
    this.apiClient = new ApiClient({
      auth,
      project: this.project,
      location: this.location,
      apiVersion: this.apiVersion,
      apiKey: this.apiKey,
      vertexai: this.vertexai,
      httpOptions: this.httpOptions,
      userAgentExtra: LANGUAGE_LABEL_PREFIX + process.version,
      uploader: new NodeUploader(),
      downloader: new NodeDownloader()
    });
    this.models = new Models(this.apiClient);
    this.live = new Live(this.apiClient, auth, new NodeWebSocketFactory());
    this.batches = new Batches(this.apiClient);
    this.chats = new Chats(this.models, this.apiClient);
    this.caches = new Caches(this.apiClient);
    this.files = new NodeFiles(this.apiClient);
    this.operations = new Operations(this.apiClient);
    this.authTokens = new Tokens(this.apiClient);
    this.tunings = new Tunings(this.apiClient);
    this.fileSearchStores = new FileSearchStores(this.apiClient);
  }
};
function getEnv(env) {
  var _a2, _b, _c;
  return (_c = (_b = (_a2 = process === null || process === void 0 ? void 0 : process.env) === null || _a2 === void 0 ? void 0 : _a2[env]) === null || _b === void 0 ? void 0 : _b.trim()) !== null && _c !== void 0 ? _c : void 0;
}
__name(getEnv, "getEnv");
function stringToBoolean(str) {
  if (str === void 0) {
    return false;
  }
  return str.toLowerCase() === "true";
}
__name(stringToBoolean, "stringToBoolean");
function getApiKeyFromEnv() {
  const envGoogleApiKey = getEnv("GOOGLE_API_KEY");
  const envGeminiApiKey = getEnv("GEMINI_API_KEY");
  if (envGoogleApiKey && envGeminiApiKey) {
    console.warn("Both GOOGLE_API_KEY and GEMINI_API_KEY are set. Using GOOGLE_API_KEY.");
  }
  return envGoogleApiKey || envGeminiApiKey || void 0;
}
__name(getApiKeyFromEnv, "getApiKeyFromEnv");

export {
  setDefaultBaseUrls,
  Outcome,
  Language,
  FunctionResponseScheduling,
  Type,
  Environment,
  AuthType,
  HttpElementLocation,
  ApiSpec,
  PhishBlockThreshold,
  Behavior,
  DynamicRetrievalConfigMode,
  FunctionCallingConfigMode,
  ThinkingLevel,
  PersonGeneration,
  ProminentPeople,
  HarmCategory,
  HarmBlockMethod,
  HarmBlockThreshold,
  FinishReason,
  HarmProbability,
  HarmSeverity,
  UrlRetrievalStatus,
  BlockedReason,
  TrafficType,
  Modality,
  ModelStage,
  MediaResolution,
  TuningMode,
  AdapterSize,
  JobState,
  TuningJobState,
  AggregationMetric,
  PairwiseChoice,
  TuningSpeed,
  TuningTask,
  VideoOrientation,
  DocumentState,
  PartMediaResolutionLevel,
  ToolType,
  ResourceScope,
  ServiceTier,
  FeatureSelectionPreference,
  EmbeddingApiType,
  SafetyFilterLevel,
  ImagePromptLanguage,
  MaskReferenceMode,
  ControlReferenceType,
  SubjectReferenceType,
  EditMode,
  SegmentMode,
  VideoGenerationReferenceType,
  VideoGenerationMaskMode,
  VideoCompressionQuality,
  ImageResizeMode,
  TuningMethod,
  FileState,
  FileSource,
  TurnCompleteReason,
  MediaModality,
  VadSignalType,
  VoiceActivityType,
  StartSensitivity,
  EndSensitivity,
  ActivityHandling,
  TurnCoverage,
  Scale,
  MusicGenerationMode,
  LiveMusicPlaybackControl,
  ToolResponse,
  FunctionResponseBlob,
  FunctionResponseFileData,
  FunctionResponsePart,
  createFunctionResponsePartFromBase64,
  createFunctionResponsePartFromUri,
  FunctionResponse,
  createPartFromUri,
  createPartFromText,
  createPartFromFunctionCall,
  createPartFromFunctionResponse,
  createPartFromBase64,
  createPartFromCodeExecutionResult,
  createPartFromExecutableCode,
  createUserContent,
  createModelContent,
  HttpResponse,
  GenerateContentResponsePromptFeedback,
  GenerateContentResponseUsageMetadata,
  GenerateContentResponse,
  EmbedContentResponse,
  GenerateImagesResponse,
  EditImageResponse,
  UpscaleImageResponse,
  RecontextImageResponse,
  SegmentImageResponse,
  ListModelsResponse,
  DeleteModelResponse,
  CountTokensResponse,
  ComputeTokensResponse,
  GenerateVideosResponse,
  GenerateVideosOperation,
  EvaluateDatasetResponse,
  ListTuningJobsResponse,
  CancelTuningJobResponse,
  DeleteCachedContentResponse,
  ListCachedContentsResponse,
  ListDocumentsResponse,
  ListFileSearchStoresResponse,
  UploadToFileSearchStoreResumableResponse,
  ImportFileResponse,
  ImportFileOperation,
  ListFilesResponse,
  CreateFileResponse,
  DeleteFileResponse,
  RegisterFilesResponse,
  InlinedResponse,
  SingleEmbedContentResponse,
  InlinedEmbedContentResponse,
  ListBatchJobsResponse,
  ReplayResponse,
  RawReferenceImage,
  MaskReferenceImage,
  ControlReferenceImage,
  StyleReferenceImage,
  SubjectReferenceImage,
  ContentReferenceImage,
  LiveServerMessage,
  LiveClientToolResponse,
  LiveSendToolResponseParameters,
  LiveMusicServerMessage,
  UploadToFileSearchStoreResponse,
  UploadToFileSearchStoreOperation,
  PagedItem,
  Pager,
  Batches,
  Caches,
  Chats,
  Chat,
  ApiError,
  Files,
  mcpToTool,
  Live,
  Session,
  Models,
  Operations,
  Tokens,
  GoogleGenAI
};
/*! Bundled license information:

@google/genai/dist/node/index.mjs:
@google/genai/dist/node/index.mjs:
  (**
   * @license
   * Copyright 2025 Google LLC
   * SPDX-License-Identifier: Apache-2.0
   *)
*/
