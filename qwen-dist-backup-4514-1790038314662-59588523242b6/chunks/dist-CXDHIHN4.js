// Force strict mode and setup for ESM
"use strict";
import {
  require_dist,
  require_follow_redirects,
  require_form_data
} from "./chunk-OBTWL6ZW.js";
import "./chunk-K6KS3LTN.js";
import "./chunk-OSHQMOBS.js";
import {
  BackgroundOutputCoordinator,
  ChannelBase,
  ChannelOutputTurn,
  isTerminalTaskLifecycleType,
  parseChannelOutputMode,
  sanitizeLogText,
  sanitizePromptText,
  sanitizeSenderName,
  truncateUtf16Units
} from "./chunk-PZRXWQUA.js";
import "./chunk-IJOS26LH.js";
import "./chunk-CQ35AJ4Z.js";
import "./chunk-DMTGGOSA.js";
import "./chunk-YQ3U5MUC.js";
import {
  wrapper_default
} from "./chunk-J5TTWBZK.js";
import "./chunk-RVIGZBIT.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __export,
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/channels/dingtalk/dist/index.js
init_esbuild_shims();

// packages/channels/dingtalk/dist/DingtalkAdapter.js
init_esbuild_shims();
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID as randomUUID6 } from "node:crypto";
import { basename as basename3, join } from "node:path";
import { tmpdir as tmpdir3 } from "node:os";
import { Buffer as Buffer2 } from "node:buffer";

// node_modules/dingtalk-stream-sdk-nodejs/dist/index.mjs
init_esbuild_shims();

// node_modules/dingtalk-stream-sdk-nodejs/dist/constants.mjs
init_esbuild_shims();
var TOPIC_ROBOT = "/v1.0/im/bot/messages/get";
var TOPIC_CARD = "/v1.0/card/instances/callback";

// node_modules/dingtalk-stream-sdk-nodejs/dist/client.mjs
init_esbuild_shims();

// node_modules/axios/index.js
init_esbuild_shims();

// node_modules/axios/lib/axios.js
init_esbuild_shims();

// node_modules/axios/lib/utils.js
init_esbuild_shims();

// node_modules/axios/lib/helpers/bind.js
init_esbuild_shims();
function bind(fn, thisArg) {
  return /* @__PURE__ */ __name(function wrap() {
    return fn.apply(thisArg, arguments);
  }, "wrap");
}
__name(bind, "bind");

// node_modules/axios/lib/utils.js
var { toString } = Object.prototype;
var { getPrototypeOf } = Object;
var { iterator, toStringTag } = Symbol;
var hasOwnProperty = (({ hasOwnProperty: hasOwnProperty2 }) => (obj, prop) => hasOwnProperty2.call(obj, prop))(Object.prototype);
var hasOwnInPrototypeChain = /* @__PURE__ */ __name((thing, prop) => {
  let obj = thing;
  const seen = [];
  while (obj != null && obj !== Object.prototype) {
    if (seen.indexOf(obj) !== -1) {
      return false;
    }
    seen.push(obj);
    if (hasOwnProperty(obj, prop)) {
      return true;
    }
    obj = getPrototypeOf(obj);
  }
  return false;
}, "hasOwnInPrototypeChain");
var getSafeProp = /* @__PURE__ */ __name((obj, prop) => obj != null && hasOwnInPrototypeChain(obj, prop) ? obj[prop] : void 0, "getSafeProp");
var kindOf = /* @__PURE__ */ ((cache) => (thing) => {
  const str = toString.call(thing);
  return cache[str] || (cache[str] = str.slice(8, -1).toLowerCase());
})(/* @__PURE__ */ Object.create(null));
var kindOfTest = /* @__PURE__ */ __name((type) => {
  type = type.toLowerCase();
  return (thing) => kindOf(thing) === type;
}, "kindOfTest");
var typeOfTest = /* @__PURE__ */ __name((type) => (thing) => typeof thing === type, "typeOfTest");
var { isArray } = Array;
var isUndefined = typeOfTest("undefined");
function isBuffer(val) {
  return val !== null && !isUndefined(val) && val.constructor !== null && !isUndefined(val.constructor) && isFunction(val.constructor.isBuffer) && val.constructor.isBuffer(val);
}
__name(isBuffer, "isBuffer");
var isArrayBuffer = kindOfTest("ArrayBuffer");
function isArrayBufferView(val) {
  let result;
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView) {
    result = ArrayBuffer.isView(val);
  } else {
    result = val && val.buffer && isArrayBuffer(val.buffer);
  }
  return result;
}
__name(isArrayBufferView, "isArrayBufferView");
var isString = typeOfTest("string");
var isFunction = typeOfTest("function");
var isNumber = typeOfTest("number");
var isObject = /* @__PURE__ */ __name((thing) => thing !== null && typeof thing === "object", "isObject");
var isBoolean = /* @__PURE__ */ __name((thing) => thing === true || thing === false, "isBoolean");
var isPlainObject = /* @__PURE__ */ __name((val) => {
  if (!isObject(val)) {
    return false;
  }
  const prototype2 = getPrototypeOf(val);
  return (prototype2 === null || prototype2 === Object.prototype || getPrototypeOf(prototype2) === null) && // Treat any genuine (non-Object.prototype-polluted) Symbol.toStringTag or
  // Symbol.iterator as evidence the value is a tagged/iterable type rather
  // than a plain object, while ignoring keys injected onto Object.prototype.
  !hasOwnInPrototypeChain(val, toStringTag) && !hasOwnInPrototypeChain(val, iterator);
}, "isPlainObject");
var isEmptyObject = /* @__PURE__ */ __name((val) => {
  if (!isObject(val) || isBuffer(val)) {
    return false;
  }
  try {
    return Object.keys(val).length === 0 && Object.getPrototypeOf(val) === Object.prototype;
  } catch (e) {
    return false;
  }
}, "isEmptyObject");
var isDate = kindOfTest("Date");
var isFile = kindOfTest("File");
var isReactNativeBlob = /* @__PURE__ */ __name((value) => {
  return !!(value && typeof value.uri !== "undefined");
}, "isReactNativeBlob");
var isReactNative = /* @__PURE__ */ __name((formData) => formData && typeof formData.getParts !== "undefined", "isReactNative");
var isBlob = kindOfTest("Blob");
var isFileList = kindOfTest("FileList");
var isSet = kindOfTest("Set");
var isStream = /* @__PURE__ */ __name((val) => isObject(val) && isFunction(val.pipe), "isStream");
function getGlobal() {
  if (typeof globalThis !== "undefined") return globalThis;
  if (typeof self !== "undefined") return self;
  if (typeof window !== "undefined") return window;
  if (typeof globalThis !== "undefined") return globalThis;
  return {};
}
__name(getGlobal, "getGlobal");
var G = getGlobal();
var FormDataCtor = typeof G.FormData !== "undefined" ? G.FormData : void 0;
var isFormData = /* @__PURE__ */ __name((thing) => {
  if (!thing) return false;
  if (FormDataCtor && thing instanceof FormDataCtor) return true;
  const proto = getPrototypeOf(thing);
  if (!proto || proto === Object.prototype) return false;
  if (!isFunction(thing.append)) return false;
  const kind = kindOf(thing);
  return kind === "formdata" || // detect form-data instance
  kind === "object" && isFunction(thing.toString) && thing.toString() === "[object FormData]";
}, "isFormData");
var isURLSearchParams = kindOfTest("URLSearchParams");
var [isReadableStream, isRequest, isResponse, isHeaders] = [
  "ReadableStream",
  "Request",
  "Response",
  "Headers"
].map(kindOfTest);
var trim = /* @__PURE__ */ __name((str) => {
  return str.trim ? str.trim() : str.replace(/^[\s\uFEFF\xA0]+|[\s\uFEFF\xA0]+$/g, "");
}, "trim");
function forEach(obj, fn, { allOwnKeys = false } = {}) {
  if (obj === null || typeof obj === "undefined") {
    return;
  }
  let i;
  let l;
  if (typeof obj !== "object") {
    obj = [obj];
  }
  if (isArray(obj)) {
    for (i = 0, l = obj.length; i < l; i++) {
      fn.call(null, obj[i], i, obj);
    }
  } else {
    if (isBuffer(obj)) {
      return;
    }
    const keys = allOwnKeys ? Object.getOwnPropertyNames(obj) : Object.keys(obj);
    const len = keys.length;
    let key;
    for (i = 0; i < len; i++) {
      key = keys[i];
      fn.call(null, obj[key], key, obj);
    }
  }
}
__name(forEach, "forEach");
function findKey(obj, key) {
  if (isBuffer(obj)) {
    return null;
  }
  key = key.toLowerCase();
  const keys = Object.keys(obj);
  let i = keys.length;
  let _key;
  while (i-- > 0) {
    _key = keys[i];
    if (key === _key.toLowerCase()) {
      return _key;
    }
  }
  return null;
}
__name(findKey, "findKey");
var _global = (() => {
  if (typeof globalThis !== "undefined") return globalThis;
  return typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : globalThis;
})();
var isContextDefined = /* @__PURE__ */ __name((context) => !isUndefined(context) && context !== _global, "isContextDefined");
function merge(...objs) {
  const { caseless, skipUndefined } = isContextDefined(this) && this || {};
  const result = {};
  const assignValue = /* @__PURE__ */ __name((val, key) => {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return;
    }
    const targetKey = caseless && typeof key === "string" && findKey(result, key) || key;
    const existing = hasOwnProperty(result, targetKey) ? result[targetKey] : void 0;
    if (isPlainObject(existing) && isPlainObject(val)) {
      result[targetKey] = merge(existing, val);
    } else if (isPlainObject(val)) {
      result[targetKey] = merge({}, val);
    } else if (isArray(val)) {
      result[targetKey] = val.slice();
    } else if (!skipUndefined || !isUndefined(val)) {
      result[targetKey] = val;
    }
  }, "assignValue");
  for (let i = 0, l = objs.length; i < l; i++) {
    const source = objs[i];
    if (!source || isBuffer(source)) {
      continue;
    }
    forEach(source, assignValue);
    if (typeof source !== "object" || isArray(source)) {
      continue;
    }
    const symbols = Object.getOwnPropertySymbols(source);
    for (let j = 0; j < symbols.length; j++) {
      const symbol = symbols[j];
      if (propertyIsEnumerable.call(source, symbol)) {
        assignValue(source[symbol], symbol);
      }
    }
  }
  return result;
}
__name(merge, "merge");
var extend = /* @__PURE__ */ __name((a, b, thisArg, { allOwnKeys } = {}) => {
  forEach(
    b,
    (val, key) => {
      if (thisArg && isFunction(val)) {
        Object.defineProperty(a, key, {
          // Null-proto descriptor so a polluted Object.prototype.get cannot
          // hijack defineProperty's accessor-vs-data resolution.
          __proto__: null,
          value: bind(val, thisArg),
          writable: true,
          enumerable: true,
          configurable: true
        });
      } else {
        Object.defineProperty(a, key, {
          __proto__: null,
          value: val,
          writable: true,
          enumerable: true,
          configurable: true
        });
      }
    },
    { allOwnKeys }
  );
  return a;
}, "extend");
var stripBOM = /* @__PURE__ */ __name((content) => {
  if (content.charCodeAt(0) === 65279) {
    content = content.slice(1);
  }
  return content;
}, "stripBOM");
var inherits = /* @__PURE__ */ __name((constructor, superConstructor, props, descriptors) => {
  constructor.prototype = Object.create(superConstructor.prototype, descriptors);
  Object.defineProperty(constructor.prototype, "constructor", {
    __proto__: null,
    value: constructor,
    writable: true,
    enumerable: false,
    configurable: true
  });
  Object.defineProperty(constructor, "super", {
    __proto__: null,
    value: superConstructor.prototype
  });
  props && Object.assign(constructor.prototype, props);
}, "inherits");
var toFlatObject = /* @__PURE__ */ __name((sourceObj, destObj, filter2, propFilter) => {
  let props;
  let i;
  let prop;
  const merged = {};
  destObj = destObj || {};
  if (sourceObj == null) return destObj;
  do {
    props = Object.getOwnPropertyNames(sourceObj);
    i = props.length;
    while (i-- > 0) {
      prop = props[i];
      if ((!propFilter || propFilter(prop, sourceObj, destObj)) && !merged[prop]) {
        destObj[prop] = sourceObj[prop];
        merged[prop] = true;
      }
    }
    sourceObj = filter2 !== false && getPrototypeOf(sourceObj);
  } while (sourceObj && (!filter2 || filter2(sourceObj, destObj)) && sourceObj !== Object.prototype);
  return destObj;
}, "toFlatObject");
var endsWith = /* @__PURE__ */ __name((str, searchString, position) => {
  str = String(str);
  if (position === void 0 || position > str.length) {
    position = str.length;
  }
  position -= searchString.length;
  const lastIndex = str.indexOf(searchString, position);
  return lastIndex !== -1 && lastIndex === position;
}, "endsWith");
var toArray = /* @__PURE__ */ __name((thing) => {
  if (!thing) return null;
  if (isArray(thing)) return thing;
  let i = thing.length;
  if (!isNumber(i)) return null;
  const arr = new Array(i);
  while (i-- > 0) {
    arr[i] = thing[i];
  }
  return arr;
}, "toArray");
var isTypedArray = /* @__PURE__ */ ((TypedArray) => {
  return (thing) => {
    return TypedArray && thing instanceof TypedArray;
  };
})(typeof Uint8Array !== "undefined" && getPrototypeOf(Uint8Array));
var forEachEntry = /* @__PURE__ */ __name((obj, fn) => {
  const generator = obj && obj[iterator];
  const _iterator = generator.call(obj);
  let result;
  while ((result = _iterator.next()) && !result.done) {
    const pair = result.value;
    fn.call(obj, pair[0], pair[1]);
  }
}, "forEachEntry");
var matchAll = /* @__PURE__ */ __name((regExp, str) => {
  let matches;
  const arr = [];
  while ((matches = regExp.exec(str)) !== null) {
    arr.push(matches);
  }
  return arr;
}, "matchAll");
var isHTMLForm = kindOfTest("HTMLFormElement");
var toCamelCase = /* @__PURE__ */ __name((str) => {
  return str.toLowerCase().replace(/[-_\s]([a-z\d])(\w*)/g, /* @__PURE__ */ __name(function replacer(m, p1, p2) {
    return p1.toUpperCase() + p2;
  }, "replacer"));
}, "toCamelCase");
var { propertyIsEnumerable } = Object.prototype;
var isRegExp = kindOfTest("RegExp");
var reduceDescriptors = /* @__PURE__ */ __name((obj, reducer) => {
  const descriptors = Object.getOwnPropertyDescriptors(obj);
  const reducedDescriptors = {};
  forEach(descriptors, (descriptor, name) => {
    let ret;
    if ((ret = reducer(descriptor, name, obj)) !== false) {
      reducedDescriptors[name] = ret || descriptor;
    }
  });
  Object.defineProperties(obj, reducedDescriptors);
}, "reduceDescriptors");
var freezeMethods = /* @__PURE__ */ __name((obj) => {
  reduceDescriptors(obj, (descriptor, name) => {
    if (isFunction(obj) && ["arguments", "caller", "callee"].includes(name)) {
      return false;
    }
    const value = obj[name];
    if (!isFunction(value)) return;
    descriptor.enumerable = false;
    if ("writable" in descriptor) {
      descriptor.writable = false;
      return;
    }
    if (!descriptor.set) {
      descriptor.set = () => {
        throw Error("Can not rewrite read-only method '" + name + "'");
      };
    }
  });
}, "freezeMethods");
var toObjectSet = /* @__PURE__ */ __name((arrayOrString, delimiter) => {
  const obj = {};
  const define = /* @__PURE__ */ __name((arr) => {
    arr.forEach((value) => {
      obj[value] = true;
    });
  }, "define");
  isArray(arrayOrString) ? define(arrayOrString) : define(String(arrayOrString).split(delimiter));
  return obj;
}, "toObjectSet");
var noop = /* @__PURE__ */ __name(() => {
}, "noop");
var toFiniteNumber = /* @__PURE__ */ __name((value, defaultValue) => {
  return value != null && Number.isFinite(value = +value) ? value : defaultValue;
}, "toFiniteNumber");
function isSpecCompliantForm(thing) {
  return !!(thing && isFunction(thing.append) && thing[toStringTag] === "FormData" && thing[iterator]);
}
__name(isSpecCompliantForm, "isSpecCompliantForm");
var toJSONObject = /* @__PURE__ */ __name((obj) => {
  const visited = /* @__PURE__ */ new WeakSet();
  const visit = /* @__PURE__ */ __name((source) => {
    if (isObject(source)) {
      if (visited.has(source)) {
        return;
      }
      if (isBuffer(source)) {
        return source;
      }
      if (!("toJSON" in source)) {
        visited.add(source);
        let target;
        if (isSet(source)) {
          target = [];
          for (const value of source) {
            const reducedValue = visit(value);
            !isUndefined(reducedValue) && target.push(reducedValue);
          }
        } else {
          target = isArray(source) ? [] : {};
          forEach(source, (value, key) => {
            const reducedValue = visit(value);
            !isUndefined(reducedValue) && (target[key] = reducedValue);
          });
        }
        visited.delete(source);
        return target;
      }
    }
    return source;
  }, "visit");
  return visit(obj);
}, "toJSONObject");
var isAsyncFn = kindOfTest("AsyncFunction");
var isThenable = /* @__PURE__ */ __name((thing) => thing && (isObject(thing) || isFunction(thing)) && isFunction(thing.then) && isFunction(thing.catch), "isThenable");
var _setImmediate = ((setImmediateSupported, postMessageSupported) => {
  if (setImmediateSupported) {
    return setImmediate;
  }
  return postMessageSupported ? ((token, callbacks) => {
    _global.addEventListener(
      "message",
      ({ source, data }) => {
        if (source === _global && data === token) {
          callbacks.length && callbacks.shift()();
        }
      },
      false
    );
    return (cb) => {
      callbacks.push(cb);
      _global.postMessage(token, "*");
    };
  })(`axios@${Math.random()}`, []) : (cb) => setTimeout(cb);
})(typeof setImmediate === "function", isFunction(_global.postMessage));
var asap = typeof queueMicrotask !== "undefined" ? queueMicrotask.bind(_global) : typeof process !== "undefined" && process.nextTick || _setImmediate;
var isIterable = /* @__PURE__ */ __name((thing) => thing != null && isFunction(thing[iterator]), "isIterable");
var isSafeIterable = /* @__PURE__ */ __name((thing) => thing != null && hasOwnInPrototypeChain(thing, iterator) && isIterable(thing), "isSafeIterable");
var utils_default = {
  isArray,
  isArrayBuffer,
  isBuffer,
  isFormData,
  isArrayBufferView,
  isString,
  isNumber,
  isBoolean,
  isObject,
  isPlainObject,
  isEmptyObject,
  isReadableStream,
  isRequest,
  isResponse,
  isHeaders,
  isUndefined,
  isDate,
  isFile,
  isReactNativeBlob,
  isReactNative,
  isBlob,
  isRegExp,
  isFunction,
  isStream,
  isURLSearchParams,
  isTypedArray,
  isFileList,
  forEach,
  merge,
  extend,
  trim,
  stripBOM,
  inherits,
  toFlatObject,
  kindOf,
  kindOfTest,
  endsWith,
  toArray,
  forEachEntry,
  matchAll,
  isHTMLForm,
  hasOwnProperty,
  hasOwnProp: hasOwnProperty,
  // an alias to avoid ESLint no-prototype-builtins detection
  hasOwnInPrototypeChain,
  getSafeProp,
  reduceDescriptors,
  freezeMethods,
  toObjectSet,
  toCamelCase,
  noop,
  toFiniteNumber,
  findKey,
  global: _global,
  isContextDefined,
  isSpecCompliantForm,
  toJSONObject,
  isAsyncFn,
  isThenable,
  setImmediate: _setImmediate,
  asap,
  isIterable,
  isSafeIterable
};

// node_modules/axios/lib/core/Axios.js
init_esbuild_shims();

// node_modules/axios/lib/helpers/buildURL.js
init_esbuild_shims();

// node_modules/axios/lib/helpers/AxiosURLSearchParams.js
init_esbuild_shims();

// node_modules/axios/lib/helpers/toFormData.js
init_esbuild_shims();

// node_modules/axios/lib/core/AxiosError.js
init_esbuild_shims();

// node_modules/axios/lib/core/AxiosHeaders.js
init_esbuild_shims();

// node_modules/axios/lib/helpers/parseHeaders.js
init_esbuild_shims();
var ignoreDuplicateOf = utils_default.toObjectSet([
  "age",
  "authorization",
  "content-length",
  "content-type",
  "etag",
  "expires",
  "from",
  "host",
  "if-modified-since",
  "if-unmodified-since",
  "last-modified",
  "location",
  "max-forwards",
  "proxy-authorization",
  "referer",
  "retry-after",
  "user-agent"
]);
var parseHeaders_default = /* @__PURE__ */ __name((rawHeaders) => {
  const parsed = {};
  let key;
  let val;
  let i;
  rawHeaders && rawHeaders.split("\n").forEach(/* @__PURE__ */ __name(function parser(line) {
    i = line.indexOf(":");
    key = line.substring(0, i).trim().toLowerCase();
    val = line.substring(i + 1).trim();
    const hasKey = utils_default.hasOwnProp(parsed, key);
    if (!key || hasKey && utils_default.hasOwnProp(ignoreDuplicateOf, key)) {
      return;
    }
    if (key === "set-cookie") {
      if (hasKey) {
        parsed[key].push(val);
      } else {
        parsed[key] = [val];
      }
    } else {
      parsed[key] = hasKey ? parsed[key] + ", " + val : val;
    }
  }, "parser"));
  return parsed;
}, "default");

// node_modules/axios/lib/helpers/sanitizeHeaderValue.js
init_esbuild_shims();
function trimSPorHTAB(str) {
  let start = 0;
  let end = str.length;
  while (start < end) {
    const code = str.charCodeAt(start);
    if (code !== 9 && code !== 32) {
      break;
    }
    start += 1;
  }
  while (end > start) {
    const code = str.charCodeAt(end - 1);
    if (code !== 9 && code !== 32) {
      break;
    }
    end -= 1;
  }
  return start === 0 && end === str.length ? str : str.slice(start, end);
}
__name(trimSPorHTAB, "trimSPorHTAB");
var INVALID_UNICODE_HEADER_VALUE_CHARS = new RegExp("[\\u0000-\\u0008\\u000a-\\u001f\\u007f]+", "g");
var INVALID_BYTE_STRING_HEADER_VALUE_CHARS = new RegExp("[^\\u0009\\u0020-\\u007e\\u0080-\\u00ff]+", "g");
function sanitizeValue(value, invalidChars) {
  if (utils_default.isArray(value)) {
    return value.map((item) => sanitizeValue(item, invalidChars));
  }
  return trimSPorHTAB(String(value).replace(invalidChars, ""));
}
__name(sanitizeValue, "sanitizeValue");
var sanitizeHeaderValue = /* @__PURE__ */ __name((value) => sanitizeValue(value, INVALID_UNICODE_HEADER_VALUE_CHARS), "sanitizeHeaderValue");
var sanitizeByteStringHeaderValue = /* @__PURE__ */ __name((value) => sanitizeValue(value, INVALID_BYTE_STRING_HEADER_VALUE_CHARS), "sanitizeByteStringHeaderValue");
function toByteStringHeaderObject(headers) {
  const byteStringHeaders = /* @__PURE__ */ Object.create(null);
  utils_default.forEach(headers.toJSON(), (value, header) => {
    byteStringHeaders[header] = sanitizeByteStringHeaderValue(value);
  });
  return byteStringHeaders;
}
__name(toByteStringHeaderObject, "toByteStringHeaderObject");

// node_modules/axios/lib/core/AxiosHeaders.js
var $internals = Symbol("internals");
function normalizeHeader(header) {
  return header && String(header).trim().toLowerCase();
}
__name(normalizeHeader, "normalizeHeader");
function normalizeValue(value) {
  if (value === false || value == null) {
    return value;
  }
  return utils_default.isArray(value) ? value.map(normalizeValue) : sanitizeHeaderValue(String(value));
}
__name(normalizeValue, "normalizeValue");
function parseTokens(str) {
  const tokens = /* @__PURE__ */ Object.create(null);
  const tokensRE = /([^\s,;=]+)\s*(?:=\s*([^,;]+))?/g;
  let match;
  while (match = tokensRE.exec(str)) {
    tokens[match[1]] = match[2];
  }
  return tokens;
}
__name(parseTokens, "parseTokens");
var parameterNameRE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
function trimOWS(value) {
  let start = 0;
  let end = value.length;
  while (start < end) {
    const code = value.charCodeAt(start);
    if (code !== 9 && code !== 32) {
      break;
    }
    start += 1;
  }
  while (end > start) {
    const code = value.charCodeAt(end - 1);
    if (code !== 9 && code !== 32) {
      break;
    }
    end -= 1;
  }
  return start === 0 && end === value.length ? value : value.slice(start, end);
}
__name(trimOWS, "trimOWS");
function decodeQuotedString(value) {
  const last = value.length - 1;
  if (last < 1 || value.charCodeAt(0) !== 34 || value.charCodeAt(last) !== 34) {
    return value;
  }
  let decoded = "";
  for (let i = 1; i < last; i++) {
    const code = value.charCodeAt(i);
    if (code === 34) {
      return value;
    }
    if (code === 92) {
      i += 1;
      if (i >= last) {
        return value;
      }
    }
    decoded += value[i];
  }
  return decoded;
}
__name(decodeQuotedString, "decodeQuotedString");
function parseParameters(value) {
  const parameters = /* @__PURE__ */ Object.create(null);
  const str = String(value);
  let start = 0;
  let quoted = false;
  let escaped = false;
  function parseParameter(end) {
    const part = trimOWS(str.slice(start, end));
    const equals = part.indexOf("=");
    if (equals < 1) {
      return;
    }
    const name = trimOWS(part.slice(0, equals));
    if (!parameterNameRE.test(name)) {
      return;
    }
    const normalizedName = name.toLowerCase();
    if (normalizedName === "__proto__" || normalizedName === "constructor" || normalizedName === "prototype") {
      return;
    }
    const parameterValue = trimOWS(part.slice(equals + 1));
    parameters[normalizedName] = decodeQuotedString(parameterValue);
  }
  __name(parseParameter, "parseParameter");
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (code === 92) {
        escaped = true;
      } else if (code === 34) {
        quoted = false;
      }
    } else if (code === 34) {
      quoted = true;
    } else if (code === 44 || code === 59) {
      parseParameter(i);
      start = i + 1;
    }
  }
  parseParameter(str.length);
  return parameters;
}
__name(parseParameters, "parseParameters");
var isValidHeaderName = /* @__PURE__ */ __name((str) => /^[-_a-zA-Z0-9^`|~,!#$%&'*+.]+$/.test(str.trim()), "isValidHeaderName");
function matchHeaderValue(context, value, header, filter2, isHeaderNameFilter) {
  if (utils_default.isFunction(filter2)) {
    return filter2.call(this, value, header);
  }
  if (isHeaderNameFilter) {
    value = header;
  }
  if (!utils_default.isString(value)) return;
  if (utils_default.isString(filter2)) {
    return value.indexOf(filter2) !== -1;
  }
  if (utils_default.isRegExp(filter2)) {
    return filter2.test(value);
  }
}
__name(matchHeaderValue, "matchHeaderValue");
function formatHeader(header) {
  return header.trim().toLowerCase().replace(/([a-z\d])(\w*)/g, (w, char, str) => {
    return char.toUpperCase() + str;
  });
}
__name(formatHeader, "formatHeader");
function buildAccessors(obj, header) {
  const accessorName = utils_default.toCamelCase(" " + header);
  ["get", "set", "has"].forEach((methodName) => {
    Object.defineProperty(obj, methodName + accessorName, {
      // Null-proto descriptor so a polluted Object.prototype.get cannot turn
      // this data descriptor into an accessor descriptor on the way in.
      __proto__: null,
      value: /* @__PURE__ */ __name(function(arg1, arg2, arg3) {
        return this[methodName].call(this, header, arg1, arg2, arg3);
      }, "value"),
      configurable: true
    });
  });
}
__name(buildAccessors, "buildAccessors");
var AxiosHeaders = class {
  static {
    __name(this, "AxiosHeaders");
  }
  constructor(headers) {
    headers && this.set(headers);
  }
  set(header, valueOrRewrite, rewrite) {
    const self2 = this;
    function setHeader(_value, _header, _rewrite) {
      const lHeader = normalizeHeader(_header);
      if (!lHeader) {
        return;
      }
      const key = utils_default.findKey(self2, lHeader);
      if (!key || self2[key] === void 0 || _rewrite === true || _rewrite === void 0 && self2[key] !== false) {
        self2[key || _header] = normalizeValue(_value);
      }
    }
    __name(setHeader, "setHeader");
    const setHeaders = /* @__PURE__ */ __name((headers, _rewrite) => utils_default.forEach(headers, (_value, _header) => setHeader(_value, _header, _rewrite)), "setHeaders");
    if (utils_default.isPlainObject(header) || header instanceof this.constructor) {
      setHeaders(header, valueOrRewrite);
    } else if (utils_default.isString(header) && (header = header.trim()) && !isValidHeaderName(header)) {
      setHeaders(parseHeaders_default(header), valueOrRewrite);
    } else if (utils_default.isObject(header) && utils_default.isSafeIterable(header)) {
      let obj = /* @__PURE__ */ Object.create(null), dest, key;
      for (const entry of header) {
        if (!utils_default.isArray(entry)) {
          throw new TypeError("Object iterator must return a key-value pair");
        }
        key = entry[0];
        if (utils_default.hasOwnProp(obj, key)) {
          dest = obj[key];
          obj[key] = utils_default.isArray(dest) ? [...dest, entry[1]] : [dest, entry[1]];
        } else {
          obj[key] = entry[1];
        }
      }
      setHeaders(obj, valueOrRewrite);
    } else {
      header != null && setHeader(valueOrRewrite, header, rewrite);
    }
    return this;
  }
  get(header, parser) {
    header = normalizeHeader(header);
    if (header) {
      const key = utils_default.findKey(this, header);
      if (key) {
        const value = this[key];
        if (!parser) {
          return value;
        }
        if (parser === true) {
          return parseTokens(value);
        }
        if (utils_default.isFunction(parser)) {
          return parser.call(this, value, key);
        }
        if (utils_default.isRegExp(parser)) {
          return parser.exec(value);
        }
        throw new TypeError("parser must be boolean|regexp|function");
      }
    }
  }
  has(header, matcher) {
    header = normalizeHeader(header);
    if (header) {
      const key = utils_default.findKey(this, header);
      return !!(key && this[key] !== void 0 && (!matcher || matchHeaderValue(this, this[key], key, matcher)));
    }
    return false;
  }
  delete(header, matcher) {
    const self2 = this;
    let deleted = false;
    function deleteHeader(_header) {
      _header = normalizeHeader(_header);
      if (_header) {
        const key = utils_default.findKey(self2, _header);
        if (key && (!matcher || matchHeaderValue(self2, self2[key], key, matcher))) {
          delete self2[key];
          deleted = true;
        }
      }
    }
    __name(deleteHeader, "deleteHeader");
    if (utils_default.isArray(header)) {
      header.forEach(deleteHeader);
    } else {
      deleteHeader(header);
    }
    return deleted;
  }
  clear(matcher) {
    const keys = Object.keys(this);
    let i = keys.length;
    let deleted = false;
    while (i--) {
      const key = keys[i];
      if (!matcher || matchHeaderValue(this, this[key], key, matcher, true)) {
        delete this[key];
        deleted = true;
      }
    }
    return deleted;
  }
  normalize(format) {
    const self2 = this;
    const headers = {};
    utils_default.forEach(this, (value, header) => {
      const key = utils_default.findKey(headers, header);
      if (key) {
        self2[key] = normalizeValue(value);
        delete self2[header];
        return;
      }
      const normalized = format ? formatHeader(header) : String(header).trim();
      if (normalized !== header) {
        delete self2[header];
      }
      self2[normalized] = normalizeValue(value);
      headers[normalized] = true;
    });
    return this;
  }
  concat(...targets) {
    return this.constructor.concat(this, ...targets);
  }
  toJSON(asStrings) {
    const obj = /* @__PURE__ */ Object.create(null);
    utils_default.forEach(this, (value, header) => {
      value != null && value !== false && (obj[header] = asStrings && utils_default.isArray(value) ? value.join(", ") : value);
    });
    return obj;
  }
  [Symbol.iterator]() {
    return Object.entries(this.toJSON())[Symbol.iterator]();
  }
  toString() {
    return Object.entries(this.toJSON()).map(([header, value]) => header + ": " + value).join("\n");
  }
  getSetCookie() {
    const value = this.get("set-cookie");
    return utils_default.isArray(value) ? value : value == null || value === false ? [] : [value];
  }
  get [Symbol.toStringTag]() {
    return "AxiosHeaders";
  }
  static from(thing) {
    return thing instanceof this ? thing : new this(thing);
  }
  static parseParameters(value) {
    return parseParameters(value);
  }
  static concat(first, ...targets) {
    const computed = new this(first);
    targets.forEach((target) => computed.set(target));
    return computed;
  }
  static accessor(header) {
    const internals = this[$internals] = this[$internals] = {
      accessors: {}
    };
    const accessors = internals.accessors;
    const prototype2 = this.prototype;
    function defineAccessor(_header) {
      const lHeader = normalizeHeader(_header);
      if (!accessors[lHeader]) {
        buildAccessors(prototype2, _header);
        accessors[lHeader] = true;
      }
    }
    __name(defineAccessor, "defineAccessor");
    utils_default.isArray(header) ? header.forEach(defineAccessor) : defineAccessor(header);
    return this;
  }
};
AxiosHeaders.accessor([
  "Content-Type",
  "Content-Length",
  "Accept",
  "Accept-Encoding",
  "User-Agent",
  "Authorization"
]);
utils_default.reduceDescriptors(AxiosHeaders.prototype, ({ value }, key) => {
  let mapped = key[0].toUpperCase() + key.slice(1);
  return {
    get: /* @__PURE__ */ __name(() => value, "get"),
    set(headerValue) {
      this[mapped] = headerValue;
    }
  };
});
utils_default.freezeMethods(AxiosHeaders);
var AxiosHeaders_default = AxiosHeaders;

// node_modules/axios/lib/core/AxiosError.js
var REDACTED = "[REDACTED ****]";
function hasOwnOrPrototypeToJSON(source) {
  if (utils_default.hasOwnProp(source, "toJSON")) {
    return true;
  }
  let prototype2 = Object.getPrototypeOf(source);
  while (prototype2 && prototype2 !== Object.prototype) {
    if (utils_default.hasOwnProp(prototype2, "toJSON")) {
      return true;
    }
    prototype2 = Object.getPrototypeOf(prototype2);
  }
  return false;
}
__name(hasOwnOrPrototypeToJSON, "hasOwnOrPrototypeToJSON");
function redactConfig(config, redactKeys) {
  const lowerKeys = new Set(redactKeys.map((k) => String(k).toLowerCase()));
  const seen = [];
  const visit = /* @__PURE__ */ __name((source) => {
    if (source === null || typeof source !== "object") return source;
    if (utils_default.isBuffer(source)) return source;
    if (seen.indexOf(source) !== -1) return void 0;
    if (source instanceof AxiosHeaders_default) {
      source = source.toJSON();
    }
    seen.push(source);
    let result;
    if (utils_default.isArray(source)) {
      result = [];
      source.forEach((v, i) => {
        const reducedValue = visit(v);
        if (!utils_default.isUndefined(reducedValue)) {
          result[i] = reducedValue;
        }
      });
    } else {
      if (!utils_default.isPlainObject(source) && hasOwnOrPrototypeToJSON(source)) {
        seen.pop();
        return source;
      }
      result = /* @__PURE__ */ Object.create(null);
      for (const [key, value] of Object.entries(source)) {
        const reducedValue = lowerKeys.has(key.toLowerCase()) ? REDACTED : visit(value);
        if (!utils_default.isUndefined(reducedValue)) {
          result[key] = reducedValue;
        }
      }
    }
    seen.pop();
    return result;
  }, "visit");
  return visit(config);
}
__name(redactConfig, "redactConfig");
function stringifySafely(value) {
  try {
    return String(value);
  } catch (err) {
    return "";
  }
}
__name(stringifySafely, "stringifySafely");
function aggregateErrorMessage(error) {
  const message = error.errors.map((entry) => {
    try {
      return entry && entry.message ? stringifySafely(entry.message) : stringifySafely(entry);
    } catch (err) {
      return "";
    }
  }).filter(Boolean).join("; ");
  return message || error.name || "AggregateError";
}
__name(aggregateErrorMessage, "aggregateErrorMessage");
var AxiosError = class _AxiosError extends Error {
  static {
    __name(this, "AxiosError");
  }
  static from(error, code, config, request, response, customProps) {
    let message = error.message;
    if (!message && utils_default.isArray(error.errors) && error.errors.length) {
      message = aggregateErrorMessage(error);
    }
    const axiosError = new _AxiosError(message, code || error.code, config, request, response);
    Object.defineProperty(axiosError, "cause", {
      __proto__: null,
      value: error,
      writable: true,
      enumerable: false,
      configurable: true
    });
    axiosError.name = error.name;
    if (error.status != null && axiosError.status == null) {
      axiosError.status = error.status;
    }
    customProps && Object.assign(axiosError, customProps);
    return axiosError;
  }
  /**
   * Create an Error with the specified message, config, error code, request and response.
   *
   * @param {string} message The error message.
   * @param {string} [code] The error code (for example, 'ECONNABORTED').
   * @param {Object} [config] The config.
   * @param {Object} [request] The request.
   * @param {Object} [response] The response.
   *
   * @returns {Error} The created error.
   */
  constructor(message, code, config, request, response) {
    super(message);
    Object.defineProperty(this, "message", {
      // Null-proto descriptor so a polluted Object.prototype.get cannot turn
      // this data descriptor into an accessor descriptor on the way in.
      __proto__: null,
      value: message,
      enumerable: true,
      writable: true,
      configurable: true
    });
    this.name = "AxiosError";
    this.isAxiosError = true;
    code && (this.code = code);
    config && (this.config = config);
    request && (this.request = request);
    if (response) {
      this.response = response;
      this.status = response.status;
    }
  }
  toJSON() {
    const config = this.config;
    const redactKeys = config && utils_default.hasOwnProp(config, "redact") ? config.redact : void 0;
    const serializedConfig = utils_default.isArray(redactKeys) && redactKeys.length > 0 ? redactConfig(config, redactKeys) : utils_default.toJSONObject(config);
    return {
      // Standard
      message: this.message,
      name: this.name,
      // Microsoft
      description: this.description,
      number: this.number,
      // Mozilla
      fileName: this.fileName,
      lineNumber: this.lineNumber,
      columnNumber: this.columnNumber,
      stack: this.stack,
      // Axios
      config: serializedConfig,
      code: this.code,
      status: this.status
    };
  }
};
AxiosError.ERR_BAD_OPTION_VALUE = "ERR_BAD_OPTION_VALUE";
AxiosError.ERR_BAD_OPTION = "ERR_BAD_OPTION";
AxiosError.ECONNABORTED = "ECONNABORTED";
AxiosError.ETIMEDOUT = "ETIMEDOUT";
AxiosError.ECONNREFUSED = "ECONNREFUSED";
AxiosError.ERR_NETWORK = "ERR_NETWORK";
AxiosError.ERR_FR_TOO_MANY_REDIRECTS = "ERR_FR_TOO_MANY_REDIRECTS";
AxiosError.ERR_DEPRECATED = "ERR_DEPRECATED";
AxiosError.ERR_BAD_RESPONSE = "ERR_BAD_RESPONSE";
AxiosError.ERR_BAD_REQUEST = "ERR_BAD_REQUEST";
AxiosError.ERR_CANCELED = "ERR_CANCELED";
AxiosError.ERR_NOT_SUPPORT = "ERR_NOT_SUPPORT";
AxiosError.ERR_INVALID_URL = "ERR_INVALID_URL";
AxiosError.ERR_FORM_DATA_DEPTH_EXCEEDED = "ERR_FORM_DATA_DEPTH_EXCEEDED";
var AxiosError_default = AxiosError;

// node_modules/axios/lib/platform/node/classes/FormData.js
init_esbuild_shims();
var import_form_data = __toESM(require_form_data(), 1);
var FormData_default = import_form_data.default;

// node_modules/axios/lib/platform/node/classes/Buffer.js
init_esbuild_shims();
var Buffer_default = {
  isBufferAvailable() {
    return typeof Buffer !== "undefined";
  },
  from(value) {
    return Buffer.from(value);
  }
};

// node_modules/axios/lib/helpers/toFormData.js
var DEFAULT_FORM_DATA_MAX_DEPTH = 100;
function isVisitable(thing) {
  return utils_default.isPlainObject(thing) || utils_default.isArray(thing);
}
__name(isVisitable, "isVisitable");
function removeBrackets(key) {
  return utils_default.endsWith(key, "[]") ? key.slice(0, -2) : key;
}
__name(removeBrackets, "removeBrackets");
function renderKey(path, key, dots) {
  if (!path) return key;
  return path.concat(key).map(/* @__PURE__ */ __name(function each(token, i) {
    token = removeBrackets(token);
    return !dots && i ? "[" + token + "]" : token;
  }, "each")).join(dots ? "." : "");
}
__name(renderKey, "renderKey");
function isFlatArray(arr) {
  return utils_default.isArray(arr) && !arr.some(isVisitable);
}
__name(isFlatArray, "isFlatArray");
var predicates = utils_default.toFlatObject(utils_default, {}, null, /* @__PURE__ */ __name(function filter(prop) {
  return /^is[A-Z]/.test(prop);
}, "filter"));
function toFormData(obj, formData, options) {
  if (!utils_default.isObject(obj)) {
    throw new TypeError("target must be an object");
  }
  formData = formData || new (FormData_default || FormData)();
  options = utils_default.toFlatObject(
    options,
    {
      metaTokens: true,
      dots: false,
      indexes: false
    },
    false,
    /* @__PURE__ */ __name(function defined(option, source) {
      return !utils_default.isUndefined(source[option]);
    }, "defined")
  );
  const metaTokens = options.metaTokens;
  const visitor = options.visitor || defaultVisitor;
  const dots = options.dots;
  const indexes = options.indexes;
  const _Blob = options.Blob || typeof Blob !== "undefined" && Blob;
  const maxDepth = options.maxDepth === void 0 ? DEFAULT_FORM_DATA_MAX_DEPTH : options.maxDepth;
  const useBlob = _Blob && utils_default.isSpecCompliantForm(formData);
  const stack = [];
  if (!utils_default.isFunction(visitor)) {
    throw new TypeError("visitor must be a function");
  }
  function convertValue(value) {
    if (value === null) return "";
    if (utils_default.isDate(value)) {
      return value.toISOString();
    }
    if (utils_default.isBoolean(value)) {
      return value.toString();
    }
    if (!useBlob && utils_default.isBlob(value)) {
      throw new AxiosError_default("Blob is not supported. Use a Buffer instead.");
    }
    if (utils_default.isArrayBuffer(value) || utils_default.isTypedArray(value)) {
      if (useBlob && typeof _Blob === "function") {
        return new _Blob([value]);
      }
      if (Buffer_default && Buffer_default.isBufferAvailable()) {
        return Buffer_default.from(value);
      }
      throw new AxiosError_default("Blob is not supported. Use a Buffer instead.", AxiosError_default.ERR_NOT_SUPPORT);
    }
    return value;
  }
  __name(convertValue, "convertValue");
  function throwIfMaxDepthExceeded(depth) {
    if (depth > maxDepth) {
      throw new AxiosError_default(
        "Object is too deeply nested (" + depth + " levels). Max depth: " + maxDepth,
        AxiosError_default.ERR_FORM_DATA_DEPTH_EXCEEDED
      );
    }
  }
  __name(throwIfMaxDepthExceeded, "throwIfMaxDepthExceeded");
  function stringifyWithDepthLimit(value, depth) {
    if (maxDepth === Infinity) {
      return JSON.stringify(value);
    }
    const ancestors = [];
    return JSON.stringify(value, /* @__PURE__ */ __name(function limitDepth(_key, currentValue) {
      if (!utils_default.isObject(currentValue)) {
        return currentValue;
      }
      while (ancestors.length && ancestors[ancestors.length - 1] !== this) {
        ancestors.pop();
      }
      ancestors.push(currentValue);
      throwIfMaxDepthExceeded(depth + ancestors.length - 1);
      return currentValue;
    }, "limitDepth"));
  }
  __name(stringifyWithDepthLimit, "stringifyWithDepthLimit");
  function defaultVisitor(value, key, path) {
    let arr = value;
    if (utils_default.isReactNative(formData) && utils_default.isReactNativeBlob(value)) {
      formData.append(renderKey(path, key, dots), convertValue(value));
      return false;
    }
    if (value && !path && typeof value === "object") {
      if (utils_default.endsWith(key, "{}")) {
        key = metaTokens ? key : key.slice(0, -2);
        value = stringifyWithDepthLimit(value, 1);
      } else if (utils_default.isArray(value) && isFlatArray(value) || (utils_default.isFileList(value) || utils_default.endsWith(key, "[]")) && (arr = utils_default.toArray(value))) {
        key = removeBrackets(key);
        arr.forEach(/* @__PURE__ */ __name(function each(el, index) {
          !(utils_default.isUndefined(el) || el === null) && formData.append(
            // eslint-disable-next-line no-nested-ternary
            indexes === true ? renderKey([key], index, dots) : indexes === null ? key : key + "[]",
            convertValue(el)
          );
        }, "each"));
        return false;
      }
    }
    if (isVisitable(value)) {
      return true;
    }
    formData.append(renderKey(path, key, dots), convertValue(value));
    return false;
  }
  __name(defaultVisitor, "defaultVisitor");
  const exposedHelpers = Object.assign(predicates, {
    defaultVisitor,
    convertValue,
    isVisitable
  });
  function build(value, path, depth = 0) {
    if (utils_default.isUndefined(value)) return;
    throwIfMaxDepthExceeded(depth);
    if (stack.indexOf(value) !== -1) {
      throw new Error("Circular reference detected in " + path.join("."));
    }
    stack.push(value);
    utils_default.forEach(value, /* @__PURE__ */ __name(function each(el, key) {
      const result = !(utils_default.isUndefined(el) || el === null) && visitor.call(formData, el, utils_default.isString(key) ? key.trim() : key, path, exposedHelpers);
      if (result === true) {
        build(el, path ? path.concat(key) : [key], depth + 1);
      }
    }, "each"));
    stack.pop();
  }
  __name(build, "build");
  if (!utils_default.isObject(obj)) {
    throw new TypeError("data must be an object");
  }
  build(obj);
  return formData;
}
__name(toFormData, "toFormData");
var toFormData_default = toFormData;

// node_modules/axios/lib/helpers/AxiosURLSearchParams.js
function encode(str) {
  const charMap = {
    "!": "%21",
    "'": "%27",
    "(": "%28",
    ")": "%29",
    "~": "%7E",
    "%20": "+"
  };
  return encodeURIComponent(str).replace(/[!'()~]|%20/g, /* @__PURE__ */ __name(function replacer(match) {
    return charMap[match];
  }, "replacer"));
}
__name(encode, "encode");
function AxiosURLSearchParams(params, options) {
  this._pairs = [];
  params && toFormData_default(params, this, options);
}
__name(AxiosURLSearchParams, "AxiosURLSearchParams");
var prototype = AxiosURLSearchParams.prototype;
prototype.append = /* @__PURE__ */ __name(function append(name, value) {
  this._pairs.push([name, value]);
}, "append");
prototype.toString = /* @__PURE__ */ __name(function toString2(encoder) {
  const _encode = encoder ? (value) => encoder.call(this, value, encode) : encode;
  return this._pairs.map(/* @__PURE__ */ __name(function each(pair) {
    return _encode(pair[0]) + "=" + _encode(pair[1]);
  }, "each"), "").join("&");
}, "toString");
var AxiosURLSearchParams_default = AxiosURLSearchParams;

// node_modules/axios/lib/helpers/buildURL.js
function encode2(val) {
  return encodeURIComponent(val).replace(/%3A/gi, ":").replace(/%24/g, "$").replace(/%2C/gi, ",").replace(/%20/g, "+");
}
__name(encode2, "encode");
function buildURL(url2, params, options) {
  if (!params) {
    return url2;
  }
  url2 = url2 || "";
  const _options = utils_default.isFunction(options) ? {
    serialize: options
  } : options;
  const _encode = utils_default.getSafeProp(_options, "encode") || encode2;
  const serializeFn = utils_default.getSafeProp(_options, "serialize");
  let serializedParams;
  if (serializeFn) {
    serializedParams = serializeFn(params, _options);
  } else {
    serializedParams = utils_default.isURLSearchParams(params) ? params.toString() : new AxiosURLSearchParams_default(params, _options).toString(_encode);
  }
  if (serializedParams) {
    const hashmarkIndex = url2.indexOf("#");
    if (hashmarkIndex !== -1) {
      url2 = url2.slice(0, hashmarkIndex);
    }
    url2 += (url2.indexOf("?") === -1 ? "?" : "&") + serializedParams;
  }
  return url2;
}
__name(buildURL, "buildURL");

// node_modules/axios/lib/core/InterceptorManager.js
init_esbuild_shims();
var InterceptorManager = class {
  static {
    __name(this, "InterceptorManager");
  }
  constructor() {
    this.handlers = [];
  }
  /**
   * Add a new interceptor to the stack
   *
   * @param {Function} fulfilled The function to handle `then` for a `Promise`
   * @param {Function} rejected The function to handle `reject` for a `Promise`
   * @param {Object} options The options for the interceptor, synchronous and runWhen
   *
   * @return {Number} An ID used to remove interceptor later
   */
  use(fulfilled, rejected, options) {
    this.handlers.push({
      fulfilled,
      rejected,
      synchronous: options ? options.synchronous : false,
      runWhen: options ? options.runWhen : null
    });
    return this.handlers.length - 1;
  }
  /**
   * Remove an interceptor from the stack
   *
   * @param {Number} id The ID that was returned by `use`
   *
   * @returns {void}
   */
  eject(id) {
    if (this.handlers[id]) {
      this.handlers[id] = null;
    }
  }
  /**
   * Clear all interceptors from the stack
   *
   * @returns {void}
   */
  clear() {
    if (this.handlers) {
      this.handlers = [];
    }
  }
  /**
   * Iterate over all the registered interceptors
   *
   * This method is particularly useful for skipping over any
   * interceptors that may have become `null` calling `eject`.
   *
   * @param {Function} fn The function to call for each interceptor
   *
   * @returns {void}
   */
  forEach(fn) {
    utils_default.forEach(this.handlers, /* @__PURE__ */ __name(function forEachHandler(h) {
      if (h !== null) {
        fn(h);
      }
    }, "forEachHandler"));
  }
};
var InterceptorManager_default = InterceptorManager;

// node_modules/axios/lib/core/dispatchRequest.js
init_esbuild_shims();

// node_modules/axios/lib/core/transformData.js
init_esbuild_shims();

// node_modules/axios/lib/defaults/index.js
init_esbuild_shims();

// node_modules/axios/lib/defaults/transitional.js
init_esbuild_shims();
var transitional_default = {
  silentJSONParsing: true,
  forcedJSONParsing: true,
  clarifyTimeoutError: false,
  legacyInterceptorReqResOrdering: true,
  advertiseZstdAcceptEncoding: false,
  validateStatusUndefinedResolves: true
};

// node_modules/axios/lib/helpers/toURLEncodedForm.js
init_esbuild_shims();

// node_modules/axios/lib/platform/index.js
init_esbuild_shims();

// node_modules/axios/lib/platform/node/index.js
init_esbuild_shims();
import crypto from "crypto";

// node_modules/axios/lib/platform/node/classes/URLSearchParams.js
init_esbuild_shims();
import url from "url";
var URLSearchParams_default = url.URLSearchParams;

// node_modules/axios/lib/platform/node/index.js
var ALPHA = "abcdefghijklmnopqrstuvwxyz";
var DIGIT = "0123456789";
var ALPHABET = {
  DIGIT,
  ALPHA,
  ALPHA_DIGIT: ALPHA + ALPHA.toUpperCase() + DIGIT
};
var generateString = /* @__PURE__ */ __name((size = 16, alphabet = ALPHABET.ALPHA_DIGIT) => {
  let str = "";
  const { length } = alphabet;
  const randomValues = new Uint32Array(size);
  crypto.randomFillSync(randomValues);
  for (let i = 0; i < size; i++) {
    str += alphabet[randomValues[i] % length];
  }
  return str;
}, "generateString");
var node_default = {
  isNode: true,
  classes: {
    URLSearchParams: URLSearchParams_default,
    FormData: FormData_default,
    Blob: typeof Blob !== "undefined" && Blob || null
  },
  ALPHABET,
  generateString,
  protocols: ["http", "https", "file", "data"]
};

// node_modules/axios/lib/platform/common/utils.js
var utils_exports = {};
__export(utils_exports, {
  hasBrowserEnv: () => hasBrowserEnv,
  hasStandardBrowserEnv: () => hasStandardBrowserEnv,
  hasStandardBrowserWebWorkerEnv: () => hasStandardBrowserWebWorkerEnv,
  navigator: () => _navigator,
  origin: () => origin
});
init_esbuild_shims();
var hasBrowserEnv = typeof window !== "undefined" && typeof document !== "undefined";
var _navigator = typeof navigator === "object" && navigator || void 0;
var hasStandardBrowserEnv = hasBrowserEnv && (!_navigator || ["ReactNative", "NativeScript", "NS"].indexOf(_navigator.product) < 0);
var hasStandardBrowserWebWorkerEnv = (() => {
  return typeof WorkerGlobalScope !== "undefined" && // eslint-disable-next-line no-undef
  self instanceof WorkerGlobalScope && typeof self.importScripts === "function";
})();
var origin = hasBrowserEnv && window.location.href || "http://localhost";

// node_modules/axios/lib/platform/index.js
var platform_default = {
  ...utils_exports,
  ...node_default
};

// node_modules/axios/lib/helpers/toURLEncodedForm.js
function toURLEncodedForm(data, options) {
  return toFormData_default(data, new platform_default.classes.URLSearchParams(), {
    visitor: /* @__PURE__ */ __name(function(value, key, path, helpers) {
      if (platform_default.isNode && utils_default.isBuffer(value)) {
        this.append(key, value.toString("base64"));
        return false;
      }
      return helpers.defaultVisitor.apply(this, arguments);
    }, "visitor"),
    ...options
  });
}
__name(toURLEncodedForm, "toURLEncodedForm");

// node_modules/axios/lib/helpers/formDataToJSON.js
init_esbuild_shims();
var MAX_DEPTH = DEFAULT_FORM_DATA_MAX_DEPTH;
function throwIfDepthExceeded(index) {
  if (index > MAX_DEPTH) {
    throw new AxiosError_default(
      "FormData field is too deeply nested (" + index + " levels). Max depth: " + MAX_DEPTH,
      AxiosError_default.ERR_FORM_DATA_DEPTH_EXCEEDED
    );
  }
}
__name(throwIfDepthExceeded, "throwIfDepthExceeded");
function parsePropPath(name) {
  const path = [];
  const pattern = /[^.[\]]+|\[([^.[\]]*)]/g;
  let match;
  while ((match = pattern.exec(name)) !== null) {
    throwIfDepthExceeded(path.length);
    path.push(match[0] === "[]" ? "" : match[1] || match[0]);
  }
  return path;
}
__name(parsePropPath, "parsePropPath");
function arrayToObject(arr) {
  const obj = {};
  const keys = Object.keys(arr);
  let i;
  const len = keys.length;
  let key;
  for (i = 0; i < len; i++) {
    key = keys[i];
    obj[key] = arr[key];
  }
  return obj;
}
__name(arrayToObject, "arrayToObject");
function formDataToJSON(formData) {
  function buildPath(path, value, target, index) {
    throwIfDepthExceeded(index);
    let name = path[index++];
    if (name === "__proto__") return true;
    const isNumericKey = Number.isFinite(+name);
    const isLast = index >= path.length;
    name = !name && utils_default.isArray(target) ? target.length : name;
    if (isLast) {
      if (utils_default.hasOwnProp(target, name)) {
        target[name] = utils_default.isArray(target[name]) ? target[name].concat(value) : [target[name], value];
      } else {
        target[name] = value;
      }
      return !isNumericKey;
    }
    if (!utils_default.hasOwnProp(target, name) || !utils_default.isObject(target[name])) {
      target[name] = [];
    }
    const result = buildPath(path, value, target[name], index);
    if (result && utils_default.isArray(target[name])) {
      target[name] = arrayToObject(target[name]);
    }
    return !isNumericKey;
  }
  __name(buildPath, "buildPath");
  if (utils_default.isFormData(formData) && utils_default.isFunction(formData.entries)) {
    const obj = {};
    utils_default.forEachEntry(formData, (name, value) => {
      buildPath(parsePropPath(name), value, obj, 0);
    });
    return obj;
  }
  return null;
}
__name(formDataToJSON, "formDataToJSON");
var formDataToJSON_default = formDataToJSON;

// node_modules/axios/lib/defaults/index.js
var own = /* @__PURE__ */ __name((obj, key) => obj != null && utils_default.hasOwnProp(obj, key) ? obj[key] : void 0, "own");
function stringifySafely2(rawValue, parser, encoder) {
  if (utils_default.isString(rawValue)) {
    try {
      (parser || JSON.parse)(rawValue);
      return utils_default.trim(rawValue);
    } catch (e) {
      if (e.name !== "SyntaxError") {
        throw e;
      }
    }
  }
  return (encoder || JSON.stringify)(rawValue);
}
__name(stringifySafely2, "stringifySafely");
var defaults = {
  transitional: transitional_default,
  adapter: ["xhr", "http", "fetch"],
  transformRequest: [
    /* @__PURE__ */ __name(function transformRequest(data, headers) {
      const contentType = headers.getContentType() || "";
      const hasJSONContentType = contentType.indexOf("application/json") > -1;
      const isObjectPayload = utils_default.isObject(data);
      if (isObjectPayload && utils_default.isHTMLForm(data)) {
        data = new FormData(data);
      }
      const isFormData2 = utils_default.isFormData(data);
      if (isFormData2) {
        return hasJSONContentType ? JSON.stringify(formDataToJSON_default(data)) : data;
      }
      if (utils_default.isArrayBuffer(data) || utils_default.isBuffer(data) || utils_default.isStream(data) || utils_default.isFile(data) || utils_default.isBlob(data) || utils_default.isReadableStream(data)) {
        return data;
      }
      if (utils_default.isArrayBufferView(data)) {
        return data.buffer;
      }
      if (utils_default.isURLSearchParams(data)) {
        headers.setContentType("application/x-www-form-urlencoded;charset=utf-8", false);
        return data.toString();
      }
      let isFileList2;
      if (isObjectPayload) {
        const formSerializer = own(this, "formSerializer");
        if (contentType.indexOf("application/x-www-form-urlencoded") > -1) {
          return toURLEncodedForm(data, formSerializer).toString();
        }
        if ((isFileList2 = utils_default.isFileList(data)) || contentType.indexOf("multipart/form-data") > -1) {
          const env = own(this, "env");
          const _FormData = env && env.FormData;
          return toFormData_default(
            isFileList2 ? { "files[]": data } : data,
            _FormData && new _FormData(),
            formSerializer
          );
        }
      }
      if (isObjectPayload || hasJSONContentType) {
        headers.setContentType("application/json", false);
        return stringifySafely2(data);
      }
      return data;
    }, "transformRequest")
  ],
  transformResponse: [
    /* @__PURE__ */ __name(function transformResponse(data) {
      const transitional2 = own(this, "transitional") || defaults.transitional;
      const forcedJSONParsing = transitional2 && transitional2.forcedJSONParsing;
      const responseType = own(this, "responseType");
      const JSONRequested = responseType === "json";
      if (utils_default.isResponse(data) || utils_default.isReadableStream(data)) {
        return data;
      }
      if (data && utils_default.isString(data) && (forcedJSONParsing && !responseType || JSONRequested)) {
        const silentJSONParsing = transitional2 && transitional2.silentJSONParsing;
        const strictJSONParsing = !silentJSONParsing && JSONRequested;
        try {
          return JSON.parse(data, own(this, "parseReviver"));
        } catch (e) {
          if (strictJSONParsing) {
            if (e.name === "SyntaxError") {
              throw AxiosError_default.from(e, AxiosError_default.ERR_BAD_RESPONSE, this, null, own(this, "response"));
            }
            throw e;
          }
        }
      }
      return data;
    }, "transformResponse")
  ],
  /**
   * A timeout in milliseconds to abort a request. If set to 0 (default) a
   * timeout is not created.
   */
  timeout: 0,
  xsrfCookieName: "XSRF-TOKEN",
  xsrfHeaderName: "X-XSRF-TOKEN",
  maxContentLength: -1,
  maxBodyLength: -1,
  env: {
    FormData: platform_default.classes.FormData,
    Blob: platform_default.classes.Blob
  },
  validateStatus: /* @__PURE__ */ __name(function validateStatus(status) {
    return status >= 200 && status < 300;
  }, "validateStatus"),
  headers: {
    common: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": void 0
    }
  }
};
utils_default.forEach(["delete", "get", "head", "post", "put", "patch", "query"], (method) => {
  defaults.headers[method] = {};
});
var defaults_default = defaults;

// node_modules/axios/lib/core/transformData.js
function transformData(fns, response) {
  const config = this || defaults_default;
  const context = response || config;
  const headers = AxiosHeaders_default.from(context.headers);
  let data = context.data;
  utils_default.forEach(fns, /* @__PURE__ */ __name(function transform(fn) {
    data = fn.call(config, data, headers.normalize(), response ? response.status : void 0);
  }, "transform"));
  headers.normalize();
  return data;
}
__name(transformData, "transformData");

// node_modules/axios/lib/cancel/isCancel.js
init_esbuild_shims();
function isCancel(value) {
  return !!(value && value.__CANCEL__);
}
__name(isCancel, "isCancel");

// node_modules/axios/lib/cancel/CanceledError.js
init_esbuild_shims();
var CanceledError = class extends AxiosError_default {
  static {
    __name(this, "CanceledError");
  }
  /**
   * A `CanceledError` is an object that is thrown when an operation is canceled.
   *
   * @param {string=} message The message.
   * @param {Object=} config The config.
   * @param {Object=} request The request.
   *
   * @returns {CanceledError} The created error.
   */
  constructor(message, config, request) {
    super(message == null ? "canceled" : message, AxiosError_default.ERR_CANCELED, config, request);
    this.name = "CanceledError";
    this.__CANCEL__ = true;
  }
};
var CanceledError_default = CanceledError;

// node_modules/axios/lib/adapters/adapters.js
init_esbuild_shims();

// node_modules/axios/lib/adapters/http.js
init_esbuild_shims();

// node_modules/axios/lib/core/settle.js
init_esbuild_shims();
function settle(resolve, reject, response) {
  const validateStatus2 = response.config.validateStatus;
  if (!response.status || !validateStatus2 || validateStatus2(response.status)) {
    resolve(response);
  } else {
    reject(new AxiosError_default(
      "Request failed with status code " + response.status,
      response.status >= 400 && response.status < 500 ? AxiosError_default.ERR_BAD_REQUEST : AxiosError_default.ERR_BAD_RESPONSE,
      response.config,
      response.request,
      response
    ));
  }
}
__name(settle, "settle");

// node_modules/axios/lib/core/buildFullPath.js
init_esbuild_shims();

// node_modules/axios/lib/helpers/isAbsoluteURL.js
init_esbuild_shims();
function isAbsoluteURL(url2) {
  if (typeof url2 !== "string") {
    return false;
  }
  return /^([a-z][a-z\d+\-.]*:)?\/\//i.test(url2);
}
__name(isAbsoluteURL, "isAbsoluteURL");

// node_modules/axios/lib/helpers/combineURLs.js
init_esbuild_shims();
function combineURLs(baseURL, relativeURL) {
  if (!relativeURL) {
    return baseURL;
  }
  let end = baseURL.length;
  while (end > 0 && baseURL.charCodeAt(end - 1) === 47) {
    end--;
  }
  return baseURL.slice(0, end) + "/" + relativeURL.replace(/^\/+/, "");
}
__name(combineURLs, "combineURLs");

// node_modules/axios/lib/core/buildFullPath.js
var malformedHttpProtocol = /^https?:(?!\/\/)/i;
var httpProtocolControlCharacters = /[\t\n\r]/g;
function stripLeadingC0ControlOrSpace(url2) {
  let i = 0;
  while (i < url2.length && url2.charCodeAt(i) <= 32) {
    i++;
  }
  return url2.slice(i);
}
__name(stripLeadingC0ControlOrSpace, "stripLeadingC0ControlOrSpace");
function normalizeURLForProtocolCheck(url2) {
  return stripLeadingC0ControlOrSpace(url2).replace(httpProtocolControlCharacters, "");
}
__name(normalizeURLForProtocolCheck, "normalizeURLForProtocolCheck");
function redactFragment(fragment) {
  if (!fragment) {
    return fragment;
  }
  return fragment.replace(/(^|&)([^=&]*=)?[^&]+/g, (match, separator, parameterName = "") => {
    return `${separator}${parameterName}${REDACTED}`;
  });
}
__name(redactFragment, "redactFragment");
function redactSensitiveURLParts(url2) {
  const redactedURL = url2.replace(/^(https?:\/{0,2})[^/?#]*@/i, `$1${REDACTED}@`);
  const fragmentIndex = redactedURL.indexOf("#");
  const urlWithoutFragment = fragmentIndex === -1 ? redactedURL : redactedURL.slice(0, fragmentIndex);
  const redactedURLWithoutFragment = urlWithoutFragment.replace(
    /([?&][^=&#]*=)[^&#]*/g,
    `$1${REDACTED}`
  );
  if (fragmentIndex === -1) {
    return redactedURLWithoutFragment;
  }
  return `${redactedURLWithoutFragment}#${redactFragment(redactedURL.slice(fragmentIndex + 1))}`;
}
__name(redactSensitiveURLParts, "redactSensitiveURLParts");
function assertValidHttpProtocolURL(url2, config) {
  if (typeof url2 === "string") {
    const normalizedURL = normalizeURLForProtocolCheck(url2);
    if (malformedHttpProtocol.test(normalizedURL)) {
      throw new AxiosError_default(
        `Invalid URL ${JSON.stringify(redactSensitiveURLParts(normalizedURL))}: missing "//" after protocol`,
        AxiosError_default.ERR_INVALID_URL,
        config
      );
    }
  }
}
__name(assertValidHttpProtocolURL, "assertValidHttpProtocolURL");
function buildFullPath(baseURL, requestedURL, allowAbsoluteUrls, config) {
  assertValidHttpProtocolURL(requestedURL, config);
  let isRelativeUrl = !isAbsoluteURL(requestedURL);
  if (baseURL && (isRelativeUrl || allowAbsoluteUrls === false)) {
    assertValidHttpProtocolURL(baseURL, config);
    return combineURLs(baseURL, requestedURL);
  }
  return requestedURL;
}
__name(buildFullPath, "buildFullPath");

// node_modules/proxy-from-env/index.js
init_esbuild_shims();
var DEFAULT_PORTS = {
  ftp: 21,
  gopher: 70,
  http: 80,
  https: 443,
  ws: 80,
  wss: 443
};
function parseUrl(urlString) {
  try {
    return new URL(urlString);
  } catch {
    return null;
  }
}
__name(parseUrl, "parseUrl");
function getProxyForUrl(url2) {
  var parsedUrl = (typeof url2 === "string" ? parseUrl(url2) : url2) || {};
  var proto = parsedUrl.protocol;
  var hostname = parsedUrl.host;
  var port = parsedUrl.port;
  if (typeof hostname !== "string" || !hostname || typeof proto !== "string") {
    return "";
  }
  proto = proto.split(":", 1)[0];
  hostname = hostname.replace(/:\d*$/, "");
  port = parseInt(port) || DEFAULT_PORTS[proto] || 0;
  if (!shouldProxy(hostname, port)) {
    return "";
  }
  var proxy = getEnv(proto + "_proxy") || getEnv("all_proxy");
  if (proxy && proxy.indexOf("://") === -1) {
    proxy = proto + "://" + proxy;
  }
  return proxy;
}
__name(getProxyForUrl, "getProxyForUrl");
function shouldProxy(hostname, port) {
  var NO_PROXY = getEnv("no_proxy").toLowerCase();
  if (!NO_PROXY) {
    return true;
  }
  if (NO_PROXY === "*") {
    return false;
  }
  return NO_PROXY.split(/[,\s]/).every(function(proxy) {
    if (!proxy) {
      return true;
    }
    var parsedProxy = proxy.match(/^(.+):(\d+)$/);
    var parsedProxyHostname = parsedProxy ? parsedProxy[1] : proxy;
    var parsedProxyPort = parsedProxy ? parseInt(parsedProxy[2]) : 0;
    if (parsedProxyPort && parsedProxyPort !== port) {
      return true;
    }
    if (!/^[.*]/.test(parsedProxyHostname)) {
      return hostname !== parsedProxyHostname;
    }
    if (parsedProxyHostname.charAt(0) === "*") {
      parsedProxyHostname = parsedProxyHostname.slice(1);
    }
    return !hostname.endsWith(parsedProxyHostname);
  });
}
__name(shouldProxy, "shouldProxy");
function getEnv(key) {
  return process.env[key.toLowerCase()] || process.env[key.toUpperCase()] || "";
}
__name(getEnv, "getEnv");

// node_modules/axios/lib/adapters/http.js
var import_https_proxy_agent = __toESM(require_dist(), 1);
var import_follow_redirects = __toESM(require_follow_redirects(), 1);
import http from "http";
import https from "https";
import http22 from "http2";
import util3 from "util";
import { resolve as resolvePath } from "path";
import zlib from "zlib";

// node_modules/axios/lib/env/data.js
init_esbuild_shims();
var VERSION = "1.19.0";

// node_modules/axios/lib/helpers/fromDataURI.js
init_esbuild_shims();

// node_modules/axios/lib/helpers/parseProtocol.js
init_esbuild_shims();
function parseProtocol(url2) {
  const match = /^([-+\w]{1,25}):(?:\/\/)?/.exec(url2);
  return match && match[1] || "";
}
__name(parseProtocol, "parseProtocol");

// node_modules/axios/lib/helpers/fromDataURI.js
var DATA_URL_PATTERN = /^([^,;]+\/[^,;]+)?((?:;[^,;=]+=[^,;]+)*)(;base64)?,([\s\S]*)$/;
function fromDataURI(uri, asBlob, options) {
  const _Blob = options && options.Blob || platform_default.classes.Blob;
  const protocol = parseProtocol(uri);
  if (asBlob === void 0 && _Blob) {
    asBlob = true;
  }
  if (protocol === "data") {
    uri = protocol.length ? uri.slice(protocol.length + 1) : uri;
    const match = DATA_URL_PATTERN.exec(uri);
    if (!match) {
      throw new AxiosError_default("Invalid URL", AxiosError_default.ERR_INVALID_URL);
    }
    const type = match[1];
    const params = match[2];
    const encoding = match[3] ? "base64" : "utf8";
    const body = match[4];
    let mime = "";
    if (type) {
      mime = params ? type + params : type;
    } else if (params) {
      mime = "text/plain" + params;
    }
    const buffer = encoding === "base64" ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), encoding);
    if (asBlob) {
      if (!_Blob) {
        throw new AxiosError_default("Blob is not supported", AxiosError_default.ERR_NOT_SUPPORT);
      }
      return new _Blob([buffer], { type: mime });
    }
    return buffer;
  }
  throw new AxiosError_default("Unsupported protocol " + protocol, AxiosError_default.ERR_NOT_SUPPORT);
}
__name(fromDataURI, "fromDataURI");

// node_modules/axios/lib/adapters/http.js
import stream3 from "stream";

// node_modules/axios/lib/core/setFormDataHeaders.js
init_esbuild_shims();
var FORM_DATA_CONTENT_HEADERS = ["content-type", "content-length"];
function setFormDataHeaders(headers, formHeaders, policy) {
  if (policy !== "content-only") {
    headers.set(formHeaders);
    return;
  }
  Object.entries(formHeaders || {}).forEach(([key, val]) => {
    if (FORM_DATA_CONTENT_HEADERS.includes(key.toLowerCase())) {
      headers.set(key, val);
    }
  });
}
__name(setFormDataHeaders, "setFormDataHeaders");

// node_modules/axios/lib/helpers/AxiosTransformStream.js
init_esbuild_shims();
import stream from "stream";
var kInternals = Symbol("internals");
var AxiosTransformStream = class extends stream.Transform {
  static {
    __name(this, "AxiosTransformStream");
  }
  constructor(options) {
    options = utils_default.toFlatObject(
      options,
      {
        maxRate: 0,
        chunkSize: 64 * 1024,
        minChunkSize: 100,
        timeWindow: 500,
        ticksRate: 2,
        samplesCount: 15
      },
      null,
      (prop, source) => {
        return !utils_default.isUndefined(source[prop]);
      }
    );
    super({
      readableHighWaterMark: options.chunkSize
    });
    const internals = this[kInternals] = {
      timeWindow: options.timeWindow,
      chunkSize: options.chunkSize,
      maxRate: options.maxRate,
      minChunkSize: options.minChunkSize,
      bytesSeen: 0,
      isCaptured: false,
      notifiedBytesLoaded: 0,
      ts: Date.now(),
      bytes: 0,
      onReadCallback: null
    };
    this.on("newListener", (event) => {
      if (event === "progress") {
        if (!internals.isCaptured) {
          internals.isCaptured = true;
        }
      }
    });
  }
  _read(size) {
    const internals = this[kInternals];
    if (internals.onReadCallback) {
      internals.onReadCallback();
    }
    return super._read(size);
  }
  _transform(chunk, encoding, callback) {
    const internals = this[kInternals];
    const maxRate = internals.maxRate;
    const readableHighWaterMark = this.readableHighWaterMark;
    const timeWindow = internals.timeWindow;
    const divider = 1e3 / timeWindow;
    const bytesThreshold = maxRate / divider;
    const minChunkSize = internals.minChunkSize !== false ? Math.max(internals.minChunkSize, bytesThreshold * 0.01) : 0;
    const pushChunk = /* @__PURE__ */ __name((_chunk, _callback) => {
      const bytes = Buffer.byteLength(_chunk);
      internals.bytesSeen += bytes;
      internals.bytes += bytes;
      internals.isCaptured && this.emit("progress", internals.bytesSeen);
      if (this.push(_chunk)) {
        process.nextTick(_callback);
      } else {
        internals.onReadCallback = () => {
          internals.onReadCallback = null;
          process.nextTick(_callback);
        };
      }
    }, "pushChunk");
    const transformChunk = /* @__PURE__ */ __name((_chunk, _callback) => {
      const chunkSize = Buffer.byteLength(_chunk);
      let chunkRemainder = null;
      let maxChunkSize = readableHighWaterMark;
      let bytesLeft;
      let passed = 0;
      if (maxRate) {
        const now = Date.now();
        if (!internals.ts || (passed = now - internals.ts) >= timeWindow) {
          internals.ts = now;
          bytesLeft = bytesThreshold - internals.bytes;
          internals.bytes = bytesLeft < 0 ? -bytesLeft : 0;
          passed = 0;
        }
        bytesLeft = bytesThreshold - internals.bytes;
      }
      if (maxRate) {
        if (bytesLeft <= 0) {
          return setTimeout(() => {
            _callback(null, _chunk);
          }, timeWindow - passed);
        }
        if (bytesLeft < maxChunkSize) {
          maxChunkSize = bytesLeft;
        }
      }
      if (maxChunkSize && chunkSize > maxChunkSize && chunkSize - maxChunkSize > minChunkSize) {
        chunkRemainder = _chunk.subarray(maxChunkSize);
        _chunk = _chunk.subarray(0, maxChunkSize);
      }
      pushChunk(
        _chunk,
        chunkRemainder ? () => {
          process.nextTick(_callback, null, chunkRemainder);
        } : _callback
      );
    }, "transformChunk");
    transformChunk(chunk, /* @__PURE__ */ __name(function transformNextChunk(err, _chunk) {
      if (err) {
        return callback(err);
      }
      if (_chunk) {
        transformChunk(_chunk, transformNextChunk);
      } else {
        callback(null);
      }
    }, "transformNextChunk"));
  }
};
var AxiosTransformStream_default = AxiosTransformStream;

// node_modules/axios/lib/adapters/http.js
import { EventEmitter } from "events";

// node_modules/axios/lib/helpers/formDataToStream.js
init_esbuild_shims();
import util from "util";
import { Readable } from "stream";

// node_modules/axios/lib/helpers/readBlob.js
init_esbuild_shims();
var { asyncIterator } = Symbol;
var readBlob = /* @__PURE__ */ __name(async function* (blob) {
  if (blob.stream) {
    yield* blob.stream();
  } else if (blob.arrayBuffer) {
    yield await blob.arrayBuffer();
  } else if (blob[asyncIterator]) {
    yield* blob[asyncIterator]();
  } else {
    yield blob;
  }
}, "readBlob");
var readBlob_default = readBlob;

// node_modules/axios/lib/helpers/formDataToStream.js
var BOUNDARY_ALPHABET = platform_default.ALPHABET.ALPHA_DIGIT + "-_";
var textEncoder = typeof TextEncoder === "function" ? new TextEncoder() : new util.TextEncoder();
var CRLF = "\r\n";
var CRLF_BYTES = textEncoder.encode(CRLF);
var CRLF_BYTES_COUNT = 2;
var FormDataPart = class {
  static {
    __name(this, "FormDataPart");
  }
  constructor(name, value) {
    const { escapeName } = this.constructor;
    const isStringValue = utils_default.isString(value);
    let headers = `Content-Disposition: form-data; name="${escapeName(name)}"${!isStringValue && value.name ? `; filename="${escapeName(value.name)}"` : ""}${CRLF}`;
    if (isStringValue) {
      value = textEncoder.encode(String(value).replace(/\r?\n|\r\n?/g, CRLF));
    } else {
      const safeType = String(value.type || "application/octet-stream").replace(/[\r\n]/g, "");
      headers += `Content-Type: ${safeType}${CRLF}`;
    }
    this.headers = textEncoder.encode(headers + CRLF);
    this.contentLength = isStringValue ? value.byteLength : value.size;
    this.size = this.headers.byteLength + this.contentLength + CRLF_BYTES_COUNT;
    this.name = name;
    this.value = value;
  }
  async *encode() {
    yield this.headers;
    const { value } = this;
    if (utils_default.isTypedArray(value)) {
      yield value;
    } else {
      yield* readBlob_default(value);
    }
    yield CRLF_BYTES;
  }
  static escapeName(name) {
    return String(name).replace(
      /[\r\n"]/g,
      (match) => ({
        "\r": "%0D",
        "\n": "%0A",
        '"': "%22"
      })[match]
    );
  }
};
var formDataToStream = /* @__PURE__ */ __name((form, headersHandler, options) => {
  const {
    tag = "form-data-boundary",
    size = 25,
    boundary = tag + "-" + platform_default.generateString(size, BOUNDARY_ALPHABET)
  } = options || {};
  if (!utils_default.isFormData(form)) {
    throw new TypeError("FormData instance required");
  }
  if (boundary.length < 1 || boundary.length > 70) {
    throw new Error("boundary must be 1-70 characters long");
  }
  const boundaryBytes = textEncoder.encode("--" + boundary + CRLF);
  const footerBytes = textEncoder.encode("--" + boundary + "--" + CRLF);
  let contentLength = footerBytes.byteLength;
  const parts = Array.from(form.entries()).map(([name, value]) => {
    const part = new FormDataPart(name, value);
    contentLength += part.size;
    return part;
  });
  contentLength += boundaryBytes.byteLength * parts.length;
  contentLength = utils_default.toFiniteNumber(contentLength);
  const computedHeaders = {
    "Content-Type": `multipart/form-data; boundary=${boundary}`
  };
  if (Number.isFinite(contentLength)) {
    computedHeaders["Content-Length"] = contentLength;
  }
  headersHandler && headersHandler(computedHeaders);
  return Readable.from(
    async function* () {
      for (const part of parts) {
        yield boundaryBytes;
        yield* part.encode();
      }
      yield footerBytes;
    }()
  );
}, "formDataToStream");
var formDataToStream_default = formDataToStream;

// node_modules/axios/lib/helpers/ZlibHeaderTransformStream.js
init_esbuild_shims();
import stream2 from "stream";
var ZlibHeaderTransformStream = class extends stream2.Transform {
  static {
    __name(this, "ZlibHeaderTransformStream");
  }
  __transform(chunk, encoding, callback) {
    this.push(chunk);
    callback();
  }
  _transform(chunk, encoding, callback) {
    if (chunk.length !== 0) {
      this._transform = this.__transform;
      if (chunk[0] !== 120) {
        const header = Buffer.alloc(2);
        header[0] = 120;
        header[1] = 156;
        this.push(header, encoding);
      }
    }
    this.__transform(chunk, encoding, callback);
  }
};
var ZlibHeaderTransformStream_default = ZlibHeaderTransformStream;

// node_modules/axios/lib/helpers/Http2Sessions.js
init_esbuild_shims();
import http2 from "http2";
import util2 from "util";
var Http2Sessions = class {
  static {
    __name(this, "Http2Sessions");
  }
  constructor() {
    this.sessions = /* @__PURE__ */ Object.create(null);
  }
  getSession(authority, options) {
    options = Object.assign(
      {
        sessionTimeout: 1e3
      },
      options
    );
    let authoritySessions = this.sessions[authority];
    if (authoritySessions) {
      let len = authoritySessions.length;
      for (let i = 0; i < len; i++) {
        const [sessionHandle, sessionOptions] = authoritySessions[i];
        if (!sessionHandle.destroyed && !sessionHandle.closed && util2.isDeepStrictEqual(sessionOptions, options)) {
          return sessionHandle;
        }
      }
    }
    const session = http2.connect(authority, options);
    let removed;
    let timer;
    const removeSession = /* @__PURE__ */ __name(() => {
      if (removed) {
        return;
      }
      removed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      let entries = authoritySessions, len = entries.length, i = len;
      while (i--) {
        if (entries[i][0] === session) {
          if (len === 1) {
            delete this.sessions[authority];
          } else {
            entries.splice(i, 1);
          }
          if (!session.closed) {
            session.close();
          }
          return;
        }
      }
    }, "removeSession");
    const originalRequestFn = session.request;
    const { sessionTimeout } = options;
    if (sessionTimeout != null) {
      let streamsCount = 0;
      session.request = function() {
        const stream4 = originalRequestFn.apply(this, arguments);
        streamsCount++;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        stream4.once("close", () => {
          if (!--streamsCount) {
            timer = setTimeout(() => {
              timer = null;
              removeSession();
            }, sessionTimeout);
          }
        });
        return stream4;
      };
    }
    session.once("close", removeSession);
    let entry = [session, options];
    authoritySessions ? authoritySessions.push(entry) : authoritySessions = this.sessions[authority] = [entry];
    return session;
  }
};
var Http2Sessions_default = Http2Sessions;

// node_modules/axios/lib/helpers/callbackify.js
init_esbuild_shims();
var callbackify = /* @__PURE__ */ __name((fn, reducer) => {
  return utils_default.isAsyncFn(fn) ? function(...args) {
    const cb = args.pop();
    fn.apply(this, args).then((value) => {
      try {
        reducer ? cb(null, ...reducer(value)) : cb(null, value);
      } catch (err) {
        cb(err);
      }
    }, cb);
  } : fn;
}, "callbackify");
var callbackify_default = callbackify;

// node_modules/axios/lib/helpers/shouldBypassProxy.js
init_esbuild_shims();
var LOOPBACK_HOSTNAMES = /* @__PURE__ */ new Set(["localhost", "0.0.0.0"]);
var isIPv4Loopback = /* @__PURE__ */ __name((host) => {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  if (parts[0] !== "127") return false;
  return parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}, "isIPv4Loopback");
var parseIPv4Octet = /* @__PURE__ */ __name((text) => {
  if (/^0[xX][0-9a-fA-F]+$/.test(text)) {
    const n = parseInt(text.slice(2), 16);
    return Number.isFinite(n) ? n : null;
  }
  if (text.length > 1 && /^0[0-7]+$/.test(text)) {
    const n = parseInt(text, 8);
    return Number.isFinite(n) ? n : null;
  }
  if (text.length > 1 && /^0[0-9]+$/.test(text)) {
    return null;
  }
  if (/^[0-9]+$/.test(text)) {
    const n = parseInt(text, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}, "parseIPv4Octet");
var normalizeIPAddress = /* @__PURE__ */ __name((host) => {
  if (typeof host !== "string" || !host || host.indexOf(":") !== -1) {
    return host;
  }
  let h = host;
  if (h.charAt(0) === "[" && h.charAt(h.length - 1) === "]") {
    h = h.slice(1, -1);
  }
  h = h.replace(/\.+$/, "");
  if (!/^[0-9.xXa-fA-F]+$/.test(h)) return host;
  const parts = h.split(".");
  if (parts.some((p) => p === "")) return host;
  if (parts.length === 4) {
    const octets = parts.map(parseIPv4Octet);
    if (octets.some((n) => n === null || n < 0 || n > 255)) return host;
    return octets.join(".");
  }
  if (parts.length > 4) {
    return host;
  }
  if (parts.length === 1) return host;
  const literalOctets = parts.slice(0, -1);
  const tail = parts[parts.length - 1];
  const tailSlots = 4 - literalOctets.length;
  const tailValue = parseIPv4Octet(tail);
  if (tailValue === null) return host;
  const maxTail = (1 << 8 * tailSlots) - 1;
  if (tailValue < 0 || tailValue > maxTail) return host;
  const tailOctets = new Array(tailSlots).fill(0);
  for (let i = tailSlots - 1, v = tailValue; i >= 0; i--, v >>= 8) {
    tailOctets[i] = v & 255;
  }
  const literal = literalOctets.map(parseIPv4Octet);
  if (literal.some((n) => n === null || n < 0 || n > 255)) return host;
  return [...literal, ...tailOctets].join(".");
}, "normalizeIPAddress");
var isIPv6ZeroGroup = /* @__PURE__ */ __name((group) => /^0{1,4}$/.test(group), "isIPv6ZeroGroup");
var isIPv6Unspecified = /* @__PURE__ */ __name((host) => {
  if (host === "::") return true;
  const compressionIndex = host.indexOf("::");
  if (compressionIndex !== -1) {
    if (compressionIndex !== host.lastIndexOf("::")) return false;
    const left = host.slice(0, compressionIndex);
    const right = host.slice(compressionIndex + 2);
    const leftGroups = left ? left.split(":") : [];
    const rightGroups = right ? right.split(":") : [];
    const explicitGroups = leftGroups.length + rightGroups.length;
    return explicitGroups < 8 && leftGroups.every(isIPv6ZeroGroup) && rightGroups.every(isIPv6ZeroGroup);
  }
  const groups = host.split(":");
  return groups.length === 8 && groups.every(isIPv6ZeroGroup);
}, "isIPv6Unspecified");
var isIPv6Loopback = /* @__PURE__ */ __name((host) => {
  if (host === "::1") return true;
  const v4MappedDotted = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4MappedDotted) return isIPv4Loopback(v4MappedDotted[1]);
  const v4MappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (v4MappedHex) {
    const high = parseInt(v4MappedHex[1], 16);
    return high >= 32512 && high <= 32767;
  }
  const groups = host.split(":");
  if (groups.length === 8) {
    for (let i = 0; i < 7; i++) {
      if (!/^0+$/.test(groups[i])) return false;
    }
    return /^0*1$/.test(groups[7]);
  }
  return false;
}, "isIPv6Loopback");
var isLoopback = /* @__PURE__ */ __name((host) => {
  if (!host) return false;
  if (LOOPBACK_HOSTNAMES.has(host)) return true;
  if (isIPv4Loopback(host)) return true;
  if (isIPv6Unspecified(host)) return true;
  return isIPv6Loopback(host);
}, "isLoopback");
var DEFAULT_PORTS2 = {
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
  ftp: 21
};
var parseNoProxyEntry = /* @__PURE__ */ __name((entry) => {
  let entryHost = entry;
  let entryPort = 0;
  if (entryHost.charAt(0) === "[") {
    const bracketIndex = entryHost.indexOf("]");
    if (bracketIndex !== -1) {
      const host = entryHost.slice(1, bracketIndex);
      const rest = entryHost.slice(bracketIndex + 1);
      if (rest.charAt(0) === ":" && /^\d+$/.test(rest.slice(1))) {
        entryPort = Number.parseInt(rest.slice(1), 10);
      }
      return [host, entryPort];
    }
  }
  const firstColon = entryHost.indexOf(":");
  const lastColon = entryHost.lastIndexOf(":");
  if (firstColon !== -1 && firstColon === lastColon && /^\d+$/.test(entryHost.slice(lastColon + 1))) {
    entryPort = Number.parseInt(entryHost.slice(lastColon + 1), 10);
    entryHost = entryHost.slice(0, lastColon);
  }
  return [entryHost, entryPort];
}, "parseNoProxyEntry");
var IPV4_MAPPED_DOTTED_RE = /^(?:::|(?:0{1,4}:){1,4}:|(?:0{1,4}:){5})ffff:(\d+\.\d+\.\d+\.\d+)$/i;
var IPV4_MAPPED_HEX_RE = /^(?:::|(?:0{1,4}:){1,4}:|(?:0{1,4}:){5})ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;
var unmapIPv4MappedIPv6 = /* @__PURE__ */ __name((host) => {
  if (typeof host !== "string" || host.indexOf(":") === -1) return host;
  const dotted = host.match(IPV4_MAPPED_DOTTED_RE);
  if (dotted) return dotted[1];
  const hex = host.match(IPV4_MAPPED_HEX_RE);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return host;
}, "unmapIPv4MappedIPv6");
var normalizeNoProxyHost = /* @__PURE__ */ __name((hostname) => {
  if (!hostname) {
    return hostname;
  }
  if (hostname.charAt(0) === "[" && hostname.charAt(hostname.length - 1) === "]") {
    hostname = hostname.slice(1, -1);
  }
  const trimmed = hostname.replace(/\.+$/, "");
  const ipv4 = normalizeIPAddress(trimmed);
  if (ipv4 !== trimmed) {
    return ipv4;
  }
  return unmapIPv4MappedIPv6(trimmed);
}, "normalizeNoProxyHost");
function shouldBypassProxy(location) {
  let parsed;
  try {
    parsed = new URL(location);
  } catch (_err) {
    return false;
  }
  const noProxy = (process.env.no_proxy || process.env.NO_PROXY || "").toLowerCase();
  if (!noProxy) {
    return false;
  }
  if (noProxy === "*") {
    return true;
  }
  const port = Number.parseInt(parsed.port, 10) || DEFAULT_PORTS2[parsed.protocol.split(":", 1)[0]] || 0;
  const hostname = normalizeNoProxyHost(parsed.hostname.toLowerCase());
  return noProxy.split(/[\s,]+/).some((entry) => {
    if (!entry) {
      return false;
    }
    if (entry === "*") {
      return true;
    }
    let [entryHost, entryPort] = parseNoProxyEntry(entry);
    entryHost = normalizeNoProxyHost(entryHost);
    if (!entryHost) {
      return false;
    }
    if (entryPort && entryPort !== port) {
      return false;
    }
    if (entryHost.charAt(0) === "*") {
      entryHost = entryHost.slice(1);
    }
    if (entryHost.charAt(0) === ".") {
      return hostname.endsWith(entryHost);
    }
    return hostname === entryHost || isLoopback(hostname) && isLoopback(entryHost);
  });
}
__name(shouldBypassProxy, "shouldBypassProxy");

// node_modules/axios/lib/helpers/progressEventReducer.js
init_esbuild_shims();

// node_modules/axios/lib/helpers/speedometer.js
init_esbuild_shims();
function speedometer(samplesCount, min) {
  samplesCount = samplesCount || 10;
  const bytes = new Array(samplesCount);
  const timestamps = new Array(samplesCount);
  let head = 0;
  let tail = 0;
  let firstSampleTS;
  min = min !== void 0 ? min : 1e3;
  return /* @__PURE__ */ __name(function push(chunkLength) {
    const now = Date.now();
    const startedAt = timestamps[tail];
    if (!firstSampleTS) {
      firstSampleTS = now;
    }
    bytes[head] = chunkLength;
    timestamps[head] = now;
    let i = tail;
    let bytesCount = 0;
    while (i !== head) {
      bytesCount += bytes[i++];
      i = i % samplesCount;
    }
    head = (head + 1) % samplesCount;
    if (head === tail) {
      tail = (tail + 1) % samplesCount;
    }
    if (now - firstSampleTS < min) {
      return;
    }
    const passed = startedAt && now - startedAt;
    return passed ? Math.round(bytesCount * 1e3 / passed) : void 0;
  }, "push");
}
__name(speedometer, "speedometer");
var speedometer_default = speedometer;

// node_modules/axios/lib/helpers/throttle.js
init_esbuild_shims();
function throttle(fn, freq) {
  let timestamp = 0;
  let threshold = 1e3 / freq;
  let lastArgs;
  let timer;
  const invoke = /* @__PURE__ */ __name((args, now = Date.now()) => {
    timestamp = now;
    lastArgs = null;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    fn(...args);
  }, "invoke");
  const throttled = /* @__PURE__ */ __name((...args) => {
    const now = Date.now();
    const passed = now - timestamp;
    if (passed >= threshold) {
      invoke(args, now);
    } else {
      lastArgs = args;
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          invoke(lastArgs);
        }, threshold - passed);
      }
    }
  }, "throttled");
  const flush = /* @__PURE__ */ __name(() => lastArgs && invoke(lastArgs), "flush");
  return [throttled, flush];
}
__name(throttle, "throttle");
var throttle_default = throttle;

// node_modules/axios/lib/helpers/progressEventReducer.js
var progressEventReducer = /* @__PURE__ */ __name((listener, isDownloadStream, freq = 3) => {
  let bytesNotified = 0;
  const _speedometer = speedometer_default(50, 250);
  return throttle_default((e) => {
    if (!e || typeof e.loaded !== "number") {
      return;
    }
    const rawLoaded = e.loaded;
    const total = e.lengthComputable ? e.total : void 0;
    const loaded = Math.max(0, total != null ? Math.min(rawLoaded, total) : rawLoaded);
    const progressBytes = Math.max(0, loaded - bytesNotified);
    const rate = _speedometer(progressBytes);
    bytesNotified = Math.max(bytesNotified, loaded);
    const data = {
      loaded,
      total,
      progress: total ? loaded / total : void 0,
      bytes: progressBytes,
      rate: rate ? rate : void 0,
      estimated: rate && total ? (total - loaded) / rate : void 0,
      event: e,
      lengthComputable: total != null,
      [isDownloadStream ? "download" : "upload"]: true
    };
    listener(data);
  }, freq);
}, "progressEventReducer");
var progressEventDecorator = /* @__PURE__ */ __name((total, throttled) => {
  const lengthComputable = total != null;
  return [
    (loaded) => throttled[0]({
      lengthComputable,
      total,
      loaded
    }),
    throttled[1]
  ];
}, "progressEventDecorator");
var asyncDecorator = /* @__PURE__ */ __name((fn, scheduler = utils_default.asap) => (...args) => scheduler(() => fn(...args)), "asyncDecorator");

// node_modules/axios/lib/helpers/estimateDataURLDecodedBytes.js
init_esbuild_shims();
var isHexDigit = /* @__PURE__ */ __name((charCode) => charCode >= 48 && charCode <= 57 || charCode >= 65 && charCode <= 70 || charCode >= 97 && charCode <= 102, "isHexDigit");
var isPercentEncodedByte = /* @__PURE__ */ __name((str, i, len) => i + 2 < len && isHexDigit(str.charCodeAt(i + 1)) && isHexDigit(str.charCodeAt(i + 2)), "isPercentEncodedByte");
var hexValue = /* @__PURE__ */ __name((charCode) => charCode <= 57 ? charCode - 48 : (charCode & 223) - 55, "hexValue");
var isBase64Char = /* @__PURE__ */ __name((charCode) => charCode >= 65 && charCode <= 90 || // A-Z
charCode >= 97 && charCode <= 122 || // a-z
charCode >= 48 && charCode <= 57 || // 0-9
charCode === 43 || // +
charCode === 47 || // /
charCode === 45 || // - (base64url)
charCode === 95, "isBase64Char");
var isBase64Whitespace = /* @__PURE__ */ __name((charCode) => charCode === 9 || charCode === 10 || charCode === 12 || charCode === 13 || charCode === 32, "isBase64Whitespace");
var base64Bytes = /* @__PURE__ */ __name((significant) => {
  const groups = Math.floor(significant / 4);
  const remainder = significant % 4;
  return groups * 3 + (remainder === 2 ? 1 : remainder === 3 ? 2 : 0);
}, "base64Bytes");
var estimateBase64BufferAllocation = /* @__PURE__ */ __name((body) => {
  const len = body.length;
  let padding = 0;
  if (len > 0 && body.charCodeAt(len - 1) === 61) {
    padding++;
    if (len > 1 && body.charCodeAt(len - 2) === 61) {
      padding++;
    }
  }
  return Math.floor((len - padding) * 3 / 4);
}, "estimateBase64BufferAllocation");
var estimatePercentDecodedBase64Bytes = /* @__PURE__ */ __name((body) => {
  const len = body.length;
  let significant = 0;
  let padding = 0;
  let invalid = false;
  for (let i = 0; i < len; i++) {
    let code = body.charCodeAt(i);
    if (code === 37 && isPercentEncodedByte(body, i, len)) {
      code = hexValue(body.charCodeAt(i + 1)) * 16 + hexValue(body.charCodeAt(i + 2));
      i += 2;
    }
    if (isBase64Whitespace(code)) {
      continue;
    }
    if (code === 61) {
      padding++;
      continue;
    }
    if (!isBase64Char(code) || padding > 0) {
      invalid = true;
      continue;
    }
    significant++;
  }
  if (invalid || padding > 2 || padding > 0 && (significant + padding) % 4 !== 0 || significant % 4 === 1) {
    return estimateBase64BufferAllocation(body);
  }
  return base64Bytes(significant);
}, "estimatePercentDecodedBase64Bytes");
var estimateDataURLBytes = /* @__PURE__ */ __name((url2, estimateBase64) => {
  if (!url2 || typeof url2 !== "string") return 0;
  if (!url2.startsWith("data:")) return 0;
  const comma = url2.indexOf(",");
  if (comma < 0) return 0;
  const meta = url2.slice(5, comma);
  const body = url2.slice(comma + 1);
  const isBase64 = /;base64/i.test(meta);
  if (isBase64) {
    return estimateBase64(body);
  }
  let bytes = 0;
  for (let i = 0, len = body.length; i < len; i++) {
    const c = body.charCodeAt(i);
    if (c === 37 && isPercentEncodedByte(body, i, len)) {
      bytes += 1;
      i += 2;
    } else if (c < 128) {
      bytes += 1;
    } else if (c < 2048) {
      bytes += 2;
    } else if (c >= 55296 && c <= 56319 && i + 1 < len) {
      const next = body.charCodeAt(i + 1);
      if (next >= 56320 && next <= 57343) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}, "estimateDataURLBytes");
function estimateDataURLDecodedBytes(url2) {
  const fragmentIndex = typeof url2 === "string" ? url2.indexOf("#") : -1;
  return estimateDataURLBytes(
    fragmentIndex === -1 ? url2 : url2.slice(0, fragmentIndex),
    estimatePercentDecodedBase64Bytes
  );
}
__name(estimateDataURLDecodedBytes, "estimateDataURLDecodedBytes");
function estimateDataURLBufferAllocation(url2) {
  return estimateDataURLBytes(url2, estimateBase64BufferAllocation);
}
__name(estimateDataURLBufferAllocation, "estimateDataURLBufferAllocation");

// node_modules/axios/lib/adapters/http.js
var zlibOptions = {
  flush: zlib.constants.Z_SYNC_FLUSH,
  finishFlush: zlib.constants.Z_SYNC_FLUSH
};
var brotliOptions = {
  flush: zlib.constants.BROTLI_OPERATION_FLUSH,
  finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH
};
var zstdOptions = {
  flush: zlib.constants.ZSTD_e_flush,
  finishFlush: zlib.constants.ZSTD_e_flush
};
var isBrotliSupported = utils_default.isFunction(zlib.createBrotliDecompress);
var isZstdSupported = utils_default.isFunction(zlib.createZstdDecompress);
var ACCEPT_ENCODING = "gzip, compress, deflate" + (isBrotliSupported ? ", br" : "");
var ACCEPT_ENCODING_WITH_ZSTD = ACCEPT_ENCODING + (isZstdSupported ? ", zstd" : "");
var scheduleProgress = typeof process !== "undefined" && process.nextTick ? process.nextTick.bind(process) : utils_default.asap;
var { http: httpFollow, https: httpsFollow } = import_follow_redirects.default;
var isHttps = /https:?/;
var kAxiosSocketListener = Symbol("axios.http.socketListener");
var kAxiosCurrentReq = Symbol("axios.http.currentReq");
var kAxiosInstalledTunnel = Symbol("axios.http.installedTunnel");
var tunnelingAgentCache = /* @__PURE__ */ new Map();
var tunnelingAgentCacheUser = /* @__PURE__ */ new WeakMap();
var NODE_NATIVE_ENV_PROXY_SUPPORT = {
  22: 21,
  24: 5
};
function isNodeNativeEnvProxySupported(nodeVersion = process.versions && process.versions.node) {
  if (!nodeVersion) {
    return false;
  }
  const [major, minor] = nodeVersion.split(".").map((part) => Number(part));
  if (!Number.isInteger(major) || !Number.isInteger(minor)) {
    return false;
  }
  if (major > 24) {
    return true;
  }
  return NODE_NATIVE_ENV_PROXY_SUPPORT[major] != null && minor >= NODE_NATIVE_ENV_PROXY_SUPPORT[major];
}
__name(isNodeNativeEnvProxySupported, "isNodeNativeEnvProxySupported");
function isNodeEnvProxyEnabled(agent, nodeVersion = process.versions && process.versions.node) {
  if (!isNodeNativeEnvProxySupported(nodeVersion)) {
    return false;
  }
  const agentOptions = agent && agent.options;
  return Boolean(
    agentOptions && utils_default.hasOwnProp(agentOptions, "proxyEnv") && agentOptions.proxyEnv != null
  );
}
__name(isNodeEnvProxyEnabled, "isNodeEnvProxyEnabled");
function getProxyEnvAgent(options, configHttpAgent, configHttpsAgent) {
  return isHttps.test(options.protocol) ? configHttpsAgent || https.globalAgent : configHttpAgent || http.globalAgent;
}
__name(getProxyEnvAgent, "getProxyEnvAgent");
function getTunnelingAgent(agentOptions, userHttpsAgent) {
  const key = agentOptions.protocol + "//" + agentOptions.hostname + ":" + (agentOptions.port || "") + "#" + (agentOptions.auth || "");
  const cache = userHttpsAgent ? tunnelingAgentCacheUser.get(userHttpsAgent) || tunnelingAgentCacheUser.set(userHttpsAgent, /* @__PURE__ */ new Map()).get(userHttpsAgent) : tunnelingAgentCache;
  let agent = cache.get(key);
  if (agent) return agent;
  const merged = userHttpsAgent && userHttpsAgent.options ? { ...userHttpsAgent.options, ...agentOptions } : agentOptions;
  agent = new import_https_proxy_agent.default(merged);
  if (userHttpsAgent && userHttpsAgent.options) {
    const originTLSOptions = { ...userHttpsAgent.options };
    const callback = agent.callback;
    agent.callback = /* @__PURE__ */ __name(function axiosTunnelingAgentCallback(req, opts) {
      return callback.call(this, req, { ...originTLSOptions, ...opts });
    }, "axiosTunnelingAgentCallback");
  }
  agent[kAxiosInstalledTunnel] = true;
  cache.set(key, agent);
  return agent;
}
__name(getTunnelingAgent, "getTunnelingAgent");
var supportedProtocols = platform_default.protocols.map((protocol) => {
  return protocol + ":";
});
var decodeURIComponentSafe = /* @__PURE__ */ __name((value) => {
  if (!utils_default.isString(value)) {
    return value;
  }
  try {
    return decodeURIComponent(value);
  } catch (error) {
    return value;
  }
}, "decodeURIComponentSafe");
var flushOnFinish = /* @__PURE__ */ __name((stream4, [throttled, flush]) => {
  stream4.on("end", flush).on("error", flush);
  return throttled;
}, "flushOnFinish");
var http2Sessions = new Http2Sessions_default();
function dispatchBeforeRedirect(options, responseDetails, requestDetails) {
  if (options.beforeRedirects.proxy) {
    options.beforeRedirects.proxy(options);
  }
  if (options.beforeRedirects.auth) {
    options.beforeRedirects.auth(options);
  }
  if (options.beforeRedirects.sensitiveHeaders) {
    options.beforeRedirects.sensitiveHeaders(options, requestDetails);
  }
  if (options.beforeRedirects.config) {
    options.beforeRedirects.config(options, responseDetails, requestDetails);
  }
}
__name(dispatchBeforeRedirect, "dispatchBeforeRedirect");
function stripMatchingHeaders(headers, sensitiveSet) {
  if (!headers) {
    return;
  }
  Object.keys(headers).forEach((header) => {
    if (sensitiveSet.has(header.toLowerCase())) {
      delete headers[header];
    }
  });
}
__name(stripMatchingHeaders, "stripMatchingHeaders");
function isSameOriginRedirect(redirectOptions, requestDetails) {
  if (!requestDetails) {
    return false;
  }
  try {
    return new URL(requestDetails.url).origin === new URL(redirectOptions.href).origin;
  } catch (e) {
    return false;
  }
}
__name(isSameOriginRedirect, "isSameOriginRedirect");
function setProxy(options, configProxy, location, isRedirect, configHttpsAgent, configHttpAgent) {
  let proxy = configProxy;
  const proxyEnvAgent = getProxyEnvAgent(options, configHttpAgent, configHttpsAgent);
  if (!proxy && proxy !== false && !isNodeEnvProxyEnabled(proxyEnvAgent)) {
    const proxyUrl = getProxyForUrl(location);
    if (proxyUrl) {
      if (!shouldBypassProxy(location)) {
        proxy = new URL(proxyUrl);
      }
    }
  }
  if (isRedirect && options.headers) {
    for (const name of Object.keys(options.headers)) {
      if (name.toLowerCase() === "proxy-authorization") {
        delete options.headers[name];
      }
    }
  }
  if (isRedirect && options.agent && options.agent[kAxiosInstalledTunnel]) {
    options.agent = void 0;
  }
  if (proxy) {
    const isProxyURL = proxy instanceof URL;
    const readProxyField = /* @__PURE__ */ __name((key) => isProxyURL || utils_default.hasOwnProp(proxy, key) ? proxy[key] : void 0, "readProxyField");
    const proxyUsername = readProxyField("username");
    const proxyPassword = readProxyField("password");
    let proxyAuth = utils_default.hasOwnProp(proxy, "auth") ? proxy.auth : void 0;
    if (proxyUsername) {
      proxyAuth = (proxyUsername || "") + ":" + (proxyPassword || "");
    }
    if (proxyAuth) {
      const authIsObject = typeof proxyAuth === "object";
      const authUsername = authIsObject && utils_default.hasOwnProp(proxyAuth, "username") ? proxyAuth.username : void 0;
      const authPassword = authIsObject && utils_default.hasOwnProp(proxyAuth, "password") ? proxyAuth.password : void 0;
      const validProxyAuth = Boolean(authUsername || authPassword);
      if (validProxyAuth) {
        proxyAuth = (authUsername || "") + ":" + (authPassword || "");
      } else if (authIsObject) {
        throw new AxiosError_default("Invalid proxy authorization", AxiosError_default.ERR_BAD_OPTION, { proxy });
      }
    }
    const targetIsHttps = isHttps.test(options.protocol);
    if (targetIsHttps) {
      if (!(configHttpsAgent instanceof import_https_proxy_agent.default)) {
        const proxyHost = readProxyField("hostname") || readProxyField("host");
        const proxyPort = readProxyField("port");
        const rawProxyProtocol = readProxyField("protocol");
        const normalizedProtocol = rawProxyProtocol ? rawProxyProtocol.includes(":") ? rawProxyProtocol : `${rawProxyProtocol}:` : "http:";
        const proxyHostForURL = proxyHost && proxyHost.includes(":") && !proxyHost.startsWith("[") ? `[${proxyHost}]` : proxyHost;
        const proxyURL = new URL(
          `${normalizedProtocol}//${proxyHostForURL}${proxyPort ? ":" + proxyPort : ""}`
        );
        const agentOptions = {
          protocol: proxyURL.protocol,
          hostname: proxyURL.hostname.replace(/^\[|\]$/g, ""),
          port: proxyURL.port,
          auth: proxyAuth && typeof proxyAuth === "string" ? proxyAuth : void 0
        };
        if (proxyURL.protocol === "https:") {
          agentOptions.ALPNProtocols = ["http/1.1"];
        }
        const tunnelingAgent = getTunnelingAgent(agentOptions, configHttpsAgent);
        options.agent = tunnelingAgent;
        if (options.agents) {
          options.agents.https = tunnelingAgent;
        }
      }
    } else {
      if (proxyAuth) {
        const base64 = Buffer.from(proxyAuth, "utf8").toString("base64");
        options.headers["Proxy-Authorization"] = "Basic " + base64;
      }
      let hasUserHostHeader = false;
      for (const name of Object.keys(options.headers)) {
        if (name.toLowerCase() === "host") {
          hasUserHostHeader = true;
          break;
        }
      }
      if (!hasUserHostHeader) {
        options.headers.host = options.hostname + (options.port ? ":" + options.port : "");
      }
      const proxyHost = readProxyField("hostname") || readProxyField("host");
      options.hostname = proxyHost;
      options.host = proxyHost;
      options.port = readProxyField("port");
      options.path = location;
      const proxyProtocol = readProxyField("protocol");
      if (proxyProtocol) {
        options.protocol = proxyProtocol.includes(":") ? proxyProtocol : `${proxyProtocol}:`;
      }
    }
  }
  options.beforeRedirects.proxy = /* @__PURE__ */ __name(function beforeRedirect(redirectOptions) {
    setProxy(
      redirectOptions,
      configProxy,
      redirectOptions.href,
      true,
      configHttpsAgent,
      configHttpAgent
    );
  }, "beforeRedirect");
}
__name(setProxy, "setProxy");
var isHttpAdapterSupported = typeof process !== "undefined" && utils_default.kindOf(process) === "process";
var wrapAsync = /* @__PURE__ */ __name((asyncExecutor) => {
  return new Promise((resolve, reject) => {
    let onDone;
    let isDone;
    const done = /* @__PURE__ */ __name((value, isRejected) => {
      if (isDone) return;
      isDone = true;
      onDone && onDone(value, isRejected);
    }, "done");
    const _resolve = /* @__PURE__ */ __name((value) => {
      done(value);
      resolve(value);
    }, "_resolve");
    const _reject = /* @__PURE__ */ __name((reason) => {
      done(reason, true);
      reject(reason);
    }, "_reject");
    asyncExecutor(_resolve, _reject, (onDoneHandler) => onDone = onDoneHandler).catch(_reject);
  });
}, "wrapAsync");
var resolveFamily = /* @__PURE__ */ __name(({ address, family }) => {
  if (!utils_default.isString(address)) {
    throw TypeError("address must be a string");
  }
  return {
    address,
    family: family || (address.indexOf(".") < 0 ? 6 : 4)
  };
}, "resolveFamily");
var buildAddressEntry = /* @__PURE__ */ __name((address, family) => resolveFamily(utils_default.isObject(address) ? address : { address, family }), "buildAddressEntry");
var http2Transport = {
  request(options, cb) {
    const authority = options.protocol + "//" + options.hostname + ":" + (options.port || (options.protocol === "https:" ? 443 : 80));
    const { http2Options, headers } = options;
    const session = http2Sessions.getSession(authority, http2Options);
    const { HTTP2_HEADER_SCHEME, HTTP2_HEADER_METHOD, HTTP2_HEADER_PATH, HTTP2_HEADER_STATUS } = http22.constants;
    const http2Headers = {
      [HTTP2_HEADER_SCHEME]: options.protocol.replace(":", ""),
      [HTTP2_HEADER_METHOD]: options.method,
      [HTTP2_HEADER_PATH]: options.path
    };
    utils_default.forEach(headers, (header, name) => {
      name.charAt(0) !== ":" && (http2Headers[name] = header);
    });
    const req = session.request(http2Headers);
    req.once("response", (responseHeaders) => {
      const response = req;
      responseHeaders = Object.assign({}, responseHeaders);
      const status = responseHeaders[HTTP2_HEADER_STATUS];
      delete responseHeaders[HTTP2_HEADER_STATUS];
      response.headers = responseHeaders;
      response.statusCode = +status;
      cb(response);
    });
    return req;
  }
};
var http_default = isHttpAdapterSupported && /* @__PURE__ */ __name(function httpAdapter(config) {
  return wrapAsync(/* @__PURE__ */ __name(async function dispatchHttpRequest(resolve, reject, onDone) {
    const own2 = /* @__PURE__ */ __name((key) => utils_default.getSafeProp(config, key), "own");
    const transitional2 = own2("transitional") || transitional_default;
    let data = own2("data");
    let lookup = own2("lookup");
    let family = own2("family");
    let httpVersion = own2("httpVersion");
    if (httpVersion === void 0) httpVersion = 1;
    let http2Options = own2("http2Options");
    const httpAgent = own2("httpAgent");
    const httpsAgent = own2("httpsAgent");
    const configProxy = own2("proxy");
    const responseType = own2("responseType");
    const responseEncoding = own2("responseEncoding");
    const socketPath = own2("socketPath");
    const method = own2("method").toUpperCase();
    const maxRedirects = own2("maxRedirects");
    const maxBodyLength = own2("maxBodyLength");
    const maxContentLength = own2("maxContentLength");
    const decompress = own2("decompress");
    let isDone;
    let rejected = false;
    let req;
    let connectPhaseTimer;
    httpVersion = +httpVersion;
    if (Number.isNaN(httpVersion)) {
      throw TypeError(`Invalid protocol version: '${config.httpVersion}' is not a number`);
    }
    if (httpVersion !== 1 && httpVersion !== 2) {
      throw TypeError(`Unsupported protocol version '${httpVersion}'`);
    }
    const isHttp2 = httpVersion === 2;
    if (lookup) {
      const _lookup = callbackify_default(lookup, (value) => utils_default.isArray(value) ? value : [value]);
      lookup = /* @__PURE__ */ __name((hostname, opt, cb) => {
        _lookup(hostname, opt, (err, arg0, arg1) => {
          if (err) {
            return cb(err);
          }
          const addresses = utils_default.isArray(arg0) ? arg0.map((addr) => buildAddressEntry(addr)) : [buildAddressEntry(arg0, arg1)];
          opt.all ? cb(err, addresses) : cb(err, addresses[0].address, addresses[0].family);
        });
      }, "lookup");
    }
    const abortEmitter = new EventEmitter();
    function abort(reason) {
      try {
        abortEmitter.emit(
          "abort",
          !reason || reason.type ? new CanceledError_default(null, config, req) : reason
        );
      } catch (err) {
      }
    }
    __name(abort, "abort");
    function clearConnectPhaseTimer() {
      if (connectPhaseTimer) {
        clearTimeout(connectPhaseTimer);
        connectPhaseTimer = null;
      }
    }
    __name(clearConnectPhaseTimer, "clearConnectPhaseTimer");
    function createTimeoutError() {
      const configTimeout = own2("timeout");
      let timeoutErrorMessage = configTimeout ? "timeout of " + configTimeout + "ms exceeded" : "timeout exceeded";
      const configTimeoutErrorMessage = own2("timeoutErrorMessage");
      if (configTimeoutErrorMessage) {
        timeoutErrorMessage = configTimeoutErrorMessage;
      }
      return new AxiosError_default(
        timeoutErrorMessage,
        transitional2.clarifyTimeoutError ? AxiosError_default.ETIMEDOUT : AxiosError_default.ECONNABORTED,
        config,
        req
      );
    }
    __name(createTimeoutError, "createTimeoutError");
    abortEmitter.once("abort", reject);
    const onFinished = /* @__PURE__ */ __name(() => {
      clearConnectPhaseTimer();
      if (config.cancelToken) {
        config.cancelToken.unsubscribe(abort);
      }
      if (config.signal) {
        config.signal.removeEventListener("abort", abort);
      }
      abortEmitter.removeAllListeners();
    }, "onFinished");
    if (config.cancelToken || config.signal) {
      config.cancelToken && config.cancelToken.subscribe(abort);
      if (config.signal) {
        config.signal.aborted ? abort() : config.signal.addEventListener("abort", abort);
      }
    }
    onDone((response, isRejected) => {
      isDone = true;
      clearConnectPhaseTimer();
      if (isRejected) {
        rejected = true;
        onFinished();
        return;
      }
      const { data: data2 } = response;
      if (data2 instanceof stream3.Readable || data2 instanceof stream3.Duplex) {
        const offListeners = stream3.finished(data2, () => {
          offListeners();
          onFinished();
        });
      } else {
        onFinished();
      }
    });
    const fullPath = buildFullPath(own2("baseURL"), own2("url"), own2("allowAbsoluteUrls"), config);
    const urlBase = socketPath ? "http://localhost" : platform_default.hasBrowserEnv ? platform_default.origin : void 0;
    const parsed = new URL(fullPath, urlBase);
    const protocol = parsed.protocol || supportedProtocols[0];
    if (protocol === "data:") {
      if (maxContentLength > -1) {
        const dataUrl = String(own2("url") || fullPath || "");
        const estimated = estimateDataURLBufferAllocation(dataUrl);
        if (estimated > maxContentLength) {
          return reject(
            new AxiosError_default(
              "maxContentLength size of " + maxContentLength + " exceeded",
              AxiosError_default.ERR_BAD_RESPONSE,
              config
            )
          );
        }
      }
      let convertedData;
      if (method !== "GET") {
        return settle(resolve, reject, {
          status: 405,
          statusText: "method not allowed",
          headers: {},
          config
        });
      }
      try {
        convertedData = fromDataURI(own2("url"), responseType === "blob", {
          Blob: config.env && config.env.Blob
        });
      } catch (err) {
        throw AxiosError_default.from(err, AxiosError_default.ERR_BAD_REQUEST, config);
      }
      if (responseType === "text") {
        convertedData = convertedData.toString(responseEncoding);
        if (!responseEncoding || responseEncoding === "utf8") {
          convertedData = utils_default.stripBOM(convertedData);
        }
      } else if (responseType === "stream") {
        convertedData = stream3.Readable.from(convertedData);
      }
      return settle(resolve, reject, {
        data: convertedData,
        status: 200,
        statusText: "OK",
        headers: new AxiosHeaders_default(),
        config
      });
    }
    if (supportedProtocols.indexOf(protocol) === -1) {
      return reject(
        new AxiosError_default("Unsupported protocol " + protocol, AxiosError_default.ERR_BAD_REQUEST, config)
      );
    }
    const headers = AxiosHeaders_default.from(config.headers).normalize();
    headers.set("User-Agent", "axios/" + VERSION, false);
    const { onUploadProgress, onDownloadProgress } = config;
    const maxRate = config.maxRate;
    let maxUploadRate = void 0;
    let maxDownloadRate = void 0;
    if (utils_default.isSpecCompliantForm(data)) {
      const userBoundary = headers.getContentType(/boundary=([-_\w\d]{10,70})/i);
      data = formDataToStream_default(
        data,
        (formHeaders) => {
          headers.set(formHeaders);
        },
        {
          tag: `axios-${VERSION}-boundary`,
          boundary: userBoundary && userBoundary[1] || void 0
        }
      );
    } else if (utils_default.isFormData(data) && utils_default.isFunction(data.getHeaders) && data.getHeaders !== Object.prototype.getHeaders) {
      setFormDataHeaders(headers, data.getHeaders(), own2("formDataHeaderPolicy"));
      if (!headers.hasContentLength()) {
        try {
          const knownLength = await util3.promisify(data.getLength).call(data);
          Number.isFinite(knownLength) && knownLength >= 0 && headers.setContentLength(knownLength);
        } catch (e) {
        }
      }
    } else if (utils_default.isBlob(data) || utils_default.isFile(data)) {
      data.size && headers.setContentType(data.type || "application/octet-stream");
      headers.setContentLength(data.size || 0);
      data = stream3.Readable.from(readBlob_default(data));
    } else if (data && !utils_default.isStream(data)) {
      if (Buffer.isBuffer(data)) {
      } else if (utils_default.isArrayBuffer(data)) {
        data = Buffer.from(new Uint8Array(data));
      } else if (utils_default.isString(data)) {
        data = Buffer.from(data, "utf-8");
      } else {
        return reject(
          new AxiosError_default(
            "Data after transformation must be a string, an ArrayBuffer, a Buffer, or a Stream",
            AxiosError_default.ERR_BAD_REQUEST,
            config
          )
        );
      }
      headers.setContentLength(data.length, false);
      if (maxBodyLength > -1 && data.length > maxBodyLength) {
        return reject(
          new AxiosError_default(
            "Request body larger than maxBodyLength limit",
            AxiosError_default.ERR_BAD_REQUEST,
            config
          )
        );
      }
    }
    const contentLength = utils_default.toFiniteNumber(headers.getContentLength());
    if (utils_default.isArray(maxRate)) {
      maxUploadRate = maxRate[0];
      maxDownloadRate = maxRate[1];
    } else {
      maxUploadRate = maxDownloadRate = maxRate;
    }
    if (data && (onUploadProgress || maxUploadRate)) {
      if (!utils_default.isStream(data)) {
        data = stream3.Readable.from(data, { objectMode: false });
      }
      data = stream3.pipeline(
        [
          data,
          new AxiosTransformStream_default({
            maxRate: utils_default.toFiniteNumber(maxUploadRate)
          })
        ],
        utils_default.noop
      );
      onUploadProgress && data.on(
        "progress",
        flushOnFinish(
          data,
          progressEventDecorator(
            contentLength,
            progressEventReducer(asyncDecorator(onUploadProgress, scheduleProgress), false, 3)
          )
        )
      );
    }
    let auth = void 0;
    const configAuth = own2("auth");
    if (configAuth) {
      const username = utils_default.getSafeProp(configAuth, "username") || "";
      const password = utils_default.getSafeProp(configAuth, "password") || "";
      auth = username + ":" + password;
    }
    if (!auth && (parsed.username || parsed.password)) {
      const urlUsername = decodeURIComponentSafe(parsed.username);
      const urlPassword = decodeURIComponentSafe(parsed.password);
      auth = urlUsername + ":" + urlPassword;
    }
    auth && headers.delete("authorization");
    let path;
    try {
      path = buildURL(
        parsed.pathname + parsed.search,
        own2("params"),
        own2("paramsSerializer")
      ).replace(/^\?/, "");
    } catch (err) {
      return reject(
        AxiosError_default.from(err, AxiosError_default.ERR_BAD_REQUEST, config, null, null, {
          url: own2("url"),
          exists: true
        })
      );
    }
    headers.set(
      "Accept-Encoding",
      utils_default.hasOwnProp(transitional2, "advertiseZstdAcceptEncoding") && transitional2.advertiseZstdAcceptEncoding === true ? ACCEPT_ENCODING_WITH_ZSTD : ACCEPT_ENCODING,
      false
    );
    const options = Object.assign(/* @__PURE__ */ Object.create(null), {
      path,
      method,
      headers: toByteStringHeaderObject(headers),
      agents: { http: httpAgent, https: httpsAgent },
      auth,
      protocol,
      family,
      beforeRedirect: dispatchBeforeRedirect,
      beforeRedirects: /* @__PURE__ */ Object.create(null),
      http2Options
    });
    !utils_default.isUndefined(lookup) && (options.lookup = lookup);
    if (socketPath) {
      if (typeof socketPath !== "string") {
        return reject(
          new AxiosError_default("socketPath must be a string", AxiosError_default.ERR_BAD_OPTION_VALUE, config)
        );
      }
      const allowedSocketPaths = own2("allowedSocketPaths");
      if (allowedSocketPaths != null) {
        const allowed = Array.isArray(allowedSocketPaths) ? allowedSocketPaths : [allowedSocketPaths];
        const resolvedSocket = resolvePath(socketPath);
        const isAllowed = allowed.some(
          (entry) => typeof entry === "string" && resolvePath(entry) === resolvedSocket
        );
        if (!isAllowed) {
          return reject(
            new AxiosError_default(
              `socketPath "${socketPath}" is not permitted by allowedSocketPaths`,
              AxiosError_default.ERR_BAD_OPTION_VALUE,
              config
            )
          );
        }
      }
      options.socketPath = socketPath;
    } else {
      options.hostname = parsed.hostname.startsWith("[") ? parsed.hostname.slice(1, -1) : parsed.hostname;
      options.port = parsed.port;
      setProxy(
        options,
        configProxy,
        protocol + "//" + parsed.hostname + (parsed.port ? ":" + parsed.port : "") + options.path,
        false,
        httpsAgent,
        httpAgent
      );
    }
    let transport;
    let isNativeTransport = false;
    let transportEnforcesMaxBodyLength = false;
    const isHttpsRequest = isHttps.test(options.protocol);
    if (options.agent == null) {
      options.agent = isHttpsRequest ? httpsAgent : httpAgent;
    }
    if (isHttp2) {
      transport = http2Transport;
    } else {
      const configTransport = own2("transport");
      if (configTransport) {
        transport = configTransport;
      } else if (maxRedirects === 0) {
        transport = isHttpsRequest ? https : http;
        isNativeTransport = true;
      } else {
        transportEnforcesMaxBodyLength = true;
        options.sensitiveHeaders = [];
        if (maxRedirects) {
          options.maxRedirects = maxRedirects;
        }
        const configBeforeRedirect = own2("beforeRedirect");
        if (configBeforeRedirect) {
          options.beforeRedirects.config = configBeforeRedirect;
        }
        if (auth) {
          const requestOrigin = parsed.origin;
          const authToRestore = auth;
          options.beforeRedirects.auth = /* @__PURE__ */ __name(function beforeRedirectAuth(redirectOptions) {
            try {
              if (new URL(redirectOptions.href).origin === requestOrigin) {
                redirectOptions.auth = authToRestore;
              }
            } catch (e) {
            }
          }, "beforeRedirectAuth");
        }
        const sensitiveHeaders = own2("sensitiveHeaders");
        if (sensitiveHeaders != null) {
          if (!utils_default.isArray(sensitiveHeaders)) {
            return reject(
              new AxiosError_default(
                "sensitiveHeaders must be an array of strings",
                AxiosError_default.ERR_BAD_OPTION_VALUE,
                config
              )
            );
          }
          const sensitiveSet = /* @__PURE__ */ new Set();
          for (const header of sensitiveHeaders) {
            if (!utils_default.isString(header)) {
              return reject(
                new AxiosError_default(
                  "sensitiveHeaders must be an array of strings",
                  AxiosError_default.ERR_BAD_OPTION_VALUE,
                  config
                )
              );
            }
            sensitiveSet.add(header.toLowerCase());
          }
          if (sensitiveSet.size) {
            options.sensitiveHeaders = Array.from(sensitiveSet);
            options.beforeRedirects.sensitiveHeaders = /* @__PURE__ */ __name(function beforeRedirectSensitiveHeaders(redirectOptions, requestDetails) {
              if (!isSameOriginRedirect(redirectOptions, requestDetails)) {
                stripMatchingHeaders(redirectOptions.headers, sensitiveSet);
              }
            }, "beforeRedirectSensitiveHeaders");
          }
        }
        transport = isHttpsRequest ? httpsFollow : httpFollow;
      }
    }
    if (maxBodyLength > -1) {
      options.maxBodyLength = maxBodyLength;
    } else {
      options.maxBodyLength = Infinity;
    }
    options.insecureHTTPParser = Boolean(own2("insecureHTTPParser"));
    req = transport.request(options, /* @__PURE__ */ __name(function handleResponse(res) {
      clearConnectPhaseTimer();
      if (req.destroyed) return;
      const streams = [res];
      const responseLength = utils_default.toFiniteNumber(res.headers["content-length"]);
      if (onDownloadProgress || maxDownloadRate) {
        const transformStream = new AxiosTransformStream_default({
          maxRate: utils_default.toFiniteNumber(maxDownloadRate)
        });
        onDownloadProgress && transformStream.on(
          "progress",
          flushOnFinish(
            transformStream,
            progressEventDecorator(
              responseLength,
              progressEventReducer(asyncDecorator(onDownloadProgress, scheduleProgress), true, 3)
            )
          )
        );
        streams.push(transformStream);
      }
      let responseStream = res;
      const lastRequest = res.req || req;
      if (decompress !== false && res.headers["content-encoding"]) {
        if (method === "HEAD" || res.statusCode === 204) {
          delete res.headers["content-encoding"];
        }
        switch ((res.headers["content-encoding"] || "").toLowerCase()) {
          /*eslint default-case:0*/
          case "gzip":
          case "x-gzip":
          case "compress":
          case "x-compress":
            streams.push(zlib.createUnzip(zlibOptions));
            delete res.headers["content-encoding"];
            break;
          case "deflate":
            streams.push(new ZlibHeaderTransformStream_default());
            streams.push(zlib.createUnzip(zlibOptions));
            delete res.headers["content-encoding"];
            break;
          case "br":
            if (isBrotliSupported) {
              streams.push(zlib.createBrotliDecompress(brotliOptions));
              delete res.headers["content-encoding"];
            }
            break;
          case "zstd":
            if (isZstdSupported) {
              streams.push(zlib.createZstdDecompress(zstdOptions));
              delete res.headers["content-encoding"];
            }
            break;
        }
      }
      responseStream = streams.length > 1 ? stream3.pipeline(streams, utils_default.noop) : streams[0];
      const response = {
        status: res.statusCode,
        statusText: res.statusMessage,
        headers: new AxiosHeaders_default(res.headers),
        config,
        request: lastRequest
      };
      if (responseType === "stream") {
        if (maxContentLength > -1) {
          const limit = maxContentLength;
          const source = responseStream;
          async function* enforceMaxContentLength() {
            let totalResponseBytes = 0;
            for await (const chunk of source) {
              totalResponseBytes += chunk.length;
              if (totalResponseBytes > limit) {
                throw new AxiosError_default(
                  "maxContentLength size of " + limit + " exceeded",
                  AxiosError_default.ERR_BAD_RESPONSE,
                  config,
                  lastRequest
                );
              }
              yield chunk;
            }
          }
          __name(enforceMaxContentLength, "enforceMaxContentLength");
          responseStream = stream3.Readable.from(enforceMaxContentLength(), {
            objectMode: false
          });
        }
        response.data = responseStream;
        settle(resolve, reject, response);
      } else {
        const responseBuffer = [];
        let totalResponseBytes = 0;
        responseStream.on("data", /* @__PURE__ */ __name(function handleStreamData(chunk) {
          responseBuffer.push(chunk);
          totalResponseBytes += chunk.length;
          if (maxContentLength > -1 && totalResponseBytes > maxContentLength) {
            rejected = true;
            responseStream.destroy();
            abort(
              new AxiosError_default(
                "maxContentLength size of " + maxContentLength + " exceeded",
                AxiosError_default.ERR_BAD_RESPONSE,
                config,
                lastRequest
              )
            );
          }
        }, "handleStreamData"));
        responseStream.on("aborted", /* @__PURE__ */ __name(function handlerStreamAborted() {
          if (rejected) {
            return;
          }
          const err = new AxiosError_default(
            "stream has been aborted",
            AxiosError_default.ERR_BAD_RESPONSE,
            config,
            lastRequest,
            response
          );
          responseStream.destroy(err);
          reject(err);
        }, "handlerStreamAborted"));
        responseStream.on("error", /* @__PURE__ */ __name(function handleStreamError(err) {
          if (rejected) return;
          reject(AxiosError_default.from(err, null, config, lastRequest, response));
        }, "handleStreamError"));
        responseStream.on("end", /* @__PURE__ */ __name(function handleStreamEnd() {
          try {
            let responseData = responseBuffer.length === 1 ? responseBuffer[0] : Buffer.concat(responseBuffer);
            if (responseType !== "arraybuffer") {
              responseData = responseData.toString(responseEncoding);
              if (!responseEncoding || responseEncoding === "utf8") {
                responseData = utils_default.stripBOM(responseData);
              }
            }
            response.data = responseData;
          } catch (err) {
            return reject(AxiosError_default.from(err, null, config, response.request, response));
          }
          settle(resolve, reject, response);
        }, "handleStreamEnd"));
      }
      abortEmitter.once("abort", (err) => {
        if (!responseStream.destroyed) {
          responseStream.emit("error", err);
          responseStream.destroy();
        }
      });
    }, "handleResponse"));
    abortEmitter.once("abort", (err) => {
      if (req.close) {
        req.close();
      } else {
        req.destroy(err);
      }
    });
    req.on("error", /* @__PURE__ */ __name(function handleRequestError(err) {
      reject(AxiosError_default.from(err, null, config, req));
    }, "handleRequestError"));
    const boundSockets = /* @__PURE__ */ new Set();
    req.on("socket", /* @__PURE__ */ __name(function handleRequestSocket(socket) {
      if (typeof socket.setKeepAlive === "function") {
        socket.setKeepAlive(true, 1e3 * 60);
      }
      if (!socket[kAxiosSocketListener]) {
        socket.on("error", /* @__PURE__ */ __name(function handleSocketError(err) {
          const current = socket[kAxiosCurrentReq];
          if (current && !current.destroyed) {
            current.destroy(err);
          }
        }, "handleSocketError"));
        socket[kAxiosSocketListener] = true;
      }
      socket[kAxiosCurrentReq] = req;
      boundSockets.add(socket);
    }, "handleRequestSocket"));
    req.once("close", /* @__PURE__ */ __name(function clearCurrentReq() {
      clearConnectPhaseTimer();
      for (const socket of boundSockets) {
        if (socket[kAxiosCurrentReq] === req) {
          socket[kAxiosCurrentReq] = null;
        }
      }
      boundSockets.clear();
    }, "clearCurrentReq"));
    if (own2("timeout")) {
      const timeout = parseInt(own2("timeout"), 10);
      if (Number.isNaN(timeout)) {
        abort(
          new AxiosError_default(
            "error trying to parse `config.timeout` to int",
            AxiosError_default.ERR_BAD_OPTION_VALUE,
            config,
            req
          )
        );
        return;
      }
      const handleTimeout = /* @__PURE__ */ __name(function handleTimeout2() {
        if (isDone) return;
        abort(createTimeoutError());
      }, "handleTimeout");
      if (isNativeTransport && timeout > 0) {
        connectPhaseTimer = setTimeout(handleTimeout, timeout);
      }
      req.setTimeout(timeout, handleTimeout);
    } else {
      req.setTimeout(0);
    }
    if (utils_default.isStream(data)) {
      let ended = false;
      let errored = false;
      data.on("end", () => {
        ended = true;
      });
      data.once("error", (err) => {
        errored = true;
        req.destroy(err);
      });
      data.on("close", () => {
        if (!ended && !errored) {
          abort(new CanceledError_default("Request stream has been aborted", config, req));
        }
      });
      let uploadStream = data;
      if (maxBodyLength > -1 && !transportEnforcesMaxBodyLength) {
        const limit = maxBodyLength;
        let bytesSent = 0;
        uploadStream = stream3.pipeline(
          [
            data,
            new stream3.Transform({
              transform(chunk, _enc, cb) {
                bytesSent += chunk.length;
                if (bytesSent > limit) {
                  return cb(
                    new AxiosError_default(
                      "Request body larger than maxBodyLength limit",
                      AxiosError_default.ERR_BAD_REQUEST,
                      config,
                      req
                    )
                  );
                }
                cb(null, chunk);
              }
            })
          ],
          utils_default.noop
        );
        uploadStream.on("error", (err) => {
          if (!req.destroyed) req.destroy(err);
        });
      }
      uploadStream.pipe(req);
    } else {
      data && req.write(data);
      req.end();
    }
  }, "dispatchHttpRequest"));
}, "httpAdapter");

// node_modules/axios/lib/adapters/xhr.js
init_esbuild_shims();

// node_modules/axios/lib/helpers/resolveConfig.js
init_esbuild_shims();

// node_modules/axios/lib/helpers/isURLSameOrigin.js
init_esbuild_shims();
var isURLSameOrigin_default = platform_default.hasStandardBrowserEnv ? /* @__PURE__ */ ((origin2, isMSIE) => (url2) => {
  url2 = new URL(url2, platform_default.origin);
  return origin2.protocol === url2.protocol && origin2.host === url2.host && (isMSIE || origin2.port === url2.port);
})(
  new URL(platform_default.origin),
  platform_default.navigator && /(msie|trident)/i.test(platform_default.navigator.userAgent)
) : () => true;

// node_modules/axios/lib/helpers/cookies.js
init_esbuild_shims();
var cookies_default = platform_default.hasStandardBrowserEnv ? (
  // Standard browser envs support document.cookie
  {
    write(name, value, expires, path, domain, secure, sameSite) {
      if (typeof document === "undefined") return;
      const cookie = [`${name}=${encodeURIComponent(value)}`];
      if (utils_default.isNumber(expires)) {
        cookie.push(`expires=${new Date(expires).toUTCString()}`);
      }
      if (utils_default.isString(path)) {
        cookie.push(`path=${path}`);
      }
      if (utils_default.isString(domain)) {
        cookie.push(`domain=${domain}`);
      }
      if (secure === true) {
        cookie.push("secure");
      }
      if (utils_default.isString(sameSite)) {
        cookie.push(`SameSite=${sameSite}`);
      }
      document.cookie = cookie.join("; ");
    },
    read(name) {
      if (typeof document === "undefined") return null;
      const cookies = document.cookie.split(";");
      for (let i = 0; i < cookies.length; i++) {
        const cookie = cookies[i].replace(/^\s+/, "");
        const eq = cookie.indexOf("=");
        if (eq !== -1 && cookie.slice(0, eq) === name) {
          try {
            return decodeURIComponent(cookie.slice(eq + 1));
          } catch (e) {
            return cookie.slice(eq + 1);
          }
        }
      }
      return null;
    },
    remove(name) {
      this.write(name, "", Date.now() - 864e5, "/");
    }
  }
) : (
  // Non-standard browser env (web workers, react-native) lack needed support.
  {
    write() {
    },
    read() {
      return null;
    },
    remove() {
    }
  }
);

// node_modules/axios/lib/core/mergeConfig.js
init_esbuild_shims();
var headersToObject = /* @__PURE__ */ __name((thing) => thing instanceof AxiosHeaders_default ? { ...thing } : thing, "headersToObject");
var ownEnumerableKeys = /* @__PURE__ */ __name((thing) => {
  if (Object.getOwnPropertySymbols && Object.getOwnPropertyDescriptor) {
    return Object.keys(thing).concat(
      Object.getOwnPropertySymbols(thing).filter(
        (symbol) => Object.getOwnPropertyDescriptor(thing, symbol).enumerable
      )
    );
  }
  return Object.keys(thing);
}, "ownEnumerableKeys");
function mergeConfig(config1, config2) {
  config1 = config1 || {};
  config2 = config2 || {};
  const config = /* @__PURE__ */ Object.create(null);
  Object.defineProperty(config, "hasOwnProperty", {
    // Null-proto descriptor so a polluted Object.prototype.get cannot turn
    // this data descriptor into an accessor descriptor on the way in.
    __proto__: null,
    value: Object.prototype.hasOwnProperty,
    enumerable: false,
    writable: true,
    configurable: true
  });
  function getMergedValue(target, source, prop, caseless) {
    if (utils_default.isPlainObject(target) && utils_default.isPlainObject(source)) {
      return utils_default.merge.call({ caseless }, target, source);
    } else if (utils_default.isPlainObject(source)) {
      return utils_default.merge({}, source);
    } else if (utils_default.isArray(source)) {
      return source.slice();
    }
    return source;
  }
  __name(getMergedValue, "getMergedValue");
  function mergeDeepProperties(a, b, prop, caseless) {
    if (!utils_default.isUndefined(b)) {
      return getMergedValue(a, b, prop, caseless);
    } else if (!utils_default.isUndefined(a)) {
      return getMergedValue(void 0, a, prop, caseless);
    }
  }
  __name(mergeDeepProperties, "mergeDeepProperties");
  function valueFromConfig2(a, b) {
    if (!utils_default.isUndefined(b)) {
      return getMergedValue(void 0, b);
    }
  }
  __name(valueFromConfig2, "valueFromConfig2");
  function defaultToConfig2(a, b) {
    if (!utils_default.isUndefined(b)) {
      return getMergedValue(void 0, b);
    } else if (!utils_default.isUndefined(a)) {
      return getMergedValue(void 0, a);
    }
  }
  __name(defaultToConfig2, "defaultToConfig2");
  function getMergedTransitionalOption(prop) {
    const transitional2 = utils_default.hasOwnProp(config2, "transitional") ? config2.transitional : void 0;
    if (!utils_default.isUndefined(transitional2)) {
      if (utils_default.isPlainObject(transitional2)) {
        if (utils_default.hasOwnProp(transitional2, prop)) {
          return transitional2[prop];
        }
      } else {
        return void 0;
      }
    }
    const transitional1 = utils_default.hasOwnProp(config1, "transitional") ? config1.transitional : void 0;
    if (utils_default.isPlainObject(transitional1) && utils_default.hasOwnProp(transitional1, prop)) {
      return transitional1[prop];
    }
    return void 0;
  }
  __name(getMergedTransitionalOption, "getMergedTransitionalOption");
  function mergeDirectKeys(a, b, prop) {
    if (utils_default.hasOwnProp(config2, prop)) {
      return getMergedValue(a, b);
    } else if (utils_default.hasOwnProp(config1, prop)) {
      return getMergedValue(void 0, a);
    }
  }
  __name(mergeDirectKeys, "mergeDirectKeys");
  const mergeMap = {
    url: valueFromConfig2,
    method: valueFromConfig2,
    data: valueFromConfig2,
    baseURL: defaultToConfig2,
    transformRequest: defaultToConfig2,
    transformResponse: defaultToConfig2,
    paramsSerializer: defaultToConfig2,
    timeout: defaultToConfig2,
    timeoutMessage: defaultToConfig2,
    withCredentials: defaultToConfig2,
    withXSRFToken: defaultToConfig2,
    adapter: defaultToConfig2,
    responseType: defaultToConfig2,
    xsrfCookieName: defaultToConfig2,
    xsrfHeaderName: defaultToConfig2,
    onUploadProgress: defaultToConfig2,
    onDownloadProgress: defaultToConfig2,
    decompress: defaultToConfig2,
    maxContentLength: defaultToConfig2,
    maxBodyLength: defaultToConfig2,
    beforeRedirect: defaultToConfig2,
    transport: defaultToConfig2,
    httpAgent: defaultToConfig2,
    httpsAgent: defaultToConfig2,
    cancelToken: defaultToConfig2,
    socketPath: defaultToConfig2,
    allowedSocketPaths: defaultToConfig2,
    responseEncoding: defaultToConfig2,
    validateStatus: mergeDirectKeys,
    headers: /* @__PURE__ */ __name((a, b, prop) => mergeDeepProperties(headersToObject(a), headersToObject(b), prop, true), "headers")
  };
  utils_default.forEach(ownEnumerableKeys({ ...config1, ...config2 }), /* @__PURE__ */ __name(function computeConfigValue(prop) {
    if (prop === "__proto__" || prop === "constructor" || prop === "prototype") return;
    const merge2 = utils_default.hasOwnProp(mergeMap, prop) ? mergeMap[prop] : mergeDeepProperties;
    const a = utils_default.hasOwnProp(config1, prop) ? config1[prop] : void 0;
    const b = utils_default.hasOwnProp(config2, prop) ? config2[prop] : void 0;
    const configValue = merge2(a, b, prop);
    utils_default.isUndefined(configValue) && merge2 !== mergeDirectKeys || (config[prop] = configValue);
  }, "computeConfigValue"));
  if (utils_default.hasOwnProp(config2, "validateStatus") && utils_default.isUndefined(config2.validateStatus) && getMergedTransitionalOption("validateStatusUndefinedResolves") === false) {
    if (utils_default.hasOwnProp(config1, "validateStatus")) {
      config.validateStatus = getMergedValue(void 0, config1.validateStatus);
    } else {
      delete config.validateStatus;
    }
  }
  return config;
}
__name(mergeConfig, "mergeConfig");

// node_modules/axios/lib/helpers/resolveConfig.js
var encodeUTF8 = /* @__PURE__ */ __name((str) => encodeURIComponent(str).replace(
  /%([0-9A-F]{2})/gi,
  (_, hex) => String.fromCharCode(parseInt(hex, 16))
), "encodeUTF8");
function resolveConfig(config) {
  const newConfig = mergeConfig({}, config);
  const own2 = /* @__PURE__ */ __name((key) => utils_default.hasOwnProp(newConfig, key) ? newConfig[key] : void 0, "own");
  const data = own2("data");
  let withXSRFToken = own2("withXSRFToken");
  const xsrfHeaderName = own2("xsrfHeaderName");
  const xsrfCookieName = own2("xsrfCookieName");
  let headers = own2("headers");
  const auth = own2("auth");
  const baseURL = own2("baseURL");
  const allowAbsoluteUrls = own2("allowAbsoluteUrls");
  const url2 = own2("url");
  newConfig.headers = headers = AxiosHeaders_default.from(headers);
  newConfig.url = buildURL(
    buildFullPath(baseURL, url2, allowAbsoluteUrls, newConfig),
    own2("params"),
    own2("paramsSerializer")
  );
  if (auth) {
    const username = utils_default.getSafeProp(auth, "username") || "";
    const password = utils_default.getSafeProp(auth, "password") || "";
    try {
      headers.set(
        "Authorization",
        "Basic " + btoa(username + ":" + (password ? encodeUTF8(password) : ""))
      );
    } catch (e) {
      throw AxiosError_default.from(e, AxiosError_default.ERR_BAD_OPTION_VALUE, config);
    }
  }
  if (utils_default.isFormData(data)) {
    if (platform_default.hasStandardBrowserEnv || platform_default.hasStandardBrowserWebWorkerEnv || utils_default.isReactNative(data)) {
      headers.setContentType(void 0);
    } else if (utils_default.isFunction(data.getHeaders)) {
      setFormDataHeaders(headers, data.getHeaders(), own2("formDataHeaderPolicy"));
    }
  }
  if (platform_default.hasStandardBrowserEnv) {
    if (utils_default.isFunction(withXSRFToken)) {
      withXSRFToken = withXSRFToken(newConfig);
    }
    const shouldSendXSRF = withXSRFToken === true || withXSRFToken == null && isURLSameOrigin_default(newConfig.url);
    if (shouldSendXSRF) {
      const xsrfValue = xsrfHeaderName && xsrfCookieName && cookies_default.read(xsrfCookieName);
      if (xsrfValue) {
        headers.set(xsrfHeaderName, xsrfValue);
      }
    }
  }
  return newConfig;
}
__name(resolveConfig, "resolveConfig");
var resolveConfig_default = resolveConfig;

// node_modules/axios/lib/adapters/xhr.js
var isXHRAdapterSupported = typeof XMLHttpRequest !== "undefined";
var xhr_default = isXHRAdapterSupported && function(config) {
  return new Promise(/* @__PURE__ */ __name(function dispatchXhrRequest(resolve, reject) {
    const _config = resolveConfig_default(config);
    let requestData = _config.data;
    const requestHeaders = AxiosHeaders_default.from(_config.headers).normalize();
    let { responseType, onUploadProgress, onDownloadProgress } = _config;
    let onCanceled;
    let uploadThrottled, downloadThrottled;
    let flushUpload, flushDownload;
    function done() {
      flushUpload && flushUpload();
      flushDownload && flushDownload();
      _config.cancelToken && _config.cancelToken.unsubscribe(onCanceled);
      _config.signal && _config.signal.removeEventListener("abort", onCanceled);
    }
    __name(done, "done");
    let request = new XMLHttpRequest();
    request.open(_config.method.toUpperCase(), _config.url, true);
    request.timeout = _config.timeout;
    function onloadend() {
      if (!request) {
        return;
      }
      const responseHeaders = AxiosHeaders_default.from(
        "getAllResponseHeaders" in request && request.getAllResponseHeaders()
      );
      const responseData = !responseType || responseType === "text" || responseType === "json" ? request.responseText : request.response;
      const response = {
        data: responseData,
        status: request.status,
        statusText: request.statusText,
        headers: responseHeaders,
        config,
        request
      };
      settle(
        /* @__PURE__ */ __name(function _resolve(value) {
          resolve(value);
          done();
        }, "_resolve"),
        /* @__PURE__ */ __name(function _reject(err) {
          reject(err);
          done();
        }, "_reject"),
        response
      );
      request = null;
    }
    __name(onloadend, "onloadend");
    if ("onloadend" in request) {
      request.onloadend = onloadend;
    } else {
      request.onreadystatechange = /* @__PURE__ */ __name(function handleLoad() {
        if (!request || request.readyState !== 4) {
          return;
        }
        if (request.status === 0 && !(request.responseURL && request.responseURL.startsWith("file:"))) {
          return;
        }
        setTimeout(onloadend);
      }, "handleLoad");
    }
    request.onabort = /* @__PURE__ */ __name(function handleAbort() {
      if (!request) {
        return;
      }
      reject(new AxiosError_default("Request aborted", AxiosError_default.ECONNABORTED, config, request));
      done();
      request = null;
    }, "handleAbort");
    request.onerror = /* @__PURE__ */ __name(function handleError(event) {
      const msg = event && event.message ? event.message : "Network Error";
      const err = new AxiosError_default(msg, AxiosError_default.ERR_NETWORK, config, request);
      err.event = event || null;
      reject(err);
      done();
      request = null;
    }, "handleError");
    request.ontimeout = /* @__PURE__ */ __name(function handleTimeout() {
      let timeoutErrorMessage = _config.timeout ? "timeout of " + _config.timeout + "ms exceeded" : "timeout exceeded";
      const transitional2 = _config.transitional || transitional_default;
      if (_config.timeoutErrorMessage) {
        timeoutErrorMessage = _config.timeoutErrorMessage;
      }
      reject(
        new AxiosError_default(
          timeoutErrorMessage,
          transitional2.clarifyTimeoutError ? AxiosError_default.ETIMEDOUT : AxiosError_default.ECONNABORTED,
          config,
          request
        )
      );
      done();
      request = null;
    }, "handleTimeout");
    requestData === void 0 && requestHeaders.setContentType(null);
    if ("setRequestHeader" in request) {
      utils_default.forEach(toByteStringHeaderObject(requestHeaders), /* @__PURE__ */ __name(function setRequestHeader(val, key) {
        request.setRequestHeader(key, val);
      }, "setRequestHeader"));
    }
    if (!utils_default.isUndefined(_config.withCredentials)) {
      request.withCredentials = !!_config.withCredentials;
    }
    if (responseType && responseType !== "json") {
      request.responseType = _config.responseType;
    }
    if (onDownloadProgress) {
      [downloadThrottled, flushDownload] = progressEventReducer(onDownloadProgress, true);
      request.addEventListener("progress", downloadThrottled);
    }
    if (onUploadProgress && request.upload) {
      [uploadThrottled, flushUpload] = progressEventReducer(onUploadProgress);
      request.upload.addEventListener("progress", uploadThrottled);
      request.upload.addEventListener("loadend", flushUpload);
    }
    if (_config.cancelToken || _config.signal) {
      onCanceled = /* @__PURE__ */ __name((cancel) => {
        if (!request) {
          return;
        }
        reject(!cancel || cancel.type ? new CanceledError_default(null, config, request) : cancel);
        request.abort();
        done();
        request = null;
      }, "onCanceled");
      _config.cancelToken && _config.cancelToken.subscribe(onCanceled);
      if (_config.signal) {
        _config.signal.aborted ? onCanceled() : _config.signal.addEventListener("abort", onCanceled);
      }
    }
    const protocol = parseProtocol(_config.url);
    if (protocol && !platform_default.protocols.includes(protocol)) {
      reject(
        new AxiosError_default(
          "Unsupported protocol " + protocol + ":",
          AxiosError_default.ERR_BAD_REQUEST,
          config
        )
      );
      done();
      return;
    }
    request.send(requestData || null);
  }, "dispatchXhrRequest"));
};

// node_modules/axios/lib/adapters/fetch.js
init_esbuild_shims();

// node_modules/axios/lib/helpers/composeSignals.js
init_esbuild_shims();
var composeSignals = /* @__PURE__ */ __name((signals, timeout) => {
  signals = signals ? signals.filter(Boolean) : [];
  if (!timeout && !signals.length) {
    return;
  }
  const controller = new AbortController();
  let aborted = false;
  const onabort = /* @__PURE__ */ __name(function(reason) {
    if (!aborted) {
      aborted = true;
      unsubscribe();
      const err = reason instanceof Error ? reason : this.reason;
      controller.abort(
        err instanceof AxiosError_default ? err : new CanceledError_default(err instanceof Error ? err.message : err)
      );
    }
  }, "onabort");
  let timer = timeout && setTimeout(() => {
    timer = null;
    onabort(new AxiosError_default(`timeout of ${timeout}ms exceeded`, AxiosError_default.ETIMEDOUT));
  }, timeout);
  const unsubscribe = /* @__PURE__ */ __name(() => {
    if (!signals) {
      return;
    }
    timer && clearTimeout(timer);
    timer = null;
    signals.forEach((signal2) => {
      signal2.unsubscribe ? signal2.unsubscribe(onabort) : signal2.removeEventListener("abort", onabort);
    });
    signals = null;
  }, "unsubscribe");
  signals.forEach((signal2) => {
    if (aborted) {
      return;
    }
    if (signal2.aborted) {
      onabort.call(signal2);
      return;
    }
    signal2.addEventListener("abort", onabort, { once: true });
  });
  const { signal } = controller;
  signal.unsubscribe = () => utils_default.asap(unsubscribe);
  return signal;
}, "composeSignals");
var composeSignals_default = composeSignals;

// node_modules/axios/lib/helpers/trackStream.js
init_esbuild_shims();
var streamChunk = /* @__PURE__ */ __name(function* (chunk, chunkSize) {
  let len = chunk.byteLength;
  if (!chunkSize || len < chunkSize) {
    yield chunk;
    return;
  }
  let pos = 0;
  let end;
  while (pos < len) {
    end = pos + chunkSize;
    yield chunk.slice(pos, end);
    pos = end;
  }
}, "streamChunk");
var readBytes = /* @__PURE__ */ __name(async function* (iterable, chunkSize) {
  for await (const chunk of readStream(iterable)) {
    yield* streamChunk(chunk, chunkSize);
  }
}, "readBytes");
var readStream = /* @__PURE__ */ __name(async function* (stream4) {
  if (stream4[Symbol.asyncIterator]) {
    yield* stream4;
    return;
  }
  const reader = stream4.getReader();
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      yield value;
    }
  } finally {
    await reader.cancel();
  }
}, "readStream");
var trackStream = /* @__PURE__ */ __name((stream4, chunkSize, onProgress, onFinish) => {
  const iterator2 = readBytes(stream4, chunkSize);
  let bytes = 0;
  let done;
  let _onFinish = /* @__PURE__ */ __name((e) => {
    if (!done) {
      done = true;
      onFinish && onFinish(e);
    }
  }, "_onFinish");
  return new ReadableStream(
    {
      async pull(controller) {
        try {
          const { done: done2, value } = await iterator2.next();
          if (done2) {
            _onFinish();
            controller.close();
            return;
          }
          let len = value.byteLength;
          if (onProgress) {
            let loadedBytes = bytes += len;
            onProgress(loadedBytes);
          }
          controller.enqueue(new Uint8Array(value));
        } catch (err) {
          _onFinish(err);
          throw err;
        }
      },
      cancel(reason) {
        _onFinish(reason);
        return iterator2.return();
      }
    },
    {
      highWaterMark: 2
    }
  );
}, "trackStream");

// node_modules/axios/lib/adapters/fetch.js
var DEFAULT_CHUNK_SIZE = 64 * 1024;
var { isFunction: isFunction2 } = utils_default;
var encodeUTF82 = /* @__PURE__ */ __name((str) => encodeURIComponent(str).replace(
  /%([0-9A-F]{2})/gi,
  (_, hex) => String.fromCharCode(parseInt(hex, 16))
), "encodeUTF8");
var decodeURIComponentSafe2 = /* @__PURE__ */ __name((value) => {
  if (!utils_default.isString(value)) {
    return value;
  }
  try {
    return decodeURIComponent(value);
  } catch (error) {
    return value;
  }
}, "decodeURIComponentSafe");
var test = /* @__PURE__ */ __name((fn, ...args) => {
  try {
    return !!fn(...args);
  } catch (e) {
    return false;
  }
}, "test");
var maybeWithAuthCredentials = /* @__PURE__ */ __name((url2) => {
  const protocolIndex = url2.indexOf("://");
  let urlToCheck = url2;
  if (protocolIndex !== -1) {
    urlToCheck = urlToCheck.slice(protocolIndex + 3);
  }
  return urlToCheck.includes("@") || urlToCheck.includes(":");
}, "maybeWithAuthCredentials");
var factory = /* @__PURE__ */ __name((env) => {
  const globalObject = utils_default.global !== void 0 && utils_default.global !== null ? utils_default.global : globalThis;
  const { ReadableStream: ReadableStream2, TextEncoder: TextEncoder2 } = globalObject;
  env = utils_default.merge.call(
    {
      skipUndefined: true
    },
    {
      Request: globalObject.Request,
      Response: globalObject.Response
    },
    env
  );
  const { fetch: envFetch, Request, Response } = env;
  const isFetchSupported = envFetch ? isFunction2(envFetch) : typeof fetch === "function";
  const isRequestSupported = isFunction2(Request);
  const isResponseSupported = isFunction2(Response);
  if (!isFetchSupported) {
    return false;
  }
  const isReadableStreamSupported = isFetchSupported && isFunction2(ReadableStream2);
  const encodeText = isFetchSupported && (typeof TextEncoder2 === "function" ? /* @__PURE__ */ ((encoder) => (str) => encoder.encode(str))(new TextEncoder2()) : async (str) => new Uint8Array(await new Request(str).arrayBuffer()));
  const supportsRequestStream = isRequestSupported && isReadableStreamSupported && test(() => {
    let duplexAccessed = false;
    const request = new Request(platform_default.origin, {
      body: new ReadableStream2(),
      method: "POST",
      get duplex() {
        duplexAccessed = true;
        return "half";
      }
    });
    const hasContentType = request.headers.has("Content-Type");
    if (request.body != null) {
      request.body.cancel();
    }
    return duplexAccessed && !hasContentType;
  });
  const supportsResponseStream = isResponseSupported && isReadableStreamSupported && test(() => utils_default.isReadableStream(new Response("").body));
  const resolvers = {
    stream: supportsResponseStream && ((res) => res.body)
  };
  isFetchSupported && (() => {
    ["text", "arrayBuffer", "blob", "formData", "stream"].forEach((type) => {
      !resolvers[type] && (resolvers[type] = (res, config) => {
        let method = res && res[type];
        if (method) {
          return method.call(res);
        }
        throw new AxiosError_default(
          `Response type '${type}' is not supported`,
          AxiosError_default.ERR_NOT_SUPPORT,
          config
        );
      });
    });
  })();
  const getBodyLength = /* @__PURE__ */ __name(async (body) => {
    if (body == null) {
      return 0;
    }
    if (utils_default.isBlob(body)) {
      return body.size;
    }
    if (utils_default.isSpecCompliantForm(body)) {
      const _request = new Request(platform_default.origin, {
        method: "POST",
        body
      });
      return (await _request.arrayBuffer()).byteLength;
    }
    if (utils_default.isArrayBufferView(body) || utils_default.isArrayBuffer(body)) {
      return body.byteLength;
    }
    if (utils_default.isURLSearchParams(body)) {
      body = body + "";
    }
    if (utils_default.isString(body)) {
      return (await encodeText(body)).byteLength;
    }
  }, "getBodyLength");
  const resolveBodyLength = /* @__PURE__ */ __name(async (headers, body) => {
    const length = utils_default.toFiniteNumber(headers.getContentLength());
    return length == null ? getBodyLength(body) : length;
  }, "resolveBodyLength");
  return async (config) => {
    let {
      url: url2,
      method,
      data,
      signal,
      cancelToken,
      timeout,
      onDownloadProgress,
      onUploadProgress,
      responseType,
      headers,
      withCredentials = "same-origin",
      fetchOptions,
      maxContentLength,
      maxBodyLength
    } = resolveConfig_default(config);
    const hasMaxContentLength = utils_default.isNumber(maxContentLength) && maxContentLength > -1;
    const hasMaxBodyLength = utils_default.isNumber(maxBodyLength) && maxBodyLength > -1;
    const own2 = /* @__PURE__ */ __name((key) => utils_default.hasOwnProp(config, key) ? config[key] : void 0, "own");
    let _fetch = envFetch || fetch;
    responseType = responseType ? (responseType + "").toLowerCase() : "text";
    let composedSignal = composeSignals_default(
      [signal, cancelToken && cancelToken.toAbortSignal()],
      timeout
    );
    let request = null;
    const unsubscribe = composedSignal && composedSignal.unsubscribe && (() => {
      composedSignal.unsubscribe();
    });
    let requestContentLength;
    let pendingBodyError = null;
    const maxBodyLengthError = /* @__PURE__ */ __name(() => new AxiosError_default(
      "Request body larger than maxBodyLength limit",
      AxiosError_default.ERR_BAD_REQUEST,
      config,
      request
    ), "maxBodyLengthError");
    try {
      let auth = void 0;
      const configAuth = own2("auth");
      if (configAuth) {
        const username = utils_default.getSafeProp(configAuth, "username") || "";
        const password = utils_default.getSafeProp(configAuth, "password") || "";
        auth = {
          username,
          password
        };
      }
      if (maybeWithAuthCredentials(url2)) {
        const parsedURL = new URL(url2, platform_default.origin);
        if (!auth && (parsedURL.username || parsedURL.password)) {
          const urlUsername = decodeURIComponentSafe2(parsedURL.username);
          const urlPassword = decodeURIComponentSafe2(parsedURL.password);
          auth = {
            username: urlUsername,
            password: urlPassword
          };
        }
        if (parsedURL.username || parsedURL.password) {
          parsedURL.username = "";
          parsedURL.password = "";
          url2 = parsedURL.href;
        }
      }
      if (auth) {
        headers.delete("authorization");
        headers.set(
          "Authorization",
          "Basic " + btoa(encodeUTF82((auth.username || "") + ":" + (auth.password || "")))
        );
      }
      if (hasMaxContentLength && typeof url2 === "string" && url2.startsWith("data:")) {
        const estimated = estimateDataURLDecodedBytes(url2);
        if (estimated > maxContentLength) {
          throw new AxiosError_default(
            "maxContentLength size of " + maxContentLength + " exceeded",
            AxiosError_default.ERR_BAD_RESPONSE,
            config,
            request
          );
        }
      }
      if (hasMaxBodyLength && method !== "get" && method !== "head") {
        const outboundLength = await getBodyLength(data);
        if (typeof outboundLength === "number" && isFinite(outboundLength)) {
          requestContentLength = outboundLength;
          if (outboundLength > maxBodyLength) {
            throw maxBodyLengthError();
          }
        }
      }
      const mustEnforceStreamBody = hasMaxBodyLength && (utils_default.isReadableStream(data) || utils_default.isStream(data));
      const trackRequestStream = /* @__PURE__ */ __name((stream4, onProgress, flush) => trackStream(
        stream4,
        DEFAULT_CHUNK_SIZE,
        (loadedBytes) => {
          if (hasMaxBodyLength && loadedBytes > maxBodyLength) {
            throw pendingBodyError = maxBodyLengthError();
          }
          onProgress && onProgress(loadedBytes);
        },
        flush
      ), "trackRequestStream");
      if (supportsRequestStream && method !== "get" && method !== "head" && (onUploadProgress || mustEnforceStreamBody)) {
        requestContentLength = requestContentLength == null ? await resolveBodyLength(headers, data) : requestContentLength;
        if (requestContentLength !== 0 || mustEnforceStreamBody) {
          let _request = new Request(url2, {
            method: "POST",
            body: data,
            duplex: "half"
          });
          let contentTypeHeader;
          if (utils_default.isFormData(data) && (contentTypeHeader = _request.headers.get("content-type"))) {
            headers.setContentType(contentTypeHeader);
          }
          if (_request.body) {
            const [onProgress, flush] = onUploadProgress && progressEventDecorator(
              requestContentLength,
              progressEventReducer(asyncDecorator(onUploadProgress))
            ) || [];
            data = trackRequestStream(_request.body, onProgress, flush);
          }
        }
      } else if (mustEnforceStreamBody && !isRequestSupported && isReadableStreamSupported && method !== "get" && method !== "head") {
        data = trackRequestStream(data);
      } else if (mustEnforceStreamBody && isRequestSupported && !supportsRequestStream && method !== "get" && method !== "head") {
        throw new AxiosError_default(
          "Stream request bodies are not supported by the current fetch implementation",
          AxiosError_default.ERR_NOT_SUPPORT,
          config,
          request
        );
      }
      if (!utils_default.isString(withCredentials)) {
        withCredentials = withCredentials ? "include" : "omit";
      }
      const isCredentialsSupported = isRequestSupported && "credentials" in Request.prototype;
      if (utils_default.isFormData(data)) {
        const contentType = headers.getContentType();
        if (contentType && /^multipart\/form-data/i.test(contentType) && !/boundary=/i.test(contentType)) {
          headers.delete("content-type");
        }
      }
      headers.set("User-Agent", "axios/" + VERSION, false);
      const resolvedOptions = {
        ...fetchOptions,
        signal: composedSignal,
        method: method.toUpperCase(),
        headers: toByteStringHeaderObject(headers.normalize()),
        body: data,
        duplex: "half",
        credentials: isCredentialsSupported ? withCredentials : void 0
      };
      request = isRequestSupported && new Request(url2, resolvedOptions);
      let response = await (isRequestSupported ? _fetch(request, fetchOptions) : _fetch(url2, resolvedOptions));
      const responseHeaders = AxiosHeaders_default.from(response.headers);
      if (hasMaxContentLength) {
        const declaredLength = utils_default.toFiniteNumber(responseHeaders.getContentLength());
        if (declaredLength != null && declaredLength > maxContentLength) {
          throw new AxiosError_default(
            "maxContentLength size of " + maxContentLength + " exceeded",
            AxiosError_default.ERR_BAD_RESPONSE,
            config,
            request
          );
        }
      }
      const isStreamResponse = supportsResponseStream && (responseType === "stream" || responseType === "response");
      if (supportsResponseStream && response.body && (onDownloadProgress || hasMaxContentLength || isStreamResponse && unsubscribe)) {
        const options = {};
        ["status", "statusText", "headers"].forEach((prop) => {
          options[prop] = response[prop];
        });
        const responseContentLength = utils_default.toFiniteNumber(responseHeaders.getContentLength());
        const [onProgress, flush] = onDownloadProgress && progressEventDecorator(
          responseContentLength,
          progressEventReducer(asyncDecorator(onDownloadProgress), true)
        ) || [];
        let bytesRead = 0;
        const onChunkProgress = /* @__PURE__ */ __name((loadedBytes) => {
          if (hasMaxContentLength) {
            bytesRead = loadedBytes;
            if (bytesRead > maxContentLength) {
              throw new AxiosError_default(
                "maxContentLength size of " + maxContentLength + " exceeded",
                AxiosError_default.ERR_BAD_RESPONSE,
                config,
                request
              );
            }
          }
          onProgress && onProgress(loadedBytes);
        }, "onChunkProgress");
        response = new Response(
          trackStream(response.body, DEFAULT_CHUNK_SIZE, onChunkProgress, () => {
            flush && flush();
            unsubscribe && unsubscribe();
          }),
          options
        );
      }
      responseType = responseType || "text";
      let responseData = await resolvers[utils_default.findKey(resolvers, responseType) || "text"](
        response,
        config
      );
      if (hasMaxContentLength && !supportsResponseStream && !isStreamResponse) {
        let materializedSize;
        if (responseData != null) {
          if (typeof responseData.byteLength === "number") {
            materializedSize = responseData.byteLength;
          } else if (typeof responseData.size === "number") {
            materializedSize = responseData.size;
          } else if (typeof responseData === "string") {
            materializedSize = typeof TextEncoder2 === "function" ? new TextEncoder2().encode(responseData).byteLength : responseData.length;
          }
        }
        if (typeof materializedSize === "number" && materializedSize > maxContentLength) {
          throw new AxiosError_default(
            "maxContentLength size of " + maxContentLength + " exceeded",
            AxiosError_default.ERR_BAD_RESPONSE,
            config,
            request
          );
        }
      }
      !isStreamResponse && unsubscribe && unsubscribe();
      return await new Promise((resolve, reject) => {
        settle(resolve, reject, {
          data: responseData,
          headers: AxiosHeaders_default.from(response.headers),
          status: response.status,
          statusText: response.statusText,
          config,
          request
        });
      });
    } catch (err) {
      unsubscribe && unsubscribe();
      if (composedSignal && composedSignal.aborted && composedSignal.reason instanceof AxiosError_default) {
        const canceledError = composedSignal.reason;
        canceledError.config = config;
        request && (canceledError.request = request);
        if (err !== canceledError) {
          Object.defineProperty(canceledError, "cause", {
            __proto__: null,
            value: err,
            writable: true,
            enumerable: false,
            configurable: true
          });
        }
        throw canceledError;
      }
      if (pendingBodyError) {
        request && !pendingBodyError.request && (pendingBodyError.request = request);
        throw pendingBodyError;
      }
      if (err instanceof AxiosError_default) {
        request && !err.request && (err.request = request);
        throw err;
      }
      if (err && err.name === "TypeError" && /Load failed|fetch/i.test(err.message)) {
        const networkError = new AxiosError_default(
          "Network Error",
          AxiosError_default.ERR_NETWORK,
          config,
          request,
          err && err.response
        );
        Object.defineProperty(networkError, "cause", {
          __proto__: null,
          value: err.cause || err,
          writable: true,
          enumerable: false,
          configurable: true
        });
        throw networkError;
      }
      throw AxiosError_default.from(err, err && err.code, config, request, err && err.response);
    }
  };
}, "factory");
var seedCache = /* @__PURE__ */ new Map();
var getFetch = /* @__PURE__ */ __name((config) => {
  let env = config && config.env || {};
  const { fetch: fetch2, Request, Response } = env;
  const seeds = [Request, Response, fetch2];
  let len = seeds.length, i = len, seed, target, map = seedCache;
  while (i--) {
    seed = seeds[i];
    target = map.get(seed);
    target === void 0 && map.set(seed, target = i ? /* @__PURE__ */ new Map() : factory(env));
    map = target;
  }
  return target;
}, "getFetch");
var adapter = getFetch();

// node_modules/axios/lib/adapters/adapters.js
var knownAdapters = {
  http: http_default,
  xhr: xhr_default,
  fetch: {
    get: getFetch
  }
};
utils_default.forEach(knownAdapters, (fn, value) => {
  if (fn) {
    try {
      Object.defineProperty(fn, "name", { __proto__: null, value });
    } catch (e) {
    }
    Object.defineProperty(fn, "adapterName", { __proto__: null, value });
  }
});
var renderReason = /* @__PURE__ */ __name((reason) => `- ${reason}`, "renderReason");
var isResolvedHandle = /* @__PURE__ */ __name((adapter2) => utils_default.isFunction(adapter2) || adapter2 === null || adapter2 === false, "isResolvedHandle");
function getAdapter(adapters, config) {
  adapters = utils_default.isArray(adapters) ? adapters : [adapters];
  const { length } = adapters;
  let nameOrAdapter;
  let adapter2;
  const rejectedReasons = {};
  for (let i = 0; i < length; i++) {
    nameOrAdapter = adapters[i];
    let id;
    adapter2 = nameOrAdapter;
    if (!isResolvedHandle(nameOrAdapter)) {
      adapter2 = knownAdapters[(id = String(nameOrAdapter)).toLowerCase()];
      if (adapter2 === void 0) {
        throw new AxiosError_default(`Unknown adapter '${id}'`);
      }
    }
    if (adapter2 && (utils_default.isFunction(adapter2) || (adapter2 = adapter2.get(config)))) {
      break;
    }
    rejectedReasons[id || "#" + i] = adapter2;
  }
  if (!adapter2) {
    const reasons = Object.entries(rejectedReasons).map(
      ([id, state]) => `adapter ${id} ` + (state === false ? "is not supported by the environment" : "is not available in the build")
    );
    let s = length ? reasons.length > 1 ? "since :\n" + reasons.map(renderReason).join("\n") : " " + renderReason(reasons[0]) : "as no adapter specified";
    throw new AxiosError_default(
      `There is no suitable adapter to dispatch the request ` + s,
      AxiosError_default.ERR_NOT_SUPPORT
    );
  }
  return adapter2;
}
__name(getAdapter, "getAdapter");
var adapters_default = {
  /**
   * Resolve an adapter from a list of adapter names or functions.
   * @type {Function}
   */
  getAdapter,
  /**
   * Exposes all known adapters
   * @type {Object<string, Function|Object>}
   */
  adapters: knownAdapters
};

// node_modules/axios/lib/core/dispatchRequest.js
function throwIfCancellationRequested(config) {
  if (config.cancelToken) {
    config.cancelToken.throwIfRequested();
  }
  if (config.signal && config.signal.aborted) {
    throw new CanceledError_default(null, config);
  }
}
__name(throwIfCancellationRequested, "throwIfCancellationRequested");
function dispatchRequest(config) {
  throwIfCancellationRequested(config);
  config.headers = AxiosHeaders_default.from(config.headers);
  config.data = transformData.call(config, config.transformRequest);
  if (["post", "put", "patch"].indexOf(config.method) !== -1) {
    config.headers.setContentType("application/x-www-form-urlencoded", false);
  }
  const adapter2 = adapters_default.getAdapter(config.adapter || defaults_default.adapter, config);
  return adapter2(config).then(
    /* @__PURE__ */ __name(function onAdapterResolution(response) {
      throwIfCancellationRequested(config);
      config.response = response;
      try {
        response.data = transformData.call(config, config.transformResponse, response);
      } finally {
        delete config.response;
      }
      response.headers = AxiosHeaders_default.from(response.headers);
      return response;
    }, "onAdapterResolution"),
    /* @__PURE__ */ __name(function onAdapterRejection(reason) {
      if (!isCancel(reason)) {
        throwIfCancellationRequested(config);
        if (reason && reason.response) {
          config.response = reason.response;
          try {
            reason.response.data = transformData.call(
              config,
              config.transformResponse,
              reason.response
            );
          } finally {
            delete config.response;
          }
          reason.response.headers = AxiosHeaders_default.from(reason.response.headers);
        }
      }
      return Promise.reject(reason);
    }, "onAdapterRejection")
  );
}
__name(dispatchRequest, "dispatchRequest");

// node_modules/axios/lib/helpers/validator.js
init_esbuild_shims();
var validators = {};
["object", "boolean", "number", "function", "string", "symbol"].forEach((type, i) => {
  validators[type] = /* @__PURE__ */ __name(function validator(thing) {
    return typeof thing === type || "a" + (i < 1 ? "n " : " ") + type;
  }, "validator");
});
var deprecatedWarnings = {};
validators.transitional = /* @__PURE__ */ __name(function transitional(validator, version, message) {
  function formatMessage(opt, desc) {
    return "[Axios v" + VERSION + "] Transitional option '" + opt + "'" + desc + (message ? ". " + message : "");
  }
  __name(formatMessage, "formatMessage");
  return (value, opt, opts) => {
    if (validator === false) {
      throw new AxiosError_default(
        formatMessage(opt, " has been removed" + (version ? " in " + version : "")),
        AxiosError_default.ERR_DEPRECATED
      );
    }
    if (version && !deprecatedWarnings[opt]) {
      deprecatedWarnings[opt] = true;
      console.warn(
        formatMessage(
          opt,
          " has been deprecated since v" + version + " and will be removed in the near future"
        )
      );
    }
    return validator ? validator(value, opt, opts) : true;
  };
}, "transitional");
validators.spelling = /* @__PURE__ */ __name(function spelling(correctSpelling) {
  return (value, opt) => {
    console.warn(`${opt} is likely a misspelling of ${correctSpelling}`);
    return true;
  };
}, "spelling");
function assertOptions(options, schema, allowUnknown) {
  if (typeof options !== "object" || options === null) {
    throw new AxiosError_default("options must be an object", AxiosError_default.ERR_BAD_OPTION_VALUE);
  }
  const keys = Object.keys(options);
  let i = keys.length;
  while (i-- > 0) {
    const opt = keys[i];
    const validator = Object.prototype.hasOwnProperty.call(schema, opt) ? schema[opt] : void 0;
    if (validator) {
      const value = options[opt];
      const result = value === void 0 || validator(value, opt, options);
      if (result !== true) {
        throw new AxiosError_default(
          "option " + opt + " must be " + result,
          AxiosError_default.ERR_BAD_OPTION_VALUE
        );
      }
      continue;
    }
    if (allowUnknown !== true) {
      throw new AxiosError_default("Unknown option " + opt, AxiosError_default.ERR_BAD_OPTION);
    }
  }
}
__name(assertOptions, "assertOptions");
var validator_default = {
  assertOptions,
  validators
};

// node_modules/axios/lib/core/Axios.js
var validators2 = validator_default.validators;
var Axios = class {
  static {
    __name(this, "Axios");
  }
  constructor(instanceConfig) {
    this.defaults = instanceConfig || {};
    this.interceptors = {
      request: new InterceptorManager_default(),
      response: new InterceptorManager_default()
    };
  }
  /**
   * Dispatch a request
   *
   * @param {String|Object} configOrUrl The config specific for this request (merged with this.defaults)
   * @param {?Object} config
   *
   * @returns {Promise} The Promise to be fulfilled
   */
  async request(configOrUrl, config) {
    try {
      return await this._request(configOrUrl, config);
    } catch (err) {
      if (err instanceof Error) {
        let dummy = {};
        Error.captureStackTrace ? Error.captureStackTrace(dummy) : dummy = new Error();
        const stack = (() => {
          if (!dummy.stack) {
            return "";
          }
          const firstNewlineIndex = dummy.stack.indexOf("\n");
          return firstNewlineIndex === -1 ? "" : dummy.stack.slice(firstNewlineIndex + 1);
        })();
        try {
          if (!err.stack) {
            err.stack = stack;
          } else if (stack) {
            const firstNewlineIndex = stack.indexOf("\n");
            const secondNewlineIndex = firstNewlineIndex === -1 ? -1 : stack.indexOf("\n", firstNewlineIndex + 1);
            const stackWithoutTwoTopLines = secondNewlineIndex === -1 ? "" : stack.slice(secondNewlineIndex + 1);
            if (!String(err.stack).endsWith(stackWithoutTwoTopLines)) {
              err.stack += "\n" + stack;
            }
          }
        } catch (e) {
        }
      }
      throw err;
    }
  }
  _request(configOrUrl, config) {
    if (typeof configOrUrl === "string") {
      config = config || {};
      config.url = configOrUrl;
    } else {
      config = configOrUrl || {};
    }
    config = mergeConfig(this.defaults, config);
    const { transitional: transitional2, paramsSerializer, headers } = config;
    if (transitional2 !== void 0) {
      validator_default.assertOptions(
        transitional2,
        {
          silentJSONParsing: validators2.transitional(validators2.boolean),
          forcedJSONParsing: validators2.transitional(validators2.boolean),
          clarifyTimeoutError: validators2.transitional(validators2.boolean),
          legacyInterceptorReqResOrdering: validators2.transitional(validators2.boolean),
          advertiseZstdAcceptEncoding: validators2.transitional(validators2.boolean),
          validateStatusUndefinedResolves: validators2.transitional(validators2.boolean)
        },
        false
      );
    }
    if (paramsSerializer != null) {
      if (utils_default.isFunction(paramsSerializer)) {
        config.paramsSerializer = {
          serialize: paramsSerializer
        };
      } else {
        validator_default.assertOptions(
          paramsSerializer,
          {
            encode: validators2.function,
            serialize: validators2.function
          },
          true
        );
      }
    }
    if (config.allowAbsoluteUrls !== void 0) {
    } else if (this.defaults.allowAbsoluteUrls !== void 0) {
      config.allowAbsoluteUrls = this.defaults.allowAbsoluteUrls;
    } else {
      config.allowAbsoluteUrls = true;
    }
    validator_default.assertOptions(
      config,
      {
        baseUrl: validators2.spelling("baseURL"),
        withXsrfToken: validators2.spelling("withXSRFToken")
      },
      true
    );
    config.method = (config.method || this.defaults.method || "get").toLowerCase();
    let contextHeaders = headers && utils_default.merge(headers.common, headers[config.method]);
    headers && utils_default.forEach(["delete", "get", "head", "post", "put", "patch", "query", "common"], (method) => {
      delete headers[method];
    });
    config.headers = AxiosHeaders_default.concat(contextHeaders, headers);
    const requestInterceptorChain = [];
    let synchronousRequestInterceptors = true;
    this.interceptors.request.forEach(/* @__PURE__ */ __name(function unshiftRequestInterceptors(interceptor) {
      if (typeof interceptor.runWhen === "function" && interceptor.runWhen(config) === false) {
        return;
      }
      synchronousRequestInterceptors = synchronousRequestInterceptors && interceptor.synchronous;
      const transitional3 = config.transitional || transitional_default;
      const legacyInterceptorReqResOrdering = transitional3 && transitional3.legacyInterceptorReqResOrdering;
      if (legacyInterceptorReqResOrdering) {
        requestInterceptorChain.unshift(interceptor.fulfilled, interceptor.rejected);
      } else {
        requestInterceptorChain.push(interceptor.fulfilled, interceptor.rejected);
      }
    }, "unshiftRequestInterceptors"));
    const responseInterceptorChain = [];
    this.interceptors.response.forEach(/* @__PURE__ */ __name(function pushResponseInterceptors(interceptor) {
      responseInterceptorChain.push(interceptor.fulfilled, interceptor.rejected);
    }, "pushResponseInterceptors"));
    let promise;
    let i = 0;
    let len;
    if (!synchronousRequestInterceptors) {
      const chain = [dispatchRequest.bind(this), void 0];
      chain.unshift(...requestInterceptorChain);
      chain.push(...responseInterceptorChain);
      len = chain.length;
      promise = Promise.resolve(config);
      while (i < len) {
        promise = promise.then(chain[i++], chain[i++]);
      }
      return promise;
    }
    len = requestInterceptorChain.length;
    let newConfig = config;
    while (i < len) {
      const onFulfilled = requestInterceptorChain[i++];
      const onRejected = requestInterceptorChain[i++];
      try {
        newConfig = onFulfilled ? onFulfilled(newConfig) : newConfig;
      } catch (error) {
        if (!onRejected) {
          promise = Promise.reject(error);
          break;
        }
        try {
          const rejectedResult = onRejected.call(this, error);
          if (utils_default.isThenable(rejectedResult)) {
            promise = Promise.resolve(rejectedResult).then(
              () => dispatchRequest.call(this, newConfig)
            );
          }
        } catch (rejectedError) {
          promise = Promise.reject(rejectedError);
        }
        break;
      }
    }
    if (!promise) {
      try {
        promise = dispatchRequest.call(this, newConfig);
      } catch (error) {
        promise = Promise.reject(error);
      }
    }
    i = 0;
    len = responseInterceptorChain.length;
    while (i < len) {
      promise = promise.then(responseInterceptorChain[i++], responseInterceptorChain[i++]);
    }
    return promise;
  }
  getUri(config) {
    config = mergeConfig(this.defaults, config);
    const fullPath = buildFullPath(config.baseURL, config.url, config.allowAbsoluteUrls, config);
    return buildURL(fullPath, config.params, config.paramsSerializer);
  }
};
utils_default.forEach(["delete", "get", "head", "options"], /* @__PURE__ */ __name(function forEachMethodNoData(method) {
  Axios.prototype[method] = function(url2, config) {
    return this.request(
      mergeConfig(config || {}, {
        method,
        url: url2,
        data: config && utils_default.hasOwnProp(config, "data") ? config.data : void 0
      })
    );
  };
}, "forEachMethodNoData"));
utils_default.forEach(["post", "put", "patch", "query"], /* @__PURE__ */ __name(function forEachMethodWithData(method) {
  function generateHTTPMethod(isForm) {
    return /* @__PURE__ */ __name(function httpMethod(url2, data, config) {
      return this.request(
        mergeConfig(config || {}, {
          method,
          headers: isForm ? {
            "Content-Type": "multipart/form-data"
          } : {},
          url: url2,
          data
        })
      );
    }, "httpMethod");
  }
  __name(generateHTTPMethod, "generateHTTPMethod");
  Axios.prototype[method] = generateHTTPMethod();
  if (method !== "query") {
    Axios.prototype[method + "Form"] = generateHTTPMethod(true);
  }
}, "forEachMethodWithData"));
var Axios_default = Axios;

// node_modules/axios/lib/cancel/CancelToken.js
init_esbuild_shims();
var CancelToken = class _CancelToken {
  static {
    __name(this, "CancelToken");
  }
  constructor(executor) {
    if (typeof executor !== "function") {
      throw new TypeError("executor must be a function.");
    }
    let resolvePromise;
    this.promise = new Promise(/* @__PURE__ */ __name(function promiseExecutor(resolve) {
      resolvePromise = resolve;
    }, "promiseExecutor"));
    const token = this;
    this.promise.then((cancel) => {
      if (!token._listeners) return;
      let i = token._listeners.length;
      while (i-- > 0) {
        token._listeners[i](cancel);
      }
      token._listeners = null;
    });
    this.promise.then = (onfulfilled) => {
      let _resolve;
      const promise = new Promise((resolve) => {
        token.subscribe(resolve);
        _resolve = resolve;
      }).then(onfulfilled);
      promise.cancel = /* @__PURE__ */ __name(function reject() {
        token.unsubscribe(_resolve);
      }, "reject");
      return promise;
    };
    executor(/* @__PURE__ */ __name(function cancel(message, config, request) {
      if (token.reason) {
        return;
      }
      token.reason = new CanceledError_default(message, config, request);
      resolvePromise(token.reason);
    }, "cancel"));
  }
  /**
   * Throws a `CanceledError` if cancellation has been requested.
   */
  throwIfRequested() {
    if (this.reason) {
      throw this.reason;
    }
  }
  /**
   * Subscribe to the cancel signal
   */
  subscribe(listener) {
    if (this.reason) {
      listener(this.reason);
      return;
    }
    if (this._listeners) {
      this._listeners.push(listener);
    } else {
      this._listeners = [listener];
    }
  }
  /**
   * Unsubscribe from the cancel signal
   */
  unsubscribe(listener) {
    if (!this._listeners) {
      return;
    }
    const index = this._listeners.indexOf(listener);
    if (index !== -1) {
      this._listeners.splice(index, 1);
    }
  }
  toAbortSignal() {
    const controller = new AbortController();
    const abort = /* @__PURE__ */ __name((err) => {
      controller.abort(err);
    }, "abort");
    this.subscribe(abort);
    controller.signal.unsubscribe = () => this.unsubscribe(abort);
    return controller.signal;
  }
  /**
   * Returns an object that contains a new `CancelToken` and a function that, when called,
   * cancels the `CancelToken`.
   */
  static source() {
    let cancel;
    const token = new _CancelToken(/* @__PURE__ */ __name(function executor(c) {
      cancel = c;
    }, "executor"));
    return {
      token,
      cancel
    };
  }
};
var CancelToken_default = CancelToken;

// node_modules/axios/lib/helpers/spread.js
init_esbuild_shims();
function spread(callback) {
  return /* @__PURE__ */ __name(function wrap(arr) {
    return callback.apply(null, arr);
  }, "wrap");
}
__name(spread, "spread");

// node_modules/axios/lib/helpers/isAxiosError.js
init_esbuild_shims();
function isAxiosError(payload) {
  return utils_default.isObject(payload) && payload.isAxiosError === true;
}
__name(isAxiosError, "isAxiosError");

// node_modules/axios/lib/helpers/HttpStatusCode.js
init_esbuild_shims();
var HttpStatusCode = {
  Continue: 100,
  SwitchingProtocols: 101,
  Processing: 102,
  EarlyHints: 103,
  Ok: 200,
  Created: 201,
  Accepted: 202,
  NonAuthoritativeInformation: 203,
  NoContent: 204,
  ResetContent: 205,
  PartialContent: 206,
  MultiStatus: 207,
  AlreadyReported: 208,
  ImUsed: 226,
  MultipleChoices: 300,
  MovedPermanently: 301,
  Found: 302,
  SeeOther: 303,
  NotModified: 304,
  UseProxy: 305,
  Unused: 306,
  TemporaryRedirect: 307,
  PermanentRedirect: 308,
  BadRequest: 400,
  Unauthorized: 401,
  PaymentRequired: 402,
  Forbidden: 403,
  NotFound: 404,
  MethodNotAllowed: 405,
  NotAcceptable: 406,
  ProxyAuthenticationRequired: 407,
  RequestTimeout: 408,
  Conflict: 409,
  Gone: 410,
  LengthRequired: 411,
  PreconditionFailed: 412,
  PayloadTooLarge: 413,
  UriTooLong: 414,
  UnsupportedMediaType: 415,
  RangeNotSatisfiable: 416,
  ExpectationFailed: 417,
  ImATeapot: 418,
  MisdirectedRequest: 421,
  UnprocessableEntity: 422,
  Locked: 423,
  FailedDependency: 424,
  TooEarly: 425,
  UpgradeRequired: 426,
  PreconditionRequired: 428,
  TooManyRequests: 429,
  RequestHeaderFieldsTooLarge: 431,
  UnavailableForLegalReasons: 451,
  InternalServerError: 500,
  NotImplemented: 501,
  BadGateway: 502,
  ServiceUnavailable: 503,
  GatewayTimeout: 504,
  HttpVersionNotSupported: 505,
  VariantAlsoNegotiates: 506,
  InsufficientStorage: 507,
  LoopDetected: 508,
  NotExtended: 510,
  NetworkAuthenticationRequired: 511,
  WebServerReturnsAnUnknownError: 520,
  WebServerIsDown: 521,
  ConnectionTimedOut: 522,
  OriginIsUnreachable: 523,
  TimeoutOccurred: 524,
  SslHandshakeFailed: 525,
  InvalidSslCertificate: 526
};
Object.entries(HttpStatusCode).forEach(([key, value]) => {
  HttpStatusCode[value] = key;
});
var HttpStatusCode_default = HttpStatusCode;

// node_modules/axios/lib/axios.js
function createInstance(defaultConfig2) {
  const context = new Axios_default(defaultConfig2);
  const instance = bind(Axios_default.prototype.request, context);
  utils_default.extend(instance, Axios_default.prototype, context, { allOwnKeys: true });
  utils_default.extend(instance, context, null, { allOwnKeys: true });
  instance.create = /* @__PURE__ */ __name(function create2(instanceConfig) {
    return createInstance(mergeConfig(defaultConfig2, instanceConfig));
  }, "create");
  return instance;
}
__name(createInstance, "createInstance");
var axios = createInstance(defaults_default);
axios.Axios = Axios_default;
axios.CanceledError = CanceledError_default;
axios.CancelToken = CancelToken_default;
axios.isCancel = isCancel;
axios.VERSION = VERSION;
axios.toFormData = toFormData_default;
axios.AxiosError = AxiosError_default;
axios.Cancel = axios.CanceledError;
axios.all = /* @__PURE__ */ __name(function all(promises) {
  return Promise.all(promises);
}, "all");
axios.spread = spread;
axios.isAxiosError = isAxiosError;
axios.mergeConfig = mergeConfig;
axios.AxiosHeaders = AxiosHeaders_default;
axios.formToJSON = (thing) => formDataToJSON_default(utils_default.isHTMLForm(thing) ? new FormData(thing) : thing);
axios.getAdapter = adapters_default.getAdapter;
axios.HttpStatusCode = HttpStatusCode_default;
axios.default = axios;
var axios_default = axios;

// node_modules/axios/index.js
var {
  Axios: Axios2,
  AxiosError: AxiosError2,
  CanceledError: CanceledError2,
  isCancel: isCancel2,
  CancelToken: CancelToken2,
  VERSION: VERSION2,
  all: all2,
  Cancel,
  isAxiosError: isAxiosError2,
  spread: spread2,
  toFormData: toFormData2,
  AxiosHeaders: AxiosHeaders2,
  HttpStatusCode: HttpStatusCode2,
  formToJSON,
  getAdapter: getAdapter2,
  mergeConfig: mergeConfig2,
  create
} = axios_default;

// node_modules/dingtalk-stream-sdk-nodejs/dist/client.mjs
import EventEmitter2 from "events";
var EventAck = /* @__PURE__ */ ((EventAck2) => {
  EventAck2["SUCCESS"] = "SUCCESS";
  EventAck2["LATER"] = "LATER";
  return EventAck2;
})(EventAck || {});
var defaultConfig = {
  autoReconnect: true,
  keepAlive: false,
  ua: "",
  subscriptions: [
    {
      type: "EVENT",
      topic: "*"
    }
  ]
};
var DWClient = class extends EventEmitter2 {
  static {
    __name(this, "DWClient");
  }
  debug = true;
  connected = false;
  registered = false;
  reconnecting = false;
  userDisconnect = false;
  reconnectInterval = 1e3;
  heartbeat_interval = 8e3;
  heartbeatIntervallId;
  sslopts = { rejectUnauthorized: true };
  config;
  socket;
  dw_url;
  isAlive = false;
  onEventReceived = /* @__PURE__ */ __name((msg) => {
    return {
      status: "SUCCESS"
      /* SUCCESS */
    };
  }, "onEventReceived");
  constructor(opts) {
    super();
    this.config = {
      ...defaultConfig,
      ...opts
    };
    if (!this.config.clientId || !this.config.clientSecret) {
      console.error("clientId or clientSecret is null");
      throw new Error("clientId or clientSecret is null");
    }
  }
  getConfig() {
    return { ...this.config };
  }
  printDebug(msg) {
    if (this.debug) {
      const date = "[" + (/* @__PURE__ */ new Date()).toISOString() + "]";
      console.info(date, msg);
    }
  }
  registerAllEventListener(onEventReceived) {
    this.onEventReceived = onEventReceived;
    return this;
  }
  registerCallbackListener(eventId, callback) {
    if (!eventId || !callback) {
      console.error(
        "registerCallbackListener: eventId and callback must be defined"
      );
      throw new Error(
        "registerCallbackListener: eventId and callback must be defined"
      );
    }
    if (!this.config.subscriptions.find(
      (x) => x.topic === eventId && x.type === "CALLBACK"
    )) {
      this.config.subscriptions.push({
        type: "CALLBACK",
        topic: eventId
      });
    }
    this.on(eventId, callback);
    return this;
  }
  async getEndpoint() {
    this.printDebug("get connect endpoint by config");
    console.log(this.config);
    const result = await axios_default.get(
      `https://oapi.dingtalk.com/gettoken?appkey=${this.config.clientId}&appsecret=${this.config.clientSecret}`
    );
    if (result.status === 200 && result.data.access_token) {
      this.config.access_token = result.data.access_token;
      const res = await axios_default({
        url: "https://api.dingtalk.com/v1.0/gateway/connections/open",
        method: "POST",
        responseType: "json",
        data: {
          clientId: this.config.clientId,
          clientSecret: this.config.clientSecret,
          ua: this.config.ua,
          subscriptions: this.config.subscriptions
        },
        headers: {
          // 这个接口得加个，否则默认返回的会是xml
          Accept: "application/json",
          "access-token": result.data.access_token
          // 'd136e657-5998-4cc4-a055-2b7ceab0f212'
        }
      });
      console.log("res.data", JSON.stringify(res.data));
      if (res.data) {
        this.config.endpoint = res.data;
        const { endpoint, ticket } = res.data;
        if (!endpoint || !ticket) {
          this.printDebug("endpoint or ticket is null");
          throw new Error("endpoint or ticket is null");
        }
        this.dw_url = `${endpoint}?ticket=${ticket}`;
        return this;
      } else {
        throw new Error("build: get endpoint failed");
      }
    } else {
      throw new Error("build: get access_token failed");
    }
  }
  _connect() {
    return new Promise((resolve, reject) => {
      this.userDisconnect = false;
      this.printDebug("Connecting to dingtalk websocket @ " + this.dw_url);
      this.socket = new wrapper_default(this.dw_url, this.sslopts);
      this.socket.on("open", () => {
        this.connected = true;
        this.printDebug("Socket open");
        if (this.config.keepAlive) {
          this.isAlive = true;
          this.heartbeatIntervallId = setInterval(() => {
            var _a, _b;
            if (this.isAlive === false) {
              console.error(
                "TERMINATE SOCKET: Ping Pong does not transfer heartbeat within heartbeat intervall"
              );
              return (_a = this.socket) == null ? void 0 : _a.terminate();
            }
            this.isAlive = false;
            (_b = this.socket) == null ? void 0 : _b.ping("", true);
          }, this.heartbeat_interval);
        }
      });
      this.socket.on("pong", () => {
        this.heartbeat();
      });
      this.socket.on("message", (data) => {
        this.onDownStream(data);
      });
      this.socket.on("close", (err) => {
        this.printDebug("Socket closed");
        this.connected = false;
        this.registered = false;
        if (this.config.autoReconnect && !this.userDisconnect) {
          this.reconnecting = true;
          this.printDebug(
            "Reconnecting in " + this.reconnectInterval / 1e3 + " seconds..."
          );
          setTimeout(this.connect.bind(this), this.reconnectInterval);
        }
      });
      this.socket.on("error", (err) => {
        this.printDebug("SOCKET ERROR");
        console.warn("ERROR", err);
      });
      resolve();
    });
  }
  async connect() {
    await this.getEndpoint();
    await this._connect();
  }
  disconnect() {
    var _a;
    console.info("Disconnecting.");
    this.userDisconnect = true;
    if (this.config.keepAlive && this.heartbeatIntervallId !== void 0) {
      clearInterval(this.heartbeatIntervallId);
    }
    (_a = this.socket) == null ? void 0 : _a.close();
  }
  heartbeat() {
    this.isAlive = true;
    this.printDebug("CLIENT-SIDE HEARTBEAT");
  }
  onDownStream(data) {
    this.printDebug("Received message from dingtalk websocket server");
    this.printDebug(data);
    console.log(data);
    const msg = JSON.parse(data);
    switch (msg.type) {
      case "SYSTEM":
        this.onSystem(msg);
        break;
      case "EVENT":
        this.onEvent(msg);
        break;
      case "CALLBACK":
        this.onCallback(msg);
        break;
    }
  }
  onSystem(downstream) {
    var _a;
    switch (downstream.headers.topic) {
      case "CONNECTED": {
        this.printDebug("CONNECTED");
        break;
      }
      case "REGISTERED": {
        this.registered = true;
        this.reconnecting = false;
        break;
      }
      case "disconnect": {
        this.connected = false;
        this.registered = false;
        break;
      }
      case "KEEPALIVE": {
        this.heartbeat();
        break;
      }
      case "ping": {
        this.printDebug("PING");
        (_a = this.socket) == null ? void 0 : _a.send(
          JSON.stringify({
            code: 200,
            headers: downstream.headers,
            message: "OK",
            data: downstream.data
          })
        );
        break;
      }
    }
  }
  onEvent(message) {
    var _a;
    this.printDebug("received event, message=" + JSON.stringify(message));
    const ackData = this.onEventReceived(message);
    (_a = this.socket) == null ? void 0 : _a.send(JSON.stringify({
      code: 200,
      headers: {
        contentType: "application/json",
        messageId: message.headers.messageId
      },
      message: "OK",
      data: JSON.stringify(ackData)
    }));
  }
  onCallback(message) {
    this.emit(message.headers.topic, message);
  }
  send(messageId, value) {
    var _a;
    if (!messageId) {
      console.error("send: messageId must be defined");
      throw new Error("send: messageId must be defined");
    }
    const msg = {
      code: 200,
      headers: {
        contentType: "application/json",
        messageId
      },
      message: "OK",
      data: JSON.stringify(value)
    };
    (_a = this.socket) == null ? void 0 : _a.send(JSON.stringify(msg));
  }
};

// packages/channels/dingtalk/dist/markdown.js
init_esbuild_shims();
var DINGTALK_CHUNK_LIMIT = 3800;
function escapeDingTalkMarkdown(value) {
  return value.replace(/([\\`*_[\]{}()#+.!|>~:-])/gu, "\\$1");
}
__name(escapeDingTalkMarkdown, "escapeDingTalkMarkdown");
function safeUtf16SliceEnd(value, end) {
  if (end <= 0 || end >= value.length)
    return end;
  const previous = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  return previous >= 55296 && previous <= 56319 && next >= 56320 && next <= 57343 ? end - 1 : end;
}
__name(safeUtf16SliceEnd, "safeUtf16SliceEnd");
function splitChunks(text, chunkLimit = DINGTALK_CHUNK_LIMIT) {
  if (!text || text.length <= chunkLimit) {
    return [text];
  }
  const chunks = [];
  let buf = "";
  const lines = text.split("\n");
  let inCode = false;
  const flush = /* @__PURE__ */ __name((keepCodeOpen = inCode) => {
    if (keepCodeOpen) {
      buf += "\n```";
    }
    chunks.push(buf);
    buf = keepCodeOpen ? "```" : "";
  }, "flush");
  const appendLine = /* @__PURE__ */ __name((line, needsLineBreak, closesCodeFence, leavesCodeFenceOpen) => {
    let remaining = line;
    let prefixPending = needsLineBreak;
    let lineOpenedFenceInBuffer = false;
    while (remaining.length > 0 || prefixPending) {
      const prefix = prefixPending ? "\n" : "";
      const fitsAsFinalPiece = remaining.length <= chunkLimit - buf.length - prefix.length;
      const closeFenceOverhead = inCode && !(closesCodeFence && fitsAsFinalPiece) || !inCode && leavesCodeFenceOpen ? "\n```".length : 0;
      const available = chunkLimit - closeFenceOverhead - buf.length - prefix.length;
      if (available <= 0) {
        const keepCodeOpen = inCode || lineOpenedFenceInBuffer;
        if (buf === (keepCodeOpen ? "```" : "")) {
          throw new RangeError("chunk limit cannot contain one Unicode character");
        }
        flush(keepCodeOpen);
        continue;
      }
      let pieceLength = Math.min(available, remaining.length);
      if (pieceLength < remaining.length) {
        for (let fenceStart = Math.max(0, pieceLength - 2); fenceStart < pieceLength; fenceStart++) {
          if (remaining.slice(fenceStart, fenceStart + 3) === "```" && pieceLength < fenceStart + 3) {
            pieceLength = fenceStart;
            break;
          }
        }
      }
      pieceLength = safeUtf16SliceEnd(remaining, pieceLength);
      if (pieceLength === 0 && remaining.length > 0) {
        const keepCodeOpen = inCode || lineOpenedFenceInBuffer;
        if (!buf || keepCodeOpen && buf === "```") {
          throw new RangeError("chunk limit cannot contain one Unicode character");
        }
        flush(keepCodeOpen);
        continue;
      }
      const piece = remaining.slice(0, pieceLength);
      const appendedText = prefix + piece;
      buf += appendedText;
      remaining = remaining.slice(piece.length);
      prefixPending = false;
      lineOpenedFenceInBuffer ||= !inCode && leavesCodeFenceOpen && appendedText.includes("```");
      if (remaining.length > 0) {
        const keepCodeOpen = inCode || lineOpenedFenceInBuffer;
        flush(keepCodeOpen);
        prefixPending = keepCodeOpen;
      }
    }
  }, "appendLine");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || "";
    const fenceCount = (line.match(/```/g) || []).length;
    const togglesCodeFence = fenceCount % 2 === 1;
    appendLine(line, i > 0, inCode && togglesCodeFence, inCode !== togglesCodeFence);
    if (togglesCodeFence) {
      inCode = !inCode;
    }
  }
  if (buf) {
    chunks.push(buf);
  }
  return chunks;
}
__name(splitChunks, "splitChunks");
function extractTitle(text) {
  const firstLine = text.split("\n")[0] || "";
  const cleaned = firstLine.replace(/^[#*\s\->]+/, "").slice(0, 20);
  return cleaned || "Reply";
}
__name(extractTitle, "extractTitle");
function normalizeDingTalkMarkdown(text, chunkLimit = DINGTALK_CHUNK_LIMIT) {
  return splitChunks(text, chunkLimit);
}
__name(normalizeDingTalkMarkdown, "normalizeDingTalkMarkdown");

// packages/channels/dingtalk/dist/media.js
init_esbuild_shims();
var DOWNLOAD_API = "https://api.dingtalk.com/v1.0/robot/messageFiles/download";
async function downloadMedia(downloadCode, robotCode, accessToken) {
  if (!downloadCode || !robotCode || !accessToken) {
    return null;
  }
  try {
    const apiResp = await fetch(DOWNLOAD_API, {
      method: "POST",
      headers: {
        "x-acs-dingtalk-access-token": accessToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ downloadCode, robotCode })
    });
    if (!apiResp.ok) {
      const detail = await apiResp.text().catch(() => "");
      process.stderr.write(`[DingTalk] downloadMedia API failed: HTTP ${apiResp.status} ${detail}
`);
      return null;
    }
    const payload = await apiResp.json();
    const downloadUrl = payload["downloadUrl"] ?? payload["data"]?.["downloadUrl"];
    if (!downloadUrl) {
      process.stderr.write(`[DingTalk] downloadMedia: no downloadUrl in response
`);
      return null;
    }
    const fileResp = await fetch(downloadUrl, {
      signal: AbortSignal.timeout(3e4)
    });
    if (!fileResp.ok) {
      process.stderr.write(`[DingTalk] downloadMedia file fetch failed: HTTP ${fileResp.status}
`);
      return null;
    }
    const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
    const contentLength = fileResp.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_DOWNLOAD_BYTES) {
      await fileResp.body?.cancel();
      process.stderr.write(`[DingTalk] downloadMedia rejected: size ${contentLength} exceeds ${MAX_DOWNLOAD_BYTES} byte limit
`);
      return null;
    }
    const mimeType = fileResp.headers.get("content-type") || "application/octet-stream";
    const reader = fileResp.body?.getReader();
    if (!reader) {
      return null;
    }
    const chunks = [];
    let totalSize = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      totalSize += value.byteLength;
      if (totalSize > MAX_DOWNLOAD_BYTES) {
        await reader.cancel();
        process.stderr.write(`[DingTalk] downloadMedia rejected: actual size exceeds ${MAX_DOWNLOAD_BYTES} byte limit
`);
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    const buffer = Buffer.concat(chunks);
    return { buffer, mimeType };
  } catch (err) {
    process.stderr.write(`[DingTalk] downloadMedia error: ${err instanceof Error ? err.message : err}
`);
    return null;
  }
}
__name(downloadMedia, "downloadMedia");

// packages/channels/dingtalk/dist/outbound-image.js
init_esbuild_shims();
import { closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, relative } from "node:path";
var MEDIA_UPLOAD_API = "https://oapi.dingtalk.com/media/upload";
var MEDIA_UPLOAD_TIMEOUT_MS = 3e4;
var MAX_IMAGE_BYTES = 20 * 1024 * 1024;
var IMAGE_EXTENSIONS = /* @__PURE__ */ new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp"]);
var AUTH_ERROR_CODES = /* @__PURE__ */ new Set([40014, 42001]);
var DingTalkMediaUploadError = class extends Error {
  static {
    __name(this, "DingTalkMediaUploadError");
  }
  authFailure;
  constructor(message, authFailure) {
    super(message);
    this.authFailure = authFailure;
    this.name = "DingTalkMediaUploadError";
  }
};
function maskCode(text) {
  const masked = text.split("");
  const blank = /* @__PURE__ */ __name((start, end) => {
    for (let i = start; i < end; i++) {
      if (masked[i] !== "\n")
        masked[i] = " ";
    }
  }, "blank");
  let offset = 0;
  while (offset < text.length) {
    if (text[offset] === "`") {
      let runLength = 1;
      while (text[offset + runLength] === "`")
        runLength++;
      const delimiter = "`".repeat(runLength);
      const closing = text.indexOf(delimiter, offset + runLength);
      const newline = runLength >= 3 ? -1 : text.indexOf("\n", offset + runLength);
      const closesBeforeNewline = closing !== -1 && (newline === -1 || closing < newline);
      const end = closesBeforeNewline ? closing + runLength : newline === -1 ? text.length : newline;
      blank(offset, end);
      offset = end;
      continue;
    }
    offset++;
  }
  return masked.join("");
}
__name(maskCode, "maskCode");
function findImageMarkers(text) {
  const visibleText = maskCode(text);
  const markerPattern = /\[IMAGE:\s*([^\]\r\n]+)\]/gi;
  const markers = [];
  for (const match of visibleText.matchAll(markerPattern)) {
    const path = match[1]?.trim();
    if (!path || match.index === void 0)
      continue;
    markers.push({
      start: match.index,
      end: match.index + match[0].length,
      path
    });
  }
  return markers;
}
__name(findImageMarkers, "findImageMarkers");
function replaceImageMarkers(text, markers, replacements) {
  if (markers.length !== replacements.length) {
    throw new Error("Image marker replacement count mismatch");
  }
  let result = text;
  for (let i = markers.length - 1; i >= 0; i--) {
    const marker = markers[i];
    result = result.slice(0, marker.start) + replacements[i] + result.slice(marker.end);
  }
  return result;
}
__name(replaceImageMarkers, "replaceImageMarkers");
function stripPartialImageMarker(text) {
  const visibleText = maskCode(text);
  const partialMarker = /\[I(?:M(?:A(?:G(?:E(?::[^\]\r\n]*)?)?)?)?)?$/i.exec(visibleText);
  if (partialMarker?.index === void 0)
    return text;
  return `${text.slice(0, partialMarker.index)}[Image pending]`;
}
__name(stripPartialImageMarker, "stripPartialImageMarker");
function sanitizeStreamingImageMarkers(text) {
  const markers = findImageMarkers(text);
  return stripPartialImageMarker(replaceImageMarkers(text, markers, markers.map(() => "[Image pending]")));
}
__name(sanitizeStreamingImageMarkers, "sanitizeStreamingImageMarkers");
function isInside(realPath, directory) {
  const pathFromDirectory = relative(directory, realPath);
  return pathFromDirectory === "" || !pathFromDirectory.startsWith("..") && !isAbsolute(pathFromDirectory);
}
__name(isInside, "isInside");
function detectImageMime(data) {
  if (data[0] === 137 && data[1] === 80 && data[2] === 78 && data[3] === 71) {
    return "image/png";
  }
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) {
    return "image/jpeg";
  }
  if (data[0] === 71 && data[1] === 73 && data[2] === 70) {
    return "image/gif";
  }
  if (data[0] === 66 && data[1] === 77) {
    return "image/bmp";
  }
  throw new Error("Unrecognized image format");
}
__name(detectImageMime, "detectImageMime");
function readValidatedImage(imagePath, options) {
  if (!isAbsolute(imagePath)) {
    throw new Error(`Image path must be absolute: ${imagePath}`);
  }
  const extension = extname(imagePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) {
    throw new Error(`Image extension not allowed: ${extension}`);
  }
  let realPath;
  try {
    realPath = realpathSync(imagePath);
  } catch {
    throw new Error(`Image file not found: ${imagePath}`);
  }
  const allowedDirectories = [
    realpathSync(options.workspaceDir),
    realpathSync(options.temporaryDir ?? tmpdir())
  ];
  if (!allowedDirectories.some((directory) => isInside(realPath, directory))) {
    throw new Error(`Image path outside allowed directories: ${realPath}`);
  }
  const descriptor = openSync(realPath, "r");
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      throw new Error(`Not a regular file: ${realPath}`);
    }
    if (stats.size > MAX_IMAGE_BYTES) {
      throw new Error(`Image too large: ${stats.size} bytes (max ${MAX_IMAGE_BYTES})`);
    }
    const header = Buffer.alloc(16);
    const bytesRead = readSync(descriptor, header, 0, header.length, 0);
    const mimeType = detectImageMime(header.subarray(0, bytesRead));
    const expectedMime = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".bmp": "image/bmp"
    };
    if (mimeType !== expectedMime[extension]) {
      throw new Error(`Image type mismatch: ${extension} expects ${expectedMime[extension]} but got ${mimeType}`);
    }
    return {
      data: readFileSync(descriptor),
      fileName: basename(realPath),
      mimeType
    };
  } finally {
    closeSync(descriptor);
  }
}
__name(readValidatedImage, "readValidatedImage");
function sanitizeApiMessage(message, accessToken) {
  const value = String(message ?? "");
  return (accessToken ? value.replaceAll(accessToken, "[redacted]") : value).replace(/[\r\n\t]+/g, " ").slice(0, 200);
}
__name(sanitizeApiMessage, "sanitizeApiMessage");
async function uploadDingTalkImage(image, accessToken) {
  const form = new FormData();
  form.append("media", new Blob([image.data], { type: image.mimeType }), image.fileName);
  let response;
  try {
    const url2 = new URL(MEDIA_UPLOAD_API);
    url2.searchParams.set("access_token", accessToken);
    url2.searchParams.set("type", "image");
    response = await fetch(url2, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(MEDIA_UPLOAD_TIMEOUT_MS)
    });
  } catch {
    throw new DingTalkMediaUploadError("DingTalk media upload failed: network request failed", false);
  }
  let payload;
  try {
    const parsed = await response.json();
    payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new DingTalkMediaUploadError(`DingTalk media upload failed: HTTP ${response.status} invalid JSON response`, response.status === 401);
  }
  const errcode = typeof payload["errcode"] === "number" ? payload["errcode"] : void 0;
  if (!response.ok || errcode !== void 0 && errcode !== 0) {
    const detail = sanitizeApiMessage(payload["errmsg"], accessToken);
    throw new DingTalkMediaUploadError(`DingTalk media upload failed: HTTP ${response.status}${errcode === void 0 ? "" : ` errcode=${errcode}`}${detail ? ` ${detail}` : ""}`, response.status === 401 || errcode !== void 0 && AUTH_ERROR_CODES.has(errcode));
  }
  const mediaId = typeof payload["media_id"] === "string" ? payload["media_id"] : typeof payload["mediaId"] === "string" ? payload["mediaId"] : void 0;
  if (!mediaId) {
    throw new DingTalkMediaUploadError("DingTalk media upload failed: response did not include a MediaID", false);
  }
  return mediaId;
}
__name(uploadDingTalkImage, "uploadDingTalkImage");

// packages/channels/dingtalk/dist/outbound-file.js
init_esbuild_shims();
import { closeSync as closeSync2, constants, fstatSync as fstatSync2, openSync as openSync2, readSync as readSync2, realpathSync as realpathSync2, statSync } from "node:fs";
import { tmpdir as tmpdir2 } from "node:os";
import { basename as basename2, extname as extname2, isAbsolute as isAbsolute2, relative as relative2, sep } from "node:path";
var FILE_OPENING = "[FILE:";
var MEDIA_UPLOAD_API2 = "https://oapi.dingtalk.com/media/upload";
var MEDIA_UPLOAD_TIMEOUT_MS2 = 3e4;
var MAX_FILE_PATH_CHARS = 4096;
var MAX_FILE_BYTES = 20 * 1024 * 1024;
var AUTH_ERROR_CODES2 = /* @__PURE__ */ new Set([40014, 42001]);
var MAX_FILES_PER_RESPONSE = 5;
var FILE_UNAVAILABLE_NOTICE = "[File delivery unavailable]";
var OutboundFileProjector = class {
  static {
    __name(this, "OutboundFileProjector");
  }
  candidate = "";
  reserved = "";
  reservedAtLineStart = false;
  reservedTooLong = false;
  atLineStart = true;
  paths = [];
  invalidMarkers = 0;
  excessMarkers = 0;
  markerCount = 0;
  append(chunk) {
    let safe = "";
    for (const char of chunk) {
      if (this.reserved) {
        if (char === "\n") {
          this.finishReservedLine();
          safe += "\n";
          this.atLineStart = true;
        } else if (this.reserved.length <= MAX_FILE_PATH_CHARS + 9) {
          this.reserved += char;
        } else {
          this.reservedTooLong = true;
        }
        continue;
      }
      if (char === "\n") {
        safe += `${this.candidate}
`;
        this.candidate = "";
        this.atLineStart = true;
        continue;
      }
      this.candidate += char;
      while (this.candidate && !FILE_OPENING.startsWith(this.candidate)) {
        safe += this.candidate[0];
        this.candidate = this.candidate.slice(1);
        this.atLineStart = false;
      }
      if (this.candidate === FILE_OPENING) {
        this.reserved = this.candidate;
        this.reservedAtLineStart = this.atLineStart;
        this.candidate = "";
        this.markerCount++;
      }
    }
    return safe;
  }
  complete() {
    if (!this.reserved) {
      const safe = this.candidate;
      this.candidate = "";
      return safe;
    }
    this.finishReservedLine();
    return "";
  }
  result(text) {
    return {
      text,
      paths: [...this.paths],
      invalidMarkers: this.invalidMarkers,
      excessMarkers: this.excessMarkers,
      markerCount: this.markerCount
    };
  }
  finishReservedLine() {
    const match = /^\[FILE: ([^\]\r\n]+)\]\r?$/u.exec(this.reserved);
    const path = match?.[1];
    if (!this.reservedTooLong && this.reservedAtLineStart && path && path.length <= MAX_FILE_PATH_CHARS && path === path.trim()) {
      if (this.paths.length < MAX_FILES_PER_RESPONSE) {
        this.paths.push(path);
      } else {
        this.excessMarkers++;
      }
    } else {
      this.invalidMarkers++;
    }
    this.reserved = "";
    this.reservedAtLineStart = false;
    this.reservedTooLong = false;
  }
};
function projectFileText(text) {
  const projector = new OutboundFileProjector();
  const safe = projector.append(text) + projector.complete();
  return projector.result(safe);
}
__name(projectFileText, "projectFileText");
function safeFileName(filePath) {
  return basename2(filePath).replace(/[\p{Cc}\p{Cf}[\]]+/gu, "_").slice(0, 200) || "file";
}
__name(safeFileName, "safeFileName");
function isInside2(filePath, directory) {
  const child = relative2(directory, filePath);
  return child === "" || !isAbsolute2(child) && child !== ".." && !child.startsWith(`..${sep}`);
}
__name(isInside2, "isInside");
function readValidatedFile(filePath, workspaceDir) {
  if (!isAbsolute2(filePath))
    throw new Error("File path must be absolute");
  let realPath;
  try {
    realPath = realpathSync2(filePath);
  } catch {
    throw new Error("File not found");
  }
  const roots = [
    workspaceDir,
    tmpdir2(),
    ...process.platform === "win32" ? [] : ["/tmp"]
  ].map((root) => realpathSync2(root));
  if (!roots.some((root) => isInside2(realPath, root))) {
    throw new Error("File path outside allowed directories");
  }
  if (!statSync(realPath).isFile())
    throw new Error("Not a regular file");
  const descriptor = openSync2(realPath, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const stats = fstatSync2(descriptor);
    if (!stats.isFile())
      throw new Error("Not a regular file");
    if (stats.size === 0)
      throw new Error("File is empty");
    if (stats.size > MAX_FILE_BYTES)
      throw new Error("File is too large");
    const data = Buffer.allocUnsafe(stats.size + 1);
    let bytesRead = 0;
    while (bytesRead < data.length) {
      const count = readSync2(descriptor, data, bytesRead, data.length - bytesRead, bytesRead);
      if (count === 0)
        break;
      bytesRead += count;
    }
    if (bytesRead !== stats.size)
      throw new Error("File changed while read");
    const fileName = safeFileName(realPath);
    return {
      data: data.subarray(0, bytesRead),
      fileName,
      fileType: extname2(fileName).slice(1).toLowerCase() || "file"
    };
  } finally {
    closeSync2(descriptor);
  }
}
__name(readValidatedFile, "readValidatedFile");
function sanitizeApiMessage2(message, accessToken) {
  const value = String(message ?? "");
  return (accessToken ? value.replaceAll(accessToken, "[redacted]") : value).replace(/[\r\n\t]+/g, " ").slice(0, 200);
}
__name(sanitizeApiMessage2, "sanitizeApiMessage");
async function uploadDingTalkFile(file, accessToken) {
  const form = new FormData();
  form.append("media", new Blob([file.data], { type: "application/octet-stream" }), file.fileName);
  let response;
  try {
    const url2 = new URL(MEDIA_UPLOAD_API2);
    url2.searchParams.set("access_token", accessToken);
    url2.searchParams.set("type", "file");
    response = await fetch(url2, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(MEDIA_UPLOAD_TIMEOUT_MS2)
    });
  } catch {
    throw new DingTalkMediaUploadError("DingTalk file upload failed: network request failed", false);
  }
  let payload;
  try {
    const parsed = await response.json();
    payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new DingTalkMediaUploadError(`DingTalk file upload failed: HTTP ${response.status} invalid JSON response`, response.status === 401);
  }
  const errcode = typeof payload["errcode"] === "number" ? payload["errcode"] : void 0;
  if (!response.ok || errcode !== void 0 && errcode !== 0) {
    const detail = sanitizeApiMessage2(payload["errmsg"], accessToken);
    throw new DingTalkMediaUploadError(`DingTalk file upload failed: HTTP ${response.status}${errcode === void 0 ? "" : ` errcode=${errcode}`}${detail ? ` ${detail}` : ""}`, response.status === 401 || errcode !== void 0 && AUTH_ERROR_CODES2.has(errcode));
  }
  const mediaId = typeof payload["media_id"] === "string" ? payload["media_id"] : typeof payload["mediaId"] === "string" ? payload["mediaId"] : void 0;
  if (!mediaId) {
    throw new DingTalkMediaUploadError("DingTalk file upload failed: response did not include a MediaID", false);
  }
  return mediaId;
}
__name(uploadDingTalkFile, "uploadDingTalkFile");

// packages/channels/dingtalk/dist/DingtalkConnectionManager.js
init_esbuild_shims();
var SOCKET_OPEN = 1;
var CONNECT_TIMEOUT_MS = 1e4;
var READY_POLL_MS = 100;
var HEARTBEAT_INTERVAL_MS = 2e4;
var MAX_HEARTBEAT_MISSES = 2;
var HEALTH_INTERVAL_MS = 6e4;
var MAX_HEALTH_FAILURES = 2;
var INITIAL_RECONNECT_DELAY_MS = 1e3;
var MAX_RECONNECT_DELAY_MS = 3e4;
var DingtalkConnectionManager = class {
  static {
    __name(this, "DingtalkConnectionManager");
  }
  options;
  running = false;
  generation = 0;
  hasStarted = false;
  startingGeneration;
  activeClient;
  readyTimer;
  resolveReadyDelay;
  heartbeatTimer;
  heartbeatMisses = 0;
  activitySinceHeartbeat = false;
  healthTimer;
  healthFailures = 0;
  reconnectTask;
  reconnectGeneration;
  socketCleanup;
  retryTimer;
  resolveRetryDelay;
  cancelConnectionAttempts = /* @__PURE__ */ new Set();
  constructor(options) {
    this.options = options;
    this.activeClient = options.initialClient;
  }
  async start() {
    if (this.running) {
      return;
    }
    const client = this.hasStarted ? this.options.createClient() : this.activeClient;
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
        this.safeDisconnect(client, "startup client");
        this.running = false;
        this.generation++;
        this.stopMonitoring();
        this.cancelReadyDelay();
        this.cancelRetryDelay();
      }
      throw error;
    } finally {
      if (this.startingGeneration === generation) {
        this.startingGeneration = void 0;
      }
    }
  }
  noteActivity(client) {
    if (!this.running || client !== this.activeClient) {
      return;
    }
    this.activitySinceHeartbeat = true;
    this.heartbeatMisses = 0;
  }
  requestReconnect(client, reason) {
    const generation = this.generation;
    if (!this.running || client !== this.activeClient || this.startingGeneration === generation || this.reconnectTask && this.reconnectGeneration === generation) {
      return;
    }
    const task = this.reconnect(reason, generation);
    this.reconnectTask = task;
    this.reconnectGeneration = generation;
    void task.catch((error) => {
      this.options.log(`reconnect failed: ${String(error)}`);
    }).finally(() => {
      if (this.reconnectTask === task) {
        this.reconnectTask = void 0;
        this.reconnectGeneration = void 0;
      }
    });
  }
  stop() {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.generation++;
    this.startingGeneration = void 0;
    this.reconnectTask = void 0;
    this.reconnectGeneration = void 0;
    this.stopMonitoring();
    this.cancelReadyDelay();
    this.cancelRetryDelay();
    for (const cancel of this.cancelConnectionAttempts) {
      cancel();
    }
    this.cancelConnectionAttempts.clear();
    this.safeDisconnect(this.activeClient, "active client");
  }
  startMonitoring(client) {
    this.stopMonitoring();
    this.activitySinceHeartbeat = true;
    this.heartbeatMisses = 0;
    this.healthFailures = 0;
    const socket = this.options.getSocket(client);
    if (socket) {
      const onPong = /* @__PURE__ */ __name(() => this.noteActivity(client), "onPong");
      const onClose = /* @__PURE__ */ __name(() => this.requestReconnect(client, "socket closed"), "onClose");
      const onError = /* @__PURE__ */ __name(() => this.requestReconnect(client, "socket error"), "onError");
      socket.on("pong", onPong);
      socket.on("close", onClose);
      socket.on("error", onError);
      this.socketCleanup = () => {
        socket.off("pong", onPong);
        socket.off("close", onClose);
        socket.off("error", onError);
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
        this.requestReconnect(client, "heartbeat timeout");
        return;
      }
      const socket2 = this.options.getSocket(client);
      if (!socket2 || socket2.readyState !== SOCKET_OPEN) {
        this.requestReconnect(client, "socket is not open");
        return;
      }
      try {
        socket2.ping();
      } catch (error) {
        this.requestReconnect(client, `socket ping failed: ${String(error)}`);
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.healthTimer = setInterval(() => {
      if (!this.running || client !== this.activeClient) {
        return;
      }
      if (client.connected && this.options.getSocket(client)?.readyState === SOCKET_OPEN) {
        this.healthFailures = 0;
        return;
      }
      this.healthFailures++;
      if (this.healthFailures >= MAX_HEALTH_FAILURES) {
        this.requestReconnect(client, "unhealthy connection state");
      }
    }, HEALTH_INTERVAL_MS);
  }
  stopMonitoring() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = void 0;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = void 0;
    }
    this.socketCleanup?.();
    this.socketCleanup = void 0;
  }
  async reconnect(reason, generation) {
    const previousClient = this.activeClient;
    let retryDelay = INITIAL_RECONNECT_DELAY_MS;
    while (this.running && generation === this.generation) {
      let replacement;
      try {
        replacement = this.options.createClient();
        await this.connectClient(replacement, generation);
        if (!this.running || generation !== this.generation) {
          this.safeDisconnect(replacement, "stale replacement client");
          return;
        }
        this.activeClient = replacement;
        this.stopMonitoring();
        this.options.onClientChanged(replacement);
        this.startMonitoring(replacement);
        this.safeDisconnect(previousClient, "replaced client");
        return;
      } catch (error) {
        if (replacement) {
          this.safeDisconnect(replacement, "failed replacement client");
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
  async connectClient(client, generation) {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    let abortAttempt = false;
    let timeout;
    let rejectAttempt;
    const attemptEnded = new Promise((_resolve, reject) => {
      rejectAttempt = reject;
      timeout = setTimeout(() => {
        abortAttempt = true;
        reject(new Error("Timed out connecting to DingTalk Stream."));
      }, CONNECT_TIMEOUT_MS);
    });
    const cancel = /* @__PURE__ */ __name(() => {
      abortAttempt = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = void 0;
      }
      rejectAttempt(new Error("DingTalk connection manager stopped."));
    }, "cancel");
    this.cancelConnectionAttempts.add(cancel);
    const connect = client.connect();
    try {
      await Promise.race([connect, attemptEnded]);
    } catch (error) {
      if (abortAttempt) {
        void connect.then(() => this.safeDisconnect(client, "late connection client"), () => void 0);
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
  safeDisconnect(client, context) {
    try {
      client.disconnect();
    } catch (error) {
      this.options.log(`failed to disconnect ${context}: ${String(error)}`);
    }
  }
  waitForRetry(delay) {
    return new Promise((resolve) => {
      this.resolveRetryDelay = resolve;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = void 0;
        this.resolveRetryDelay = void 0;
        resolve();
      }, delay);
    });
  }
  async waitUntilReady(client, generation, deadline) {
    while (this.running && generation === this.generation) {
      if (client.connected && this.options.getSocket(client)?.readyState === SOCKET_OPEN) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out connecting to DingTalk Stream.");
      }
      await this.waitForReadyPoll();
    }
    throw new Error("DingTalk connection manager stopped.");
  }
  waitForReadyPoll() {
    return new Promise((resolve) => {
      this.resolveReadyDelay = resolve;
      this.readyTimer = setTimeout(() => {
        this.readyTimer = void 0;
        this.resolveReadyDelay = void 0;
        resolve();
      }, READY_POLL_MS);
    });
  }
  cancelReadyDelay() {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = void 0;
    }
    this.resolveReadyDelay?.();
    this.resolveReadyDelay = void 0;
  }
  cancelRetryDelay() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = void 0;
    }
    this.resolveRetryDelay?.();
    this.resolveRetryDelay = void 0;
  }
};

// packages/channels/dingtalk/dist/interactive-card-client.js
init_esbuild_shims();
import { randomUUID } from "node:crypto";
var STATUS_CARD_TEMPLATE_ID = "675cde2f-f526-40cb-b828-f5b2b57b8b77.schema";
var QUESTION_CARD_TEMPLATE_ID = "c2a6355b-9724-4f7e-9653-d33fcb3311bb.schema";
var DINGTALK_API = "https://api.dingtalk.com";
var CARD_FETCH_TIMEOUT_MS = 1e4;
function isRetryableDingtalkStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500 && status <= 599;
}
__name(isRetryableDingtalkStatus, "isRetryableDingtalkStatus");
var DingtalkCardRequestError = class extends Error {
  static {
    __name(this, "DingtalkCardRequestError");
  }
  retryable;
  constructor(message, retryable) {
    super(message);
    this.retryable = retryable;
    this.name = "DingtalkCardRequestError";
  }
};
function isRetryableDingtalkCardError(error) {
  return !(error instanceof DingtalkCardRequestError) || error.retryable;
}
__name(isRetryableDingtalkCardError, "isRetryableDingtalkCardError");
function stringifyCardParamMap(cardParamMap) {
  return Object.fromEntries(Object.entries(cardParamMap).map(([key, value]) => [
    key,
    typeof value === "string" ? value : JSON.stringify(value)
  ]));
}
__name(stringifyCardParamMap, "stringifyCardParamMap");
var DingtalkInteractiveCardClient = class {
  static {
    __name(this, "DingtalkInteractiveCardClient");
  }
  options;
  fetch;
  constructor(options) {
    this.options = options;
    this.fetch = options.fetch ?? globalThis.fetch;
  }
  async createAndDeliver(input) {
    const targetModel = input.target.isGroup ? {
      imGroupOpenDeliverModel: {
        robotCode: this.options.robotCode,
        extension: { dynamicSummary: "true" }
      }
    } : {
      imRobotOpenDeliverModel: {
        spaceType: "IM_ROBOT",
        robotCode: this.options.robotCode,
        extension: { dynamicSummary: "true" }
      }
    };
    const data = await this.request("/v1.0/card/instances/createAndDeliver", "POST", {
      cardTemplateId: input.templateId,
      outTrackId: input.outTrackId,
      cardData: {
        cardParamMap: stringifyCardParamMap(input.cardParamMap)
      },
      callbackType: "STREAM",
      imGroupOpenSpaceModel: { supportForward: true },
      imRobotOpenSpaceModel: { supportForward: true },
      openSpaceId: input.target.isGroup ? `dtv1.card//IM_GROUP.${input.target.chatId}` : `dtv1.card//IM_ROBOT.${input.target.chatId}`,
      userIdType: 1,
      ...targetModel
    }, input.templateId);
    const result = data && typeof data === "object" ? data.result : void 0;
    const deliveries = result?.deliverResults;
    if (Array.isArray(deliveries)) {
      const failure = deliveries.find((entry) => entry !== null && typeof entry === "object" && entry.success === false);
      if (failure) {
        throw new DingtalkCardRequestError(`${input.templateId}: ${typeof failure.errorMsg === "string" && failure.errorMsg.trim() ? failure.errorMsg.trim() : "DingTalk card delivery failed"}`, false);
      }
    }
  }
  async openOrUpdateStream(input) {
    await this.request("/v1.0/card/streaming", "PUT", {
      outTrackId: input.outTrackId,
      guid: randomUUID(),
      key: input.key,
      content: input.content,
      isFull: true,
      isFinalize: input.finalize,
      isError: input.isError ?? false
    });
  }
  async updateInstance(input) {
    await this.request("/v1.0/card/instances", "PUT", {
      outTrackId: input.outTrackId,
      cardData: {
        cardParamMap: stringifyCardParamMap(input.cardParamMap)
      },
      cardUpdateOptions: { updateCardDataByKey: true }
    });
  }
  async request(path, method, body, templateId) {
    for (let attempt = 0; ; attempt++) {
      const token = await this.options.getAccessToken();
      const response = await this.fetch(`${DINGTALK_API}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": token
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CARD_FETCH_TIMEOUT_MS)
      });
      if (response.status === 401 && attempt === 0) {
        this.options.invalidateAccessToken(token);
        await response.body?.cancel();
        continue;
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 300);
        throw new DingtalkCardRequestError(`DingTalk Card OpenAPI ${method} ${path} failed${templateId ? ` for ${templateId}` : ""}: HTTP ${response.status}${detail ? ` ${detail}` : ""}`, isRetryableDingtalkStatus(response.status));
      }
      return response.json().catch(() => void 0);
    }
  }
};

// packages/channels/dingtalk/dist/interactive-card-types.js
init_esbuild_shims();
var DINGTALK_INTERACTIVE_CARD_TIMEOUT_EXCLUSIVE_MINIMUM = 0;
var DINGTALK_INTERACTIVE_CARD_TIMEOUT_MAXIMUM_MS = 2147483647;
var DEFAULT_QUESTION_TIMEOUT_MS = 27e4;
function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
__name(asRecord, "asRecord");
function parseEmbeddedRecord(value) {
  if (typeof value !== "string") {
    return asRecord(value);
  }
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return void 0;
  }
}
__name(parseEmbeddedRecord, "parseEmbeddedRecord");
function parseBooleanLike(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}
__name(parseBooleanLike, "parseBooleanLike");
function optionalBoolean(value, path, fallback) {
  if (value === void 0)
    return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`DingTalk interactiveCards.${path} must be a boolean.`);
  }
  return value;
}
__name(optionalBoolean, "optionalBoolean");
function parseDingtalkInteractiveCardConfig(value) {
  if (value !== void 0 && !asRecord(value)) {
    throw new Error("DingTalk interactiveCards must be an object.");
  }
  const configured = value !== void 0;
  const root = asRecord(value) ?? {};
  const status = asRecord(root["statusCard"]);
  const question = asRecord(root["questionCard"]);
  const permission = asRecord(root["permissionCard"]);
  if (root["statusCard"] !== void 0 && !status) {
    throw new Error("DingTalk interactiveCards.statusCard must be an object.");
  }
  if (root["questionCard"] !== void 0 && !question) {
    throw new Error("DingTalk interactiveCards.questionCard must be an object.");
  }
  if (root["permissionCard"] !== void 0 && !permission) {
    throw new Error("DingTalk interactiveCards.permissionCard must be an object.");
  }
  const questionTimeoutMs = question?.["timeoutMs"] === void 0 ? DEFAULT_QUESTION_TIMEOUT_MS : question["timeoutMs"];
  if (typeof questionTimeoutMs !== "number" || !Number.isFinite(questionTimeoutMs) || questionTimeoutMs <= DINGTALK_INTERACTIVE_CARD_TIMEOUT_EXCLUSIVE_MINIMUM) {
    throw new Error("DingTalk interactiveCards.questionCard.timeoutMs must be a finite positive number.");
  }
  const permissionTimeoutMs = permission?.["timeoutMs"] === void 0 ? DEFAULT_QUESTION_TIMEOUT_MS : permission["timeoutMs"];
  if (typeof permissionTimeoutMs !== "number" || !Number.isFinite(permissionTimeoutMs) || permissionTimeoutMs <= DINGTALK_INTERACTIVE_CARD_TIMEOUT_EXCLUSIVE_MINIMUM) {
    throw new Error("DingTalk interactiveCards.permissionCard.timeoutMs must be a finite positive number.");
  }
  return {
    enabled: optionalBoolean(root["enabled"], "enabled", configured),
    statusCard: {
      enabled: optionalBoolean(status?.["enabled"], "statusCard.enabled", true)
    },
    questionCard: {
      enabled: optionalBoolean(question?.["enabled"], "questionCard.enabled", true),
      timeoutMs: Math.min(questionTimeoutMs, DINGTALK_INTERACTIVE_CARD_TIMEOUT_MAXIMUM_MS)
    },
    permissionCard: {
      enabled: optionalBoolean(permission?.["enabled"], "permissionCard.enabled", true),
      timeoutMs: Math.min(permissionTimeoutMs, DINGTALK_INTERACTIVE_CARD_TIMEOUT_MAXIMUM_MS)
    }
  };
}
__name(parseDingtalkInteractiveCardConfig, "parseDingtalkInteractiveCardConfig");
function parseDingtalkCardCallback(value) {
  const root = parseEmbeddedRecord(value);
  if (!root)
    return void 0;
  const embeddedValue = parseEmbeddedRecord(root["value"]);
  const embeddedContent = parseEmbeddedRecord(root["content"]);
  const privateSources = [embeddedValue, embeddedContent, root].map((source) => parseEmbeddedRecord(source?.["cardPrivateData"])).filter((source) => source !== void 0);
  const sources = [
    embeddedValue,
    embeddedContent,
    ...privateSources,
    root
  ].filter((source) => source !== void 0);
  const pickString = /* @__PURE__ */ __name((...keys) => {
    for (const source of sources) {
      for (const key of keys) {
        const candidate = source[key];
        if (typeof candidate === "string" && candidate.trim()) {
          return candidate.trim();
        }
      }
    }
    return void 0;
  }, "pickString");
  const privateData = privateSources[0];
  const actionIds = privateData?.["actionIds"];
  const actionId = (Array.isArray(actionIds) && typeof actionIds[0] === "string" && actionIds[0].trim() ? actionIds[0].trim() : void 0) ?? pickString("actionValue", "eventKey", "actionId");
  const outTrackId = pickString("outTrackId");
  const actorId = parseDingtalkCardActorId(root);
  if (!outTrackId || !actionId || !actorId)
    return void 0;
  const params = sources.map((source) => parseEmbeddedRecord(source["params"])).find((source) => source !== void 0);
  const formData = sources.flatMap((source) => [
    parseEmbeddedRecord(source["formData"]),
    parseEmbeddedRecord(parseEmbeddedRecord(source["params"])?.["form"])
  ]).find((source) => source !== void 0);
  const hasCancelField = params !== void 0 && Object.prototype.hasOwnProperty.call(params, "user_cancel");
  return {
    outTrackId,
    actionId,
    actorId,
    formData: formData ?? {},
    hasBusinessPayload: formData !== void 0 || hasCancelField,
    isCancel: hasCancelField && parseBooleanLike(params["user_cancel"])
  };
}
__name(parseDingtalkCardCallback, "parseDingtalkCardCallback");
function parseDingtalkCardActorId(value) {
  const root = parseEmbeddedRecord(value);
  if (!root)
    return void 0;
  return ["userId", "senderStaffId", "senderId"].map((key) => root[key]).find((candidate) => typeof candidate === "string" && candidate.trim().length > 0)?.trim();
}
__name(parseDingtalkCardActorId, "parseDingtalkCardActorId");

// packages/channels/dingtalk/dist/status-card-controller.js
init_esbuild_shims();
import { randomUUID as randomUUID2 } from "node:crypto";

// packages/channels/dingtalk/dist/presentation-phase.js
init_esbuild_shims();
var DINGTALK_PRESENTATION_PHASE_LABELS = {
  thinking: "\u{1F914} Thinking",
  reading: "\u{1F4D6} Reading",
  searching: "\u{1F50E} Searching",
  running: "\u{1F5A5}\uFE0F Running",
  editing: "\u{1F6E0}\uFE0F Editing",
  deleting: "\u{1F5D1}\uFE0F Deleting",
  moving: "\u{1F4E6} Moving",
  fetching: "\u{1F310} Fetching",
  switching: "\u{1F504} Switching mode",
  working: "\u{1F6E0}\uFE0F Working",
  failed: "\u26A0\uFE0F Tool failed",
  replying: "\u270D\uFE0F Replying"
};
var DINGTALK_ZH_PRESENTATION_PHASE_LABELS = {
  thinking: "\u{1F914} \u601D\u8003\u4E2D",
  reading: "\u{1F4D6} \u8BFB\u53D6\u4E2D",
  searching: "\u{1F50E} \u641C\u7D22\u4E2D",
  running: "\u{1F5A5}\uFE0F \u6267\u884C\u4E2D",
  editing: "\u{1F6E0}\uFE0F \u7F16\u8F91\u4E2D",
  deleting: "\u{1F5D1}\uFE0F \u5220\u9664\u4E2D",
  moving: "\u{1F4E6} \u79FB\u52A8\u4E2D",
  fetching: "\u{1F310} \u83B7\u53D6\u4E2D",
  switching: "\u{1F504} \u5207\u6362\u6A21\u5F0F\u4E2D",
  working: "\u{1F6E0}\uFE0F \u5904\u7406\u4E2D",
  failed: "\u26A0\uFE0F \u5DE5\u5177\u5931\u8D25",
  replying: "\u270D\uFE0F \u56DE\u590D\u4E2D"
};
function isChinesePresentationLanguage(language) {
  const normalized = language?.trim().toLowerCase().replaceAll("_", "-");
  return normalized === "zh" || normalized === "zh-cn";
}
__name(isChinesePresentationLanguage, "isChinesePresentationLanguage");
function partialOutputLabel(language) {
  return isChinesePresentationLanguage(language) ? "\uFF08\u90E8\u5206\uFF09" : "(partial)";
}
__name(partialOutputLabel, "partialOutputLabel");
function markPartialOutput(text, language) {
  const label = partialOutputLabel(language);
  return !text.trim() || text.startsWith(label) ? text : `${label}

${text}`;
}
__name(markPartialOutput, "markPartialOutput");
function presentationPhaseLabel(phase, language) {
  return (isChinesePresentationLanguage(language) ? DINGTALK_ZH_PRESENTATION_PHASE_LABELS : DINGTALK_PRESENTATION_PHASE_LABELS)[phase];
}
__name(presentationPhaseLabel, "presentationPhaseLabel");
function toolPresentationPhase(kind) {
  switch (kind.trim().toLowerCase()) {
    case "read":
      return "reading";
    case "edit":
      return "editing";
    case "delete":
      return "deleting";
    case "move":
      return "moving";
    case "search":
      return "searching";
    case "execute":
      return "running";
    case "think":
      return "thinking";
    case "fetch":
      return "fetching";
    case "switch_mode":
      return "switching";
    case "other":
      return "working";
    default:
      if (/read/iu.test(kind))
        return "reading";
      if (/search|browser|web/iu.test(kind))
        return "searching";
      if (/shell|exec|command|run/iu.test(kind))
        return "running";
      if (/edit|write|patch/iu.test(kind))
        return "editing";
      return "working";
  }
}
__name(toolPresentationPhase, "toolPresentationPhase");
function lifecyclePresentationPhase(event) {
  if (event.type === "text_chunk")
    return "replying";
  if (event.type !== "tool_call")
    return void 0;
  if (/fail|error/iu.test(event.toolCall.status))
    return "failed";
  if (/complete|success/iu.test(event.toolCall.status))
    return "thinking";
  return toolPresentationPhase(event.toolCall.kind);
}
__name(lifecyclePresentationPhase, "lifecyclePresentationPhase");

// packages/channels/dingtalk/dist/status-card-controller.js
var FLUSH_INTERVAL_MS = 500;
var STATUS_REFRESH_INTERVAL_MS = 1e3;
var CONTENT_SYNC_INTERVAL_SECONDS = 5;
var BREAKER_PROBE_INTERVAL_MS = 3e4;
var MAX_CONSECUTIVE_STATUS_FAILURES = 3;
var INITIAL_RETRY_INTERVAL_MS = 1e3;
var MAX_RETRY_INTERVAL_MS = 3e4;
var CONTENT_LIMIT = 2e4;
var TRUNCATION_MARKER = "[Earlier output truncated]\n";
function boundContent(content) {
  if (content.length <= CONTENT_LIMIT)
    return content;
  return `${TRUNCATION_MARKER}${content.slice(content.length - (CONTENT_LIMIT - TRUNCATION_MARKER.length))}`;
}
__name(boundContent, "boundContent");
function activeContent(phase, content, language, sourcePrefix) {
  const label = presentationPhaseLabel(phase, language);
  const sanitized = sanitizeStreamingImageMarkers(content);
  const renderedSourcePrefix = sourcePrefix && (sanitized === sourcePrefix || sanitized.startsWith(`${sourcePrefix}

`)) ? sourcePrefix : void 0;
  const body = renderedSourcePrefix ? sanitized.slice(renderedSourcePrefix.length + (sanitized.length === renderedSourcePrefix.length ? 0 : 2)) : sanitized;
  const prefix = [label, renderedSourcePrefix].filter(Boolean).join("\n\n");
  if (!body)
    return prefix;
  const separator = "\n\n";
  const available = CONTENT_LIMIT - prefix.length - separator.length;
  if (body.length <= available)
    return `${prefix}${separator}${body}`;
  return `${prefix}${separator}${TRUNCATION_MARKER}${body.slice(body.length - (available - TRUNCATION_MARKER.length))}`;
}
__name(activeContent, "activeContent");
var StatusCardController = class {
  static {
    __name(this, "StatusCardController");
  }
  options;
  recordsBySegment = /* @__PURE__ */ new Map();
  recordsByOutTrack = /* @__PURE__ */ new Map();
  segmentIdsByRun = /* @__PURE__ */ new Map();
  terminalSegmentIds = /* @__PURE__ */ new Set();
  disposed = false;
  constructor(options) {
    this.options = options;
  }
  async deliverCompletedResult(target, text, sourceLabel, result = { status: "completed" }) {
    const content = sourceLabel ? `${escapeDingTalkMarkdown(sourceLabel)}

${text}` : text;
    if (this.disposed || !text.trim() || content.length > CONTENT_LIMIT) {
      return false;
    }
    const state = result.status === "failed" ? "Failed" : result.status === "stopped" ? "Stopped" : result.status === "cancelled" ? "Cancelled" : result.partial || result.status !== "completed" ? "Partial" : "Completed";
    try {
      await this.options.client.createAndDeliver({
        templateId: STATUS_CARD_TEMPLATE_ID,
        outTrackId: `qwen-result-${randomUUID2()}`,
        target,
        cardParamMap: this.terminalCardParams(content, [this.statusStateLabel(state), this.options.model?.trim()].filter(Boolean).join(" \xB7 "))
      });
      return true;
    } catch (error) {
      this.options.onError?.("completed result card", error);
      return false;
    }
  }
  terminalCardParams(content, statusLine) {
    return {
      blockList: JSON.stringify([{ type: 0, markdown: content }]),
      content,
      copy_content: content,
      flowStatus: 3,
      statusLine,
      hasAction: "false",
      stop_action: "false"
    };
  }
  ensure(segment, target) {
    if (this.disposed)
      return;
    if (this.terminalSegmentIds.has(segment.segmentId))
      return;
    if (!this.recordsBySegment.has(segment.segmentId)) {
      this.createRecord(segment, target);
    }
  }
  replace(segment, target, content) {
    if (this.disposed)
      return;
    if (this.terminalSegmentIds.has(segment.segmentId))
      return;
    const record = this.recordsBySegment.get(segment.segmentId);
    if (!record) {
      this.createRecord(segment, target, content);
      return;
    }
    if (record.terminal)
      return;
    record.content = boundContent(content);
    record.contentVersion++;
    if (record.streamFailed)
      return;
    record.hasPendingWrite = true;
    this.scheduleFlush(record);
  }
  /**
   * Whether a created, still-running status card is displaying content for
   * this segment. Awaits the in-flight creation so a boundary decision made
   * while creation is pending does not race it. A latched stream failure
   * means the card can never show further content, so it is not live. A
   * creation that is backing off for a retry is not awaited either (see
   * `awaitDelivery`).
   */
  async isCardLive(segmentId) {
    if (this.disposed)
      return false;
    const record = this.recordsBySegment.get(segmentId);
    if (!record || record.terminal || record.streamFailed)
      return false;
    return this.awaitDelivery(record);
  }
  /**
   * Drain any pending snapshot so callers can treat the card's current
   * content as delivered. Returns false when there is no live record, the
   * card never became ready, or the stream failed during the drain, so the
   * caller can fall back instead of claiming delivery.
   */
  async flushPending(segmentId) {
    if (this.disposed)
      return false;
    const record = this.recordsBySegment.get(segmentId);
    if (!record || record.terminal)
      return false;
    if (!await this.awaitDelivery(record))
      return false;
    while (!record.terminal && !record.streamFailed) {
      if (record.flushTimer) {
        clearTimeout(record.flushTimer);
        record.flushTimer = void 0;
      }
      if (record.streamRetryTimer) {
        clearTimeout(record.streamRetryTimer);
        record.streamRetryTimer = void 0;
      }
      const failureVersion = record.streamFailureVersion;
      this.flush(record);
      await record.writeChain;
      if (record.streamFailureVersion !== failureVersion)
        return false;
      if (!record.hasPendingWrite)
        break;
    }
    return !record.terminal && !record.streamFailed;
  }
  abandon(segmentId) {
    const record = this.recordsBySegment.get(segmentId);
    if (!record || record.terminal)
      return;
    record.terminal = true;
    record.hasPendingWrite = false;
    void record.ready.then((ready) => {
      if (!ready)
        return;
      void this.options.client.updateInstance({
        outTrackId: record.outTrackId,
        cardParamMap: {
          flowStatus: 3,
          hasAction: "false",
          stop_action: "false"
        }
      }).catch(() => {
      });
    });
    this.removeRecord(record);
  }
  /**
   * Resolves once the card is known to be delivered (or not) without waiting
   * through a creation backoff: `creationAttempt` is the failed attempt until
   * the retry actually starts, so a boundary reached mid-backoff falls back
   * to text while the retry keeps running for later output.
   */
  async awaitDelivery(record) {
    if (!await record.creationAttempt)
      return false;
    return record.ready;
  }
  createRecord(segment, target, initialContent = "") {
    const outTrackId = `qwen-status-${randomUUID2()}`;
    const record = {
      segmentId: segment.segmentId,
      runId: segment.runId,
      sessionId: segment.sessionId,
      ownerId: segment.owner.id,
      target,
      outTrackId,
      content: boundContent(initialContent),
      ...segment.sourceLabel ? { sourcePrefix: escapeDingTalkMarkdown(segment.sourceLabel) } : {},
      phase: "thinking",
      startedAt: Date.now(),
      lastStatusSecond: 0,
      lastContentSyncSecond: 0,
      ready: Promise.resolve(false),
      creationAttempt: Promise.resolve(false),
      terminal: false,
      streamFailed: false,
      streamFailureVersion: 0,
      createRetryAttempt: 0,
      streamRetryAttempt: 0,
      terminalRetryAttempt: 0,
      consecutiveStatusFailures: 0,
      stopClaimed: false,
      forbiddenActors: /* @__PURE__ */ new Set(),
      lastWriteAt: Date.now(),
      contentVersion: 0,
      hasPendingWrite: false,
      writeChain: Promise.resolve()
    };
    this.recordsBySegment.set(record.segmentId, record);
    this.recordsByOutTrack.set(outTrackId, record);
    const segmentIds = this.segmentIdsByRun.get(record.runId) ?? /* @__PURE__ */ new Set();
    segmentIds.add(record.segmentId);
    this.segmentIdsByRun.set(record.runId, segmentIds);
    record.ready = this.create(record, target);
    void record.ready.then((ready) => {
      if (ready)
        this.scheduleStatusRefresh(record);
    });
    return record;
  }
  complete(segmentId, text, retainedContent, partial = false) {
    return this.finalize(segmentId, boundContent(text), partial ? "Partial" : "Completed", false, retainedContent);
  }
  updateRunPhase(runId, phase) {
    if (this.disposed)
      return;
    for (const segmentId of this.segmentIdsByRun.get(runId) ?? []) {
      const record = this.recordsBySegment.get(segmentId);
      if (!record || record.terminal || record.streamFailed || record.phase === phase) {
        continue;
      }
      record.phase = phase;
      record.contentVersion++;
      record.hasPendingWrite = true;
      this.scheduleFlush(record);
    }
  }
  fail(segmentId, error) {
    void this.finalize(segmentId, boundContent(error), "Failed", true);
  }
  cancelRun(runId, reason) {
    if (this.disposed)
      return;
    for (const segmentId of [...this.segmentIdsByRun.get(runId) ?? []]) {
      const record = this.recordsBySegment.get(segmentId);
      if (!record)
        continue;
      void this.finalize(segmentId, sanitizeStreamingImageMarkers(record.content), reason === "cancel_command" ? "Stopped" : "Cancelled", false);
    }
  }
  claimStop(outTrackId, actorId) {
    if (this.disposed)
      return { kind: "ignored", actorId };
    const record = this.recordsByOutTrack.get(outTrackId);
    if (!record || record.terminal || record.stopClaimed) {
      return { kind: "ignored", actorId };
    }
    if (record.ownerId !== actorId) {
      if (record.forbiddenActors.has(actorId)) {
        return { kind: "ignored" };
      }
      record.forbiddenActors.add(actorId);
      return { kind: "forbidden", actorId, target: record.target };
    }
    record.stopClaimed = true;
    return {
      kind: "accepted",
      execute: /* @__PURE__ */ __name(async () => {
        const cancelled = await this.options.cancelRun(record.sessionId, record.runId);
        if (this.recordsByOutTrack.get(outTrackId) !== record || record.terminal) {
          return;
        }
        if (!cancelled) {
          record.stopClaimed = false;
          return;
        }
        this.cancelRun(record.runId, "cancel_command");
      }, "execute")
    };
  }
  async create(record, target) {
    for (; ; ) {
      let settleAttempt;
      record.creationAttempt = new Promise((resolve) => {
        settleAttempt = resolve;
      });
      try {
        await this.options.client.createAndDeliver({
          templateId: STATUS_CARD_TEMPLATE_ID,
          outTrackId: record.outTrackId,
          target,
          cardParamMap: {
            content: activeContent(record.phase, record.content, this.options.language, record.sourcePrefix),
            flowStatus: 2,
            statusLine: this.statusLine(record).text,
            hasAction: "true",
            stop_action: "true"
          }
        });
        settleAttempt(true);
        break;
      } catch (error) {
        settleAttempt(false);
        this.options.onError?.("status card creation", error);
        if (this.disposed || record.terminal || !isRetryableDingtalkCardError(error)) {
          return false;
        }
        if (!await this.waitForCreationRetry(record))
          return false;
      }
    }
    if (this.disposed)
      return false;
    if (this.recordsBySegment.get(record.segmentId) !== record)
      return true;
    try {
      await this.options.client.openOrUpdateStream({
        outTrackId: record.outTrackId,
        key: "content",
        content: activeContent(record.phase, record.content, this.options.language, record.sourcePrefix),
        finalize: false
      });
    } catch (error) {
      this.handleStreamFailure(record, error);
    }
    return true;
  }
  /**
   * Sleeps for the next creation backoff. Resolves false when finalization or
   * disposal abandons the creation so `ready` settles without waiting.
   */
  waitForCreationRetry(record) {
    const delay = this.retryDelay(record.createRetryAttempt++);
    return new Promise((resolve) => {
      const settle2 = /* @__PURE__ */ __name((resumed) => {
        if (record.createRetryTimer)
          clearTimeout(record.createRetryTimer);
        record.createRetryTimer = void 0;
        record.abandonCreation = void 0;
        resolve(resumed);
      }, "settle");
      record.abandonCreation = () => settle2(false);
      record.createRetryTimer = setTimeout(() => settle2(true), delay);
    });
  }
  scheduleFlush(record) {
    if (record.flushTimer || record.streamRetryTimer || record.inFlight || record.terminal)
      return;
    const delay = Math.max(0, FLUSH_INTERVAL_MS - (Date.now() - record.lastWriteAt));
    record.flushTimer = setTimeout(() => {
      record.flushTimer = void 0;
      this.flush(record);
    }, delay);
  }
  flush(record) {
    if (this.disposed || record.terminal || record.streamFailed || record.inFlight || !record.hasPendingWrite)
      return;
    record.hasPendingWrite = false;
    let sentVersion;
    let contentWritten = false;
    const write = record.writeChain.then(async () => {
      const ready = await record.ready;
      if (!ready || record.terminal || record.streamFailed)
        return;
      sentVersion = record.contentVersion;
      await this.options.client.openOrUpdateStream({
        outTrackId: record.outTrackId,
        key: "content",
        content: activeContent(record.phase, record.content, this.options.language, record.sourcePrefix),
        finalize: false
      });
      contentWritten = true;
      record.streamRetryAttempt = 0;
      await this.updateRunningStatus(record);
    }).catch((error) => this.handleStreamFailure(record, error));
    const tracked = write.finally(() => {
      if (record.inFlight === tracked) {
        record.inFlight = void 0;
      }
      record.lastWriteAt = Date.now();
      if (contentWritten && record.contentVersion === sentVersion) {
        record.hasPendingWrite = false;
      }
      if (record.hasPendingWrite && record.contentVersion !== sentVersion) {
        this.scheduleFlush(record);
      }
    });
    record.inFlight = tracked;
    record.writeChain = tracked;
  }
  async finalize(segmentId, content, state, isError, retainedContent) {
    if (this.disposed)
      return false;
    const record = this.recordsBySegment.get(segmentId);
    if (!record || record.terminal)
      return false;
    record.terminal = true;
    this.terminalSegmentIds.add(segmentId);
    while (this.terminalSegmentIds.size > 1e3) {
      const oldest = this.terminalSegmentIds.values().next().value;
      if (oldest === void 0)
        break;
      this.terminalSegmentIds.delete(oldest);
    }
    if (record.flushTimer)
      clearTimeout(record.flushTimer);
    record.flushTimer = void 0;
    if (record.streamRetryTimer)
      clearTimeout(record.streamRetryTimer);
    record.streamRetryTimer = void 0;
    if (record.statusTimer)
      clearTimeout(record.statusTimer);
    record.statusTimer = void 0;
    record.hasPendingWrite = false;
    record.abandonCreation?.();
    if (!await record.ready) {
      this.removeRecord(record);
      return false;
    }
    await record.writeChain;
    const retained = content || (retainedContent ? retainedContent(record.content) : record.content);
    record.terminalIntent = {
      content: boundContent(sanitizeStreamingImageMarkers(retained)),
      isError,
      statusLine: this.statusLine(record, state).text,
      streamFinalizeSettled: false
    };
    return this.attemptFinalization(record);
  }
  async attemptFinalization(record) {
    if (this.disposed)
      return false;
    if (this.recordsBySegment.get(record.segmentId) !== record)
      return false;
    const intent = record.terminalIntent;
    if (!intent)
      return false;
    if (!intent.streamFinalizeSettled) {
      try {
        await this.options.client.openOrUpdateStream({
          outTrackId: record.outTrackId,
          key: "content",
          content: "",
          finalize: true,
          isError: intent.isError
        });
        intent.streamFinalizeSettled = true;
      } catch (error) {
        if (!isRetryableDingtalkCardError(error)) {
          intent.streamFinalizeSettled = true;
        }
        this.options.onError?.("status card finalization", error);
      }
    }
    if (this.disposed)
      return false;
    try {
      await this.options.client.updateInstance({
        outTrackId: record.outTrackId,
        cardParamMap: this.terminalCardParams(intent.content, intent.statusLine)
      });
      record.content = "";
      this.removeRecord(record);
      return true;
    } catch (error) {
      this.options.onError?.("status card finalization", error);
      if (isRetryableDingtalkCardError(error)) {
        this.scheduleTerminalRetry(record);
        return true;
      } else {
        this.removeRecord(record);
      }
      return false;
    }
  }
  scheduleStreamRetry(record) {
    if (this.disposed || record.terminal || record.streamFailed || record.streamRetryTimer) {
      return;
    }
    const delay = this.retryDelay(record.streamRetryAttempt++);
    record.streamRetryTimer = setTimeout(() => {
      record.streamRetryTimer = void 0;
      if (this.disposed || record.terminal || record.streamFailed)
        return;
      this.flush(record);
    }, delay);
  }
  scheduleTerminalRetry(record) {
    if (this.disposed || !record.terminalIntent || record.terminalRetryTimer) {
      return;
    }
    const delay = this.retryDelay(record.terminalRetryAttempt++);
    record.terminalRetryTimer = setTimeout(() => {
      record.terminalRetryTimer = void 0;
      if (this.disposed)
        return;
      void this.attemptFinalization(record);
    }, delay);
  }
  handleStreamFailure(record, error) {
    record.streamFailureVersion++;
    if (!this.disposed && !record.terminal && isRetryableDingtalkCardError(error)) {
      record.hasPendingWrite = true;
      this.scheduleStreamRetry(record);
    } else if (!record.terminal) {
      record.streamFailed = true;
      record.hasPendingWrite = false;
      if (record.statusTimer) {
        clearTimeout(record.statusTimer);
        record.statusTimer = void 0;
      }
    }
    this.options.onError?.("status card streaming", error);
  }
  retryDelay(attempt) {
    return Math.min(INITIAL_RETRY_INTERVAL_MS * 2 ** Math.min(attempt, 10), MAX_RETRY_INTERVAL_MS);
  }
  removeRecord(record) {
    record.abandonCreation?.();
    if (record.flushTimer)
      clearTimeout(record.flushTimer);
    if (record.streamRetryTimer)
      clearTimeout(record.streamRetryTimer);
    if (record.terminalRetryTimer)
      clearTimeout(record.terminalRetryTimer);
    if (record.statusTimer)
      clearTimeout(record.statusTimer);
    record.flushTimer = void 0;
    record.streamRetryTimer = void 0;
    record.terminalRetryTimer = void 0;
    record.statusTimer = void 0;
    if (this.recordsBySegment.get(record.segmentId) === record) {
      this.recordsBySegment.delete(record.segmentId);
    }
    if (this.recordsByOutTrack.get(record.outTrackId) === record) {
      this.recordsByOutTrack.delete(record.outTrackId);
    }
    const segmentIds = this.segmentIdsByRun.get(record.runId);
    segmentIds?.delete(record.segmentId);
    if (segmentIds?.size === 0) {
      this.segmentIdsByRun.delete(record.runId);
    }
  }
  dispose() {
    if (this.disposed)
      return;
    this.disposed = true;
    for (const record of [...this.recordsBySegment.values()]) {
      record.terminal = true;
      record.hasPendingWrite = false;
      this.removeRecord(record);
    }
    this.terminalSegmentIds.clear();
  }
  statusLine(record, state) {
    const second = Math.max(0, Math.floor((Date.now() - record.startedAt) / 1e3));
    const model = this.options.model?.trim();
    return {
      text: [
        state ? this.statusStateLabel(state) : void 0,
        model,
        `${second}s`
      ].filter(Boolean).join(" \xB7 "),
      second
    };
  }
  statusStateLabel(state) {
    if (!isChinesePresentationLanguage(this.options.language))
      return state;
    return {
      Completed: "\u5DF2\u5B8C\u6210",
      Failed: "\u5DF2\u5931\u8D25",
      Stopped: "\u5DF2\u7EC8\u6B62",
      Cancelled: "\u5DF2\u53D6\u6D88",
      Partial: "\u90E8\u5206\u7ED3\u679C"
    }[state] ?? state;
  }
  async updateRunningStatus(record) {
    if (this.disposed || record.terminal || record.streamFailed)
      return;
    const status = this.statusLine(record);
    if (status.second === record.lastStatusSecond)
      return;
    const syncContent = status.second - record.lastContentSyncSecond >= CONTENT_SYNC_INTERVAL_SECONDS;
    try {
      await this.options.client.updateInstance({
        outTrackId: record.outTrackId,
        cardParamMap: {
          ...syncContent ? {
            content: activeContent(record.phase, record.content, this.options.language, record.sourcePrefix)
          } : {},
          statusLine: status.text
        }
      });
      record.lastStatusSecond = status.second;
      if (syncContent)
        record.lastContentSyncSecond = status.second;
      record.consecutiveStatusFailures = 0;
      if (record.statusTimer) {
        clearTimeout(record.statusTimer);
        record.statusTimer = void 0;
      }
      this.scheduleStatusRefresh(record);
    } catch (error) {
      record.consecutiveStatusFailures++;
      this.options.onError?.("status card metadata", error);
    }
  }
  scheduleStatusRefresh(record, intervalMs = STATUS_REFRESH_INTERVAL_MS) {
    if (this.disposed || record.terminal || record.streamFailed || record.statusTimer)
      return;
    const elapsed = Math.max(0, Date.now() - record.startedAt);
    const delay = Math.max(50, intervalMs - elapsed % intervalMs);
    record.statusTimer = setTimeout(() => {
      record.statusTimer = void 0;
      if (this.disposed || record.terminal || record.streamFailed)
        return;
      const refresh = record.writeChain.then(() => this.updateRunningStatus(record));
      record.writeChain = refresh;
      void refresh.finally(() => {
        if (record.consecutiveStatusFailures >= MAX_CONSECUTIVE_STATUS_FAILURES) {
          this.scheduleStatusRefresh(record, BREAKER_PROBE_INTERVAL_MS);
          return;
        }
        this.scheduleStatusRefresh(record);
      });
    }, delay);
  }
};

// packages/channels/dingtalk/dist/question-card-controller.js
init_esbuild_shims();
import { randomUUID as randomUUID3 } from "node:crypto";
var OTHER_OPTION_VALUE = "__qwen_other__";
var QuestionCardController = class {
  static {
    __name(this, "QuestionCardController");
  }
  options;
  byRequest = /* @__PURE__ */ new Map();
  byOutTrack = /* @__PURE__ */ new Map();
  activeByScope = /* @__PURE__ */ new Map();
  pendingByRun = /* @__PURE__ */ new Map();
  nextSequence = 0;
  constructor(options) {
    this.options = options;
  }
  async present(context, target) {
    const scopeKey = this.scopeKey(context);
    const active = this.activeByScope.get(scopeKey);
    if (active?.state === "reserved" || active?.state === "pending") {
      if (active.context.runId === context.runId) {
        return { kind: "unsupported" };
      }
      if (active.state === "pending")
        this.reserveTerminalProjection(active);
      void this.finalize(active, "expired", "A newer question is available. Answer the latest card.");
    }
    const record = {
      context,
      target,
      outTrackId: `qwen-question-${randomUUID3()}`,
      scopeKey,
      sequence: this.nextSequence++,
      state: "reserved",
      delivered: false,
      forbiddenActors: /* @__PURE__ */ new Set()
    };
    this.byRequest.set(context.requestId, record);
    this.byOutTrack.set(record.outTrackId, record);
    this.activeByScope.set(record.scopeKey, record);
    const unsubscribe = context.onSettled((reason) => {
      if (record.state === "claimed")
        return;
      if (record.state === "pending")
        this.reserveTerminalProjection(record);
      void this.finalize(record, reason === "resolved_outside_presenter" ? "resolved_outside_presenter" : "cancelled");
    });
    record.unsubscribe = unsubscribe;
    if (record.state === "terminal")
      unsubscribe();
    try {
      await this.options.client.createAndDeliver({
        templateId: QUESTION_CARD_TEMPLATE_ID,
        outTrackId: record.outTrackId,
        target,
        cardParamMap: this.cardData(context)
      });
      record.delivered = true;
    } catch (error) {
      this.options.onError?.("question card creation", error);
      if (record.state === "terminal") {
        return { kind: "presented" };
      }
      await this.finalize(record, "cancelled");
      try {
        await this.options.sendFallback(context.target.chatId, this.fallbackText(context), ...context.sourceLabel ? [context.sourceLabel] : []);
      } catch (fallbackError) {
        this.options.onError?.("question fallback delivery", fallbackError);
      }
      await context.respond({ outcome: { outcome: "cancelled" } });
      return { kind: "handled" };
    }
    if (record.state !== "reserved") {
      await this.projectTerminal(record);
      return { kind: "presented" };
    }
    const latest = this.activeByScope.get(record.scopeKey);
    if (latest && latest.sequence > record.sequence) {
      await this.finalize(record, "expired", "A newer question is available. Answer the latest card.");
      return { kind: "presented" };
    }
    record.state = "pending";
    this.activeByScope.set(record.scopeKey, record);
    const pending = this.pendingByRun.get(context.runId) ?? /* @__PURE__ */ new Set();
    pending.add(context.requestId);
    this.pendingByRun.set(context.runId, pending);
    record.timer = setTimeout(() => {
      void this.expire(record);
    }, this.options.timeoutMs);
    record.timer.unref?.();
    return { kind: "presented" };
  }
  claim(callback) {
    const record = this.byOutTrack.get(callback.outTrackId);
    if (!record || record.state !== "pending") {
      return { kind: "ignored", actorId: callback.actorId };
    }
    if (record.context.owner.id !== callback.actorId) {
      if (record.forbiddenActors.has(callback.actorId)) {
        return { kind: "ignored" };
      }
      record.forbiddenActors.add(callback.actorId);
      return {
        kind: "forbidden",
        actorId: callback.actorId,
        target: record.target
      };
    }
    if (callback.hasBusinessPayload === false) {
      return { kind: "ignored", actorId: callback.actorId };
    }
    if (callback.isCancel || callback.actionId === "cancel") {
      this.reserveTerminalProjection(record);
      record.state = "claimed";
      return {
        kind: "accepted",
        execute: /* @__PURE__ */ __name(() => this.respond(record, "cancelled"), "execute")
      };
    }
    if (callback.actionId !== "submit" && callback.actionId !== record.context.requestId) {
      return { kind: "ignored", actorId: callback.actorId };
    }
    const answers = this.parseAnswers(record, callback.formData);
    if (!answers)
      return { kind: "ignored", actorId: callback.actorId };
    this.reserveTerminalProjection(record);
    record.state = "claimed";
    return {
      kind: "accepted",
      execute: /* @__PURE__ */ __name(() => this.respond(record, "submitted", answers), "execute")
    };
  }
  cancelRun(runId, terminalState = "cancelled") {
    const requestIds = [...this.pendingByRun.get(runId) ?? []];
    for (const requestId of requestIds) {
      const record = this.byRequest.get(requestId);
      if (record) {
        this.reserveTerminalProjection(record);
        void this.finalize(record, terminalState, terminalState === "expired" ? "This question is no longer available." : void 0);
      }
    }
  }
  async respond(record, terminalState, answers) {
    try {
      const accepted = await record.context.respond(terminalState === "submitted" ? {
        outcome: {
          outcome: "selected",
          optionId: record.context.submitOptionId
        },
        answers
      } : { outcome: { outcome: "cancelled" } });
      await this.finalize(record, accepted ? terminalState : "expired", accepted ? void 0 : "This question is no longer available.");
    } catch (error) {
      this.options.onError?.("question response", error);
      await this.finalize(record, "expired", "This question is no longer available.");
    }
  }
  async expire(record) {
    if (record.state !== "pending")
      return;
    this.reserveTerminalProjection(record);
    await this.finalize(record, "expired");
    try {
      await record.context.respond({ outcome: { outcome: "cancelled" } });
    } catch (error) {
      this.options.onError?.("expired question cancellation", error);
    }
  }
  async finalize(record, state, description) {
    if (record.state === "terminal")
      return;
    record.state = "terminal";
    record.terminalState = state;
    record.terminalDescription = description;
    if (record.timer)
      clearTimeout(record.timer);
    record.timer = void 0;
    record.unsubscribe?.();
    record.unsubscribe = void 0;
    this.byRequest.delete(record.context.requestId);
    this.byOutTrack.delete(record.outTrackId);
    if (this.activeByScope.get(record.scopeKey) === record) {
      this.activeByScope.delete(record.scopeKey);
    }
    const pending = this.pendingByRun.get(record.context.runId);
    pending?.delete(record.context.requestId);
    if (pending?.size === 0)
      this.pendingByRun.delete(record.context.runId);
    if (record.delivered) {
      const finishTerminalProjection = record.finishTerminalProjection;
      record.finishTerminalProjection = void 0;
      if (finishTerminalProjection) {
        await finishTerminalProjection(() => this.projectTerminal(record));
      } else {
        await this.projectTerminal(record);
      }
    }
  }
  reserveTerminalProjection(record) {
    record.finishTerminalProjection ??= this.options.reserveRunProjection?.(record.context.runId);
  }
  async projectTerminal(record) {
    if (!record.terminalState)
      return;
    const cardParamMap = {
      submitted: {
        card_status: "submitted",
        question_desc: this.withSourceLabel(record.context, "Submitted."),
        form_btn_text: "Submitted"
      },
      expired: {
        card_status: "expired",
        question_desc: this.withSourceLabel(record.context, "This question expired. Please retry."),
        form_btn_text: "Expired"
      },
      resolved_outside_presenter: {
        card_status: "expired",
        question_desc: this.withSourceLabel(record.context, "Resolved outside this card."),
        form_btn_text: "Expired"
      },
      cancelled: {
        card_status: "cancelled",
        question_desc: this.withSourceLabel(record.context, "Cancelled."),
        form_btn_text: "Cancelled"
      }
    };
    try {
      await this.options.client.updateInstance({
        outTrackId: record.outTrackId,
        cardParamMap: {
          ...cardParamMap[record.terminalState],
          ...record.terminalDescription ? {
            question_desc: this.withSourceLabel(record.context, record.terminalDescription)
          } : {}
        }
      });
    } catch (error) {
      this.options.onError?.("question card finalization", error);
    }
  }
  parseAnswers(record, formData) {
    const allowed = new Set(record.context.questions.flatMap((question) => [
      question.answerKey,
      this.otherAnswerKey(question.answerKey)
    ]));
    if (Object.keys(formData).some((key) => !allowed.has(key))) {
      return void 0;
    }
    const answers = {};
    for (const question of record.context.questions) {
      const values = this.readAnswerValues(formData[question.answerKey]);
      if (values.length === 0 || !question.multiSelect && values.length !== 1)
        return void 0;
      const optionLabels = new Set(question.options.map((option) => option.label));
      const customValue = this.readAnswerValues(formData[this.otherAnswerKey(question.answerKey)])[0]?.trim();
      const normalized = [];
      for (const value of values) {
        if (value === OTHER_OPTION_VALUE) {
          if (!customValue)
            return void 0;
          normalized.push(customValue);
        } else if (optionLabels.has(value)) {
          normalized.push(value);
        } else {
          return void 0;
        }
      }
      answers[question.answerKey] = normalized.join(", ");
    }
    return answers;
  }
  readAnswerValues(value) {
    if (typeof value === "string")
      return value.trim() ? [value.trim()] : [];
    if (Array.isArray(value)) {
      return value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean);
    }
    if (value !== null && typeof value === "object") {
      return this.readAnswerValues(value["value"]);
    }
    return [];
  }
  otherAnswerKey(answerKey) {
    return `${answerKey}_other`;
  }
  scopeKey(context) {
    return `${context.sessionId}\0${context.owner.id}`;
  }
  cardData(context) {
    const first = context.questions[0];
    return {
      question_id: context.requestId,
      question_title: first.header,
      question_desc: this.withSourceLabel(context, first.question),
      card_status: "pending",
      form_btn_text: "Submit",
      selected_text: "",
      selected_values: "[]",
      form: {
        fields: context.questions.flatMap((question) => [
          {
            name: question.answerKey,
            label: question.question,
            type: question.multiSelect ? "MULTI_CHECKBOX_GROUP" : "CHECKBOX_GROUP",
            required: true,
            options: [
              ...question.options.map((option) => ({
                value: option.label,
                text: option.label
              })),
              { value: OTHER_OPTION_VALUE, text: "Other" }
            ]
          },
          {
            name: this.otherAnswerKey(question.answerKey),
            label: `${question.header}: Other`,
            type: "TEXT",
            required: false,
            placeholder: "Enter a custom answer when Other is selected"
          }
        ])
      }
    };
  }
  fallbackText(context) {
    const questions = context.questions.map((question) => `- ${question.question}: ${question.options.map((option) => option.label).join(", ")}`).join("\n");
    return `The interactive question could not be delivered, so this request was cancelled. Please retry.
${questions}`;
  }
  withSourceLabel(context, text) {
    if (!context.sourceLabel)
      return text;
    const label = escapeDingTalkMarkdown(context.sourceLabel);
    return `${label}

${text}`;
  }
};

// packages/channels/dingtalk/dist/permission-card-controller.js
init_esbuild_shims();
import { randomUUID as randomUUID4 } from "node:crypto";
var DECISION_FIELD = "permission_decision";
var PERMISSION_CARD_COPY = {
  en: {
    title: "Permission required",
    submit: "Submit",
    choose: "Choose how to continue",
    approved: { description: "Permission approved.", button: "Approved" },
    denied: { description: "Permission denied.", button: "Denied" },
    expired: {
      description: "This permission request is no longer available.",
      button: "Expired"
    },
    cancelled: {
      description: "Permission request cancelled.",
      button: "Cancelled"
    }
  },
  zh: {
    title: "\u9700\u8981\u6388\u6743",
    submit: "\u63D0\u4EA4",
    choose: "\u8BF7\u9009\u62E9\u540E\u7EED\u64CD\u4F5C",
    approved: { description: "\u5DF2\u6388\u6743\u3002", button: "\u5DF2\u6388\u6743" },
    denied: { description: "\u5DF2\u62D2\u7EDD\u6388\u6743\u3002", button: "\u5DF2\u62D2\u7EDD" },
    expired: { description: "\u6B64\u6388\u6743\u8BF7\u6C42\u5DF2\u5931\u6548\u3002", button: "\u5DF2\u5931\u6548" },
    cancelled: { description: "\u6388\u6743\u8BF7\u6C42\u5DF2\u53D6\u6D88\u3002", button: "\u5DF2\u53D6\u6D88" }
  }
};
var PermissionCardController = class {
  static {
    __name(this, "PermissionCardController");
  }
  options;
  byRequest = /* @__PURE__ */ new Map();
  byOutTrack = /* @__PURE__ */ new Map();
  pendingByRun = /* @__PURE__ */ new Map();
  constructor(options) {
    this.options = options;
  }
  async present(context, target) {
    const previous = this.byRequest.get(context.requestId);
    if (previous) {
      this.reserveTerminalProjection(previous);
      await this.finalize(previous, "expired");
    }
    const record = {
      context,
      target,
      outTrackId: `qwen-permission-${randomUUID4()}`,
      state: "reserved",
      delivered: false,
      forbiddenActors: /* @__PURE__ */ new Set()
    };
    this.byRequest.set(context.requestId, record);
    this.byOutTrack.set(record.outTrackId, record);
    const unsubscribe = context.onSettled((reason) => {
      if (record.state === "claimed")
        return;
      if (record.state === "pending")
        this.reserveTerminalProjection(record);
      void this.finalize(record, reason === "resolved_outside_presenter" ? "expired" : "cancelled");
    });
    record.unsubscribe = unsubscribe;
    if (record.state === "terminal")
      unsubscribe();
    try {
      await this.options.client.createAndDeliver({
        templateId: QUESTION_CARD_TEMPLATE_ID,
        outTrackId: record.outTrackId,
        target,
        cardParamMap: this.cardData(context)
      });
      record.delivered = true;
    } catch (error) {
      this.options.onError?.("permission card creation", error);
      if (record.state === "terminal")
        return { kind: "presented" };
      this.discard(record);
      return { kind: "unsupported" };
    }
    if (record.state !== "reserved") {
      await this.projectTerminal(record);
      return { kind: "presented" };
    }
    record.state = "pending";
    const pending = this.pendingByRun.get(context.runId) ?? /* @__PURE__ */ new Set();
    pending.add(context.requestId);
    this.pendingByRun.set(context.runId, pending);
    record.timer = setTimeout(() => {
      void this.expire(record);
    }, this.options.timeoutMs);
    record.timer.unref?.();
    return { kind: "presented" };
  }
  claim(callback) {
    const record = this.byOutTrack.get(callback.outTrackId);
    if (!record || record.state !== "pending") {
      return { kind: "ignored", actorId: callback.actorId };
    }
    if (record.context.owner.id !== callback.actorId) {
      if (record.forbiddenActors.has(callback.actorId)) {
        return { kind: "ignored" };
      }
      record.forbiddenActors.add(callback.actorId);
      return {
        kind: "forbidden",
        actorId: callback.actorId,
        target: record.target
      };
    }
    if (callback.hasBusinessPayload === false || !callback.isCancel && callback.actionId !== "cancel" && callback.actionId !== "submit" && callback.actionId !== record.context.requestId) {
      return { kind: "ignored", actorId: callback.actorId };
    }
    if (callback.isCancel || callback.actionId === "cancel") {
      this.reserveTerminalProjection(record);
      record.state = "claimed";
      return {
        kind: "accepted",
        execute: /* @__PURE__ */ __name(() => this.respond(record, "deny", "cancelled"), "execute")
      };
    }
    const decision = this.parseDecision(record, callback.formData);
    if (!decision)
      return { kind: "ignored", actorId: callback.actorId };
    this.reserveTerminalProjection(record);
    record.state = "claimed";
    return {
      kind: "accepted",
      execute: /* @__PURE__ */ __name(() => this.respond(record, decision), "execute")
    };
  }
  cancelRun(runId) {
    const requestIds = [...this.pendingByRun.get(runId) ?? []];
    for (const requestId of requestIds) {
      const record = this.byRequest.get(requestId);
      if (record) {
        this.reserveTerminalProjection(record);
        void this.finalize(record, "cancelled");
      }
    }
  }
  async respond(record, decision, terminalState) {
    try {
      const accepted = await record.context.respond(decision);
      await this.finalize(record, accepted ? terminalState ?? (decision === "deny" ? "denied" : "approved") : "expired");
    } catch (error) {
      this.options.onError?.("permission response", error);
      await this.finalize(record, "expired");
    }
  }
  async expire(record) {
    if (record.state !== "pending")
      return;
    this.reserveTerminalProjection(record);
    record.state = "claimed";
    const response = record.context.respond("deny").catch((error) => {
      this.options.onError?.("expired permission cancellation", error);
    });
    await this.finalize(record, "expired");
    await response;
  }
  async finalize(record, terminalState) {
    if (record.state === "terminal")
      return;
    record.state = "terminal";
    record.terminalState = terminalState;
    this.removeRecord(record);
    if (!record.delivered)
      return;
    const finishTerminalProjection = record.finishTerminalProjection;
    record.finishTerminalProjection = void 0;
    if (finishTerminalProjection) {
      await finishTerminalProjection(() => this.projectTerminal(record));
    } else {
      await this.projectTerminal(record);
    }
  }
  discard(record) {
    if (record.state === "terminal")
      return;
    record.state = "terminal";
    this.removeRecord(record);
  }
  removeRecord(record) {
    if (record.timer)
      clearTimeout(record.timer);
    record.timer = void 0;
    record.unsubscribe?.();
    record.unsubscribe = void 0;
    this.byRequest.delete(record.context.requestId);
    this.byOutTrack.delete(record.outTrackId);
    const pending = this.pendingByRun.get(record.context.runId);
    pending?.delete(record.context.requestId);
    if (pending?.size === 0)
      this.pendingByRun.delete(record.context.runId);
  }
  reserveTerminalProjection(record) {
    record.finishTerminalProjection ??= this.options.reserveRunProjection?.(record.context.runId);
  }
  async projectTerminal(record) {
    if (!record.terminalState)
      return;
    const copy = PERMISSION_CARD_COPY[this.options.locale ?? "en"];
    const cardParamMap = {
      approved: {
        card_status: "approved",
        question_desc: copy.approved.description,
        form_btn_text: copy.approved.button
      },
      denied: {
        card_status: "denied",
        question_desc: copy.denied.description,
        form_btn_text: copy.denied.button
      },
      expired: {
        card_status: "expired",
        question_desc: copy.expired.description,
        form_btn_text: copy.expired.button
      },
      cancelled: {
        card_status: "cancelled",
        question_desc: copy.cancelled.description,
        form_btn_text: copy.cancelled.button
      }
    };
    try {
      await this.options.client.updateInstance({
        outTrackId: record.outTrackId,
        cardParamMap: cardParamMap[record.terminalState]
      });
    } catch (error) {
      this.options.onError?.("permission card finalization", error);
    }
  }
  parseDecision(record, formData) {
    if (Object.keys(formData).length !== 1 || !Object.prototype.hasOwnProperty.call(formData, DECISION_FIELD)) {
      return void 0;
    }
    const values = this.readValues(formData[DECISION_FIELD]);
    if (values.length !== 1)
      return void 0;
    const decision = values[0];
    return record.context.decisions.some((candidate) => candidate.kind === decision) ? decision : void 0;
  }
  readValues(value) {
    if (typeof value === "string")
      return value.trim() ? [value.trim()] : [];
    if (Array.isArray(value)) {
      return value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean);
    }
    if (value !== null && typeof value === "object") {
      return this.readValues(value["value"]);
    }
    return [];
  }
  cardData(context) {
    const copy = PERMISSION_CARD_COPY[this.options.locale ?? "en"];
    return {
      question_id: context.requestId,
      question_title: copy.title,
      question_desc: context.title,
      card_status: "pending",
      form_btn_text: copy.submit,
      selected_text: "",
      selected_values: "[]",
      form: {
        fields: [
          {
            name: DECISION_FIELD,
            label: copy.choose,
            type: "CHECKBOX_GROUP",
            required: true,
            options: context.decisions.map((decision) => ({
              value: decision.kind,
              text: decision.label
            }))
          }
        ]
      }
    };
  }
};

// packages/channels/dingtalk/dist/interaction-presenter.js
init_esbuild_shims();
import { randomUUID as randomUUID5 } from "node:crypto";
function escapeSenderMarkdownText(text) {
  return text.replace(/([\\`*_[\]{}()#+.!|>~-])/gu, "\\$1");
}
__name(escapeSenderMarkdownText, "escapeSenderMarkdownText");
function formatSenderPrefixes(sender) {
  const senderName = sanitizeSenderName(sender.senderName);
  return {
    senderPrefix: `@${escapeSenderMarkdownText(senderName)}`,
    senderRawPrefix: `@${senderName}`
  };
}
__name(formatSenderPrefixes, "formatSenderPrefixes");
var DingtalkInteractionPresenter = class {
  static {
    __name(this, "DingtalkInteractionPresenter");
  }
  options;
  runs = /* @__PURE__ */ new Map();
  segments = /* @__PURE__ */ new Map();
  terminalSegmentIds = /* @__PURE__ */ new Set();
  constructor(options) {
    this.options = options;
  }
  registerRun(runId, ownerId, target, sessionId = "", sender, sourceLabel, sendFallback) {
    this.runs.set(runId, {
      runId,
      ownerId,
      target,
      baseContext: {
        channelName: "dingtalk",
        sessionId,
        runId,
        segmentId: runId,
        owner: { kind: "channel_user", id: ownerId },
        target: {
          channelName: "dingtalk",
          chatId: target.chatId,
          senderId: ownerId,
          isGroup: target.isGroup
        },
        sourceLabel
      },
      projectionChain: Promise.resolve(),
      output: new ChannelOutputTurn(this.options.outputMode),
      ...target.isGroup && sender ? formatSenderPrefixes(sender) : {},
      ...sourceLabel ? { sourceLabel } : {},
      ...sendFallback ? { sendFallback } : {},
      terminal: false
    });
  }
  startStatusCard(runId) {
    const run = this.runs.get(runId);
    if (!run || run.terminal)
      return;
    const statusContext = this.ensureStatusContext(run);
    void this.enqueue(run, () => {
      const statusCards = this.options.statusCards;
      const target = this.cardTarget(statusContext.target);
      statusCards?.replace(statusContext, target, this.withSourcePrefix(run, ""));
    });
  }
  updateStatusCardPhase(runId, phase) {
    const run = this.runs.get(runId);
    if (!run || run.terminal)
      return;
    void this.enqueue(run, () => this.options.statusCards?.updateRunPhase(runId, phase));
  }
  appendOutput(segment, chunk) {
    const run = this.runs.get(segment.runId);
    if (!run || run.terminal || run.ownerId !== segment.owner.id || run.target.chatId !== segment.target.chatId || run.target.isGroup !== segment.target.isGroup || !chunk || this.terminalSegmentIds.has(segment.segmentId)) {
      return;
    }
    const existing = this.segments.get(segment.segmentId);
    if (existing && existing.run !== run)
      return;
    const presentation = existing ?? {
      run,
      context: segment,
      content: "",
      preview: "",
      visible: false
    };
    presentation.content += chunk;
    presentation.preview = this.boundContent(presentation.preview + chunk);
    presentation.visible ||= chunk.trim().length > 0;
    this.segments.set(segment.segmentId, presentation);
    run.activeSegmentId = segment.segmentId;
    if (!run.output.shouldPreview(presentation.visible ? "visible" : ""))
      return;
    void this.enqueue(run, () => {
      const statusContext = this.ensureStatusContext(run, segment);
      this.options.statusCards?.replace(statusContext, this.cardTarget(statusContext.target), this.withSourcePrefix(run, presentation.preview));
    });
  }
  closeOutput(segmentId, text, reason, segment) {
    let presentation = this.segments.get(segmentId);
    if (!presentation && segment && text) {
      this.appendOutput(segment, text);
      presentation = this.segments.get(segmentId);
    }
    if (!presentation)
      return Promise.resolve(false);
    const run = presentation.run;
    if (run.terminal)
      return Promise.resolve(false);
    this.segments.delete(segmentId);
    this.addTerminalSegment(segmentId);
    if (run.activeSegmentId === segmentId) {
      run.activeSegmentId = void 0;
    }
    return this.enqueue(run, async () => {
      const decision = run.output.close(text || presentation.content, reason);
      if (decision.kind === "skip")
        return true;
      const statusCards = this.options.statusCards;
      const statusContext = this.ensureStatusContext(run, presentation.context);
      if (decision.kind === "failed") {
        statusCards?.ensure(statusContext, this.cardTarget(statusContext.target));
        statusCards?.fail(statusContext.segmentId, this.withSenderPrefix(run, "\u672C\u6B21\u5904\u7406\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002"));
        await this.redeliverCardDeliveredContent(run);
        return statusCards !== void 0;
      }
      if (decision.kind === "cancelled") {
        return statusCards !== void 0;
      }
      if (decision.kind === "preview") {
        const deliveredViaCard = statusCards !== void 0 && await statusCards.isCardLive(statusContext.segmentId) && await statusCards.flushPending(statusContext.segmentId);
        if (deliveredViaCard) {
          run.cardDelivered = {
            text: stripPartialImageMarker(decision.text),
            chatId: presentation.context.target.chatId,
            sessionId: presentation.context.sessionId
          };
        }
        run.lastOutputContext = presentation.context;
        return true;
      }
      if (!decision.rotate) {
        statusCards?.ensure(statusContext, this.cardTarget(statusContext.target));
      }
      let output = this.options.prepareOutput ? await this.options.prepareOutput(presentation.context.target.chatId, decision.text) : decision.text;
      const partial = segment?.partial ?? presentation.context.partial;
      if (partial)
        output = markPartialOutput(output, this.options.language);
      const completed = statusCards !== void 0 && await statusCards.complete(statusContext.segmentId, this.withSenderPrefix(run, output), void 0, partial);
      if (decision.rotate)
        run.statusContext = void 0;
      if (completed)
        return true;
      const fallbackText = stripPartialImageMarker(output);
      if (!fallbackText || !(run.sendFallback ?? this.options.sendFallback))
        return false;
      await this.sendFallback(run, presentation.context.target.chatId, fallbackText, presentation.context.sessionId);
      statusCards?.abandon(statusContext.segmentId);
      return true;
    });
  }
  presentInput(context) {
    const run = this.runs.get(context.runId);
    if (!run || run.terminal || run.ownerId !== context.owner.id || run.target.chatId !== context.target.chatId || run.target.isGroup !== context.target.isGroup) {
      return Promise.resolve({ kind: "unsupported" });
    }
    const questionCards = this.options.questionCards;
    if (!questionCards)
      return Promise.resolve({ kind: "unsupported" });
    return questionCards.present(context, this.cardTarget(context.target));
  }
  presentPermission(context) {
    const run = this.runs.get(context.runId);
    if (!run || run.terminal || run.ownerId !== context.owner.id || run.target.chatId !== context.target.chatId || run.target.isGroup !== context.target.isGroup) {
      return Promise.resolve({ kind: "unsupported" });
    }
    const permissionCards = this.options.permissionCards;
    if (!permissionCards)
      return Promise.resolve({ kind: "unsupported" });
    return permissionCards.present(context, this.cardTarget(context.target));
  }
  terminalCopy() {
    if (this.options.language !== void 0 && !isChinesePresentationLanguage(this.options.language)) {
      return {
        failed: "Processing failed, please try again later.",
        stopped: "Task stopped",
        cancelled: "Task cancelled"
      };
    }
    return {
      failed: "\u672C\u6B21\u5904\u7406\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002",
      stopped: "\u4EFB\u52A1\u5DF2\u505C\u6B62",
      cancelled: "\u4EFB\u52A1\u5DF2\u53D6\u6D88"
    };
  }
  terminalizeRun(runId, terminal, detail = "") {
    const run = this.runs.get(runId);
    if (!run || run.terminal)
      return;
    this.options.questionCards?.cancelRun(runId, terminal === "cancelled" && (detail === "cancel_command" || detail === "clear") ? "cancelled" : "expired");
    this.options.permissionCards?.cancelRun(runId);
    run.terminal = true;
    const activeSegmentId = run.activeSegmentId;
    run.activeSegmentId = void 0;
    if (activeSegmentId) {
      this.segments.delete(activeSegmentId);
      this.addTerminalSegment(activeSegmentId);
    }
    const copy = this.terminalCopy();
    const finalization = this.enqueue(run, async () => {
      const finalOutput = run.output.finish(terminal);
      if (terminal === "failed") {
        const statusContext = this.ensureStatusContext(run);
        this.options.statusCards?.ensure(statusContext, this.cardTarget(statusContext.target));
        this.options.statusCards?.fail(statusContext.segmentId, this.withSenderPrefix(run, copy.failed));
        await this.redeliverCardDeliveredContent(run);
      } else if (terminal === "cancelled") {
        const statusContext = run.statusContext;
        if (statusContext) {
          this.options.statusCards?.replace(statusContext, this.cardTarget(statusContext.target), this.withSenderPrefix(run, detail === "cancel_command" ? copy.stopped : copy.cancelled));
        }
        this.options.statusCards?.cancelRun(runId, detail === "cancel_command" ? "cancel_command" : "dropped");
        await this.redeliverCardDeliveredContent(run);
      } else {
        const statusContext = run.statusContext;
        if (statusContext) {
          const context = run.lastOutputContext ?? run.baseContext;
          const output = finalOutput && this.options.prepareOutput ? await this.options.prepareOutput(context.target.chatId, finalOutput) : finalOutput;
          const completed = await this.options.statusCards?.complete(statusContext.segmentId, output ? this.withSenderPrefix(run, output) : "", (retained) => retained ? this.withSenderPrefix(run, this.withoutRenderedSourcePrefix(run, retained)) : retained);
          if (!completed && output) {
            await this.sendFallback(run, context.target.chatId, stripPartialImageMarker(output), context.sessionId);
          }
        }
      }
    });
    void finalization.then(() => {
      if (this.runs.get(runId) === run)
        this.runs.delete(runId);
    }, () => {
      if (this.runs.get(runId) === run)
        this.runs.delete(runId);
    });
  }
  reserveProjection(runId) {
    const run = this.runs.get(runId);
    if (!run || run.terminal)
      return void 0;
    let supplyOperation;
    const operation = new Promise((resolve) => {
      supplyOperation = resolve;
    });
    const result = this.enqueue(run, async () => {
      const execute = await operation;
      await execute();
    });
    let supplied = false;
    return (execute) => {
      if (!supplied) {
        supplied = true;
        supplyOperation(execute);
      }
      return result;
    };
  }
  /**
   * A failed or cancelled terminal overwrites the single continuity card,
   * erasing content a boundary already declared delivered there. Send it as
   * a text message so it survives the overwrite.
   */
  async redeliverCardDeliveredContent(run) {
    const delivered = run.cardDelivered;
    if (!delivered || !(run.sendFallback ?? this.options.sendFallback))
      return;
    run.cardDelivered = void 0;
    await this.sendFallback(run, delivered.chatId, delivered.text, delivered.sessionId);
  }
  enqueue(run, operation) {
    const result = run.projectionChain.then(operation);
    run.projectionChain = result.then(() => void 0, () => void 0);
    return result;
  }
  boundContent(content, limit = CONTENT_LIMIT) {
    if (content.length <= limit)
      return content;
    if (limit === 0)
      return "";
    if (limit <= TRUNCATION_MARKER.length)
      return content.slice(-limit);
    return `${TRUNCATION_MARKER}${content.slice(content.length - (limit - TRUNCATION_MARKER.length))}`;
  }
  withSenderPrefix(run, content) {
    const prefixes = [
      run.senderPrefix,
      run.sourceLabel ? escapeDingTalkMarkdown(run.sourceLabel) : void 0
    ].filter((value) => Boolean(value));
    if (prefixes.length === 0)
      return this.boundContent(content);
    const body = this.withoutExistingSenderPrefix(run, content);
    const prefix = prefixes.join("\n\n");
    if (!body)
      return prefix;
    const separator = "\n\n";
    const bodyLimit = Math.max(0, CONTENT_LIMIT - prefix.length - separator.length);
    return `${prefix}${separator}${this.boundContent(body, bodyLimit)}`;
  }
  withSourcePrefix(run, content) {
    if (!run.sourceLabel)
      return this.boundContent(content);
    const sourceLabel = escapeDingTalkMarkdown(run.sourceLabel);
    if (!content)
      return sourceLabel;
    return `${sourceLabel}

${this.boundContent(content, Math.max(0, CONTENT_LIMIT - sourceLabel.length - 2))}`;
  }
  async sendFallback(run, chatId, text, sessionId) {
    const sendFallback = run.sendFallback ?? this.options.sendFallback;
    if (!sendFallback)
      return;
    if (run.sourceLabel) {
      await sendFallback(chatId, text, sessionId, run.sourceLabel);
      return;
    }
    await sendFallback(chatId, text, sessionId);
  }
  withoutExistingSenderPrefix(run, content) {
    const prefixes = /* @__PURE__ */ new Set([run.senderPrefix, run.senderRawPrefix]);
    let body = content;
    while (body) {
      let removed = false;
      for (const prefix of prefixes) {
        if (!prefix)
          continue;
        if (body === prefix)
          return "";
        if (!body.startsWith(prefix))
          continue;
        const remainder = body.slice(prefix.length);
        if (/^\s/u.test(remainder)) {
          body = remainder.replace(/^\s{1,2}/u, "");
          removed = true;
          break;
        }
      }
      if (!removed)
        break;
    }
    return body;
  }
  withoutRenderedSourcePrefix(run, content) {
    if (!run.sourceLabel)
      return content;
    const rendered = escapeDingTalkMarkdown(run.sourceLabel);
    if (content === rendered)
      return "";
    const prefix = `${rendered}

`;
    return content.startsWith(prefix) ? content.slice(prefix.length) : content;
  }
  ensureStatusContext(run, segment) {
    if (run.statusContext)
      return run.statusContext;
    run.statusContext = segment ? { ...segment } : { ...run.baseContext, segmentId: `${run.runId}:${randomUUID5()}` };
    return run.statusContext;
  }
  cardTarget(target) {
    const isGroup = target.isGroup === true;
    return {
      chatId: isGroup ? target.chatId : target.senderId,
      isGroup
    };
  }
  addTerminalSegment(segmentId) {
    this.terminalSegmentIds.add(segmentId);
    while (this.terminalSegmentIds.size > 1e3) {
      const oldest = this.terminalSegmentIds.values().next().value;
      if (oldest === void 0)
        break;
      this.terminalSegmentIds.delete(oldest);
    }
  }
};

// packages/channels/dingtalk/dist/DingtalkAdapter.js
function nonEmptyString(value) {
  if (typeof value !== "string")
    return void 0;
  const trimmed = value.trim();
  return trimmed || void 0;
}
__name(nonEmptyString, "nonEmptyString");
function richTextPartType(part) {
  return part.type || part.msgType || "text";
}
__name(richTextPartType, "richTextPartType");
function parseJsonArray(value) {
  if (Array.isArray(value))
    return value;
  if (typeof value !== "string")
    return void 0;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
}
__name(parseJsonArray, "parseJsonArray");
function sanitizeChatRecordField(value) {
  return sanitizePromptText(value).trim();
}
__name(sanitizeChatRecordField, "sanitizeChatRecordField");
function bracketSafeChatRecordField(value) {
  return sanitizeChatRecordField(value).replace(/[[\]]/g, " ").trim();
}
__name(bracketSafeChatRecordField, "bracketSafeChatRecordField");
function startOfLineSafeChatRecordField(value) {
  const sanitized = sanitizeChatRecordField(value);
  if (!sanitized.startsWith("["))
    return sanitized;
  const deleted = new Uint8Array(sanitized.length);
  let open = 0;
  let close = 0;
  for (; ; ) {
    while (open < sanitized.length && (deleted[open] === 1 || /\s/.test(sanitized[open]))) {
      open += 1;
    }
    if (sanitized[open] !== "[")
      break;
    let next = Math.max(close, open + 1);
    while (next < sanitized.length && (deleted[next] === 1 || sanitized[next] !== "]")) {
      next += 1;
    }
    if (next >= sanitized.length) {
      deleted[open] = 1;
      open += 1;
      close = next;
      continue;
    }
    deleted[open] = 1;
    deleted[next] = 1;
    open += 1;
    close = next + 1;
  }
  const parts = [];
  let cut = 0;
  for (let i = 0; i < sanitized.length; i++) {
    if (deleted[i] === 0)
      continue;
    if (i > cut)
      parts.push(sanitized.slice(cut, i));
    cut = i + 1;
  }
  parts.push(sanitized.slice(cut));
  return parts.join("").trim();
}
__name(startOfLineSafeChatRecordField, "startOfLineSafeChatRecordField");
var MAX_CHAT_RECORD_ENTRIES = 50;
var MAX_CHAT_RECORD_CHARS = 4e3;
var MAX_CHAT_RECORD_LINE_CHARS = 500;
var MAX_QUOTED_CHAT_RECORD_CHARS = 500;
var CHAT_RECORD_ENTRIES_LABEL = "[Chat record messages]";
var CHAT_RECORD_HEADER_LEAD = /* @__PURE__ */ __name((title) => `[Chat record: ${title}] `, "CHAT_RECORD_HEADER_LEAD");
var CHAT_RECORD_PART_GAP = 2;
function announcedDrop(count) {
  return `[${count} more message(s) not shown]`;
}
__name(announcedDrop, "announcedDrop");
function chatRecordAnnouncementCost(lines) {
  return lines.length > 0 ? announcedDrop(lines.length).length + 1 : 0;
}
__name(chatRecordAnnouncementCost, "chatRecordAnnouncementCost");
function capChatRecordLines(lines, budget) {
  const kept = [];
  let dropped = 0;
  let total = 0;
  const spendable = budget - chatRecordAnnouncementCost(lines);
  if (spendable < 0)
    return [];
  for (const [index, line] of lines.entries()) {
    if (kept.length >= MAX_CHAT_RECORD_ENTRIES) {
      dropped = lines.length - index;
      break;
    }
    const boundedRaw = truncateUtf16Units(line, MAX_CHAT_RECORD_LINE_CHARS);
    const bounded = boundedRaw === line ? line : `${boundedRaw} [truncated]`;
    if (total + bounded.length > spendable) {
      dropped = lines.length - index;
      break;
    }
    kept.push(bounded);
    total += bounded.length + 1;
  }
  if (dropped > 0)
    kept.push(announcedDrop(dropped));
  return kept;
}
__name(capChatRecordLines, "capChatRecordLines");
function mediaTypePlaceholder(msgType, fileName) {
  switch (msgType) {
    case "picture":
      return "[image]";
    case "file": {
      const name = bracketSafeChatRecordField(nonEmptyString(fileName) || "");
      return `[file: ${name || "file"}]`;
    }
    case "audio":
      return "[audio]";
    case "video":
      return "[video]";
    default:
      return void 0;
  }
}
__name(mediaTypePlaceholder, "mediaTypePlaceholder");
function formatChatRecordEntryBody(record) {
  const rawContent = record["content"];
  const content = rawContent && typeof rawContent === "object" ? rawContent : void 0;
  const body = nonEmptyString(record["text"]) || nonEmptyString(rawContent) || nonEmptyString(content?.["text"]) || nonEmptyString(record["message"]) || nonEmptyString(record["body"]);
  if (body)
    return sanitizeChatRecordField(body) || "[message]";
  const msgType = nonEmptyString(record["msgType"]) || nonEmptyString(record["msgtype"]);
  const safeMsgType = msgType ? bracketSafeChatRecordField(msgType) : "";
  return mediaTypePlaceholder(msgType, content?.["fileName"]) ?? // Record-specific fallback: name the type when DingTalk sends one we do
  // not model, so the model sees *something* arrived rather than a gap.
  // The name is record content like every other field here, so it is
  // neutralized before it goes inside the brackets.
  (safeMsgType ? `[${safeMsgType}]` : "[message]");
}
__name(formatChatRecordEntryBody, "formatChatRecordEntryBody");
function describeChatRecordKeys(content) {
  if (!content || typeof content !== "object")
    return "none";
  const keys = Object.keys(content);
  return keys.length > 0 ? keys.join(",") : "none";
}
__name(describeChatRecordKeys, "describeChatRecordKeys");
function formatChatRecord(content, budget = MAX_CHAT_RECORD_CHARS) {
  const title = nonEmptyString(content?.title);
  const rawSummary = nonEmptyString(content?.summary);
  const parsedSummary = parseJsonArray(rawSummary);
  const summaryLines = parsedSummary ? parsedSummary.map((item) => startOfLineSafeChatRecordField(nonEmptyString(item) || "") || "") : rawSummary?.split("\n").map((line) => startOfLineSafeChatRecordField(nonEmptyString(line) || "")) || [];
  const rawEntries = content?.chatRecord ?? content?.records ?? content?.messages;
  const entries = parseJsonArray(rawEntries);
  const recordLines = Array.isArray(entries) ? entries.flatMap((entry, index) => {
    if (typeof entry === "string") {
      const body = nonEmptyString(entry);
      if (!body)
        return [];
      return [`Unknown: ${formatChatRecordEntryBody({ text: body })}`];
    }
    if (!entry || typeof entry !== "object")
      return [];
    const record = entry;
    const summarySender = summaryLines.length === entries.length ? nonEmptyString(summaryLines[index]?.match(/^([^:：]+)[:：]/)?.[1]) : void 0;
    const rawSender = nonEmptyString(record["senderName"]) || nonEmptyString(record["senderNick"]) || nonEmptyString(record["sender"]) || summarySender || nonEmptyString(record["senderId"]);
    const sender = rawSender && bracketSafeChatRecordField(rawSender) || "Unknown";
    return [`${sender}: ${formatChatRecordEntryBody(record)}`];
  }) : [];
  const entriesFloor = recordLines.length > 0 ? CHAT_RECORD_ENTRIES_LABEL.length + 1 + chatRecordAnnouncementCost(recordLines) : 0;
  const headerBudget = Math.max(budget - CHAT_RECORD_PART_GAP - entriesFloor, 0);
  const summaryDisplayLines = summaryLines.filter(Boolean);
  const safeTitle = title ? truncateUtf16Units(bracketSafeChatRecordField(title), Math.max(Math.min(MAX_CHAT_RECORD_LINE_CHARS, headerBudget - CHAT_RECORD_HEADER_LEAD("").length - chatRecordAnnouncementCost(summaryDisplayLines)), 0)) || void 0 : void 0;
  const headerLead = CHAT_RECORD_HEADER_LEAD(safeTitle || "untitled");
  const summary = capChatRecordLines(summaryDisplayLines, Math.max(headerBudget - headerLead.length, 0)).join("\n");
  const parts = [];
  if (summary) {
    parts.push(`${headerLead}${summary}`);
  } else if (safeTitle) {
    parts.push(`[Chat record: ${safeTitle}]`);
  }
  const spent = parts.reduce((used, part) => used + part.length + CHAT_RECORD_PART_GAP, 0);
  const boundedLines = capChatRecordLines(recordLines, Math.max(budget - spent - CHAT_RECORD_ENTRIES_LABEL.length - 1, 0));
  if (boundedLines.length > 0) {
    parts.push(`${CHAT_RECORD_ENTRIES_LABEL}
${boundedLines.join("\n")}`);
  }
  return {
    text: parts.join("\n\n"),
    entriesDropped: rawEntries !== void 0 && recordLines.length === 0
  };
}
__name(formatChatRecord, "formatChatRecord");
var DEDUP_TTL_MS = 5 * 60 * 1e3;
var SLASH_COMMAND_TOKEN_RE = /^[a-zA-Z0-9_:-]+$/;
var ACK_REACTION_NAME = "\u{1F440}";
var ACK_EMOTION_ID = "2659900";
var ACK_EMOTION_BG_ID = "im_bg_1";
var STATUS_EMOTION_ID = "34019";
var STATUS_EMOTION_BG_ID = "im_bg_6";
var DONE_EMOTION_ID = "54054";
var DONE_EMOTION_BG_ID = "im_bg_5";
var EMOTION_API = "https://api.dingtalk.com/v1.0/robot/emotion";
var EMOTION_MAX_ATTEMPTS = 3;
var EMOTION_RETRY_BASE_DELAY_MS = 250;
var EMOTION_FETCH_TIMEOUT_MS = 15e3;
var EMOTION_FINISH_MAX_ATTEMPTS = 3;
var GROUP_MSG_API = "https://api.dingtalk.com/v1.0/robot/groupMessages/send";
var DIRECT_MSG_API = "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";
var PROACTIVE_MSG_KEY = "sampleMarkdown";
var PROACTIVE_FILE_MSG_KEY = "sampleFile";
var TOKEN_API = "https://oapi.dingtalk.com/gettoken";
var PROACTIVE_FETCH_TIMEOUT_MS = 15e3;
var ROBOT_MESSAGE_HOSTS = /* @__PURE__ */ new Set(["api.dingtalk.com", "oapi.dingtalk.com"]);
var PERMANENT_TOKEN_ERROR_CODES = /* @__PURE__ */ new Set([
  40001,
  40013,
  40089,
  40096,
  90002,
  90003
]);
var REPLY_FETCH_TIMEOUT_MS = 15e3;
function presentInboundError(error) {
  const parts = [];
  let status;
  try {
    if (error instanceof Error) {
      if (typeof error.name === "string")
        parts.push(error.name);
      if (typeof error.message === "string")
        parts.push(error.message);
    } else if (typeof error === "string") {
      parts.push(error);
    }
    if (typeof error === "object" && error !== null) {
      const record = error;
      if (typeof record["code"] === "string")
        parts.push(record["code"]);
      if (typeof record["status"] === "number")
        status = record["status"];
      const body = record["body"];
      if (typeof body === "string") {
        parts.push(body);
      } else if (typeof body === "object" && body !== null) {
        const bodyRecord = body;
        for (const key of ["code", "errorKind", "message"]) {
          if (typeof bodyRecord[key] === "string")
            parts.push(bodyRecord[key]);
        }
      }
    }
  } catch {
    return {
      status: "Processing failed",
      nextStep: "Try again. If it keeps failing, contact the bot administrator."
    };
  }
  const diagnostic = parts.join(" ").slice(0, 2e3).toLowerCase();
  if (status === 401 || status === 403 || /unauthor|forbidden|authentication|credential|invalid.?token/.test(diagnostic)) {
    return {
      status: "Bot configuration error",
      nextStep: "Contact the bot administrator."
    };
  }
  if (status === 408 || status === 504 || /timeout|timed?\s+out|deadline/.test(diagnostic)) {
    return {
      status: "Request timed out",
      nextStep: "Try again. For a large request, split it into smaller parts."
    };
  }
  if (/cancel|abort/.test(diagnostic)) {
    return {
      status: "Request was cancelled",
      nextStep: "Send the request again if you still need it."
    };
  }
  if (status === 429 || /overload|rate.?limit|queue.?full|too many|busy|pending prompts full/.test(diagnostic)) {
    return {
      status: "Service is busy",
      nextStep: "Try again in a moment."
    };
  }
  if (status === 502 || status === 503 || /unavailable|econn|enotfound|etimedout|network|socket|fetch failed|connection|session[_ ](?:not[ _]found|closing)|workspace[_ ]draining|transport closed/.test(diagnostic)) {
    return {
      status: "Service is temporarily unavailable",
      nextStep: "Try again in a moment. If it keeps failing, contact the bot administrator."
    };
  }
  return {
    status: "Processing failed",
    nextStep: "Try again. If it keeps failing, contact the bot administrator."
  };
}
__name(presentInboundError, "presentInboundError");
function formatInboundErrorMessage(error, reference) {
  const presentation = presentInboundError(error);
  return [
    "**Unable to process this message**",
    "",
    `**Status:** ${presentation.status}`,
    `**Next step:** ${presentation.nextStep}`,
    `**Reference:** \`${reference}\``
  ].join("\n");
}
__name(formatInboundErrorMessage, "formatInboundErrorMessage");
var GENERATED_MEDIA_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "video/mp4": "mp4"
};
var mentionTarget = Symbol("mentionTarget");
var IMAGE_INSTRUCTIONS = [
  "",
  "If you created an image file (screenshot, chart, etc.), you can send it to the user by writing:",
  "`[IMAGE: /absolute/path/to/file.png]` (without the backticks)",
  "",
  "The marker is stripped from text and the image is uploaded automatically.",
  "",
  "Only use a real image file inside the workspace or system temporary directory."
].join("\n");
var FILE_INSTRUCTIONS = [
  "",
  "When the user explicitly asks for a completed local file, send it by writing this on its own line:",
  "`[FILE: /absolute/path/to/file]` (without the backticks)",
  "",
  "Use at most five non-empty files inside the workspace or system temporary directory.",
  "File paths containing ] are not supported.",
  "Do not claim delivery succeeded; DingTalk shows successful files separately and reports failures in the final text."
].join("\n");
function statusEmotionTag(name) {
  return {
    name,
    emotionId: STATUS_EMOTION_ID,
    backgroundId: STATUS_EMOTION_BG_ID
  };
}
__name(statusEmotionTag, "statusEmotionTag");
var EYE_TAG = {
  name: ACK_REACTION_NAME,
  emotionId: ACK_EMOTION_ID,
  backgroundId: ACK_EMOTION_BG_ID
};
var DONE_TAG = {
  name: "\u2705 Done",
  emotionId: DONE_EMOTION_ID,
  backgroundId: DONE_EMOTION_BG_ID
};
var FAILED_TAG = statusEmotionTag("\u274C Failed");
var STOPPED_TAG = statusEmotionTag("\u23F9\uFE0F Stopped");
function collectNonBotMentionIds(data) {
  if (!Array.isArray(data.atUsers) || typeof data.chatbotUserId !== "string") {
    return [];
  }
  const mentions = /* @__PURE__ */ new Set();
  for (const user of data.atUsers) {
    if (!user)
      continue;
    const dingtalkId = typeof user.dingtalkId === "string" ? user.dingtalkId : void 0;
    if (dingtalkId === data.chatbotUserId)
      continue;
    const staffId = typeof user.staffId === "string" ? user.staffId : void 0;
    const stableId = staffId || dingtalkId;
    if (stableId)
      mentions.add(stableId);
  }
  return [...mentions];
}
__name(collectNonBotMentionIds, "collectNonBotMentionIds");
var connectLogDepth = 0;
var unsuppressedConsoleLog;
async function withConnectLoggingSuppressed(connect) {
  if (connectLogDepth++ === 0) {
    unsuppressedConsoleLog = console.log;
    console.log = () => {
    };
  }
  try {
    return await connect();
  } finally {
    if (--connectLogDepth === 0 && unsuppressedConsoleLog) {
      console.log = unsuppressedConsoleLog;
      unsuppressedConsoleLog = void 0;
    }
  }
}
__name(withConnectLoggingSuppressed, "withConnectLoggingSuppressed");
var ProactiveTextDeliveryError = class extends Error {
  static {
    __name(this, "ProactiveTextDeliveryError");
  }
  plan;
  retryable;
  constructor(plan, cause) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.plan = plan;
    if (cause instanceof DingtalkCardRequestError) {
      this.retryable = cause.retryable;
    }
  }
};
var ReplyTextDeliveryError = class extends Error {
  static {
    __name(this, "ReplyTextDeliveryError");
  }
  plan;
  retryable;
  constructor(plan, cause) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.plan = plan;
    if (cause instanceof DingtalkCardRequestError) {
      this.retryable = cause.retryable;
    }
  }
};
var DingtalkChannel = class _DingtalkChannel extends ChannelBase {
  static {
    __name(this, "DingtalkChannel");
  }
  client;
  atSender;
  displayLanguage;
  connectionManager;
  seenMessages = /* @__PURE__ */ new Map();
  mentionTargets = /* @__PURE__ */ new Map();
  sessionMentionTargets = /* @__PURE__ */ new Map();
  bufferedMentionTargets = /* @__PURE__ */ new Set();
  bufferedMentionTargetsBySession = /* @__PURE__ */ new Map();
  dedupTimer;
  /** Map conversationId → latest sessionWebhook URL for sending replies. */
  webhooks = /* @__PURE__ */ new Map();
  activeReactionKeys = /* @__PURE__ */ new Set();
  reactionStates = /* @__PURE__ */ new Map();
  /** sessionId → reaction keys, so a dead session's reactions can be recalled. */
  sessionReactionKeys = /* @__PURE__ */ new Map();
  /** Settles after background output and reaction cleanup finish on disconnect. */
  disconnectDrain;
  /**
   * Real inbound message ids (insertion-ordered, size-capped). Unlike the
   * TTL-swept seenMessages dedup map, entries survive long queue waits, so a
   * turn that starts minutes after its message arrived still gets a reaction.
   */
  inboundMessageIds = /* @__PURE__ */ new Set();
  /**
   * Token cache for proactive sends. The stream SDK only refreshes its token
   * on (re)connect, so a long-lived socket serves a stale one after ~2h.
   */
  proactiveToken;
  interactiveCardConfig;
  outputMode;
  interactiveCardClient;
  statusCardController;
  questionCardController;
  permissionCardController;
  interactionPresenter;
  inboundCardOwners = /* @__PURE__ */ new Map();
  cardRunBySession = /* @__PURE__ */ new Map();
  cardRuns = /* @__PURE__ */ new Map();
  // Keyed by runId, not segmentId: a mid-turn segment reset (response
  // boundary, input requested) mints a fresh segment UUID but the projection
  // state must survive it, or a marker split across the reset leaks.
  fileProjectors = /* @__PURE__ */ new Map();
  backgroundOutputCoordinator;
  constructor(name, config, bridge, options) {
    super(name, config, bridge, options);
    this.atSender = config["atSender"] === true;
    this.displayLanguage = options?.displayLanguage;
    if (!this.config.instructions) {
      this.config.instructions = [
        "## DingTalk Channel",
        "",
        "You are responding through DingTalk.",
        IMAGE_INSTRUCTIONS
      ].join("\n");
    } else if (!this.config.instructions.includes("[IMAGE:")) {
      this.config.instructions += IMAGE_INSTRUCTIONS;
    }
    if (!this.config.instructions.includes("[FILE:")) {
      this.config.instructions += FILE_INSTRUCTIONS;
    }
    this.interactiveCardConfig = parseDingtalkInteractiveCardConfig(config.interactiveCards);
    this.outputMode = parseChannelOutputMode(name, config.outputMode, true);
    this.backgroundOutputCoordinator = new BackgroundOutputCoordinator({
      outputMode: this.outputMode,
      getTarget: /* @__PURE__ */ __name((sessionId) => this.router.getTarget(sessionId), "getTarget"),
      getSourceLabel: /* @__PURE__ */ __name((sessionId) => this.getBackgroundResponseSourceLabel(sessionId), "getSourceLabel"),
      resolveDelivery: /* @__PURE__ */ __name((sessionId) => this.resolveBackgroundResponseDelivery(sessionId), "resolveDelivery"),
      createDelivery: /* @__PURE__ */ __name((sessionId, target) => this.createBackgroundOutputDelivery(sessionId, target), "createDelivery"),
      isRetryableError: /* @__PURE__ */ __name((error) => !((error instanceof ProactiveTextDeliveryError || error instanceof ReplyTextDeliveryError || error instanceof DingtalkCardRequestError) && error.retryable === false), "isRetryableError"),
      log: /* @__PURE__ */ __name((message) => process.stderr.write(`[DingTalk:${this.name}] ${message}`), "log")
    });
    if (!config.clientId || !config.clientSecret) {
      throw new Error(`Channel "${name}" requires clientId and clientSecret for DingTalk.`);
    }
    const rawUseConnectionManager = config.useConnectionManager;
    if (rawUseConnectionManager !== void 0 && typeof rawUseConnectionManager !== "boolean") {
      throw new Error(`Channel "${name}" useConnectionManager must be a boolean.`);
    }
    const useConnectionManager = rawUseConnectionManager ?? true;
    this.client = this.createClient(useConnectionManager);
    if (this.interactiveCardConfig.enabled) {
      this.interactiveCardClient = new DingtalkInteractiveCardClient({
        robotCode: config.clientId,
        getAccessToken: /* @__PURE__ */ __name(() => this.getProactiveToken(), "getAccessToken"),
        invalidateAccessToken: /* @__PURE__ */ __name((token) => {
          if (this.proactiveToken?.token === token) {
            this.proactiveToken = void 0;
          }
        }, "invalidateAccessToken")
      });
      if (this.interactiveCardConfig.statusCard.enabled) {
        this.statusCardController = new StatusCardController({
          client: this.interactiveCardClient,
          cancelRun: /* @__PURE__ */ __name((sessionId, runId) => this.requestPromptRunCancellation(sessionId, runId), "cancelRun"),
          ...config.model ? { model: config.model } : {},
          ...options?.displayLanguage ? { language: options.displayLanguage } : {},
          onError: /* @__PURE__ */ __name((operation, error) => {
            process.stderr.write(`[DingTalk:${this.name}] ${operation} failed: ${sanitizeLogText(String(error), 300)}
`);
          }, "onError")
        });
      }
      if (this.interactiveCardConfig.questionCard.enabled) {
        this.questionCardController = new QuestionCardController({
          client: this.interactiveCardClient,
          timeoutMs: this.interactiveCardConfig.questionCard.timeoutMs,
          sendFallback: /* @__PURE__ */ __name((chatId, text, sourceLabel) => this.sendReply(chatId, text, void 0, sourceLabel), "sendFallback"),
          reserveRunProjection: /* @__PURE__ */ __name((runId) => this.interactionPresenter?.reserveProjection(runId), "reserveRunProjection"),
          onError: /* @__PURE__ */ __name((operation, error) => {
            process.stderr.write(`[DingTalk:${this.name}] ${operation} failed: ${sanitizeLogText(String(error), 300)}
`);
          }, "onError")
        });
      }
      if (this.interactiveCardConfig.permissionCard.enabled) {
        this.permissionCardController = new PermissionCardController({
          client: this.interactiveCardClient,
          timeoutMs: this.interactiveCardConfig.permissionCard.timeoutMs,
          locale: this.locale,
          reserveRunProjection: /* @__PURE__ */ __name((runId) => this.interactionPresenter?.reserveProjection(runId), "reserveRunProjection"),
          onError: /* @__PURE__ */ __name((operation, error) => {
            process.stderr.write(`[DingTalk:${this.name}] ${operation} failed: ${sanitizeLogText(String(error), 300)}
`);
          }, "onError")
        });
      }
    }
    this.interactionPresenter = new DingtalkInteractionPresenter({
      outputMode: this.outputMode,
      prepareOutput: /* @__PURE__ */ __name((chatId, text) => this.prepareReplyOutput(chatId, text), "prepareOutput"),
      statusCards: this.statusCardController,
      questionCards: this.questionCardController,
      permissionCards: this.permissionCardController,
      ...options?.displayLanguage ? { language: options.displayLanguage } : {},
      sendFallback: /* @__PURE__ */ __name((chatId, text, sessionId, sourceLabel) => this.sendFallbackReply(chatId, text, sessionId, sourceLabel), "sendFallback")
    });
    if (useConnectionManager) {
      this.connectionManager = new DingtalkConnectionManager({
        initialClient: this.client,
        createClient: /* @__PURE__ */ __name(() => this.createClient(true), "createClient"),
        getSocket: /* @__PURE__ */ __name((client) => client.socket, "getSocket"),
        onClientChanged: /* @__PURE__ */ __name((client) => {
          this.client = client;
        }, "onClientChanged"),
        log: /* @__PURE__ */ __name((message) => {
          process.stderr.write(`[DingTalk:${this.name}] ${sanitizeLogText(message, 200)}
`);
        }, "log")
      });
    }
  }
  createClient(useConnectionManager) {
    const client = new DWClient({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      keepAlive: !useConnectionManager
    });
    client.config.autoReconnect = !useConnectionManager;
    this.installStructuredDownstreamHandler(client);
    this.registerMessageHandler(client);
    return client;
  }
  installStructuredDownstreamHandler(streamClient) {
    const client = streamClient;
    client.debug = false;
    client.onDownStream = (raw) => {
      this.onDownStream(raw, client);
    };
    const sdkConnect = client.connect.bind(client);
    client.connect = () => withConnectLoggingSuppressed(sdkConnect);
  }
  registerMessageHandler(client) {
    client.registerCallbackListener(TOPIC_ROBOT, (msg) => {
      client.send(msg.headers.messageId, {
        status: EventAck.SUCCESS,
        message: "ok"
      });
      this.onMessage(msg);
    });
    if (this.interactiveCardConfig.enabled) {
      client.registerCallbackListener(TOPIC_CARD, (msg) => {
        this.onCardCallback(client, msg);
      });
    }
  }
  onCardCallback(client, msg) {
    const callback = parseDingtalkCardCallback(msg.data);
    const actorId = callback?.actorId ?? parseDingtalkCardActorId(msg.data);
    let result;
    try {
      result = callback ? this.routeCardCallback(callback) : { kind: "ignored", ...actorId ? { actorId } : {} };
    } catch (err) {
      process.stderr.write(`[DingTalk:${this.name}] card callback routing failed: ${sanitizeLogText(String(err), 200)}
`);
      result = { kind: "ignored", ...actorId ? { actorId } : {} };
    }
    client.send(msg.headers.messageId, {
      status: EventAck.SUCCESS,
      message: "ok"
    });
    if (result.kind === "accepted") {
      void result.execute().catch((err) => {
        process.stderr.write(`[DingTalk:${this.name}] card callback action failed: ${sanitizeLogText(String(err), 200)}
`);
      });
    } else if (result.kind === "forbidden") {
      void this.sendCardInteractionFeedback(result.actorId, result.target).catch((err) => {
        process.stderr.write(`[DingTalk:${this.name}] card interaction feedback failed: ${sanitizeLogText(String(err), 200)}
`);
      });
    }
  }
  routeCardCallback(callback) {
    if (callback.actionId === "btn_stop") {
      return this.statusCardController?.claimStop(callback.outTrackId, callback.actorId) ?? { kind: "ignored", actorId: callback.actorId };
    }
    const permissionResult = this.permissionCardController?.claim(callback);
    if (permissionResult && permissionResult.kind !== "ignored") {
      return permissionResult;
    }
    return this.questionCardController?.claim(callback) ?? permissionResult ?? {
      kind: "ignored",
      actorId: callback.actorId
    };
  }
  onDownStream(raw, client) {
    this.connectionManager?.noteActivity(client);
    const decoded = this.decodeDownStream(raw);
    let msg;
    try {
      const parsed = JSON.parse(decoded.text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        process.stderr.write(`[DingTalk:${this.name}] downstream parsed to non-object, ignoring.
`);
        return;
      }
      msg = parsed;
    } catch (err) {
      process.stderr.write(`[DingTalk:${this.name}] Failed to parse downstream: ${sanitizeLogText(String(err), 200)}
`);
      return;
    }
    const headers = msg.headers && typeof msg.headers === "object" ? msg.headers : {};
    const type = typeof msg.type === "string" ? msg.type : "";
    const topic = typeof headers["topic"] === "string" ? headers["topic"] : "";
    const messageId = typeof headers["messageId"] === "string" ? headers["messageId"] : "";
    process.stderr.write(`[DingTalk:${this.name}] downstream type=${sanitizeLogText(type, 40)} topic=${sanitizeLogText(topic, 80)} messageId=${sanitizeLogText(messageId, 80)} bytes=${decoded.bytes}
`);
    if ((type === "CALLBACK" || type === "EVENT") && (!topic || !messageId)) {
      process.stderr.write(`[DingTalk:${this.name}] Ignoring downstream with invalid routing headers.
`);
      return;
    }
    const normalizedMsg = {
      ...msg,
      headers: { ...headers, topic, messageId }
    };
    switch (type) {
      case "SYSTEM":
        this.callDownStreamHandler(client, "onSystem", normalizedMsg);
        if (topic === "disconnect") {
          this.connectionManager?.requestReconnect(client, "SYSTEM disconnect");
        }
        break;
      case "EVENT":
        this.callDownStreamHandler(client, "onEvent", normalizedMsg);
        break;
      case "CALLBACK":
        this.callDownStreamHandler(client, "onCallback", normalizedMsg);
        break;
      default:
        process.stderr.write(`[DingTalk:${this.name}] Ignoring downstream type ${sanitizeLogText(type || "unknown", 40)}.
`);
    }
  }
  callDownStreamHandler(client, method, msg) {
    try {
      client[method](msg);
    } catch (err) {
      process.stderr.write(`[DingTalk:${this.name}] ${method} failed: ${sanitizeLogText(String(err), 200)}
`);
    }
  }
  decodeDownStream(raw) {
    if (typeof raw === "string") {
      return { text: raw, bytes: Buffer2.byteLength(raw) };
    }
    if (Buffer2.isBuffer(raw)) {
      return { text: raw.toString("utf8"), bytes: raw.length };
    }
    if (raw instanceof Uint8Array) {
      return { text: Buffer2.from(raw).toString("utf8"), bytes: raw.byteLength };
    }
    if (raw instanceof ArrayBuffer) {
      return {
        text: Buffer2.from(raw).toString("utf8"),
        bytes: raw.byteLength
      };
    }
    return { text: String(raw), bytes: Buffer2.byteLength(String(raw)) };
  }
  async connect() {
    if (this.connectionManager) {
      await this.connectionManager.start();
    } else {
      await this.client.connect();
    }
    this.dedupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, ts] of this.seenMessages) {
        if (now - ts > DEDUP_TTL_MS) {
          this.seenMessages.delete(id);
        }
      }
    }, 6e4);
    process.stderr.write(`[DingTalk:${this.name}] Connected via stream.
`);
  }
  /**
   * A group message with no conversationId can't be routed to a stable shared
   * session (chatId would fall back to the expiring sessionWebhook), so it is
   * dropped on ingestion. Exposed for testing the drop rule.
   */
  static isUnroutableGroupMessage(isGroup, conversationId) {
    return isGroup && !conversationId;
  }
  resolveSessionWebhook(chatId) {
    const value = this.webhooks.get(chatId);
    if (!value)
      return void 0;
    try {
      const url2 = new URL(value);
      return url2.protocol === "https:" && url2.port === "" && ROBOT_MESSAGE_HOSTS.has(url2.hostname) ? url2.toString() : void 0;
    } catch {
      return void 0;
    }
  }
  async uploadOutboundFile(filePath) {
    const file = readValidatedFile(filePath, this.config.cwd);
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.getProactiveToken();
      try {
        return { file, mediaId: await uploadDingTalkFile(file, token) };
      } catch (error) {
        if (error instanceof DingTalkMediaUploadError && error.authFailure && attempt === 0) {
          this.proactiveToken = void 0;
          continue;
        }
        throw error;
      }
    }
    throw new Error("DingTalk file upload returned no MediaID");
  }
  async deliverFiles(paths, send, preflight) {
    const notices = [];
    for (const filePath of paths) {
      const displayName = safeFileName(filePath);
      try {
        preflight?.();
        const { file, mediaId } = await this.uploadOutboundFile(filePath);
        await send(file, mediaId);
      } catch (error) {
        process.stderr.write(`[DingTalk:${this.name}] outbound file delivery failed (${sanitizeLogText(displayName, 200)}): ${sanitizeLogText(error instanceof Error ? error.message : String(error), 300)}
`);
        notices.push(`[File delivery failed: ${displayName}]`);
      }
    }
    return notices;
  }
  async sendSessionFile(chatId, file, mediaId) {
    const webhook = this.resolveSessionWebhook(chatId);
    if (!webhook)
      throw new Error("DingTalk session webhook unavailable");
    let response;
    try {
      response = await fetch(webhook, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          msgtype: "file",
          file: {
            mediaId,
            fileName: file.fileName,
            fileType: file.fileType
          }
        }),
        signal: AbortSignal.timeout(REPLY_FETCH_TIMEOUT_MS)
      });
    } catch {
      throw new Error("DingTalk file delivery failed: network request failed");
    }
    const body = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(`DingTalk file delivery failed: HTTP ${response.status}`);
    }
    if (!body.trim())
      return;
    let data;
    try {
      const parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return;
      data = parsed;
    } catch {
      return;
    }
    const code = data["errcode"] ?? data["code"];
    if (code !== void 0 && String(code) !== "0") {
      throw new Error(`DingTalk file delivery failed: API code ${code}`);
    }
  }
  appendFileNotices(text, notices) {
    if (notices.length === 0)
      return text;
    const prefix = text.trimEnd();
    return `${prefix}${prefix ? "\n" : ""}${notices.join("\n")}`;
  }
  async prepareReplyOutput(chatId, text, streamed) {
    return this.prepareFileOutput(text, (file, mediaId) => this.sendSessionFile(chatId, file, mediaId), streamed, () => {
      if (!this.resolveSessionWebhook(chatId)) {
        throw new Error("DingTalk session webhook unavailable");
      }
    });
  }
  async prepareFileOutput(text, send, streamed, preflight) {
    const projection = projectFileText(text);
    const streamedMarkers = streamed ? streamed.result("").markerCount : 0;
    if (projection.markerCount > 0 || streamedMarkers > 0) {
      process.stderr.write(`[DingTalk:${this.name}] file markers projected (final=${projection.markerCount}, streamed=${streamedMarkers})
`);
    }
    const notices = [];
    if (projection.invalidMarkers > 0) {
      notices.push("[File delivery failed: invalid marker]");
    }
    if (projection.excessMarkers > 0) {
      notices.push("[File delivery failed: response file limit exceeded]");
    }
    if (streamedMarkers > projection.markerCount) {
      notices.push(FILE_UNAVAILABLE_NOTICE);
    }
    notices.push(...await this.deliverFiles(projection.paths, send, preflight));
    return this.prepareOutgoingText(this.appendFileNotices(projection.text, notices));
  }
  async prepareOutgoingText(text) {
    const markers = findImageMarkers(text);
    if (markers.length === 0)
      return text;
    const replacements = [];
    for (const marker of markers) {
      const fileName = basename3(marker.path).replace(/[\r\n[\]]+/g, "_").slice(0, 100) || "image";
      try {
        const image = readValidatedImage(marker.path, {
          workspaceDir: this.config.cwd
        });
        let mediaId;
        for (let attempt = 0; attempt < 2; attempt++) {
          const token = await this.getProactiveToken();
          try {
            mediaId = await uploadDingTalkImage(image, token);
            break;
          } catch (error) {
            if (error instanceof DingTalkMediaUploadError && error.authFailure && attempt === 0) {
              this.proactiveToken = void 0;
              continue;
            }
            throw error;
          }
        }
        if (!mediaId) {
          throw new Error("DingTalk media upload returned no MediaID");
        }
        replacements.push(`![image](${mediaId})`);
      } catch (error) {
        process.stderr.write(`[DingTalk:${this.name}] outbound image upload failed (${sanitizeLogText(fileName, 100)}): ${sanitizeLogText(error instanceof Error ? error.message : String(error), 300)}
`);
        replacements.push(`[Image delivery failed: ${fileName}]`);
      }
    }
    return replaceImageMarkers(text, markers, replacements);
  }
  async sendReply(chatId, text, atUserId, sourceLabel, prepared = false, failOnHttpError = false) {
    const webhook = this.webhooks.get(chatId);
    if (!webhook) {
      process.stderr.write(`[DingTalk:${this.name}] No webhook for chatId ${chatId}, cannot send.
`);
      if (failOnHttpError) {
        throw new Error("DingTalk session webhook unavailable");
      }
      return;
    }
    const outgoingText = prepared ? text : await this.prepareReplyOutput(chatId, text);
    if (!outgoingText.trim())
      return;
    const plan = this.createReplyTextDelivery(outgoingText, atUserId, sourceLabel);
    try {
      await this.deliverReplyText(chatId, plan, failOnHttpError);
    } catch (error) {
      throw new ReplyTextDeliveryError(plan, error);
    }
  }
  createReplyTextDelivery(outgoingText, atUserId, sourceLabel) {
    const mentionPrefix = atUserId ? `@${atUserId}

` : "";
    const sourcePrefix = sourceLabel && outgoingText.trim().length > 0 ? `${escapeDingTalkMarkdown(sourceLabel)}

` : "";
    const contentLimit = DINGTALK_CHUNK_LIMIT - mentionPrefix.length - sourcePrefix.length;
    if (contentLimit <= 0) {
      throw new Error("DingTalk source label exceeds the message limit.");
    }
    const chunks = normalizeDingTalkMarkdown(outgoingText, contentLimit).map((chunk, index) => `${index === 0 ? mentionPrefix : ""}${sourcePrefix}${chunk}`);
    return {
      title: extractTitle(outgoingText),
      chunks,
      nextChunk: 0,
      ...atUserId ? { atUserId } : {}
    };
  }
  async deliverReplyText(chatId, plan, failOnHttpError = false) {
    const webhook = this.webhooks.get(chatId);
    if (!webhook) {
      if (failOnHttpError) {
        throw new Error("DingTalk session webhook unavailable");
      }
      return;
    }
    while (plan.nextChunk < plan.chunks.length) {
      const index = plan.nextChunk;
      const chunk = plan.chunks[index];
      const isMention = index === 0 && plan.atUserId !== void 0;
      const body = {
        msgtype: "markdown",
        markdown: {
          title: index === 0 ? plan.title : `${plan.title} (cont.)`,
          text: chunk
        },
        ...isMention ? { at: { atUserIds: [plan.atUserId] } } : {}
      };
      let resp;
      try {
        resp = await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REPLY_FETCH_TIMEOUT_MS)
        });
      } catch (err) {
        process.stderr.write(`[DingTalk:${this.name}] sendMessage failed: ${sanitizeLogText(err instanceof Error ? err.message : String(err), 300)}
`);
        throw err;
      }
      if (isMention && process.env["QWEN_CHANNEL_DEBUG_MENTIONS"] === "1") {
        const payload = await resp.clone().json().catch(() => void 0);
        const response = payload && typeof payload === "object" ? payload : {};
        const value = response["errcode"] ?? response["code"];
        const code = typeof value === "number" || typeof value === "string" ? String(value) : "unknown";
        process.stderr.write(`[DingTalk:${this.name}] mention delivery status=${resp.status} code=${code}
`);
      }
      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        process.stderr.write(`[DingTalk:${this.name}] sendMessage failed: HTTP ${resp.status} ${detail}
`);
        if (failOnHttpError) {
          throw new DingtalkCardRequestError(`DingTalk reply send failed: HTTP ${resp.status} ${detail}`, isRetryableDingtalkStatus(resp.status));
        }
      } else if (failOnHttpError) {
        const payload = await resp.clone().json().catch(() => void 0);
        const response = payload && typeof payload === "object" ? payload : void 0;
        const value = response?.["errcode"] ?? response?.["code"];
        if (value !== void 0 && String(value) !== "0") {
          const detail = sanitizeLogText(String(response?.["errmsg"] ?? response?.["message"] ?? value), 300);
          process.stderr.write(`[DingTalk:${this.name}] sendMessage failed: ${detail}
`);
          throw new Error(`DingTalk reply send failed: ${detail}`);
        }
      }
      plan.nextChunk++;
    }
  }
  async sendMessage(chatId, text) {
    await this.sendReply(chatId, text);
  }
  async sendThreadMessage(chatId, _threadId, text, sourceLabel) {
    await this.sendReply(chatId, text, void 0, sourceLabel);
  }
  supportsProactiveSend() {
    return true;
  }
  // Regular proactive paths accept only group targets; webhook tasks may use
  // DMs through the one-to-one API.
  supportsProactiveTarget(target) {
    return target.isGroup === true && target.threadId === void 0 && this.isStableTargetId(target.chatId);
  }
  supportsProactiveDeliveryTarget(target) {
    return typeof target.isGroup === "boolean" && target.threadId === void 0 && this.isStableTargetId(target.chatId);
  }
  supportsProactiveWebhookTarget(target) {
    return typeof target.isGroup === "boolean" && target.threadId === void 0 && this.isStableTargetId(target.chatId);
  }
  /**
   * Single-shot cold send: a failed chunk aborts the remainder (already-sent
   * chunks are not recalled) and the error surfaces in the loop's lastError.
   */
  async pushProactive(target, text, sourceLabel) {
    if (!text.trim())
      return;
    const plan = await this.createProactiveTextDelivery(target, text, sourceLabel);
    if (!plan)
      return;
    try {
      await this.deliverProactiveText(target, plan);
    } catch (error) {
      throw new ProactiveTextDeliveryError(plan, error);
    }
  }
  async createProactiveTextDelivery(target, text, sourceLabel) {
    const outgoingText = await this.prepareFileOutput(text, (file, mediaId) => this.sendProactiveFile(target, file, mediaId));
    if (!outgoingText.trim())
      return void 0;
    const sourcePrefix = sourceLabel ? `${escapeDingTalkMarkdown(sourceLabel)}

` : "";
    const contentLimit = DINGTALK_CHUNK_LIMIT - sourcePrefix.length;
    if (contentLimit <= 0) {
      throw new Error("DingTalk source label exceeds the message limit.");
    }
    const chunks = normalizeDingTalkMarkdown(outgoingText, contentLimit).map((chunk) => `${sourcePrefix}${chunk}`);
    return { title: extractTitle(outgoingText), chunks, nextChunk: 0 };
  }
  async deliverProactiveText(target, plan) {
    while (plan.nextChunk < plan.chunks.length) {
      const index = plan.nextChunk;
      await this.sendProactiveChunk(target, index === 0 ? plan.title : `${plan.title} (cont.)`, plan.chunks[index], `chunk ${index + 1}/${plan.chunks.length}`);
      plan.nextChunk++;
    }
  }
  async getProactiveToken() {
    const cached = this.proactiveToken;
    if (cached && Date.now() < cached.expiresAt)
      return cached.token;
    const url2 = `${TOKEN_API}?appkey=${encodeURIComponent(this.config.clientId)}&appsecret=${encodeURIComponent(this.config.clientSecret)}`;
    let data;
    try {
      const resp = await fetch(url2, {
        signal: AbortSignal.timeout(PROACTIVE_FETCH_TIMEOUT_MS)
      });
      data = await resp.json();
    } catch {
      process.stderr.write(`[DingTalk:${this.name}] access token fetch failed.
`);
      throw new Error("DingTalk access token fetch failed");
    }
    if (!data.access_token) {
      const errmsg = sanitizeLogText(String(data.errmsg ?? ""), 200);
      process.stderr.write(`[DingTalk:${this.name}] access token request failed: gettoken errcode=${data.errcode} ${errmsg}
`);
      throw new DingtalkCardRequestError(`DingTalk access token request failed: gettoken errcode=${data.errcode}${errmsg ? ` ${errmsg}` : ""}`, !PERMANENT_TOKEN_ERROR_CODES.has(Number(data.errcode)));
    }
    this.proactiveToken = {
      token: data.access_token,
      // Refresh a minute early so a fire mid-expiry doesn't race the TTL.
      expiresAt: Date.now() + Math.max(60, (data.expires_in ?? 7200) - 60) * 1e3
    };
    return data.access_token;
  }
  sendCardInteractionFeedback(actorId, target) {
    const copy = this.locale === "zh" ? {
      title: "\u5361\u7247\u64CD\u4F5C",
      group: "\u4EC5\u4EFB\u52A1\u53D1\u8D77\u4EBA\u53EF\u4EE5\u64CD\u4F5C\u8FD9\u5F20\u5361\u7247\uFF0C\u672C\u6B21\u64CD\u4F5C\u672A\u751F\u6548\u3002",
      direct: "\u4F60\u65E0\u6743\u64CD\u4F5C\u8FD9\u5F20\u5361\u7247\uFF0C\u4EC5\u4EFB\u52A1\u53D1\u8D77\u4EBA\u53EF\u4EE5\u63D0\u4EA4\u6216\u505C\u6B62\u3002"
    } : {
      title: "Card interaction",
      group: "Only the task initiator can operate this card. This action had no effect.",
      direct: "You cannot operate this card. Only the task initiator can submit or stop it."
    };
    if (target?.isGroup) {
      return this.sendProactiveChunk({
        channelName: this.name,
        senderId: actorId,
        chatId: target.chatId,
        isGroup: true
      }, copy.title, copy.group, "card interaction feedback");
    }
    return this.sendProactiveChunk({
      channelName: this.name,
      senderId: actorId,
      chatId: actorId,
      isGroup: false
    }, copy.title, copy.direct, "card interaction feedback");
  }
  async sendProactiveChunk(target, title, text, chunkLabel) {
    return this.sendProactivePayload(target, PROACTIVE_MSG_KEY, { title, text }, chunkLabel);
  }
  async sendProactiveFile(target, file, mediaId) {
    return this.sendProactivePayload(target, PROACTIVE_FILE_MSG_KEY, { mediaId, fileName: file.fileName, fileType: file.fileType }, `file ${file.fileName}`);
  }
  async sendProactivePayload(target, msgKey, msgParam, chunkLabel) {
    const targetKind = target.isGroup === true ? "group" : "dm";
    for (let attempt = 0; ; attempt++) {
      const token = await this.getProactiveToken();
      let resp;
      try {
        const targetBody = target.isGroup === true ? { openConversationId: target.chatId } : { userIds: [target.chatId] };
        resp = await fetch(target.isGroup === true ? GROUP_MSG_API : DIRECT_MSG_API, {
          method: "POST",
          headers: {
            "x-acs-dingtalk-access-token": token,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            robotCode: this.config.clientId,
            ...targetBody,
            msgKey,
            msgParam: JSON.stringify(msgParam)
          }),
          signal: AbortSignal.timeout(PROACTIVE_FETCH_TIMEOUT_MS)
        });
      } catch (err) {
        const cause = err.cause;
        process.stderr.write(`[DingTalk:${this.name}] proactive send error (${targetKind}, ${chunkLabel}): ${err}${cause ? ` (${cause})` : ""}
`);
        throw new Error(`DingTalk proactive send failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (resp.status === 401 && attempt === 0) {
        this.proactiveToken = void 0;
        await resp.body?.cancel();
        continue;
      }
      if (!resp.ok) {
        const detail = sanitizeLogText(await resp.text().catch(() => ""), 300);
        process.stderr.write(`[DingTalk:${this.name}] proactive send failed (${targetKind}, ${chunkLabel}): HTTP ${resp.status} ${detail}
`);
        throw new DingtalkCardRequestError(`DingTalk proactive send failed: HTTP ${resp.status}${detail ? ` ${detail}` : ""}`, isRetryableDingtalkStatus(resp.status));
      }
      if (target.isGroup === true) {
        if (msgKey !== PROACTIVE_FILE_MSG_KEY) {
          await resp.body?.cancel();
          return;
        }
        let data;
        try {
          const parsed = await resp.json();
          data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        } catch {
          throw new Error("DingTalk file delivery failed: invalid JSON response");
        }
        const code = data["errcode"] ?? data["code"];
        if (code !== void 0 && String(code) !== "0") {
          throw new Error(`DingTalk file delivery failed: API code ${code}`);
        }
        if (typeof data["processQueryKey"] !== "string" || !data["processQueryKey"].trim()) {
          throw new Error("DingTalk file delivery failed: missing processQueryKey");
        }
        return;
      }
      if (target.isGroup === false) {
        let data;
        try {
          data = await resp.json();
        } catch {
          process.stderr.write(`[DingTalk:${this.name}] proactive send failed (${targetKind}, ${chunkLabel}): invalid JSON response
`);
          throw new Error("DingTalk proactive send failed: invalid JSON response");
        }
        if (data.invalidStaffIdList?.includes(target.chatId)) {
          process.stderr.write(`[DingTalk:${this.name}] proactive send failed (${targetKind}, ${chunkLabel}): invalid direct recipient
`);
          throw new Error("DingTalk proactive send failed: invalid direct recipient");
        }
        if (data.flowControlledStaffIdList?.includes(target.chatId)) {
          process.stderr.write(`[DingTalk:${this.name}] proactive send failed (${targetKind}, ${chunkLabel}): direct recipient rate limited
`);
          throw new Error("DingTalk proactive send failed: direct recipient rate limited");
        }
        if (msgKey === PROACTIVE_FILE_MSG_KEY && !data.processQueryKey?.trim()) {
          throw new Error("DingTalk file delivery failed: missing processQueryKey");
        }
        return;
      }
      await resp.body?.cancel();
      return;
    }
  }
  getAccessToken() {
    return this.client.getConfig().access_token;
  }
  async emotionApi(endpoint, msgId, conversationId, tag) {
    const robotCode = this.config.clientId;
    if (!robotCode || !msgId || !conversationId)
      return false;
    try {
      const token = this.config.clientSecret ? await this.getProactiveToken() : this.getAccessToken();
      if (!token)
        return false;
      for (let attempt = 0; attempt < EMOTION_MAX_ATTEMPTS; attempt++) {
        const resp = await fetch(`${EMOTION_API}/${endpoint}`, {
          method: "POST",
          headers: {
            "x-acs-dingtalk-access-token": token,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            robotCode,
            openMsgId: msgId,
            openConversationId: conversationId,
            emotionType: 2,
            emotionName: tag.name,
            textEmotion: {
              emotionId: tag.emotionId,
              emotionName: tag.name,
              text: tag.name,
              backgroundId: tag.backgroundId
            }
          }),
          signal: AbortSignal.timeout(EMOTION_FETCH_TIMEOUT_MS)
        });
        if (resp.ok)
          return true;
        const isTransient = resp.status === 429 || resp.status >= 500;
        if (isTransient && attempt < EMOTION_MAX_ATTEMPTS - 1) {
          await resp.body?.cancel();
          await new Promise((resolve) => setTimeout(resolve, EMOTION_RETRY_BASE_DELAY_MS * 2 ** attempt));
          continue;
        }
        const detail = sanitizeLogText(await resp.text().catch(() => ""), 500);
        process.stderr.write(`[DingTalk:${this.name}] emotion/${endpoint} failed after ${attempt + 1}/${EMOTION_MAX_ATTEMPTS} attempts: ${resp.status} ${detail}
`);
        return false;
      }
    } catch {
    }
    return false;
  }
  async attachReaction(msgId, conversationId, tag = EYE_TAG) {
    return this.emotionApi("reply", msgId, conversationId, tag);
  }
  async recallReaction(msgId, conversationId, tag = EYE_TAG) {
    return this.emotionApi("recall", msgId, conversationId, tag);
  }
  disconnect() {
    if (this.dedupTimer) {
      clearInterval(this.dedupTimer);
    }
    const reactionStates = [...this.reactionStates.values()];
    for (const state of reactionStates) {
      this.finishReaction(state.chatId, state.messageId, state.sessionId);
    }
    const backgroundDrain = this.backgroundOutputCoordinator.drain();
    this.activeReactionKeys.clear();
    this.sessionReactionKeys.clear();
    this.reactionStates.clear();
    if (this.connectionManager) {
      this.connectionManager.stop();
    } else {
      this.client.disconnect();
    }
    process.stderr.write(`[DingTalk:${this.name}] Disconnected.
`);
    this.disconnectDrain = Promise.allSettled([
      backgroundDrain,
      ...reactionStates.map((state) => state.tail)
    ]).then(() => {
      this.statusCardController?.dispose();
    });
  }
  waitForDisconnect() {
    return this.disconnectDrain ?? Promise.resolve();
  }
  /** Stable API targets are conversation or user IDs, never webhook URLs. */
  isStableTargetId(chatId) {
    return !!chatId && !/^https?:\/\//i.test(chatId);
  }
  reactionKey(messageId, conversationId) {
    return `${conversationId}:${messageId}`;
  }
  forgetReactionState(state) {
    this.activeReactionKeys.delete(state.key);
    if (this.reactionStates.get(state.key) === state) {
      this.reactionStates.delete(state.key);
    }
    if (!state.sessionId)
      return;
    const keys = this.sessionReactionKeys.get(state.sessionId);
    keys?.delete(state.key);
    if (keys?.size === 0)
      this.sessionReactionKeys.delete(state.sessionId);
  }
  enqueueReaction(state, operation) {
    state.tail = state.tail.then(operation).catch((err) => {
      this.logReactionFailure("lifecycle tag update", err);
    });
  }
  scheduleReactionDrain(state) {
    if (state.drainScheduled)
      return;
    state.drainScheduled = true;
    this.enqueueReaction(state, async () => {
      try {
        await this.drainReactionState(state);
      } finally {
        state.drainScheduled = false;
        if (this.reactionStates.get(state.key) === state && (state.finishing ? !state.finishBlocked : this.activeReactionKeys.has(state.key) && state.desiredStatusTag && state.desiredStatusTag.name !== state.statusTag?.name)) {
          this.scheduleReactionDrain(state);
        }
      }
    });
  }
  async drainReactionState(state) {
    while (true) {
      if (state.finishing) {
        await this.finishReactionState(state);
        return;
      }
      if (this.reactionStates.get(state.key) !== state || !this.activeReactionKeys.has(state.key)) {
        return;
      }
      const desired = state.desiredStatusTag;
      if (!desired || desired.name === state.statusTag?.name)
        return;
      const latched = state.failedTransition;
      if (state.statusTag) {
        const from = state.statusTag.name;
        if (latched && latched.from === from && latched.to === desired.name) {
          state.desiredStatusTag = state.statusTag;
          return;
        }
        const revision2 = state.revision;
        if (await this.recallReaction(state.messageId, state.chatId, state.statusTag) === false) {
          state.failedTransition = { from, to: desired.name };
          if (state.revision !== revision2)
            continue;
          state.desiredStatusTag = state.statusTag;
          return;
        }
        state.failedTransition = void 0;
        state.statusTag = void 0;
        continue;
      }
      if (latched && latched.from === void 0 && latched.to === desired.name) {
        state.desiredStatusTag = void 0;
        return;
      }
      const revision = state.revision;
      if (await this.attachReaction(state.messageId, state.chatId, desired) === false) {
        state.failedTransition = { from: void 0, to: desired.name };
        if (state.revision !== revision)
          continue;
        state.desiredStatusTag = void 0;
        return;
      }
      state.failedTransition = void 0;
      state.statusTag = desired;
    }
  }
  async finishReactionState(state) {
    let statusCleared = true;
    if (state.statusTag) {
      statusCleared = await this.recallReaction(state.messageId, state.chatId, state.statusTag) !== false;
      if (statusCleared)
        state.statusTag = void 0;
    }
    const eyeCleared = !state.eyeAttached || await this.recallReaction(state.messageId, state.chatId, EYE_TAG) !== false;
    if (eyeCleared)
      state.eyeAttached = false;
    let terminalAttached = true;
    if (state.terminalTag && statusCleared && eyeCleared) {
      terminalAttached = await this.attachReaction(state.messageId, state.chatId, state.terminalTag) !== false;
    }
    if (!statusCleared || !eyeCleared || !terminalAttached) {
      state.finishAttempts = (state.finishAttempts ?? 0) + 1;
      if (state.finishAttempts >= EMOTION_FINISH_MAX_ATTEMPTS) {
        this.logReactionFailure("reaction cleanup", `abandoned after ${state.finishAttempts} attempts`);
        this.forgetReactionState(state);
        return;
      }
      state.finishBlocked = true;
      return;
    }
    this.forgetReactionState(state);
  }
  rememberInboundMessageId(msgId) {
    this.inboundMessageIds.delete(msgId);
    this.inboundMessageIds.add(msgId);
    if (this.inboundMessageIds.size > 1e3) {
      const oldest = this.inboundMessageIds.values().next().value;
      if (oldest !== void 0)
        this.inboundMessageIds.delete(oldest);
    }
  }
  logReactionFailure(action, err) {
    process.stderr.write(`[DingTalk:${this.name}] ${action} failed: ${err instanceof Error ? err.message : err}
`);
  }
  startReaction(chatId, messageId, sessionId) {
    if (!messageId || !this.isStableTargetId(chatId))
      return;
    if (!this.inboundMessageIds.has(messageId))
      return;
    const key = this.reactionKey(messageId, chatId);
    if (this.activeReactionKeys.has(key))
      return;
    this.activeReactionKeys.add(key);
    const state = {
      key,
      messageId,
      chatId,
      ...sessionId ? { sessionId } : {},
      desiredStatusTag: this.phaseReactionTag("thinking"),
      finishing: false,
      drainScheduled: false,
      eyeAttached: false,
      revision: 0,
      tail: Promise.resolve()
    };
    this.reactionStates.set(key, state);
    if (sessionId) {
      let keys = this.sessionReactionKeys.get(sessionId);
      if (!keys) {
        keys = /* @__PURE__ */ new Map();
        this.sessionReactionKeys.set(sessionId, keys);
      }
      keys.set(key, { messageId, chatId });
    }
    this.enqueueReaction(state, async () => {
      try {
        if (await this.attachReaction(messageId, chatId, EYE_TAG) === false) {
          this.forgetReactionState(state);
          return;
        }
        state.eyeAttached = true;
        this.scheduleReactionDrain(state);
      } catch (err) {
        this.forgetReactionState(state);
        this.logReactionFailure("reaction attach", err);
      }
    });
  }
  replaceStatusReaction(chatId, messageId, tag) {
    if (!messageId)
      return;
    const state = this.reactionStates.get(this.reactionKey(messageId, chatId));
    if (!state || !this.activeReactionKeys.has(state.key))
      return;
    state.desiredStatusTag = tag;
    state.revision++;
    this.scheduleReactionDrain(state);
  }
  phaseReactionTag(phase) {
    return statusEmotionTag(presentationPhaseLabel(phase, this.displayLanguage));
  }
  terminalReactionTag(type) {
    if (!isChinesePresentationLanguage(this.displayLanguage)) {
      return type === "completed" ? DONE_TAG : type === "failed" ? FAILED_TAG : STOPPED_TAG;
    }
    if (type === "completed") {
      return { ...DONE_TAG, name: "\u2705 \u5DF2\u5B8C\u6210" };
    }
    return statusEmotionTag(type === "failed" ? "\u274C \u5931\u8D25" : "\u23F9\uFE0F \u5DF2\u505C\u6B62");
  }
  finishReaction(chatId, messageId, sessionId, terminalTag) {
    if (!messageId || !this.isStableTargetId(chatId))
      return;
    const key = this.reactionKey(messageId, chatId);
    const state = this.reactionStates.get(key);
    if (!state)
      return;
    if (state.finishing) {
      if (!state.finishBlocked)
        return;
      state.finishBlocked = false;
      if (terminalTag)
        state.terminalTag = terminalTag;
      this.scheduleReactionDrain(state);
      return;
    }
    if (!this.activeReactionKeys.delete(key))
      return;
    state.finishing = true;
    state.desiredStatusTag = void 0;
    state.terminalTag = terminalTag;
    state.revision++;
    this.scheduleReactionDrain(state);
  }
  stopReaction(chatId, messageId, sessionId) {
    this.finishReaction(chatId, messageId, sessionId);
  }
  /** Recall reactions left behind when a session dies without terminal lifecycle events. */
  onSessionDied(sessionId) {
    for (const [runId, state] of this.fileProjectors) {
      if (state.sessionId === sessionId)
        this.fileProjectors.delete(runId);
    }
    const bufferedTargets = this.bufferedMentionTargetsBySession.get(sessionId);
    if (bufferedTargets) {
      this.bufferedMentionTargetsBySession.delete(sessionId);
      for (const messageId of bufferedTargets) {
        this.bufferedMentionTargets.delete(messageId);
        this.mentionTargets.delete(messageId);
      }
    }
    this.sessionMentionTargets.delete(sessionId);
    this.backgroundOutputCoordinator.drain(sessionId);
    const cardRunId = this.cardRunBySession.get(sessionId);
    if (cardRunId) {
      this.cardRunBySession.delete(sessionId);
      this.interactionPresenter?.terminalizeRun(cardRunId, "cancelled");
      this.cardRuns.delete(cardRunId);
    }
    const keys = this.sessionReactionKeys.get(sessionId);
    if (keys) {
      this.sessionReactionKeys.delete(sessionId);
      for (const { messageId, chatId } of keys.values()) {
        this.finishReaction(chatId, messageId, sessionId);
      }
    }
    super.onSessionDied(sessionId);
  }
  /**
   * A crashed standalone bridge never settles its in-flight turns, so their
   * transient tags and ticking status cards would otherwise assert a live
   * turn forever. Finish the tags without a terminal result and terminalize
   * the cards as interrupted. Session state stays: crash recovery restores
   * the sessions on a fresh bridge.
   */
  onBridgeDisconnected() {
    void this.backgroundOutputCoordinator.drain();
    for (const [sessionId, keys] of this.sessionReactionKeys) {
      this.sessionReactionKeys.delete(sessionId);
      for (const { messageId, chatId } of keys.values()) {
        this.finishReaction(chatId, messageId, sessionId);
      }
    }
    for (const [sessionId, runId] of this.cardRunBySession) {
      this.cardRunBySession.delete(sessionId);
      this.interactionPresenter?.terminalizeRun(runId, "cancelled");
      this.cardRuns.delete(runId);
    }
  }
  onSessionRetiring(sessionId) {
    this.backgroundOutputCoordinator.drain(sessionId);
  }
  onTaskLifecycle(event) {
    if (event.type === "started") {
      this.startReaction(event.chatId, event.messageId, event.sessionId);
      const inboundOwner = event.messageId ? this.inboundCardOwners.get(event.messageId) : void 0;
      if (event.messageId)
        this.inboundCardOwners.delete(event.messageId);
      if (event.runId && event.owner && inboundOwner?.ownerId === event.owner.id) {
        this.cardRuns.set(event.runId, inboundOwner);
        this.cardRunBySession.set(event.sessionId, event.runId);
        const sourceLabel = this.getResponseSourceLabel(event.sessionId);
        const atUserId = this.atSender && event.messageId ? this.mentionTargets.get(event.messageId) : void 0;
        this.interactionPresenter?.registerRun(event.runId, event.owner.id, inboundOwner.target, event.sessionId, inboundOwner.sender, sourceLabel, (chatId, text, _sessionId, label) => this.sendReply(chatId, text, atUserId, label));
        this.interactionPresenter?.startStatusCard(event.runId);
      }
      return;
    }
    const presentationPhase = lifecyclePresentationPhase(event);
    if (event.runId && presentationPhase) {
      this.interactionPresenter?.updateStatusCardPhase(event.runId, presentationPhase);
    }
    if (presentationPhase) {
      this.replaceStatusReaction(event.chatId, event.messageId, this.phaseReactionTag(presentationPhase));
      return;
    }
    if (isTerminalTaskLifecycleType(event.type)) {
      if (event.messageId)
        this.mentionTargets.delete(event.messageId);
      this.finishReaction(event.chatId, event.messageId, event.sessionId, this.terminalReactionTag(event.type));
      if (event.runId) {
        this.deleteFileProjectorsForRun(event.runId);
        if (event.type === "failed") {
          this.interactionPresenter?.terminalizeRun(event.runId, "failed", event.error);
        } else if (event.type === "cancelled") {
          this.interactionPresenter?.terminalizeRun(event.runId, "cancelled", event.reason);
        } else {
          this.interactionPresenter?.terminalizeRun(event.runId, "completed");
        }
        this.cardRuns.delete(event.runId);
        if (this.cardRunBySession.get(event.sessionId) === event.runId) {
          this.cardRunBySession.delete(event.sessionId);
        }
      }
    }
  }
  onPromptBufferDropped(_chatId, sessionId, messageIds) {
    for (const messageId of messageIds) {
      this.bufferedMentionTargets.delete(messageId);
      this.mentionTargets.delete(messageId);
      this.untrackBufferedMentionTarget(sessionId, messageId);
    }
  }
  onPromptBufferDrained(_chatId, sessionId, messageIds) {
    for (const messageId of messageIds) {
      this.bufferedMentionTargets.delete(messageId);
      this.untrackBufferedMentionTarget(sessionId, messageId);
    }
    for (const messageId of messageIds.slice(0, -1)) {
      this.mentionTargets.delete(messageId);
    }
  }
  onPromptBuffered(_chatId, sessionId, messageId) {
    if (messageId && this.mentionTargets.has(messageId)) {
      this.bufferedMentionTargets.add(messageId);
      let targets = this.bufferedMentionTargetsBySession.get(sessionId);
      if (!targets) {
        targets = /* @__PURE__ */ new Set();
        this.bufferedMentionTargetsBySession.set(sessionId, targets);
      }
      targets.add(messageId);
    }
  }
  onPromptStart(chatId, sessionId, messageId) {
    if (messageId) {
      this.bufferedMentionTargets.delete(messageId);
      this.untrackBufferedMentionTarget(sessionId, messageId);
      const atUserId = this.mentionTargets.get(messageId);
      this.mentionTargets.delete(messageId);
      if (this.atSender && atUserId) {
        this.sessionMentionTargets.set(sessionId, atUserId);
      }
    }
    this.startReaction(chatId, messageId, sessionId);
  }
  async handleInbound(envelope) {
    if (!await this.preflightInbound(envelope))
      return;
    await this.processPreflightedInbound(envelope, async () => {
      const messageId = envelope.messageId;
      if (messageId && envelope.senderId) {
        this.inboundCardOwners.delete(messageId);
        this.inboundCardOwners.set(messageId, {
          ownerId: envelope.senderId,
          target: {
            chatId: envelope.chatId,
            isGroup: envelope.isGroup
          },
          ...this.atSender && envelope.isGroup ? {
            sender: {
              senderName: envelope.senderName
            }
          } : {}
        });
        if (this.inboundCardOwners.size > 1e3) {
          const oldest = this.inboundCardOwners.keys().next().value;
          if (oldest !== void 0)
            this.inboundCardOwners.delete(oldest);
        }
      }
      const atUserId = envelope[mentionTarget];
      if (this.atSender && messageId && atUserId) {
        this.mentionTargets.set(messageId, atUserId);
      }
      await this.processInbound(envelope);
    });
  }
  async processInbound(envelope) {
    const messageId = envelope.messageId;
    try {
      await super.processInbound(envelope);
    } finally {
      if (messageId && !this.bufferedMentionTargets.has(messageId)) {
        this.mentionTargets.delete(messageId);
      }
    }
  }
  untrackBufferedMentionTarget(sessionId, messageId) {
    const targets = this.bufferedMentionTargetsBySession.get(sessionId);
    if (!targets)
      return;
    targets.delete(messageId);
    if (targets.size === 0)
      this.bufferedMentionTargetsBySession.delete(sessionId);
  }
  onPromptEnd(chatId, sessionId, messageId) {
    this.sessionMentionTargets.delete(sessionId);
    this.stopReaction(chatId, messageId, sessionId);
  }
  async dispatchBackgroundResponse(sessionId, text, context) {
    const target = this.router.getTarget(sessionId);
    if (!target || target.channelName !== this.name) {
      return super.dispatchBackgroundResponse(sessionId, text, context);
    }
    if (await this.backgroundOutputCoordinator.dispatch(sessionId, text, context)) {
      return;
    }
    if (!text.trim())
      return;
    const delivery = await this.resolveBackgroundResponseDelivery(sessionId);
    if (!delivery || this.router.getTarget(sessionId) !== delivery.target)
      return;
    await this.deliverBackgroundResponseToTarget(sessionId, text, delivery, false, context);
  }
  createBackgroundOutputDelivery(sessionId, target) {
    let proactivePlan;
    let replyPlan;
    let preparedReplyBody;
    let composedHeader;
    let composedTurnComplete = false;
    return async (output) => {
      const header = this.formatBackgroundOutputHeader(output);
      const body = [header, output.text].filter(Boolean).join("\n\n");
      const plan = proactivePlan ?? replyPlan;
      if (!plan || plan.nextChunk === 0) {
        const replaceHeader = /* @__PURE__ */ __name((text) => {
          if (composedHeader === void 0 || composedHeader === header) {
            return text;
          }
          const separator = output.text ? "\n\n" : "";
          const previous = composedHeader ? `${composedHeader}${separator}` : "";
          const next = header ? `${header}${separator}` : "";
          return text.startsWith(previous) ? `${next}${text.slice(previous.length)}` : text;
        }, "replaceHeader");
        if (plan) {
          plan.title = extractTitle(body);
          const prefix = (replyPlan?.atUserId ? `@${replyPlan.atUserId}

` : "") + (target.sourceLabel ? `${escapeDingTalkMarkdown(target.sourceLabel)}

` : "");
          plan.chunks[0] = prefix + replaceHeader(plan.chunks[0].slice(prefix.length));
        }
        if (preparedReplyBody) {
          preparedReplyBody = replaceHeader(preparedReplyBody);
        }
        composedHeader = header;
        composedTurnComplete = output.turnComplete;
      }
      try {
        if (proactivePlan) {
          await this.deliverProactiveText(target.target, proactivePlan);
        } else if (replyPlan) {
          await this.deliverReplyText(target.target.chatId, replyPlan, true);
        } else {
          if (this.statusCardController || !this.supportsProactiveSend() || !this.supportsProactiveTarget(target.target)) {
            preparedReplyBody ??= await this.prepareBackgroundOutput(target.target, body);
          }
          await this.deliverBackgroundResponseToTarget(sessionId, preparedReplyBody ?? body, target, preparedReplyBody !== void 0, output);
        }
        return { turnComplete: composedTurnComplete };
      } catch (error) {
        if (error instanceof ProactiveTextDeliveryError) {
          proactivePlan = error.plan;
        } else if (error instanceof ReplyTextDeliveryError) {
          replyPlan = error.plan;
        }
        throw error;
      }
    };
  }
  formatBackgroundOutputHeader(delivery) {
    const chinese = isChinesePresentationLanguage(this.displayLanguage);
    const partialLabel = partialOutputLabel(this.displayLanguage);
    const icon = delivery.status === "completed" ? "\u2705" : delivery.status === "failed" ? "\u274C" : "\u23F9\uFE0F";
    if (delivery.kind === "agent") {
      if (delivery.text)
        return delivery.partial ? partialLabel : "";
      const status = delivery.status === "completed" ? chinese ? "\u5DF2\u5B8C\u6210" : "completed" : delivery.status === "failed" ? chinese ? "\u5931\u8D25" : "failed" : chinese ? "\u5DF2\u505C\u6B62" : "stopped";
      return chinese ? `${icon} \u540E\u53F0\u4EFB\u52A1${status}` : `${icon} Background task ${status}`;
    }
    const label = this.formatBackgroundTaskLabel(delivery.label);
    const kind = {
      shell: "Shell",
      monitor: "Monitor",
      workflow: "Workflow"
    }[delivery.kind];
    return `## ${icon} ${kind} \xB7 ${label}${delivery.partial ? `${chinese ? "" : " "}${partialLabel}` : ""}`;
  }
  formatBackgroundTaskLabel(label) {
    const normalized = label?.replace(new RegExp("\\p{Cc}+", "gu"), " ").replace(/\s+/g, " ").trim();
    return escapeDingTalkMarkdown(normalized || (isChinesePresentationLanguage(this.displayLanguage) ? "\u540E\u53F0\u4EFB\u52A1" : "Background task"));
  }
  prepareBackgroundOutput(target, text) {
    return this.supportsProactiveSend() && this.supportsProactiveTarget(target) ? this.prepareFileOutput(text, (file, mediaId) => this.sendProactiveFile(target, file, mediaId)) : this.prepareReplyOutput(target.chatId, text);
  }
  async deliverBackgroundResponseToTarget(sessionId, text, delivery, prepared = false, result) {
    const { target, sourceLabel } = delivery;
    if (this.statusCardController && this.supportsProactiveDeliveryTarget(target) && (target.isGroup === true || this.isStableTargetId(target.senderId))) {
      if (!prepared) {
        text = await this.prepareBackgroundOutput(target, text);
        prepared = true;
      }
      if (await this.statusCardController.deliverCompletedResult({
        chatId: target.isGroup ? target.chatId : target.senderId,
        isGroup: target.isGroup === true
      }, text, sourceLabel, result)) {
        return;
      }
    }
    if (this.supportsProactiveSend() && this.supportsProactiveTarget(target)) {
      return super.deliverBackgroundResponseToTarget(sessionId, text, delivery);
    }
    await this.deliverBackgroundReply(target.chatId, text, sessionId, sourceLabel, prepared, true);
  }
  /**
   * Body-identical to the base implementation — this override exists only to
   * widen the signature, which the base seam does not declare. The background
   * output delivery passes `prepared` so the body it already projected isn't
   * projected a second time (that would re-upload its files), and
   * `failOnHttpError` so a failed send throws instead of being swallowed,
   * letting the flush capture the delivery plan for the next retry.
   */
  async deliverBackgroundReply(chatId, text, sessionId, sourceLabel, prepared = false, failOnHttpError = false) {
    await this.sendResponseMessage(chatId, text, sessionId, sourceLabel, prepared, failOnHttpError);
  }
  async sendResponseMessage(chatId, text, sessionId, sourceLabel, prepared = false, failOnHttpError = false) {
    const atUserId = this.atSender ? this.sessionMentionTargets.get(sessionId) : void 0;
    if (atUserId)
      this.sessionMentionTargets.delete(sessionId);
    await this.sendReply(chatId, text, atUserId, sourceLabel ?? this.getResponseSourceLabel(sessionId), prepared, failOnHttpError);
  }
  async sendFallbackReply(chatId, text, sessionId, sourceLabel) {
    const atUserId = this.atSender ? this.sessionMentionTargets.get(sessionId) : void 0;
    await this.sendReply(chatId, text, atUserId, sourceLabel);
  }
  async onResponseComplete(chatId, text, sessionId, segment) {
    const streamed = segment ? this.fileProjectors.get(segment.runId)?.projector : void 0;
    if (segment)
      this.fileProjectors.delete(segment.runId);
    const outgoingText = await this.prepareReplyOutput(chatId, text, streamed);
    if (segment && this.interactionPresenter) {
      if (await this.interactionPresenter.closeOutput(segment.segmentId, outgoingText, "completed", segment)) {
        return;
      }
    }
    await this.sendResponseMessage(chatId, segment?.partial ? markPartialOutput(outgoingText, this.displayLanguage) : outgoingText, sessionId, segment?.sourceLabel, true);
  }
  onOutputSegmentEnd(_chatId, _sessionId, segment, reason) {
    if (reason === "completed" || reason === "failed" || reason === "cancelled") {
      this.fileProjectors.delete(segment.runId);
    }
    if (!this.interactionPresenter)
      return;
    return this.interactionPresenter.closeOutput(segment.segmentId, "", reason, segment).then(() => void 0);
  }
  onResponseChunk(_chatId, chunk, _sessionId, segment) {
    if (!segment)
      return;
    let state = this.fileProjectors.get(segment.runId);
    if (!state) {
      state = {
        sessionId: segment.sessionId,
        projector: new OutboundFileProjector()
      };
      this.fileProjectors.set(segment.runId, state);
    }
    const safe = state.projector.append(chunk);
    if (safe)
      this.interactionPresenter?.appendOutput(segment, safe);
  }
  deleteFileProjectorsForRun(runId) {
    this.fileProjectors.delete(runId);
  }
  async presentUserInputRequest(context) {
    const run = this.cardRuns.get(context.runId);
    if (!run || run.ownerId !== context.owner.id) {
      return { kind: "unsupported" };
    }
    if (!this.questionCardController || !this.interactionPresenter) {
      return { kind: "unsupported" };
    }
    return this.interactionPresenter.presentInput(context);
  }
  async presentPermissionRequest(context) {
    const run = this.cardRuns.get(context.runId);
    if (!run || run.ownerId !== context.owner.id) {
      return { kind: "unsupported" };
    }
    if (!this.permissionCardController || !this.interactionPresenter) {
      return { kind: "unsupported" };
    }
    return this.interactionPresenter.presentPermission(context);
  }
  /**
   * Extract quoted/referenced message context from a reply.
   * DingTalk provides this via text.repliedMsg (newer) or quoteMessage (legacy).
   */
  extractQuotedContext(data) {
    if (data.text?.isReplyMsg && data.text.repliedMsg) {
      const replied = data.text.repliedMsg;
      const isReplyToBot = !!data.chatbotUserId && replied.senderId === data.chatbotUserId;
      const text = this.summarizeRepliedContent(replied);
      const media = [];
      const richText = replied.content?.richText;
      if (Array.isArray(richText)) {
        for (const part of richText) {
          const mediaType = this.mediaTypeFromMsgType(richTextPartType(part));
          if (part.downloadCode && mediaType) {
            media.push({ downloadCode: part.downloadCode, mediaType });
          }
        }
      } else {
        const downloadCode = replied.content?.downloadCode;
        const mediaType = this.mediaTypeFromMsgType(replied.msgType);
        if (downloadCode && mediaType) {
          media.push({
            downloadCode,
            mediaType,
            fileName: replied.content?.fileName
          });
        }
      }
      return {
        referencedText: text || void 0,
        isReplyToBot,
        media
      };
    }
    if (data.quoteMessage) {
      const quote = data.quoteMessage;
      const isReplyToBot = !!data.chatbotUserId && quote.senderId === data.chatbotUserId;
      const text = quote.text?.content?.trim();
      return { referencedText: text || void 0, isReplyToBot, media: [] };
    }
    return { isReplyToBot: false, media: [] };
  }
  /**
   * Warn once when a chat-record payload yields nothing to show the model.
   * Both chat-record paths degrade silently otherwise — `parseJsonArray`
   * swallows JSON errors, the top-level path falls back to `(chat record)`
   * and the replied path to an empty quote — matching this file's convention
   * of logging degraded paths (`onDownStream`, `onMessage`).
   */
  warnEmptyChatRecord(content) {
    process.stderr.write(`[DingTalk:${this.name}] chat record had no readable content (content keys: ${sanitizeLogText(describeChatRecordKeys(content), 200)})
`);
  }
  /**
   * The partial degradation the empty-record warning cannot see: a title or
   * summary rendered, so the result is non-empty, but the entries key that
   * arrived produced no lines at all (an object encoding such as
   * `{"list":[...]}`, a non-array, or a present-but-unusable first alias).
   * Every forwarded message is dropped and the user reports only that "the bot
   * cannot see forwarded messages"; without this line nothing in the log
   * distinguishes that from model behaviour.
   */
  warnUnreadableChatRecordEntries(content) {
    process.stderr.write(`[DingTalk:${this.name}] chat record summary rendered but no readable entries (content keys: ${sanitizeLogText(describeChatRecordKeys(content), 200)})
`);
  }
  /**
   * Build a text summary from a repliedMsg, handling text, richText, chat
   * records, and media message types with placeholders.
   */
  summarizeRepliedContent(replied) {
    const msgType = replied.msgType;
    const content = replied.content;
    if (content?.text?.trim()) {
      return content.text.trim();
    }
    if (content?.richText && Array.isArray(content.richText)) {
      const parts = [];
      for (const part of content.richText) {
        const partType = richTextPartType(part);
        const partText = typeof part.text === "string" ? part.text : part.content;
        if (partType === "text" && partText) {
          parts.push(partText);
        } else if (partType === "picture") {
          parts.push("[image]");
        } else if (partType === "at" && part.atName) {
          parts.push(`@${part.atName}`);
        }
      }
      const summary = parts.join("").trim();
      if (summary)
        return summary;
    }
    if (msgType === "chatRecord") {
      const { text, entriesDropped } = formatChatRecord(content, MAX_QUOTED_CHAT_RECORD_CHARS);
      if (!text)
        this.warnEmptyChatRecord(content);
      else if (entriesDropped)
        this.warnUnreadableChatRecordEntries(content);
      return text;
    }
    return mediaTypePlaceholder(msgType, content?.fileName) ?? "";
  }
  /**
   * Map a DingTalk message type to the media type used for downloads. Shared
   * by the direct-media (`extractContent`) and quoted-media
   * (`extractQuotedContext`) paths so the mapping cannot drift between them.
   */
  mediaTypeFromMsgType(msgType) {
    if (msgType === "picture")
      return "image";
    if (msgType === "file" || msgType === "audio" || msgType === "video") {
      return msgType;
    }
    return void 0;
  }
  /**
   * Extract text and media download codes from an incoming DingTalk message.
   * Handles text, richText, chat records, picture, file, audio, and video
   * message types.
   */
  extractContent(data) {
    const msgtype = data.msgtype || "text";
    if (msgtype === "richText") {
      const richText = data.content?.richText;
      if (!Array.isArray(richText)) {
        return { text: "", downloadCodes: [], syntheticText: false };
      }
      let text = "";
      const codes = [];
      for (const part of richText) {
        const partType = part.type || "text";
        if (partType === "text" && part.text) {
          text += part.text;
        } else if (partType === "picture" && part.downloadCode) {
          codes.push(part.downloadCode);
        }
      }
      return {
        text: text.trim() || (codes.length > 0 ? "(image)" : ""),
        downloadCodes: codes,
        mediaType: codes.length > 0 ? "image" : void 0,
        syntheticText: text.trim().length === 0 && codes.length > 0
      };
    }
    if (msgtype === "picture") {
      const code = data.content?.downloadCode;
      return {
        text: "(image)",
        downloadCodes: code ? [code] : [],
        mediaType: this.mediaTypeFromMsgType(msgtype),
        syntheticText: Boolean(code)
      };
    }
    if (msgtype === "file") {
      const code = data.content?.downloadCode;
      const fileName = data.content?.fileName || void 0;
      const placeholder = `(file: ${fileName || "file"})`;
      return {
        text: placeholder,
        downloadCodes: code ? [code] : [],
        mediaType: this.mediaTypeFromMsgType(msgtype),
        fileName,
        placeholder,
        syntheticText: Boolean(code)
      };
    }
    if (msgtype === "audio") {
      const code = data.content?.downloadCode;
      const recognition = data.content?.recognition;
      return {
        text: recognition || "(audio)",
        downloadCodes: code ? [code] : [],
        mediaType: this.mediaTypeFromMsgType(msgtype),
        placeholder: recognition ? void 0 : "(audio)",
        syntheticText: !recognition && Boolean(code)
      };
    }
    if (msgtype === "video") {
      const code = data.content?.downloadCode;
      return {
        text: "(video)",
        downloadCodes: code ? [code] : [],
        mediaType: this.mediaTypeFromMsgType(msgtype),
        placeholder: "(video)",
        syntheticText: Boolean(code)
      };
    }
    if (msgtype === "chatRecord") {
      const { text, entriesDropped } = formatChatRecord(data.content);
      if (!text)
        this.warnEmptyChatRecord(data.content);
      else if (entriesDropped)
        this.warnUnreadableChatRecordEntries(data.content);
      return {
        text: text || "(chat record)",
        downloadCodes: [],
        syntheticText: !text
      };
    }
    return {
      text: data.text?.content?.trim() || "",
      downloadCodes: [],
      syntheticText: false
    };
  }
  /**
   * Download a media file and attach it to the envelope.
   * Images → base64 in envelope; files → saved to temp dir with path in text.
   *
   * `cleanPlaceholderText` is the placeholder `extractContent` generated for
   * this message's own media — `(audio)`, `(video)`, `(file: name)`. Only the
   * direct-media call site has one, and only that call may erase it: on the
   * quoted-media path `envelope.text` is the user's own reply, and a reply
   * that happens to read exactly like a placeholder must survive.
   */
  async attachMedia(envelope, downloadCode, mediaType, fileName, cleanPlaceholderText) {
    let token;
    try {
      token = await this.getProactiveToken();
    } catch {
      process.stderr.write(`[DingTalk:${this.name}] Cannot download media: access token refresh failed.
`);
      return;
    }
    const robotCode = this.config.clientId;
    if (!robotCode) {
      process.stderr.write(`[DingTalk:${this.name}] Cannot download media: missing robotCode.
`);
      return;
    }
    const media = await downloadMedia(downloadCode, robotCode, token);
    if (!media)
      return;
    if (mediaType === "image") {
      const mimeType = media.mimeType.startsWith("image/") ? media.mimeType : "image/jpeg";
      envelope.attachments = [
        ...envelope.attachments || [],
        {
          type: "image",
          data: media.buffer.toString("base64"),
          mimeType
        }
      ];
    } else {
      let dir;
      let filePath;
      let safeName;
      try {
        dir = join(tmpdir3(), "channel-files", randomUUID6());
        mkdirSync(dir, { recursive: true });
        safeName = basename3(typeof fileName === "string" ? fileName : "") || `dingtalk_${mediaType}_${Date.now()}.${GENERATED_MEDIA_EXT[media.mimeType] ?? "bin"}`;
        filePath = join(dir, safeName);
        writeFileSync(filePath, media.buffer);
      } catch (error) {
        if (dir) {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
          }
        }
        process.stderr.write(`[DingTalk:${this.name}] Cannot store media, delivering the text without it: ${sanitizeLogText(error instanceof Error ? error.message : String(error), 300)}
`);
        return;
      }
      if (cleanPlaceholderText !== void 0 && envelope.text === cleanPlaceholderText) {
        envelope.text = "";
      }
      envelope.attachments = [
        ...envelope.attachments || [],
        {
          type: mediaType,
          filePath,
          mimeType: media.mimeType,
          fileName: safeName
        }
      ];
    }
  }
  onMessage(downstream) {
    try {
      const data = typeof downstream.data === "string" ? JSON.parse(downstream.data) : downstream.data;
      this.logDebugPayload("DingTalk", data);
      const dataMsgId = typeof data.msgId === "string" ? data.msgId : void 0;
      const headerMsgId = typeof downstream.headers.messageId === "string" ? downstream.headers.messageId : void 0;
      const msgId = dataMsgId || headerMsgId;
      if (msgId && this.seenMessages.has(msgId)) {
        return;
      }
      if (msgId) {
        this.seenMessages.set(msgId, Date.now());
        this.rememberInboundMessageId(msgId);
      }
      const isGroup = data.conversationType === "2";
      const sessionWebhook = typeof data.sessionWebhook === "string" ? data.sessionWebhook : void 0;
      const conversationId = typeof data.conversationId === "string" ? data.conversationId : void 0;
      const conversationTitle = typeof data.conversationTitle === "string" ? data.conversationTitle : void 0;
      const isMentioned = Boolean(data.isInAtList);
      const senderNick = typeof data.senderNick === "string" ? data.senderNick : void 0;
      const senderStaffId = typeof data.senderStaffId === "string" ? data.senderStaffId : void 0;
      const senderIdValue = typeof data.senderId === "string" ? data.senderId : void 0;
      if (!sessionWebhook) {
        process.stderr.write(`[DingTalk:${this.name}] No sessionWebhook in message, skipping.
`);
        return;
      }
      if (_DingtalkChannel.isUnroutableGroupMessage(isGroup, conversationId)) {
        process.stderr.write(`[DingTalk:${this.name}] Group message has no conversationId, skipping (msgId=${msgId || "unknown"}, sender=${sanitizeSenderName(senderNick || senderStaffId || "unknown")})
`);
        return;
      }
      if (conversationId) {
        this.webhooks.set(conversationId, sessionWebhook);
      }
      process.stderr.write(`[DingTalk:${this.name}] message msgId=${sanitizeLogText(msgId || "unknown", 80)} conversationId=${sanitizeLogText(conversationId || "", 120)} isGroup=${isGroup} isMentioned=${isMentioned} senderNick=${sanitizeLogText(senderNick || "", 80)} senderStaffId=${sanitizeLogText(senderStaffId || "", 80)} senderId=${sanitizeLogText(senderIdValue || "", 80)}
`);
      const content = this.extractContent(data);
      const quoted = this.extractQuotedContext(data);
      const chatId = conversationId || sessionWebhook;
      const mentionedMemberIds = isGroup ? collectNonBotMentionIds(data) : [];
      const senderId = senderStaffId || senderIdValue || "";
      const senderName = senderNick || senderId || "Unknown";
      const dmSenderId = senderNick && senderId ? ` (sender ID: ${sanitizeSenderName(senderId)})` : "";
      const dmCommandToken = content.text.trimStart().match(/^\/(\S+)/)?.[1] ?? "";
      const dmSenderMetadata = !isGroup && this.config.sessionScope !== "single" && !SLASH_COMMAND_TOKEN_RE.test(dmCommandToken) ? `Direct message from ${sanitizeSenderName(senderNick || senderId)}${dmSenderId}` : void 0;
      const envelope = {
        channelName: this.name,
        senderId,
        senderName,
        chatId,
        ...isGroup && conversationTitle ? { chatName: conversationTitle } : {},
        text: content.text,
        ...content.syntheticText ? { syntheticText: true } : {},
        ...mentionedMemberIds.length > 0 ? { mentionedMemberIds } : {},
        ...dmSenderMetadata ? { metadata: dmSenderMetadata } : {},
        isGroup,
        isMentioned,
        isReplyToBot: quoted.isReplyToBot,
        referencedText: quoted.referencedText
      };
      envelope.messageId = msgId;
      if (this.atSender && isGroup && senderStaffId) {
        envelope[mentionTarget] = senderStaffId;
      }
      const processMessage = content.downloadCodes.length > 0 || quoted.media.length > 0 ? this.prepareThenHandleInbound(envelope, async () => {
        if (content.downloadCodes.length > 0 && content.mediaType) {
          for (const downloadCode of content.downloadCodes) {
            await this.attachMedia(envelope, downloadCode, content.mediaType, content.fileName, content.placeholder);
          }
        }
        for (const media of quoted.media) {
          await this.attachMedia(envelope, media.downloadCode, media.mediaType, media.fileName);
        }
      }) : this.handleInbound(envelope);
      processMessage.catch((err) => {
        const reference = randomUUID6().slice(0, 8);
        let errorSummary = "Unknown error";
        try {
          errorSummary = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        } catch {
        }
        process.stderr.write(`[DingTalk:${this.name}] Error handling message ref=${reference}: ${sanitizeLogText(errorSummary, 300)}
`);
        const fallbackMessage = formatInboundErrorMessage(err, reference);
        const sourceLabel = this.getInboundErrorSourceLabel(envelope);
        const delivery = sourceLabel ? this.sendThreadMessage(chatId, envelope.threadId, fallbackMessage, sourceLabel) : this.sendMessage(chatId, fallbackMessage);
        delivery.catch(() => {
        });
      });
    } catch (err) {
      process.stderr.write(`[DingTalk:${this.name}] Failed to parse message: ${err}
`);
    }
  }
};

// packages/channels/dingtalk/dist/index.js
var plugin = {
  channelType: "dingtalk",
  displayName: "DingTalk",
  requiredConfigFields: ["clientId", "clientSecret"],
  supportsOutputMode: true,
  management: {
    fields: [
      {
        key: "clientId",
        label: "Client ID",
        kind: "string",
        required: true,
        envResolvable: true
      },
      {
        key: "clientSecret",
        label: "Client Secret",
        kind: "secret",
        required: true,
        envResolvable: true
      },
      {
        key: "interactiveCards",
        label: "Interactive Cards",
        kind: "object",
        properties: [
          {
            key: "enabled",
            label: "Enabled",
            kind: "boolean"
          },
          {
            key: "statusCard",
            label: "Status Card",
            kind: "object",
            properties: [
              {
                key: "enabled",
                label: "Enabled",
                kind: "boolean"
              }
            ]
          },
          {
            key: "questionCard",
            label: "Question Card",
            kind: "object",
            properties: [
              {
                key: "enabled",
                label: "Enabled",
                kind: "boolean"
              },
              {
                key: "timeoutMs",
                label: "Timeout (ms)",
                kind: "number",
                exclusiveMinimum: DINGTALK_INTERACTIVE_CARD_TIMEOUT_EXCLUSIVE_MINIMUM
              }
            ]
          },
          {
            key: "permissionCard",
            label: "Permission Card",
            kind: "object",
            properties: [
              {
                key: "enabled",
                label: "Enabled",
                kind: "boolean"
              },
              {
                key: "timeoutMs",
                label: "Timeout (ms)",
                kind: "number",
                exclusiveMinimum: DINGTALK_INTERACTIVE_CARD_TIMEOUT_EXCLUSIVE_MINIMUM
              }
            ]
          }
        ]
      }
    ]
  },
  createChannel: /* @__PURE__ */ __name((name, config, bridge, options) => new DingtalkChannel(name, config, bridge, options), "createChannel")
};
export {
  DingtalkChannel,
  downloadMedia,
  plugin
};
