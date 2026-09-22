// Force strict mode and setup for ESM
"use strict";
import {
  esm_exports as esm_exports2,
  init_esm as init_esm2
} from "./chunk-74TONY4F.js";
import {
  esm_exports,
  init_esm
} from "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __commonJS,
  __name,
  __require,
  __toCommonJS
} from "./chunk-J2S4EL5Y.js";

// node_modules/@opentelemetry/core/build/src/trace/suppress-tracing.js
var require_suppress_tracing = __commonJS({
  "node_modules/@opentelemetry/core/build/src/trace/suppress-tracing.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isTracingSuppressed = exports.unsuppressTracing = exports.suppressTracing = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var SUPPRESS_TRACING_KEY = (0, api_1.createContextKey)("OpenTelemetry SDK Context Key SUPPRESS_TRACING");
    function suppressTracing(context) {
      return context.setValue(SUPPRESS_TRACING_KEY, true);
    }
    __name(suppressTracing, "suppressTracing");
    exports.suppressTracing = suppressTracing;
    function unsuppressTracing(context) {
      return context.deleteValue(SUPPRESS_TRACING_KEY);
    }
    __name(unsuppressTracing, "unsuppressTracing");
    exports.unsuppressTracing = unsuppressTracing;
    function isTracingSuppressed(context) {
      return context.getValue(SUPPRESS_TRACING_KEY) === true;
    }
    __name(isTracingSuppressed, "isTracingSuppressed");
    exports.isTracingSuppressed = isTracingSuppressed;
  }
});

// node_modules/@opentelemetry/core/build/src/baggage/constants.js
var require_constants = __commonJS({
  "node_modules/@opentelemetry/core/build/src/baggage/constants.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BAGGAGE_MAX_TOTAL_LENGTH = exports.BAGGAGE_MAX_PER_NAME_VALUE_PAIRS = exports.BAGGAGE_MAX_NAME_VALUE_PAIRS = exports.BAGGAGE_HEADER = exports.BAGGAGE_ITEMS_SEPARATOR = exports.BAGGAGE_PROPERTIES_SEPARATOR = exports.BAGGAGE_KEY_PAIR_SEPARATOR = void 0;
    exports.BAGGAGE_KEY_PAIR_SEPARATOR = "=";
    exports.BAGGAGE_PROPERTIES_SEPARATOR = ";";
    exports.BAGGAGE_ITEMS_SEPARATOR = ",";
    exports.BAGGAGE_HEADER = "baggage";
    exports.BAGGAGE_MAX_NAME_VALUE_PAIRS = 180;
    exports.BAGGAGE_MAX_PER_NAME_VALUE_PAIRS = 4096;
    exports.BAGGAGE_MAX_TOTAL_LENGTH = 8192;
  }
});

// node_modules/@opentelemetry/core/build/src/baggage/utils.js
var require_utils = __commonJS({
  "node_modules/@opentelemetry/core/build/src/baggage/utils.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.parseKeyPairsIntoRecord = exports.parseBaggageHeaderString = exports.parsePairKeyValue = exports.getKeyPairs = exports.serializeKeyPairs = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var constants_1 = require_constants();
    function serializeKeyPairs(keyPairs) {
      return keyPairs.reduce((hValue, current) => {
        const value = `${hValue}${hValue !== "" ? constants_1.BAGGAGE_ITEMS_SEPARATOR : ""}${current}`;
        return value.length > constants_1.BAGGAGE_MAX_TOTAL_LENGTH ? hValue : value;
      }, "");
    }
    __name(serializeKeyPairs, "serializeKeyPairs");
    exports.serializeKeyPairs = serializeKeyPairs;
    function getKeyPairs(baggage) {
      return baggage.getAllEntries().map(([key, value]) => {
        let entry = `${encodeURIComponent(key)}=${encodeURIComponent(value.value)}`;
        if (value.metadata !== void 0) {
          entry += constants_1.BAGGAGE_PROPERTIES_SEPARATOR + value.metadata.toString();
        }
        return entry;
      });
    }
    __name(getKeyPairs, "getKeyPairs");
    exports.getKeyPairs = getKeyPairs;
    function parsePairKeyValue(entry) {
      if (!entry)
        return;
      const metadataSeparatorIndex = entry.indexOf(constants_1.BAGGAGE_PROPERTIES_SEPARATOR);
      const keyPairPart = metadataSeparatorIndex === -1 ? entry : entry.substring(0, metadataSeparatorIndex);
      const separatorIndex = keyPairPart.indexOf(constants_1.BAGGAGE_KEY_PAIR_SEPARATOR);
      if (separatorIndex <= 0)
        return;
      const rawKey = keyPairPart.substring(0, separatorIndex).trim();
      const rawValue = keyPairPart.substring(separatorIndex + 1).trim();
      if (!rawKey || !rawValue)
        return;
      let key;
      let value;
      try {
        key = decodeURIComponent(rawKey);
        value = decodeURIComponent(rawValue);
      } catch {
        return;
      }
      let metadata;
      if (metadataSeparatorIndex !== -1 && metadataSeparatorIndex < entry.length - 1) {
        const metadataString = entry.substring(metadataSeparatorIndex + 1);
        metadata = (0, api_1.baggageEntryMetadataFromString)(metadataString);
      }
      return { key, value, metadata };
    }
    __name(parsePairKeyValue, "parsePairKeyValue");
    exports.parsePairKeyValue = parsePairKeyValue;
    function parseBaggageHeaderString(value, baggage, count, totalSize) {
      let start = 0;
      while (start < value.length && count < constants_1.BAGGAGE_MAX_NAME_VALUE_PAIRS) {
        const end = value.indexOf(constants_1.BAGGAGE_ITEMS_SEPARATOR, start);
        const entryEnd = end === -1 ? value.length : end;
        const entryLength = entryEnd - start;
        if (entryLength <= constants_1.BAGGAGE_MAX_PER_NAME_VALUE_PAIRS) {
          const keyPair = parsePairKeyValue(value.substring(start, entryEnd));
          if (keyPair) {
            const entrySize = (count === 0 ? 0 : 1) + entryLength;
            if (totalSize + entrySize > constants_1.BAGGAGE_MAX_TOTAL_LENGTH)
              break;
            baggage[keyPair.key] = keyPair.metadata ? { value: keyPair.value, metadata: keyPair.metadata } : { value: keyPair.value };
            count++;
            totalSize += entrySize;
          }
        }
        if (end === -1)
          break;
        start = end + 1;
      }
      return [count, totalSize];
    }
    __name(parseBaggageHeaderString, "parseBaggageHeaderString");
    exports.parseBaggageHeaderString = parseBaggageHeaderString;
    function parseKeyPairsIntoRecord(value) {
      const result = {};
      if (typeof value === "string" && value.length > 0) {
        value.split(constants_1.BAGGAGE_ITEMS_SEPARATOR).forEach((entry) => {
          const keyPair = parsePairKeyValue(entry);
          if (keyPair !== void 0 && keyPair.value.length > 0) {
            result[keyPair.key] = keyPair.value;
          }
        });
      }
      return result;
    }
    __name(parseKeyPairsIntoRecord, "parseKeyPairsIntoRecord");
    exports.parseKeyPairsIntoRecord = parseKeyPairsIntoRecord;
  }
});

// node_modules/@opentelemetry/core/build/src/baggage/propagation/W3CBaggagePropagator.js
var require_W3CBaggagePropagator = __commonJS({
  "node_modules/@opentelemetry/core/build/src/baggage/propagation/W3CBaggagePropagator.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.W3CBaggagePropagator = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var suppress_tracing_1 = require_suppress_tracing();
    var constants_1 = require_constants();
    var utils_1 = require_utils();
    var W3CBaggagePropagator = class {
      static {
        __name(this, "W3CBaggagePropagator");
      }
      inject(context, carrier, setter) {
        const baggage = api_1.propagation.getBaggage(context);
        if (!baggage || (0, suppress_tracing_1.isTracingSuppressed)(context))
          return;
        const keyPairs = (0, utils_1.getKeyPairs)(baggage).filter((pair) => {
          return pair.length <= constants_1.BAGGAGE_MAX_PER_NAME_VALUE_PAIRS;
        }).slice(0, constants_1.BAGGAGE_MAX_NAME_VALUE_PAIRS);
        const headerValue = (0, utils_1.serializeKeyPairs)(keyPairs);
        if (headerValue.length > 0) {
          setter.set(carrier, constants_1.BAGGAGE_HEADER, headerValue);
        }
      }
      extract(context, carrier, getter) {
        const headerValue = getter.get(carrier, constants_1.BAGGAGE_HEADER);
        if (!headerValue) {
          return context;
        }
        const baggage = {};
        let count = 0;
        let totalSize = 0;
        if (Array.isArray(headerValue)) {
          for (let i = 0; i < headerValue.length; i++) {
            [count, totalSize] = (0, utils_1.parseBaggageHeaderString)(headerValue[i], baggage, count, totalSize);
          }
        } else {
          [count] = (0, utils_1.parseBaggageHeaderString)(headerValue, baggage, count, totalSize);
        }
        if (count === 0) {
          return context;
        }
        return api_1.propagation.setBaggage(context, api_1.propagation.createBaggage(baggage));
      }
      fields() {
        return [constants_1.BAGGAGE_HEADER];
      }
    };
    exports.W3CBaggagePropagator = W3CBaggagePropagator;
  }
});

// node_modules/@opentelemetry/core/build/src/common/anchored-clock.js
var require_anchored_clock = __commonJS({
  "node_modules/@opentelemetry/core/build/src/common/anchored-clock.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AnchoredClock = void 0;
    var AnchoredClock = class {
      static {
        __name(this, "AnchoredClock");
      }
      _monotonicClock;
      _epochMillis;
      _performanceMillis;
      /**
       * Create a new AnchoredClock anchored to the current time returned by systemClock.
       *
       * @param systemClock should be a clock that returns the number of milliseconds since January 1 1970 such as Date
       * @param monotonicClock should be a clock that counts milliseconds monotonically such as window.performance or perf_hooks.performance
       */
      constructor(systemClock, monotonicClock) {
        this._monotonicClock = monotonicClock;
        this._epochMillis = systemClock.now();
        this._performanceMillis = monotonicClock.now();
      }
      /**
       * Returns the current time by adding the number of milliseconds since the
       * AnchoredClock was created to the creation epoch time
       */
      now() {
        const delta = this._monotonicClock.now() - this._performanceMillis;
        return this._epochMillis + delta;
      }
    };
    exports.AnchoredClock = AnchoredClock;
  }
});

// node_modules/@opentelemetry/core/build/src/common/attributes.js
var require_attributes = __commonJS({
  "node_modules/@opentelemetry/core/build/src/common/attributes.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isAttributeValue = exports.isAttributeKey = exports.sanitizeAttributes = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    function sanitizeAttributes(attributes) {
      const out = {};
      if (typeof attributes !== "object" || attributes == null) {
        return out;
      }
      for (const key in attributes) {
        if (!Object.prototype.hasOwnProperty.call(attributes, key)) {
          continue;
        }
        if (!isAttributeKey(key)) {
          api_1.diag.warn(`Invalid attribute key: ${key}`);
          continue;
        }
        const val = attributes[key];
        if (!isAttributeValue(val)) {
          api_1.diag.warn(`Invalid attribute value set for key: ${key}`);
          continue;
        }
        if (Array.isArray(val)) {
          out[key] = val.slice();
        } else {
          out[key] = val;
        }
      }
      return out;
    }
    __name(sanitizeAttributes, "sanitizeAttributes");
    exports.sanitizeAttributes = sanitizeAttributes;
    function isAttributeKey(key) {
      return typeof key === "string" && key !== "";
    }
    __name(isAttributeKey, "isAttributeKey");
    exports.isAttributeKey = isAttributeKey;
    function isAttributeValue(val) {
      if (val == null) {
        return true;
      }
      if (Array.isArray(val)) {
        return isHomogeneousAttributeValueArray(val);
      }
      return isValidPrimitiveAttributeValueType(typeof val);
    }
    __name(isAttributeValue, "isAttributeValue");
    exports.isAttributeValue = isAttributeValue;
    function isHomogeneousAttributeValueArray(arr) {
      let type;
      for (const element of arr) {
        if (element == null)
          continue;
        const elementType = typeof element;
        if (elementType === type) {
          continue;
        }
        if (!type) {
          if (isValidPrimitiveAttributeValueType(elementType)) {
            type = elementType;
            continue;
          }
          return false;
        }
        return false;
      }
      return true;
    }
    __name(isHomogeneousAttributeValueArray, "isHomogeneousAttributeValueArray");
    function isValidPrimitiveAttributeValueType(valType) {
      switch (valType) {
        case "number":
        case "boolean":
        case "string":
          return true;
      }
      return false;
    }
    __name(isValidPrimitiveAttributeValueType, "isValidPrimitiveAttributeValueType");
  }
});

// node_modules/@opentelemetry/core/build/src/common/logging-error-handler.js
var require_logging_error_handler = __commonJS({
  "node_modules/@opentelemetry/core/build/src/common/logging-error-handler.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.loggingErrorHandler = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    function loggingErrorHandler() {
      return (ex) => {
        api_1.diag.error(stringifyException(ex));
      };
    }
    __name(loggingErrorHandler, "loggingErrorHandler");
    exports.loggingErrorHandler = loggingErrorHandler;
    function stringifyException(ex) {
      if (typeof ex === "string") {
        return ex;
      } else {
        return JSON.stringify(flattenException(ex));
      }
    }
    __name(stringifyException, "stringifyException");
    function flattenException(ex) {
      const result = {};
      let current = ex;
      while (current !== null) {
        Object.getOwnPropertyNames(current).forEach((propertyName) => {
          if (result[propertyName])
            return;
          const value = current[propertyName];
          if (value) {
            result[propertyName] = String(value);
          }
        });
        current = Object.getPrototypeOf(current);
      }
      return result;
    }
    __name(flattenException, "flattenException");
  }
});

// node_modules/@opentelemetry/core/build/src/common/global-error-handler.js
var require_global_error_handler = __commonJS({
  "node_modules/@opentelemetry/core/build/src/common/global-error-handler.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.globalErrorHandler = exports.setGlobalErrorHandler = void 0;
    var logging_error_handler_1 = require_logging_error_handler();
    var delegateHandler = (0, logging_error_handler_1.loggingErrorHandler)();
    function setGlobalErrorHandler(handler) {
      delegateHandler = handler;
    }
    __name(setGlobalErrorHandler, "setGlobalErrorHandler");
    exports.setGlobalErrorHandler = setGlobalErrorHandler;
    function globalErrorHandler(ex) {
      try {
        delegateHandler(ex);
      } catch {
      }
    }
    __name(globalErrorHandler, "globalErrorHandler");
    exports.globalErrorHandler = globalErrorHandler;
  }
});

// node_modules/@opentelemetry/core/build/src/platform/node/environment.js
var require_environment = __commonJS({
  "node_modules/@opentelemetry/core/build/src/platform/node/environment.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getStringListFromEnv = exports.getBooleanFromEnv = exports.getStringFromEnv = exports.getNumberFromEnv = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var util_1 = __require("util");
    function getNumberFromEnv(key) {
      const raw = process.env[key];
      if (raw == null || raw.trim() === "") {
        return void 0;
      }
      const value = Number(raw);
      if (isNaN(value)) {
        api_1.diag.warn(`Unknown value ${(0, util_1.inspect)(raw)} for ${key}, expected a number, using defaults`);
        return void 0;
      }
      return value;
    }
    __name(getNumberFromEnv, "getNumberFromEnv");
    exports.getNumberFromEnv = getNumberFromEnv;
    function getStringFromEnv(key) {
      const raw = process.env[key];
      if (raw == null || raw.trim() === "") {
        return void 0;
      }
      return raw;
    }
    __name(getStringFromEnv, "getStringFromEnv");
    exports.getStringFromEnv = getStringFromEnv;
    function getBooleanFromEnv(key) {
      const raw = process.env[key]?.trim().toLowerCase();
      if (raw == null || raw === "") {
        return false;
      }
      if (raw === "true") {
        return true;
      } else if (raw === "false") {
        return false;
      } else {
        api_1.diag.warn(`Unknown value ${(0, util_1.inspect)(raw)} for ${key}, expected 'true' or 'false', falling back to 'false' (default)`);
        return false;
      }
    }
    __name(getBooleanFromEnv, "getBooleanFromEnv");
    exports.getBooleanFromEnv = getBooleanFromEnv;
    function getStringListFromEnv(key) {
      return getStringFromEnv(key)?.split(",").map((v) => v.trim()).filter((s) => s !== "");
    }
    __name(getStringListFromEnv, "getStringListFromEnv");
    exports.getStringListFromEnv = getStringListFromEnv;
  }
});

// node_modules/@opentelemetry/core/build/src/common/globalThis.js
var require_globalThis = __commonJS({
  "node_modules/@opentelemetry/core/build/src/common/globalThis.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports._globalThis = void 0;
    exports._globalThis = globalThis;
  }
});

// node_modules/@opentelemetry/core/build/src/version.js
var require_version = __commonJS({
  "node_modules/@opentelemetry/core/build/src/version.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.VERSION = void 0;
    exports.VERSION = "2.10.0";
  }
});

// node_modules/@opentelemetry/core/build/src/semconv.js
var require_semconv = __commonJS({
  "node_modules/@opentelemetry/core/build/src/semconv.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ATTR_PROCESS_RUNTIME_NAME = void 0;
    exports.ATTR_PROCESS_RUNTIME_NAME = "process.runtime.name";
  }
});

// node_modules/@opentelemetry/core/build/src/platform/node/sdk-info.js
var require_sdk_info = __commonJS({
  "node_modules/@opentelemetry/core/build/src/platform/node/sdk-info.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SDK_INFO = void 0;
    var version_1 = require_version();
    var semantic_conventions_1 = (init_esm2(), __toCommonJS(esm_exports2));
    var semconv_1 = require_semconv();
    exports.SDK_INFO = {
      [semantic_conventions_1.ATTR_TELEMETRY_SDK_NAME]: "opentelemetry",
      [semconv_1.ATTR_PROCESS_RUNTIME_NAME]: "node",
      [semantic_conventions_1.ATTR_TELEMETRY_SDK_LANGUAGE]: semantic_conventions_1.TELEMETRY_SDK_LANGUAGE_VALUE_NODEJS,
      [semantic_conventions_1.ATTR_TELEMETRY_SDK_VERSION]: version_1.VERSION
    };
  }
});

// node_modules/@opentelemetry/core/build/src/platform/node/index.js
var require_node = __commonJS({
  "node_modules/@opentelemetry/core/build/src/platform/node/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.otperformance = exports.SDK_INFO = exports._globalThis = exports.getStringListFromEnv = exports.getNumberFromEnv = exports.getBooleanFromEnv = exports.getStringFromEnv = void 0;
    var environment_1 = require_environment();
    Object.defineProperty(exports, "getStringFromEnv", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return environment_1.getStringFromEnv;
    }, "get") });
    Object.defineProperty(exports, "getBooleanFromEnv", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return environment_1.getBooleanFromEnv;
    }, "get") });
    Object.defineProperty(exports, "getNumberFromEnv", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return environment_1.getNumberFromEnv;
    }, "get") });
    Object.defineProperty(exports, "getStringListFromEnv", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return environment_1.getStringListFromEnv;
    }, "get") });
    var globalThis_1 = require_globalThis();
    Object.defineProperty(exports, "_globalThis", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return globalThis_1._globalThis;
    }, "get") });
    var sdk_info_1 = require_sdk_info();
    Object.defineProperty(exports, "SDK_INFO", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return sdk_info_1.SDK_INFO;
    }, "get") });
    exports.otperformance = performance;
  }
});

// node_modules/@opentelemetry/core/build/src/platform/index.js
var require_platform = __commonJS({
  "node_modules/@opentelemetry/core/build/src/platform/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getStringListFromEnv = exports.getNumberFromEnv = exports.getStringFromEnv = exports.getBooleanFromEnv = exports.otperformance = exports._globalThis = exports.SDK_INFO = void 0;
    var node_1 = require_node();
    Object.defineProperty(exports, "SDK_INFO", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return node_1.SDK_INFO;
    }, "get") });
    Object.defineProperty(exports, "_globalThis", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return node_1._globalThis;
    }, "get") });
    Object.defineProperty(exports, "otperformance", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return node_1.otperformance;
    }, "get") });
    Object.defineProperty(exports, "getBooleanFromEnv", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return node_1.getBooleanFromEnv;
    }, "get") });
    Object.defineProperty(exports, "getStringFromEnv", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return node_1.getStringFromEnv;
    }, "get") });
    Object.defineProperty(exports, "getNumberFromEnv", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return node_1.getNumberFromEnv;
    }, "get") });
    Object.defineProperty(exports, "getStringListFromEnv", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return node_1.getStringListFromEnv;
    }, "get") });
  }
});

// node_modules/@opentelemetry/core/build/src/common/time.js
var require_time = __commonJS({
  "node_modules/@opentelemetry/core/build/src/common/time.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.addHrTimes = exports.isTimeInput = exports.isTimeInputHrTime = exports.hrTimeToSeconds = exports.hrTimeToMilliseconds = exports.hrTimeToMicroseconds = exports.hrTimeToNanoseconds = exports.hrTimeToTimeStamp = exports.hrTimeDuration = exports.timeInputToHrTime = exports.hrTime = exports.getTimeOrigin = exports.millisToHrTime = void 0;
    var platform_1 = require_platform();
    var NANOSECOND_DIGITS = 9;
    var NANOSECOND_DIGITS_IN_MILLIS = 6;
    var MILLISECONDS_TO_NANOSECONDS = Math.pow(10, NANOSECOND_DIGITS_IN_MILLIS);
    var SECOND_TO_NANOSECONDS = Math.pow(10, NANOSECOND_DIGITS);
    function millisToHrTime(epochMillis) {
      const epochSeconds = epochMillis / 1e3;
      const seconds = Math.trunc(epochSeconds);
      const nanos = Math.round(epochMillis % 1e3 * MILLISECONDS_TO_NANOSECONDS);
      return [seconds, nanos];
    }
    __name(millisToHrTime, "millisToHrTime");
    exports.millisToHrTime = millisToHrTime;
    function getTimeOrigin() {
      return platform_1.otperformance.timeOrigin;
    }
    __name(getTimeOrigin, "getTimeOrigin");
    exports.getTimeOrigin = getTimeOrigin;
    function hrTime(performanceNow) {
      const timeOrigin = millisToHrTime(platform_1.otperformance.timeOrigin);
      const now = millisToHrTime(typeof performanceNow === "number" ? performanceNow : platform_1.otperformance.now());
      return addHrTimes(timeOrigin, now);
    }
    __name(hrTime, "hrTime");
    exports.hrTime = hrTime;
    function timeInputToHrTime(time) {
      if (isTimeInputHrTime(time)) {
        return time;
      } else if (typeof time === "number") {
        if (time < platform_1.otperformance.timeOrigin / 2) {
          return hrTime(time);
        } else {
          return millisToHrTime(time);
        }
      } else if (time instanceof Date) {
        return millisToHrTime(time.getTime());
      } else {
        throw TypeError("Invalid input type");
      }
    }
    __name(timeInputToHrTime, "timeInputToHrTime");
    exports.timeInputToHrTime = timeInputToHrTime;
    function hrTimeDuration(startTime, endTime) {
      let seconds = endTime[0] - startTime[0];
      let nanos = endTime[1] - startTime[1];
      if (nanos < 0) {
        seconds -= 1;
        nanos += SECOND_TO_NANOSECONDS;
      }
      return [seconds, nanos];
    }
    __name(hrTimeDuration, "hrTimeDuration");
    exports.hrTimeDuration = hrTimeDuration;
    function hrTimeToTimeStamp(time) {
      const precision = NANOSECOND_DIGITS;
      const tmp = `${"0".repeat(precision)}${time[1]}Z`;
      const nanoString = tmp.substring(tmp.length - precision - 1);
      const date = new Date(time[0] * 1e3).toISOString();
      return date.replace("000Z", nanoString);
    }
    __name(hrTimeToTimeStamp, "hrTimeToTimeStamp");
    exports.hrTimeToTimeStamp = hrTimeToTimeStamp;
    function hrTimeToNanoseconds(time) {
      return time[0] * SECOND_TO_NANOSECONDS + time[1];
    }
    __name(hrTimeToNanoseconds, "hrTimeToNanoseconds");
    exports.hrTimeToNanoseconds = hrTimeToNanoseconds;
    function hrTimeToMicroseconds(time) {
      return time[0] * 1e6 + time[1] / 1e3;
    }
    __name(hrTimeToMicroseconds, "hrTimeToMicroseconds");
    exports.hrTimeToMicroseconds = hrTimeToMicroseconds;
    function hrTimeToMilliseconds(time) {
      return time[0] * 1e3 + time[1] / 1e6;
    }
    __name(hrTimeToMilliseconds, "hrTimeToMilliseconds");
    exports.hrTimeToMilliseconds = hrTimeToMilliseconds;
    function hrTimeToSeconds(time) {
      return time[0] + time[1] / SECOND_TO_NANOSECONDS;
    }
    __name(hrTimeToSeconds, "hrTimeToSeconds");
    exports.hrTimeToSeconds = hrTimeToSeconds;
    function isTimeInputHrTime(value) {
      return Array.isArray(value) && value.length === 2 && typeof value[0] === "number" && typeof value[1] === "number";
    }
    __name(isTimeInputHrTime, "isTimeInputHrTime");
    exports.isTimeInputHrTime = isTimeInputHrTime;
    function isTimeInput(value) {
      return isTimeInputHrTime(value) || typeof value === "number" || value instanceof Date;
    }
    __name(isTimeInput, "isTimeInput");
    exports.isTimeInput = isTimeInput;
    function addHrTimes(time1, time2) {
      const out = [time1[0] + time2[0], time1[1] + time2[1]];
      if (out[1] >= SECOND_TO_NANOSECONDS) {
        out[1] -= SECOND_TO_NANOSECONDS;
        out[0] += 1;
      }
      return out;
    }
    __name(addHrTimes, "addHrTimes");
    exports.addHrTimes = addHrTimes;
  }
});

// node_modules/@opentelemetry/core/build/src/common/timer-util.js
var require_timer_util = __commonJS({
  "node_modules/@opentelemetry/core/build/src/common/timer-util.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.unrefTimer = void 0;
    function unrefTimer(timer) {
      if (typeof timer !== "number") {
        timer.unref();
      }
    }
    __name(unrefTimer, "unrefTimer");
    exports.unrefTimer = unrefTimer;
  }
});

// node_modules/@opentelemetry/core/build/src/ExportResult.js
var require_ExportResult = __commonJS({
  "node_modules/@opentelemetry/core/build/src/ExportResult.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ExportResultCode = void 0;
    var ExportResultCode;
    (function(ExportResultCode2) {
      ExportResultCode2[ExportResultCode2["SUCCESS"] = 0] = "SUCCESS";
      ExportResultCode2[ExportResultCode2["FAILED"] = 1] = "FAILED";
    })(ExportResultCode || (exports.ExportResultCode = ExportResultCode = {}));
  }
});

// node_modules/@opentelemetry/core/build/src/propagation/composite.js
var require_composite = __commonJS({
  "node_modules/@opentelemetry/core/build/src/propagation/composite.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.CompositePropagator = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var CompositePropagator = class {
      static {
        __name(this, "CompositePropagator");
      }
      _propagators;
      _fields;
      /**
       * Construct a composite propagator from a list of propagators.
       *
       * @param [config] Configuration object for composite propagator
       */
      constructor(config = {}) {
        this._propagators = config.propagators ?? [];
        const fields = /* @__PURE__ */ new Set();
        for (const propagator of this._propagators) {
          const propagatorFields = typeof propagator.fields === "function" ? propagator.fields() : [];
          for (const field of propagatorFields) {
            fields.add(field);
          }
        }
        this._fields = Array.from(fields);
      }
      /**
       * Run each of the configured propagators with the given context and carrier.
       * Propagators are run in the order they are configured, so if multiple
       * propagators write the same carrier key, the propagator later in the list
       * will "win".
       *
       * @param context Context to inject
       * @param carrier Carrier into which context will be injected
       */
      inject(context, carrier, setter) {
        for (const propagator of this._propagators) {
          try {
            propagator.inject(context, carrier, setter);
          } catch (err) {
            api_1.diag.warn(`Failed to inject with ${propagator.constructor.name}. Err: ${err.message}`);
          }
        }
      }
      /**
       * Run each of the configured propagators with the given context and carrier.
       * Propagators are run in the order they are configured, so if multiple
       * propagators write the same context key, the propagator later in the list
       * will "win".
       *
       * @param context Context to add values to
       * @param carrier Carrier from which to extract context
       */
      extract(context, carrier, getter) {
        return this._propagators.reduce((ctx, propagator) => {
          try {
            return propagator.extract(ctx, carrier, getter);
          } catch (err) {
            api_1.diag.warn(`Failed to extract with ${propagator.constructor.name}. Err: ${err.message}`);
          }
          return ctx;
        }, context);
      }
      fields() {
        return this._fields.slice();
      }
    };
    exports.CompositePropagator = CompositePropagator;
  }
});

// node_modules/@opentelemetry/core/build/src/internal/validators.js
var require_validators = __commonJS({
  "node_modules/@opentelemetry/core/build/src/internal/validators.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.validateValue = exports.validateKey = void 0;
    var VALID_KEY_CHAR_RANGE = "[_0-9a-z-*/]";
    var VALID_KEY = `[a-z]${VALID_KEY_CHAR_RANGE}{0,255}`;
    var VALID_VENDOR_KEY = `[a-z0-9]${VALID_KEY_CHAR_RANGE}{0,240}@[a-z]${VALID_KEY_CHAR_RANGE}{0,13}`;
    var VALID_KEY_REGEX = new RegExp(`^(?:${VALID_KEY}|${VALID_VENDOR_KEY})$`);
    var VALID_VALUE_BASE_REGEX = /^[ -~]{0,255}[!-~]$/;
    var INVALID_VALUE_COMMA_EQUAL_REGEX = /,|=/;
    function validateKey(key) {
      return VALID_KEY_REGEX.test(key);
    }
    __name(validateKey, "validateKey");
    exports.validateKey = validateKey;
    function validateValue(value) {
      return VALID_VALUE_BASE_REGEX.test(value) && !INVALID_VALUE_COMMA_EQUAL_REGEX.test(value);
    }
    __name(validateValue, "validateValue");
    exports.validateValue = validateValue;
  }
});

// node_modules/@opentelemetry/core/build/src/trace/TraceState.js
var require_TraceState = __commonJS({
  "node_modules/@opentelemetry/core/build/src/trace/TraceState.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.TraceState = void 0;
    var validators_1 = require_validators();
    var MAX_TRACE_STATE_ITEMS = 32;
    var MAX_TRACE_STATE_LEN = 512;
    var LIST_MEMBERS_SEPARATOR = ",";
    var LIST_MEMBER_KEY_VALUE_SPLITTER = "=";
    var TraceState = class _TraceState {
      static {
        __name(this, "TraceState");
      }
      _length;
      _rawTraceState;
      _internalState;
      constructor(rawTraceState) {
        this._rawTraceState = typeof rawTraceState === "string" ? rawTraceState : "";
        this._length = this._rawTraceState.length;
      }
      set(key, value) {
        if (!(0, validators_1.validateKey)(key) || !(0, validators_1.validateValue)(value)) {
          return this;
        }
        const currState = this._getState();
        const currValue = currState.get(key);
        let newLength = this._length;
        if (typeof currValue === "string") {
          newLength += value.length - currValue.length;
        } else {
          newLength += key.length + value.length + (currState.size > 0 ? 2 : 1);
        }
        if (newLength > MAX_TRACE_STATE_LEN) {
          return this;
        }
        const newState = new Map(currState);
        newState.delete(key);
        newState.set(key, value);
        return this._fromState(newState, newLength);
      }
      unset(key) {
        const currState = this._getState();
        const currValue = currState.get(key);
        if (typeof currValue !== "string") {
          return this;
        }
        let newLength = this._length - (key.length + currValue.length + 1);
        if (currState.size > 1) {
          newLength = newLength - 1;
        }
        const newState = new Map(currState);
        newState.delete(key);
        return this._fromState(newState, newLength);
      }
      get(key) {
        const currState = this._getState();
        return currState.get(key);
      }
      serialize() {
        let serialized = "";
        let index = 0;
        for (const entry of this._getState()) {
          if (index > 0) {
            serialized = LIST_MEMBERS_SEPARATOR + serialized;
          }
          serialized = `${entry[0]}${LIST_MEMBER_KEY_VALUE_SPLITTER}${entry[1]}` + serialized;
          index++;
        }
        return serialized;
      }
      _getState() {
        if (this._internalState) {
          return this._internalState;
        }
        const vendorMembers = this._rawTraceState.split(LIST_MEMBERS_SEPARATOR);
        const vendorEntries = /* @__PURE__ */ new Map();
        let currentLength = 0;
        for (const member of vendorMembers) {
          const m = member.trim();
          const idx = m.indexOf(LIST_MEMBER_KEY_VALUE_SPLITTER);
          if (idx === -1) {
            continue;
          }
          const key = m.slice(0, idx);
          const value = m.slice(idx + 1);
          if (!(0, validators_1.validateKey)(key) || !(0, validators_1.validateValue)(value)) {
            continue;
          }
          const futureLength = currentLength + m.length + (vendorEntries.size > 0 ? 1 : 0);
          if (futureLength > MAX_TRACE_STATE_LEN) {
            continue;
          }
          vendorEntries.set(key, value);
          currentLength = futureLength;
          if (vendorEntries.size >= MAX_TRACE_STATE_ITEMS) {
            break;
          }
        }
        this._length = currentLength;
        this._internalState = new Map(Array.from(vendorEntries.entries()).reverse());
        return this._internalState;
      }
      _fromState(state, length) {
        const traceState = Object.create(_TraceState.prototype);
        traceState._internalState = state;
        traceState._length = length;
        return traceState;
      }
    };
    exports.TraceState = TraceState;
  }
});

// node_modules/@opentelemetry/core/build/src/trace/W3CTraceContextPropagator.js
var require_W3CTraceContextPropagator = __commonJS({
  "node_modules/@opentelemetry/core/build/src/trace/W3CTraceContextPropagator.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.W3CTraceContextPropagator = exports.parseTraceParent = exports.TRACE_STATE_HEADER = exports.TRACE_PARENT_HEADER = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var suppress_tracing_1 = require_suppress_tracing();
    var TraceState_1 = require_TraceState();
    exports.TRACE_PARENT_HEADER = "traceparent";
    exports.TRACE_STATE_HEADER = "tracestate";
    var VERSION = "00";
    var VERSION_PART = "(?!ff)[\\da-f]{2}";
    var TRACE_ID_PART = "(?![0]{32})[\\da-f]{32}";
    var PARENT_ID_PART = "(?![0]{16})[\\da-f]{16}";
    var FLAGS_PART = "[\\da-f]{2}";
    var TRACE_PARENT_REGEX = new RegExp(`^\\s?(${VERSION_PART})-(${TRACE_ID_PART})-(${PARENT_ID_PART})-(${FLAGS_PART})(-.*)?\\s?$`);
    function parseTraceParent(traceParent) {
      const match = TRACE_PARENT_REGEX.exec(traceParent);
      if (!match)
        return null;
      if (match[1] === "00" && match[5])
        return null;
      return {
        traceId: match[2],
        spanId: match[3],
        traceFlags: parseInt(match[4], 16)
      };
    }
    __name(parseTraceParent, "parseTraceParent");
    exports.parseTraceParent = parseTraceParent;
    var W3CTraceContextPropagator = class {
      static {
        __name(this, "W3CTraceContextPropagator");
      }
      inject(context, carrier, setter) {
        const spanContext = api_1.trace.getSpanContext(context);
        if (!spanContext || (0, suppress_tracing_1.isTracingSuppressed)(context) || !(0, api_1.isSpanContextValid)(spanContext))
          return;
        const traceParent = `${VERSION}-${spanContext.traceId}-${spanContext.spanId}-0${Number(spanContext.traceFlags || api_1.TraceFlags.NONE).toString(16)}`;
        setter.set(carrier, exports.TRACE_PARENT_HEADER, traceParent);
        if (spanContext.traceState) {
          setter.set(carrier, exports.TRACE_STATE_HEADER, spanContext.traceState.serialize());
        }
      }
      extract(context, carrier, getter) {
        const traceParentHeader = getter.get(carrier, exports.TRACE_PARENT_HEADER);
        if (!traceParentHeader)
          return context;
        const traceParent = Array.isArray(traceParentHeader) ? traceParentHeader[0] : traceParentHeader;
        if (typeof traceParent !== "string")
          return context;
        const spanContext = parseTraceParent(traceParent);
        if (!spanContext)
          return context;
        spanContext.isRemote = true;
        const traceStateHeader = getter.get(carrier, exports.TRACE_STATE_HEADER);
        if (traceStateHeader) {
          const state = Array.isArray(traceStateHeader) ? traceStateHeader.join(",") : traceStateHeader;
          spanContext.traceState = new TraceState_1.TraceState(typeof state === "string" ? state : void 0);
        }
        return api_1.trace.setSpanContext(context, spanContext);
      }
      fields() {
        return [exports.TRACE_PARENT_HEADER, exports.TRACE_STATE_HEADER];
      }
    };
    exports.W3CTraceContextPropagator = W3CTraceContextPropagator;
  }
});

// node_modules/@opentelemetry/core/build/src/trace/rpc-metadata.js
var require_rpc_metadata = __commonJS({
  "node_modules/@opentelemetry/core/build/src/trace/rpc-metadata.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getRPCMetadata = exports.deleteRPCMetadata = exports.setRPCMetadata = exports.RPCType = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var RPC_METADATA_KEY = (0, api_1.createContextKey)("OpenTelemetry SDK Context Key RPC_METADATA");
    var RPCType;
    (function(RPCType2) {
      RPCType2["HTTP"] = "http";
    })(RPCType || (exports.RPCType = RPCType = {}));
    function setRPCMetadata(context, meta) {
      return context.setValue(RPC_METADATA_KEY, meta);
    }
    __name(setRPCMetadata, "setRPCMetadata");
    exports.setRPCMetadata = setRPCMetadata;
    function deleteRPCMetadata(context) {
      return context.deleteValue(RPC_METADATA_KEY);
    }
    __name(deleteRPCMetadata, "deleteRPCMetadata");
    exports.deleteRPCMetadata = deleteRPCMetadata;
    function getRPCMetadata(context) {
      return context.getValue(RPC_METADATA_KEY);
    }
    __name(getRPCMetadata, "getRPCMetadata");
    exports.getRPCMetadata = getRPCMetadata;
  }
});

// node_modules/@opentelemetry/core/build/src/utils/lodash.merge.js
var require_lodash_merge = __commonJS({
  "node_modules/@opentelemetry/core/build/src/utils/lodash.merge.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isPlainObject = void 0;
    var objectTag = "[object Object]";
    var nullTag = "[object Null]";
    var undefinedTag = "[object Undefined]";
    var funcProto = Function.prototype;
    var funcToString = funcProto.toString;
    var objectCtorString = funcToString.call(Object);
    var getPrototypeOf = Object.getPrototypeOf;
    var objectProto = Object.prototype;
    var hasOwnProperty = objectProto.hasOwnProperty;
    var symToStringTag = Symbol ? Symbol.toStringTag : void 0;
    var nativeObjectToString = objectProto.toString;
    function isPlainObject(value) {
      if (!isObjectLike(value) || baseGetTag(value) !== objectTag) {
        return false;
      }
      const proto = getPrototypeOf(value);
      if (proto === null) {
        return true;
      }
      const Ctor = hasOwnProperty.call(proto, "constructor") && proto.constructor;
      return typeof Ctor == "function" && Ctor instanceof Ctor && funcToString.call(Ctor) === objectCtorString;
    }
    __name(isPlainObject, "isPlainObject");
    exports.isPlainObject = isPlainObject;
    function isObjectLike(value) {
      return value != null && typeof value == "object";
    }
    __name(isObjectLike, "isObjectLike");
    function baseGetTag(value) {
      if (value == null) {
        return value === void 0 ? undefinedTag : nullTag;
      }
      return symToStringTag && symToStringTag in Object(value) ? getRawTag(value) : objectToString(value);
    }
    __name(baseGetTag, "baseGetTag");
    function getRawTag(value) {
      const isOwn = hasOwnProperty.call(value, symToStringTag), tag = value[symToStringTag];
      let unmasked = false;
      try {
        value[symToStringTag] = void 0;
        unmasked = true;
      } catch {
      }
      const result = nativeObjectToString.call(value);
      if (unmasked) {
        if (isOwn) {
          value[symToStringTag] = tag;
        } else {
          delete value[symToStringTag];
        }
      }
      return result;
    }
    __name(getRawTag, "getRawTag");
    function objectToString(value) {
      return nativeObjectToString.call(value);
    }
    __name(objectToString, "objectToString");
  }
});

// node_modules/@opentelemetry/core/build/src/utils/merge.js
var require_merge = __commonJS({
  "node_modules/@opentelemetry/core/build/src/utils/merge.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.merge = void 0;
    var lodash_merge_1 = require_lodash_merge();
    var MAX_LEVEL = 20;
    function merge(...args) {
      let result = args.shift();
      const objects = /* @__PURE__ */ new WeakMap();
      while (args.length > 0) {
        result = mergeTwoObjects(result, args.shift(), 0, objects);
      }
      return result;
    }
    __name(merge, "merge");
    exports.merge = merge;
    function takeValue(value) {
      if (isArray(value)) {
        return value.slice();
      }
      return value;
    }
    __name(takeValue, "takeValue");
    function mergeTwoObjects(one, two, level = 0, objects) {
      let result;
      if (level > MAX_LEVEL) {
        return void 0;
      }
      level++;
      if (isPrimitive(one) || isPrimitive(two) || isFunction(two)) {
        result = takeValue(two);
      } else if (isArray(one)) {
        result = one.slice();
        if (isArray(two)) {
          for (let i = 0, j = two.length; i < j; i++) {
            result.push(takeValue(two[i]));
          }
        } else if (isObject(two)) {
          const keys = Object.keys(two);
          for (let i = 0, j = keys.length; i < j; i++) {
            const key = keys[i];
            if (key === "__proto__" || key === "constructor" || key === "prototype") {
              continue;
            }
            result[key] = takeValue(two[key]);
          }
        }
      } else if (isObject(one)) {
        if (isObject(two)) {
          if (!shouldMerge(one, two)) {
            return two;
          }
          result = Object.assign({}, one);
          const keys = Object.keys(two);
          for (let i = 0, j = keys.length; i < j; i++) {
            const key = keys[i];
            if (key === "__proto__" || key === "constructor" || key === "prototype") {
              continue;
            }
            const twoValue = two[key];
            if (isPrimitive(twoValue)) {
              if (typeof twoValue === "undefined") {
                delete result[key];
              } else {
                result[key] = twoValue;
              }
            } else {
              const obj1 = result[key];
              const obj2 = twoValue;
              if (wasObjectReferenced(one, key, objects) || wasObjectReferenced(two, key, objects)) {
                delete result[key];
              } else {
                if (isObject(obj1) && isObject(obj2)) {
                  const arr1 = objects.get(obj1) || [];
                  const arr2 = objects.get(obj2) || [];
                  arr1.push({ obj: one, key });
                  arr2.push({ obj: two, key });
                  objects.set(obj1, arr1);
                  objects.set(obj2, arr2);
                }
                result[key] = mergeTwoObjects(result[key], twoValue, level, objects);
              }
            }
          }
        } else {
          result = two;
        }
      }
      return result;
    }
    __name(mergeTwoObjects, "mergeTwoObjects");
    function wasObjectReferenced(obj, key, objects) {
      const arr = objects.get(obj[key]) || [];
      for (let i = 0, j = arr.length; i < j; i++) {
        const info = arr[i];
        if (info.key === key && info.obj === obj) {
          return true;
        }
      }
      return false;
    }
    __name(wasObjectReferenced, "wasObjectReferenced");
    function isArray(value) {
      return Array.isArray(value);
    }
    __name(isArray, "isArray");
    function isFunction(value) {
      return typeof value === "function";
    }
    __name(isFunction, "isFunction");
    function isObject(value) {
      return !isPrimitive(value) && !isArray(value) && !isFunction(value) && typeof value === "object";
    }
    __name(isObject, "isObject");
    function isPrimitive(value) {
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "undefined" || value instanceof Date || value instanceof RegExp || value === null;
    }
    __name(isPrimitive, "isPrimitive");
    function shouldMerge(one, two) {
      if (!(0, lodash_merge_1.isPlainObject)(one) || !(0, lodash_merge_1.isPlainObject)(two)) {
        return false;
      }
      return true;
    }
    __name(shouldMerge, "shouldMerge");
  }
});

// node_modules/@opentelemetry/core/build/src/utils/timeout.js
var require_timeout = __commonJS({
  "node_modules/@opentelemetry/core/build/src/utils/timeout.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.callWithTimeout = exports.TimeoutError = void 0;
    var TimeoutError = class _TimeoutError extends Error {
      static {
        __name(this, "TimeoutError");
      }
      constructor(message) {
        super(message);
        Object.setPrototypeOf(this, _TimeoutError.prototype);
      }
    };
    exports.TimeoutError = TimeoutError;
    function callWithTimeout(promise, timeout) {
      let timeoutHandle;
      const timeoutPromise = new Promise(/* @__PURE__ */ __name(function timeoutFunction(_resolve, reject) {
        timeoutHandle = setTimeout(/* @__PURE__ */ __name(function timeoutHandler() {
          reject(new TimeoutError("Operation timed out."));
        }, "timeoutHandler"), timeout);
      }, "timeoutFunction"));
      return Promise.race([promise, timeoutPromise]).then((result) => {
        clearTimeout(timeoutHandle);
        return result;
      }, (reason) => {
        clearTimeout(timeoutHandle);
        throw reason;
      });
    }
    __name(callWithTimeout, "callWithTimeout");
    exports.callWithTimeout = callWithTimeout;
  }
});

// node_modules/@opentelemetry/core/build/src/utils/url.js
var require_url = __commonJS({
  "node_modules/@opentelemetry/core/build/src/utils/url.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isUrlIgnored = exports.urlMatches = void 0;
    function urlMatches(url, urlToMatch) {
      if (typeof urlToMatch === "string") {
        return url === urlToMatch;
      } else {
        return !!url.match(urlToMatch);
      }
    }
    __name(urlMatches, "urlMatches");
    exports.urlMatches = urlMatches;
    function isUrlIgnored(url, ignoredUrls) {
      if (!ignoredUrls) {
        return false;
      }
      for (const ignoreUrl of ignoredUrls) {
        if (urlMatches(url, ignoreUrl)) {
          return true;
        }
      }
      return false;
    }
    __name(isUrlIgnored, "isUrlIgnored");
    exports.isUrlIgnored = isUrlIgnored;
  }
});

// node_modules/@opentelemetry/core/build/src/utils/promise.js
var require_promise = __commonJS({
  "node_modules/@opentelemetry/core/build/src/utils/promise.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Deferred = void 0;
    var Deferred = class {
      static {
        __name(this, "Deferred");
      }
      _promise;
      _resolve;
      _reject;
      constructor() {
        this._promise = new Promise((resolve, reject) => {
          this._resolve = resolve;
          this._reject = reject;
        });
      }
      get promise() {
        return this._promise;
      }
      resolve(val) {
        this._resolve(val);
      }
      reject(err) {
        this._reject(err);
      }
    };
    exports.Deferred = Deferred;
  }
});

// node_modules/@opentelemetry/core/build/src/utils/callback.js
var require_callback = __commonJS({
  "node_modules/@opentelemetry/core/build/src/utils/callback.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BindOnceFuture = void 0;
    var promise_1 = require_promise();
    var BindOnceFuture = class {
      static {
        __name(this, "BindOnceFuture");
      }
      _isCalled = false;
      _deferred = new promise_1.Deferred();
      _callback;
      _that;
      constructor(callback, that) {
        this._callback = callback;
        this._that = that;
      }
      get isCalled() {
        return this._isCalled;
      }
      get promise() {
        return this._deferred.promise;
      }
      call(...args) {
        if (!this._isCalled) {
          this._isCalled = true;
          try {
            Promise.resolve(this._callback.call(this._that, ...args)).then((val) => this._deferred.resolve(val), (err) => this._deferred.reject(err));
          } catch (err) {
            this._deferred.reject(err);
          }
        }
        return this._deferred.promise;
      }
    };
    exports.BindOnceFuture = BindOnceFuture;
  }
});

// node_modules/@opentelemetry/core/build/src/utils/configuration.js
var require_configuration = __commonJS({
  "node_modules/@opentelemetry/core/build/src/utils/configuration.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.diagLogLevelFromString = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var logLevelMap = {
      ALL: api_1.DiagLogLevel.ALL,
      VERBOSE: api_1.DiagLogLevel.VERBOSE,
      DEBUG: api_1.DiagLogLevel.DEBUG,
      INFO: api_1.DiagLogLevel.INFO,
      WARN: api_1.DiagLogLevel.WARN,
      ERROR: api_1.DiagLogLevel.ERROR,
      NONE: api_1.DiagLogLevel.NONE
    };
    function diagLogLevelFromString(value) {
      if (value == null) {
        return void 0;
      }
      const resolvedLogLevel = logLevelMap[value.toUpperCase()];
      if (resolvedLogLevel == null) {
        api_1.diag.warn(`Unknown log level "${value}", expected one of ${Object.keys(logLevelMap)}, using default`);
        return api_1.DiagLogLevel.INFO;
      }
      return resolvedLogLevel;
    }
    __name(diagLogLevelFromString, "diagLogLevelFromString");
    exports.diagLogLevelFromString = diagLogLevelFromString;
  }
});

// node_modules/@opentelemetry/core/build/src/internal/exporter.js
var require_exporter = __commonJS({
  "node_modules/@opentelemetry/core/build/src/internal/exporter.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports._export = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var suppress_tracing_1 = require_suppress_tracing();
    function _export(exporter, arg) {
      return new Promise((resolve) => {
        api_1.context.with((0, suppress_tracing_1.suppressTracing)(api_1.context.active()), () => {
          exporter.export(arg, resolve);
        });
      });
    }
    __name(_export, "_export");
    exports._export = _export;
  }
});

// node_modules/@opentelemetry/core/build/src/index.js
var require_src = __commonJS({
  "node_modules/@opentelemetry/core/build/src/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.diagLogLevelFromString = exports.BindOnceFuture = exports.urlMatches = exports.isUrlIgnored = exports.callWithTimeout = exports.TimeoutError = exports.merge = exports.TraceState = exports.unsuppressTracing = exports.suppressTracing = exports.isTracingSuppressed = exports.setRPCMetadata = exports.getRPCMetadata = exports.deleteRPCMetadata = exports.RPCType = exports.parseTraceParent = exports.W3CTraceContextPropagator = exports.TRACE_STATE_HEADER = exports.TRACE_PARENT_HEADER = exports.CompositePropagator = exports.otperformance = exports.getStringListFromEnv = exports.getNumberFromEnv = exports.getBooleanFromEnv = exports.getStringFromEnv = exports._globalThis = exports.SDK_INFO = exports.parseKeyPairsIntoRecord = exports.ExportResultCode = exports.unrefTimer = exports.timeInputToHrTime = exports.millisToHrTime = exports.isTimeInputHrTime = exports.isTimeInput = exports.hrTimeToTimeStamp = exports.hrTimeToSeconds = exports.hrTimeToNanoseconds = exports.hrTimeToMilliseconds = exports.hrTimeToMicroseconds = exports.hrTimeDuration = exports.hrTime = exports.getTimeOrigin = exports.addHrTimes = exports.loggingErrorHandler = exports.setGlobalErrorHandler = exports.globalErrorHandler = exports.sanitizeAttributes = exports.isAttributeValue = exports.AnchoredClock = exports.W3CBaggagePropagator = void 0;
    exports.internal = void 0;
    var W3CBaggagePropagator_1 = require_W3CBaggagePropagator();
    Object.defineProperty(exports, "W3CBaggagePropagator", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return W3CBaggagePropagator_1.W3CBaggagePropagator;
    }, "get") });
    var anchored_clock_1 = require_anchored_clock();
    Object.defineProperty(exports, "AnchoredClock", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return anchored_clock_1.AnchoredClock;
    }, "get") });
    var attributes_1 = require_attributes();
    Object.defineProperty(exports, "isAttributeValue", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return attributes_1.isAttributeValue;
    }, "get") });
    Object.defineProperty(exports, "sanitizeAttributes", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return attributes_1.sanitizeAttributes;
    }, "get") });
    var global_error_handler_1 = require_global_error_handler();
    Object.defineProperty(exports, "globalErrorHandler", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return global_error_handler_1.globalErrorHandler;
    }, "get") });
    Object.defineProperty(exports, "setGlobalErrorHandler", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return global_error_handler_1.setGlobalErrorHandler;
    }, "get") });
    var logging_error_handler_1 = require_logging_error_handler();
    Object.defineProperty(exports, "loggingErrorHandler", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return logging_error_handler_1.loggingErrorHandler;
    }, "get") });
    var time_1 = require_time();
    Object.defineProperty(exports, "addHrTimes", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return time_1.addHrTimes;
    }, "get") });
    Object.defineProperty(exports, "getTimeOrigin", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return time_1.getTimeOrigin;
    }, "get") });
    Object.defineProperty(exports, "hrTime", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return time_1.hrTime;
    }, "get") });
    Object.defineProperty(exports, "hrTimeDuration", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return time_1.hrTimeDuration;
    }, "get") });
    Object.defineProperty(exports, "hrTimeToMicroseconds", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return time_1.hrTimeToMicroseconds;
    }, "get") });
    Object.defineProperty(exports, "hrTimeToMilliseconds", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return time_1.hrTimeToMilliseconds;
    }, "get") });
    Object.defineProperty(exports, "hrTimeToNanoseconds", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return time_1.hrTimeToNanoseconds;
    }, "get") });
    Object.defineProperty(exports, "hrTimeToSeconds", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return time_1.hrTimeToSeconds;
    }, "get") });
    Object.defineProperty(exports, "hrTimeToTimeStamp", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return time_1.hrTimeToTimeStamp;
    }, "get") });
    Object.defineProperty(exports, "isTimeInput", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return time_1.isTimeInput;
    }, "get") });
    Object.defineProperty(exports, "isTimeInputHrTime", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return time_1.isTimeInputHrTime;
    }, "get") });
    Object.defineProperty(exports, "millisToHrTime", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return time_1.millisToHrTime;
    }, "get") });
    Object.defineProperty(exports, "timeInputToHrTime", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return time_1.timeInputToHrTime;
    }, "get") });
    var timer_util_1 = require_timer_util();
    Object.defineProperty(exports, "unrefTimer", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return timer_util_1.unrefTimer;
    }, "get") });
    var ExportResult_1 = require_ExportResult();
    Object.defineProperty(exports, "ExportResultCode", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return ExportResult_1.ExportResultCode;
    }, "get") });
    var utils_1 = require_utils();
    Object.defineProperty(exports, "parseKeyPairsIntoRecord", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return utils_1.parseKeyPairsIntoRecord;
    }, "get") });
    var platform_1 = require_platform();
    Object.defineProperty(exports, "SDK_INFO", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return platform_1.SDK_INFO;
    }, "get") });
    Object.defineProperty(exports, "_globalThis", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return platform_1._globalThis;
    }, "get") });
    Object.defineProperty(exports, "getStringFromEnv", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return platform_1.getStringFromEnv;
    }, "get") });
    Object.defineProperty(exports, "getBooleanFromEnv", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return platform_1.getBooleanFromEnv;
    }, "get") });
    Object.defineProperty(exports, "getNumberFromEnv", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return platform_1.getNumberFromEnv;
    }, "get") });
    Object.defineProperty(exports, "getStringListFromEnv", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return platform_1.getStringListFromEnv;
    }, "get") });
    Object.defineProperty(exports, "otperformance", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return platform_1.otperformance;
    }, "get") });
    var composite_1 = require_composite();
    Object.defineProperty(exports, "CompositePropagator", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return composite_1.CompositePropagator;
    }, "get") });
    var W3CTraceContextPropagator_1 = require_W3CTraceContextPropagator();
    Object.defineProperty(exports, "TRACE_PARENT_HEADER", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return W3CTraceContextPropagator_1.TRACE_PARENT_HEADER;
    }, "get") });
    Object.defineProperty(exports, "TRACE_STATE_HEADER", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return W3CTraceContextPropagator_1.TRACE_STATE_HEADER;
    }, "get") });
    Object.defineProperty(exports, "W3CTraceContextPropagator", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return W3CTraceContextPropagator_1.W3CTraceContextPropagator;
    }, "get") });
    Object.defineProperty(exports, "parseTraceParent", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return W3CTraceContextPropagator_1.parseTraceParent;
    }, "get") });
    var rpc_metadata_1 = require_rpc_metadata();
    Object.defineProperty(exports, "RPCType", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return rpc_metadata_1.RPCType;
    }, "get") });
    Object.defineProperty(exports, "deleteRPCMetadata", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return rpc_metadata_1.deleteRPCMetadata;
    }, "get") });
    Object.defineProperty(exports, "getRPCMetadata", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return rpc_metadata_1.getRPCMetadata;
    }, "get") });
    Object.defineProperty(exports, "setRPCMetadata", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return rpc_metadata_1.setRPCMetadata;
    }, "get") });
    var suppress_tracing_1 = require_suppress_tracing();
    Object.defineProperty(exports, "isTracingSuppressed", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return suppress_tracing_1.isTracingSuppressed;
    }, "get") });
    Object.defineProperty(exports, "suppressTracing", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return suppress_tracing_1.suppressTracing;
    }, "get") });
    Object.defineProperty(exports, "unsuppressTracing", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return suppress_tracing_1.unsuppressTracing;
    }, "get") });
    var TraceState_1 = require_TraceState();
    Object.defineProperty(exports, "TraceState", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return TraceState_1.TraceState;
    }, "get") });
    var merge_1 = require_merge();
    Object.defineProperty(exports, "merge", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return merge_1.merge;
    }, "get") });
    var timeout_1 = require_timeout();
    Object.defineProperty(exports, "TimeoutError", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return timeout_1.TimeoutError;
    }, "get") });
    Object.defineProperty(exports, "callWithTimeout", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return timeout_1.callWithTimeout;
    }, "get") });
    var url_1 = require_url();
    Object.defineProperty(exports, "isUrlIgnored", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return url_1.isUrlIgnored;
    }, "get") });
    Object.defineProperty(exports, "urlMatches", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return url_1.urlMatches;
    }, "get") });
    var callback_1 = require_callback();
    Object.defineProperty(exports, "BindOnceFuture", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return callback_1.BindOnceFuture;
    }, "get") });
    var configuration_1 = require_configuration();
    Object.defineProperty(exports, "diagLogLevelFromString", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return configuration_1.diagLogLevelFromString;
    }, "get") });
    var exporter_1 = require_exporter();
    exports.internal = {
      _export: exporter_1._export
    };
  }
});

// packages/core/node_modules/@opentelemetry/resources/build/src/default-service-name.js
var require_default_service_name = __commonJS({
  "packages/core/node_modules/@opentelemetry/resources/build/src/default-service-name.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports._clearDefaultServiceNameCache = exports.defaultServiceName = void 0;
    var serviceName;
    function defaultServiceName() {
      if (serviceName === void 0) {
        try {
          const argv0 = globalThis.process.argv0;
          serviceName = argv0 ? `unknown_service:${argv0}` : "unknown_service";
        } catch {
          serviceName = "unknown_service";
        }
      }
      return serviceName;
    }
    __name(defaultServiceName, "defaultServiceName");
    exports.defaultServiceName = defaultServiceName;
    function _clearDefaultServiceNameCache() {
      serviceName = void 0;
    }
    __name(_clearDefaultServiceNameCache, "_clearDefaultServiceNameCache");
    exports._clearDefaultServiceNameCache = _clearDefaultServiceNameCache;
  }
});

// packages/core/node_modules/@opentelemetry/resources/build/src/utils.js
var require_utils2 = __commonJS({
  "packages/core/node_modules/@opentelemetry/resources/build/src/utils.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isPromiseLike = void 0;
    var isPromiseLike = /* @__PURE__ */ __name((val) => {
      return val !== null && typeof val === "object" && typeof val.then === "function";
    }, "isPromiseLike");
    exports.isPromiseLike = isPromiseLike;
  }
});

// packages/core/node_modules/@opentelemetry/resources/build/src/ResourceImpl.js
var require_ResourceImpl = __commonJS({
  "packages/core/node_modules/@opentelemetry/resources/build/src/ResourceImpl.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.defaultResource = exports.emptyResource = exports.resourceFromDetectedResource = exports.resourceFromAttributes = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var core_1 = require_src();
    var semantic_conventions_1 = (init_esm2(), __toCommonJS(esm_exports2));
    var default_service_name_1 = require_default_service_name();
    var utils_1 = require_utils2();
    var ResourceImpl = class _ResourceImpl {
      static {
        __name(this, "ResourceImpl");
      }
      _rawAttributes;
      _asyncAttributesPending = false;
      _schemaUrl;
      _memoizedAttributes;
      static FromAttributeList(attributes, options) {
        const res = new _ResourceImpl({}, options);
        res._rawAttributes = guardedRawAttributes(attributes);
        res._asyncAttributesPending = attributes.filter(([_, val]) => (0, utils_1.isPromiseLike)(val)).length > 0;
        return res;
      }
      constructor(resource, options) {
        const attributes = resource.attributes ?? {};
        this._rawAttributes = Object.entries(attributes).map(([k, v]) => {
          if ((0, utils_1.isPromiseLike)(v)) {
            this._asyncAttributesPending = true;
          }
          return [k, v];
        });
        this._rawAttributes = guardedRawAttributes(this._rawAttributes);
        this._schemaUrl = validateSchemaUrl(options?.schemaUrl);
      }
      get asyncAttributesPending() {
        return this._asyncAttributesPending;
      }
      async waitForAsyncAttributes() {
        if (!this.asyncAttributesPending) {
          return;
        }
        for (let i = 0; i < this._rawAttributes.length; i++) {
          const [k, v] = this._rawAttributes[i];
          this._rawAttributes[i] = [k, (0, utils_1.isPromiseLike)(v) ? await v : v];
        }
        this._asyncAttributesPending = false;
      }
      get attributes() {
        if (this.asyncAttributesPending) {
          api_1.diag.error("Accessing resource attributes before async attributes settled");
        }
        if (this._memoizedAttributes) {
          return this._memoizedAttributes;
        }
        const attrs = {};
        for (const [k, v] of this._rawAttributes) {
          if ((0, utils_1.isPromiseLike)(v)) {
            api_1.diag.debug(`Unsettled resource attribute ${k} skipped`);
            continue;
          }
          if (v != null) {
            attrs[k] ??= v;
          }
        }
        if (!this._asyncAttributesPending) {
          this._memoizedAttributes = attrs;
        }
        return attrs;
      }
      getRawAttributes() {
        return this._rawAttributes;
      }
      get schemaUrl() {
        return this._schemaUrl;
      }
      merge(resource) {
        if (resource == null)
          return this;
        const mergedSchemaUrl = mergeSchemaUrl(this, resource);
        const mergedOptions = mergedSchemaUrl ? { schemaUrl: mergedSchemaUrl } : void 0;
        return _ResourceImpl.FromAttributeList([...resource.getRawAttributes(), ...this.getRawAttributes()], mergedOptions);
      }
    };
    function resourceFromAttributes(attributes, options) {
      return ResourceImpl.FromAttributeList(Object.entries(attributes), options);
    }
    __name(resourceFromAttributes, "resourceFromAttributes");
    exports.resourceFromAttributes = resourceFromAttributes;
    function resourceFromDetectedResource(detectedResource, options) {
      return new ResourceImpl(detectedResource, options);
    }
    __name(resourceFromDetectedResource, "resourceFromDetectedResource");
    exports.resourceFromDetectedResource = resourceFromDetectedResource;
    function emptyResource() {
      return resourceFromAttributes({});
    }
    __name(emptyResource, "emptyResource");
    exports.emptyResource = emptyResource;
    function defaultResource() {
      return resourceFromAttributes({
        [semantic_conventions_1.ATTR_SERVICE_NAME]: (0, default_service_name_1.defaultServiceName)(),
        [semantic_conventions_1.ATTR_TELEMETRY_SDK_LANGUAGE]: core_1.SDK_INFO[semantic_conventions_1.ATTR_TELEMETRY_SDK_LANGUAGE],
        [semantic_conventions_1.ATTR_TELEMETRY_SDK_NAME]: core_1.SDK_INFO[semantic_conventions_1.ATTR_TELEMETRY_SDK_NAME],
        [semantic_conventions_1.ATTR_TELEMETRY_SDK_VERSION]: core_1.SDK_INFO[semantic_conventions_1.ATTR_TELEMETRY_SDK_VERSION]
      });
    }
    __name(defaultResource, "defaultResource");
    exports.defaultResource = defaultResource;
    function guardedRawAttributes(attributes) {
      return attributes.map(([k, v]) => {
        if ((0, utils_1.isPromiseLike)(v)) {
          return [
            k,
            v.catch((err) => {
              api_1.diag.debug("promise rejection for resource attribute: %s - %s", k, err);
              return void 0;
            })
          ];
        }
        return [k, v];
      });
    }
    __name(guardedRawAttributes, "guardedRawAttributes");
    function validateSchemaUrl(schemaUrl) {
      if (typeof schemaUrl === "string" || schemaUrl === void 0) {
        return schemaUrl;
      }
      api_1.diag.warn("Schema URL must be string or undefined, got %s. Schema URL will be ignored.", schemaUrl);
      return void 0;
    }
    __name(validateSchemaUrl, "validateSchemaUrl");
    function mergeSchemaUrl(old, updating) {
      const oldSchemaUrl = old?.schemaUrl;
      const updatingSchemaUrl = updating?.schemaUrl;
      const isOldEmpty = oldSchemaUrl === void 0 || oldSchemaUrl === "";
      const isUpdatingEmpty = updatingSchemaUrl === void 0 || updatingSchemaUrl === "";
      if (isOldEmpty) {
        return updatingSchemaUrl;
      }
      if (isUpdatingEmpty) {
        return oldSchemaUrl;
      }
      if (oldSchemaUrl === updatingSchemaUrl) {
        return oldSchemaUrl;
      }
      api_1.diag.warn('Schema URL merge conflict: old resource has "%s", updating resource has "%s". Resulting resource will have undefined Schema URL.', oldSchemaUrl, updatingSchemaUrl);
      return void 0;
    }
    __name(mergeSchemaUrl, "mergeSchemaUrl");
  }
});

// packages/core/node_modules/@opentelemetry/resources/build/src/detect-resources.js
var require_detect_resources = __commonJS({
  "packages/core/node_modules/@opentelemetry/resources/build/src/detect-resources.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.detectResources = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var ResourceImpl_1 = require_ResourceImpl();
    var detectResources = /* @__PURE__ */ __name((config = {}) => {
      const resources = (config.detectors || []).map((d) => {
        try {
          const resource = (0, ResourceImpl_1.resourceFromDetectedResource)(d.detect(config));
          api_1.diag.debug(`${d.constructor.name} found resource.`, resource);
          return resource;
        } catch (e) {
          api_1.diag.debug(`${d.constructor.name} failed: ${e.message}`);
          return (0, ResourceImpl_1.emptyResource)();
        }
      });
      return resources.reduce((acc, resource) => acc.merge(resource), (0, ResourceImpl_1.emptyResource)());
    }, "detectResources");
    exports.detectResources = detectResources;
  }
});

// packages/core/node_modules/@opentelemetry/resources/build/src/detectors/EnvDetector.js
var require_EnvDetector = __commonJS({
  "packages/core/node_modules/@opentelemetry/resources/build/src/detectors/EnvDetector.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.envDetector = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var semantic_conventions_1 = (init_esm2(), __toCommonJS(esm_exports2));
    var core_1 = require_src();
    var EnvDetector = class {
      static {
        __name(this, "EnvDetector");
      }
      // Type, attribute keys, and attribute values should not exceed 256 characters.
      _MAX_LENGTH = 255;
      // OTEL_RESOURCE_ATTRIBUTES is a comma-separated list of attributes.
      _COMMA_SEPARATOR = ",";
      // OTEL_RESOURCE_ATTRIBUTES contains key value pair separated by '='.
      _LABEL_KEY_VALUE_SPLITTER = "=";
      /**
       * Returns a {@link Resource} populated with attributes from the
       * OTEL_RESOURCE_ATTRIBUTES environment variable. Note this is an async
       * function to conform to the Detector interface.
       *
       * @param config The resource detection config
       */
      detect(_config) {
        const attributes = {};
        const rawAttributes = (0, core_1.getStringFromEnv)("OTEL_RESOURCE_ATTRIBUTES");
        const serviceName = (0, core_1.getStringFromEnv)("OTEL_SERVICE_NAME");
        if (rawAttributes) {
          try {
            const parsedAttributes = this._parseResourceAttributes(rawAttributes);
            Object.assign(attributes, parsedAttributes);
          } catch (e) {
            api_1.diag.debug(`EnvDetector failed: ${e instanceof Error ? e.message : e}`);
          }
        }
        if (serviceName) {
          attributes[semantic_conventions_1.ATTR_SERVICE_NAME] = serviceName;
        }
        return { attributes };
      }
      /**
       * Creates an attribute map from the OTEL_RESOURCE_ATTRIBUTES environment
       * variable.
       *
       * OTEL_RESOURCE_ATTRIBUTES: A comma-separated list of attributes in the
       * format "key1=value1,key2=value2". The ',' and '=' characters in keys
       * and values MUST be percent-encoded. Other characters MAY be percent-encoded.
       *
       * Per the spec, on any error (e.g., decoding failure), the entire environment
       * variable value is discarded.
       *
       * @param rawEnvAttributes The resource attributes as a comma-separated list
       * of key/value pairs.
       * @returns The parsed resource attributes.
       * @throws Error if parsing fails (caller handles by discarding all attributes)
       */
      _parseResourceAttributes(rawEnvAttributes) {
        if (!rawEnvAttributes)
          return {};
        const attributes = {};
        const rawAttributes = rawEnvAttributes.split(this._COMMA_SEPARATOR).filter((attr) => attr.trim() !== "");
        for (const rawAttribute of rawAttributes) {
          const keyValuePair = rawAttribute.split(this._LABEL_KEY_VALUE_SPLITTER);
          if (keyValuePair.length !== 2) {
            throw new Error(`Invalid format for OTEL_RESOURCE_ATTRIBUTES: "${rawAttribute}". Expected format: key=value. The ',' and '=' characters must be percent-encoded in keys and values.`);
          }
          const [rawKey, rawValue] = keyValuePair;
          const key = rawKey.trim();
          const value = rawValue.trim();
          if (key.length === 0) {
            throw new Error(`Invalid OTEL_RESOURCE_ATTRIBUTES: empty attribute key in "${rawAttribute}".`);
          }
          let decodedKey;
          let decodedValue;
          try {
            decodedKey = decodeURIComponent(key);
            decodedValue = decodeURIComponent(value);
          } catch (e) {
            throw new Error(`Failed to percent-decode OTEL_RESOURCE_ATTRIBUTES entry "${rawAttribute}": ${e instanceof Error ? e.message : e}`, { cause: e });
          }
          if (decodedKey.length > this._MAX_LENGTH) {
            throw new Error(`Attribute key exceeds the maximum length of ${this._MAX_LENGTH} characters: "${decodedKey}".`);
          }
          if (decodedValue.length > this._MAX_LENGTH) {
            throw new Error(`Attribute value exceeds the maximum length of ${this._MAX_LENGTH} characters for key "${decodedKey}".`);
          }
          attributes[decodedKey] = decodedValue;
        }
        return attributes;
      }
    };
    exports.envDetector = new EnvDetector();
  }
});

// packages/core/node_modules/@opentelemetry/resources/build/src/semconv.js
var require_semconv2 = __commonJS({
  "packages/core/node_modules/@opentelemetry/resources/build/src/semconv.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ATTR_WEBENGINE_VERSION = exports.ATTR_WEBENGINE_NAME = exports.ATTR_WEBENGINE_DESCRIPTION = exports.ATTR_SERVICE_NAMESPACE = exports.ATTR_SERVICE_INSTANCE_ID = exports.ATTR_PROCESS_RUNTIME_VERSION = exports.ATTR_PROCESS_RUNTIME_NAME = exports.ATTR_PROCESS_RUNTIME_DESCRIPTION = exports.ATTR_PROCESS_PID = exports.ATTR_PROCESS_OWNER = exports.ATTR_PROCESS_EXECUTABLE_PATH = exports.ATTR_PROCESS_EXECUTABLE_NAME = exports.ATTR_PROCESS_COMMAND_ARGS = exports.ATTR_PROCESS_COMMAND = exports.ATTR_OS_VERSION = exports.ATTR_OS_TYPE = exports.ATTR_K8S_POD_NAME = exports.ATTR_K8S_NAMESPACE_NAME = exports.ATTR_K8S_DEPLOYMENT_NAME = exports.ATTR_K8S_CLUSTER_NAME = exports.ATTR_HOST_TYPE = exports.ATTR_HOST_NAME = exports.ATTR_HOST_IMAGE_VERSION = exports.ATTR_HOST_IMAGE_NAME = exports.ATTR_HOST_IMAGE_ID = exports.ATTR_HOST_ID = exports.ATTR_HOST_ARCH = exports.ATTR_CONTAINER_NAME = exports.ATTR_CONTAINER_IMAGE_TAGS = exports.ATTR_CONTAINER_IMAGE_NAME = exports.ATTR_CONTAINER_ID = exports.ATTR_CLOUD_REGION = exports.ATTR_CLOUD_PROVIDER = exports.ATTR_CLOUD_AVAILABILITY_ZONE = exports.ATTR_CLOUD_ACCOUNT_ID = void 0;
    exports.ATTR_CLOUD_ACCOUNT_ID = "cloud.account.id";
    exports.ATTR_CLOUD_AVAILABILITY_ZONE = "cloud.availability_zone";
    exports.ATTR_CLOUD_PROVIDER = "cloud.provider";
    exports.ATTR_CLOUD_REGION = "cloud.region";
    exports.ATTR_CONTAINER_ID = "container.id";
    exports.ATTR_CONTAINER_IMAGE_NAME = "container.image.name";
    exports.ATTR_CONTAINER_IMAGE_TAGS = "container.image.tags";
    exports.ATTR_CONTAINER_NAME = "container.name";
    exports.ATTR_HOST_ARCH = "host.arch";
    exports.ATTR_HOST_ID = "host.id";
    exports.ATTR_HOST_IMAGE_ID = "host.image.id";
    exports.ATTR_HOST_IMAGE_NAME = "host.image.name";
    exports.ATTR_HOST_IMAGE_VERSION = "host.image.version";
    exports.ATTR_HOST_NAME = "host.name";
    exports.ATTR_HOST_TYPE = "host.type";
    exports.ATTR_K8S_CLUSTER_NAME = "k8s.cluster.name";
    exports.ATTR_K8S_DEPLOYMENT_NAME = "k8s.deployment.name";
    exports.ATTR_K8S_NAMESPACE_NAME = "k8s.namespace.name";
    exports.ATTR_K8S_POD_NAME = "k8s.pod.name";
    exports.ATTR_OS_TYPE = "os.type";
    exports.ATTR_OS_VERSION = "os.version";
    exports.ATTR_PROCESS_COMMAND = "process.command";
    exports.ATTR_PROCESS_COMMAND_ARGS = "process.command_args";
    exports.ATTR_PROCESS_EXECUTABLE_NAME = "process.executable.name";
    exports.ATTR_PROCESS_EXECUTABLE_PATH = "process.executable.path";
    exports.ATTR_PROCESS_OWNER = "process.owner";
    exports.ATTR_PROCESS_PID = "process.pid";
    exports.ATTR_PROCESS_RUNTIME_DESCRIPTION = "process.runtime.description";
    exports.ATTR_PROCESS_RUNTIME_NAME = "process.runtime.name";
    exports.ATTR_PROCESS_RUNTIME_VERSION = "process.runtime.version";
    exports.ATTR_SERVICE_INSTANCE_ID = "service.instance.id";
    exports.ATTR_SERVICE_NAMESPACE = "service.namespace";
    exports.ATTR_WEBENGINE_DESCRIPTION = "webengine.description";
    exports.ATTR_WEBENGINE_NAME = "webengine.name";
    exports.ATTR_WEBENGINE_VERSION = "webengine.version";
  }
});

// packages/core/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/machine-id/getMachineId.js
var require_getMachineId = __commonJS({
  "packages/core/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/machine-id/getMachineId.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getMachineId = void 0;
    var process2 = __require("process");
    var getMachineIdImpl;
    async function getMachineId() {
      if (!getMachineIdImpl) {
        switch (process2.platform) {
          case "darwin":
            getMachineIdImpl = (await import("./getMachineId-darwin-H6USQYNI.js")).getMachineId;
            break;
          case "linux":
            getMachineIdImpl = (await import("./getMachineId-linux-HF2N63ET.js")).getMachineId;
            break;
          case "freebsd":
            getMachineIdImpl = (await import("./getMachineId-bsd-YH7RURBZ.js")).getMachineId;
            break;
          case "win32":
            getMachineIdImpl = (await import("./getMachineId-win-SMEGY2DW.js")).getMachineId;
            break;
          default:
            getMachineIdImpl = (await import("./getMachineId-unsupported-NYA5DXRB.js")).getMachineId;
            break;
        }
      }
      return getMachineIdImpl();
    }
    __name(getMachineId, "getMachineId");
    exports.getMachineId = getMachineId;
  }
});

// packages/core/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/utils.js
var require_utils3 = __commonJS({
  "packages/core/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/utils.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.normalizeType = exports.normalizeArch = void 0;
    var normalizeArch = /* @__PURE__ */ __name((nodeArchString) => {
      switch (nodeArchString) {
        case "arm":
          return "arm32";
        case "ppc":
          return "ppc32";
        case "x64":
          return "amd64";
        default:
          return nodeArchString;
      }
    }, "normalizeArch");
    exports.normalizeArch = normalizeArch;
    var normalizeType = /* @__PURE__ */ __name((nodePlatform) => {
      switch (nodePlatform) {
        case "sunos":
          return "solaris";
        case "win32":
          return "windows";
        default:
          return nodePlatform;
      }
    }, "normalizeType");
    exports.normalizeType = normalizeType;
  }
});

// packages/core/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/HostDetector.js
var require_HostDetector = __commonJS({
  "packages/core/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/HostDetector.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.hostDetector = void 0;
    var semconv_1 = require_semconv2();
    var os_1 = __require("os");
    var getMachineId_1 = require_getMachineId();
    var utils_1 = require_utils3();
    var HostDetector = class {
      static {
        __name(this, "HostDetector");
      }
      detect(_config) {
        const attributes = {
          [semconv_1.ATTR_HOST_NAME]: (0, os_1.hostname)(),
          [semconv_1.ATTR_HOST_ARCH]: (0, utils_1.normalizeArch)((0, os_1.arch)()),
          [semconv_1.ATTR_HOST_ID]: (0, getMachineId_1.getMachineId)()
        };
        return { attributes };
      }
    };
    exports.hostDetector = new HostDetector();
  }
});

// packages/core/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/OSDetector.js
var require_OSDetector = __commonJS({
  "packages/core/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/OSDetector.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.osDetector = void 0;
    var semconv_1 = require_semconv2();
    var os_1 = __require("os");
    var utils_1 = require_utils3();
    var OSDetector = class {
      static {
        __name(this, "OSDetector");
      }
      detect(_config) {
        const attributes = {
          [semconv_1.ATTR_OS_TYPE]: (0, utils_1.normalizeType)((0, os_1.platform)()),
          [semconv_1.ATTR_OS_VERSION]: (0, os_1.release)()
        };
        return { attributes };
      }
    };
    exports.osDetector = new OSDetector();
  }
});

// packages/core/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/ProcessDetector.js
var require_ProcessDetector = __commonJS({
  "packages/core/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/ProcessDetector.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.processDetector = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var semconv_1 = require_semconv2();
    var os = __require("os");
    var ProcessDetector = class {
      static {
        __name(this, "ProcessDetector");
      }
      detect(_config) {
        const attributes = {
          [semconv_1.ATTR_PROCESS_PID]: process.pid,
          [semconv_1.ATTR_PROCESS_EXECUTABLE_NAME]: process.title,
          [semconv_1.ATTR_PROCESS_EXECUTABLE_PATH]: process.execPath,
          [semconv_1.ATTR_PROCESS_COMMAND_ARGS]: [
            process.argv[0],
            ...process.execArgv,
            ...process.argv.slice(1)
          ],
          [semconv_1.ATTR_PROCESS_RUNTIME_VERSION]: process.versions.node,
          [semconv_1.ATTR_PROCESS_RUNTIME_NAME]: "nodejs",
          [semconv_1.ATTR_PROCESS_RUNTIME_DESCRIPTION]: "Node.js"
        };
        if (process.argv.length > 1) {
          attributes[semconv_1.ATTR_PROCESS_COMMAND] = process.argv[1];
        }
        try {
          const userInfo = os.userInfo();
          attributes[semconv_1.ATTR_PROCESS_OWNER] = userInfo.username;
        } catch (e) {
          api_1.diag.debug(`error obtaining process owner: ${e}`);
        }
        return { attributes };
      }
    };
    exports.processDetector = new ProcessDetector();
  }
});

// packages/core/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/ServiceInstanceIdDetector.js
var require_ServiceInstanceIdDetector = __commonJS({
  "packages/core/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/ServiceInstanceIdDetector.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.serviceInstanceIdDetector = void 0;
    var semconv_1 = require_semconv2();
    var crypto_1 = __require("crypto");
    var ServiceInstanceIdDetector = class {
      static {
        __name(this, "ServiceInstanceIdDetector");
      }
      detect(_config) {
        return {
          attributes: {
            [semconv_1.ATTR_SERVICE_INSTANCE_ID]: (0, crypto_1.randomUUID)()
          }
        };
      }
    };
    exports.serviceInstanceIdDetector = new ServiceInstanceIdDetector();
  }
});

// packages/core/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/index.js
var require_node2 = __commonJS({
  "packages/core/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.serviceInstanceIdDetector = exports.processDetector = exports.osDetector = exports.hostDetector = void 0;
    var HostDetector_1 = require_HostDetector();
    Object.defineProperty(exports, "hostDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return HostDetector_1.hostDetector;
    }, "get") });
    var OSDetector_1 = require_OSDetector();
    Object.defineProperty(exports, "osDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return OSDetector_1.osDetector;
    }, "get") });
    var ProcessDetector_1 = require_ProcessDetector();
    Object.defineProperty(exports, "processDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return ProcessDetector_1.processDetector;
    }, "get") });
    var ServiceInstanceIdDetector_1 = require_ServiceInstanceIdDetector();
    Object.defineProperty(exports, "serviceInstanceIdDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return ServiceInstanceIdDetector_1.serviceInstanceIdDetector;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/resources/build/src/detectors/platform/index.js
var require_platform2 = __commonJS({
  "packages/core/node_modules/@opentelemetry/resources/build/src/detectors/platform/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.serviceInstanceIdDetector = exports.processDetector = exports.osDetector = exports.hostDetector = void 0;
    var node_1 = require_node2();
    Object.defineProperty(exports, "hostDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return node_1.hostDetector;
    }, "get") });
    Object.defineProperty(exports, "osDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return node_1.osDetector;
    }, "get") });
    Object.defineProperty(exports, "processDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return node_1.processDetector;
    }, "get") });
    Object.defineProperty(exports, "serviceInstanceIdDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return node_1.serviceInstanceIdDetector;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/resources/build/src/detectors/NoopDetector.js
var require_NoopDetector = __commonJS({
  "packages/core/node_modules/@opentelemetry/resources/build/src/detectors/NoopDetector.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.noopDetector = exports.NoopDetector = void 0;
    var NoopDetector = class {
      static {
        __name(this, "NoopDetector");
      }
      detect() {
        return {
          attributes: {}
        };
      }
    };
    exports.NoopDetector = NoopDetector;
    exports.noopDetector = new NoopDetector();
  }
});

// packages/core/node_modules/@opentelemetry/resources/build/src/detectors/index.js
var require_detectors = __commonJS({
  "packages/core/node_modules/@opentelemetry/resources/build/src/detectors/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.noopDetector = exports.serviceInstanceIdDetector = exports.processDetector = exports.osDetector = exports.hostDetector = exports.envDetector = void 0;
    var EnvDetector_1 = require_EnvDetector();
    Object.defineProperty(exports, "envDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return EnvDetector_1.envDetector;
    }, "get") });
    var platform_1 = require_platform2();
    Object.defineProperty(exports, "hostDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return platform_1.hostDetector;
    }, "get") });
    Object.defineProperty(exports, "osDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return platform_1.osDetector;
    }, "get") });
    Object.defineProperty(exports, "processDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return platform_1.processDetector;
    }, "get") });
    Object.defineProperty(exports, "serviceInstanceIdDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return platform_1.serviceInstanceIdDetector;
    }, "get") });
    var NoopDetector_1 = require_NoopDetector();
    Object.defineProperty(exports, "noopDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return NoopDetector_1.noopDetector;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/resources/build/src/index.js
var require_src2 = __commonJS({
  "packages/core/node_modules/@opentelemetry/resources/build/src/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.defaultServiceName = exports.emptyResource = exports.defaultResource = exports.resourceFromAttributes = exports.serviceInstanceIdDetector = exports.processDetector = exports.osDetector = exports.hostDetector = exports.envDetector = exports.detectResources = void 0;
    var detect_resources_1 = require_detect_resources();
    Object.defineProperty(exports, "detectResources", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return detect_resources_1.detectResources;
    }, "get") });
    var detectors_1 = require_detectors();
    Object.defineProperty(exports, "envDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return detectors_1.envDetector;
    }, "get") });
    Object.defineProperty(exports, "hostDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return detectors_1.hostDetector;
    }, "get") });
    Object.defineProperty(exports, "osDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return detectors_1.osDetector;
    }, "get") });
    Object.defineProperty(exports, "processDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return detectors_1.processDetector;
    }, "get") });
    Object.defineProperty(exports, "serviceInstanceIdDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return detectors_1.serviceInstanceIdDetector;
    }, "get") });
    var ResourceImpl_1 = require_ResourceImpl();
    Object.defineProperty(exports, "resourceFromAttributes", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return ResourceImpl_1.resourceFromAttributes;
    }, "get") });
    Object.defineProperty(exports, "defaultResource", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return ResourceImpl_1.defaultResource;
    }, "get") });
    Object.defineProperty(exports, "emptyResource", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return ResourceImpl_1.emptyResource;
    }, "get") });
    var default_service_name_1 = require_default_service_name();
    Object.defineProperty(exports, "defaultServiceName", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return default_service_name_1.defaultServiceName;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/export/AggregationTemporality.js
var require_AggregationTemporality = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/export/AggregationTemporality.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AggregationTemporality = void 0;
    var AggregationTemporality;
    (function(AggregationTemporality2) {
      AggregationTemporality2[AggregationTemporality2["DELTA"] = 0] = "DELTA";
      AggregationTemporality2[AggregationTemporality2["CUMULATIVE"] = 1] = "CUMULATIVE";
    })(AggregationTemporality || (exports.AggregationTemporality = AggregationTemporality = {}));
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/export/MetricData.js
var require_MetricData = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/export/MetricData.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DataPointType = exports.InstrumentType = void 0;
    var InstrumentType;
    (function(InstrumentType2) {
      InstrumentType2["COUNTER"] = "COUNTER";
      InstrumentType2["GAUGE"] = "GAUGE";
      InstrumentType2["HISTOGRAM"] = "HISTOGRAM";
      InstrumentType2["UP_DOWN_COUNTER"] = "UP_DOWN_COUNTER";
      InstrumentType2["OBSERVABLE_COUNTER"] = "OBSERVABLE_COUNTER";
      InstrumentType2["OBSERVABLE_GAUGE"] = "OBSERVABLE_GAUGE";
      InstrumentType2["OBSERVABLE_UP_DOWN_COUNTER"] = "OBSERVABLE_UP_DOWN_COUNTER";
    })(InstrumentType || (exports.InstrumentType = InstrumentType = {}));
    var DataPointType;
    (function(DataPointType2) {
      DataPointType2[DataPointType2["HISTOGRAM"] = 0] = "HISTOGRAM";
      DataPointType2[DataPointType2["EXPONENTIAL_HISTOGRAM"] = 1] = "EXPONENTIAL_HISTOGRAM";
      DataPointType2[DataPointType2["GAUGE"] = 2] = "GAUGE";
      DataPointType2[DataPointType2["SUM"] = 3] = "SUM";
    })(DataPointType || (exports.DataPointType = DataPointType = {}));
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/utils.js
var require_utils4 = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/utils.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.equalsCaseInsensitive = exports.binarySearchUB = exports.setEquals = exports.callWithTimeout = exports.TimeoutError = exports.instrumentationScopeId = exports.hashAttributes = void 0;
    function hashAttributes(attributes) {
      let keys = Object.keys(attributes);
      if (keys.length === 0)
        return "";
      keys = keys.sort();
      return JSON.stringify(keys.map((key) => [key, attributes[key]]));
    }
    __name(hashAttributes, "hashAttributes");
    exports.hashAttributes = hashAttributes;
    function instrumentationScopeId(instrumentationScope) {
      return `${instrumentationScope.name}:${instrumentationScope.version ?? ""}:${instrumentationScope.schemaUrl ?? ""}`;
    }
    __name(instrumentationScopeId, "instrumentationScopeId");
    exports.instrumentationScopeId = instrumentationScopeId;
    var TimeoutError = class _TimeoutError extends Error {
      static {
        __name(this, "TimeoutError");
      }
      constructor(message) {
        super(message);
        Object.setPrototypeOf(this, _TimeoutError.prototype);
      }
    };
    exports.TimeoutError = TimeoutError;
    function callWithTimeout(promise, timeout) {
      let timeoutHandle;
      const timeoutPromise = new Promise(/* @__PURE__ */ __name(function timeoutFunction(_resolve, reject) {
        timeoutHandle = setTimeout(/* @__PURE__ */ __name(function timeoutHandler() {
          reject(new TimeoutError("Operation timed out."));
        }, "timeoutHandler"), timeout);
      }, "timeoutFunction"));
      return Promise.race([promise, timeoutPromise]).then((result) => {
        clearTimeout(timeoutHandle);
        return result;
      }, (reason) => {
        clearTimeout(timeoutHandle);
        throw reason;
      });
    }
    __name(callWithTimeout, "callWithTimeout");
    exports.callWithTimeout = callWithTimeout;
    function setEquals(lhs, rhs) {
      if (lhs.size !== rhs.size) {
        return false;
      }
      for (const item of lhs) {
        if (!rhs.has(item)) {
          return false;
        }
      }
      return true;
    }
    __name(setEquals, "setEquals");
    exports.setEquals = setEquals;
    function binarySearchUB(arr, value) {
      let lo = 0;
      let hi = arr.length - 1;
      let ret = arr.length;
      while (hi >= lo) {
        const mid = lo + Math.trunc((hi - lo) / 2);
        if (arr[mid] < value) {
          lo = mid + 1;
        } else {
          ret = mid;
          hi = mid - 1;
        }
      }
      return ret;
    }
    __name(binarySearchUB, "binarySearchUB");
    exports.binarySearchUB = binarySearchUB;
    function equalsCaseInsensitive(lhs, rhs) {
      return lhs.toLowerCase() === rhs.toLowerCase();
    }
    __name(equalsCaseInsensitive, "equalsCaseInsensitive");
    exports.equalsCaseInsensitive = equalsCaseInsensitive;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/types.js
var require_types = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/types.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AggregatorKind = void 0;
    var AggregatorKind;
    (function(AggregatorKind2) {
      AggregatorKind2[AggregatorKind2["DROP"] = 0] = "DROP";
      AggregatorKind2[AggregatorKind2["SUM"] = 1] = "SUM";
      AggregatorKind2[AggregatorKind2["LAST_VALUE"] = 2] = "LAST_VALUE";
      AggregatorKind2[AggregatorKind2["HISTOGRAM"] = 3] = "HISTOGRAM";
      AggregatorKind2[AggregatorKind2["EXPONENTIAL_HISTOGRAM"] = 4] = "EXPONENTIAL_HISTOGRAM";
    })(AggregatorKind || (exports.AggregatorKind = AggregatorKind = {}));
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/Drop.js
var require_Drop = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/Drop.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DropAggregator = void 0;
    var types_1 = require_types();
    var DropAggregator = class {
      static {
        __name(this, "DropAggregator");
      }
      kind = types_1.AggregatorKind.DROP;
      createAccumulation() {
        return void 0;
      }
      merge(_previous, _delta) {
        return void 0;
      }
      diff(_previous, _current) {
        return void 0;
      }
      toMetricData(_descriptor, _aggregationTemporality, _accumulationByAttributes, _endTime) {
        return void 0;
      }
    };
    exports.DropAggregator = DropAggregator;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/Histogram.js
var require_Histogram = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/Histogram.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.HistogramAggregator = exports.HistogramAccumulation = void 0;
    var types_1 = require_types();
    var MetricData_1 = require_MetricData();
    var utils_1 = require_utils4();
    function createNewEmptyCheckpoint(boundaries) {
      const counts = boundaries.map(() => 0);
      counts.push(0);
      return {
        buckets: {
          boundaries,
          counts
        },
        sum: 0,
        count: 0,
        hasMinMax: false,
        min: Infinity,
        max: -Infinity
      };
    }
    __name(createNewEmptyCheckpoint, "createNewEmptyCheckpoint");
    var HistogramAccumulation = class {
      static {
        __name(this, "HistogramAccumulation");
      }
      startTime;
      _boundaries;
      _recordMinMax;
      _current;
      constructor(startTime, boundaries, recordMinMax = true, current = createNewEmptyCheckpoint(boundaries)) {
        this.startTime = startTime;
        this._boundaries = boundaries;
        this._recordMinMax = recordMinMax;
        this._current = current;
      }
      record(value) {
        if (Number.isNaN(value)) {
          return;
        }
        this._current.count += 1;
        this._current.sum += value;
        if (this._recordMinMax) {
          this._current.min = Math.min(value, this._current.min);
          this._current.max = Math.max(value, this._current.max);
          this._current.hasMinMax = true;
        }
        const idx = (0, utils_1.binarySearchUB)(this._boundaries, value);
        this._current.buckets.counts[idx] += 1;
      }
      setStartTime(startTime) {
        this.startTime = startTime;
      }
      toPointValue() {
        return this._current;
      }
    };
    exports.HistogramAccumulation = HistogramAccumulation;
    var HistogramAggregator = class {
      static {
        __name(this, "HistogramAggregator");
      }
      kind = types_1.AggregatorKind.HISTOGRAM;
      _boundaries;
      _recordMinMax;
      /**
       * @param _boundaries sorted upper bounds of recorded values.
       * @param _recordMinMax If set to true, min and max will be recorded. Otherwise, min and max will not be recorded.
       */
      constructor(boundaries, recordMinMax) {
        this._boundaries = boundaries;
        this._recordMinMax = recordMinMax;
      }
      createAccumulation(startTime) {
        return new HistogramAccumulation(startTime, this._boundaries, this._recordMinMax);
      }
      /**
       * Return the result of the merge of two histogram accumulations. As long as one Aggregator
       * instance produces all Accumulations with constant boundaries we don't need to worry about
       * merging accumulations with different boundaries.
       */
      merge(previous, delta) {
        const previousValue = previous.toPointValue();
        const deltaValue = delta.toPointValue();
        const previousCounts = previousValue.buckets.counts;
        const deltaCounts = deltaValue.buckets.counts;
        const mergedCounts = new Array(previousCounts.length);
        for (let idx = 0; idx < previousCounts.length; idx++) {
          mergedCounts[idx] = previousCounts[idx] + deltaCounts[idx];
        }
        let min = Infinity;
        let max = -Infinity;
        if (this._recordMinMax) {
          if (previousValue.hasMinMax && deltaValue.hasMinMax) {
            min = Math.min(previousValue.min, deltaValue.min);
            max = Math.max(previousValue.max, deltaValue.max);
          } else if (previousValue.hasMinMax) {
            min = previousValue.min;
            max = previousValue.max;
          } else if (deltaValue.hasMinMax) {
            min = deltaValue.min;
            max = deltaValue.max;
          }
        }
        return new HistogramAccumulation(previous.startTime, previousValue.buckets.boundaries, this._recordMinMax, {
          buckets: {
            boundaries: previousValue.buckets.boundaries,
            counts: mergedCounts
          },
          count: previousValue.count + deltaValue.count,
          sum: previousValue.sum + deltaValue.sum,
          hasMinMax: this._recordMinMax && (previousValue.hasMinMax || deltaValue.hasMinMax),
          min,
          max
        });
      }
      /**
       * Returns a new DELTA aggregation by comparing two cumulative measurements.
       */
      diff(previous, current) {
        const previousValue = previous.toPointValue();
        const currentValue = current.toPointValue();
        const previousCounts = previousValue.buckets.counts;
        const currentCounts = currentValue.buckets.counts;
        const diffedCounts = new Array(previousCounts.length);
        for (let idx = 0; idx < previousCounts.length; idx++) {
          diffedCounts[idx] = currentCounts[idx] - previousCounts[idx];
        }
        return new HistogramAccumulation(current.startTime, previousValue.buckets.boundaries, this._recordMinMax, {
          buckets: {
            boundaries: previousValue.buckets.boundaries,
            counts: diffedCounts
          },
          count: currentValue.count - previousValue.count,
          sum: currentValue.sum - previousValue.sum,
          hasMinMax: false,
          min: Infinity,
          max: -Infinity
        });
      }
      toMetricData(descriptor, aggregationTemporality, accumulationByAttributes, endTime) {
        return {
          descriptor,
          aggregationTemporality,
          dataPointType: MetricData_1.DataPointType.HISTOGRAM,
          dataPoints: accumulationByAttributes.map(([attributes, accumulation]) => {
            const pointValue = accumulation.toPointValue();
            const allowsNegativeValues = descriptor.type === MetricData_1.InstrumentType.GAUGE || descriptor.type === MetricData_1.InstrumentType.UP_DOWN_COUNTER || descriptor.type === MetricData_1.InstrumentType.OBSERVABLE_GAUGE || descriptor.type === MetricData_1.InstrumentType.OBSERVABLE_UP_DOWN_COUNTER;
            return {
              attributes,
              startTime: accumulation.startTime,
              endTime,
              value: {
                min: pointValue.hasMinMax ? pointValue.min : void 0,
                max: pointValue.hasMinMax ? pointValue.max : void 0,
                sum: !allowsNegativeValues ? pointValue.sum : void 0,
                buckets: pointValue.buckets,
                count: pointValue.count
              }
            };
          })
        };
      }
    };
    exports.HistogramAggregator = HistogramAggregator;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/exponential-histogram/Buckets.js
var require_Buckets = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/exponential-histogram/Buckets.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Buckets = void 0;
    var Buckets = class _Buckets {
      static {
        __name(this, "Buckets");
      }
      backing;
      indexBase;
      indexStart;
      indexEnd;
      /**
       * The term index refers to the number of the exponential histogram bucket
       * used to determine its boundaries. The lower boundary of a bucket is
       * determined by base ** index and the upper boundary of a bucket is
       * determined by base ** (index + 1). index values are signed to account
       * for values less than or equal to 1.
       *
       * indexBase is the index of the 0th position in the
       * backing array, i.e., backing[0] is the count
       * in the bucket with index `indexBase`.
       *
       * indexStart is the smallest index value represented
       * in the backing array.
       *
       * indexEnd is the largest index value represented in
       * the backing array.
       */
      constructor(backing = new BucketsBacking(), indexBase = 0, indexStart = 0, indexEnd = 0) {
        this.backing = backing;
        this.indexBase = indexBase;
        this.indexStart = indexStart;
        this.indexEnd = indexEnd;
      }
      /**
       * Offset is the bucket index of the smallest entry in the counts array
       * @returns {number}
       */
      get offset() {
        return this.indexStart;
      }
      /**
       * Buckets is a view into the backing array.
       * @returns {number}
       */
      get length() {
        if (this.backing.length === 0) {
          return 0;
        }
        if (this.indexEnd === this.indexStart && this.at(0) === 0) {
          return 0;
        }
        return this.indexEnd - this.indexStart + 1;
      }
      /**
       * An array of counts, where count[i] carries the count
       * of the bucket at index (offset+i).  count[i] is the count of
       * values greater than base^(offset+i) and less than or equal to
       * base^(offset+i+1).
       * @returns {number} The logical counts based on the backing array
       */
      counts() {
        return Array.from({ length: this.length }, (_, i) => this.at(i));
      }
      /**
       * At returns the count of the bucket at a position in the logical
       * array of counts.
       * @param position
       * @returns {number}
       */
      at(position) {
        const bias = this.indexBase - this.indexStart;
        if (position < bias) {
          position += this.backing.length;
        }
        position -= bias;
        return this.backing.countAt(position);
      }
      /**
       * incrementBucket increments the backing array index by `increment`
       * @param bucketIndex
       * @param increment
       */
      incrementBucket(bucketIndex, increment) {
        this.backing.increment(bucketIndex, increment);
      }
      /**
       * decrementBucket decrements the backing array index by `decrement`
       * if decrement is greater than the current value, it's set to 0.
       * @param bucketIndex
       * @param decrement
       */
      decrementBucket(bucketIndex, decrement) {
        this.backing.decrement(bucketIndex, decrement);
      }
      /**
       * trim removes leading and / or trailing zero buckets (which can occur
       * after diffing two histos) and rotates the backing array so that the
       * smallest non-zero index is in the 0th position of the backing array
       */
      trim() {
        for (let i = 0; i < this.length; i++) {
          if (this.at(i) !== 0) {
            this.indexStart += i;
            break;
          } else if (i === this.length - 1) {
            this.indexStart = this.indexEnd = this.indexBase = 0;
            return;
          }
        }
        for (let i = this.length - 1; i >= 0; i--) {
          if (this.at(i) !== 0) {
            this.indexEnd -= this.length - i - 1;
            break;
          }
        }
        this._rotate();
      }
      /**
       * downscale first rotates, then collapses 2**`by`-to-1 buckets.
       * @param by
       */
      downscale(by) {
        this._rotate();
        const size = 1 + this.indexEnd - this.indexStart;
        const each = 1 << by;
        let inpos = 0;
        let outpos = 0;
        for (let pos = this.indexStart; pos <= this.indexEnd; ) {
          let mod = pos % each;
          if (mod < 0) {
            mod += each;
          }
          for (let i = mod; i < each && inpos < size; i++) {
            this._relocateBucket(outpos, inpos);
            inpos++;
            pos++;
          }
          outpos++;
        }
        this.indexStart >>= by;
        this.indexEnd >>= by;
        this.indexBase = this.indexStart;
      }
      /**
       * Clone returns a deep copy of Buckets
       * @returns {Buckets}
       */
      clone() {
        return new _Buckets(this.backing.clone(), this.indexBase, this.indexStart, this.indexEnd);
      }
      /**
       * _rotate shifts the backing array contents so that indexStart ==
       * indexBase to simplify the downscale logic.
       */
      _rotate() {
        const bias = this.indexBase - this.indexStart;
        if (bias === 0) {
          return;
        } else if (bias > 0) {
          this.backing.reverse(0, this.backing.length);
          this.backing.reverse(0, bias);
          this.backing.reverse(bias, this.backing.length);
        } else {
          this.backing.reverse(0, this.backing.length);
          this.backing.reverse(0, this.backing.length + bias);
        }
        this.indexBase = this.indexStart;
      }
      /**
       * _relocateBucket adds the count in counts[src] to counts[dest] and
       * resets count[src] to zero.
       */
      _relocateBucket(dest, src) {
        if (dest === src) {
          return;
        }
        this.incrementBucket(dest, this.backing.emptyBucket(src));
      }
    };
    exports.Buckets = Buckets;
    var BucketsBacking = class _BucketsBacking {
      static {
        __name(this, "BucketsBacking");
      }
      _counts;
      constructor(counts = [0]) {
        this._counts = counts;
      }
      /**
       * length returns the physical size of the backing array, which
       * is >= buckets.length()
       */
      get length() {
        return this._counts.length;
      }
      /**
       * countAt returns the count in a specific bucket
       */
      countAt(pos) {
        return this._counts[pos];
      }
      /**
       * growTo grows a backing array and copies old entries
       * into their correct new positions.
       */
      growTo(newSize, oldPositiveLimit, newPositiveLimit) {
        const tmp = new Array(newSize).fill(0);
        tmp.splice(newPositiveLimit, this._counts.length - oldPositiveLimit, ...this._counts.slice(oldPositiveLimit));
        tmp.splice(0, oldPositiveLimit, ...this._counts.slice(0, oldPositiveLimit));
        this._counts = tmp;
      }
      /**
       * reverse the items in the backing array in the range [from, limit).
       */
      reverse(from, limit) {
        const num = Math.floor((from + limit) / 2) - from;
        for (let i = 0; i < num; i++) {
          const tmp = this._counts[from + i];
          this._counts[from + i] = this._counts[limit - i - 1];
          this._counts[limit - i - 1] = tmp;
        }
      }
      /**
       * emptyBucket empties the count from a bucket, for
       * moving into another.
       */
      emptyBucket(src) {
        const tmp = this._counts[src];
        this._counts[src] = 0;
        return tmp;
      }
      /**
       * increments a bucket by `increment`
       */
      increment(bucketIndex, increment) {
        this._counts[bucketIndex] += increment;
      }
      /**
       * decrements a bucket by `decrement`
       */
      decrement(bucketIndex, decrement) {
        if (this._counts[bucketIndex] >= decrement) {
          this._counts[bucketIndex] -= decrement;
        } else {
          this._counts[bucketIndex] = 0;
        }
      }
      /**
       * clone returns a deep copy of BucketsBacking
       */
      clone() {
        return new _BucketsBacking([...this._counts]);
      }
    };
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/exponential-histogram/mapping/ieee754.js
var require_ieee754 = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/exponential-histogram/mapping/ieee754.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getSignificand = exports.getNormalBase2 = exports.MIN_VALUE = exports.MAX_NORMAL_EXPONENT = exports.MIN_NORMAL_EXPONENT = exports.SIGNIFICAND_WIDTH = void 0;
    exports.SIGNIFICAND_WIDTH = 52;
    var EXPONENT_MASK = 2146435072;
    var SIGNIFICAND_MASK = 1048575;
    var EXPONENT_BIAS = 1023;
    exports.MIN_NORMAL_EXPONENT = -EXPONENT_BIAS + 1;
    exports.MAX_NORMAL_EXPONENT = EXPONENT_BIAS;
    exports.MIN_VALUE = Math.pow(2, -1022);
    function getNormalBase2(value) {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setFloat64(0, value);
      const hiBits = dv.getUint32(0);
      const expBits = (hiBits & EXPONENT_MASK) >> 20;
      return expBits - EXPONENT_BIAS;
    }
    __name(getNormalBase2, "getNormalBase2");
    exports.getNormalBase2 = getNormalBase2;
    function getSignificand(value) {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setFloat64(0, value);
      const hiBits = dv.getUint32(0);
      const loBits = dv.getUint32(4);
      const significandHiBits = (hiBits & SIGNIFICAND_MASK) * Math.pow(2, 32);
      return significandHiBits + loBits;
    }
    __name(getSignificand, "getSignificand");
    exports.getSignificand = getSignificand;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/exponential-histogram/util.js
var require_util = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/exponential-histogram/util.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.nextGreaterSquare = exports.ldexp = void 0;
    function ldexp(frac, exp) {
      if (frac === 0 || frac === Number.POSITIVE_INFINITY || frac === Number.NEGATIVE_INFINITY || Number.isNaN(frac)) {
        return frac;
      }
      return frac * Math.pow(2, exp);
    }
    __name(ldexp, "ldexp");
    exports.ldexp = ldexp;
    function nextGreaterSquare(v) {
      v--;
      v |= v >> 1;
      v |= v >> 2;
      v |= v >> 4;
      v |= v >> 8;
      v |= v >> 16;
      v++;
      return v;
    }
    __name(nextGreaterSquare, "nextGreaterSquare");
    exports.nextGreaterSquare = nextGreaterSquare;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/exponential-histogram/mapping/types.js
var require_types2 = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/exponential-histogram/mapping/types.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MappingError = void 0;
    var MappingError = class extends Error {
      static {
        __name(this, "MappingError");
      }
    };
    exports.MappingError = MappingError;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/exponential-histogram/mapping/ExponentMapping.js
var require_ExponentMapping = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/exponential-histogram/mapping/ExponentMapping.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ExponentMapping = void 0;
    var ieee754 = require_ieee754();
    var util = require_util();
    var types_1 = require_types2();
    var ExponentMapping = class {
      static {
        __name(this, "ExponentMapping");
      }
      _shift;
      constructor(scale) {
        this._shift = -scale;
      }
      /**
       * Maps positive floating point values to indexes corresponding to scale
       * @param value
       * @returns {number} index for provided value at the current scale
       */
      mapToIndex(value) {
        if (value < ieee754.MIN_VALUE) {
          return this._minNormalLowerBoundaryIndex();
        }
        const exp = ieee754.getNormalBase2(value);
        const correction = this._rightShift(ieee754.getSignificand(value) - 1, ieee754.SIGNIFICAND_WIDTH);
        return exp + correction >> this._shift;
      }
      /**
       * Returns the lower bucket boundary for the given index for scale
       *
       * @param index
       * @returns {number}
       */
      lowerBoundary(index) {
        const minIndex = this._minNormalLowerBoundaryIndex();
        if (index < minIndex) {
          throw new types_1.MappingError(`underflow: ${index} is < minimum lower boundary: ${minIndex}`);
        }
        const maxIndex = this._maxNormalLowerBoundaryIndex();
        if (index > maxIndex) {
          throw new types_1.MappingError(`overflow: ${index} is > maximum lower boundary: ${maxIndex}`);
        }
        return util.ldexp(1, index << this._shift);
      }
      /**
       * The scale used by this mapping
       * @returns {number}
       */
      get scale() {
        if (this._shift === 0) {
          return 0;
        }
        return -this._shift;
      }
      _minNormalLowerBoundaryIndex() {
        let index = ieee754.MIN_NORMAL_EXPONENT >> this._shift;
        if (this._shift < 2) {
          index--;
        }
        return index;
      }
      _maxNormalLowerBoundaryIndex() {
        return ieee754.MAX_NORMAL_EXPONENT >> this._shift;
      }
      _rightShift(value, shift) {
        return Math.floor(value * Math.pow(2, -shift));
      }
    };
    exports.ExponentMapping = ExponentMapping;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/exponential-histogram/mapping/LogarithmMapping.js
var require_LogarithmMapping = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/exponential-histogram/mapping/LogarithmMapping.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.LogarithmMapping = void 0;
    var ieee754 = require_ieee754();
    var util = require_util();
    var types_1 = require_types2();
    var LogarithmMapping = class {
      static {
        __name(this, "LogarithmMapping");
      }
      _scale;
      _scaleFactor;
      _inverseFactor;
      constructor(scale) {
        this._scale = scale;
        this._scaleFactor = util.ldexp(Math.LOG2E, scale);
        this._inverseFactor = util.ldexp(Math.LN2, -scale);
      }
      /**
       * Maps positive floating point values to indexes corresponding to scale
       * @param value
       * @returns {number} index for provided value at the current scale
       */
      mapToIndex(value) {
        if (value <= ieee754.MIN_VALUE) {
          return this._minNormalLowerBoundaryIndex() - 1;
        }
        if (ieee754.getSignificand(value) === 0) {
          const exp = ieee754.getNormalBase2(value);
          return (exp << this._scale) - 1;
        }
        const index = Math.floor(Math.log(value) * this._scaleFactor);
        const maxIndex = this._maxNormalLowerBoundaryIndex();
        if (index >= maxIndex) {
          return maxIndex;
        }
        return index;
      }
      /**
       * Returns the lower bucket boundary for the given index for scale
       *
       * @param index
       * @returns {number}
       */
      lowerBoundary(index) {
        const maxIndex = this._maxNormalLowerBoundaryIndex();
        if (index >= maxIndex) {
          if (index === maxIndex) {
            return 2 * Math.exp((index - (1 << this._scale)) / this._scaleFactor);
          }
          throw new types_1.MappingError(`overflow: ${index} is > maximum lower boundary: ${maxIndex}`);
        }
        const minIndex = this._minNormalLowerBoundaryIndex();
        if (index <= minIndex) {
          if (index === minIndex) {
            return ieee754.MIN_VALUE;
          } else if (index === minIndex - 1) {
            return Math.exp((index + (1 << this._scale)) / this._scaleFactor) / 2;
          }
          throw new types_1.MappingError(`overflow: ${index} is < minimum lower boundary: ${minIndex}`);
        }
        return Math.exp(index * this._inverseFactor);
      }
      /**
       * The scale used by this mapping
       * @returns {number}
       */
      get scale() {
        return this._scale;
      }
      _minNormalLowerBoundaryIndex() {
        return ieee754.MIN_NORMAL_EXPONENT << this._scale;
      }
      _maxNormalLowerBoundaryIndex() {
        return (ieee754.MAX_NORMAL_EXPONENT + 1 << this._scale) - 1;
      }
    };
    exports.LogarithmMapping = LogarithmMapping;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/exponential-histogram/mapping/getMapping.js
var require_getMapping = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/exponential-histogram/mapping/getMapping.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getMapping = void 0;
    var ExponentMapping_1 = require_ExponentMapping();
    var LogarithmMapping_1 = require_LogarithmMapping();
    var types_1 = require_types2();
    var MIN_SCALE = -10;
    var MAX_SCALE = 20;
    var PREBUILT_MAPPINGS = Array.from({ length: 31 }, (_, i) => {
      if (i > 10) {
        return new LogarithmMapping_1.LogarithmMapping(i - 10);
      }
      return new ExponentMapping_1.ExponentMapping(i - 10);
    });
    function getMapping(scale) {
      if (scale > MAX_SCALE || scale < MIN_SCALE) {
        throw new types_1.MappingError(`expected scale >= ${MIN_SCALE} && <= ${MAX_SCALE}, got: ${scale}`);
      }
      return PREBUILT_MAPPINGS[scale + 10];
    }
    __name(getMapping, "getMapping");
    exports.getMapping = getMapping;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/ExponentialHistogram.js
var require_ExponentialHistogram = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/ExponentialHistogram.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ExponentialHistogramAggregator = exports.ExponentialHistogramAccumulation = void 0;
    var types_1 = require_types();
    var MetricData_1 = require_MetricData();
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var Buckets_1 = require_Buckets();
    var getMapping_1 = require_getMapping();
    var util_1 = require_util();
    var HighLow = class _HighLow {
      static {
        __name(this, "HighLow");
      }
      static combine(h1, h2) {
        return new _HighLow(Math.min(h1.low, h2.low), Math.max(h1.high, h2.high));
      }
      low;
      high;
      constructor(low, high) {
        this.low = low;
        this.high = high;
      }
    };
    var MAX_SCALE = 20;
    var DEFAULT_MAX_SIZE = 160;
    var MIN_MAX_SIZE = 2;
    var ExponentialHistogramAccumulation = class _ExponentialHistogramAccumulation {
      static {
        __name(this, "ExponentialHistogramAccumulation");
      }
      startTime;
      _maxSize;
      _recordMinMax;
      _sum;
      _count;
      _zeroCount;
      _min;
      _max;
      _positive;
      _negative;
      _mapping;
      constructor(startTime, maxSize = DEFAULT_MAX_SIZE, recordMinMax = true, sum = 0, count = 0, zeroCount = 0, min = Number.POSITIVE_INFINITY, max = Number.NEGATIVE_INFINITY, positive = new Buckets_1.Buckets(), negative = new Buckets_1.Buckets(), mapping = (0, getMapping_1.getMapping)(MAX_SCALE)) {
        this.startTime = startTime;
        this._maxSize = maxSize;
        this._recordMinMax = recordMinMax;
        this._sum = sum;
        this._count = count;
        this._zeroCount = zeroCount;
        this._min = min;
        this._max = max;
        this._positive = positive;
        this._negative = negative;
        this._mapping = mapping;
        if (this._maxSize < MIN_MAX_SIZE) {
          api_1.diag.warn(`Exponential Histogram Max Size set to ${this._maxSize},                 changing to the minimum size of: ${MIN_MAX_SIZE}`);
          this._maxSize = MIN_MAX_SIZE;
        }
      }
      /**
       * record updates a histogram with a single count
       * @param {Number} value
       */
      record(value) {
        this.updateByIncrement(value, 1);
      }
      /**
       * Sets the start time for this accumulation
       * @param {HrTime} startTime
       */
      setStartTime(startTime) {
        this.startTime = startTime;
      }
      /**
       * Returns the datapoint representation of this accumulation
       * @param {HrTime} startTime
       */
      toPointValue() {
        return {
          hasMinMax: this._recordMinMax,
          min: this.min,
          max: this.max,
          sum: this.sum,
          positive: {
            offset: this.positive.offset,
            bucketCounts: this.positive.counts()
          },
          negative: {
            offset: this.negative.offset,
            bucketCounts: this.negative.counts()
          },
          count: this.count,
          scale: this.scale,
          zeroCount: this.zeroCount
        };
      }
      /**
       * @returns {Number} The sum of values recorded by this accumulation
       */
      get sum() {
        return this._sum;
      }
      /**
       * @returns {Number} The minimum value recorded by this accumulation
       */
      get min() {
        return this._min;
      }
      /**
       * @returns {Number} The maximum value recorded by this accumulation
       */
      get max() {
        return this._max;
      }
      /**
       * @returns {Number} The count of values recorded by this accumulation
       */
      get count() {
        return this._count;
      }
      /**
       * @returns {Number} The number of 0 values recorded by this accumulation
       */
      get zeroCount() {
        return this._zeroCount;
      }
      /**
       * @returns {Number} The scale used by this accumulation
       */
      get scale() {
        if (this._count === this._zeroCount) {
          return 0;
        }
        return this._mapping.scale;
      }
      /**
       * positive holds the positive values
       * @returns {Buckets}
       */
      get positive() {
        return this._positive;
      }
      /**
       * negative holds the negative values by their absolute value
       * @returns {Buckets}
       */
      get negative() {
        return this._negative;
      }
      /**
       * updateByIncr supports updating a histogram with a non-negative
       * increment.
       * @param value
       * @param increment
       */
      updateByIncrement(value, increment) {
        if (Number.isNaN(value)) {
          return;
        }
        if (value > this._max) {
          this._max = value;
        }
        if (value < this._min) {
          this._min = value;
        }
        this._count += increment;
        if (value === 0) {
          this._zeroCount += increment;
          return;
        }
        this._sum += value * increment;
        if (value > 0) {
          this._updateBuckets(this._positive, value, increment);
        } else {
          this._updateBuckets(this._negative, -value, increment);
        }
      }
      /**
       * merge combines data from previous value into self
       * @param {ExponentialHistogramAccumulation} previous
       */
      merge(previous) {
        if (this._count === 0) {
          this._min = previous.min;
          this._max = previous.max;
        } else if (previous.count !== 0) {
          if (previous.min < this.min) {
            this._min = previous.min;
          }
          if (previous.max > this.max) {
            this._max = previous.max;
          }
        }
        this.startTime = previous.startTime;
        this._sum += previous.sum;
        this._count += previous.count;
        this._zeroCount += previous.zeroCount;
        const minScale = this._minScale(previous);
        this._downscale(this.scale - minScale);
        this._mergeBuckets(this.positive, previous, previous.positive, minScale);
        this._mergeBuckets(this.negative, previous, previous.negative, minScale);
      }
      /**
       * diff subtracts other from self
       * @param {ExponentialHistogramAccumulation} other
       */
      diff(other) {
        this._min = Infinity;
        this._max = -Infinity;
        this._sum -= other.sum;
        this._count -= other.count;
        this._zeroCount -= other.zeroCount;
        const minScale = this._minScale(other);
        this._downscale(this.scale - minScale);
        this._diffBuckets(this.positive, other, other.positive, minScale);
        this._diffBuckets(this.negative, other, other.negative, minScale);
      }
      /**
       * clone returns a deep copy of self
       * @returns {ExponentialHistogramAccumulation}
       */
      clone() {
        return new _ExponentialHistogramAccumulation(this.startTime, this._maxSize, this._recordMinMax, this._sum, this._count, this._zeroCount, this._min, this._max, this.positive.clone(), this.negative.clone(), this._mapping);
      }
      /**
       * _updateBuckets maps the incoming value to a bucket index for the current
       * scale. If the bucket index is outside of the range of the backing array,
       * it will rescale the backing array and update the mapping for the new scale.
       */
      _updateBuckets(buckets, value, increment) {
        let index = this._mapping.mapToIndex(value);
        let rescalingNeeded = false;
        let high = 0;
        let low = 0;
        if (buckets.length === 0) {
          buckets.indexStart = index;
          buckets.indexEnd = buckets.indexStart;
          buckets.indexBase = buckets.indexStart;
        } else if (index < buckets.indexStart && buckets.indexEnd - index >= this._maxSize) {
          rescalingNeeded = true;
          low = index;
          high = buckets.indexEnd;
        } else if (index > buckets.indexEnd && index - buckets.indexStart >= this._maxSize) {
          rescalingNeeded = true;
          low = buckets.indexStart;
          high = index;
        }
        if (rescalingNeeded) {
          const change = this._changeScale(high, low);
          this._downscale(change);
          index = this._mapping.mapToIndex(value);
        }
        this._incrementIndexBy(buckets, index, increment);
      }
      /**
       * _incrementIndexBy increments the count of the bucket specified by `index`.
       * If the index is outside of the range [buckets.indexStart, buckets.indexEnd]
       * the boundaries of the backing array will be adjusted and more buckets will
       * be added if needed.
       */
      _incrementIndexBy(buckets, index, increment) {
        if (increment === 0) {
          return;
        }
        if (buckets.length === 0) {
          buckets.indexStart = buckets.indexEnd = buckets.indexBase = index;
        }
        if (index < buckets.indexStart) {
          const span = buckets.indexEnd - index;
          if (span >= buckets.backing.length) {
            this._grow(buckets, span + 1);
          }
          buckets.indexStart = index;
        } else if (index > buckets.indexEnd) {
          const span = index - buckets.indexStart;
          if (span >= buckets.backing.length) {
            this._grow(buckets, span + 1);
          }
          buckets.indexEnd = index;
        }
        let bucketIndex = index - buckets.indexBase;
        if (bucketIndex < 0) {
          bucketIndex += buckets.backing.length;
        }
        buckets.incrementBucket(bucketIndex, increment);
      }
      /**
       * grow resizes the backing array by doubling in size up to maxSize.
       * This extends the array with a bunch of zeros and copies the
       * existing counts to the same position.
       */
      _grow(buckets, needed) {
        const size = buckets.backing.length;
        const bias = buckets.indexBase - buckets.indexStart;
        const oldPositiveLimit = size - bias;
        let newSize = (0, util_1.nextGreaterSquare)(needed);
        if (newSize > this._maxSize) {
          newSize = this._maxSize;
        }
        const newPositiveLimit = newSize - bias;
        buckets.backing.growTo(newSize, oldPositiveLimit, newPositiveLimit);
      }
      /**
       * _changeScale computes how much downscaling is needed by shifting the
       * high and low values until they are separated by no more than size.
       */
      _changeScale(high, low) {
        let change = 0;
        while (high - low >= this._maxSize) {
          high >>= 1;
          low >>= 1;
          change++;
        }
        return change;
      }
      /**
       * _downscale subtracts `change` from the current mapping scale.
       */
      _downscale(change) {
        if (change === 0) {
          return;
        }
        if (change < 0) {
          throw new Error(`impossible change of scale: ${this.scale}`);
        }
        const newScale = this._mapping.scale - change;
        this._positive.downscale(change);
        this._negative.downscale(change);
        this._mapping = (0, getMapping_1.getMapping)(newScale);
      }
      /**
       * _minScale is used by diff and merge to compute an ideal combined scale
       */
      _minScale(other) {
        const minScale = Math.min(this.scale, other.scale);
        const highLowPos = HighLow.combine(this._highLowAtScale(this.positive, this.scale, minScale), this._highLowAtScale(other.positive, other.scale, minScale));
        const highLowNeg = HighLow.combine(this._highLowAtScale(this.negative, this.scale, minScale), this._highLowAtScale(other.negative, other.scale, minScale));
        return Math.min(minScale - this._changeScale(highLowPos.high, highLowPos.low), minScale - this._changeScale(highLowNeg.high, highLowNeg.low));
      }
      /**
       * _highLowAtScale is used by diff and merge to compute an ideal combined scale.
       */
      _highLowAtScale(buckets, currentScale, newScale) {
        if (buckets.length === 0) {
          return new HighLow(0, -1);
        }
        const shift = currentScale - newScale;
        return new HighLow(buckets.indexStart >> shift, buckets.indexEnd >> shift);
      }
      /**
       * _mergeBuckets translates index values from another histogram and
       * adds the values into the corresponding buckets of this histogram.
       */
      _mergeBuckets(ours, other, theirs, scale) {
        const theirOffset = theirs.offset;
        const theirChange = other.scale - scale;
        for (let i = 0; i < theirs.length; i++) {
          this._incrementIndexBy(ours, theirOffset + i >> theirChange, theirs.at(i));
        }
      }
      /**
       * _diffBuckets translates index values from another histogram and
       * subtracts the values in the corresponding buckets of this histogram.
       */
      _diffBuckets(ours, other, theirs, scale) {
        const theirOffset = theirs.offset;
        const theirChange = other.scale - scale;
        for (let i = 0; i < theirs.length; i++) {
          const ourIndex = theirOffset + i >> theirChange;
          let bucketIndex = ourIndex - ours.indexBase;
          if (bucketIndex < 0) {
            bucketIndex += ours.backing.length;
          }
          ours.decrementBucket(bucketIndex, theirs.at(i));
        }
        ours.trim();
      }
    };
    exports.ExponentialHistogramAccumulation = ExponentialHistogramAccumulation;
    var ExponentialHistogramAggregator = class {
      static {
        __name(this, "ExponentialHistogramAggregator");
      }
      kind = types_1.AggregatorKind.EXPONENTIAL_HISTOGRAM;
      _maxSize;
      _recordMinMax;
      /**
       * @param _maxSize Maximum number of buckets for each of the positive
       *    and negative ranges, exclusive of the zero-bucket.
       * @param _recordMinMax If set to true, min and max will be recorded.
       *    Otherwise, min and max will not be recorded.
       */
      constructor(maxSize, recordMinMax) {
        this._maxSize = maxSize;
        this._recordMinMax = recordMinMax;
      }
      createAccumulation(startTime) {
        return new ExponentialHistogramAccumulation(startTime, this._maxSize, this._recordMinMax);
      }
      /**
       * Return the result of the merge of two exponential histogram accumulations.
       */
      merge(previous, delta) {
        const result = delta.clone();
        result.merge(previous);
        return result;
      }
      /**
       * Returns a new DELTA aggregation by comparing two cumulative measurements.
       */
      diff(previous, current) {
        const result = current.clone();
        result.diff(previous);
        return result;
      }
      toMetricData(descriptor, aggregationTemporality, accumulationByAttributes, endTime) {
        return {
          descriptor,
          aggregationTemporality,
          dataPointType: MetricData_1.DataPointType.EXPONENTIAL_HISTOGRAM,
          dataPoints: accumulationByAttributes.map(([attributes, accumulation]) => {
            const pointValue = accumulation.toPointValue();
            const allowsNegativeValues = descriptor.type === MetricData_1.InstrumentType.GAUGE || descriptor.type === MetricData_1.InstrumentType.UP_DOWN_COUNTER || descriptor.type === MetricData_1.InstrumentType.OBSERVABLE_GAUGE || descriptor.type === MetricData_1.InstrumentType.OBSERVABLE_UP_DOWN_COUNTER;
            return {
              attributes,
              startTime: accumulation.startTime,
              endTime,
              value: {
                min: pointValue.hasMinMax ? pointValue.min : void 0,
                max: pointValue.hasMinMax ? pointValue.max : void 0,
                sum: !allowsNegativeValues ? pointValue.sum : void 0,
                positive: {
                  offset: pointValue.positive.offset,
                  bucketCounts: pointValue.positive.bucketCounts
                },
                negative: {
                  offset: pointValue.negative.offset,
                  bucketCounts: pointValue.negative.bucketCounts
                },
                count: pointValue.count,
                scale: pointValue.scale,
                zeroCount: pointValue.zeroCount
              }
            };
          })
        };
      }
    };
    exports.ExponentialHistogramAggregator = ExponentialHistogramAggregator;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/LastValue.js
var require_LastValue = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/LastValue.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.LastValueAggregator = exports.LastValueAccumulation = void 0;
    var types_1 = require_types();
    var core_1 = require_src();
    var MetricData_1 = require_MetricData();
    var LastValueAccumulation = class {
      static {
        __name(this, "LastValueAccumulation");
      }
      startTime;
      _current;
      sampleTime;
      constructor(startTime, current = 0, sampleTime = [0, 0]) {
        this.startTime = startTime;
        this._current = current;
        this.sampleTime = sampleTime;
      }
      record(value) {
        this._current = value;
        this.sampleTime = (0, core_1.millisToHrTime)(Date.now());
      }
      setStartTime(startTime) {
        this.startTime = startTime;
      }
      toPointValue() {
        return this._current;
      }
    };
    exports.LastValueAccumulation = LastValueAccumulation;
    var LastValueAggregator = class {
      static {
        __name(this, "LastValueAggregator");
      }
      kind = types_1.AggregatorKind.LAST_VALUE;
      createAccumulation(startTime) {
        return new LastValueAccumulation(startTime);
      }
      /**
       * Returns the result of the merge of the given accumulations.
       *
       * Return the newly captured (delta) accumulation for LastValueAggregator.
       */
      merge(previous, delta) {
        const latestAccumulation = (0, core_1.hrTimeToMicroseconds)(delta.sampleTime) >= (0, core_1.hrTimeToMicroseconds)(previous.sampleTime) ? delta : previous;
        return new LastValueAccumulation(previous.startTime, latestAccumulation.toPointValue(), latestAccumulation.sampleTime);
      }
      /**
       * Returns a new DELTA aggregation by comparing two cumulative measurements.
       *
       * A delta aggregation is not meaningful to LastValueAggregator, just return
       * the newly captured (delta) accumulation for LastValueAggregator.
       */
      diff(previous, current) {
        const latestAccumulation = (0, core_1.hrTimeToMicroseconds)(current.sampleTime) >= (0, core_1.hrTimeToMicroseconds)(previous.sampleTime) ? current : previous;
        return new LastValueAccumulation(current.startTime, latestAccumulation.toPointValue(), latestAccumulation.sampleTime);
      }
      toMetricData(descriptor, aggregationTemporality, accumulationByAttributes, endTime) {
        return {
          descriptor,
          aggregationTemporality,
          dataPointType: MetricData_1.DataPointType.GAUGE,
          dataPoints: accumulationByAttributes.map(([attributes, accumulation]) => {
            return {
              attributes,
              startTime: accumulation.startTime,
              endTime,
              value: accumulation.toPointValue()
            };
          })
        };
      }
    };
    exports.LastValueAggregator = LastValueAggregator;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/Sum.js
var require_Sum = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/Sum.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SumAggregator = exports.SumAccumulation = void 0;
    var types_1 = require_types();
    var MetricData_1 = require_MetricData();
    var SumAccumulation = class {
      static {
        __name(this, "SumAccumulation");
      }
      startTime;
      monotonic;
      _current;
      reset;
      constructor(startTime, monotonic, current = 0, reset = false) {
        this.startTime = startTime;
        this.monotonic = monotonic;
        this._current = current;
        this.reset = reset;
      }
      record(value) {
        if (this.monotonic && value < 0) {
          return;
        }
        this._current += value;
      }
      setStartTime(startTime) {
        this.startTime = startTime;
      }
      toPointValue() {
        return this._current;
      }
    };
    exports.SumAccumulation = SumAccumulation;
    var SumAggregator = class {
      static {
        __name(this, "SumAggregator");
      }
      kind = types_1.AggregatorKind.SUM;
      monotonic;
      constructor(monotonic) {
        this.monotonic = monotonic;
      }
      createAccumulation(startTime) {
        return new SumAccumulation(startTime, this.monotonic);
      }
      /**
       * Returns the result of the merge of the given accumulations.
       */
      merge(previous, delta) {
        const prevPv = previous.toPointValue();
        const deltaPv = delta.toPointValue();
        if (delta.reset) {
          return new SumAccumulation(delta.startTime, this.monotonic, deltaPv, delta.reset);
        }
        return new SumAccumulation(previous.startTime, this.monotonic, prevPv + deltaPv);
      }
      /**
       * Returns a new DELTA aggregation by comparing two cumulative measurements.
       */
      diff(previous, current) {
        const prevPv = previous.toPointValue();
        const currPv = current.toPointValue();
        if (this.monotonic && prevPv > currPv) {
          return new SumAccumulation(current.startTime, this.monotonic, currPv, true);
        }
        return new SumAccumulation(current.startTime, this.monotonic, currPv - prevPv);
      }
      toMetricData(descriptor, aggregationTemporality, accumulationByAttributes, endTime) {
        return {
          descriptor,
          aggregationTemporality,
          dataPointType: MetricData_1.DataPointType.SUM,
          dataPoints: accumulationByAttributes.map(([attributes, accumulation]) => {
            return {
              attributes,
              startTime: accumulation.startTime,
              endTime,
              value: accumulation.toPointValue()
            };
          }),
          isMonotonic: this.monotonic
        };
      }
    };
    exports.SumAggregator = SumAggregator;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/index.js
var require_aggregator = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/aggregator/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SumAggregator = exports.SumAccumulation = exports.LastValueAggregator = exports.LastValueAccumulation = exports.ExponentialHistogramAggregator = exports.ExponentialHistogramAccumulation = exports.HistogramAggregator = exports.HistogramAccumulation = exports.DropAggregator = void 0;
    var Drop_1 = require_Drop();
    Object.defineProperty(exports, "DropAggregator", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return Drop_1.DropAggregator;
    }, "get") });
    var Histogram_1 = require_Histogram();
    Object.defineProperty(exports, "HistogramAccumulation", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return Histogram_1.HistogramAccumulation;
    }, "get") });
    Object.defineProperty(exports, "HistogramAggregator", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return Histogram_1.HistogramAggregator;
    }, "get") });
    var ExponentialHistogram_1 = require_ExponentialHistogram();
    Object.defineProperty(exports, "ExponentialHistogramAccumulation", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return ExponentialHistogram_1.ExponentialHistogramAccumulation;
    }, "get") });
    Object.defineProperty(exports, "ExponentialHistogramAggregator", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return ExponentialHistogram_1.ExponentialHistogramAggregator;
    }, "get") });
    var LastValue_1 = require_LastValue();
    Object.defineProperty(exports, "LastValueAccumulation", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return LastValue_1.LastValueAccumulation;
    }, "get") });
    Object.defineProperty(exports, "LastValueAggregator", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return LastValue_1.LastValueAggregator;
    }, "get") });
    var Sum_1 = require_Sum();
    Object.defineProperty(exports, "SumAccumulation", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return Sum_1.SumAccumulation;
    }, "get") });
    Object.defineProperty(exports, "SumAggregator", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return Sum_1.SumAggregator;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/view/Aggregation.js
var require_Aggregation = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/view/Aggregation.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DEFAULT_AGGREGATION = exports.EXPONENTIAL_HISTOGRAM_AGGREGATION = exports.HISTOGRAM_AGGREGATION = exports.LAST_VALUE_AGGREGATION = exports.SUM_AGGREGATION = exports.DROP_AGGREGATION = exports.DefaultAggregation = exports.ExponentialHistogramAggregation = exports.ExplicitBucketHistogramAggregation = exports.HistogramAggregation = exports.LastValueAggregation = exports.SumAggregation = exports.DropAggregation = void 0;
    var api = (init_esm(), __toCommonJS(esm_exports));
    var aggregator_1 = require_aggregator();
    var MetricData_1 = require_MetricData();
    var DropAggregation = class _DropAggregation {
      static {
        __name(this, "DropAggregation");
      }
      static DEFAULT_INSTANCE = new aggregator_1.DropAggregator();
      createAggregator(_instrument) {
        return _DropAggregation.DEFAULT_INSTANCE;
      }
    };
    exports.DropAggregation = DropAggregation;
    var SumAggregation = class _SumAggregation {
      static {
        __name(this, "SumAggregation");
      }
      static MONOTONIC_INSTANCE = new aggregator_1.SumAggregator(true);
      static NON_MONOTONIC_INSTANCE = new aggregator_1.SumAggregator(false);
      createAggregator(instrument) {
        switch (instrument.type) {
          case MetricData_1.InstrumentType.COUNTER:
          case MetricData_1.InstrumentType.OBSERVABLE_COUNTER:
          case MetricData_1.InstrumentType.HISTOGRAM: {
            return _SumAggregation.MONOTONIC_INSTANCE;
          }
          default: {
            return _SumAggregation.NON_MONOTONIC_INSTANCE;
          }
        }
      }
    };
    exports.SumAggregation = SumAggregation;
    var LastValueAggregation = class _LastValueAggregation {
      static {
        __name(this, "LastValueAggregation");
      }
      static DEFAULT_INSTANCE = new aggregator_1.LastValueAggregator();
      createAggregator(_instrument) {
        return _LastValueAggregation.DEFAULT_INSTANCE;
      }
    };
    exports.LastValueAggregation = LastValueAggregation;
    var HistogramAggregation = class _HistogramAggregation {
      static {
        __name(this, "HistogramAggregation");
      }
      static DEFAULT_INSTANCE = new aggregator_1.HistogramAggregator([0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1e3, 2500, 5e3, 7500, 1e4], true);
      createAggregator(_instrument) {
        return _HistogramAggregation.DEFAULT_INSTANCE;
      }
    };
    exports.HistogramAggregation = HistogramAggregation;
    var ExplicitBucketHistogramAggregation = class {
      static {
        __name(this, "ExplicitBucketHistogramAggregation");
      }
      _boundaries;
      _recordMinMax;
      /**
       * @param boundaries the bucket boundaries of the histogram aggregation
       * @param _recordMinMax If set to true, min and max will be recorded. Otherwise, min and max will not be recorded.
       */
      constructor(boundaries, recordMinMax = true) {
        if (boundaries == null) {
          throw new Error("ExplicitBucketHistogramAggregation should be created with explicit boundaries, if a single bucket histogram is required, please pass an empty array");
        }
        boundaries = boundaries.concat();
        boundaries = boundaries.sort((a, b) => a - b);
        const minusInfinityIndex = boundaries.lastIndexOf(-Infinity);
        let infinityIndex = boundaries.indexOf(Infinity);
        if (infinityIndex === -1) {
          infinityIndex = void 0;
        }
        this._boundaries = boundaries.slice(minusInfinityIndex + 1, infinityIndex);
        this._recordMinMax = recordMinMax;
      }
      createAggregator(_instrument) {
        return new aggregator_1.HistogramAggregator(this._boundaries, this._recordMinMax);
      }
    };
    exports.ExplicitBucketHistogramAggregation = ExplicitBucketHistogramAggregation;
    var ExponentialHistogramAggregation = class {
      static {
        __name(this, "ExponentialHistogramAggregation");
      }
      _maxSize;
      _recordMinMax;
      constructor(maxSize = 160, recordMinMax = true) {
        this._maxSize = maxSize;
        this._recordMinMax = recordMinMax;
      }
      createAggregator(_instrument) {
        return new aggregator_1.ExponentialHistogramAggregator(this._maxSize, this._recordMinMax);
      }
    };
    exports.ExponentialHistogramAggregation = ExponentialHistogramAggregation;
    var DefaultAggregation = class {
      static {
        __name(this, "DefaultAggregation");
      }
      _resolve(instrument) {
        switch (instrument.type) {
          case MetricData_1.InstrumentType.COUNTER:
          case MetricData_1.InstrumentType.UP_DOWN_COUNTER:
          case MetricData_1.InstrumentType.OBSERVABLE_COUNTER:
          case MetricData_1.InstrumentType.OBSERVABLE_UP_DOWN_COUNTER: {
            return exports.SUM_AGGREGATION;
          }
          case MetricData_1.InstrumentType.GAUGE:
          case MetricData_1.InstrumentType.OBSERVABLE_GAUGE: {
            return exports.LAST_VALUE_AGGREGATION;
          }
          case MetricData_1.InstrumentType.HISTOGRAM: {
            if (instrument.advice.explicitBucketBoundaries) {
              return new ExplicitBucketHistogramAggregation(instrument.advice.explicitBucketBoundaries);
            }
            return exports.HISTOGRAM_AGGREGATION;
          }
        }
        api.diag.warn(`Unable to recognize instrument type: ${instrument.type}`);
        return exports.DROP_AGGREGATION;
      }
      createAggregator(instrument) {
        return this._resolve(instrument).createAggregator(instrument);
      }
    };
    exports.DefaultAggregation = DefaultAggregation;
    exports.DROP_AGGREGATION = new DropAggregation();
    exports.SUM_AGGREGATION = new SumAggregation();
    exports.LAST_VALUE_AGGREGATION = new LastValueAggregation();
    exports.HISTOGRAM_AGGREGATION = new HistogramAggregation();
    exports.EXPONENTIAL_HISTOGRAM_AGGREGATION = new ExponentialHistogramAggregation();
    exports.DEFAULT_AGGREGATION = new DefaultAggregation();
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/view/AggregationOption.js
var require_AggregationOption = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/view/AggregationOption.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.toAggregation = exports.AggregationType = void 0;
    var Aggregation_1 = require_Aggregation();
    var AggregationType;
    (function(AggregationType2) {
      AggregationType2[AggregationType2["DEFAULT"] = 0] = "DEFAULT";
      AggregationType2[AggregationType2["DROP"] = 1] = "DROP";
      AggregationType2[AggregationType2["SUM"] = 2] = "SUM";
      AggregationType2[AggregationType2["LAST_VALUE"] = 3] = "LAST_VALUE";
      AggregationType2[AggregationType2["EXPLICIT_BUCKET_HISTOGRAM"] = 4] = "EXPLICIT_BUCKET_HISTOGRAM";
      AggregationType2[AggregationType2["EXPONENTIAL_HISTOGRAM"] = 5] = "EXPONENTIAL_HISTOGRAM";
    })(AggregationType || (exports.AggregationType = AggregationType = {}));
    function toAggregation(option) {
      switch (option.type) {
        case AggregationType.DEFAULT:
          return Aggregation_1.DEFAULT_AGGREGATION;
        case AggregationType.DROP:
          return Aggregation_1.DROP_AGGREGATION;
        case AggregationType.SUM:
          return Aggregation_1.SUM_AGGREGATION;
        case AggregationType.LAST_VALUE:
          return Aggregation_1.LAST_VALUE_AGGREGATION;
        case AggregationType.EXPONENTIAL_HISTOGRAM: {
          const expOption = option;
          return new Aggregation_1.ExponentialHistogramAggregation(expOption.options?.maxSize, expOption.options?.recordMinMax);
        }
        case AggregationType.EXPLICIT_BUCKET_HISTOGRAM: {
          const expOption = option;
          if (expOption.options == null) {
            return Aggregation_1.HISTOGRAM_AGGREGATION;
          } else {
            return new Aggregation_1.ExplicitBucketHistogramAggregation(expOption.options?.boundaries, expOption.options?.recordMinMax);
          }
        }
        default:
          throw new Error("Unsupported Aggregation");
      }
    }
    __name(toAggregation, "toAggregation");
    exports.toAggregation = toAggregation;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/export/AggregationSelector.js
var require_AggregationSelector = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/export/AggregationSelector.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DEFAULT_AGGREGATION_TEMPORALITY_SELECTOR = exports.DEFAULT_AGGREGATION_SELECTOR = void 0;
    var AggregationTemporality_1 = require_AggregationTemporality();
    var AggregationOption_1 = require_AggregationOption();
    var DEFAULT_AGGREGATION_SELECTOR = /* @__PURE__ */ __name((_instrumentType) => {
      return {
        type: AggregationOption_1.AggregationType.DEFAULT
      };
    }, "DEFAULT_AGGREGATION_SELECTOR");
    exports.DEFAULT_AGGREGATION_SELECTOR = DEFAULT_AGGREGATION_SELECTOR;
    var DEFAULT_AGGREGATION_TEMPORALITY_SELECTOR = /* @__PURE__ */ __name((_instrumentType) => AggregationTemporality_1.AggregationTemporality.CUMULATIVE, "DEFAULT_AGGREGATION_TEMPORALITY_SELECTOR");
    exports.DEFAULT_AGGREGATION_TEMPORALITY_SELECTOR = DEFAULT_AGGREGATION_TEMPORALITY_SELECTOR;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/semconv.js
var require_semconv3 = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/semconv.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ATTR_ERROR_TYPE = exports.METRIC_OTEL_SDK_METRIC_READER_COLLECTION_DURATION = exports.OTEL_COMPONENT_TYPE_VALUE_PERIODIC_METRIC_READER = exports.ATTR_OTEL_COMPONENT_TYPE = exports.ATTR_OTEL_COMPONENT_NAME = void 0;
    exports.ATTR_OTEL_COMPONENT_NAME = "otel.component.name";
    exports.ATTR_OTEL_COMPONENT_TYPE = "otel.component.type";
    exports.OTEL_COMPONENT_TYPE_VALUE_PERIODIC_METRIC_READER = "periodic_metric_reader";
    exports.METRIC_OTEL_SDK_METRIC_READER_COLLECTION_DURATION = "otel.sdk.metric_reader.collection.duration";
    exports.ATTR_ERROR_TYPE = "error.type";
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/export/MetricReaderMetrics.js
var require_MetricReaderMetrics = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/export/MetricReaderMetrics.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MetricReaderMetrics = void 0;
    var semconv_1 = require_semconv3();
    var componentCounter = /* @__PURE__ */ new Map();
    var MetricReaderMetrics = class {
      static {
        __name(this, "MetricReaderMetrics");
      }
      collectionDuration;
      standardAttrs;
      constructor(componentType, meter) {
        const counter = componentCounter.get(componentType) ?? 0;
        componentCounter.set(componentType, counter + 1);
        this.standardAttrs = {
          [semconv_1.ATTR_OTEL_COMPONENT_TYPE]: componentType,
          [semconv_1.ATTR_OTEL_COMPONENT_NAME]: `${componentType}/${counter}`
        };
        this.collectionDuration = meter.createHistogram(semconv_1.METRIC_OTEL_SDK_METRIC_READER_COLLECTION_DURATION, {
          unit: "s",
          description: "The duration of the collect operation of the metric reader.",
          advice: {
            explicitBucketBoundaries: []
          }
        });
      }
      recordCollection(durationSecs, error) {
        const attrs = error ? { ...this.standardAttrs, [semconv_1.ATTR_ERROR_TYPE]: error } : this.standardAttrs;
        this.collectionDuration.record(durationSecs, attrs);
      }
    };
    exports.MetricReaderMetrics = MetricReaderMetrics;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/version.js
var require_version2 = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/version.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.VERSION = void 0;
    exports.VERSION = "2.10.0";
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/export/MetricReader.js
var require_MetricReader = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/export/MetricReader.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MetricReader = void 0;
    var api = (init_esm(), __toCommonJS(esm_exports));
    var utils_1 = require_utils4();
    var AggregationSelector_1 = require_AggregationSelector();
    var MetricReaderMetrics_1 = require_MetricReaderMetrics();
    var version_1 = require_version2();
    var core_1 = require_src();
    var MetricReader = class {
      static {
        __name(this, "MetricReader");
      }
      // Tracks the shutdown state.
      // TODO: use BindOncePromise here once a new version of @opentelemetry/core is available.
      _shutdown = false;
      // Additional MetricProducers which will be combined with the SDK's output
      _metricProducers;
      // MetricProducer used by this instance which produces metrics from the SDK
      _sdkMetricProducer;
      // Metrics about the MetricReader itself
      _selfObsMetrics;
      _aggregationTemporalitySelector;
      _aggregationSelector;
      _cardinalitySelector;
      _otelComponentType;
      constructor(options) {
        this._aggregationSelector = options?.aggregationSelector ?? AggregationSelector_1.DEFAULT_AGGREGATION_SELECTOR;
        this._aggregationTemporalitySelector = options?.aggregationTemporalitySelector ?? AggregationSelector_1.DEFAULT_AGGREGATION_TEMPORALITY_SELECTOR;
        this._metricProducers = options?.metricProducers ?? [];
        this._cardinalitySelector = options?.cardinalitySelector;
        this._otelComponentType = options?.otelComponentType ?? this.constructor.name;
        this._selfObsMetrics = new MetricReaderMetrics_1.MetricReaderMetrics(this._otelComponentType, api.createNoopMeter());
      }
      setMetricProducer(metricProducer) {
        if (this._sdkMetricProducer) {
          throw new Error("MetricReader can not be bound to a MeterProvider again.");
        }
        this._sdkMetricProducer = metricProducer;
        this.onInitialized();
      }
      _setSelfObsMeterProvider(meterProvider) {
        const meter = meterProvider.getMeter("@opentelemetry/sdk-metrics", version_1.VERSION);
        this._selfObsMetrics = new MetricReaderMetrics_1.MetricReaderMetrics(this._otelComponentType, meter);
      }
      selectAggregation(instrumentType) {
        return this._aggregationSelector(instrumentType);
      }
      selectAggregationTemporality(instrumentType) {
        return this._aggregationTemporalitySelector(instrumentType);
      }
      selectCardinalityLimit(instrumentType) {
        return this._cardinalitySelector ? this._cardinalitySelector(instrumentType) : 2e3;
      }
      /**
       * Handle once the SDK has initialized this {@link MetricReader}
       * Overriding this method is optional.
       */
      onInitialized() {
      }
      async collect(options) {
        if (this._sdkMetricProducer === void 0) {
          throw new Error("MetricReader is not bound to a MetricProducer");
        }
        if (this._shutdown) {
          throw new Error("MetricReader is shutdown");
        }
        const startTime = (0, core_1.hrTime)();
        const [sdkCollectionResults, ...additionalCollectionResults] = await Promise.all([
          this._sdkMetricProducer.collect({
            timeoutMillis: options?.timeoutMillis
          }),
          ...this._metricProducers.map((producer) => producer.collect({
            timeoutMillis: options?.timeoutMillis
          }))
        ]);
        const endTime = (0, core_1.hrTime)();
        const errors = sdkCollectionResults.errors.concat(additionalCollectionResults.flatMap((result) => result.errors));
        const collectDuration = (0, core_1.hrTimeToSeconds)((0, core_1.hrTimeDuration)(startTime, endTime));
        this._selfObsMetrics.recordCollection(collectDuration, errors.length > 0 ? errors[0].name ?? "collect_error" : void 0);
        const resource = sdkCollectionResults.resourceMetrics.resource;
        const scopeMetrics = sdkCollectionResults.resourceMetrics.scopeMetrics.concat(additionalCollectionResults.flatMap((result) => result.resourceMetrics.scopeMetrics));
        return {
          resourceMetrics: {
            resource,
            scopeMetrics
          },
          errors
        };
      }
      async shutdown(options) {
        if (this._shutdown) {
          api.diag.error("Cannot call shutdown twice.");
          return;
        }
        if (options?.timeoutMillis == null) {
          await this.onShutdown();
        } else {
          await (0, utils_1.callWithTimeout)(this.onShutdown(), options.timeoutMillis);
        }
        this._shutdown = true;
      }
      async forceFlush(options) {
        if (this._shutdown) {
          api.diag.warn("Cannot forceFlush on already shutdown MetricReader.");
          return;
        }
        if (options?.timeoutMillis == null) {
          await this.onForceFlush();
          return;
        }
        await (0, utils_1.callWithTimeout)(this.onForceFlush(), options.timeoutMillis);
      }
    };
    exports.MetricReader = MetricReader;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/export/MetricDataSplitter.js
var require_MetricDataSplitter = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/export/MetricDataSplitter.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.splitMetricData = void 0;
    function splitMetricData(resourceMetrics, maxExportBatchSize) {
      if (!Number.isInteger(maxExportBatchSize) || maxExportBatchSize <= 0) {
        throw new Error("maxExportBatchSize must be a positive integer");
      }
      const batches = [];
      let currentBatchPoints = 0;
      let currentScopeMetrics = [];
      function flush() {
        if (currentScopeMetrics.length > 0) {
          batches.push({
            resource: resourceMetrics.resource,
            scopeMetrics: currentScopeMetrics
          });
          currentScopeMetrics = [];
          currentBatchPoints = 0;
        }
      }
      __name(flush, "flush");
      for (const scopeMetric of resourceMetrics.scopeMetrics) {
        let scopeMetricCopy = null;
        for (const metric of scopeMetric.metrics) {
          const dataPoints = metric.dataPoints;
          if (dataPoints.length === 0) {
            if (!scopeMetricCopy) {
              scopeMetricCopy = { scope: scopeMetric.scope, metrics: [] };
              currentScopeMetrics.push(scopeMetricCopy);
            }
            scopeMetricCopy.metrics.push(metric);
            continue;
          }
          let offset = 0;
          while (offset < dataPoints.length) {
            const spaceLeft = maxExportBatchSize - currentBatchPoints;
            const take = Math.min(spaceLeft, dataPoints.length - offset);
            if (!scopeMetricCopy) {
              scopeMetricCopy = { scope: scopeMetric.scope, metrics: [] };
              currentScopeMetrics.push(scopeMetricCopy);
            }
            const metricCopy = {
              ...metric,
              dataPoints: dataPoints.slice(offset, offset + take)
            };
            scopeMetricCopy.metrics.push(metricCopy);
            offset += take;
            currentBatchPoints += take;
            if (currentBatchPoints === maxExportBatchSize) {
              flush();
              scopeMetricCopy = null;
            }
          }
        }
      }
      flush();
      return batches;
    }
    __name(splitMetricData, "splitMetricData");
    exports.splitMetricData = splitMetricData;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/export/PeriodicExportingMetricReader.js
var require_PeriodicExportingMetricReader = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/export/PeriodicExportingMetricReader.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.PeriodicExportingMetricReader = void 0;
    var api = (init_esm(), __toCommonJS(esm_exports));
    var core_1 = require_src();
    var MetricReader_1 = require_MetricReader();
    var utils_1 = require_utils4();
    var MetricData_1 = require_MetricData();
    var MetricDataSplitter_1 = require_MetricDataSplitter();
    var semconv_1 = require_semconv3();
    var PeriodicExportingMetricReader = class extends MetricReader_1.MetricReader {
      static {
        __name(this, "PeriodicExportingMetricReader");
      }
      _interval;
      _exporter;
      _exportInterval;
      _exportTimeout;
      _maxExportBatchSize;
      _ongoingExportPromise = null;
      constructor(options) {
        const { exporter, exportIntervalMillis = 6e4, metricProducers, cardinalityLimits, maxExportBatchSize } = options;
        let { exportTimeoutMillis = 3e4 } = options;
        super({
          aggregationSelector: exporter.selectAggregation?.bind(exporter),
          aggregationTemporalitySelector: exporter.selectAggregationTemporality?.bind(exporter),
          otelComponentType: semconv_1.OTEL_COMPONENT_TYPE_VALUE_PERIODIC_METRIC_READER,
          metricProducers,
          cardinalitySelector: /* @__PURE__ */ __name((instrumentType) => {
            const limits = {
              default: 2e3,
              ...cardinalityLimits
            };
            switch (instrumentType) {
              case MetricData_1.InstrumentType.COUNTER:
                return limits.counter ?? limits.default;
              case MetricData_1.InstrumentType.GAUGE:
                return limits.gauge ?? limits.default;
              case MetricData_1.InstrumentType.HISTOGRAM:
                return limits.histogram ?? limits.default;
              case MetricData_1.InstrumentType.OBSERVABLE_COUNTER:
                return limits.observableCounter ?? limits.default;
              case MetricData_1.InstrumentType.OBSERVABLE_UP_DOWN_COUNTER:
                return limits.observableUpDownCounter ?? limits.default;
              case MetricData_1.InstrumentType.OBSERVABLE_GAUGE:
                return limits.observableGauge ?? limits.default;
              case MetricData_1.InstrumentType.UP_DOWN_COUNTER:
                return limits.upDownCounter ?? limits.default;
              default:
                return limits.default;
            }
          }, "cardinalitySelector")
        });
        if (exportIntervalMillis <= 0) {
          throw Error("exportIntervalMillis must be greater than 0");
        }
        if (exportTimeoutMillis <= 0) {
          throw Error("exportTimeoutMillis must be greater than 0");
        }
        if (maxExportBatchSize !== void 0 && (!Number.isInteger(maxExportBatchSize) || maxExportBatchSize <= 0)) {
          throw Error("maxExportBatchSize must be a positive integer");
        }
        if (exportIntervalMillis < exportTimeoutMillis) {
          if ("exportIntervalMillis" in options && "exportTimeoutMillis" in options) {
            throw Error("exportIntervalMillis must be greater than or equal to exportTimeoutMillis");
          } else {
            api.diag.info(`Timeout of ${exportTimeoutMillis} exceeds the interval of ${exportIntervalMillis}. Clamping timeout to interval duration.`);
            exportTimeoutMillis = exportIntervalMillis;
          }
        }
        this._exportInterval = exportIntervalMillis;
        this._exportTimeout = exportTimeoutMillis;
        this._exporter = exporter;
        this._maxExportBatchSize = maxExportBatchSize;
      }
      async _runOnce() {
        try {
          await this._doRun();
        } catch (err) {
          (0, core_1.globalErrorHandler)(err);
        }
      }
      async _doRun() {
        if (this._ongoingExportPromise) {
          api.diag.debug("PeriodicExportingMetricReader: export already in progress, skipping");
          return;
        }
        const currentRun = /* @__PURE__ */ __name(async () => {
          const { resourceMetrics, errors } = await this.collect({
            timeoutMillis: this._exportTimeout
          });
          if (errors.length > 0) {
            api.diag.error("PeriodicExportingMetricReader: metrics collection errors", ...errors);
          }
          if (resourceMetrics.resource.asyncAttributesPending) {
            try {
              await resourceMetrics.resource.waitForAsyncAttributes?.();
            } catch (e) {
              api.diag.debug("Error while resolving async portion of resource: ", e);
              (0, core_1.globalErrorHandler)(e);
            }
          }
          if (resourceMetrics.scopeMetrics.length === 0) {
            return;
          }
          const batches = this._maxExportBatchSize ? (0, MetricDataSplitter_1.splitMetricData)(resourceMetrics, this._maxExportBatchSize) : [resourceMetrics];
          let anyErr = null;
          for (const batch of batches) {
            try {
              const result = await (0, utils_1.callWithTimeout)(core_1.internal._export(this._exporter, batch), this._exportTimeout);
              if (result.code !== core_1.ExportResultCode.SUCCESS) {
                const err = new Error(`PeriodicExportingMetricReader: metrics export failed (error ${result.error})`);
                anyErr = err;
              }
            } catch (e) {
              if (e instanceof utils_1.TimeoutError) {
                api.diag.error(`PeriodicExportingMetricReader: metrics export timed out after ${this._exportTimeout}ms`);
                break;
              } else {
                api.diag.error("PeriodicExportingMetricReader: metrics export threw error", e);
                anyErr = e instanceof Error ? e : new Error(String(e));
              }
            }
          }
          if (anyErr) {
            throw anyErr;
          }
        }, "currentRun");
        this._ongoingExportPromise = currentRun();
        try {
          await this._ongoingExportPromise;
        } finally {
          this._ongoingExportPromise = null;
        }
      }
      onInitialized() {
        this._interval = setInterval(() => {
          void this._runOnce();
        }, this._exportInterval);
        if (typeof this._interval !== "number") {
          this._interval.unref();
        }
      }
      async onForceFlush() {
        await this._awaitOngoingExport();
        if (this._ongoingExportPromise) {
          await this._awaitOngoingExport();
        } else {
          await this._runOnce();
        }
        await this._exporter.forceFlush();
      }
      /**
       * Helper function to wait for an ongoing export to complete.
       * Errors are swallowed and handled by the original _runOnce().
       */
      async _awaitOngoingExport() {
        if (this._ongoingExportPromise) {
          api.diag.debug("PeriodicExportingMetricReader: export already in progress, awaiting ongoing export");
          try {
            await this._ongoingExportPromise;
          } catch {
          }
        }
      }
      async onShutdown() {
        if (this._interval) {
          clearInterval(this._interval);
        }
        await this.onForceFlush();
        await this._exporter.shutdown();
      }
    };
    exports.PeriodicExportingMetricReader = PeriodicExportingMetricReader;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/export/InMemoryMetricExporter.js
var require_InMemoryMetricExporter = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/export/InMemoryMetricExporter.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.InMemoryMetricExporter = void 0;
    var core_1 = require_src();
    var InMemoryMetricExporter = class {
      static {
        __name(this, "InMemoryMetricExporter");
      }
      _shutdown = false;
      _aggregationTemporality;
      _metrics = [];
      constructor(aggregationTemporality) {
        this._aggregationTemporality = aggregationTemporality;
      }
      /**
       * @inheritedDoc
       */
      export(metrics, resultCallback) {
        if (this._shutdown) {
          setTimeout(() => resultCallback({ code: core_1.ExportResultCode.FAILED }), 0);
          return;
        }
        this._metrics.push(metrics);
        setTimeout(() => resultCallback({ code: core_1.ExportResultCode.SUCCESS }), 0);
      }
      /**
       * Returns all the collected resource metrics
       * @returns ResourceMetrics[]
       */
      getMetrics() {
        return this._metrics;
      }
      forceFlush() {
        return Promise.resolve();
      }
      reset() {
        this._metrics = [];
      }
      selectAggregationTemporality(_instrumentType) {
        return this._aggregationTemporality;
      }
      shutdown() {
        this._shutdown = true;
        return Promise.resolve();
      }
    };
    exports.InMemoryMetricExporter = InMemoryMetricExporter;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/export/ConsoleMetricExporter.js
var require_ConsoleMetricExporter = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/export/ConsoleMetricExporter.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ConsoleMetricExporter = void 0;
    var core_1 = require_src();
    var AggregationSelector_1 = require_AggregationSelector();
    var ConsoleMetricExporter = class _ConsoleMetricExporter {
      static {
        __name(this, "ConsoleMetricExporter");
      }
      _shutdown = false;
      _temporalitySelector;
      constructor(options) {
        this._temporalitySelector = options?.temporalitySelector ?? AggregationSelector_1.DEFAULT_AGGREGATION_TEMPORALITY_SELECTOR;
      }
      export(metrics, resultCallback) {
        if (this._shutdown) {
          resultCallback({ code: core_1.ExportResultCode.FAILED });
          return;
        }
        return _ConsoleMetricExporter._sendMetrics(metrics, resultCallback);
      }
      forceFlush() {
        return Promise.resolve();
      }
      selectAggregationTemporality(_instrumentType) {
        return this._temporalitySelector(_instrumentType);
      }
      shutdown() {
        this._shutdown = true;
        return Promise.resolve();
      }
      static _sendMetrics(metrics, done) {
        for (const scopeMetrics of metrics.scopeMetrics) {
          for (const metric of scopeMetrics.metrics) {
            console.dir({
              descriptor: metric.descriptor,
              dataPointType: metric.dataPointType,
              dataPoints: metric.dataPoints
            }, { depth: null });
          }
        }
        done({ code: core_1.ExportResultCode.SUCCESS });
      }
    };
    exports.ConsoleMetricExporter = ConsoleMetricExporter;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/view/ViewRegistry.js
var require_ViewRegistry = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/view/ViewRegistry.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ViewRegistry = void 0;
    var ViewRegistry = class {
      static {
        __name(this, "ViewRegistry");
      }
      _registeredViews = [];
      addView(view) {
        this._registeredViews.push(view);
      }
      findViews(instrument, meter) {
        const views = this._registeredViews.filter((registeredView) => {
          return this._matchInstrument(registeredView.instrumentSelector, instrument) && this._matchMeter(registeredView.meterSelector, meter);
        });
        return views;
      }
      _matchInstrument(selector, instrument) {
        return (selector.getType() === void 0 || instrument.type === selector.getType()) && selector.getNameFilter().match(instrument.name) && selector.getUnitFilter().match(instrument.unit);
      }
      _matchMeter(selector, meter) {
        return selector.getNameFilter().match(meter.name) && (meter.version === void 0 || selector.getVersionFilter().match(meter.version)) && (meter.schemaUrl === void 0 || selector.getSchemaUrlFilter().match(meter.schemaUrl));
      }
    };
    exports.ViewRegistry = ViewRegistry;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/InstrumentDescriptor.js
var require_InstrumentDescriptor = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/InstrumentDescriptor.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isValidName = exports.isDescriptorCompatibleWith = exports.createInstrumentDescriptorWithView = exports.createInstrumentDescriptor = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var utils_1 = require_utils4();
    function createInstrumentDescriptor(name, type, options) {
      if (!isValidName(name)) {
        api_1.diag.warn(`Invalid metric name: "${name}". The metric name should be a ASCII string with a length no greater than 255 characters.`);
      }
      return {
        name,
        type,
        description: options?.description ?? "",
        unit: options?.unit ?? "",
        valueType: options?.valueType ?? api_1.ValueType.DOUBLE,
        advice: options?.advice ?? {}
      };
    }
    __name(createInstrumentDescriptor, "createInstrumentDescriptor");
    exports.createInstrumentDescriptor = createInstrumentDescriptor;
    function createInstrumentDescriptorWithView(view, instrument) {
      return {
        name: view.name ?? instrument.name,
        description: view.description ?? instrument.description,
        type: instrument.type,
        unit: instrument.unit,
        valueType: instrument.valueType,
        advice: instrument.advice
      };
    }
    __name(createInstrumentDescriptorWithView, "createInstrumentDescriptorWithView");
    exports.createInstrumentDescriptorWithView = createInstrumentDescriptorWithView;
    function isDescriptorCompatibleWith(descriptor, otherDescriptor) {
      return (0, utils_1.equalsCaseInsensitive)(descriptor.name, otherDescriptor.name) && descriptor.unit === otherDescriptor.unit && descriptor.type === otherDescriptor.type && descriptor.valueType === otherDescriptor.valueType;
    }
    __name(isDescriptorCompatibleWith, "isDescriptorCompatibleWith");
    exports.isDescriptorCompatibleWith = isDescriptorCompatibleWith;
    var NAME_REGEXP = /^[a-z][a-z0-9_.\-/]{0,254}$/i;
    function isValidName(name) {
      return NAME_REGEXP.test(name);
    }
    __name(isValidName, "isValidName");
    exports.isValidName = isValidName;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/Instruments.js
var require_Instruments = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/Instruments.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isObservableInstrument = exports.ObservableUpDownCounterInstrument = exports.ObservableGaugeInstrument = exports.ObservableCounterInstrument = exports.ObservableInstrument = exports.HistogramInstrument = exports.GaugeInstrument = exports.CounterInstrument = exports.UpDownCounterInstrument = exports.SyncInstrument = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var SyncInstrument = class {
      static {
        __name(this, "SyncInstrument");
      }
      _writableMetricStorage;
      _descriptor;
      constructor(writableMetricStorage, descriptor) {
        this._writableMetricStorage = writableMetricStorage;
        this._descriptor = descriptor;
      }
      _record(value, attributes = {}, context) {
        if (typeof value !== "number") {
          api_1.diag.warn(`non-number value provided to metric ${this._descriptor.name}: ${value}`);
          return;
        }
        if (this._descriptor.valueType === api_1.ValueType.INT && !Number.isInteger(value)) {
          api_1.diag.warn(`INT value type cannot accept a floating-point value for ${this._descriptor.name}, ignoring the fractional digits.`);
          value = Math.trunc(value);
          if (!Number.isInteger(value)) {
            return;
          }
        }
        this._writableMetricStorage.record(value, attributes, context, Date.now());
      }
    };
    exports.SyncInstrument = SyncInstrument;
    var UpDownCounterInstrument = class extends SyncInstrument {
      static {
        __name(this, "UpDownCounterInstrument");
      }
      /**
       * Increment value of counter by the input. Inputs may be negative.
       */
      add(value, attributes, ctx) {
        this._record(value, attributes, ctx);
      }
    };
    exports.UpDownCounterInstrument = UpDownCounterInstrument;
    var CounterInstrument = class extends SyncInstrument {
      static {
        __name(this, "CounterInstrument");
      }
      /**
       * Increment value of counter by the input. Inputs may not be negative.
       */
      add(value, attributes, ctx) {
        if (value < 0) {
          api_1.diag.warn(`negative value provided to counter ${this._descriptor.name}: ${value}`);
          return;
        }
        this._record(value, attributes, ctx);
      }
    };
    exports.CounterInstrument = CounterInstrument;
    var GaugeInstrument = class extends SyncInstrument {
      static {
        __name(this, "GaugeInstrument");
      }
      /**
       * Records a measurement.
       */
      record(value, attributes, ctx) {
        this._record(value, attributes, ctx);
      }
    };
    exports.GaugeInstrument = GaugeInstrument;
    var HistogramInstrument = class extends SyncInstrument {
      static {
        __name(this, "HistogramInstrument");
      }
      /**
       * Records a measurement. Value of the measurement must not be negative.
       */
      record(value, attributes, ctx) {
        if (value < 0) {
          api_1.diag.warn(`negative value provided to histogram ${this._descriptor.name}: ${value}`);
          return;
        }
        this._record(value, attributes, ctx);
      }
    };
    exports.HistogramInstrument = HistogramInstrument;
    var ObservableInstrument = class {
      static {
        __name(this, "ObservableInstrument");
      }
      /** @internal */
      _metricStorages;
      /** @internal */
      _descriptor;
      _observableRegistry;
      constructor(descriptor, metricStorages, observableRegistry) {
        this._descriptor = descriptor;
        this._metricStorages = metricStorages;
        this._observableRegistry = observableRegistry;
      }
      /**
       * @see {Observable.addCallback}
       */
      addCallback(callback) {
        this._observableRegistry.addCallback(callback, this);
      }
      /**
       * @see {Observable.removeCallback}
       */
      removeCallback(callback) {
        this._observableRegistry.removeCallback(callback, this);
      }
    };
    exports.ObservableInstrument = ObservableInstrument;
    var ObservableCounterInstrument = class extends ObservableInstrument {
      static {
        __name(this, "ObservableCounterInstrument");
      }
    };
    exports.ObservableCounterInstrument = ObservableCounterInstrument;
    var ObservableGaugeInstrument = class extends ObservableInstrument {
      static {
        __name(this, "ObservableGaugeInstrument");
      }
    };
    exports.ObservableGaugeInstrument = ObservableGaugeInstrument;
    var ObservableUpDownCounterInstrument = class extends ObservableInstrument {
      static {
        __name(this, "ObservableUpDownCounterInstrument");
      }
    };
    exports.ObservableUpDownCounterInstrument = ObservableUpDownCounterInstrument;
    function isObservableInstrument(it) {
      return it instanceof ObservableInstrument;
    }
    __name(isObservableInstrument, "isObservableInstrument");
    exports.isObservableInstrument = isObservableInstrument;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/Meter.js
var require_Meter = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/Meter.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Meter = void 0;
    var InstrumentDescriptor_1 = require_InstrumentDescriptor();
    var Instruments_1 = require_Instruments();
    var MetricData_1 = require_MetricData();
    var Meter = class {
      static {
        __name(this, "Meter");
      }
      _meterSharedState;
      constructor(meterSharedState) {
        this._meterSharedState = meterSharedState;
      }
      /**
       * Create a {@link Gauge} instrument.
       */
      createGauge(name, options) {
        const descriptor = (0, InstrumentDescriptor_1.createInstrumentDescriptor)(name, MetricData_1.InstrumentType.GAUGE, options);
        const storage = this._meterSharedState.registerMetricStorage(descriptor);
        return new Instruments_1.GaugeInstrument(storage, descriptor);
      }
      /**
       * Create a {@link Histogram} instrument.
       */
      createHistogram(name, options) {
        const descriptor = (0, InstrumentDescriptor_1.createInstrumentDescriptor)(name, MetricData_1.InstrumentType.HISTOGRAM, options);
        const storage = this._meterSharedState.registerMetricStorage(descriptor);
        return new Instruments_1.HistogramInstrument(storage, descriptor);
      }
      /**
       * Create a {@link Counter} instrument.
       */
      createCounter(name, options) {
        const descriptor = (0, InstrumentDescriptor_1.createInstrumentDescriptor)(name, MetricData_1.InstrumentType.COUNTER, options);
        const storage = this._meterSharedState.registerMetricStorage(descriptor);
        return new Instruments_1.CounterInstrument(storage, descriptor);
      }
      /**
       * Create a {@link UpDownCounter} instrument.
       */
      createUpDownCounter(name, options) {
        const descriptor = (0, InstrumentDescriptor_1.createInstrumentDescriptor)(name, MetricData_1.InstrumentType.UP_DOWN_COUNTER, options);
        const storage = this._meterSharedState.registerMetricStorage(descriptor);
        return new Instruments_1.UpDownCounterInstrument(storage, descriptor);
      }
      /**
       * Create a {@link ObservableGauge} instrument.
       */
      createObservableGauge(name, options) {
        const descriptor = (0, InstrumentDescriptor_1.createInstrumentDescriptor)(name, MetricData_1.InstrumentType.OBSERVABLE_GAUGE, options);
        const storages = this._meterSharedState.registerAsyncMetricStorage(descriptor);
        return new Instruments_1.ObservableGaugeInstrument(descriptor, storages, this._meterSharedState.observableRegistry);
      }
      /**
       * Create a {@link ObservableCounter} instrument.
       */
      createObservableCounter(name, options) {
        const descriptor = (0, InstrumentDescriptor_1.createInstrumentDescriptor)(name, MetricData_1.InstrumentType.OBSERVABLE_COUNTER, options);
        const storages = this._meterSharedState.registerAsyncMetricStorage(descriptor);
        return new Instruments_1.ObservableCounterInstrument(descriptor, storages, this._meterSharedState.observableRegistry);
      }
      /**
       * Create a {@link ObservableUpDownCounter} instrument.
       */
      createObservableUpDownCounter(name, options) {
        const descriptor = (0, InstrumentDescriptor_1.createInstrumentDescriptor)(name, MetricData_1.InstrumentType.OBSERVABLE_UP_DOWN_COUNTER, options);
        const storages = this._meterSharedState.registerAsyncMetricStorage(descriptor);
        return new Instruments_1.ObservableUpDownCounterInstrument(descriptor, storages, this._meterSharedState.observableRegistry);
      }
      /**
       * @see {@link Meter.addBatchObservableCallback}
       */
      addBatchObservableCallback(callback, observables) {
        this._meterSharedState.observableRegistry.addBatchCallback(callback, observables);
      }
      /**
       * @see {@link Meter.removeBatchObservableCallback}
       */
      removeBatchObservableCallback(callback, observables) {
        this._meterSharedState.observableRegistry.removeBatchCallback(callback, observables);
      }
    };
    exports.Meter = Meter;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/state/MetricStorage.js
var require_MetricStorage = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/state/MetricStorage.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MetricStorage = void 0;
    var InstrumentDescriptor_1 = require_InstrumentDescriptor();
    var MetricStorage = class {
      static {
        __name(this, "MetricStorage");
      }
      _instrumentDescriptor;
      constructor(instrumentDescriptor) {
        this._instrumentDescriptor = instrumentDescriptor;
      }
      getInstrumentDescriptor() {
        return this._instrumentDescriptor;
      }
      updateDescription(description) {
        this._instrumentDescriptor = (0, InstrumentDescriptor_1.createInstrumentDescriptor)(this._instrumentDescriptor.name, this._instrumentDescriptor.type, {
          description,
          valueType: this._instrumentDescriptor.valueType,
          unit: this._instrumentDescriptor.unit,
          advice: this._instrumentDescriptor.advice
        });
      }
    };
    exports.MetricStorage = MetricStorage;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/state/HashMap.js
var require_HashMap = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/state/HashMap.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AttributeHashMap = exports.HashMap = void 0;
    var utils_1 = require_utils4();
    var HashMap = class {
      static {
        __name(this, "HashMap");
      }
      _valueMap = /* @__PURE__ */ new Map();
      _keyMap = /* @__PURE__ */ new Map();
      _hash;
      constructor(hash) {
        this._hash = hash;
      }
      get(key, hashCode) {
        hashCode ??= this._hash(key);
        return this._valueMap.get(hashCode);
      }
      getOrDefault(key, defaultFactory) {
        const hash = this._hash(key);
        if (this._valueMap.has(hash)) {
          return this._valueMap.get(hash);
        }
        const val = defaultFactory();
        if (!this._keyMap.has(hash)) {
          this._keyMap.set(hash, key);
        }
        this._valueMap.set(hash, val);
        return val;
      }
      set(key, value, hashCode) {
        hashCode ??= this._hash(key);
        if (!this._keyMap.has(hashCode)) {
          this._keyMap.set(hashCode, key);
        }
        this._valueMap.set(hashCode, value);
      }
      has(key, hashCode) {
        hashCode ??= this._hash(key);
        return this._valueMap.has(hashCode);
      }
      *keys() {
        const keyIterator = this._keyMap.entries();
        let next = keyIterator.next();
        while (next.done !== true) {
          yield [next.value[1], next.value[0]];
          next = keyIterator.next();
        }
      }
      *entries() {
        const valueIterator = this._valueMap.entries();
        let next = valueIterator.next();
        while (next.done !== true) {
          yield [this._keyMap.get(next.value[0]), next.value[1], next.value[0]];
          next = valueIterator.next();
        }
      }
      get size() {
        return this._valueMap.size;
      }
    };
    exports.HashMap = HashMap;
    var AttributeHashMap = class extends HashMap {
      static {
        __name(this, "AttributeHashMap");
      }
      constructor() {
        super(utils_1.hashAttributes);
      }
    };
    exports.AttributeHashMap = AttributeHashMap;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/state/DeltaMetricProcessor.js
var require_DeltaMetricProcessor = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/state/DeltaMetricProcessor.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DeltaMetricProcessor = void 0;
    var core_1 = require_src();
    var utils_1 = require_utils4();
    var HashMap_1 = require_HashMap();
    var DeltaMetricProcessor = class {
      static {
        __name(this, "DeltaMetricProcessor");
      }
      _activeCollectionStorage = new HashMap_1.AttributeHashMap();
      // TODO: find a reasonable mean to clean the memo;
      // https://github.com/open-telemetry/opentelemetry-specification/pull/2208
      _cumulativeMemoStorage = new HashMap_1.AttributeHashMap();
      _cardinalityLimit;
      _overflowAttributes = { "otel.metric.overflow": true };
      _overflowHashCode;
      _aggregator;
      constructor(aggregator, aggregationCardinalityLimit) {
        this._aggregator = aggregator;
        this._cardinalityLimit = (aggregationCardinalityLimit ?? 2e3) - 1;
        this._overflowHashCode = (0, utils_1.hashAttributes)(this._overflowAttributes);
      }
      record(value, attributes, collectionTime) {
        let accumulation = this._activeCollectionStorage.get(attributes);
        if (!accumulation) {
          const hrTime = (0, core_1.millisToHrTime)(collectionTime);
          if (this._activeCollectionStorage.size >= this._cardinalityLimit) {
            const overflowAccumulation = this._activeCollectionStorage.getOrDefault(this._overflowAttributes, () => this._aggregator.createAccumulation(hrTime));
            overflowAccumulation?.record(value);
            return;
          }
          accumulation = this._aggregator.createAccumulation(hrTime);
          this._activeCollectionStorage.set(attributes, accumulation);
        }
        accumulation?.record(value);
      }
      batchCumulate(measurements, collectionTime) {
        for (const [originalAttributes, value, originalHashCode] of measurements.entries()) {
          let attributes = originalAttributes;
          let hashCode = originalHashCode;
          const accumulation = this._aggregator.createAccumulation(collectionTime);
          accumulation?.record(value);
          let delta = accumulation;
          if (this._cumulativeMemoStorage.has(attributes, hashCode)) {
            const previous = this._cumulativeMemoStorage.get(attributes, hashCode);
            delta = this._aggregator.diff(previous, accumulation);
          } else {
            if (this._cumulativeMemoStorage.size >= this._cardinalityLimit) {
              attributes = this._overflowAttributes;
              hashCode = this._overflowHashCode;
              if (this._cumulativeMemoStorage.has(attributes, hashCode)) {
                const previous = this._cumulativeMemoStorage.get(attributes, hashCode);
                delta = this._aggregator.diff(previous, accumulation);
              }
            }
          }
          if (this._activeCollectionStorage.has(attributes, hashCode)) {
            const active = this._activeCollectionStorage.get(attributes, hashCode);
            delta = this._aggregator.merge(active, delta);
          }
          this._cumulativeMemoStorage.set(attributes, accumulation, hashCode);
          this._activeCollectionStorage.set(attributes, delta, hashCode);
        }
      }
      /**
       * Returns a collection of delta metrics. Start time is the when first
       * time event collected.
       */
      collect() {
        const unreportedDelta = this._activeCollectionStorage;
        this._activeCollectionStorage = new HashMap_1.AttributeHashMap();
        return unreportedDelta;
      }
    };
    exports.DeltaMetricProcessor = DeltaMetricProcessor;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/state/TemporalMetricProcessor.js
var require_TemporalMetricProcessor = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/state/TemporalMetricProcessor.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.TemporalMetricProcessor = void 0;
    var AggregationTemporality_1 = require_AggregationTemporality();
    var HashMap_1 = require_HashMap();
    var TemporalMetricProcessor = class _TemporalMetricProcessor {
      static {
        __name(this, "TemporalMetricProcessor");
      }
      _aggregator;
      _unreportedAccumulations = /* @__PURE__ */ new Map();
      _reportHistory = /* @__PURE__ */ new Map();
      constructor(aggregator, collectorHandles) {
        this._aggregator = aggregator;
        collectorHandles.forEach((handle) => {
          this._unreportedAccumulations.set(handle, []);
        });
      }
      /**
       * Builds the {@link MetricData} streams to report against a specific MetricCollector.
       * @param collector The information of the MetricCollector.
       * @param collectors The registered collectors.
       * @param instrumentDescriptor The instrumentation descriptor that these metrics generated with.
       * @param currentAccumulations The current accumulation of metric data from instruments.
       * @param collectionTime The current collection timestamp.
       * @returns The {@link MetricData} points or `null`.
       */
      buildMetrics(collector, instrumentDescriptor, currentAccumulations, collectionTime) {
        this._stashAccumulations(currentAccumulations);
        const unreportedAccumulations = this._getMergedUnreportedAccumulations(collector);
        let result = unreportedAccumulations;
        let aggregationTemporality;
        if (this._reportHistory.has(collector)) {
          const last = this._reportHistory.get(collector);
          const lastCollectionTime = last.collectionTime;
          aggregationTemporality = last.aggregationTemporality;
          if (aggregationTemporality === AggregationTemporality_1.AggregationTemporality.CUMULATIVE) {
            result = _TemporalMetricProcessor.merge(last.accumulations, unreportedAccumulations, this._aggregator);
          } else {
            result = _TemporalMetricProcessor.calibrateStartTime(last.accumulations, unreportedAccumulations, lastCollectionTime);
          }
        } else {
          aggregationTemporality = collector.selectAggregationTemporality(instrumentDescriptor.type);
        }
        this._reportHistory.set(collector, {
          accumulations: result,
          collectionTime,
          aggregationTemporality
        });
        const accumulationRecords = AttributesMapToAccumulationRecords(result);
        if (accumulationRecords.length === 0) {
          return void 0;
        }
        return this._aggregator.toMetricData(
          instrumentDescriptor,
          aggregationTemporality,
          accumulationRecords,
          /* endTime */
          collectionTime
        );
      }
      _stashAccumulations(currentAccumulation) {
        const registeredCollectors = this._unreportedAccumulations.keys();
        for (const collector of registeredCollectors) {
          let stash = this._unreportedAccumulations.get(collector);
          if (stash === void 0) {
            stash = [];
            this._unreportedAccumulations.set(collector, stash);
          }
          stash.push(currentAccumulation);
        }
      }
      _getMergedUnreportedAccumulations(collector) {
        let result = new HashMap_1.AttributeHashMap();
        const unreportedList = this._unreportedAccumulations.get(collector);
        this._unreportedAccumulations.set(collector, []);
        if (unreportedList === void 0) {
          return result;
        }
        for (const it of unreportedList) {
          result = _TemporalMetricProcessor.merge(result, it, this._aggregator);
        }
        return result;
      }
      static merge(last, current, aggregator) {
        const result = last;
        const iterator = current.entries();
        let next = iterator.next();
        while (next.done !== true) {
          const [key, record, hash] = next.value;
          if (last.has(key, hash)) {
            const lastAccumulation = last.get(key, hash);
            const accumulation = aggregator.merge(lastAccumulation, record);
            result.set(key, accumulation, hash);
          } else {
            result.set(key, record, hash);
          }
          next = iterator.next();
        }
        return result;
      }
      /**
       * Calibrate the reported metric streams' startTime to lastCollectionTime. Leaves
       * the new stream to be the initial observation time unchanged.
       */
      static calibrateStartTime(last, current, lastCollectionTime) {
        for (const [key, hash] of last.keys()) {
          const currentAccumulation = current.get(key, hash);
          currentAccumulation?.setStartTime(lastCollectionTime);
        }
        return current;
      }
    };
    exports.TemporalMetricProcessor = TemporalMetricProcessor;
    function AttributesMapToAccumulationRecords(map) {
      return Array.from(map.entries());
    }
    __name(AttributesMapToAccumulationRecords, "AttributesMapToAccumulationRecords");
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/state/AsyncMetricStorage.js
var require_AsyncMetricStorage = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/state/AsyncMetricStorage.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AsyncMetricStorage = void 0;
    var MetricStorage_1 = require_MetricStorage();
    var DeltaMetricProcessor_1 = require_DeltaMetricProcessor();
    var TemporalMetricProcessor_1 = require_TemporalMetricProcessor();
    var HashMap_1 = require_HashMap();
    var AsyncMetricStorage = class extends MetricStorage_1.MetricStorage {
      static {
        __name(this, "AsyncMetricStorage");
      }
      _aggregationCardinalityLimit;
      _deltaMetricStorage;
      _temporalMetricStorage;
      _attributesProcessor;
      constructor(_instrumentDescriptor, aggregator, attributesProcessor, collectorHandles, aggregationCardinalityLimit) {
        super(_instrumentDescriptor);
        this._aggregationCardinalityLimit = aggregationCardinalityLimit;
        this._deltaMetricStorage = new DeltaMetricProcessor_1.DeltaMetricProcessor(aggregator, this._aggregationCardinalityLimit);
        this._temporalMetricStorage = new TemporalMetricProcessor_1.TemporalMetricProcessor(aggregator, collectorHandles);
        this._attributesProcessor = attributesProcessor;
      }
      record(measurements, observationTime) {
        if (this._attributesProcessor === void 0) {
          this._deltaMetricStorage.batchCumulate(measurements, observationTime);
          return;
        }
        const processed = new HashMap_1.AttributeHashMap();
        for (const [attributes, value] of measurements.entries()) {
          processed.set(this._attributesProcessor.process(attributes), value);
        }
        this._deltaMetricStorage.batchCumulate(processed, observationTime);
      }
      /**
       * Collects the metrics from this storage. The ObservableCallback is invoked
       * during the collection.
       *
       * Note: This is a stateful operation and may reset any interval-related
       * state for the MetricCollector.
       */
      collect(collector, collectionTime) {
        const accumulations = this._deltaMetricStorage.collect();
        return this._temporalMetricStorage.buildMetrics(collector, this._instrumentDescriptor, accumulations, collectionTime);
      }
    };
    exports.AsyncMetricStorage = AsyncMetricStorage;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/view/RegistrationConflicts.js
var require_RegistrationConflicts = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/view/RegistrationConflicts.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getConflictResolutionRecipe = exports.getDescriptionResolutionRecipe = exports.getTypeConflictResolutionRecipe = exports.getUnitConflictResolutionRecipe = exports.getValueTypeConflictResolutionRecipe = exports.getIncompatibilityDetails = void 0;
    function getIncompatibilityDetails(existing, otherDescriptor) {
      let incompatibility = "";
      if (existing.unit !== otherDescriptor.unit) {
        incompatibility += `	- Unit '${existing.unit}' does not match '${otherDescriptor.unit}'
`;
      }
      if (existing.type !== otherDescriptor.type) {
        incompatibility += `	- Type '${existing.type}' does not match '${otherDescriptor.type}'
`;
      }
      if (existing.valueType !== otherDescriptor.valueType) {
        incompatibility += `	- Value Type '${existing.valueType}' does not match '${otherDescriptor.valueType}'
`;
      }
      if (existing.description !== otherDescriptor.description) {
        incompatibility += `	- Description '${existing.description}' does not match '${otherDescriptor.description}'
`;
      }
      return incompatibility;
    }
    __name(getIncompatibilityDetails, "getIncompatibilityDetails");
    exports.getIncompatibilityDetails = getIncompatibilityDetails;
    function getValueTypeConflictResolutionRecipe(existing, otherDescriptor) {
      return `	- use valueType '${existing.valueType}' on instrument creation or use an instrument name other than '${otherDescriptor.name}'`;
    }
    __name(getValueTypeConflictResolutionRecipe, "getValueTypeConflictResolutionRecipe");
    exports.getValueTypeConflictResolutionRecipe = getValueTypeConflictResolutionRecipe;
    function getUnitConflictResolutionRecipe(existing, otherDescriptor) {
      return `	- use unit '${existing.unit}' on instrument creation or use an instrument name other than '${otherDescriptor.name}'`;
    }
    __name(getUnitConflictResolutionRecipe, "getUnitConflictResolutionRecipe");
    exports.getUnitConflictResolutionRecipe = getUnitConflictResolutionRecipe;
    function getTypeConflictResolutionRecipe(existing, otherDescriptor) {
      const selector = {
        name: otherDescriptor.name,
        type: otherDescriptor.type,
        unit: otherDescriptor.unit
      };
      const selectorString = JSON.stringify(selector);
      return `	- create a new view with a name other than '${existing.name}' and InstrumentSelector '${selectorString}'`;
    }
    __name(getTypeConflictResolutionRecipe, "getTypeConflictResolutionRecipe");
    exports.getTypeConflictResolutionRecipe = getTypeConflictResolutionRecipe;
    function getDescriptionResolutionRecipe(existing, otherDescriptor) {
      const selector = {
        name: otherDescriptor.name,
        type: otherDescriptor.type,
        unit: otherDescriptor.unit
      };
      const selectorString = JSON.stringify(selector);
      return `	- create a new view with a name other than '${existing.name}' and InstrumentSelector '${selectorString}'
    	- OR - create a new view with the name ${existing.name} and description '${existing.description}' and InstrumentSelector ${selectorString}
    	- OR - create a new view with the name ${otherDescriptor.name} and description '${existing.description}' and InstrumentSelector ${selectorString}`;
    }
    __name(getDescriptionResolutionRecipe, "getDescriptionResolutionRecipe");
    exports.getDescriptionResolutionRecipe = getDescriptionResolutionRecipe;
    function getConflictResolutionRecipe(existing, otherDescriptor) {
      if (existing.valueType !== otherDescriptor.valueType) {
        return getValueTypeConflictResolutionRecipe(existing, otherDescriptor);
      }
      if (existing.unit !== otherDescriptor.unit) {
        return getUnitConflictResolutionRecipe(existing, otherDescriptor);
      }
      if (existing.type !== otherDescriptor.type) {
        return getTypeConflictResolutionRecipe(existing, otherDescriptor);
      }
      if (existing.description !== otherDescriptor.description) {
        return getDescriptionResolutionRecipe(existing, otherDescriptor);
      }
      return "";
    }
    __name(getConflictResolutionRecipe, "getConflictResolutionRecipe");
    exports.getConflictResolutionRecipe = getConflictResolutionRecipe;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/state/MetricStorageRegistry.js
var require_MetricStorageRegistry = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/state/MetricStorageRegistry.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MetricStorageRegistry = void 0;
    var InstrumentDescriptor_1 = require_InstrumentDescriptor();
    var api = (init_esm(), __toCommonJS(esm_exports));
    var RegistrationConflicts_1 = require_RegistrationConflicts();
    var MetricStorageRegistry = class _MetricStorageRegistry {
      static {
        __name(this, "MetricStorageRegistry");
      }
      _sharedRegistry = /* @__PURE__ */ new Map();
      _perCollectorRegistry = /* @__PURE__ */ new Map();
      static create() {
        return new _MetricStorageRegistry();
      }
      getStorages(collector) {
        let storages = [];
        for (const metricStorages of this._sharedRegistry.values()) {
          storages = storages.concat(metricStorages);
        }
        const perCollectorStorages = this._perCollectorRegistry.get(collector);
        if (perCollectorStorages != null) {
          for (const metricStorages of perCollectorStorages.values()) {
            storages = storages.concat(metricStorages);
          }
        }
        return storages;
      }
      register(storage) {
        this._registerStorage(storage, this._sharedRegistry);
      }
      registerForCollector(collector, storage) {
        let storageMap = this._perCollectorRegistry.get(collector);
        if (storageMap == null) {
          storageMap = /* @__PURE__ */ new Map();
          this._perCollectorRegistry.set(collector, storageMap);
        }
        this._registerStorage(storage, storageMap);
      }
      findOrUpdateCompatibleStorage(expectedDescriptor) {
        const storages = this._sharedRegistry.get(expectedDescriptor.name);
        if (storages === void 0) {
          return null;
        }
        return this._findOrUpdateCompatibleStorage(expectedDescriptor, storages);
      }
      findOrUpdateCompatibleCollectorStorage(collector, expectedDescriptor) {
        const storageMap = this._perCollectorRegistry.get(collector);
        if (storageMap === void 0) {
          return null;
        }
        const storages = storageMap.get(expectedDescriptor.name);
        if (storages === void 0) {
          return null;
        }
        return this._findOrUpdateCompatibleStorage(expectedDescriptor, storages);
      }
      _registerStorage(storage, storageMap) {
        const descriptor = storage.getInstrumentDescriptor();
        const storages = storageMap.get(descriptor.name);
        if (storages === void 0) {
          storageMap.set(descriptor.name, [storage]);
          return;
        }
        storages.push(storage);
      }
      _findOrUpdateCompatibleStorage(expectedDescriptor, existingStorages) {
        let compatibleStorage = null;
        for (const existingStorage of existingStorages) {
          const existingDescriptor = existingStorage.getInstrumentDescriptor();
          if ((0, InstrumentDescriptor_1.isDescriptorCompatibleWith)(existingDescriptor, expectedDescriptor)) {
            if (existingDescriptor.description !== expectedDescriptor.description) {
              if (expectedDescriptor.description.length > existingDescriptor.description.length) {
                existingStorage.updateDescription(expectedDescriptor.description);
              }
              api.diag.warn("A view or instrument with the name ", expectedDescriptor.name, " has already been registered, but has a different description and is incompatible with another registered view.\n", "Details:\n", (0, RegistrationConflicts_1.getIncompatibilityDetails)(existingDescriptor, expectedDescriptor), "The longer description will be used.\nTo resolve the conflict:", (0, RegistrationConflicts_1.getConflictResolutionRecipe)(existingDescriptor, expectedDescriptor));
            }
            compatibleStorage = existingStorage;
          } else {
            api.diag.warn("A view or instrument with the name ", expectedDescriptor.name, " has already been registered and is incompatible with another registered view.\n", "Details:\n", (0, RegistrationConflicts_1.getIncompatibilityDetails)(existingDescriptor, expectedDescriptor), "To resolve the conflict:\n", (0, RegistrationConflicts_1.getConflictResolutionRecipe)(existingDescriptor, expectedDescriptor));
          }
        }
        return compatibleStorage;
      }
    };
    exports.MetricStorageRegistry = MetricStorageRegistry;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/state/MultiWritableMetricStorage.js
var require_MultiWritableMetricStorage = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/state/MultiWritableMetricStorage.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MultiMetricStorage = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var MultiMetricStorage = class {
      static {
        __name(this, "MultiMetricStorage");
      }
      _backingStorages;
      hasAttributeProcessor;
      constructor(backingStorages) {
        this._backingStorages = backingStorages;
        this.hasAttributeProcessor = backingStorages.some((s) => s.hasAttributeProcessor);
      }
      record(value, attributes, context, recordTime) {
        if (this.hasAttributeProcessor && context === void 0) {
          context = api_1.context.active();
        }
        const storages = this._backingStorages;
        for (let i = 0; i < storages.length; i++) {
          storages[i].record(value, attributes, context, recordTime);
        }
      }
    };
    exports.MultiMetricStorage = MultiMetricStorage;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/ObservableResult.js
var require_ObservableResult = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/ObservableResult.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BatchObservableResultImpl = exports.ObservableResultImpl = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var HashMap_1 = require_HashMap();
    var Instruments_1 = require_Instruments();
    var ObservableResultImpl = class {
      static {
        __name(this, "ObservableResultImpl");
      }
      /**
       * @internal
       */
      _buffer = new HashMap_1.AttributeHashMap();
      _instrumentName;
      _valueType;
      constructor(instrumentName, valueType) {
        this._instrumentName = instrumentName;
        this._valueType = valueType;
      }
      /**
       * Observe a measurement of the value associated with the given attributes.
       */
      observe(value, attributes = {}) {
        if (typeof value !== "number") {
          api_1.diag.warn(`non-number value provided to metric ${this._instrumentName}: ${value}`);
          return;
        }
        if (this._valueType === api_1.ValueType.INT && !Number.isInteger(value)) {
          api_1.diag.warn(`INT value type cannot accept a floating-point value for ${this._instrumentName}, ignoring the fractional digits.`);
          value = Math.trunc(value);
          if (!Number.isInteger(value)) {
            return;
          }
        }
        this._buffer.set(attributes, value);
      }
    };
    exports.ObservableResultImpl = ObservableResultImpl;
    var BatchObservableResultImpl = class {
      static {
        __name(this, "BatchObservableResultImpl");
      }
      /**
       * @internal
       */
      _buffer = /* @__PURE__ */ new Map();
      /**
       * Observe a measurement of the value associated with the given attributes.
       */
      observe(metric, value, attributes = {}) {
        if (!(0, Instruments_1.isObservableInstrument)(metric)) {
          return;
        }
        let map = this._buffer.get(metric);
        if (map == null) {
          map = new HashMap_1.AttributeHashMap();
          this._buffer.set(metric, map);
        }
        if (typeof value !== "number") {
          api_1.diag.warn(`non-number value provided to metric ${metric._descriptor.name}: ${value}`);
          return;
        }
        if (metric._descriptor.valueType === api_1.ValueType.INT && !Number.isInteger(value)) {
          api_1.diag.warn(`INT value type cannot accept a floating-point value for ${metric._descriptor.name}, ignoring the fractional digits.`);
          value = Math.trunc(value);
          if (!Number.isInteger(value)) {
            return;
          }
        }
        map.set(attributes, value);
      }
    };
    exports.BatchObservableResultImpl = BatchObservableResultImpl;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/state/ObservableRegistry.js
var require_ObservableRegistry = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/state/ObservableRegistry.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ObservableRegistry = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var Instruments_1 = require_Instruments();
    var ObservableResult_1 = require_ObservableResult();
    var utils_1 = require_utils4();
    var ObservableRegistry = class {
      static {
        __name(this, "ObservableRegistry");
      }
      _callbacks = [];
      _batchCallbacks = [];
      addCallback(callback, instrument) {
        const idx = this._findCallback(callback, instrument);
        if (idx >= 0) {
          return;
        }
        this._callbacks.push({ callback, instrument });
      }
      removeCallback(callback, instrument) {
        const idx = this._findCallback(callback, instrument);
        if (idx < 0) {
          return;
        }
        this._callbacks.splice(idx, 1);
      }
      addBatchCallback(callback, instruments) {
        const observableInstruments = new Set(instruments.filter(Instruments_1.isObservableInstrument));
        if (observableInstruments.size === 0) {
          api_1.diag.error("BatchObservableCallback is not associated with valid instruments", instruments);
          return;
        }
        const idx = this._findBatchCallback(callback, observableInstruments);
        if (idx >= 0) {
          return;
        }
        this._batchCallbacks.push({ callback, instruments: observableInstruments });
      }
      removeBatchCallback(callback, instruments) {
        const observableInstruments = new Set(instruments.filter(Instruments_1.isObservableInstrument));
        const idx = this._findBatchCallback(callback, observableInstruments);
        if (idx < 0) {
          return;
        }
        this._batchCallbacks.splice(idx, 1);
      }
      /**
       * @returns a promise of rejected reasons for invoking callbacks.
       */
      async observe(collectionTime, timeoutMillis) {
        const callbackFutures = this._observeCallbacks(collectionTime, timeoutMillis);
        const batchCallbackFutures = this._observeBatchCallbacks(collectionTime, timeoutMillis);
        const results = await Promise.allSettled([
          ...callbackFutures,
          ...batchCallbackFutures
        ]);
        const rejections = results.filter((result) => result.status === "rejected").map((result) => result.reason);
        return rejections;
      }
      _observeCallbacks(observationTime, timeoutMillis) {
        return this._callbacks.map(async ({ callback, instrument }) => {
          const observableResult = new ObservableResult_1.ObservableResultImpl(instrument._descriptor.name, instrument._descriptor.valueType);
          let callPromise = Promise.resolve(callback(observableResult));
          if (timeoutMillis != null) {
            callPromise = (0, utils_1.callWithTimeout)(callPromise, timeoutMillis);
          }
          await callPromise;
          instrument._metricStorages.forEach((metricStorage) => {
            metricStorage.record(observableResult._buffer, observationTime);
          });
        });
      }
      _observeBatchCallbacks(observationTime, timeoutMillis) {
        return this._batchCallbacks.map(async ({ callback, instruments }) => {
          const observableResult = new ObservableResult_1.BatchObservableResultImpl();
          let callPromise = Promise.resolve(callback(observableResult));
          if (timeoutMillis != null) {
            callPromise = (0, utils_1.callWithTimeout)(callPromise, timeoutMillis);
          }
          await callPromise;
          instruments.forEach((instrument) => {
            const buffer = observableResult._buffer.get(instrument);
            if (buffer == null) {
              return;
            }
            instrument._metricStorages.forEach((metricStorage) => {
              metricStorage.record(buffer, observationTime);
            });
          });
        });
      }
      _findCallback(callback, instrument) {
        return this._callbacks.findIndex((record) => {
          return record.callback === callback && record.instrument === instrument;
        });
      }
      _findBatchCallback(callback, instruments) {
        return this._batchCallbacks.findIndex((record) => {
          return record.callback === callback && (0, utils_1.setEquals)(record.instruments, instruments);
        });
      }
    };
    exports.ObservableRegistry = ObservableRegistry;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/state/SyncMetricStorage.js
var require_SyncMetricStorage = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/state/SyncMetricStorage.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SyncMetricStorage = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var MetricStorage_1 = require_MetricStorage();
    var DeltaMetricProcessor_1 = require_DeltaMetricProcessor();
    var TemporalMetricProcessor_1 = require_TemporalMetricProcessor();
    var SyncMetricStorage = class extends MetricStorage_1.MetricStorage {
      static {
        __name(this, "SyncMetricStorage");
      }
      _aggregationCardinalityLimit;
      _deltaMetricStorage;
      _temporalMetricStorage;
      _attributesProcessor;
      constructor(instrumentDescriptor, aggregator, attributesProcessor, collectorHandles, aggregationCardinalityLimit) {
        super(instrumentDescriptor);
        this._aggregationCardinalityLimit = aggregationCardinalityLimit;
        this._deltaMetricStorage = new DeltaMetricProcessor_1.DeltaMetricProcessor(aggregator, this._aggregationCardinalityLimit);
        this._temporalMetricStorage = new TemporalMetricProcessor_1.TemporalMetricProcessor(aggregator, collectorHandles);
        this._attributesProcessor = attributesProcessor;
        this.hasAttributeProcessor = attributesProcessor !== void 0;
      }
      hasAttributeProcessor;
      record(value, attributes, context, recordTime) {
        if (this._attributesProcessor !== void 0) {
          attributes = this._attributesProcessor.process(attributes, context ?? api_1.context.active());
        }
        this._deltaMetricStorage.record(value, attributes, recordTime);
      }
      /**
       * Collects the metrics from this storage.
       *
       * Note: This is a stateful operation and may reset any interval-related
       * state for the MetricCollector.
       */
      collect(collector, collectionTime) {
        const accumulations = this._deltaMetricStorage.collect();
        return this._temporalMetricStorage.buildMetrics(collector, this._instrumentDescriptor, accumulations, collectionTime);
      }
    };
    exports.SyncMetricStorage = SyncMetricStorage;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/state/MeterSharedState.js
var require_MeterSharedState = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/state/MeterSharedState.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MeterSharedState = void 0;
    var InstrumentDescriptor_1 = require_InstrumentDescriptor();
    var Meter_1 = require_Meter();
    var AsyncMetricStorage_1 = require_AsyncMetricStorage();
    var MetricStorageRegistry_1 = require_MetricStorageRegistry();
    var MultiWritableMetricStorage_1 = require_MultiWritableMetricStorage();
    var ObservableRegistry_1 = require_ObservableRegistry();
    var SyncMetricStorage_1 = require_SyncMetricStorage();
    var MeterSharedState = class {
      static {
        __name(this, "MeterSharedState");
      }
      metricStorageRegistry = new MetricStorageRegistry_1.MetricStorageRegistry();
      observableRegistry = new ObservableRegistry_1.ObservableRegistry();
      meter;
      _meterProviderSharedState;
      _instrumentationScope;
      constructor(meterProviderSharedState, instrumentationScope) {
        this.meter = new Meter_1.Meter(this);
        this._meterProviderSharedState = meterProviderSharedState;
        this._instrumentationScope = instrumentationScope;
      }
      registerMetricStorage(descriptor) {
        const storages = this._registerMetricStorage(descriptor, SyncMetricStorage_1.SyncMetricStorage);
        if (storages.length === 1) {
          return storages[0];
        }
        return new MultiWritableMetricStorage_1.MultiMetricStorage(storages);
      }
      registerAsyncMetricStorage(descriptor) {
        const storages = this._registerMetricStorage(descriptor, AsyncMetricStorage_1.AsyncMetricStorage);
        return storages;
      }
      /**
       * @param collector opaque handle of {@link MetricCollector} which initiated the collection.
       * @param collectionTime the HrTime at which the collection was initiated.
       * @param options options for collection.
       * @returns the list of metric data collected.
       */
      async collect(collector, collectionTime, options) {
        const errors = await this.observableRegistry.observe(collectionTime, options?.timeoutMillis);
        const storages = this.metricStorageRegistry.getStorages(collector);
        if (storages.length === 0) {
          return null;
        }
        const metricDataList = [];
        storages.forEach((metricStorage) => {
          const metricData = metricStorage.collect(collector, collectionTime);
          if (metricData != null) {
            metricDataList.push(metricData);
          }
        });
        if (metricDataList.length === 0) {
          return { errors };
        }
        return {
          scopeMetrics: {
            scope: this._instrumentationScope,
            metrics: metricDataList
          },
          errors
        };
      }
      _registerMetricStorage(descriptor, MetricStorageType) {
        const views = this._meterProviderSharedState.viewRegistry.findViews(descriptor, this._instrumentationScope);
        let storages = views.map((view) => {
          const viewDescriptor = (0, InstrumentDescriptor_1.createInstrumentDescriptorWithView)(view, descriptor);
          const compatibleStorage = this.metricStorageRegistry.findOrUpdateCompatibleStorage(viewDescriptor);
          if (compatibleStorage != null) {
            return compatibleStorage;
          }
          const aggregator = view.aggregation.createAggregator(viewDescriptor);
          const viewStorage = new MetricStorageType(viewDescriptor, aggregator, view.attributesProcessor, this._meterProviderSharedState.metricCollectors, view.aggregationCardinalityLimit);
          this.metricStorageRegistry.register(viewStorage);
          return viewStorage;
        });
        if (storages.length === 0) {
          const perCollectorAggregations = this._meterProviderSharedState.selectAggregations(descriptor.type);
          const collectorStorages = perCollectorAggregations.map(([collector, aggregation]) => {
            const compatibleStorage = this.metricStorageRegistry.findOrUpdateCompatibleCollectorStorage(collector, descriptor);
            if (compatibleStorage != null) {
              return compatibleStorage;
            }
            const aggregator = aggregation.createAggregator(descriptor);
            const cardinalityLimit = collector.selectCardinalityLimit(descriptor.type);
            const storage = new MetricStorageType(descriptor, aggregator, void 0, [collector], cardinalityLimit);
            this.metricStorageRegistry.registerForCollector(collector, storage);
            return storage;
          });
          storages = storages.concat(collectorStorages);
        }
        return storages;
      }
    };
    exports.MeterSharedState = MeterSharedState;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/state/MeterProviderSharedState.js
var require_MeterProviderSharedState = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/state/MeterProviderSharedState.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MeterProviderSharedState = void 0;
    var utils_1 = require_utils4();
    var ViewRegistry_1 = require_ViewRegistry();
    var MeterSharedState_1 = require_MeterSharedState();
    var AggregationOption_1 = require_AggregationOption();
    var MeterProviderSharedState = class {
      static {
        __name(this, "MeterProviderSharedState");
      }
      viewRegistry = new ViewRegistry_1.ViewRegistry();
      metricCollectors = [];
      meterSharedStates = /* @__PURE__ */ new Map();
      resource;
      constructor(resource) {
        this.resource = resource;
      }
      getMeterSharedState(instrumentationScope) {
        const id = (0, utils_1.instrumentationScopeId)(instrumentationScope);
        let meterSharedState = this.meterSharedStates.get(id);
        if (meterSharedState == null) {
          meterSharedState = new MeterSharedState_1.MeterSharedState(this, instrumentationScope);
          this.meterSharedStates.set(id, meterSharedState);
        }
        return meterSharedState;
      }
      selectAggregations(instrumentType) {
        const result = [];
        for (const collector of this.metricCollectors) {
          result.push([
            collector,
            (0, AggregationOption_1.toAggregation)(collector.selectAggregation(instrumentType))
          ]);
        }
        return result;
      }
    };
    exports.MeterProviderSharedState = MeterProviderSharedState;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/state/MetricCollector.js
var require_MetricCollector = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/state/MetricCollector.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MetricCollector = void 0;
    var core_1 = require_src();
    var MetricCollector = class {
      static {
        __name(this, "MetricCollector");
      }
      _sharedState;
      _metricReader;
      constructor(sharedState, metricReader) {
        this._sharedState = sharedState;
        this._metricReader = metricReader;
      }
      async collect(options) {
        const collectionTime = (0, core_1.millisToHrTime)(Date.now());
        const scopeMetrics = [];
        const errors = [];
        const meterCollectionPromises = Array.from(this._sharedState.meterSharedStates.values()).map(async (meterSharedState) => {
          const current = await meterSharedState.collect(this, collectionTime, options);
          if (current?.scopeMetrics != null) {
            scopeMetrics.push(current.scopeMetrics);
          }
          if (current?.errors != null) {
            errors.push(...current.errors);
          }
        });
        await Promise.all(meterCollectionPromises);
        return {
          resourceMetrics: {
            resource: this._sharedState.resource,
            scopeMetrics
          },
          errors
        };
      }
      /**
       * Delegates for MetricReader.forceFlush.
       */
      async forceFlush(options) {
        await this._metricReader.forceFlush(options);
      }
      /**
       * Delegates for MetricReader.shutdown.
       */
      async shutdown(options) {
        await this._metricReader.shutdown(options);
      }
      selectAggregationTemporality(instrumentType) {
        return this._metricReader.selectAggregationTemporality(instrumentType);
      }
      selectAggregation(instrumentType) {
        return this._metricReader.selectAggregation(instrumentType);
      }
      /**
       * Select the cardinality limit for the given {@link InstrumentType} for this
       * collector.
       */
      selectCardinalityLimit(instrumentType) {
        return this._metricReader.selectCardinalityLimit?.(instrumentType) ?? 2e3;
      }
    };
    exports.MetricCollector = MetricCollector;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/view/Predicate.js
var require_Predicate = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/view/Predicate.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ExactPredicate = exports.PatternPredicate = void 0;
    var ESCAPE = /[\^$\\.+?()[\]{}|]/g;
    var PatternPredicate = class _PatternPredicate {
      static {
        __name(this, "PatternPredicate");
      }
      _matchAll;
      _regexp;
      constructor(pattern) {
        if (pattern === "*") {
          this._matchAll = true;
          this._regexp = /.*/;
        } else {
          this._matchAll = false;
          this._regexp = new RegExp(_PatternPredicate.escapePattern(pattern));
        }
      }
      match(str) {
        if (this._matchAll) {
          return true;
        }
        return this._regexp.test(str);
      }
      static escapePattern(pattern) {
        return `^${pattern.replace(ESCAPE, "\\$&").replace("*", ".*")}$`;
      }
      static hasWildcard(pattern) {
        return pattern.includes("*");
      }
    };
    exports.PatternPredicate = PatternPredicate;
    var ExactPredicate = class {
      static {
        __name(this, "ExactPredicate");
      }
      _matchAll;
      _pattern;
      constructor(pattern) {
        this._matchAll = pattern === void 0;
        this._pattern = pattern;
      }
      match(str) {
        if (this._matchAll) {
          return true;
        }
        if (str === this._pattern) {
          return true;
        }
        return false;
      }
    };
    exports.ExactPredicate = ExactPredicate;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/view/AttributesProcessor.js
var require_AttributesProcessor = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/view/AttributesProcessor.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.createDenyListAttributesProcessor = exports.createAllowListAttributesProcessor = exports.createMultiAttributesProcessor = exports.createNoopAttributesProcessor = void 0;
    var NoopAttributesProcessor = class {
      static {
        __name(this, "NoopAttributesProcessor");
      }
      process(incoming, _context) {
        return incoming;
      }
    };
    var MultiAttributesProcessor = class {
      static {
        __name(this, "MultiAttributesProcessor");
      }
      _processors;
      constructor(processors) {
        this._processors = processors;
      }
      process(incoming, context) {
        let filteredAttributes = incoming;
        for (const processor of this._processors) {
          filteredAttributes = processor.process(filteredAttributes, context);
        }
        return filteredAttributes;
      }
    };
    var AllowListProcessor = class {
      static {
        __name(this, "AllowListProcessor");
      }
      _allowedAttributeNames;
      constructor(allowedAttributeNames) {
        this._allowedAttributeNames = new Set(allowedAttributeNames);
      }
      process(incoming, _context) {
        const filteredAttributes = {};
        for (const attributeName in incoming) {
          if (Object.prototype.hasOwnProperty.call(incoming, attributeName) && this._allowedAttributeNames.has(attributeName)) {
            filteredAttributes[attributeName] = incoming[attributeName];
          }
        }
        return filteredAttributes;
      }
    };
    var DenyListProcessor = class {
      static {
        __name(this, "DenyListProcessor");
      }
      _deniedAttributeNames;
      constructor(deniedAttributeNames) {
        this._deniedAttributeNames = new Set(deniedAttributeNames);
      }
      process(incoming, _context) {
        const filteredAttributes = {};
        for (const attributeName in incoming) {
          if (Object.prototype.hasOwnProperty.call(incoming, attributeName) && !this._deniedAttributeNames.has(attributeName)) {
            filteredAttributes[attributeName] = incoming[attributeName];
          }
        }
        return filteredAttributes;
      }
    };
    function createNoopAttributesProcessor() {
      return NOOP;
    }
    __name(createNoopAttributesProcessor, "createNoopAttributesProcessor");
    exports.createNoopAttributesProcessor = createNoopAttributesProcessor;
    function createMultiAttributesProcessor(processors) {
      return new MultiAttributesProcessor(processors);
    }
    __name(createMultiAttributesProcessor, "createMultiAttributesProcessor");
    exports.createMultiAttributesProcessor = createMultiAttributesProcessor;
    function createAllowListAttributesProcessor(attributeAllowList) {
      return new AllowListProcessor(attributeAllowList);
    }
    __name(createAllowListAttributesProcessor, "createAllowListAttributesProcessor");
    exports.createAllowListAttributesProcessor = createAllowListAttributesProcessor;
    function createDenyListAttributesProcessor(attributeDenyList) {
      return new DenyListProcessor(attributeDenyList);
    }
    __name(createDenyListAttributesProcessor, "createDenyListAttributesProcessor");
    exports.createDenyListAttributesProcessor = createDenyListAttributesProcessor;
    var NOOP = new NoopAttributesProcessor();
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/view/InstrumentSelector.js
var require_InstrumentSelector = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/view/InstrumentSelector.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.InstrumentSelector = void 0;
    var Predicate_1 = require_Predicate();
    var InstrumentSelector = class {
      static {
        __name(this, "InstrumentSelector");
      }
      _nameFilter;
      _type;
      _unitFilter;
      constructor(criteria) {
        this._nameFilter = new Predicate_1.PatternPredicate(criteria?.name ?? "*");
        this._type = criteria?.type;
        this._unitFilter = new Predicate_1.ExactPredicate(criteria?.unit);
      }
      getType() {
        return this._type;
      }
      getNameFilter() {
        return this._nameFilter;
      }
      getUnitFilter() {
        return this._unitFilter;
      }
    };
    exports.InstrumentSelector = InstrumentSelector;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/view/MeterSelector.js
var require_MeterSelector = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/view/MeterSelector.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MeterSelector = void 0;
    var Predicate_1 = require_Predicate();
    var MeterSelector = class {
      static {
        __name(this, "MeterSelector");
      }
      _nameFilter;
      _versionFilter;
      _schemaUrlFilter;
      constructor(criteria) {
        this._nameFilter = new Predicate_1.ExactPredicate(criteria?.name);
        this._versionFilter = new Predicate_1.ExactPredicate(criteria?.version);
        this._schemaUrlFilter = new Predicate_1.ExactPredicate(criteria?.schemaUrl);
      }
      getNameFilter() {
        return this._nameFilter;
      }
      /**
       * TODO: semver filter? no spec yet.
       */
      getVersionFilter() {
        return this._versionFilter;
      }
      getSchemaUrlFilter() {
        return this._schemaUrlFilter;
      }
    };
    exports.MeterSelector = MeterSelector;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/view/View.js
var require_View = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/view/View.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.View = void 0;
    var Predicate_1 = require_Predicate();
    var AttributesProcessor_1 = require_AttributesProcessor();
    var InstrumentSelector_1 = require_InstrumentSelector();
    var MeterSelector_1 = require_MeterSelector();
    var AggregationOption_1 = require_AggregationOption();
    function isSelectorNotProvided(options) {
      return options.instrumentName == null && options.instrumentType == null && options.instrumentUnit == null && options.meterName == null && options.meterVersion == null && options.meterSchemaUrl == null;
    }
    __name(isSelectorNotProvided, "isSelectorNotProvided");
    function validateViewOptions(viewOptions) {
      if (isSelectorNotProvided(viewOptions)) {
        throw new Error("Cannot create view with no selector arguments supplied");
      }
      if (viewOptions.name != null && (viewOptions?.instrumentName == null || Predicate_1.PatternPredicate.hasWildcard(viewOptions.instrumentName))) {
        throw new Error("Views with a specified name must be declared with an instrument selector that selects at most one instrument per meter.");
      }
    }
    __name(validateViewOptions, "validateViewOptions");
    var View = class {
      static {
        __name(this, "View");
      }
      name;
      description;
      aggregation;
      attributesProcessor;
      instrumentSelector;
      meterSelector;
      aggregationCardinalityLimit;
      /**
       * Create a new {@link View} instance.
       *
       * Parameters can be categorized as two types:
       *  Instrument selection criteria: Used to describe the instrument(s) this view will be applied to.
       *  Will be treated as additive (the Instrument has to meet all the provided criteria to be selected).
       *
       *  Metric stream altering: Alter the metric stream of instruments selected by instrument selection criteria.
       *
       * @param viewOptions {@link ViewOptions} for altering the metric stream and instrument selection.
       * @param viewOptions.name
       * Alters the metric stream:
       *  This will be used as the name of the metrics stream.
       *  If not provided, the original Instrument name will be used.
       * @param viewOptions.description
       * Alters the metric stream:
       *  This will be used as the description of the metrics stream.
       *  If not provided, the original Instrument description will be used by default.
       * @param viewOptions.attributesProcessors
       * Alters the metric stream:
       *  If provided, the attributes will be modified as defined by the added processors.
       *  If not provided, all attribute keys will be used by default.
       * @param viewOptions.aggregationCardinalityLimit
       * Alters the metric stream:
       *  Sets a limit on the number of unique attribute combinations (cardinality) that can be aggregated.
       *  If not provided, the default limit of 2000 will be used.
       * @param viewOptions.aggregation
       * Alters the metric stream:
       *  Alters the {@link Aggregation} of the metric stream.
       * @param viewOptions.instrumentName
       * Instrument selection criteria:
       *  Original name of the Instrument(s) with wildcard support.
       * @param viewOptions.instrumentType
       * Instrument selection criteria:
       *  The original type of the Instrument(s).
       * @param viewOptions.instrumentUnit
       * Instrument selection criteria:
       *  The unit of the Instrument(s).
       * @param viewOptions.meterName
       * Instrument selection criteria:
       *  The name of the Meter. No wildcard support, name must match the meter exactly.
       * @param viewOptions.meterVersion
       * Instrument selection criteria:
       *  The version of the Meter. No wildcard support, version must match exactly.
       * @param viewOptions.meterSchemaUrl
       * Instrument selection criteria:
       *  The schema URL of the Meter. No wildcard support, schema URL must match exactly.
       *
       * @example
       * // Create a view that changes the Instrument 'my.instrument' to use to an
       * // ExplicitBucketHistogramAggregation with the boundaries [20, 30, 40]
       * new View({
       *   aggregation: new ExplicitBucketHistogramAggregation([20, 30, 40]),
       *   instrumentName: 'my.instrument'
       * })
       */
      constructor(viewOptions) {
        validateViewOptions(viewOptions);
        if (viewOptions.attributesProcessors != null) {
          this.attributesProcessor = (0, AttributesProcessor_1.createMultiAttributesProcessor)(viewOptions.attributesProcessors);
        } else {
          this.attributesProcessor = (0, AttributesProcessor_1.createNoopAttributesProcessor)();
        }
        this.name = viewOptions.name;
        this.description = viewOptions.description;
        this.aggregation = (0, AggregationOption_1.toAggregation)(viewOptions.aggregation ?? { type: AggregationOption_1.AggregationType.DEFAULT });
        this.instrumentSelector = new InstrumentSelector_1.InstrumentSelector({
          name: viewOptions.instrumentName,
          type: viewOptions.instrumentType,
          unit: viewOptions.instrumentUnit
        });
        this.meterSelector = new MeterSelector_1.MeterSelector({
          name: viewOptions.meterName,
          version: viewOptions.meterVersion,
          schemaUrl: viewOptions.meterSchemaUrl
        });
        this.aggregationCardinalityLimit = viewOptions.aggregationCardinalityLimit;
      }
    };
    exports.View = View;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/MeterProvider.js
var require_MeterProvider = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/MeterProvider.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MeterProvider = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var resources_1 = require_src2();
    var MetricReader_1 = require_MetricReader();
    var MeterProviderSharedState_1 = require_MeterProviderSharedState();
    var MetricCollector_1 = require_MetricCollector();
    var View_1 = require_View();
    var MeterProvider = class {
      static {
        __name(this, "MeterProvider");
      }
      _sharedState;
      _shutdown = false;
      constructor(options) {
        this._sharedState = new MeterProviderSharedState_1.MeterProviderSharedState(options?.resource ?? (0, resources_1.defaultResource)());
        if (options?.views != null && options.views.length > 0) {
          for (const viewOption of options.views) {
            this._sharedState.viewRegistry.addView(new View_1.View(viewOption));
          }
        }
        if (options?.readers != null && options.readers.length > 0) {
          for (const metricReader of options.readers) {
            const collector = new MetricCollector_1.MetricCollector(this._sharedState, metricReader);
            metricReader.setMetricProducer(collector);
            this._sharedState.metricCollectors.push(collector);
            if (options.sdkMetricsEnabled && metricReader instanceof MetricReader_1.MetricReader) {
              metricReader._setSelfObsMeterProvider(this);
            }
          }
        }
      }
      /**
       * Get a meter with the configuration of the MeterProvider.
       */
      getMeter(name, version = "", options = {}) {
        if (this._shutdown) {
          api_1.diag.warn("A shutdown MeterProvider cannot provide a Meter");
          return (0, api_1.createNoopMeter)();
        }
        return this._sharedState.getMeterSharedState({
          name,
          version,
          schemaUrl: options.schemaUrl
        }).meter;
      }
      /**
       * Shut down the MeterProvider and all registered
       * MetricReaders.
       *
       * Returns a promise which is resolved when all flushes are complete.
       */
      async shutdown(options) {
        if (this._shutdown) {
          api_1.diag.warn("shutdown may only be called once per MeterProvider");
          return;
        }
        this._shutdown = true;
        await Promise.all(this._sharedState.metricCollectors.map((collector) => {
          return collector.shutdown(options);
        }));
      }
      /**
       * Notifies all registered MetricReaders to flush any buffered data.
       *
       * Returns a promise which is resolved when all flushes are complete.
       */
      async forceFlush(options) {
        if (this._shutdown) {
          api_1.diag.warn("invalid attempt to force flush after MeterProvider shutdown");
          return;
        }
        await Promise.all(this._sharedState.metricCollectors.map((collector) => {
          return collector.forceFlush(options);
        }));
      }
    };
    exports.MeterProvider = MeterProvider;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/index.js
var require_src3 = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-metrics/build/src/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.TimeoutError = exports.createDenyListAttributesProcessor = exports.createAllowListAttributesProcessor = exports.AggregationType = exports.MeterProvider = exports.ConsoleMetricExporter = exports.InMemoryMetricExporter = exports.PeriodicExportingMetricReader = exports.MetricReader = exports.InstrumentType = exports.DataPointType = exports.AggregationTemporality = void 0;
    var AggregationTemporality_1 = require_AggregationTemporality();
    Object.defineProperty(exports, "AggregationTemporality", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return AggregationTemporality_1.AggregationTemporality;
    }, "get") });
    var MetricData_1 = require_MetricData();
    Object.defineProperty(exports, "DataPointType", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return MetricData_1.DataPointType;
    }, "get") });
    Object.defineProperty(exports, "InstrumentType", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return MetricData_1.InstrumentType;
    }, "get") });
    var MetricReader_1 = require_MetricReader();
    Object.defineProperty(exports, "MetricReader", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return MetricReader_1.MetricReader;
    }, "get") });
    var PeriodicExportingMetricReader_1 = require_PeriodicExportingMetricReader();
    Object.defineProperty(exports, "PeriodicExportingMetricReader", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return PeriodicExportingMetricReader_1.PeriodicExportingMetricReader;
    }, "get") });
    var InMemoryMetricExporter_1 = require_InMemoryMetricExporter();
    Object.defineProperty(exports, "InMemoryMetricExporter", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return InMemoryMetricExporter_1.InMemoryMetricExporter;
    }, "get") });
    var ConsoleMetricExporter_1 = require_ConsoleMetricExporter();
    Object.defineProperty(exports, "ConsoleMetricExporter", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return ConsoleMetricExporter_1.ConsoleMetricExporter;
    }, "get") });
    var MeterProvider_1 = require_MeterProvider();
    Object.defineProperty(exports, "MeterProvider", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return MeterProvider_1.MeterProvider;
    }, "get") });
    var AggregationOption_1 = require_AggregationOption();
    Object.defineProperty(exports, "AggregationType", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return AggregationOption_1.AggregationType;
    }, "get") });
    var AttributesProcessor_1 = require_AttributesProcessor();
    Object.defineProperty(exports, "createAllowListAttributesProcessor", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return AttributesProcessor_1.createAllowListAttributesProcessor;
    }, "get") });
    Object.defineProperty(exports, "createDenyListAttributesProcessor", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return AttributesProcessor_1.createDenyListAttributesProcessor;
    }, "get") });
    var utils_1 = require_utils4();
    Object.defineProperty(exports, "TimeoutError", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return utils_1.TimeoutError;
    }, "get") });
  }
});

export {
  require_src,
  require_src2,
  require_src3
};
