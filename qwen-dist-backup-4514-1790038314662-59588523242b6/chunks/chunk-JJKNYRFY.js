// Force strict mode and setup for ESM
"use strict";
import {
  require_dist,
  require_follow_redirects,
  require_form_data
} from "./chunk-OBTWL6ZW.js";
import {
  require_extension,
  require_permessage_deflate,
  require_receiver,
  require_sender,
  require_stream,
  require_subprotocol,
  require_websocket,
  require_websocket_server
} from "./chunk-RVIGZBIT.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __commonJS,
  __name,
  __require
} from "./chunk-J2S4EL5Y.js";

// node_modules/axios/dist/node/axios.cjs
var require_axios = __commonJS({
  "node_modules/axios/dist/node/axios.cjs"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var FormData$1 = require_form_data();
    var crypto = __require("crypto");
    var url = __require("url");
    var HttpsProxyAgent = require_dist();
    var http = __require("http");
    var https = __require("https");
    var http2 = __require("http2");
    var util = __require("util");
    var path = __require("path");
    var followRedirects = require_follow_redirects();
    var zlib = __require("zlib");
    var stream = __require("stream");
    var events = __require("events");
    function bind(fn, thisArg) {
      return /* @__PURE__ */ __name(function wrap() {
        return fn.apply(thisArg, arguments);
      }, "wrap");
    }
    __name(bind, "bind");
    var {
      toString
    } = Object.prototype;
    var {
      getPrototypeOf
    } = Object;
    var {
      iterator,
      toStringTag
    } = Symbol;
    var hasOwnProperty = (({
      hasOwnProperty: hasOwnProperty2
    }) => (obj, prop) => hasOwnProperty2.call(obj, prop))(Object.prototype);
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
    var {
      isArray
    } = Array;
    var isUndefined = typeOfTest("undefined");
    function isBuffer(val) {
      return val !== null && !isUndefined(val) && val.constructor !== null && !isUndefined(val.constructor) && isFunction$1(val.constructor.isBuffer) && val.constructor.isBuffer(val);
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
    var isFunction$1 = typeOfTest("function");
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
    var isStream = /* @__PURE__ */ __name((val) => isObject(val) && isFunction$1(val.pipe), "isStream");
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
      if (!isFunction$1(thing.append)) return false;
      const kind = kindOf(thing);
      return kind === "formdata" || // detect form-data instance
      kind === "object" && isFunction$1(thing.toString) && thing.toString() === "[object FormData]";
    }, "isFormData");
    var isURLSearchParams = kindOfTest("URLSearchParams");
    var [isReadableStream, isRequest, isResponse, isHeaders] = ["ReadableStream", "Request", "Response", "Headers"].map(kindOfTest);
    var trim = /* @__PURE__ */ __name((str) => {
      return str.trim ? str.trim() : str.replace(/^[\s\uFEFF\xA0]+|[\s\uFEFF\xA0]+$/g, "");
    }, "trim");
    function forEach(obj, fn, {
      allOwnKeys = false
    } = {}) {
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
      const {
        caseless,
        skipUndefined
      } = isContextDefined(this) && this || {};
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
    var extend = /* @__PURE__ */ __name((a, b, thisArg, {
      allOwnKeys
    } = {}) => {
      forEach(b, (val, key) => {
        if (thisArg && isFunction$1(val)) {
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
      }, {
        allOwnKeys
      });
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
    var toFlatObject = /* @__PURE__ */ __name((sourceObj, destObj, filter, propFilter) => {
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
        sourceObj = filter !== false && getPrototypeOf(sourceObj);
      } while (sourceObj && (!filter || filter(sourceObj, destObj)) && sourceObj !== Object.prototype);
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
    var {
      propertyIsEnumerable
    } = Object.prototype;
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
        if (isFunction$1(obj) && ["arguments", "caller", "callee"].includes(name)) {
          return false;
        }
        const value = obj[name];
        if (!isFunction$1(value)) return;
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
      return !!(thing && isFunction$1(thing.append) && thing[toStringTag] === "FormData" && thing[iterator]);
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
    var isThenable = /* @__PURE__ */ __name((thing) => thing && (isObject(thing) || isFunction$1(thing)) && isFunction$1(thing.then) && isFunction$1(thing.catch), "isThenable");
    var _setImmediate = ((setImmediateSupported, postMessageSupported) => {
      if (setImmediateSupported) {
        return setImmediate;
      }
      return postMessageSupported ? ((token, callbacks) => {
        _global.addEventListener("message", ({
          source,
          data
        }) => {
          if (source === _global && data === token) {
            callbacks.length && callbacks.shift()();
          }
        }, false);
        return (cb) => {
          callbacks.push(cb);
          _global.postMessage(token, "*");
        };
      })(`axios@${Math.random()}`, []) : (cb) => setTimeout(cb);
    })(typeof setImmediate === "function", isFunction$1(_global.postMessage));
    var asap = typeof queueMicrotask !== "undefined" ? queueMicrotask.bind(_global) : typeof process !== "undefined" && process.nextTick || _setImmediate;
    var isIterable = /* @__PURE__ */ __name((thing) => thing != null && isFunction$1(thing[iterator]), "isIterable");
    var isSafeIterable = /* @__PURE__ */ __name((thing) => thing != null && hasOwnInPrototypeChain(thing, iterator) && isIterable(thing), "isSafeIterable");
    var utils$1 = {
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
      isFunction: isFunction$1,
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
    var ignoreDuplicateOf = utils$1.toObjectSet(["age", "authorization", "content-length", "content-type", "etag", "expires", "from", "host", "if-modified-since", "if-unmodified-since", "last-modified", "location", "max-forwards", "proxy-authorization", "referer", "retry-after", "user-agent"]);
    var parseHeaders = /* @__PURE__ */ __name((rawHeaders) => {
      const parsed = {};
      let key;
      let val;
      let i;
      rawHeaders && rawHeaders.split("\n").forEach(/* @__PURE__ */ __name(function parser(line) {
        i = line.indexOf(":");
        key = line.substring(0, i).trim().toLowerCase();
        val = line.substring(i + 1).trim();
        const hasKey = utils$1.hasOwnProp(parsed, key);
        if (!key || hasKey && utils$1.hasOwnProp(ignoreDuplicateOf, key)) {
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
    }, "parseHeaders");
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
      if (utils$1.isArray(value)) {
        return value.map((item) => sanitizeValue(item, invalidChars));
      }
      return trimSPorHTAB(String(value).replace(invalidChars, ""));
    }
    __name(sanitizeValue, "sanitizeValue");
    var sanitizeHeaderValue = /* @__PURE__ */ __name((value) => sanitizeValue(value, INVALID_UNICODE_HEADER_VALUE_CHARS), "sanitizeHeaderValue");
    var sanitizeByteStringHeaderValue = /* @__PURE__ */ __name((value) => sanitizeValue(value, INVALID_BYTE_STRING_HEADER_VALUE_CHARS), "sanitizeByteStringHeaderValue");
    function toByteStringHeaderObject(headers) {
      const byteStringHeaders = /* @__PURE__ */ Object.create(null);
      utils$1.forEach(headers.toJSON(), (value, header) => {
        byteStringHeaders[header] = sanitizeByteStringHeaderValue(value);
      });
      return byteStringHeaders;
    }
    __name(toByteStringHeaderObject, "toByteStringHeaderObject");
    var $internals = Symbol("internals");
    function normalizeHeader(header) {
      return header && String(header).trim().toLowerCase();
    }
    __name(normalizeHeader, "normalizeHeader");
    function normalizeValue(value) {
      if (value === false || value == null) {
        return value;
      }
      return utils$1.isArray(value) ? value.map(normalizeValue) : sanitizeHeaderValue(String(value));
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
    function matchHeaderValue(context, value, header, filter, isHeaderNameFilter) {
      if (utils$1.isFunction(filter)) {
        return filter.call(this, value, header);
      }
      if (isHeaderNameFilter) {
        value = header;
      }
      if (!utils$1.isString(value)) return;
      if (utils$1.isString(filter)) {
        return value.indexOf(filter) !== -1;
      }
      if (utils$1.isRegExp(filter)) {
        return filter.test(value);
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
      const accessorName = utils$1.toCamelCase(" " + header);
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
          const key = utils$1.findKey(self2, lHeader);
          if (!key || self2[key] === void 0 || _rewrite === true || _rewrite === void 0 && self2[key] !== false) {
            self2[key || _header] = normalizeValue(_value);
          }
        }
        __name(setHeader, "setHeader");
        const setHeaders = /* @__PURE__ */ __name((headers, _rewrite) => utils$1.forEach(headers, (_value, _header) => setHeader(_value, _header, _rewrite)), "setHeaders");
        if (utils$1.isPlainObject(header) || header instanceof this.constructor) {
          setHeaders(header, valueOrRewrite);
        } else if (utils$1.isString(header) && (header = header.trim()) && !isValidHeaderName(header)) {
          setHeaders(parseHeaders(header), valueOrRewrite);
        } else if (utils$1.isObject(header) && utils$1.isSafeIterable(header)) {
          let obj = /* @__PURE__ */ Object.create(null), dest, key;
          for (const entry of header) {
            if (!utils$1.isArray(entry)) {
              throw new TypeError("Object iterator must return a key-value pair");
            }
            key = entry[0];
            if (utils$1.hasOwnProp(obj, key)) {
              dest = obj[key];
              obj[key] = utils$1.isArray(dest) ? [...dest, entry[1]] : [dest, entry[1]];
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
          const key = utils$1.findKey(this, header);
          if (key) {
            const value = this[key];
            if (!parser) {
              return value;
            }
            if (parser === true) {
              return parseTokens(value);
            }
            if (utils$1.isFunction(parser)) {
              return parser.call(this, value, key);
            }
            if (utils$1.isRegExp(parser)) {
              return parser.exec(value);
            }
            throw new TypeError("parser must be boolean|regexp|function");
          }
        }
      }
      has(header, matcher) {
        header = normalizeHeader(header);
        if (header) {
          const key = utils$1.findKey(this, header);
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
            const key = utils$1.findKey(self2, _header);
            if (key && (!matcher || matchHeaderValue(self2, self2[key], key, matcher))) {
              delete self2[key];
              deleted = true;
            }
          }
        }
        __name(deleteHeader, "deleteHeader");
        if (utils$1.isArray(header)) {
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
        utils$1.forEach(this, (value, header) => {
          const key = utils$1.findKey(headers, header);
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
        utils$1.forEach(this, (value, header) => {
          value != null && value !== false && (obj[header] = asStrings && utils$1.isArray(value) ? value.join(", ") : value);
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
        return utils$1.isArray(value) ? value : value == null || value === false ? [] : [value];
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
        utils$1.isArray(header) ? header.forEach(defineAccessor) : defineAccessor(header);
        return this;
      }
    };
    AxiosHeaders.accessor(["Content-Type", "Content-Length", "Accept", "Accept-Encoding", "User-Agent", "Authorization"]);
    utils$1.reduceDescriptors(AxiosHeaders.prototype, ({
      value
    }, key) => {
      let mapped = key[0].toUpperCase() + key.slice(1);
      return {
        get: /* @__PURE__ */ __name(() => value, "get"),
        set(headerValue) {
          this[mapped] = headerValue;
        }
      };
    });
    utils$1.freezeMethods(AxiosHeaders);
    var REDACTED = "[REDACTED ****]";
    function hasOwnOrPrototypeToJSON(source) {
      if (utils$1.hasOwnProp(source, "toJSON")) {
        return true;
      }
      let prototype2 = Object.getPrototypeOf(source);
      while (prototype2 && prototype2 !== Object.prototype) {
        if (utils$1.hasOwnProp(prototype2, "toJSON")) {
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
        if (utils$1.isBuffer(source)) return source;
        if (seen.indexOf(source) !== -1) return void 0;
        if (source instanceof AxiosHeaders) {
          source = source.toJSON();
        }
        seen.push(source);
        let result;
        if (utils$1.isArray(source)) {
          result = [];
          source.forEach((v, i) => {
            const reducedValue = visit(v);
            if (!utils$1.isUndefined(reducedValue)) {
              result[i] = reducedValue;
            }
          });
        } else {
          if (!utils$1.isPlainObject(source) && hasOwnOrPrototypeToJSON(source)) {
            seen.pop();
            return source;
          }
          result = /* @__PURE__ */ Object.create(null);
          for (const [key, value] of Object.entries(source)) {
            const reducedValue = lowerKeys.has(key.toLowerCase()) ? REDACTED : visit(value);
            if (!utils$1.isUndefined(reducedValue)) {
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
    function stringifySafely$1(value) {
      try {
        return String(value);
      } catch (err) {
        return "";
      }
    }
    __name(stringifySafely$1, "stringifySafely$1");
    function aggregateErrorMessage(error) {
      const message = error.errors.map((entry) => {
        try {
          return entry && entry.message ? stringifySafely$1(entry.message) : stringifySafely$1(entry);
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
        if (!message && utils$1.isArray(error.errors) && error.errors.length) {
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
        const redactKeys = config && utils$1.hasOwnProp(config, "redact") ? config.redact : void 0;
        const serializedConfig = utils$1.isArray(redactKeys) && redactKeys.length > 0 ? redactConfig(config, redactKeys) : utils$1.toJSONObject(config);
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
    var PlatformBuffer = {
      isBufferAvailable() {
        return typeof Buffer !== "undefined";
      },
      from(value) {
        return Buffer.from(value);
      }
    };
    var DEFAULT_FORM_DATA_MAX_DEPTH = 100;
    function isVisitable(thing) {
      return utils$1.isPlainObject(thing) || utils$1.isArray(thing);
    }
    __name(isVisitable, "isVisitable");
    function removeBrackets(key) {
      return utils$1.endsWith(key, "[]") ? key.slice(0, -2) : key;
    }
    __name(removeBrackets, "removeBrackets");
    function renderKey(path2, key, dots) {
      if (!path2) return key;
      return path2.concat(key).map(/* @__PURE__ */ __name(function each(token, i) {
        token = removeBrackets(token);
        return !dots && i ? "[" + token + "]" : token;
      }, "each")).join(dots ? "." : "");
    }
    __name(renderKey, "renderKey");
    function isFlatArray(arr) {
      return utils$1.isArray(arr) && !arr.some(isVisitable);
    }
    __name(isFlatArray, "isFlatArray");
    var predicates = utils$1.toFlatObject(utils$1, {}, null, /* @__PURE__ */ __name(function filter(prop) {
      return /^is[A-Z]/.test(prop);
    }, "filter"));
    function toFormData(obj, formData, options) {
      if (!utils$1.isObject(obj)) {
        throw new TypeError("target must be an object");
      }
      formData = formData || new (FormData$1 || FormData)();
      options = utils$1.toFlatObject(options, {
        metaTokens: true,
        dots: false,
        indexes: false
      }, false, /* @__PURE__ */ __name(function defined(option, source) {
        return !utils$1.isUndefined(source[option]);
      }, "defined"));
      const metaTokens = options.metaTokens;
      const visitor = options.visitor || defaultVisitor;
      const dots = options.dots;
      const indexes = options.indexes;
      const _Blob = options.Blob || typeof Blob !== "undefined" && Blob;
      const maxDepth = options.maxDepth === void 0 ? DEFAULT_FORM_DATA_MAX_DEPTH : options.maxDepth;
      const useBlob = _Blob && utils$1.isSpecCompliantForm(formData);
      const stack = [];
      if (!utils$1.isFunction(visitor)) {
        throw new TypeError("visitor must be a function");
      }
      function convertValue(value) {
        if (value === null) return "";
        if (utils$1.isDate(value)) {
          return value.toISOString();
        }
        if (utils$1.isBoolean(value)) {
          return value.toString();
        }
        if (!useBlob && utils$1.isBlob(value)) {
          throw new AxiosError("Blob is not supported. Use a Buffer instead.");
        }
        if (utils$1.isArrayBuffer(value) || utils$1.isTypedArray(value)) {
          if (useBlob && typeof _Blob === "function") {
            return new _Blob([value]);
          }
          if (PlatformBuffer && PlatformBuffer.isBufferAvailable()) {
            return PlatformBuffer.from(value);
          }
          throw new AxiosError("Blob is not supported. Use a Buffer instead.", AxiosError.ERR_NOT_SUPPORT);
        }
        return value;
      }
      __name(convertValue, "convertValue");
      function throwIfMaxDepthExceeded(depth) {
        if (depth > maxDepth) {
          throw new AxiosError("Object is too deeply nested (" + depth + " levels). Max depth: " + maxDepth, AxiosError.ERR_FORM_DATA_DEPTH_EXCEEDED);
        }
      }
      __name(throwIfMaxDepthExceeded, "throwIfMaxDepthExceeded");
      function stringifyWithDepthLimit(value, depth) {
        if (maxDepth === Infinity) {
          return JSON.stringify(value);
        }
        const ancestors = [];
        return JSON.stringify(value, /* @__PURE__ */ __name(function limitDepth(_key, currentValue) {
          if (!utils$1.isObject(currentValue)) {
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
      function defaultVisitor(value, key, path2) {
        let arr = value;
        if (utils$1.isReactNative(formData) && utils$1.isReactNativeBlob(value)) {
          formData.append(renderKey(path2, key, dots), convertValue(value));
          return false;
        }
        if (value && !path2 && typeof value === "object") {
          if (utils$1.endsWith(key, "{}")) {
            key = metaTokens ? key : key.slice(0, -2);
            value = stringifyWithDepthLimit(value, 1);
          } else if (utils$1.isArray(value) && isFlatArray(value) || (utils$1.isFileList(value) || utils$1.endsWith(key, "[]")) && (arr = utils$1.toArray(value))) {
            key = removeBrackets(key);
            arr.forEach(/* @__PURE__ */ __name(function each(el, index) {
              !(utils$1.isUndefined(el) || el === null) && formData.append(
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
        formData.append(renderKey(path2, key, dots), convertValue(value));
        return false;
      }
      __name(defaultVisitor, "defaultVisitor");
      const exposedHelpers = Object.assign(predicates, {
        defaultVisitor,
        convertValue,
        isVisitable
      });
      function build(value, path2, depth = 0) {
        if (utils$1.isUndefined(value)) return;
        throwIfMaxDepthExceeded(depth);
        if (stack.indexOf(value) !== -1) {
          throw new Error("Circular reference detected in " + path2.join("."));
        }
        stack.push(value);
        utils$1.forEach(value, /* @__PURE__ */ __name(function each(el, key) {
          const result = !(utils$1.isUndefined(el) || el === null) && visitor.call(formData, el, utils$1.isString(key) ? key.trim() : key, path2, exposedHelpers);
          if (result === true) {
            build(el, path2 ? path2.concat(key) : [key], depth + 1);
          }
        }, "each"));
        stack.pop();
      }
      __name(build, "build");
      if (!utils$1.isObject(obj)) {
        throw new TypeError("data must be an object");
      }
      build(obj);
      return formData;
    }
    __name(toFormData, "toFormData");
    function encode$1(str) {
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
    __name(encode$1, "encode$1");
    function AxiosURLSearchParams(params, options) {
      this._pairs = [];
      params && toFormData(params, this, options);
    }
    __name(AxiosURLSearchParams, "AxiosURLSearchParams");
    var prototype = AxiosURLSearchParams.prototype;
    prototype.append = /* @__PURE__ */ __name(function append(name, value) {
      this._pairs.push([name, value]);
    }, "append");
    prototype.toString = /* @__PURE__ */ __name(function toString2(encoder) {
      const _encode = encoder ? (value) => encoder.call(this, value, encode$1) : encode$1;
      return this._pairs.map(/* @__PURE__ */ __name(function each(pair) {
        return _encode(pair[0]) + "=" + _encode(pair[1]);
      }, "each"), "").join("&");
    }, "toString");
    function encode(val) {
      return encodeURIComponent(val).replace(/%3A/gi, ":").replace(/%24/g, "$").replace(/%2C/gi, ",").replace(/%20/g, "+");
    }
    __name(encode, "encode");
    function buildURL(url2, params, options) {
      if (!params) {
        return url2;
      }
      url2 = url2 || "";
      const _options = utils$1.isFunction(options) ? {
        serialize: options
      } : options;
      const _encode = utils$1.getSafeProp(_options, "encode") || encode;
      const serializeFn = utils$1.getSafeProp(_options, "serialize");
      let serializedParams;
      if (serializeFn) {
        serializedParams = serializeFn(params, _options);
      } else {
        serializedParams = utils$1.isURLSearchParams(params) ? params.toString() : new AxiosURLSearchParams(params, _options).toString(_encode);
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
        utils$1.forEach(this.handlers, /* @__PURE__ */ __name(function forEachHandler(h) {
          if (h !== null) {
            fn(h);
          }
        }, "forEachHandler"));
      }
    };
    var transitionalDefaults = {
      silentJSONParsing: true,
      forcedJSONParsing: true,
      clarifyTimeoutError: false,
      legacyInterceptorReqResOrdering: true,
      advertiseZstdAcceptEncoding: false,
      validateStatusUndefinedResolves: true
    };
    var URLSearchParams = url.URLSearchParams;
    var ALPHA = "abcdefghijklmnopqrstuvwxyz";
    var DIGIT = "0123456789";
    var ALPHABET = {
      DIGIT,
      ALPHA,
      ALPHA_DIGIT: ALPHA + ALPHA.toUpperCase() + DIGIT
    };
    var generateString = /* @__PURE__ */ __name((size = 16, alphabet = ALPHABET.ALPHA_DIGIT) => {
      let str = "";
      const {
        length
      } = alphabet;
      const randomValues = new Uint32Array(size);
      crypto.randomFillSync(randomValues);
      for (let i = 0; i < size; i++) {
        str += alphabet[randomValues[i] % length];
      }
      return str;
    }, "generateString");
    var platform$1 = {
      isNode: true,
      classes: {
        URLSearchParams,
        FormData: FormData$1,
        Blob: typeof Blob !== "undefined" && Blob || null
      },
      ALPHABET,
      generateString,
      protocols: ["http", "https", "file", "data"]
    };
    var hasBrowserEnv = typeof window !== "undefined" && typeof document !== "undefined";
    var _navigator = typeof navigator === "object" && navigator || void 0;
    var hasStandardBrowserEnv = hasBrowserEnv && (!_navigator || ["ReactNative", "NativeScript", "NS"].indexOf(_navigator.product) < 0);
    var hasStandardBrowserWebWorkerEnv = (() => {
      return typeof WorkerGlobalScope !== "undefined" && // eslint-disable-next-line no-undef
      self instanceof WorkerGlobalScope && typeof self.importScripts === "function";
    })();
    var origin = hasBrowserEnv && window.location.href || "http://localhost";
    var utils = /* @__PURE__ */ Object.freeze({
      __proto__: null,
      hasBrowserEnv,
      hasStandardBrowserEnv,
      hasStandardBrowserWebWorkerEnv,
      navigator: _navigator,
      origin
    });
    var platform = {
      ...utils,
      ...platform$1
    };
    function toURLEncodedForm(data, options) {
      return toFormData(data, new platform.classes.URLSearchParams(), {
        visitor: /* @__PURE__ */ __name(function(value, key, path2, helpers) {
          if (platform.isNode && utils$1.isBuffer(value)) {
            this.append(key, value.toString("base64"));
            return false;
          }
          return helpers.defaultVisitor.apply(this, arguments);
        }, "visitor"),
        ...options
      });
    }
    __name(toURLEncodedForm, "toURLEncodedForm");
    var MAX_DEPTH = DEFAULT_FORM_DATA_MAX_DEPTH;
    function throwIfDepthExceeded(index) {
      if (index > MAX_DEPTH) {
        throw new AxiosError("FormData field is too deeply nested (" + index + " levels). Max depth: " + MAX_DEPTH, AxiosError.ERR_FORM_DATA_DEPTH_EXCEEDED);
      }
    }
    __name(throwIfDepthExceeded, "throwIfDepthExceeded");
    function parsePropPath(name) {
      const path2 = [];
      const pattern = /[^.[\]]+|\[([^.[\]]*)]/g;
      let match;
      while ((match = pattern.exec(name)) !== null) {
        throwIfDepthExceeded(path2.length);
        path2.push(match[0] === "[]" ? "" : match[1] || match[0]);
      }
      return path2;
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
      function buildPath(path2, value, target, index) {
        throwIfDepthExceeded(index);
        let name = path2[index++];
        if (name === "__proto__") return true;
        const isNumericKey = Number.isFinite(+name);
        const isLast = index >= path2.length;
        name = !name && utils$1.isArray(target) ? target.length : name;
        if (isLast) {
          if (utils$1.hasOwnProp(target, name)) {
            target[name] = utils$1.isArray(target[name]) ? target[name].concat(value) : [target[name], value];
          } else {
            target[name] = value;
          }
          return !isNumericKey;
        }
        if (!utils$1.hasOwnProp(target, name) || !utils$1.isObject(target[name])) {
          target[name] = [];
        }
        const result = buildPath(path2, value, target[name], index);
        if (result && utils$1.isArray(target[name])) {
          target[name] = arrayToObject(target[name]);
        }
        return !isNumericKey;
      }
      __name(buildPath, "buildPath");
      if (utils$1.isFormData(formData) && utils$1.isFunction(formData.entries)) {
        const obj = {};
        utils$1.forEachEntry(formData, (name, value) => {
          buildPath(parsePropPath(name), value, obj, 0);
        });
        return obj;
      }
      return null;
    }
    __name(formDataToJSON, "formDataToJSON");
    var own = /* @__PURE__ */ __name((obj, key) => obj != null && utils$1.hasOwnProp(obj, key) ? obj[key] : void 0, "own");
    function stringifySafely(rawValue, parser, encoder) {
      if (utils$1.isString(rawValue)) {
        try {
          (parser || JSON.parse)(rawValue);
          return utils$1.trim(rawValue);
        } catch (e) {
          if (e.name !== "SyntaxError") {
            throw e;
          }
        }
      }
      return (encoder || JSON.stringify)(rawValue);
    }
    __name(stringifySafely, "stringifySafely");
    var defaults = {
      transitional: transitionalDefaults,
      adapter: ["xhr", "http", "fetch"],
      transformRequest: [/* @__PURE__ */ __name(function transformRequest(data, headers) {
        const contentType = headers.getContentType() || "";
        const hasJSONContentType = contentType.indexOf("application/json") > -1;
        const isObjectPayload = utils$1.isObject(data);
        if (isObjectPayload && utils$1.isHTMLForm(data)) {
          data = new FormData(data);
        }
        const isFormData2 = utils$1.isFormData(data);
        if (isFormData2) {
          return hasJSONContentType ? JSON.stringify(formDataToJSON(data)) : data;
        }
        if (utils$1.isArrayBuffer(data) || utils$1.isBuffer(data) || utils$1.isStream(data) || utils$1.isFile(data) || utils$1.isBlob(data) || utils$1.isReadableStream(data)) {
          return data;
        }
        if (utils$1.isArrayBufferView(data)) {
          return data.buffer;
        }
        if (utils$1.isURLSearchParams(data)) {
          headers.setContentType("application/x-www-form-urlencoded;charset=utf-8", false);
          return data.toString();
        }
        let isFileList2;
        if (isObjectPayload) {
          const formSerializer = own(this, "formSerializer");
          if (contentType.indexOf("application/x-www-form-urlencoded") > -1) {
            return toURLEncodedForm(data, formSerializer).toString();
          }
          if ((isFileList2 = utils$1.isFileList(data)) || contentType.indexOf("multipart/form-data") > -1) {
            const env = own(this, "env");
            const _FormData = env && env.FormData;
            return toFormData(isFileList2 ? {
              "files[]": data
            } : data, _FormData && new _FormData(), formSerializer);
          }
        }
        if (isObjectPayload || hasJSONContentType) {
          headers.setContentType("application/json", false);
          return stringifySafely(data);
        }
        return data;
      }, "transformRequest")],
      transformResponse: [/* @__PURE__ */ __name(function transformResponse(data) {
        const transitional = own(this, "transitional") || defaults.transitional;
        const forcedJSONParsing = transitional && transitional.forcedJSONParsing;
        const responseType = own(this, "responseType");
        const JSONRequested = responseType === "json";
        if (utils$1.isResponse(data) || utils$1.isReadableStream(data)) {
          return data;
        }
        if (data && utils$1.isString(data) && (forcedJSONParsing && !responseType || JSONRequested)) {
          const silentJSONParsing = transitional && transitional.silentJSONParsing;
          const strictJSONParsing = !silentJSONParsing && JSONRequested;
          try {
            return JSON.parse(data, own(this, "parseReviver"));
          } catch (e) {
            if (strictJSONParsing) {
              if (e.name === "SyntaxError") {
                throw AxiosError.from(e, AxiosError.ERR_BAD_RESPONSE, this, null, own(this, "response"));
              }
              throw e;
            }
          }
        }
        return data;
      }, "transformResponse")],
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
        FormData: platform.classes.FormData,
        Blob: platform.classes.Blob
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
    utils$1.forEach(["delete", "get", "head", "post", "put", "patch", "query"], (method) => {
      defaults.headers[method] = {};
    });
    function transformData(fns, response) {
      const config = this || defaults;
      const context = response || config;
      const headers = AxiosHeaders.from(context.headers);
      let data = context.data;
      utils$1.forEach(fns, /* @__PURE__ */ __name(function transform(fn) {
        data = fn.call(config, data, headers.normalize(), response ? response.status : void 0);
      }, "transform"));
      headers.normalize();
      return data;
    }
    __name(transformData, "transformData");
    function isCancel(value) {
      return !!(value && value.__CANCEL__);
    }
    __name(isCancel, "isCancel");
    var CanceledError = class extends AxiosError {
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
        super(message == null ? "canceled" : message, AxiosError.ERR_CANCELED, config, request);
        this.name = "CanceledError";
        this.__CANCEL__ = true;
      }
    };
    function settle(resolve, reject, response) {
      const validateStatus = response.config.validateStatus;
      if (!response.status || !validateStatus || validateStatus(response.status)) {
        resolve(response);
      } else {
        reject(new AxiosError("Request failed with status code " + response.status, response.status >= 400 && response.status < 500 ? AxiosError.ERR_BAD_REQUEST : AxiosError.ERR_BAD_RESPONSE, response.config, response.request, response));
      }
    }
    __name(settle, "settle");
    function isAbsoluteURL(url2) {
      if (typeof url2 !== "string") {
        return false;
      }
      return /^([a-z][a-z\d+\-.]*:)?\/\//i.test(url2);
    }
    __name(isAbsoluteURL, "isAbsoluteURL");
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
      const redactedURLWithoutFragment = urlWithoutFragment.replace(/([?&][^=&#]*=)[^&#]*/g, `$1${REDACTED}`);
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
          throw new AxiosError(`Invalid URL ${JSON.stringify(redactSensitiveURLParts(normalizedURL))}: missing "//" after protocol`, AxiosError.ERR_INVALID_URL, config);
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
    var DEFAULT_PORTS$1 = {
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
      port = parseInt(port) || DEFAULT_PORTS$1[proto] || 0;
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
    var VERSION = "1.19.0";
    function parseProtocol(url2) {
      const match = /^([-+\w]{1,25}):(?:\/\/)?/.exec(url2);
      return match && match[1] || "";
    }
    __name(parseProtocol, "parseProtocol");
    var DATA_URL_PATTERN = /^([^,;]+\/[^,;]+)?((?:;[^,;=]+=[^,;]+)*)(;base64)?,([\s\S]*)$/;
    function fromDataURI(uri, asBlob, options) {
      const _Blob = options && options.Blob || platform.classes.Blob;
      const protocol = parseProtocol(uri);
      if (asBlob === void 0 && _Blob) {
        asBlob = true;
      }
      if (protocol === "data") {
        uri = protocol.length ? uri.slice(protocol.length + 1) : uri;
        const match = DATA_URL_PATTERN.exec(uri);
        if (!match) {
          throw new AxiosError("Invalid URL", AxiosError.ERR_INVALID_URL);
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
            throw new AxiosError("Blob is not supported", AxiosError.ERR_NOT_SUPPORT);
          }
          return new _Blob([buffer], {
            type: mime
          });
        }
        return buffer;
      }
      throw new AxiosError("Unsupported protocol " + protocol, AxiosError.ERR_NOT_SUPPORT);
    }
    __name(fromDataURI, "fromDataURI");
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
    var kInternals = Symbol("internals");
    var AxiosTransformStream = class extends stream.Transform {
      static {
        __name(this, "AxiosTransformStream");
      }
      constructor(options) {
        options = utils$1.toFlatObject(options, {
          maxRate: 0,
          chunkSize: 64 * 1024,
          minChunkSize: 100,
          timeWindow: 500,
          ticksRate: 2,
          samplesCount: 15
        }, null, (prop, source) => {
          return !utils$1.isUndefined(source[prop]);
        });
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
          pushChunk(_chunk, chunkRemainder ? () => {
            process.nextTick(_callback, null, chunkRemainder);
          } : _callback);
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
    var {
      asyncIterator
    } = Symbol;
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
    var BOUNDARY_ALPHABET = platform.ALPHABET.ALPHA_DIGIT + "-_";
    var textEncoder = typeof TextEncoder === "function" ? new TextEncoder() : new util.TextEncoder();
    var CRLF = "\r\n";
    var CRLF_BYTES = textEncoder.encode(CRLF);
    var CRLF_BYTES_COUNT = 2;
    var FormDataPart = class {
      static {
        __name(this, "FormDataPart");
      }
      constructor(name, value) {
        const {
          escapeName
        } = this.constructor;
        const isStringValue = utils$1.isString(value);
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
        const {
          value
        } = this;
        if (utils$1.isTypedArray(value)) {
          yield value;
        } else {
          yield* readBlob(value);
        }
        yield CRLF_BYTES;
      }
      static escapeName(name) {
        return String(name).replace(/[\r\n"]/g, (match) => ({
          "\r": "%0D",
          "\n": "%0A",
          '"': "%22"
        })[match]);
      }
    };
    var formDataToStream = /* @__PURE__ */ __name((form, headersHandler, options) => {
      const {
        tag = "form-data-boundary",
        size = 25,
        boundary = tag + "-" + platform.generateString(size, BOUNDARY_ALPHABET)
      } = options || {};
      if (!utils$1.isFormData(form)) {
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
      contentLength = utils$1.toFiniteNumber(contentLength);
      const computedHeaders = {
        "Content-Type": `multipart/form-data; boundary=${boundary}`
      };
      if (Number.isFinite(contentLength)) {
        computedHeaders["Content-Length"] = contentLength;
      }
      headersHandler && headersHandler(computedHeaders);
      return stream.Readable.from(async function* () {
        for (const part of parts) {
          yield boundaryBytes;
          yield* part.encode();
        }
        yield footerBytes;
      }());
    }, "formDataToStream");
    var ZlibHeaderTransformStream = class extends stream.Transform {
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
    var Http2Sessions = class {
      static {
        __name(this, "Http2Sessions");
      }
      constructor() {
        this.sessions = /* @__PURE__ */ Object.create(null);
      }
      getSession(authority, options) {
        options = Object.assign({
          sessionTimeout: 1e3
        }, options);
        let authoritySessions = this.sessions[authority];
        if (authoritySessions) {
          let len = authoritySessions.length;
          for (let i = 0; i < len; i++) {
            const [sessionHandle, sessionOptions] = authoritySessions[i];
            if (!sessionHandle.destroyed && !sessionHandle.closed && util.isDeepStrictEqual(sessionOptions, options)) {
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
        const {
          sessionTimeout
        } = options;
        if (sessionTimeout != null) {
          let streamsCount = 0;
          session.request = function() {
            const stream2 = originalRequestFn.apply(this, arguments);
            streamsCount++;
            if (timer) {
              clearTimeout(timer);
              timer = null;
            }
            stream2.once("close", () => {
              if (!--streamsCount) {
                timer = setTimeout(() => {
                  timer = null;
                  removeSession();
                }, sessionTimeout);
              }
            });
            return stream2;
          };
        }
        session.once("close", removeSession);
        let entry = [session, options];
        authoritySessions ? authoritySessions.push(entry) : authoritySessions = this.sessions[authority] = [entry];
        return session;
      }
    };
    var callbackify = /* @__PURE__ */ __name((fn, reducer) => {
      return utils$1.isAsyncFn(fn) ? function(...args) {
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
    var DEFAULT_PORTS = {
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
      const port = Number.parseInt(parsed.port, 10) || DEFAULT_PORTS[parsed.protocol.split(":", 1)[0]] || 0;
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
    var progressEventReducer = /* @__PURE__ */ __name((listener, isDownloadStream, freq = 3) => {
      let bytesNotified = 0;
      const _speedometer = speedometer(50, 250);
      return throttle((e) => {
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
      return [(loaded) => throttled[0]({
        lengthComputable,
        total,
        loaded
      }), throttled[1]];
    }, "progressEventDecorator");
    var asyncDecorator = /* @__PURE__ */ __name((fn, scheduler = utils$1.asap) => (...args) => scheduler(() => fn(...args)), "asyncDecorator");
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
      return estimateDataURLBytes(fragmentIndex === -1 ? url2 : url2.slice(0, fragmentIndex), estimatePercentDecodedBase64Bytes);
    }
    __name(estimateDataURLDecodedBytes, "estimateDataURLDecodedBytes");
    function estimateDataURLBufferAllocation(url2) {
      return estimateDataURLBytes(url2, estimateBase64BufferAllocation);
    }
    __name(estimateDataURLBufferAllocation, "estimateDataURLBufferAllocation");
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
    var isBrotliSupported = utils$1.isFunction(zlib.createBrotliDecompress);
    var isZstdSupported = utils$1.isFunction(zlib.createZstdDecompress);
    var ACCEPT_ENCODING = "gzip, compress, deflate" + (isBrotliSupported ? ", br" : "");
    var ACCEPT_ENCODING_WITH_ZSTD = ACCEPT_ENCODING + (isZstdSupported ? ", zstd" : "");
    var scheduleProgress = typeof process !== "undefined" && process.nextTick ? process.nextTick.bind(process) : utils$1.asap;
    var {
      http: httpFollow,
      https: httpsFollow
    } = followRedirects;
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
      return Boolean(agentOptions && utils$1.hasOwnProp(agentOptions, "proxyEnv") && agentOptions.proxyEnv != null);
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
      const merged = userHttpsAgent && userHttpsAgent.options ? {
        ...userHttpsAgent.options,
        ...agentOptions
      } : agentOptions;
      agent = new HttpsProxyAgent(merged);
      if (userHttpsAgent && userHttpsAgent.options) {
        const originTLSOptions = {
          ...userHttpsAgent.options
        };
        const callback = agent.callback;
        agent.callback = /* @__PURE__ */ __name(function axiosTunnelingAgentCallback(req, opts) {
          return callback.call(this, req, {
            ...originTLSOptions,
            ...opts
          });
        }, "axiosTunnelingAgentCallback");
      }
      agent[kAxiosInstalledTunnel] = true;
      cache.set(key, agent);
      return agent;
    }
    __name(getTunnelingAgent, "getTunnelingAgent");
    var supportedProtocols = platform.protocols.map((protocol) => {
      return protocol + ":";
    });
    var decodeURIComponentSafe$1 = /* @__PURE__ */ __name((value) => {
      if (!utils$1.isString(value)) {
        return value;
      }
      try {
        return decodeURIComponent(value);
      } catch (error) {
        return value;
      }
    }, "decodeURIComponentSafe$1");
    var flushOnFinish = /* @__PURE__ */ __name((stream2, [throttled, flush]) => {
      stream2.on("end", flush).on("error", flush);
      return throttled;
    }, "flushOnFinish");
    var http2Sessions = new Http2Sessions();
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
        const readProxyField = /* @__PURE__ */ __name((key) => isProxyURL || utils$1.hasOwnProp(proxy, key) ? proxy[key] : void 0, "readProxyField");
        const proxyUsername = readProxyField("username");
        const proxyPassword = readProxyField("password");
        let proxyAuth = utils$1.hasOwnProp(proxy, "auth") ? proxy.auth : void 0;
        if (proxyUsername) {
          proxyAuth = (proxyUsername || "") + ":" + (proxyPassword || "");
        }
        if (proxyAuth) {
          const authIsObject = typeof proxyAuth === "object";
          const authUsername = authIsObject && utils$1.hasOwnProp(proxyAuth, "username") ? proxyAuth.username : void 0;
          const authPassword = authIsObject && utils$1.hasOwnProp(proxyAuth, "password") ? proxyAuth.password : void 0;
          const validProxyAuth = Boolean(authUsername || authPassword);
          if (validProxyAuth) {
            proxyAuth = (authUsername || "") + ":" + (authPassword || "");
          } else if (authIsObject) {
            throw new AxiosError("Invalid proxy authorization", AxiosError.ERR_BAD_OPTION, {
              proxy
            });
          }
        }
        const targetIsHttps = isHttps.test(options.protocol);
        if (targetIsHttps) {
          if (!(configHttpsAgent instanceof HttpsProxyAgent)) {
            const proxyHost = readProxyField("hostname") || readProxyField("host");
            const proxyPort = readProxyField("port");
            const rawProxyProtocol = readProxyField("protocol");
            const normalizedProtocol = rawProxyProtocol ? rawProxyProtocol.includes(":") ? rawProxyProtocol : `${rawProxyProtocol}:` : "http:";
            const proxyHostForURL = proxyHost && proxyHost.includes(":") && !proxyHost.startsWith("[") ? `[${proxyHost}]` : proxyHost;
            const proxyURL = new URL(`${normalizedProtocol}//${proxyHostForURL}${proxyPort ? ":" + proxyPort : ""}`);
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
        setProxy(redirectOptions, configProxy, redirectOptions.href, true, configHttpsAgent, configHttpAgent);
      }, "beforeRedirect");
    }
    __name(setProxy, "setProxy");
    var isHttpAdapterSupported = typeof process !== "undefined" && utils$1.kindOf(process) === "process";
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
    var resolveFamily = /* @__PURE__ */ __name(({
      address,
      family
    }) => {
      if (!utils$1.isString(address)) {
        throw TypeError("address must be a string");
      }
      return {
        address,
        family: family || (address.indexOf(".") < 0 ? 6 : 4)
      };
    }, "resolveFamily");
    var buildAddressEntry = /* @__PURE__ */ __name((address, family) => resolveFamily(utils$1.isObject(address) ? address : {
      address,
      family
    }), "buildAddressEntry");
    var http2Transport = {
      request(options, cb) {
        const authority = options.protocol + "//" + options.hostname + ":" + (options.port || (options.protocol === "https:" ? 443 : 80));
        const {
          http2Options,
          headers
        } = options;
        const session = http2Sessions.getSession(authority, http2Options);
        const {
          HTTP2_HEADER_SCHEME,
          HTTP2_HEADER_METHOD,
          HTTP2_HEADER_PATH,
          HTTP2_HEADER_STATUS
        } = http2.constants;
        const http2Headers = {
          [HTTP2_HEADER_SCHEME]: options.protocol.replace(":", ""),
          [HTTP2_HEADER_METHOD]: options.method,
          [HTTP2_HEADER_PATH]: options.path
        };
        utils$1.forEach(headers, (header, name) => {
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
    var httpAdapter = isHttpAdapterSupported && /* @__PURE__ */ __name(function httpAdapter2(config) {
      return wrapAsync(/* @__PURE__ */ __name(async function dispatchHttpRequest(resolve, reject, onDone) {
        const own2 = /* @__PURE__ */ __name((key) => utils$1.getSafeProp(config, key), "own");
        const transitional = own2("transitional") || transitionalDefaults;
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
          const _lookup = callbackify(lookup, (value) => utils$1.isArray(value) ? value : [value]);
          lookup = /* @__PURE__ */ __name((hostname, opt, cb) => {
            _lookup(hostname, opt, (err, arg0, arg1) => {
              if (err) {
                return cb(err);
              }
              const addresses = utils$1.isArray(arg0) ? arg0.map((addr) => buildAddressEntry(addr)) : [buildAddressEntry(arg0, arg1)];
              opt.all ? cb(err, addresses) : cb(err, addresses[0].address, addresses[0].family);
            });
          }, "lookup");
        }
        const abortEmitter = new events.EventEmitter();
        function abort(reason) {
          try {
            abortEmitter.emit("abort", !reason || reason.type ? new CanceledError(null, config, req) : reason);
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
          return new AxiosError(timeoutErrorMessage, transitional.clarifyTimeoutError ? AxiosError.ETIMEDOUT : AxiosError.ECONNABORTED, config, req);
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
          const {
            data: data2
          } = response;
          if (data2 instanceof stream.Readable || data2 instanceof stream.Duplex) {
            const offListeners = stream.finished(data2, () => {
              offListeners();
              onFinished();
            });
          } else {
            onFinished();
          }
        });
        const fullPath = buildFullPath(own2("baseURL"), own2("url"), own2("allowAbsoluteUrls"), config);
        const urlBase = socketPath ? "http://localhost" : platform.hasBrowserEnv ? platform.origin : void 0;
        const parsed = new URL(fullPath, urlBase);
        const protocol = parsed.protocol || supportedProtocols[0];
        if (protocol === "data:") {
          if (maxContentLength > -1) {
            const dataUrl = String(own2("url") || fullPath || "");
            const estimated = estimateDataURLBufferAllocation(dataUrl);
            if (estimated > maxContentLength) {
              return reject(new AxiosError("maxContentLength size of " + maxContentLength + " exceeded", AxiosError.ERR_BAD_RESPONSE, config));
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
            throw AxiosError.from(err, AxiosError.ERR_BAD_REQUEST, config);
          }
          if (responseType === "text") {
            convertedData = convertedData.toString(responseEncoding);
            if (!responseEncoding || responseEncoding === "utf8") {
              convertedData = utils$1.stripBOM(convertedData);
            }
          } else if (responseType === "stream") {
            convertedData = stream.Readable.from(convertedData);
          }
          return settle(resolve, reject, {
            data: convertedData,
            status: 200,
            statusText: "OK",
            headers: new AxiosHeaders(),
            config
          });
        }
        if (supportedProtocols.indexOf(protocol) === -1) {
          return reject(new AxiosError("Unsupported protocol " + protocol, AxiosError.ERR_BAD_REQUEST, config));
        }
        const headers = AxiosHeaders.from(config.headers).normalize();
        headers.set("User-Agent", "axios/" + VERSION, false);
        const {
          onUploadProgress,
          onDownloadProgress
        } = config;
        const maxRate = config.maxRate;
        let maxUploadRate = void 0;
        let maxDownloadRate = void 0;
        if (utils$1.isSpecCompliantForm(data)) {
          const userBoundary = headers.getContentType(/boundary=([-_\w\d]{10,70})/i);
          data = formDataToStream(data, (formHeaders) => {
            headers.set(formHeaders);
          }, {
            tag: `axios-${VERSION}-boundary`,
            boundary: userBoundary && userBoundary[1] || void 0
          });
        } else if (utils$1.isFormData(data) && utils$1.isFunction(data.getHeaders) && data.getHeaders !== Object.prototype.getHeaders) {
          setFormDataHeaders(headers, data.getHeaders(), own2("formDataHeaderPolicy"));
          if (!headers.hasContentLength()) {
            try {
              const knownLength = await util.promisify(data.getLength).call(data);
              Number.isFinite(knownLength) && knownLength >= 0 && headers.setContentLength(knownLength);
            } catch (e) {
            }
          }
        } else if (utils$1.isBlob(data) || utils$1.isFile(data)) {
          data.size && headers.setContentType(data.type || "application/octet-stream");
          headers.setContentLength(data.size || 0);
          data = stream.Readable.from(readBlob(data));
        } else if (data && !utils$1.isStream(data)) {
          if (Buffer.isBuffer(data)) ;
          else if (utils$1.isArrayBuffer(data)) {
            data = Buffer.from(new Uint8Array(data));
          } else if (utils$1.isString(data)) {
            data = Buffer.from(data, "utf-8");
          } else {
            return reject(new AxiosError("Data after transformation must be a string, an ArrayBuffer, a Buffer, or a Stream", AxiosError.ERR_BAD_REQUEST, config));
          }
          headers.setContentLength(data.length, false);
          if (maxBodyLength > -1 && data.length > maxBodyLength) {
            return reject(new AxiosError("Request body larger than maxBodyLength limit", AxiosError.ERR_BAD_REQUEST, config));
          }
        }
        const contentLength = utils$1.toFiniteNumber(headers.getContentLength());
        if (utils$1.isArray(maxRate)) {
          maxUploadRate = maxRate[0];
          maxDownloadRate = maxRate[1];
        } else {
          maxUploadRate = maxDownloadRate = maxRate;
        }
        if (data && (onUploadProgress || maxUploadRate)) {
          if (!utils$1.isStream(data)) {
            data = stream.Readable.from(data, {
              objectMode: false
            });
          }
          data = stream.pipeline([data, new AxiosTransformStream({
            maxRate: utils$1.toFiniteNumber(maxUploadRate)
          })], utils$1.noop);
          onUploadProgress && data.on("progress", flushOnFinish(data, progressEventDecorator(contentLength, progressEventReducer(asyncDecorator(onUploadProgress, scheduleProgress), false, 3))));
        }
        let auth = void 0;
        const configAuth = own2("auth");
        if (configAuth) {
          const username = utils$1.getSafeProp(configAuth, "username") || "";
          const password = utils$1.getSafeProp(configAuth, "password") || "";
          auth = username + ":" + password;
        }
        if (!auth && (parsed.username || parsed.password)) {
          const urlUsername = decodeURIComponentSafe$1(parsed.username);
          const urlPassword = decodeURIComponentSafe$1(parsed.password);
          auth = urlUsername + ":" + urlPassword;
        }
        auth && headers.delete("authorization");
        let path$1;
        try {
          path$1 = buildURL(parsed.pathname + parsed.search, own2("params"), own2("paramsSerializer")).replace(/^\?/, "");
        } catch (err) {
          return reject(AxiosError.from(err, AxiosError.ERR_BAD_REQUEST, config, null, null, {
            url: own2("url"),
            exists: true
          }));
        }
        headers.set("Accept-Encoding", utils$1.hasOwnProp(transitional, "advertiseZstdAcceptEncoding") && transitional.advertiseZstdAcceptEncoding === true ? ACCEPT_ENCODING_WITH_ZSTD : ACCEPT_ENCODING, false);
        const options = Object.assign(/* @__PURE__ */ Object.create(null), {
          path: path$1,
          method,
          headers: toByteStringHeaderObject(headers),
          agents: {
            http: httpAgent,
            https: httpsAgent
          },
          auth,
          protocol,
          family,
          beforeRedirect: dispatchBeforeRedirect,
          beforeRedirects: /* @__PURE__ */ Object.create(null),
          http2Options
        });
        !utils$1.isUndefined(lookup) && (options.lookup = lookup);
        if (socketPath) {
          if (typeof socketPath !== "string") {
            return reject(new AxiosError("socketPath must be a string", AxiosError.ERR_BAD_OPTION_VALUE, config));
          }
          const allowedSocketPaths = own2("allowedSocketPaths");
          if (allowedSocketPaths != null) {
            const allowed = Array.isArray(allowedSocketPaths) ? allowedSocketPaths : [allowedSocketPaths];
            const resolvedSocket = path.resolve(socketPath);
            const isAllowed = allowed.some((entry) => typeof entry === "string" && path.resolve(entry) === resolvedSocket);
            if (!isAllowed) {
              return reject(new AxiosError(`socketPath "${socketPath}" is not permitted by allowedSocketPaths`, AxiosError.ERR_BAD_OPTION_VALUE, config));
            }
          }
          options.socketPath = socketPath;
        } else {
          options.hostname = parsed.hostname.startsWith("[") ? parsed.hostname.slice(1, -1) : parsed.hostname;
          options.port = parsed.port;
          setProxy(options, configProxy, protocol + "//" + parsed.hostname + (parsed.port ? ":" + parsed.port : "") + options.path, false, httpsAgent, httpAgent);
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
              if (!utils$1.isArray(sensitiveHeaders)) {
                return reject(new AxiosError("sensitiveHeaders must be an array of strings", AxiosError.ERR_BAD_OPTION_VALUE, config));
              }
              const sensitiveSet = /* @__PURE__ */ new Set();
              for (const header of sensitiveHeaders) {
                if (!utils$1.isString(header)) {
                  return reject(new AxiosError("sensitiveHeaders must be an array of strings", AxiosError.ERR_BAD_OPTION_VALUE, config));
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
          const responseLength = utils$1.toFiniteNumber(res.headers["content-length"]);
          if (onDownloadProgress || maxDownloadRate) {
            const transformStream = new AxiosTransformStream({
              maxRate: utils$1.toFiniteNumber(maxDownloadRate)
            });
            onDownloadProgress && transformStream.on("progress", flushOnFinish(transformStream, progressEventDecorator(responseLength, progressEventReducer(asyncDecorator(onDownloadProgress, scheduleProgress), true, 3))));
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
                streams.push(new ZlibHeaderTransformStream());
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
          responseStream = streams.length > 1 ? stream.pipeline(streams, utils$1.noop) : streams[0];
          const response = {
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: new AxiosHeaders(res.headers),
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
                    throw new AxiosError("maxContentLength size of " + limit + " exceeded", AxiosError.ERR_BAD_RESPONSE, config, lastRequest);
                  }
                  yield chunk;
                }
              }
              __name(enforceMaxContentLength, "enforceMaxContentLength");
              responseStream = stream.Readable.from(enforceMaxContentLength(), {
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
                abort(new AxiosError("maxContentLength size of " + maxContentLength + " exceeded", AxiosError.ERR_BAD_RESPONSE, config, lastRequest));
              }
            }, "handleStreamData"));
            responseStream.on("aborted", /* @__PURE__ */ __name(function handlerStreamAborted() {
              if (rejected) {
                return;
              }
              const err = new AxiosError("stream has been aborted", AxiosError.ERR_BAD_RESPONSE, config, lastRequest, response);
              responseStream.destroy(err);
              reject(err);
            }, "handlerStreamAborted"));
            responseStream.on("error", /* @__PURE__ */ __name(function handleStreamError(err) {
              if (rejected) return;
              reject(AxiosError.from(err, null, config, lastRequest, response));
            }, "handleStreamError"));
            responseStream.on("end", /* @__PURE__ */ __name(function handleStreamEnd() {
              try {
                let responseData = responseBuffer.length === 1 ? responseBuffer[0] : Buffer.concat(responseBuffer);
                if (responseType !== "arraybuffer") {
                  responseData = responseData.toString(responseEncoding);
                  if (!responseEncoding || responseEncoding === "utf8") {
                    responseData = utils$1.stripBOM(responseData);
                  }
                }
                response.data = responseData;
              } catch (err) {
                return reject(AxiosError.from(err, null, config, response.request, response));
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
          reject(AxiosError.from(err, null, config, req));
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
            abort(new AxiosError("error trying to parse `config.timeout` to int", AxiosError.ERR_BAD_OPTION_VALUE, config, req));
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
        if (utils$1.isStream(data)) {
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
              abort(new CanceledError("Request stream has been aborted", config, req));
            }
          });
          let uploadStream = data;
          if (maxBodyLength > -1 && !transportEnforcesMaxBodyLength) {
            const limit = maxBodyLength;
            let bytesSent = 0;
            uploadStream = stream.pipeline([data, new stream.Transform({
              transform(chunk, _enc, cb) {
                bytesSent += chunk.length;
                if (bytesSent > limit) {
                  return cb(new AxiosError("Request body larger than maxBodyLength limit", AxiosError.ERR_BAD_REQUEST, config, req));
                }
                cb(null, chunk);
              }
            })], utils$1.noop);
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
    var isURLSameOrigin = platform.hasStandardBrowserEnv ? /* @__PURE__ */ ((origin2, isMSIE) => (url2) => {
      url2 = new URL(url2, platform.origin);
      return origin2.protocol === url2.protocol && origin2.host === url2.host && (isMSIE || origin2.port === url2.port);
    })(new URL(platform.origin), platform.navigator && /(msie|trident)/i.test(platform.navigator.userAgent)) : () => true;
    var cookies = platform.hasStandardBrowserEnv ? (
      // Standard browser envs support document.cookie
      {
        write(name, value, expires, path2, domain, secure, sameSite) {
          if (typeof document === "undefined") return;
          const cookie = [`${name}=${encodeURIComponent(value)}`];
          if (utils$1.isNumber(expires)) {
            cookie.push(`expires=${new Date(expires).toUTCString()}`);
          }
          if (utils$1.isString(path2)) {
            cookie.push(`path=${path2}`);
          }
          if (utils$1.isString(domain)) {
            cookie.push(`domain=${domain}`);
          }
          if (secure === true) {
            cookie.push("secure");
          }
          if (utils$1.isString(sameSite)) {
            cookie.push(`SameSite=${sameSite}`);
          }
          document.cookie = cookie.join("; ");
        },
        read(name) {
          if (typeof document === "undefined") return null;
          const cookies2 = document.cookie.split(";");
          for (let i = 0; i < cookies2.length; i++) {
            const cookie = cookies2[i].replace(/^\s+/, "");
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
    var headersToObject = /* @__PURE__ */ __name((thing) => thing instanceof AxiosHeaders ? {
      ...thing
    } : thing, "headersToObject");
    var ownEnumerableKeys = /* @__PURE__ */ __name((thing) => {
      if (Object.getOwnPropertySymbols && Object.getOwnPropertyDescriptor) {
        return Object.keys(thing).concat(Object.getOwnPropertySymbols(thing).filter((symbol) => Object.getOwnPropertyDescriptor(thing, symbol).enumerable));
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
        if (utils$1.isPlainObject(target) && utils$1.isPlainObject(source)) {
          return utils$1.merge.call({
            caseless
          }, target, source);
        } else if (utils$1.isPlainObject(source)) {
          return utils$1.merge({}, source);
        } else if (utils$1.isArray(source)) {
          return source.slice();
        }
        return source;
      }
      __name(getMergedValue, "getMergedValue");
      function mergeDeepProperties(a, b, prop, caseless) {
        if (!utils$1.isUndefined(b)) {
          return getMergedValue(a, b, prop, caseless);
        } else if (!utils$1.isUndefined(a)) {
          return getMergedValue(void 0, a, prop, caseless);
        }
      }
      __name(mergeDeepProperties, "mergeDeepProperties");
      function valueFromConfig2(a, b) {
        if (!utils$1.isUndefined(b)) {
          return getMergedValue(void 0, b);
        }
      }
      __name(valueFromConfig2, "valueFromConfig2");
      function defaultToConfig2(a, b) {
        if (!utils$1.isUndefined(b)) {
          return getMergedValue(void 0, b);
        } else if (!utils$1.isUndefined(a)) {
          return getMergedValue(void 0, a);
        }
      }
      __name(defaultToConfig2, "defaultToConfig2");
      function getMergedTransitionalOption(prop) {
        const transitional2 = utils$1.hasOwnProp(config2, "transitional") ? config2.transitional : void 0;
        if (!utils$1.isUndefined(transitional2)) {
          if (utils$1.isPlainObject(transitional2)) {
            if (utils$1.hasOwnProp(transitional2, prop)) {
              return transitional2[prop];
            }
          } else {
            return void 0;
          }
        }
        const transitional1 = utils$1.hasOwnProp(config1, "transitional") ? config1.transitional : void 0;
        if (utils$1.isPlainObject(transitional1) && utils$1.hasOwnProp(transitional1, prop)) {
          return transitional1[prop];
        }
        return void 0;
      }
      __name(getMergedTransitionalOption, "getMergedTransitionalOption");
      function mergeDirectKeys(a, b, prop) {
        if (utils$1.hasOwnProp(config2, prop)) {
          return getMergedValue(a, b);
        } else if (utils$1.hasOwnProp(config1, prop)) {
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
      utils$1.forEach(ownEnumerableKeys({
        ...config1,
        ...config2
      }), /* @__PURE__ */ __name(function computeConfigValue(prop) {
        if (prop === "__proto__" || prop === "constructor" || prop === "prototype") return;
        const merge2 = utils$1.hasOwnProp(mergeMap, prop) ? mergeMap[prop] : mergeDeepProperties;
        const a = utils$1.hasOwnProp(config1, prop) ? config1[prop] : void 0;
        const b = utils$1.hasOwnProp(config2, prop) ? config2[prop] : void 0;
        const configValue = merge2(a, b, prop);
        utils$1.isUndefined(configValue) && merge2 !== mergeDirectKeys || (config[prop] = configValue);
      }, "computeConfigValue"));
      if (utils$1.hasOwnProp(config2, "validateStatus") && utils$1.isUndefined(config2.validateStatus) && getMergedTransitionalOption("validateStatusUndefinedResolves") === false) {
        if (utils$1.hasOwnProp(config1, "validateStatus")) {
          config.validateStatus = getMergedValue(void 0, config1.validateStatus);
        } else {
          delete config.validateStatus;
        }
      }
      return config;
    }
    __name(mergeConfig, "mergeConfig");
    var encodeUTF8$1 = /* @__PURE__ */ __name((str) => encodeURIComponent(str).replace(/%([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), "encodeUTF8$1");
    function resolveConfig(config) {
      const newConfig = mergeConfig({}, config);
      const own2 = /* @__PURE__ */ __name((key) => utils$1.hasOwnProp(newConfig, key) ? newConfig[key] : void 0, "own");
      const data = own2("data");
      let withXSRFToken = own2("withXSRFToken");
      const xsrfHeaderName = own2("xsrfHeaderName");
      const xsrfCookieName = own2("xsrfCookieName");
      let headers = own2("headers");
      const auth = own2("auth");
      const baseURL = own2("baseURL");
      const allowAbsoluteUrls = own2("allowAbsoluteUrls");
      const url2 = own2("url");
      newConfig.headers = headers = AxiosHeaders.from(headers);
      newConfig.url = buildURL(buildFullPath(baseURL, url2, allowAbsoluteUrls, newConfig), own2("params"), own2("paramsSerializer"));
      if (auth) {
        const username = utils$1.getSafeProp(auth, "username") || "";
        const password = utils$1.getSafeProp(auth, "password") || "";
        try {
          headers.set("Authorization", "Basic " + btoa(username + ":" + (password ? encodeUTF8$1(password) : "")));
        } catch (e) {
          throw AxiosError.from(e, AxiosError.ERR_BAD_OPTION_VALUE, config);
        }
      }
      if (utils$1.isFormData(data)) {
        if (platform.hasStandardBrowserEnv || platform.hasStandardBrowserWebWorkerEnv || utils$1.isReactNative(data)) {
          headers.setContentType(void 0);
        } else if (utils$1.isFunction(data.getHeaders)) {
          setFormDataHeaders(headers, data.getHeaders(), own2("formDataHeaderPolicy"));
        }
      }
      if (platform.hasStandardBrowserEnv) {
        if (utils$1.isFunction(withXSRFToken)) {
          withXSRFToken = withXSRFToken(newConfig);
        }
        const shouldSendXSRF = withXSRFToken === true || withXSRFToken == null && isURLSameOrigin(newConfig.url);
        if (shouldSendXSRF) {
          const xsrfValue = xsrfHeaderName && xsrfCookieName && cookies.read(xsrfCookieName);
          if (xsrfValue) {
            headers.set(xsrfHeaderName, xsrfValue);
          }
        }
      }
      return newConfig;
    }
    __name(resolveConfig, "resolveConfig");
    var isXHRAdapterSupported = typeof XMLHttpRequest !== "undefined";
    var xhrAdapter = isXHRAdapterSupported && function(config) {
      return new Promise(/* @__PURE__ */ __name(function dispatchXhrRequest(resolve, reject) {
        const _config = resolveConfig(config);
        let requestData = _config.data;
        const requestHeaders = AxiosHeaders.from(_config.headers).normalize();
        let {
          responseType,
          onUploadProgress,
          onDownloadProgress
        } = _config;
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
          const responseHeaders = AxiosHeaders.from("getAllResponseHeaders" in request && request.getAllResponseHeaders());
          const responseData = !responseType || responseType === "text" || responseType === "json" ? request.responseText : request.response;
          const response = {
            data: responseData,
            status: request.status,
            statusText: request.statusText,
            headers: responseHeaders,
            config,
            request
          };
          settle(/* @__PURE__ */ __name(function _resolve(value) {
            resolve(value);
            done();
          }, "_resolve"), /* @__PURE__ */ __name(function _reject(err) {
            reject(err);
            done();
          }, "_reject"), response);
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
          reject(new AxiosError("Request aborted", AxiosError.ECONNABORTED, config, request));
          done();
          request = null;
        }, "handleAbort");
        request.onerror = /* @__PURE__ */ __name(function handleError(event) {
          const msg = event && event.message ? event.message : "Network Error";
          const err = new AxiosError(msg, AxiosError.ERR_NETWORK, config, request);
          err.event = event || null;
          reject(err);
          done();
          request = null;
        }, "handleError");
        request.ontimeout = /* @__PURE__ */ __name(function handleTimeout() {
          let timeoutErrorMessage = _config.timeout ? "timeout of " + _config.timeout + "ms exceeded" : "timeout exceeded";
          const transitional = _config.transitional || transitionalDefaults;
          if (_config.timeoutErrorMessage) {
            timeoutErrorMessage = _config.timeoutErrorMessage;
          }
          reject(new AxiosError(timeoutErrorMessage, transitional.clarifyTimeoutError ? AxiosError.ETIMEDOUT : AxiosError.ECONNABORTED, config, request));
          done();
          request = null;
        }, "handleTimeout");
        requestData === void 0 && requestHeaders.setContentType(null);
        if ("setRequestHeader" in request) {
          utils$1.forEach(toByteStringHeaderObject(requestHeaders), /* @__PURE__ */ __name(function setRequestHeader(val, key) {
            request.setRequestHeader(key, val);
          }, "setRequestHeader"));
        }
        if (!utils$1.isUndefined(_config.withCredentials)) {
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
            reject(!cancel || cancel.type ? new CanceledError(null, config, request) : cancel);
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
        if (protocol && !platform.protocols.includes(protocol)) {
          reject(new AxiosError("Unsupported protocol " + protocol + ":", AxiosError.ERR_BAD_REQUEST, config));
          done();
          return;
        }
        request.send(requestData || null);
      }, "dispatchXhrRequest"));
    };
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
          controller.abort(err instanceof AxiosError ? err : new CanceledError(err instanceof Error ? err.message : err));
        }
      }, "onabort");
      let timer = timeout && setTimeout(() => {
        timer = null;
        onabort(new AxiosError(`timeout of ${timeout}ms exceeded`, AxiosError.ETIMEDOUT));
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
        signal2.addEventListener("abort", onabort, {
          once: true
        });
      });
      const {
        signal
      } = controller;
      signal.unsubscribe = () => utils$1.asap(unsubscribe);
      return signal;
    }, "composeSignals");
    var streamChunk = /* @__PURE__ */ __name(function* (chunk, chunkSize) {
      let len = chunk.byteLength;
      if (len < chunkSize) {
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
    var readStream = /* @__PURE__ */ __name(async function* (stream2) {
      if (stream2[Symbol.asyncIterator]) {
        yield* stream2;
        return;
      }
      const reader = stream2.getReader();
      try {
        for (; ; ) {
          const {
            done,
            value
          } = await reader.read();
          if (done) {
            break;
          }
          yield value;
        }
      } finally {
        await reader.cancel();
      }
    }, "readStream");
    var trackStream = /* @__PURE__ */ __name((stream2, chunkSize, onProgress, onFinish) => {
      const iterator2 = readBytes(stream2, chunkSize);
      let bytes = 0;
      let done;
      let _onFinish = /* @__PURE__ */ __name((e) => {
        if (!done) {
          done = true;
          onFinish && onFinish(e);
        }
      }, "_onFinish");
      return new ReadableStream({
        async pull(controller) {
          try {
            const {
              done: done2,
              value
            } = await iterator2.next();
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
      }, {
        highWaterMark: 2
      });
    }, "trackStream");
    var DEFAULT_CHUNK_SIZE = 64 * 1024;
    var {
      isFunction
    } = utils$1;
    var encodeUTF8 = /* @__PURE__ */ __name((str) => encodeURIComponent(str).replace(/%([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), "encodeUTF8");
    var decodeURIComponentSafe = /* @__PURE__ */ __name((value) => {
      if (!utils$1.isString(value)) {
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
      const globalObject = utils$1.global !== void 0 && utils$1.global !== null ? utils$1.global : globalThis;
      const {
        ReadableStream: ReadableStream2,
        TextEncoder: TextEncoder2
      } = globalObject;
      env = utils$1.merge.call({
        skipUndefined: true
      }, {
        Request: globalObject.Request,
        Response: globalObject.Response
      }, env);
      const {
        fetch: envFetch,
        Request,
        Response
      } = env;
      const isFetchSupported = envFetch ? isFunction(envFetch) : typeof fetch === "function";
      const isRequestSupported = isFunction(Request);
      const isResponseSupported = isFunction(Response);
      if (!isFetchSupported) {
        return false;
      }
      const isReadableStreamSupported = isFetchSupported && isFunction(ReadableStream2);
      const encodeText = isFetchSupported && (typeof TextEncoder2 === "function" ? /* @__PURE__ */ ((encoder) => (str) => encoder.encode(str))(new TextEncoder2()) : async (str) => new Uint8Array(await new Request(str).arrayBuffer()));
      const supportsRequestStream = isRequestSupported && isReadableStreamSupported && test(() => {
        let duplexAccessed = false;
        const request = new Request(platform.origin, {
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
      const supportsResponseStream = isResponseSupported && isReadableStreamSupported && test(() => utils$1.isReadableStream(new Response("").body));
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
            throw new AxiosError(`Response type '${type}' is not supported`, AxiosError.ERR_NOT_SUPPORT, config);
          });
        });
      })();
      const getBodyLength = /* @__PURE__ */ __name(async (body) => {
        if (body == null) {
          return 0;
        }
        if (utils$1.isBlob(body)) {
          return body.size;
        }
        if (utils$1.isSpecCompliantForm(body)) {
          const _request = new Request(platform.origin, {
            method: "POST",
            body
          });
          return (await _request.arrayBuffer()).byteLength;
        }
        if (utils$1.isArrayBufferView(body) || utils$1.isArrayBuffer(body)) {
          return body.byteLength;
        }
        if (utils$1.isURLSearchParams(body)) {
          body = body + "";
        }
        if (utils$1.isString(body)) {
          return (await encodeText(body)).byteLength;
        }
      }, "getBodyLength");
      const resolveBodyLength = /* @__PURE__ */ __name(async (headers, body) => {
        const length = utils$1.toFiniteNumber(headers.getContentLength());
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
        } = resolveConfig(config);
        const hasMaxContentLength = utils$1.isNumber(maxContentLength) && maxContentLength > -1;
        const hasMaxBodyLength = utils$1.isNumber(maxBodyLength) && maxBodyLength > -1;
        const own2 = /* @__PURE__ */ __name((key) => utils$1.hasOwnProp(config, key) ? config[key] : void 0, "own");
        let _fetch = envFetch || fetch;
        responseType = responseType ? (responseType + "").toLowerCase() : "text";
        let composedSignal = composeSignals([signal, cancelToken && cancelToken.toAbortSignal()], timeout);
        let request = null;
        const unsubscribe = composedSignal && composedSignal.unsubscribe && (() => {
          composedSignal.unsubscribe();
        });
        let requestContentLength;
        let pendingBodyError = null;
        const maxBodyLengthError = /* @__PURE__ */ __name(() => new AxiosError("Request body larger than maxBodyLength limit", AxiosError.ERR_BAD_REQUEST, config, request), "maxBodyLengthError");
        try {
          let auth = void 0;
          const configAuth = own2("auth");
          if (configAuth) {
            const username = utils$1.getSafeProp(configAuth, "username") || "";
            const password = utils$1.getSafeProp(configAuth, "password") || "";
            auth = {
              username,
              password
            };
          }
          if (maybeWithAuthCredentials(url2)) {
            const parsedURL = new URL(url2, platform.origin);
            if (!auth && (parsedURL.username || parsedURL.password)) {
              const urlUsername = decodeURIComponentSafe(parsedURL.username);
              const urlPassword = decodeURIComponentSafe(parsedURL.password);
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
            headers.set("Authorization", "Basic " + btoa(encodeUTF8((auth.username || "") + ":" + (auth.password || ""))));
          }
          if (hasMaxContentLength && typeof url2 === "string" && url2.startsWith("data:")) {
            const estimated = estimateDataURLDecodedBytes(url2);
            if (estimated > maxContentLength) {
              throw new AxiosError("maxContentLength size of " + maxContentLength + " exceeded", AxiosError.ERR_BAD_RESPONSE, config, request);
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
          const mustEnforceStreamBody = hasMaxBodyLength && (utils$1.isReadableStream(data) || utils$1.isStream(data));
          const trackRequestStream = /* @__PURE__ */ __name((stream2, onProgress, flush) => trackStream(stream2, DEFAULT_CHUNK_SIZE, (loadedBytes) => {
            if (hasMaxBodyLength && loadedBytes > maxBodyLength) {
              throw pendingBodyError = maxBodyLengthError();
            }
            onProgress && onProgress(loadedBytes);
          }, flush), "trackRequestStream");
          if (supportsRequestStream && method !== "get" && method !== "head" && (onUploadProgress || mustEnforceStreamBody)) {
            requestContentLength = requestContentLength == null ? await resolveBodyLength(headers, data) : requestContentLength;
            if (requestContentLength !== 0 || mustEnforceStreamBody) {
              let _request = new Request(url2, {
                method: "POST",
                body: data,
                duplex: "half"
              });
              let contentTypeHeader;
              if (utils$1.isFormData(data) && (contentTypeHeader = _request.headers.get("content-type"))) {
                headers.setContentType(contentTypeHeader);
              }
              if (_request.body) {
                const [onProgress, flush] = onUploadProgress && progressEventDecorator(requestContentLength, progressEventReducer(asyncDecorator(onUploadProgress))) || [];
                data = trackRequestStream(_request.body, onProgress, flush);
              }
            }
          } else if (mustEnforceStreamBody && !isRequestSupported && isReadableStreamSupported && method !== "get" && method !== "head") {
            data = trackRequestStream(data);
          } else if (mustEnforceStreamBody && isRequestSupported && !supportsRequestStream && method !== "get" && method !== "head") {
            throw new AxiosError("Stream request bodies are not supported by the current fetch implementation", AxiosError.ERR_NOT_SUPPORT, config, request);
          }
          if (!utils$1.isString(withCredentials)) {
            withCredentials = withCredentials ? "include" : "omit";
          }
          const isCredentialsSupported = isRequestSupported && "credentials" in Request.prototype;
          if (utils$1.isFormData(data)) {
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
          const responseHeaders = AxiosHeaders.from(response.headers);
          if (hasMaxContentLength) {
            const declaredLength = utils$1.toFiniteNumber(responseHeaders.getContentLength());
            if (declaredLength != null && declaredLength > maxContentLength) {
              throw new AxiosError("maxContentLength size of " + maxContentLength + " exceeded", AxiosError.ERR_BAD_RESPONSE, config, request);
            }
          }
          const isStreamResponse = supportsResponseStream && (responseType === "stream" || responseType === "response");
          if (supportsResponseStream && response.body && (onDownloadProgress || hasMaxContentLength || isStreamResponse && unsubscribe)) {
            const options = {};
            ["status", "statusText", "headers"].forEach((prop) => {
              options[prop] = response[prop];
            });
            const responseContentLength = utils$1.toFiniteNumber(responseHeaders.getContentLength());
            const [onProgress, flush] = onDownloadProgress && progressEventDecorator(responseContentLength, progressEventReducer(asyncDecorator(onDownloadProgress), true)) || [];
            let bytesRead = 0;
            const onChunkProgress = /* @__PURE__ */ __name((loadedBytes) => {
              if (hasMaxContentLength) {
                bytesRead = loadedBytes;
                if (bytesRead > maxContentLength) {
                  throw new AxiosError("maxContentLength size of " + maxContentLength + " exceeded", AxiosError.ERR_BAD_RESPONSE, config, request);
                }
              }
              onProgress && onProgress(loadedBytes);
            }, "onChunkProgress");
            response = new Response(trackStream(response.body, DEFAULT_CHUNK_SIZE, onChunkProgress, () => {
              flush && flush();
              unsubscribe && unsubscribe();
            }), options);
          }
          responseType = responseType || "text";
          let responseData = await resolvers[utils$1.findKey(resolvers, responseType) || "text"](response, config);
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
              throw new AxiosError("maxContentLength size of " + maxContentLength + " exceeded", AxiosError.ERR_BAD_RESPONSE, config, request);
            }
          }
          !isStreamResponse && unsubscribe && unsubscribe();
          return await new Promise((resolve, reject) => {
            settle(resolve, reject, {
              data: responseData,
              headers: AxiosHeaders.from(response.headers),
              status: response.status,
              statusText: response.statusText,
              config,
              request
            });
          });
        } catch (err) {
          unsubscribe && unsubscribe();
          if (composedSignal && composedSignal.aborted && composedSignal.reason instanceof AxiosError) {
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
          if (err instanceof AxiosError) {
            request && !err.request && (err.request = request);
            throw err;
          }
          if (err && err.name === "TypeError" && /Load failed|fetch/i.test(err.message)) {
            const networkError = new AxiosError("Network Error", AxiosError.ERR_NETWORK, config, request, err && err.response);
            Object.defineProperty(networkError, "cause", {
              __proto__: null,
              value: err.cause || err,
              writable: true,
              enumerable: false,
              configurable: true
            });
            throw networkError;
          }
          throw AxiosError.from(err, err && err.code, config, request, err && err.response);
        }
      };
    }, "factory");
    var seedCache = /* @__PURE__ */ new Map();
    var getFetch = /* @__PURE__ */ __name((config) => {
      let env = config && config.env || {};
      const {
        fetch: fetch2,
        Request,
        Response
      } = env;
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
    getFetch();
    var knownAdapters = {
      http: httpAdapter,
      xhr: xhrAdapter,
      fetch: {
        get: getFetch
      }
    };
    utils$1.forEach(knownAdapters, (fn, value) => {
      if (fn) {
        try {
          Object.defineProperty(fn, "name", {
            __proto__: null,
            value
          });
        } catch (e) {
        }
        Object.defineProperty(fn, "adapterName", {
          __proto__: null,
          value
        });
      }
    });
    var renderReason = /* @__PURE__ */ __name((reason) => `- ${reason}`, "renderReason");
    var isResolvedHandle = /* @__PURE__ */ __name((adapter) => utils$1.isFunction(adapter) || adapter === null || adapter === false, "isResolvedHandle");
    function getAdapter(adapters2, config) {
      adapters2 = utils$1.isArray(adapters2) ? adapters2 : [adapters2];
      const {
        length
      } = adapters2;
      let nameOrAdapter;
      let adapter;
      const rejectedReasons = {};
      for (let i = 0; i < length; i++) {
        nameOrAdapter = adapters2[i];
        let id;
        adapter = nameOrAdapter;
        if (!isResolvedHandle(nameOrAdapter)) {
          adapter = knownAdapters[(id = String(nameOrAdapter)).toLowerCase()];
          if (adapter === void 0) {
            throw new AxiosError(`Unknown adapter '${id}'`);
          }
        }
        if (adapter && (utils$1.isFunction(adapter) || (adapter = adapter.get(config)))) {
          break;
        }
        rejectedReasons[id || "#" + i] = adapter;
      }
      if (!adapter) {
        const reasons = Object.entries(rejectedReasons).map(([id, state]) => `adapter ${id} ` + (state === false ? "is not supported by the environment" : "is not available in the build"));
        let s = length ? reasons.length > 1 ? "since :\n" + reasons.map(renderReason).join("\n") : " " + renderReason(reasons[0]) : "as no adapter specified";
        throw new AxiosError(`There is no suitable adapter to dispatch the request ` + s, AxiosError.ERR_NOT_SUPPORT);
      }
      return adapter;
    }
    __name(getAdapter, "getAdapter");
    var adapters = {
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
    function throwIfCancellationRequested(config) {
      if (config.cancelToken) {
        config.cancelToken.throwIfRequested();
      }
      if (config.signal && config.signal.aborted) {
        throw new CanceledError(null, config);
      }
    }
    __name(throwIfCancellationRequested, "throwIfCancellationRequested");
    function dispatchRequest(config) {
      throwIfCancellationRequested(config);
      config.headers = AxiosHeaders.from(config.headers);
      config.data = transformData.call(config, config.transformRequest);
      if (["post", "put", "patch"].indexOf(config.method) !== -1) {
        config.headers.setContentType("application/x-www-form-urlencoded", false);
      }
      const adapter = adapters.getAdapter(config.adapter || defaults.adapter, config);
      return adapter(config).then(/* @__PURE__ */ __name(function onAdapterResolution(response) {
        throwIfCancellationRequested(config);
        config.response = response;
        try {
          response.data = transformData.call(config, config.transformResponse, response);
        } finally {
          delete config.response;
        }
        response.headers = AxiosHeaders.from(response.headers);
        return response;
      }, "onAdapterResolution"), /* @__PURE__ */ __name(function onAdapterRejection(reason) {
        if (!isCancel(reason)) {
          throwIfCancellationRequested(config);
          if (reason && reason.response) {
            config.response = reason.response;
            try {
              reason.response.data = transformData.call(config, config.transformResponse, reason.response);
            } finally {
              delete config.response;
            }
            reason.response.headers = AxiosHeaders.from(reason.response.headers);
          }
        }
        return Promise.reject(reason);
      }, "onAdapterRejection"));
    }
    __name(dispatchRequest, "dispatchRequest");
    var validators$1 = {};
    ["object", "boolean", "number", "function", "string", "symbol"].forEach((type, i) => {
      validators$1[type] = /* @__PURE__ */ __name(function validator2(thing) {
        return typeof thing === type || "a" + (i < 1 ? "n " : " ") + type;
      }, "validator");
    });
    var deprecatedWarnings = {};
    validators$1.transitional = /* @__PURE__ */ __name(function transitional(validator2, version, message) {
      function formatMessage(opt, desc) {
        return "[Axios v" + VERSION + "] Transitional option '" + opt + "'" + desc + (message ? ". " + message : "");
      }
      __name(formatMessage, "formatMessage");
      return (value, opt, opts) => {
        if (validator2 === false) {
          throw new AxiosError(formatMessage(opt, " has been removed" + (version ? " in " + version : "")), AxiosError.ERR_DEPRECATED);
        }
        if (version && !deprecatedWarnings[opt]) {
          deprecatedWarnings[opt] = true;
          console.warn(formatMessage(opt, " has been deprecated since v" + version + " and will be removed in the near future"));
        }
        return validator2 ? validator2(value, opt, opts) : true;
      };
    }, "transitional");
    validators$1.spelling = /* @__PURE__ */ __name(function spelling(correctSpelling) {
      return (value, opt) => {
        console.warn(`${opt} is likely a misspelling of ${correctSpelling}`);
        return true;
      };
    }, "spelling");
    function assertOptions(options, schema, allowUnknown) {
      if (typeof options !== "object" || options === null) {
        throw new AxiosError("options must be an object", AxiosError.ERR_BAD_OPTION_VALUE);
      }
      const keys = Object.keys(options);
      let i = keys.length;
      while (i-- > 0) {
        const opt = keys[i];
        const validator2 = Object.prototype.hasOwnProperty.call(schema, opt) ? schema[opt] : void 0;
        if (validator2) {
          const value = options[opt];
          const result = value === void 0 || validator2(value, opt, options);
          if (result !== true) {
            throw new AxiosError("option " + opt + " must be " + result, AxiosError.ERR_BAD_OPTION_VALUE);
          }
          continue;
        }
        if (allowUnknown !== true) {
          throw new AxiosError("Unknown option " + opt, AxiosError.ERR_BAD_OPTION);
        }
      }
    }
    __name(assertOptions, "assertOptions");
    var validator = {
      assertOptions,
      validators: validators$1
    };
    var validators = validator.validators;
    var Axios = class {
      static {
        __name(this, "Axios");
      }
      constructor(instanceConfig) {
        this.defaults = instanceConfig || {};
        this.interceptors = {
          request: new InterceptorManager(),
          response: new InterceptorManager()
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
        const {
          transitional,
          paramsSerializer,
          headers
        } = config;
        if (transitional !== void 0) {
          validator.assertOptions(transitional, {
            silentJSONParsing: validators.transitional(validators.boolean),
            forcedJSONParsing: validators.transitional(validators.boolean),
            clarifyTimeoutError: validators.transitional(validators.boolean),
            legacyInterceptorReqResOrdering: validators.transitional(validators.boolean),
            advertiseZstdAcceptEncoding: validators.transitional(validators.boolean),
            validateStatusUndefinedResolves: validators.transitional(validators.boolean)
          }, false);
        }
        if (paramsSerializer != null) {
          if (utils$1.isFunction(paramsSerializer)) {
            config.paramsSerializer = {
              serialize: paramsSerializer
            };
          } else {
            validator.assertOptions(paramsSerializer, {
              encode: validators.function,
              serialize: validators.function
            }, true);
          }
        }
        if (config.allowAbsoluteUrls !== void 0) ;
        else if (this.defaults.allowAbsoluteUrls !== void 0) {
          config.allowAbsoluteUrls = this.defaults.allowAbsoluteUrls;
        } else {
          config.allowAbsoluteUrls = true;
        }
        validator.assertOptions(config, {
          baseUrl: validators.spelling("baseURL"),
          withXsrfToken: validators.spelling("withXSRFToken")
        }, true);
        config.method = (config.method || this.defaults.method || "get").toLowerCase();
        let contextHeaders = headers && utils$1.merge(headers.common, headers[config.method]);
        headers && utils$1.forEach(["delete", "get", "head", "post", "put", "patch", "query", "common"], (method) => {
          delete headers[method];
        });
        config.headers = AxiosHeaders.concat(contextHeaders, headers);
        const requestInterceptorChain = [];
        let synchronousRequestInterceptors = true;
        this.interceptors.request.forEach(/* @__PURE__ */ __name(function unshiftRequestInterceptors(interceptor) {
          if (typeof interceptor.runWhen === "function" && interceptor.runWhen(config) === false) {
            return;
          }
          synchronousRequestInterceptors = synchronousRequestInterceptors && interceptor.synchronous;
          const transitional2 = config.transitional || transitionalDefaults;
          const legacyInterceptorReqResOrdering = transitional2 && transitional2.legacyInterceptorReqResOrdering;
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
              if (utils$1.isThenable(rejectedResult)) {
                promise = Promise.resolve(rejectedResult).then(() => dispatchRequest.call(this, newConfig));
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
    utils$1.forEach(["delete", "get", "head", "options"], /* @__PURE__ */ __name(function forEachMethodNoData(method) {
      Axios.prototype[method] = function(url2, config) {
        return this.request(mergeConfig(config || {}, {
          method,
          url: url2,
          data: config && utils$1.hasOwnProp(config, "data") ? config.data : void 0
        }));
      };
    }, "forEachMethodNoData"));
    utils$1.forEach(["post", "put", "patch", "query"], /* @__PURE__ */ __name(function forEachMethodWithData(method) {
      function generateHTTPMethod(isForm) {
        return /* @__PURE__ */ __name(function httpMethod(url2, data, config) {
          return this.request(mergeConfig(config || {}, {
            method,
            headers: isForm ? {
              "Content-Type": "multipart/form-data"
            } : {},
            url: url2,
            data
          }));
        }, "httpMethod");
      }
      __name(generateHTTPMethod, "generateHTTPMethod");
      Axios.prototype[method] = generateHTTPMethod();
      if (method !== "query") {
        Axios.prototype[method + "Form"] = generateHTTPMethod(true);
      }
    }, "forEachMethodWithData"));
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
          token.reason = new CanceledError(message, config, request);
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
    function spread(callback) {
      return /* @__PURE__ */ __name(function wrap(arr) {
        return callback.apply(null, arr);
      }, "wrap");
    }
    __name(spread, "spread");
    function isAxiosError(payload) {
      return utils$1.isObject(payload) && payload.isAxiosError === true;
    }
    __name(isAxiosError, "isAxiosError");
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
    function createInstance(defaultConfig) {
      const context = new Axios(defaultConfig);
      const instance = bind(Axios.prototype.request, context);
      utils$1.extend(instance, Axios.prototype, context, {
        allOwnKeys: true
      });
      utils$1.extend(instance, context, null, {
        allOwnKeys: true
      });
      instance.create = /* @__PURE__ */ __name(function create(instanceConfig) {
        return createInstance(mergeConfig(defaultConfig, instanceConfig));
      }, "create");
      return instance;
    }
    __name(createInstance, "createInstance");
    var axios = createInstance(defaults);
    axios.Axios = Axios;
    axios.CanceledError = CanceledError;
    axios.CancelToken = CancelToken;
    axios.isCancel = isCancel;
    axios.VERSION = VERSION;
    axios.toFormData = toFormData;
    axios.AxiosError = AxiosError;
    axios.Cancel = axios.CanceledError;
    axios.all = /* @__PURE__ */ __name(function all(promises) {
      return Promise.all(promises);
    }, "all");
    axios.spread = spread;
    axios.isAxiosError = isAxiosError;
    axios.mergeConfig = mergeConfig;
    axios.AxiosHeaders = AxiosHeaders;
    axios.formToJSON = (thing) => formDataToJSON(utils$1.isHTMLForm(thing) ? new FormData(thing) : thing);
    axios.getAdapter = adapters.getAdapter;
    axios.HttpStatusCode = HttpStatusCode;
    axios.default = axios;
    module.exports = axios;
  }
});

// node_modules/ws/index.js
var require_ws = __commonJS({
  "node_modules/ws/index.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var createWebSocketStream = require_stream();
    var extension = require_extension();
    var PerMessageDeflate = require_permessage_deflate();
    var Receiver = require_receiver();
    var Sender = require_sender();
    var subprotocol = require_subprotocol();
    var WebSocket = require_websocket();
    var WebSocketServer = require_websocket_server();
    WebSocket.createWebSocketStream = createWebSocketStream;
    WebSocket.extension = extension;
    WebSocket.PerMessageDeflate = PerMessageDeflate;
    WebSocket.Receiver = Receiver;
    WebSocket.Sender = Sender;
    WebSocket.Server = WebSocketServer;
    WebSocket.subprotocol = subprotocol;
    WebSocket.WebSocket = WebSocket;
    WebSocket.WebSocketServer = WebSocketServer;
    module.exports = WebSocket;
  }
});

export {
  require_axios,
  require_ws
};
/*! Bundled license information:

axios/dist/node/axios.cjs:
  (*! Axios v1.19.0 Copyright (c) 2026 Matt Zabriskie and contributors *)
*/
