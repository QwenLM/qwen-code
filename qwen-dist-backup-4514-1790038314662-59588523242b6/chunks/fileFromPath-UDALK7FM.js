// Force strict mode and setup for ESM
"use strict";
import {
  File,
  isFile
} from "./chunk-QMGX2KO2.js";
import {
  require_node_domexception
} from "./chunk-2X56YUSZ.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// node_modules/formdata-node/lib/esm/fileFromPath.js
init_esbuild_shims();
var import_node_domexception = __toESM(require_node_domexception(), 1);
import { statSync, createReadStream, promises as fs } from "fs";
import { basename } from "path";

// node_modules/formdata-node/lib/esm/isPlainObject.js
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

// node_modules/formdata-node/lib/esm/fileFromPath.js
var __classPrivateFieldSet = function(receiver, state, value, kind, f) {
  if (kind === "m") throw new TypeError("Private method is not writable");
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
};
var __classPrivateFieldGet = function(receiver, state, kind, f) {
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _FileFromPath_path;
var _FileFromPath_start;
var MESSAGE = "The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.";
var FileFromPath = class _FileFromPath {
  static {
    __name(this, "FileFromPath");
  }
  constructor(input) {
    _FileFromPath_path.set(this, void 0);
    _FileFromPath_start.set(this, void 0);
    __classPrivateFieldSet(this, _FileFromPath_path, input.path, "f");
    __classPrivateFieldSet(this, _FileFromPath_start, input.start || 0, "f");
    this.name = basename(__classPrivateFieldGet(this, _FileFromPath_path, "f"));
    this.size = input.size;
    this.lastModified = input.lastModified;
  }
  slice(start, end) {
    return new _FileFromPath({
      path: __classPrivateFieldGet(this, _FileFromPath_path, "f"),
      lastModified: this.lastModified,
      size: end - start,
      start
    });
  }
  async *stream() {
    const { mtimeMs } = await fs.stat(__classPrivateFieldGet(this, _FileFromPath_path, "f"));
    if (mtimeMs > this.lastModified) {
      throw new import_node_domexception.default(MESSAGE, "NotReadableError");
    }
    if (this.size) {
      yield* createReadStream(__classPrivateFieldGet(this, _FileFromPath_path, "f"), {
        start: __classPrivateFieldGet(this, _FileFromPath_start, "f"),
        end: __classPrivateFieldGet(this, _FileFromPath_start, "f") + this.size - 1
      });
    }
  }
  get [(_FileFromPath_path = /* @__PURE__ */ new WeakMap(), _FileFromPath_start = /* @__PURE__ */ new WeakMap(), Symbol.toStringTag)]() {
    return "File";
  }
};
function createFileFromPath(path, { mtimeMs, size }, filenameOrOptions, options = {}) {
  let filename;
  if (isPlainObject_default(filenameOrOptions)) {
    [options, filename] = [filenameOrOptions, void 0];
  } else {
    filename = filenameOrOptions;
  }
  const file = new FileFromPath({ path, size, lastModified: mtimeMs });
  if (!filename) {
    filename = file.name;
  }
  return new File([file], filename, {
    ...options,
    lastModified: file.lastModified
  });
}
__name(createFileFromPath, "createFileFromPath");
function fileFromPathSync(path, filenameOrOptions, options = {}) {
  const stats = statSync(path);
  return createFileFromPath(path, stats, filenameOrOptions, options);
}
__name(fileFromPathSync, "fileFromPathSync");
async function fileFromPath(path, filenameOrOptions, options) {
  const stats = await fs.stat(path);
  return createFileFromPath(path, stats, filenameOrOptions, options);
}
__name(fileFromPath, "fileFromPath");
export {
  fileFromPath,
  fileFromPathSync,
  isFile
};
