// Force strict mode and setup for ESM
"use strict";
import {
  require_proper_lockfile
} from "./chunk-MLXTMF7H.js";
import {
  stringifyGenAiJson
} from "./chunk-QE36VXWP.js";
import {
  GOAL_STATE_EVENT_CAUSES,
  makeGoalStateEvent
} from "./chunk-KKGSJZWK.js";
import {
  atomicWriteJSON
} from "./chunk-CA63HYHU.js";
import {
  DEFAULT_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH,
  SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT,
  SERVICE_NAME,
  getMeter,
  isTelemetrySdkInitialized,
  isValidSensitiveSpanAttributeMaxLength
} from "./chunk-B3XJFEEH.js";
import {
  QWEN_DIR,
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  FatalConfigError
} from "./chunk-S34QJ6IR.js";
import {
  ValueType,
  diag,
  init_esm
} from "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __commonJS,
  __name,
  __require,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// node_modules/yaml/dist/nodes/identity.js
var require_identity = __commonJS({
  "node_modules/yaml/dist/nodes/identity.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var ALIAS = Symbol.for("yaml.alias");
    var DOC = Symbol.for("yaml.document");
    var MAP = Symbol.for("yaml.map");
    var PAIR = Symbol.for("yaml.pair");
    var SCALAR = Symbol.for("yaml.scalar");
    var SEQ = Symbol.for("yaml.seq");
    var NODE_TYPE = Symbol.for("yaml.node.type");
    var isAlias = /* @__PURE__ */ __name((node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS, "isAlias");
    var isDocument = /* @__PURE__ */ __name((node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC, "isDocument");
    var isMap = /* @__PURE__ */ __name((node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP, "isMap");
    var isPair = /* @__PURE__ */ __name((node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR, "isPair");
    var isScalar = /* @__PURE__ */ __name((node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR, "isScalar");
    var isSeq = /* @__PURE__ */ __name((node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ, "isSeq");
    function isCollection(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case MAP:
          case SEQ:
            return true;
        }
      return false;
    }
    __name(isCollection, "isCollection");
    function isNode(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case ALIAS:
          case MAP:
          case SCALAR:
          case SEQ:
            return true;
        }
      return false;
    }
    __name(isNode, "isNode");
    var hasAnchor = /* @__PURE__ */ __name((node) => (isScalar(node) || isCollection(node)) && !!node.anchor, "hasAnchor");
    exports.ALIAS = ALIAS;
    exports.DOC = DOC;
    exports.MAP = MAP;
    exports.NODE_TYPE = NODE_TYPE;
    exports.PAIR = PAIR;
    exports.SCALAR = SCALAR;
    exports.SEQ = SEQ;
    exports.hasAnchor = hasAnchor;
    exports.isAlias = isAlias;
    exports.isCollection = isCollection;
    exports.isDocument = isDocument;
    exports.isMap = isMap;
    exports.isNode = isNode;
    exports.isPair = isPair;
    exports.isScalar = isScalar;
    exports.isSeq = isSeq;
  }
});

// node_modules/yaml/dist/visit.js
var require_visit = __commonJS({
  "node_modules/yaml/dist/visit.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var identity = require_identity();
    var BREAK = Symbol("break visit");
    var SKIP = Symbol("skip children");
    var REMOVE = Symbol("remove node");
    function visit(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        visit_(null, node, visitor_, Object.freeze([]));
    }
    __name(visit, "visit");
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    function visit_(key, node, visitor, path3) {
      const ctrl = callVisitor(key, node, visitor, path3);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path3, ctrl);
        return visit_(key, ctrl, visitor, path3);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path3 = Object.freeze(path3.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = visit_(i, node.items[i], visitor, path3);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path3 = Object.freeze(path3.concat(node));
          const ck = visit_("key", node.key, visitor, path3);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = visit_("value", node.value, visitor, path3);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    __name(visit_, "visit_");
    async function visitAsync(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        await visitAsync_(null, node, visitor_, Object.freeze([]));
    }
    __name(visitAsync, "visitAsync");
    visitAsync.BREAK = BREAK;
    visitAsync.SKIP = SKIP;
    visitAsync.REMOVE = REMOVE;
    async function visitAsync_(key, node, visitor, path3) {
      const ctrl = await callVisitor(key, node, visitor, path3);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path3, ctrl);
        return visitAsync_(key, ctrl, visitor, path3);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path3 = Object.freeze(path3.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = await visitAsync_(i, node.items[i], visitor, path3);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path3 = Object.freeze(path3.concat(node));
          const ck = await visitAsync_("key", node.key, visitor, path3);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = await visitAsync_("value", node.value, visitor, path3);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    __name(visitAsync_, "visitAsync_");
    function initVisitor(visitor) {
      if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
        return Object.assign({
          Alias: visitor.Node,
          Map: visitor.Node,
          Scalar: visitor.Node,
          Seq: visitor.Node
        }, visitor.Value && {
          Map: visitor.Value,
          Scalar: visitor.Value,
          Seq: visitor.Value
        }, visitor.Collection && {
          Map: visitor.Collection,
          Seq: visitor.Collection
        }, visitor);
      }
      return visitor;
    }
    __name(initVisitor, "initVisitor");
    function callVisitor(key, node, visitor, path3) {
      if (typeof visitor === "function")
        return visitor(key, node, path3);
      if (identity.isMap(node))
        return visitor.Map?.(key, node, path3);
      if (identity.isSeq(node))
        return visitor.Seq?.(key, node, path3);
      if (identity.isPair(node))
        return visitor.Pair?.(key, node, path3);
      if (identity.isScalar(node))
        return visitor.Scalar?.(key, node, path3);
      if (identity.isAlias(node))
        return visitor.Alias?.(key, node, path3);
      return void 0;
    }
    __name(callVisitor, "callVisitor");
    function replaceNode(key, path3, node) {
      const parent = path3[path3.length - 1];
      if (identity.isCollection(parent)) {
        parent.items[key] = node;
      } else if (identity.isPair(parent)) {
        if (key === "key")
          parent.key = node;
        else
          parent.value = node;
      } else if (identity.isDocument(parent)) {
        parent.contents = node;
      } else {
        const pt = identity.isAlias(parent) ? "alias" : "scalar";
        throw new Error(`Cannot replace node with ${pt} parent`);
      }
    }
    __name(replaceNode, "replaceNode");
    exports.visit = visit;
    exports.visitAsync = visitAsync;
  }
});

// node_modules/yaml/dist/doc/directives.js
var require_directives = __commonJS({
  "node_modules/yaml/dist/doc/directives.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var identity = require_identity();
    var visit = require_visit();
    var escapeChars = {
      "!": "%21",
      ",": "%2C",
      "[": "%5B",
      "]": "%5D",
      "{": "%7B",
      "}": "%7D"
    };
    var escapeTagName = /* @__PURE__ */ __name((tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]), "escapeTagName");
    var Directives = class _Directives {
      static {
        __name(this, "Directives");
      }
      constructor(yaml2, tags) {
        this.docStart = null;
        this.docEnd = false;
        this.yaml = Object.assign({}, _Directives.defaultYaml, yaml2);
        this.tags = Object.assign({}, _Directives.defaultTags, tags);
      }
      clone() {
        const copy = new _Directives(this.yaml, this.tags);
        copy.docStart = this.docStart;
        return copy;
      }
      /**
       * During parsing, get a Directives instance for the current document and
       * update the stream state according to the current version's spec.
       */
      atDocument() {
        const res = new _Directives(this.yaml, this.tags);
        switch (this.yaml.version) {
          case "1.1":
            this.atNextDocument = true;
            break;
          case "1.2":
            this.atNextDocument = false;
            this.yaml = {
              explicit: _Directives.defaultYaml.explicit,
              version: "1.2"
            };
            this.tags = Object.assign({}, _Directives.defaultTags);
            break;
        }
        return res;
      }
      /**
       * @param onError - May be called even if the action was successful
       * @returns `true` on success
       */
      add(line, onError) {
        if (this.atNextDocument) {
          this.yaml = { explicit: _Directives.defaultYaml.explicit, version: "1.1" };
          this.tags = Object.assign({}, _Directives.defaultTags);
          this.atNextDocument = false;
        }
        const parts = line.trim().split(/[ \t]+/);
        const name = parts.shift();
        switch (name) {
          case "%TAG": {
            if (parts.length !== 2) {
              onError(0, "%TAG directive should contain exactly two parts");
              if (parts.length < 2)
                return false;
            }
            const [handle, prefix] = parts;
            this.tags[handle] = prefix;
            return true;
          }
          case "%YAML": {
            this.yaml.explicit = true;
            if (parts.length !== 1) {
              onError(0, "%YAML directive should contain exactly one part");
              return false;
            }
            const [version] = parts;
            if (version === "1.1" || version === "1.2") {
              this.yaml.version = version;
              return true;
            } else {
              const isValid = /^\d+\.\d+$/.test(version);
              onError(6, `Unsupported YAML version ${version}`, isValid);
              return false;
            }
          }
          default:
            onError(0, `Unknown directive ${name}`, true);
            return false;
        }
      }
      /**
       * Resolves a tag, matching handles to those defined in %TAG directives.
       *
       * @returns Resolved tag, which may also be the non-specific tag `'!'` or a
       *   `'!local'` tag, or `null` if unresolvable.
       */
      tagName(source, onError) {
        if (source === "!")
          return "!";
        if (source[0] !== "!") {
          onError(`Not a valid tag: ${source}`);
          return null;
        }
        if (source[1] === "<") {
          const verbatim = source.slice(2, -1);
          if (verbatim === "!" || verbatim === "!!") {
            onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
            return null;
          }
          if (source[source.length - 1] !== ">")
            onError("Verbatim tags must end with a >");
          return verbatim;
        }
        const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
        if (!suffix)
          onError(`The ${source} tag has no suffix`);
        const prefix = this.tags[handle];
        if (prefix) {
          try {
            return prefix + decodeURIComponent(suffix);
          } catch (error) {
            onError(String(error));
            return null;
          }
        }
        if (handle === "!")
          return source;
        onError(`Could not resolve tag: ${source}`);
        return null;
      }
      /**
       * Given a fully resolved tag, returns its printable string form,
       * taking into account current tag prefixes and defaults.
       */
      tagString(tag) {
        for (const [handle, prefix] of Object.entries(this.tags)) {
          if (tag.startsWith(prefix))
            return handle + escapeTagName(tag.substring(prefix.length));
        }
        return tag[0] === "!" ? tag : `!<${tag}>`;
      }
      toString(doc) {
        const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
        const tagEntries = Object.entries(this.tags);
        let tagNames;
        if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
          const tags = {};
          visit.visit(doc.contents, (_key, node) => {
            if (identity.isNode(node) && node.tag)
              tags[node.tag] = true;
          });
          tagNames = Object.keys(tags);
        } else
          tagNames = [];
        for (const [handle, prefix] of tagEntries) {
          if (handle === "!!" && prefix === "tag:yaml.org,2002:")
            continue;
          if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
            lines.push(`%TAG ${handle} ${prefix}`);
        }
        return lines.join("\n");
      }
    };
    Directives.defaultYaml = { explicit: false, version: "1.2" };
    Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
    exports.Directives = Directives;
  }
});

// node_modules/yaml/dist/doc/anchors.js
var require_anchors = __commonJS({
  "node_modules/yaml/dist/doc/anchors.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var identity = require_identity();
    var visit = require_visit();
    function anchorIsValid(anchor) {
      if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
        const sa = JSON.stringify(anchor);
        const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
        throw new Error(msg);
      }
      return true;
    }
    __name(anchorIsValid, "anchorIsValid");
    function anchorNames(root) {
      const anchors = /* @__PURE__ */ new Set();
      visit.visit(root, {
        Value(_key, node) {
          if (node.anchor)
            anchors.add(node.anchor);
        }
      });
      return anchors;
    }
    __name(anchorNames, "anchorNames");
    function findNewAnchor(prefix, exclude) {
      for (let i = 1; true; ++i) {
        const name = `${prefix}${i}`;
        if (!exclude.has(name))
          return name;
      }
    }
    __name(findNewAnchor, "findNewAnchor");
    function createNodeAnchors(doc, prefix) {
      const aliasObjects = [];
      const sourceObjects = /* @__PURE__ */ new Map();
      let prevAnchors = null;
      return {
        onAnchor: /* @__PURE__ */ __name((source) => {
          aliasObjects.push(source);
          prevAnchors ?? (prevAnchors = anchorNames(doc));
          const anchor = findNewAnchor(prefix, prevAnchors);
          prevAnchors.add(anchor);
          return anchor;
        }, "onAnchor"),
        /**
         * With circular references, the source node is only resolved after all
         * of its child nodes are. This is why anchors are set only after all of
         * the nodes have been created.
         */
        setAnchors: /* @__PURE__ */ __name(() => {
          for (const source of aliasObjects) {
            const ref = sourceObjects.get(source);
            if (typeof ref === "object" && ref.anchor && (identity.isScalar(ref.node) || identity.isCollection(ref.node))) {
              ref.node.anchor = ref.anchor;
            } else {
              const error = new Error("Failed to resolve repeated object (this should not happen)");
              error.source = source;
              throw error;
            }
          }
        }, "setAnchors"),
        sourceObjects
      };
    }
    __name(createNodeAnchors, "createNodeAnchors");
    exports.anchorIsValid = anchorIsValid;
    exports.anchorNames = anchorNames;
    exports.createNodeAnchors = createNodeAnchors;
    exports.findNewAnchor = findNewAnchor;
  }
});

// node_modules/yaml/dist/doc/applyReviver.js
var require_applyReviver = __commonJS({
  "node_modules/yaml/dist/doc/applyReviver.js"(exports) {
    "use strict";
    init_esbuild_shims();
    function applyReviver(reviver, obj, key, val) {
      if (val && typeof val === "object") {
        if (Array.isArray(val)) {
          for (let i = 0, len = val.length; i < len; ++i) {
            const v0 = val[i];
            const v1 = applyReviver(reviver, val, String(i), v0);
            if (v1 === void 0)
              delete val[i];
            else if (v1 !== v0)
              val[i] = v1;
          }
        } else if (val instanceof Map) {
          for (const k of Array.from(val.keys())) {
            const v0 = val.get(k);
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              val.delete(k);
            else if (v1 !== v0)
              val.set(k, v1);
          }
        } else if (val instanceof Set) {
          for (const v0 of Array.from(val)) {
            const v1 = applyReviver(reviver, val, v0, v0);
            if (v1 === void 0)
              val.delete(v0);
            else if (v1 !== v0) {
              val.delete(v0);
              val.add(v1);
            }
          }
        } else {
          for (const [k, v0] of Object.entries(val)) {
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              delete val[k];
            else if (v1 !== v0)
              val[k] = v1;
          }
        }
      }
      return reviver.call(obj, key, val);
    }
    __name(applyReviver, "applyReviver");
    exports.applyReviver = applyReviver;
  }
});

// node_modules/yaml/dist/nodes/toJS.js
var require_toJS = __commonJS({
  "node_modules/yaml/dist/nodes/toJS.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var identity = require_identity();
    function toJS(value, arg, ctx) {
      if (Array.isArray(value))
        return value.map((v, i) => toJS(v, String(i), ctx));
      if (value && typeof value.toJSON === "function") {
        if (!ctx || !identity.hasAnchor(value))
          return value.toJSON(arg, ctx);
        const data = { aliasCount: 0, count: 1, res: void 0 };
        ctx.anchors.set(value, data);
        ctx.onCreate = (res2) => {
          data.res = res2;
          delete ctx.onCreate;
        };
        const res = value.toJSON(arg, ctx);
        if (ctx.onCreate)
          ctx.onCreate(res);
        return res;
      }
      if (typeof value === "bigint" && !ctx?.keep)
        return Number(value);
      return value;
    }
    __name(toJS, "toJS");
    exports.toJS = toJS;
  }
});

// node_modules/yaml/dist/nodes/Node.js
var require_Node = __commonJS({
  "node_modules/yaml/dist/nodes/Node.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var applyReviver = require_applyReviver();
    var identity = require_identity();
    var toJS = require_toJS();
    var NodeBase = class {
      static {
        __name(this, "NodeBase");
      }
      constructor(type) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: type });
      }
      /** Create a copy of this node.  */
      clone() {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** A plain JavaScript representation of this node. */
      toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        if (!identity.isDocument(doc))
          throw new TypeError("A document argument is required");
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc,
          keep: true,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this, "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
    };
    exports.NodeBase = NodeBase;
  }
});

// node_modules/yaml/dist/nodes/Alias.js
var require_Alias = __commonJS({
  "node_modules/yaml/dist/nodes/Alias.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var anchors = require_anchors();
    var visit = require_visit();
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var Alias = class extends Node.NodeBase {
      static {
        __name(this, "Alias");
      }
      constructor(source) {
        super(identity.ALIAS);
        this.source = source;
        Object.defineProperty(this, "tag", {
          set() {
            throw new Error("Alias nodes cannot have tags");
          }
        });
      }
      /**
       * Resolve the value of this alias within `doc`, finding the last
       * instance of the `source` anchor before this node.
       */
      resolve(doc, ctx) {
        if (ctx?.maxAliasCount === 0)
          throw new ReferenceError("Alias resolution is disabled");
        let nodes;
        if (ctx?.aliasResolveCache) {
          nodes = ctx.aliasResolveCache;
        } else {
          nodes = [];
          visit.visit(doc, {
            Node: /* @__PURE__ */ __name((_key, node) => {
              if (identity.isAlias(node) || identity.hasAnchor(node))
                nodes.push(node);
            }, "Node")
          });
          if (ctx)
            ctx.aliasResolveCache = nodes;
        }
        let found = void 0;
        for (const node of nodes) {
          if (node === this)
            break;
          if (node.anchor === this.source)
            found = node;
        }
        return found;
      }
      toJSON(_arg, ctx) {
        if (!ctx)
          return { source: this.source };
        const { anchors: anchors2, doc, maxAliasCount } = ctx;
        const source = this.resolve(doc, ctx);
        if (!source) {
          const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
          throw new ReferenceError(msg);
        }
        let data = anchors2.get(source);
        if (!data) {
          toJS.toJS(source, null, ctx);
          data = anchors2.get(source);
        }
        if (data?.res === void 0) {
          const msg = "This should not happen: Alias anchor was not resolved?";
          throw new ReferenceError(msg);
        }
        if (maxAliasCount >= 0) {
          data.count += 1;
          if (data.aliasCount === 0)
            data.aliasCount = getAliasCount(doc, source, anchors2);
          if (data.count * data.aliasCount > maxAliasCount) {
            const msg = "Excessive alias count indicates a resource exhaustion attack";
            throw new ReferenceError(msg);
          }
        }
        return data.res;
      }
      toString(ctx, _onComment, _onChompKeep) {
        const src = `*${this.source}`;
        if (ctx) {
          anchors.anchorIsValid(this.source);
          if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
            const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
            throw new Error(msg);
          }
          if (ctx.implicitKey)
            return `${src} `;
        }
        return src;
      }
    };
    function getAliasCount(doc, node, anchors2) {
      if (identity.isAlias(node)) {
        const source = node.resolve(doc);
        const anchor = anchors2 && source && anchors2.get(source);
        return anchor ? anchor.count * anchor.aliasCount : 0;
      } else if (identity.isCollection(node)) {
        let count = 0;
        for (const item of node.items) {
          const c = getAliasCount(doc, item, anchors2);
          if (c > count)
            count = c;
        }
        return count;
      } else if (identity.isPair(node)) {
        const kc = getAliasCount(doc, node.key, anchors2);
        const vc = getAliasCount(doc, node.value, anchors2);
        return Math.max(kc, vc);
      }
      return 1;
    }
    __name(getAliasCount, "getAliasCount");
    exports.Alias = Alias;
  }
});

// node_modules/yaml/dist/nodes/Scalar.js
var require_Scalar = __commonJS({
  "node_modules/yaml/dist/nodes/Scalar.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var isScalarValue = /* @__PURE__ */ __name((value) => !value || typeof value !== "function" && typeof value !== "object", "isScalarValue");
    var Scalar = class extends Node.NodeBase {
      static {
        __name(this, "Scalar");
      }
      constructor(value) {
        super(identity.SCALAR);
        this.value = value;
      }
      toJSON(arg, ctx) {
        return ctx?.keep ? this.value : toJS.toJS(this.value, arg, ctx);
      }
      toString() {
        return String(this.value);
      }
    };
    Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
    Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
    Scalar.PLAIN = "PLAIN";
    Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
    Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";
    exports.Scalar = Scalar;
    exports.isScalarValue = isScalarValue;
  }
});

// node_modules/yaml/dist/doc/createNode.js
var require_createNode = __commonJS({
  "node_modules/yaml/dist/doc/createNode.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var Alias = require_Alias();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var defaultTagPrefix = "tag:yaml.org,2002:";
    function findTagObject(value, tagName, tags) {
      if (tagName) {
        const match = tags.filter((t) => t.tag === tagName);
        const tagObj = match.find((t) => !t.format) ?? match[0];
        if (!tagObj)
          throw new Error(`Tag ${tagName} not found`);
        return tagObj;
      }
      return tags.find((t) => t.identify?.(value) && !t.format);
    }
    __name(findTagObject, "findTagObject");
    function createNode(value, tagName, ctx) {
      if (identity.isDocument(value))
        value = value.contents;
      if (identity.isNode(value))
        return value;
      if (identity.isPair(value)) {
        const map = ctx.schema[identity.MAP].createNode?.(ctx.schema, null, ctx);
        map.items.push(value);
        return map;
      }
      if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
        value = value.valueOf();
      }
      const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
      let ref = void 0;
      if (aliasDuplicateObjects && value && typeof value === "object") {
        ref = sourceObjects.get(value);
        if (ref) {
          ref.anchor ?? (ref.anchor = onAnchor(value));
          return new Alias.Alias(ref.anchor);
        } else {
          ref = { anchor: null, node: null };
          sourceObjects.set(value, ref);
        }
      }
      if (tagName?.startsWith("!!"))
        tagName = defaultTagPrefix + tagName.slice(2);
      let tagObj = findTagObject(value, tagName, schema.tags);
      if (!tagObj) {
        if (value && typeof value.toJSON === "function") {
          value = value.toJSON();
        }
        if (!value || typeof value !== "object") {
          const node2 = new Scalar.Scalar(value);
          if (ref)
            ref.node = node2;
          return node2;
        }
        tagObj = value instanceof Map ? schema[identity.MAP] : Symbol.iterator in Object(value) ? schema[identity.SEQ] : schema[identity.MAP];
      }
      if (onTagObj) {
        onTagObj(tagObj);
        delete ctx.onTagObj;
      }
      const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar.Scalar(value);
      if (tagName)
        node.tag = tagName;
      else if (!tagObj.default)
        node.tag = tagObj.tag;
      if (ref)
        ref.node = node;
      return node;
    }
    __name(createNode, "createNode");
    exports.createNode = createNode;
  }
});

// node_modules/yaml/dist/nodes/Collection.js
var require_Collection = __commonJS({
  "node_modules/yaml/dist/nodes/Collection.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var createNode = require_createNode();
    var identity = require_identity();
    var Node = require_Node();
    function collectionFromPath(schema, path3, value) {
      let v = value;
      for (let i = path3.length - 1; i >= 0; --i) {
        const k = path3[i];
        if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
          const a = [];
          a[k] = v;
          v = a;
        } else {
          v = /* @__PURE__ */ new Map([[k, v]]);
        }
      }
      return createNode.createNode(v, void 0, {
        aliasDuplicateObjects: false,
        keepUndefined: false,
        onAnchor: /* @__PURE__ */ __name(() => {
          throw new Error("This should not happen, please report a bug.");
        }, "onAnchor"),
        schema,
        sourceObjects: /* @__PURE__ */ new Map()
      });
    }
    __name(collectionFromPath, "collectionFromPath");
    var isEmptyPath = /* @__PURE__ */ __name((path3) => path3 == null || typeof path3 === "object" && !!path3[Symbol.iterator]().next().done, "isEmptyPath");
    var Collection = class extends Node.NodeBase {
      static {
        __name(this, "Collection");
      }
      constructor(type, schema) {
        super(type);
        Object.defineProperty(this, "schema", {
          value: schema,
          configurable: true,
          enumerable: false,
          writable: true
        });
      }
      /**
       * Create a copy of this collection.
       *
       * @param schema - If defined, overwrites the original's schema
       */
      clone(schema) {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (schema)
          copy.schema = schema;
        copy.items = copy.items.map((it) => identity.isNode(it) || identity.isPair(it) ? it.clone(schema) : it);
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /**
       * Adds a value to the collection. For `!!map` and `!!omap` the value must
       * be a Pair instance or a `{ key, value }` object, which may not have a key
       * that already exists in the map.
       */
      addIn(path3, value) {
        if (isEmptyPath(path3))
          this.add(value);
        else {
          const [key, ...rest] = path3;
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.addIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
      /**
       * Removes a value from the collection.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path3) {
        const [key, ...rest] = path3;
        if (rest.length === 0)
          return this.delete(key);
        const node = this.get(key, true);
        if (identity.isCollection(node))
          return node.deleteIn(rest);
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path3, keepScalar) {
        const [key, ...rest] = path3;
        const node = this.get(key, true);
        if (rest.length === 0)
          return !keepScalar && identity.isScalar(node) ? node.value : node;
        else
          return identity.isCollection(node) ? node.getIn(rest, keepScalar) : void 0;
      }
      hasAllNullValues(allowScalar) {
        return this.items.every((node) => {
          if (!identity.isPair(node))
            return false;
          const n = node.value;
          return n == null || allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
        });
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       */
      hasIn(path3) {
        const [key, ...rest] = path3;
        if (rest.length === 0)
          return this.has(key);
        const node = this.get(key, true);
        return identity.isCollection(node) ? node.hasIn(rest) : false;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path3, value) {
        const [key, ...rest] = path3;
        if (rest.length === 0) {
          this.set(key, value);
        } else {
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.setIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
    };
    exports.Collection = Collection;
    exports.collectionFromPath = collectionFromPath;
    exports.isEmptyPath = isEmptyPath;
  }
});

// node_modules/yaml/dist/stringify/stringifyComment.js
var require_stringifyComment = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyComment.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var stringifyComment = /* @__PURE__ */ __name((str) => str.replace(/^(?!$)(?: $)?/gm, "#"), "stringifyComment");
    function indentComment(comment, indent) {
      if (/^\n+$/.test(comment))
        return comment.substring(1);
      return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
    }
    __name(indentComment, "indentComment");
    var lineComment = /* @__PURE__ */ __name((str, indent, comment) => str.endsWith("\n") ? indentComment(comment, indent) : comment.includes("\n") ? "\n" + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment, "lineComment");
    exports.indentComment = indentComment;
    exports.lineComment = lineComment;
    exports.stringifyComment = stringifyComment;
  }
});

// node_modules/yaml/dist/stringify/foldFlowLines.js
var require_foldFlowLines = __commonJS({
  "node_modules/yaml/dist/stringify/foldFlowLines.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var FOLD_FLOW = "flow";
    var FOLD_BLOCK = "block";
    var FOLD_QUOTED = "quoted";
    function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
      if (!lineWidth || lineWidth < 0)
        return text;
      if (lineWidth < minContentWidth)
        minContentWidth = 0;
      const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
      if (text.length <= endStep)
        return text;
      const folds = [];
      const escapedFolds = {};
      let end = lineWidth - indent.length;
      if (typeof indentAtStart === "number") {
        if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
          folds.push(0);
        else
          end = lineWidth - indentAtStart;
      }
      let split = void 0;
      let prev = void 0;
      let overflow = false;
      let i = -1;
      let escStart = -1;
      let escEnd = -1;
      if (mode === FOLD_BLOCK) {
        i = consumeMoreIndentedLines(text, i, indent.length);
        if (i !== -1)
          end = i + endStep;
      }
      for (let ch; ch = text[i += 1]; ) {
        if (mode === FOLD_QUOTED && ch === "\\") {
          escStart = i;
          switch (text[i + 1]) {
            case "x":
              i += 3;
              break;
            case "u":
              i += 5;
              break;
            case "U":
              i += 9;
              break;
            default:
              i += 1;
          }
          escEnd = i;
        }
        if (ch === "\n") {
          if (mode === FOLD_BLOCK)
            i = consumeMoreIndentedLines(text, i, indent.length);
          end = i + indent.length + endStep;
          split = void 0;
        } else {
          if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
            const next = text[i + 1];
            if (next && next !== " " && next !== "\n" && next !== "	")
              split = i;
          }
          if (i >= end) {
            if (split) {
              folds.push(split);
              end = split + endStep;
              split = void 0;
            } else if (mode === FOLD_QUOTED) {
              while (prev === " " || prev === "	") {
                prev = ch;
                ch = text[i += 1];
                overflow = true;
              }
              const j = i > escEnd + 1 ? i - 2 : escStart - 1;
              if (escapedFolds[j])
                return text;
              folds.push(j);
              escapedFolds[j] = true;
              end = j + endStep;
              split = void 0;
            } else {
              overflow = true;
            }
          }
        }
        prev = ch;
      }
      if (overflow && onOverflow)
        onOverflow();
      if (folds.length === 0)
        return text;
      if (onFold)
        onFold();
      let res = text.slice(0, folds[0]);
      for (let i2 = 0; i2 < folds.length; ++i2) {
        const fold = folds[i2];
        const end2 = folds[i2 + 1] || text.length;
        if (fold === 0)
          res = `
${indent}${text.slice(0, end2)}`;
        else {
          if (mode === FOLD_QUOTED && escapedFolds[fold])
            res += `${text[fold]}\\`;
          res += `
${indent}${text.slice(fold + 1, end2)}`;
        }
      }
      return res;
    }
    __name(foldFlowLines, "foldFlowLines");
    function consumeMoreIndentedLines(text, i, indent) {
      let end = i;
      let start = i + 1;
      let ch = text[start];
      while (ch === " " || ch === "	") {
        if (i < start + indent) {
          ch = text[++i];
        } else {
          do {
            ch = text[++i];
          } while (ch && ch !== "\n");
          end = i;
          start = i + 1;
          ch = text[start];
        }
      }
      return end;
    }
    __name(consumeMoreIndentedLines, "consumeMoreIndentedLines");
    exports.FOLD_BLOCK = FOLD_BLOCK;
    exports.FOLD_FLOW = FOLD_FLOW;
    exports.FOLD_QUOTED = FOLD_QUOTED;
    exports.foldFlowLines = foldFlowLines;
  }
});

// node_modules/yaml/dist/stringify/stringifyString.js
var require_stringifyString = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyString.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var Scalar = require_Scalar();
    var foldFlowLines = require_foldFlowLines();
    var getFoldOptions = /* @__PURE__ */ __name((ctx, isBlock) => ({
      indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
      lineWidth: ctx.options.lineWidth,
      minContentWidth: ctx.options.minContentWidth
    }), "getFoldOptions");
    var containsDocumentMarker = /* @__PURE__ */ __name((str) => /^(%|---|\.\.\.)/m.test(str), "containsDocumentMarker");
    function lineLengthOverLimit(str, lineWidth, indentLength) {
      if (!lineWidth || lineWidth < 0)
        return false;
      const limit = lineWidth - indentLength;
      const strLen = str.length;
      if (strLen <= limit)
        return false;
      for (let i = 0, start = 0; i < strLen; ++i) {
        if (str[i] === "\n") {
          if (i - start > limit)
            return true;
          start = i + 1;
          if (strLen - start <= limit)
            return false;
        }
      }
      return true;
    }
    __name(lineLengthOverLimit, "lineLengthOverLimit");
    function doubleQuotedString(value, ctx) {
      const json = JSON.stringify(value);
      if (ctx.options.doubleQuotedAsJSON)
        return json;
      const { implicitKey } = ctx;
      const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      let str = "";
      let start = 0;
      for (let i = 0, ch = json[i]; ch; ch = json[++i]) {
        if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
          str += json.slice(start, i) + "\\ ";
          i += 1;
          start = i;
          ch = "\\";
        }
        if (ch === "\\")
          switch (json[i + 1]) {
            case "u":
              {
                str += json.slice(start, i);
                const code = json.substr(i + 2, 4);
                switch (code) {
                  case "0000":
                    str += "\\0";
                    break;
                  case "0007":
                    str += "\\a";
                    break;
                  case "000b":
                    str += "\\v";
                    break;
                  case "001b":
                    str += "\\e";
                    break;
                  case "0085":
                    str += "\\N";
                    break;
                  case "00a0":
                    str += "\\_";
                    break;
                  case "2028":
                    str += "\\L";
                    break;
                  case "2029":
                    str += "\\P";
                    break;
                  default:
                    if (code.substr(0, 2) === "00")
                      str += "\\x" + code.substr(2);
                    else
                      str += json.substr(i, 6);
                }
                i += 5;
                start = i + 1;
              }
              break;
            case "n":
              if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
                i += 1;
              } else {
                str += json.slice(start, i) + "\n\n";
                while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
                  str += "\n";
                  i += 2;
                }
                str += indent;
                if (json[i + 2] === " ")
                  str += "\\";
                i += 1;
                start = i + 1;
              }
              break;
            default:
              i += 1;
          }
      }
      str = start ? str + json.slice(start) : json;
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
    }
    __name(doubleQuotedString, "doubleQuotedString");
    function singleQuotedString(value, ctx) {
      if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes("\n") || /[ \t]\n|\n[ \t]/.test(value))
        return doubleQuotedString(value, ctx);
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
      return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    __name(singleQuotedString, "singleQuotedString");
    function quotedString(value, ctx) {
      const { singleQuote } = ctx.options;
      let qs;
      if (singleQuote === false)
        qs = doubleQuotedString;
      else {
        const hasDouble = value.includes('"');
        const hasSingle = value.includes("'");
        if (hasDouble && !hasSingle)
          qs = singleQuotedString;
        else if (hasSingle && !hasDouble)
          qs = doubleQuotedString;
        else
          qs = singleQuote ? singleQuotedString : doubleQuotedString;
      }
      return qs(value, ctx);
    }
    __name(quotedString, "quotedString");
    var blockEndNewlines;
    try {
      blockEndNewlines = new RegExp("(^|(?<!\n))\n+(?!\n|$)", "g");
    } catch {
      blockEndNewlines = /\n+(?!\n|$)/g;
    }
    function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
      const { blockQuote, commentString, lineWidth } = ctx.options;
      if (!blockQuote || /\n[\t ]+$/.test(value)) {
        return quotedString(value, ctx);
      }
      const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
      const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.Scalar.BLOCK_FOLDED ? false : type === Scalar.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
      if (!value)
        return literal ? "|\n" : ">\n";
      let chomp;
      let endStart;
      for (endStart = value.length; endStart > 0; --endStart) {
        const ch = value[endStart - 1];
        if (ch !== "\n" && ch !== "	" && ch !== " ")
          break;
      }
      let end = value.substring(endStart);
      const endNlPos = end.indexOf("\n");
      if (endNlPos === -1) {
        chomp = "-";
      } else if (value === end || endNlPos !== end.length - 1) {
        chomp = "+";
        if (onChompKeep)
          onChompKeep();
      } else {
        chomp = "";
      }
      if (end) {
        value = value.slice(0, -end.length);
        if (end[end.length - 1] === "\n")
          end = end.slice(0, -1);
        end = end.replace(blockEndNewlines, `$&${indent}`);
      }
      let startWithSpace = false;
      let startEnd;
      let startNlPos = -1;
      for (startEnd = 0; startEnd < value.length; ++startEnd) {
        const ch = value[startEnd];
        if (ch === " ")
          startWithSpace = true;
        else if (ch === "\n")
          startNlPos = startEnd;
        else
          break;
      }
      let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
      if (start) {
        value = value.substring(start.length);
        start = start.replace(/\n+/g, `$&${indent}`);
      }
      const indentSize = indent ? "2" : "1";
      let header = (startWithSpace ? indentSize : "") + chomp;
      if (comment) {
        header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
        if (onComment)
          onComment();
      }
      if (!literal) {
        const foldedValue = value.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
        let literalFallback = false;
        const foldOptions = getFoldOptions(ctx, true);
        if (blockQuote !== "folded" && type !== Scalar.Scalar.BLOCK_FOLDED) {
          foldOptions.onOverflow = () => {
            literalFallback = true;
          };
        }
        const body = foldFlowLines.foldFlowLines(`${start}${foldedValue}${end}`, indent, foldFlowLines.FOLD_BLOCK, foldOptions);
        if (!literalFallback)
          return `>${header}
${indent}${body}`;
      }
      value = value.replace(/\n+/g, `$&${indent}`);
      return `|${header}
${indent}${start}${value}${end}`;
    }
    __name(blockString, "blockString");
    function plainString(item, ctx, onComment, onChompKeep) {
      const { type, value } = item;
      const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
      if (implicitKey && value.includes("\n") || inFlow && /[[\]{},]/.test(value)) {
        return quotedString(value, ctx);
      }
      if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
        return implicitKey || inFlow || !value.includes("\n") ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
      }
      if (!implicitKey && !inFlow && type !== Scalar.Scalar.PLAIN && value.includes("\n")) {
        return blockString(item, ctx, onComment, onChompKeep);
      }
      if (containsDocumentMarker(value)) {
        if (indent === "") {
          ctx.forceBlockIndent = true;
          return blockString(item, ctx, onComment, onChompKeep);
        } else if (implicitKey && indent === indentStep) {
          return quotedString(value, ctx);
        }
      }
      const str = value.replace(/\n+/g, `$&
${indent}`);
      if (actualString) {
        const test = /* @__PURE__ */ __name((tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str), "test");
        const { compat, tags } = ctx.doc.schema;
        if (tags.some(test) || compat?.some(test))
          return quotedString(value, ctx);
      }
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    __name(plainString, "plainString");
    function stringifyString(item, ctx, onComment, onChompKeep) {
      const { implicitKey, inFlow } = ctx;
      const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
      let { type } = item;
      if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
        if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
          type = Scalar.Scalar.QUOTE_DOUBLE;
      }
      const _stringify = /* @__PURE__ */ __name((_type) => {
        switch (_type) {
          case Scalar.Scalar.BLOCK_FOLDED:
          case Scalar.Scalar.BLOCK_LITERAL:
            return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
          case Scalar.Scalar.QUOTE_DOUBLE:
            return doubleQuotedString(ss.value, ctx);
          case Scalar.Scalar.QUOTE_SINGLE:
            return singleQuotedString(ss.value, ctx);
          case Scalar.Scalar.PLAIN:
            return plainString(ss, ctx, onComment, onChompKeep);
          default:
            return null;
        }
      }, "_stringify");
      let res = _stringify(type);
      if (res === null) {
        const { defaultKeyType, defaultStringType } = ctx.options;
        const t = implicitKey && defaultKeyType || defaultStringType;
        res = _stringify(t);
        if (res === null)
          throw new Error(`Unsupported default string type ${t}`);
      }
      return res;
    }
    __name(stringifyString, "stringifyString");
    exports.stringifyString = stringifyString;
  }
});

// node_modules/yaml/dist/stringify/stringify.js
var require_stringify = __commonJS({
  "node_modules/yaml/dist/stringify/stringify.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var anchors = require_anchors();
    var identity = require_identity();
    var stringifyComment = require_stringifyComment();
    var stringifyString = require_stringifyString();
    function createStringifyContext(doc, options) {
      const opt = Object.assign({
        blockQuote: true,
        commentString: stringifyComment.stringifyComment,
        defaultKeyType: null,
        defaultStringType: "PLAIN",
        directives: null,
        doubleQuotedAsJSON: false,
        doubleQuotedMinMultiLineLength: 40,
        falseStr: "false",
        flowCollectionPadding: true,
        indentSeq: true,
        lineWidth: 80,
        minContentWidth: 20,
        nullStr: "null",
        simpleKeys: false,
        singleQuote: null,
        trailingComma: false,
        trueStr: "true",
        verifyAliasOrder: true
      }, doc.schema.toStringOptions, options);
      let inFlow;
      switch (opt.collectionStyle) {
        case "block":
          inFlow = false;
          break;
        case "flow":
          inFlow = true;
          break;
        default:
          inFlow = null;
      }
      return {
        anchors: /* @__PURE__ */ new Set(),
        doc,
        flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
        indent: "",
        indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
        inFlow,
        options: opt
      };
    }
    __name(createStringifyContext, "createStringifyContext");
    function getTagObject(tags, item) {
      if (item.tag) {
        const match = tags.filter((t) => t.tag === item.tag);
        if (match.length > 0)
          return match.find((t) => t.format === item.format) ?? match[0];
      }
      let tagObj = void 0;
      let obj;
      if (identity.isScalar(item)) {
        obj = item.value;
        let match = tags.filter((t) => t.identify?.(obj));
        if (match.length > 1) {
          const testMatch = match.filter((t) => t.test);
          if (testMatch.length > 0)
            match = testMatch;
        }
        tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
      } else {
        obj = item;
        tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
      }
      if (!tagObj) {
        const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
        throw new Error(`Tag not resolved for ${name} value`);
      }
      return tagObj;
    }
    __name(getTagObject, "getTagObject");
    function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
      if (!doc.directives)
        return "";
      const props = [];
      const anchor = (identity.isScalar(node) || identity.isCollection(node)) && node.anchor;
      if (anchor && anchors.anchorIsValid(anchor)) {
        anchors$1.add(anchor);
        props.push(`&${anchor}`);
      }
      const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
      if (tag)
        props.push(doc.directives.tagString(tag));
      return props.join(" ");
    }
    __name(stringifyProps, "stringifyProps");
    function stringify3(item, ctx, onComment, onChompKeep) {
      if (identity.isPair(item))
        return item.toString(ctx, onComment, onChompKeep);
      if (identity.isAlias(item)) {
        if (ctx.doc.directives)
          return item.toString(ctx);
        if (ctx.resolvedAliases?.has(item)) {
          throw new TypeError(`Cannot stringify circular structure without alias nodes`);
        } else {
          if (ctx.resolvedAliases)
            ctx.resolvedAliases.add(item);
          else
            ctx.resolvedAliases = /* @__PURE__ */ new Set([item]);
          item = item.resolve(ctx.doc);
        }
      }
      let tagObj = void 0;
      const node = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: /* @__PURE__ */ __name((o) => tagObj = o, "onTagObj") });
      tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
      const props = stringifyProps(node, tagObj, ctx);
      if (props.length > 0)
        ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
      const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity.isScalar(node) ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
      if (!props)
        return str;
      return identity.isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
    }
    __name(stringify3, "stringify");
    exports.createStringifyContext = createStringifyContext;
    exports.stringify = stringify3;
  }
});

// node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyPair.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var stringify3 = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
      const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
      let keyComment = identity.isNode(key) && key.comment || null;
      if (simpleKeys) {
        if (keyComment) {
          throw new Error("With simple keys, key nodes cannot have comments");
        }
        if (identity.isCollection(key) || !identity.isNode(key) && typeof key === "object") {
          const msg = "With simple keys, collection cannot be used as a key value";
          throw new Error(msg);
        }
      }
      let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || identity.isCollection(key) || (identity.isScalar(key) ? key.type === Scalar.Scalar.BLOCK_FOLDED || key.type === Scalar.Scalar.BLOCK_LITERAL : typeof key === "object"));
      ctx = Object.assign({}, ctx, {
        allNullValues: false,
        implicitKey: !explicitKey && (simpleKeys || !allNullValues),
        indent: indent + indentStep
      });
      let keyCommentDone = false;
      let chompKeep = false;
      let str = stringify3.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
      if (!explicitKey && !ctx.inFlow && str.length > 1024) {
        if (simpleKeys)
          throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
        explicitKey = true;
      }
      if (ctx.inFlow) {
        if (allNullValues || value == null) {
          if (keyCommentDone && onComment)
            onComment();
          return str === "" ? "?" : explicitKey ? `? ${str}` : str;
        }
      } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
        str = `? ${str}`;
        if (keyComment && !keyCommentDone) {
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        } else if (chompKeep && onChompKeep)
          onChompKeep();
        return str;
      }
      if (keyCommentDone)
        keyComment = null;
      if (explicitKey) {
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        str = `? ${str}
${indent}:`;
      } else {
        str = `${str}:`;
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      }
      let vsb, vcb, valueComment;
      if (identity.isNode(value)) {
        vsb = !!value.spaceBefore;
        vcb = value.commentBefore;
        valueComment = value.comment;
      } else {
        vsb = false;
        vcb = null;
        valueComment = null;
        if (value && typeof value === "object")
          value = doc.createNode(value);
      }
      ctx.implicitKey = false;
      if (!explicitKey && !keyComment && identity.isScalar(value))
        ctx.indentAtStart = str.length + 1;
      chompKeep = false;
      if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity.isSeq(value) && !value.flow && !value.tag && !value.anchor) {
        ctx.indent = ctx.indent.substring(2);
      }
      let valueCommentDone = false;
      const valueStr = stringify3.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
      let ws = " ";
      if (keyComment || vsb || vcb) {
        ws = vsb ? "\n" : "";
        if (vcb) {
          const cs = commentString(vcb);
          ws += `
${stringifyComment.indentComment(cs, ctx.indent)}`;
        }
        if (valueStr === "" && !ctx.inFlow) {
          if (ws === "\n" && valueComment)
            ws = "\n\n";
        } else {
          ws += `
${ctx.indent}`;
        }
      } else if (!explicitKey && identity.isCollection(value)) {
        const vs0 = valueStr[0];
        const nl0 = valueStr.indexOf("\n");
        const hasNewline = nl0 !== -1;
        const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
        if (hasNewline || !flow) {
          let hasPropsLine = false;
          if (hasNewline && (vs0 === "&" || vs0 === "!")) {
            let sp0 = valueStr.indexOf(" ");
            if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
              sp0 = valueStr.indexOf(" ", sp0 + 1);
            }
            if (sp0 === -1 || nl0 < sp0)
              hasPropsLine = true;
          }
          if (!hasPropsLine)
            ws = `
${ctx.indent}`;
        }
      } else if (valueStr === "" || valueStr[0] === "\n") {
        ws = "";
      }
      str += ws + valueStr;
      if (ctx.inFlow) {
        if (valueCommentDone && onComment)
          onComment();
      } else if (valueComment && !valueCommentDone) {
        str += stringifyComment.lineComment(str, ctx.indent, commentString(valueComment));
      } else if (chompKeep && onChompKeep) {
        onChompKeep();
      }
      return str;
    }
    __name(stringifyPair, "stringifyPair");
    exports.stringifyPair = stringifyPair;
  }
});

// node_modules/yaml/dist/log.js
var require_log = __commonJS({
  "node_modules/yaml/dist/log.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var node_process = __require("process");
    function debug(logLevel, ...messages) {
      if (logLevel === "debug")
        console.log(...messages);
    }
    __name(debug, "debug");
    function warn2(logLevel, warning) {
      if (logLevel === "debug" || logLevel === "warn") {
        if (typeof node_process.emitWarning === "function")
          node_process.emitWarning(warning);
        else
          console.warn(warning);
      }
    }
    __name(warn2, "warn");
    exports.debug = debug;
    exports.warn = warn2;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/merge.js
var require_merge = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/merge.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var MERGE_KEY = "<<";
    var merge = {
      identify: /* @__PURE__ */ __name((value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY, "identify"),
      default: "key",
      tag: "tag:yaml.org,2002:merge",
      test: /^<<$/,
      resolve: /* @__PURE__ */ __name(() => Object.assign(new Scalar.Scalar(Symbol(MERGE_KEY)), {
        addToJSMap: addMergeToJSMap
      }), "resolve"),
      stringify: /* @__PURE__ */ __name(() => MERGE_KEY, "stringify")
    };
    var isMergeKey = /* @__PURE__ */ __name((ctx, key) => (merge.identify(key) || identity.isScalar(key) && (!key.type || key.type === Scalar.Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default), "isMergeKey");
    function addMergeToJSMap(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (identity.isSeq(source))
        for (const it of source.items)
          mergeValue(ctx, map, it);
      else if (Array.isArray(source))
        for (const it of source)
          mergeValue(ctx, map, it);
      else
        mergeValue(ctx, map, source);
    }
    __name(addMergeToJSMap, "addMergeToJSMap");
    function mergeValue(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (!identity.isMap(source))
        throw new Error("Merge sources must be maps or map aliases");
      const srcMap = source.toJSON(null, ctx, Map);
      for (const [key, value2] of srcMap) {
        if (map instanceof Map) {
          if (!map.has(key))
            map.set(key, value2);
        } else if (map instanceof Set) {
          map.add(key);
        } else if (!Object.prototype.hasOwnProperty.call(map, key)) {
          Object.defineProperty(map, key, {
            value: value2,
            writable: true,
            enumerable: true,
            configurable: true
          });
        }
      }
      return map;
    }
    __name(mergeValue, "mergeValue");
    function resolveAliasValue(ctx, value) {
      return ctx && identity.isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
    }
    __name(resolveAliasValue, "resolveAliasValue");
    exports.addMergeToJSMap = addMergeToJSMap;
    exports.isMergeKey = isMergeKey;
    exports.merge = merge;
  }
});

// node_modules/yaml/dist/nodes/addPairToJSMap.js
var require_addPairToJSMap = __commonJS({
  "node_modules/yaml/dist/nodes/addPairToJSMap.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var log = require_log();
    var merge = require_merge();
    var stringify3 = require_stringify();
    var identity = require_identity();
    var toJS = require_toJS();
    function addPairToJSMap(ctx, map, { key, value }) {
      if (identity.isNode(key) && key.addToJSMap)
        key.addToJSMap(ctx, map, value);
      else if (merge.isMergeKey(ctx, key))
        merge.addMergeToJSMap(ctx, map, value);
      else {
        const jsKey = toJS.toJS(key, "", ctx);
        if (map instanceof Map) {
          map.set(jsKey, toJS.toJS(value, jsKey, ctx));
        } else if (map instanceof Set) {
          map.add(jsKey);
        } else {
          const stringKey = stringifyKey(key, jsKey, ctx);
          const jsValue = toJS.toJS(value, stringKey, ctx);
          if (stringKey in map)
            Object.defineProperty(map, stringKey, {
              value: jsValue,
              writable: true,
              enumerable: true,
              configurable: true
            });
          else
            map[stringKey] = jsValue;
        }
      }
      return map;
    }
    __name(addPairToJSMap, "addPairToJSMap");
    function stringifyKey(key, jsKey, ctx) {
      if (jsKey === null)
        return "";
      if (typeof jsKey !== "object")
        return String(jsKey);
      if (identity.isNode(key) && ctx?.doc) {
        const strCtx = stringify3.createStringifyContext(ctx.doc, {});
        strCtx.anchors = /* @__PURE__ */ new Set();
        for (const node of ctx.anchors.keys())
          strCtx.anchors.add(node.anchor);
        strCtx.inFlow = true;
        strCtx.inStringifyKey = true;
        const strKey = key.toString(strCtx);
        if (!ctx.mapKeyWarned) {
          let jsonStr = JSON.stringify(strKey);
          if (jsonStr.length > 40)
            jsonStr = jsonStr.substring(0, 36) + '..."';
          log.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
          ctx.mapKeyWarned = true;
        }
        return strKey;
      }
      return JSON.stringify(jsKey);
    }
    __name(stringifyKey, "stringifyKey");
    exports.addPairToJSMap = addPairToJSMap;
  }
});

// node_modules/yaml/dist/nodes/Pair.js
var require_Pair = __commonJS({
  "node_modules/yaml/dist/nodes/Pair.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var createNode = require_createNode();
    var stringifyPair = require_stringifyPair();
    var addPairToJSMap = require_addPairToJSMap();
    var identity = require_identity();
    function createPair(key, value, ctx) {
      const k = createNode.createNode(key, void 0, ctx);
      const v = createNode.createNode(value, void 0, ctx);
      return new Pair(k, v);
    }
    __name(createPair, "createPair");
    var Pair = class _Pair {
      static {
        __name(this, "Pair");
      }
      constructor(key, value = null) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.PAIR });
        this.key = key;
        this.value = value;
      }
      clone(schema) {
        let { key, value } = this;
        if (identity.isNode(key))
          key = key.clone(schema);
        if (identity.isNode(value))
          value = value.clone(schema);
        return new _Pair(key, value);
      }
      toJSON(_, ctx) {
        const pair = ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        return addPairToJSMap.addPairToJSMap(ctx, pair, this);
      }
      toString(ctx, onComment, onChompKeep) {
        return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
      }
    };
    exports.Pair = Pair;
    exports.createPair = createPair;
  }
});

// node_modules/yaml/dist/stringify/stringifyCollection.js
var require_stringifyCollection = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyCollection.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var identity = require_identity();
    var stringify3 = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyCollection(collection, ctx, options) {
      const flow = ctx.inFlow ?? collection.flow;
      const stringify4 = flow ? stringifyFlowCollection : stringifyBlockCollection;
      return stringify4(collection, ctx, options);
    }
    __name(stringifyCollection, "stringifyCollection");
    function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
      const { indent, options: { commentString } } = ctx;
      const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
      let chompKeep = false;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment2 = null;
        if (identity.isNode(item)) {
          if (!chompKeep && item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
          if (item.comment)
            comment2 = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (!chompKeep && ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
          }
        }
        chompKeep = false;
        let str2 = stringify3.stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
        if (comment2)
          str2 += stringifyComment.lineComment(str2, itemIndent, commentString(comment2));
        if (chompKeep && comment2)
          chompKeep = false;
        lines.push(blockItemPrefix + str2);
      }
      let str;
      if (lines.length === 0) {
        str = flowChars.start + flowChars.end;
      } else {
        str = lines[0];
        for (let i = 1; i < lines.length; ++i) {
          const line = lines[i];
          str += line ? `
${indent}${line}` : "\n";
        }
      }
      if (comment) {
        str += "\n" + stringifyComment.indentComment(commentString(comment), indent);
        if (onComment)
          onComment();
      } else if (chompKeep && onChompKeep)
        onChompKeep();
      return str;
    }
    __name(stringifyBlockCollection, "stringifyBlockCollection");
    function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
      const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
      itemIndent += indentStep;
      const itemCtx = Object.assign({}, ctx, {
        indent: itemIndent,
        inFlow: true,
        type: null
      });
      let reqNewline = false;
      let linesAtValue = 0;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment = null;
        if (identity.isNode(item)) {
          if (item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, false);
          if (item.comment)
            comment = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, false);
            if (ik.comment)
              reqNewline = true;
          }
          const iv = identity.isNode(item.value) ? item.value : null;
          if (iv) {
            if (iv.comment)
              comment = iv.comment;
            if (iv.commentBefore)
              reqNewline = true;
          } else if (item.value == null && ik?.comment) {
            comment = ik.comment;
          }
        }
        if (comment)
          reqNewline = true;
        let str = stringify3.stringify(item, itemCtx, () => comment = null);
        reqNewline || (reqNewline = lines.length > linesAtValue || str.includes("\n"));
        if (i < items.length - 1) {
          str += ",";
        } else if (ctx.options.trailingComma) {
          if (ctx.options.lineWidth > 0) {
            reqNewline || (reqNewline = lines.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
          }
          if (reqNewline) {
            str += ",";
          }
        }
        if (comment)
          str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
        lines.push(str);
        linesAtValue = lines.length;
      }
      const { start, end } = flowChars;
      if (lines.length === 0) {
        return start + end;
      } else {
        if (!reqNewline) {
          const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
          reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
        }
        if (reqNewline) {
          let str = start;
          for (const line of lines)
            str += line ? `
${indentStep}${indent}${line}` : "\n";
          return `${str}
${indent}${end}`;
        } else {
          return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
        }
      }
    }
    __name(stringifyFlowCollection, "stringifyFlowCollection");
    function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
      if (comment && chompKeep)
        comment = comment.replace(/^\n+/, "");
      if (comment) {
        const ic = stringifyComment.indentComment(commentString(comment), indent);
        lines.push(ic.trimStart());
      }
    }
    __name(addCommentBefore, "addCommentBefore");
    exports.stringifyCollection = stringifyCollection;
  }
});

// node_modules/yaml/dist/nodes/YAMLMap.js
var require_YAMLMap = __commonJS({
  "node_modules/yaml/dist/nodes/YAMLMap.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var stringifyCollection = require_stringifyCollection();
    var addPairToJSMap = require_addPairToJSMap();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    function findPair(items, key) {
      const k = identity.isScalar(key) ? key.value : key;
      for (const it of items) {
        if (identity.isPair(it)) {
          if (it.key === key || it.key === k)
            return it;
          if (identity.isScalar(it.key) && it.key.value === k)
            return it;
        }
      }
      return void 0;
    }
    __name(findPair, "findPair");
    var YAMLMap = class extends Collection.Collection {
      static {
        __name(this, "YAMLMap");
      }
      static get tagName() {
        return "tag:yaml.org,2002:map";
      }
      constructor(schema) {
        super(identity.MAP, schema);
        this.items = [];
      }
      /**
       * A generic collection parsing method that can be extended
       * to other node classes that inherit from YAMLMap
       */
      static from(schema, obj, ctx) {
        const { keepUndefined, replacer } = ctx;
        const map = new this(schema);
        const add = /* @__PURE__ */ __name((key, value) => {
          if (typeof replacer === "function")
            value = replacer.call(obj, key, value);
          else if (Array.isArray(replacer) && !replacer.includes(key))
            return;
          if (value !== void 0 || keepUndefined)
            map.items.push(Pair.createPair(key, value, ctx));
        }, "add");
        if (obj instanceof Map) {
          for (const [key, value] of obj)
            add(key, value);
        } else if (obj && typeof obj === "object") {
          for (const key of Object.keys(obj))
            add(key, obj[key]);
        }
        if (typeof schema.sortMapEntries === "function") {
          map.items.sort(schema.sortMapEntries);
        }
        return map;
      }
      /**
       * Adds a value to the collection.
       *
       * @param overwrite - If not set `true`, using a key that is already in the
       *   collection will throw. Otherwise, overwrites the previous value.
       */
      add(pair, overwrite) {
        let _pair;
        if (identity.isPair(pair))
          _pair = pair;
        else if (!pair || typeof pair !== "object" || !("key" in pair)) {
          _pair = new Pair.Pair(pair, pair?.value);
        } else
          _pair = new Pair.Pair(pair.key, pair.value);
        const prev = findPair(this.items, _pair.key);
        const sortEntries = this.schema?.sortMapEntries;
        if (prev) {
          if (!overwrite)
            throw new Error(`Key ${_pair.key} already set`);
          if (identity.isScalar(prev.value) && Scalar.isScalarValue(_pair.value))
            prev.value.value = _pair.value;
          else
            prev.value = _pair.value;
        } else if (sortEntries) {
          const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
          if (i === -1)
            this.items.push(_pair);
          else
            this.items.splice(i, 0, _pair);
        } else {
          this.items.push(_pair);
        }
      }
      delete(key) {
        const it = findPair(this.items, key);
        if (!it)
          return false;
        const del = this.items.splice(this.items.indexOf(it), 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const it = findPair(this.items, key);
        const node = it?.value;
        return (!keepScalar && identity.isScalar(node) ? node.value : node) ?? void 0;
      }
      has(key) {
        return !!findPair(this.items, key);
      }
      set(key, value) {
        this.add(new Pair.Pair(key, value), true);
      }
      /**
       * @param ctx - Conversion context, originally set in Document#toJS()
       * @param {Class} Type - If set, forces the returned collection type
       * @returns Instance of Type, Map, or Object
       */
      toJSON(_, ctx, Type) {
        const map = Type ? new Type() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const item of this.items)
          addPairToJSMap.addPairToJSMap(ctx, map, item);
        return map;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        for (const item of this.items) {
          if (!identity.isPair(item))
            throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
        }
        if (!ctx.allNullValues && this.hasAllNullValues(false))
          ctx = Object.assign({}, ctx, { allNullValues: true });
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "",
          flowChars: { start: "{", end: "}" },
          itemIndent: ctx.indent || "",
          onChompKeep,
          onComment
        });
      }
    };
    exports.YAMLMap = YAMLMap;
    exports.findPair = findPair;
  }
});

// node_modules/yaml/dist/schema/common/map.js
var require_map = __commonJS({
  "node_modules/yaml/dist/schema/common/map.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var identity = require_identity();
    var YAMLMap = require_YAMLMap();
    var map = {
      collection: "map",
      default: true,
      nodeClass: YAMLMap.YAMLMap,
      tag: "tag:yaml.org,2002:map",
      resolve(map2, onError) {
        if (!identity.isMap(map2))
          onError("Expected a mapping for this tag");
        return map2;
      },
      createNode: /* @__PURE__ */ __name((schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx), "createNode")
    };
    exports.map = map;
  }
});

// node_modules/yaml/dist/nodes/YAMLSeq.js
var require_YAMLSeq = __commonJS({
  "node_modules/yaml/dist/nodes/YAMLSeq.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var createNode = require_createNode();
    var stringifyCollection = require_stringifyCollection();
    var Collection = require_Collection();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var toJS = require_toJS();
    var YAMLSeq = class extends Collection.Collection {
      static {
        __name(this, "YAMLSeq");
      }
      static get tagName() {
        return "tag:yaml.org,2002:seq";
      }
      constructor(schema) {
        super(identity.SEQ, schema);
        this.items = [];
      }
      add(value) {
        this.items.push(value);
      }
      /**
       * Removes a value from the collection.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       *
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return false;
        const del = this.items.splice(idx, 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return void 0;
        const it = this.items[idx];
        return !keepScalar && identity.isScalar(it) ? it.value : it;
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       */
      has(key) {
        const idx = asItemIndex(key);
        return typeof idx === "number" && idx < this.items.length;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       *
       * If `key` does not contain a representation of an integer, this will throw.
       * It may be wrapped in a `Scalar`.
       */
      set(key, value) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          throw new Error(`Expected a valid index, not ${key}.`);
        const prev = this.items[idx];
        if (identity.isScalar(prev) && Scalar.isScalarValue(value))
          prev.value = value;
        else
          this.items[idx] = value;
      }
      toJSON(_, ctx) {
        const seq = [];
        if (ctx?.onCreate)
          ctx.onCreate(seq);
        let i = 0;
        for (const item of this.items)
          seq.push(toJS.toJS(item, String(i++), ctx));
        return seq;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "- ",
          flowChars: { start: "[", end: "]" },
          itemIndent: (ctx.indent || "") + "  ",
          onChompKeep,
          onComment
        });
      }
      static from(schema, obj, ctx) {
        const { replacer } = ctx;
        const seq = new this(schema);
        if (obj && Symbol.iterator in Object(obj)) {
          let i = 0;
          for (let it of obj) {
            if (typeof replacer === "function") {
              const key = obj instanceof Set ? it : String(i++);
              it = replacer.call(obj, key, it);
            }
            seq.items.push(createNode.createNode(it, void 0, ctx));
          }
        }
        return seq;
      }
    };
    function asItemIndex(key) {
      let idx = identity.isScalar(key) ? key.value : key;
      if (idx && typeof idx === "string")
        idx = Number(idx);
      return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
    }
    __name(asItemIndex, "asItemIndex");
    exports.YAMLSeq = YAMLSeq;
  }
});

// node_modules/yaml/dist/schema/common/seq.js
var require_seq = __commonJS({
  "node_modules/yaml/dist/schema/common/seq.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var identity = require_identity();
    var YAMLSeq = require_YAMLSeq();
    var seq = {
      collection: "seq",
      default: true,
      nodeClass: YAMLSeq.YAMLSeq,
      tag: "tag:yaml.org,2002:seq",
      resolve(seq2, onError) {
        if (!identity.isSeq(seq2))
          onError("Expected a sequence for this tag");
        return seq2;
      },
      createNode: /* @__PURE__ */ __name((schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx), "createNode")
    };
    exports.seq = seq;
  }
});

// node_modules/yaml/dist/schema/common/string.js
var require_string = __commonJS({
  "node_modules/yaml/dist/schema/common/string.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var stringifyString = require_stringifyString();
    var string = {
      identify: /* @__PURE__ */ __name((value) => typeof value === "string", "identify"),
      default: true,
      tag: "tag:yaml.org,2002:str",
      resolve: /* @__PURE__ */ __name((str) => str, "resolve"),
      stringify(item, ctx, onComment, onChompKeep) {
        ctx = Object.assign({ actualString: true }, ctx);
        return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
      }
    };
    exports.string = string;
  }
});

// node_modules/yaml/dist/schema/common/null.js
var require_null = __commonJS({
  "node_modules/yaml/dist/schema/common/null.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var Scalar = require_Scalar();
    var nullTag = {
      identify: /* @__PURE__ */ __name((value) => value == null, "identify"),
      createNode: /* @__PURE__ */ __name(() => new Scalar.Scalar(null), "createNode"),
      default: true,
      tag: "tag:yaml.org,2002:null",
      test: /^(?:~|[Nn]ull|NULL)?$/,
      resolve: /* @__PURE__ */ __name(() => new Scalar.Scalar(null), "resolve"),
      stringify: /* @__PURE__ */ __name(({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr, "stringify")
    };
    exports.nullTag = nullTag;
  }
});

// node_modules/yaml/dist/schema/core/bool.js
var require_bool = __commonJS({
  "node_modules/yaml/dist/schema/core/bool.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var Scalar = require_Scalar();
    var boolTag = {
      identify: /* @__PURE__ */ __name((value) => typeof value === "boolean", "identify"),
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
      resolve: /* @__PURE__ */ __name((str) => new Scalar.Scalar(str[0] === "t" || str[0] === "T"), "resolve"),
      stringify({ source, value }, ctx) {
        if (source && boolTag.test.test(source)) {
          const sv = source[0] === "t" || source[0] === "T";
          if (value === sv)
            return source;
        }
        return value ? ctx.options.trueStr : ctx.options.falseStr;
      }
    };
    exports.boolTag = boolTag;
  }
});

// node_modules/yaml/dist/stringify/stringifyNumber.js
var require_stringifyNumber = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyNumber.js"(exports) {
    "use strict";
    init_esbuild_shims();
    function stringifyNumber({ format, minFractionDigits, tag, value }) {
      if (typeof value === "bigint")
        return String(value);
      const num = typeof value === "number" ? value : Number(value);
      if (!isFinite(num))
        return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
      let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
      if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
        let i = n.indexOf(".");
        if (i < 0) {
          i = n.length;
          n += ".";
        }
        let d = minFractionDigits - (n.length - i - 1);
        while (d-- > 0)
          n += "0";
      }
      return n;
    }
    __name(stringifyNumber, "stringifyNumber");
    exports.stringifyNumber = stringifyNumber;
  }
});

// node_modules/yaml/dist/schema/core/float.js
var require_float = __commonJS({
  "node_modules/yaml/dist/schema/core/float.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: /* @__PURE__ */ __name((value) => typeof value === "number", "identify"),
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: /* @__PURE__ */ __name((str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY, "resolve"),
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: /* @__PURE__ */ __name((value) => typeof value === "number", "identify"),
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
      resolve: /* @__PURE__ */ __name((str) => parseFloat(str), "resolve"),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: /* @__PURE__ */ __name((value) => typeof value === "number", "identify"),
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str));
        const dot = str.indexOf(".");
        if (dot !== -1 && str[str.length - 1] === "0")
          node.minFractionDigits = str.length - dot - 1;
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports.float = float;
    exports.floatExp = floatExp;
    exports.floatNaN = floatNaN;
  }
});

// node_modules/yaml/dist/schema/core/int.js
var require_int = __commonJS({
  "node_modules/yaml/dist/schema/core/int.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = /* @__PURE__ */ __name((value) => typeof value === "bigint" || Number.isInteger(value), "intIdentify");
    var intResolve = /* @__PURE__ */ __name((str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix), "intResolve");
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value) && value >= 0)
        return prefix + value.toString(radix);
      return stringifyNumber.stringifyNumber(node);
    }
    __name(intStringify, "intStringify");
    var intOct = {
      identify: /* @__PURE__ */ __name((value) => intIdentify(value) && value >= 0, "identify"),
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^0o[0-7]+$/,
      resolve: /* @__PURE__ */ __name((str, _onError, opt) => intResolve(str, 2, 8, opt), "resolve"),
      stringify: /* @__PURE__ */ __name((node) => intStringify(node, 8, "0o"), "stringify")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9]+$/,
      resolve: /* @__PURE__ */ __name((str, _onError, opt) => intResolve(str, 0, 10, opt), "resolve"),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: /* @__PURE__ */ __name((value) => intIdentify(value) && value >= 0, "identify"),
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^0x[0-9a-fA-F]+$/,
      resolve: /* @__PURE__ */ __name((str, _onError, opt) => intResolve(str, 2, 16, opt), "resolve"),
      stringify: /* @__PURE__ */ __name((node) => intStringify(node, 16, "0x"), "stringify")
    };
    exports.int = int;
    exports.intHex = intHex;
    exports.intOct = intOct;
  }
});

// node_modules/yaml/dist/schema/core/schema.js
var require_schema = __commonJS({
  "node_modules/yaml/dist/schema/core/schema.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = [
      map.map,
      seq.seq,
      string.string,
      _null.nullTag,
      bool.boolTag,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float
    ];
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/json/schema.js
var require_schema2 = __commonJS({
  "node_modules/yaml/dist/schema/json/schema.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var Scalar = require_Scalar();
    var map = require_map();
    var seq = require_seq();
    function intIdentify(value) {
      return typeof value === "bigint" || Number.isInteger(value);
    }
    __name(intIdentify, "intIdentify");
    var stringifyJSON = /* @__PURE__ */ __name(({ value }) => JSON.stringify(value), "stringifyJSON");
    var jsonScalars = [
      {
        identify: /* @__PURE__ */ __name((value) => typeof value === "string", "identify"),
        default: true,
        tag: "tag:yaml.org,2002:str",
        resolve: /* @__PURE__ */ __name((str) => str, "resolve"),
        stringify: stringifyJSON
      },
      {
        identify: /* @__PURE__ */ __name((value) => value == null, "identify"),
        createNode: /* @__PURE__ */ __name(() => new Scalar.Scalar(null), "createNode"),
        default: true,
        tag: "tag:yaml.org,2002:null",
        test: /^null$/,
        resolve: /* @__PURE__ */ __name(() => null, "resolve"),
        stringify: stringifyJSON
      },
      {
        identify: /* @__PURE__ */ __name((value) => typeof value === "boolean", "identify"),
        default: true,
        tag: "tag:yaml.org,2002:bool",
        test: /^true$|^false$/,
        resolve: /* @__PURE__ */ __name((str) => str === "true", "resolve"),
        stringify: stringifyJSON
      },
      {
        identify: intIdentify,
        default: true,
        tag: "tag:yaml.org,2002:int",
        test: /^-?(?:0|[1-9][0-9]*)$/,
        resolve: /* @__PURE__ */ __name((str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10), "resolve"),
        stringify: /* @__PURE__ */ __name(({ value }) => intIdentify(value) ? value.toString() : JSON.stringify(value), "stringify")
      },
      {
        identify: /* @__PURE__ */ __name((value) => typeof value === "number", "identify"),
        default: true,
        tag: "tag:yaml.org,2002:float",
        test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
        resolve: /* @__PURE__ */ __name((str) => parseFloat(str), "resolve"),
        stringify: stringifyJSON
      }
    ];
    var jsonError = {
      default: true,
      tag: "",
      test: /^/,
      resolve(str, onError) {
        onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
        return str;
      }
    };
    var schema = [map.map, seq.seq].concat(jsonScalars, jsonError);
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/binary.js
var require_binary = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/binary.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var node_buffer = __require("buffer");
    var Scalar = require_Scalar();
    var stringifyString = require_stringifyString();
    var binary = {
      identify: /* @__PURE__ */ __name((value) => value instanceof Uint8Array, "identify"),
      // Buffer inherits from Uint8Array
      default: false,
      tag: "tag:yaml.org,2002:binary",
      /**
       * Returns a Buffer in node and an Uint8Array in browsers
       *
       * To use the resulting buffer as an image, you'll want to do something like:
       *
       *   const blob = new Blob([buffer], { type: 'image/jpeg' })
       *   document.querySelector('#photo').src = URL.createObjectURL(blob)
       */
      resolve(src, onError) {
        if (typeof node_buffer.Buffer === "function") {
          return node_buffer.Buffer.from(src, "base64");
        } else if (typeof atob === "function") {
          const str = atob(src.replace(/[\n\r]/g, ""));
          const buffer = new Uint8Array(str.length);
          for (let i = 0; i < str.length; ++i)
            buffer[i] = str.charCodeAt(i);
          return buffer;
        } else {
          onError("This environment does not support reading binary tags; either Buffer or atob is required");
          return src;
        }
      },
      stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
        if (!value)
          return "";
        const buf = value;
        let str;
        if (typeof node_buffer.Buffer === "function") {
          str = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
        } else if (typeof btoa === "function") {
          let s = "";
          for (let i = 0; i < buf.length; ++i)
            s += String.fromCharCode(buf[i]);
          str = btoa(s);
        } else {
          throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
        }
        type ?? (type = Scalar.Scalar.BLOCK_LITERAL);
        if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
          const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
          const n = Math.ceil(str.length / lineWidth);
          const lines = new Array(n);
          for (let i = 0, o = 0; i < n; ++i, o += lineWidth) {
            lines[i] = str.substr(o, lineWidth);
          }
          str = lines.join(type === Scalar.Scalar.BLOCK_LITERAL ? "\n" : " ");
        }
        return stringifyString.stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
      }
    };
    exports.binary = binary;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/pairs.js
var require_pairs = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/pairs.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLSeq = require_YAMLSeq();
    function resolvePairs(seq, onError) {
      if (identity.isSeq(seq)) {
        for (let i = 0; i < seq.items.length; ++i) {
          let item = seq.items[i];
          if (identity.isPair(item))
            continue;
          else if (identity.isMap(item)) {
            if (item.items.length > 1)
              onError("Each pair must have its own sequence indicator");
            const pair = item.items[0] || new Pair.Pair(new Scalar.Scalar(null));
            if (item.commentBefore)
              pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
            if (item.comment) {
              const cn = pair.value ?? pair.key;
              cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
            }
            item = pair;
          }
          seq.items[i] = identity.isPair(item) ? item : new Pair.Pair(item);
        }
      } else
        onError("Expected a sequence for this tag");
      return seq;
    }
    __name(resolvePairs, "resolvePairs");
    function createPairs(schema, iterable, ctx) {
      const { replacer } = ctx;
      const pairs2 = new YAMLSeq.YAMLSeq(schema);
      pairs2.tag = "tag:yaml.org,2002:pairs";
      let i = 0;
      if (iterable && Symbol.iterator in Object(iterable))
        for (let it of iterable) {
          if (typeof replacer === "function")
            it = replacer.call(iterable, String(i++), it);
          let key, value;
          if (Array.isArray(it)) {
            if (it.length === 2) {
              key = it[0];
              value = it[1];
            } else
              throw new TypeError(`Expected [key, value] tuple: ${it}`);
          } else if (it && it instanceof Object) {
            const keys = Object.keys(it);
            if (keys.length === 1) {
              key = keys[0];
              value = it[key];
            } else {
              throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
            }
          } else {
            key = it;
          }
          pairs2.items.push(Pair.createPair(key, value, ctx));
        }
      return pairs2;
    }
    __name(createPairs, "createPairs");
    var pairs = {
      collection: "seq",
      default: false,
      tag: "tag:yaml.org,2002:pairs",
      resolve: resolvePairs,
      createNode: createPairs
    };
    exports.createPairs = createPairs;
    exports.pairs = pairs;
    exports.resolvePairs = resolvePairs;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/omap.js
var require_omap = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/omap.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var identity = require_identity();
    var toJS = require_toJS();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var pairs = require_pairs();
    var YAMLOMap = class _YAMLOMap extends YAMLSeq.YAMLSeq {
      static {
        __name(this, "YAMLOMap");
      }
      constructor() {
        super();
        this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
        this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
        this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
        this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
        this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
        this.tag = _YAMLOMap.tag;
      }
      /**
       * If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
       * but TypeScript won't allow widening the signature of a child method.
       */
      toJSON(_, ctx) {
        if (!ctx)
          return super.toJSON(_);
        const map = /* @__PURE__ */ new Map();
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const pair of this.items) {
          let key, value;
          if (identity.isPair(pair)) {
            key = toJS.toJS(pair.key, "", ctx);
            value = toJS.toJS(pair.value, key, ctx);
          } else {
            key = toJS.toJS(pair, "", ctx);
          }
          if (map.has(key))
            throw new Error("Ordered maps must not include duplicate keys");
          map.set(key, value);
        }
        return map;
      }
      static from(schema, iterable, ctx) {
        const pairs$1 = pairs.createPairs(schema, iterable, ctx);
        const omap2 = new this();
        omap2.items = pairs$1.items;
        return omap2;
      }
    };
    YAMLOMap.tag = "tag:yaml.org,2002:omap";
    var omap = {
      collection: "seq",
      identify: /* @__PURE__ */ __name((value) => value instanceof Map, "identify"),
      nodeClass: YAMLOMap,
      default: false,
      tag: "tag:yaml.org,2002:omap",
      resolve(seq, onError) {
        const pairs$1 = pairs.resolvePairs(seq, onError);
        const seenKeys = [];
        for (const { key } of pairs$1.items) {
          if (identity.isScalar(key)) {
            if (seenKeys.includes(key.value)) {
              onError(`Ordered maps must not include duplicate keys: ${key.value}`);
            } else {
              seenKeys.push(key.value);
            }
          }
        }
        return Object.assign(new YAMLOMap(), pairs$1);
      },
      createNode: /* @__PURE__ */ __name((schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx), "createNode")
    };
    exports.YAMLOMap = YAMLOMap;
    exports.omap = omap;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/bool.js
var require_bool2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/bool.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var Scalar = require_Scalar();
    function boolStringify({ value, source }, ctx) {
      const boolObj = value ? trueTag : falseTag;
      if (source && boolObj.test.test(source))
        return source;
      return value ? ctx.options.trueStr : ctx.options.falseStr;
    }
    __name(boolStringify, "boolStringify");
    var trueTag = {
      identify: /* @__PURE__ */ __name((value) => value === true, "identify"),
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
      resolve: /* @__PURE__ */ __name(() => new Scalar.Scalar(true), "resolve"),
      stringify: boolStringify
    };
    var falseTag = {
      identify: /* @__PURE__ */ __name((value) => value === false, "identify"),
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
      resolve: /* @__PURE__ */ __name(() => new Scalar.Scalar(false), "resolve"),
      stringify: boolStringify
    };
    exports.falseTag = falseTag;
    exports.trueTag = trueTag;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/float.js
var require_float2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/float.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: /* @__PURE__ */ __name((value) => typeof value === "number", "identify"),
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: /* @__PURE__ */ __name((str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY, "resolve"),
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: /* @__PURE__ */ __name((value) => typeof value === "number", "identify"),
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
      resolve: /* @__PURE__ */ __name((str) => parseFloat(str.replace(/_/g, "")), "resolve"),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: /* @__PURE__ */ __name((value) => typeof value === "number", "identify"),
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str.replace(/_/g, "")));
        const dot = str.indexOf(".");
        if (dot !== -1) {
          const f = str.substring(dot + 1).replace(/_/g, "");
          if (f[f.length - 1] === "0")
            node.minFractionDigits = f.length;
        }
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports.float = float;
    exports.floatExp = floatExp;
    exports.floatNaN = floatNaN;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/int.js
var require_int2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/int.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = /* @__PURE__ */ __name((value) => typeof value === "bigint" || Number.isInteger(value), "intIdentify");
    function intResolve(str, offset, radix, { intAsBigInt }) {
      const sign = str[0];
      if (sign === "-" || sign === "+")
        offset += 1;
      str = str.substring(offset).replace(/_/g, "");
      if (intAsBigInt) {
        switch (radix) {
          case 2:
            str = `0b${str}`;
            break;
          case 8:
            str = `0o${str}`;
            break;
          case 16:
            str = `0x${str}`;
            break;
        }
        const n2 = BigInt(str);
        return sign === "-" ? BigInt(-1) * n2 : n2;
      }
      const n = parseInt(str, radix);
      return sign === "-" ? -1 * n : n;
    }
    __name(intResolve, "intResolve");
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value)) {
        const str = value.toString(radix);
        return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
      }
      return stringifyNumber.stringifyNumber(node);
    }
    __name(intStringify, "intStringify");
    var intBin = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "BIN",
      test: /^[-+]?0b[0-1_]+$/,
      resolve: /* @__PURE__ */ __name((str, _onError, opt) => intResolve(str, 2, 2, opt), "resolve"),
      stringify: /* @__PURE__ */ __name((node) => intStringify(node, 2, "0b"), "stringify")
    };
    var intOct = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^[-+]?0[0-7_]+$/,
      resolve: /* @__PURE__ */ __name((str, _onError, opt) => intResolve(str, 1, 8, opt), "resolve"),
      stringify: /* @__PURE__ */ __name((node) => intStringify(node, 8, "0"), "stringify")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9][0-9_]*$/,
      resolve: /* @__PURE__ */ __name((str, _onError, opt) => intResolve(str, 0, 10, opt), "resolve"),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^[-+]?0x[0-9a-fA-F_]+$/,
      resolve: /* @__PURE__ */ __name((str, _onError, opt) => intResolve(str, 2, 16, opt), "resolve"),
      stringify: /* @__PURE__ */ __name((node) => intStringify(node, 16, "0x"), "stringify")
    };
    exports.int = int;
    exports.intBin = intBin;
    exports.intHex = intHex;
    exports.intOct = intOct;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/set.js
var require_set = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/set.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSet = class _YAMLSet extends YAMLMap.YAMLMap {
      static {
        __name(this, "YAMLSet");
      }
      constructor(schema) {
        super(schema);
        this.tag = _YAMLSet.tag;
      }
      add(key) {
        let pair;
        if (identity.isPair(key))
          pair = key;
        else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
          pair = new Pair.Pair(key.key, null);
        else
          pair = new Pair.Pair(key, null);
        const prev = YAMLMap.findPair(this.items, pair.key);
        if (!prev)
          this.items.push(pair);
      }
      /**
       * If `keepPair` is `true`, returns the Pair matching `key`.
       * Otherwise, returns the value of that Pair's key.
       */
      get(key, keepPair) {
        const pair = YAMLMap.findPair(this.items, key);
        return !keepPair && identity.isPair(pair) ? identity.isScalar(pair.key) ? pair.key.value : pair.key : pair;
      }
      set(key, value) {
        if (typeof value !== "boolean")
          throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
        const prev = YAMLMap.findPair(this.items, key);
        if (prev && !value) {
          this.items.splice(this.items.indexOf(prev), 1);
        } else if (!prev && value) {
          this.items.push(new Pair.Pair(key));
        }
      }
      toJSON(_, ctx) {
        return super.toJSON(_, ctx, Set);
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        if (this.hasAllNullValues(true))
          return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
        else
          throw new Error("Set items must all have null values");
      }
      static from(schema, iterable, ctx) {
        const { replacer } = ctx;
        const set2 = new this(schema);
        if (iterable && Symbol.iterator in Object(iterable))
          for (let value of iterable) {
            if (typeof replacer === "function")
              value = replacer.call(iterable, value, value);
            set2.items.push(Pair.createPair(value, null, ctx));
          }
        return set2;
      }
    };
    YAMLSet.tag = "tag:yaml.org,2002:set";
    var set = {
      collection: "map",
      identify: /* @__PURE__ */ __name((value) => value instanceof Set, "identify"),
      nodeClass: YAMLSet,
      default: false,
      tag: "tag:yaml.org,2002:set",
      createNode: /* @__PURE__ */ __name((schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx), "createNode"),
      resolve(map, onError) {
        if (identity.isMap(map)) {
          if (map.hasAllNullValues(true))
            return Object.assign(new YAMLSet(), map);
          else
            onError("Set items must all have null values");
        } else
          onError("Expected a mapping for this tag");
        return map;
      }
    };
    exports.YAMLSet = YAMLSet;
    exports.set = set;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/timestamp.js
var require_timestamp = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/timestamp.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var stringifyNumber = require_stringifyNumber();
    function parseSexagesimal(str, asBigInt) {
      const sign = str[0];
      const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
      const num = /* @__PURE__ */ __name((n) => asBigInt ? BigInt(n) : Number(n), "num");
      const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
      return sign === "-" ? num(-1) * res : res;
    }
    __name(parseSexagesimal, "parseSexagesimal");
    function stringifySexagesimal(node) {
      let { value } = node;
      let num = /* @__PURE__ */ __name((n) => n, "num");
      if (typeof value === "bigint")
        num = /* @__PURE__ */ __name((n) => BigInt(n), "num");
      else if (isNaN(value) || !isFinite(value))
        return stringifyNumber.stringifyNumber(node);
      let sign = "";
      if (value < 0) {
        sign = "-";
        value *= num(-1);
      }
      const _60 = num(60);
      const parts = [value % _60];
      if (value < 60) {
        parts.unshift(0);
      } else {
        value = (value - parts[0]) / _60;
        parts.unshift(value % _60);
        if (value >= 60) {
          value = (value - parts[0]) / _60;
          parts.unshift(value);
        }
      }
      return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
    }
    __name(stringifySexagesimal, "stringifySexagesimal");
    var intTime = {
      identify: /* @__PURE__ */ __name((value) => typeof value === "bigint" || Number.isInteger(value), "identify"),
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
      resolve: /* @__PURE__ */ __name((str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt), "resolve"),
      stringify: stringifySexagesimal
    };
    var floatTime = {
      identify: /* @__PURE__ */ __name((value) => typeof value === "number", "identify"),
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
      resolve: /* @__PURE__ */ __name((str) => parseSexagesimal(str, false), "resolve"),
      stringify: stringifySexagesimal
    };
    var timestamp = {
      identify: /* @__PURE__ */ __name((value) => value instanceof Date, "identify"),
      default: true,
      tag: "tag:yaml.org,2002:timestamp",
      // If the time zone is omitted, the timestamp is assumed to be specified in UTC. The time part
      // may be omitted altogether, resulting in a date format. In such a case, the time part is
      // assumed to be 00:00:00Z (start of day, UTC).
      test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
      resolve(str) {
        const match = str.match(timestamp.test);
        if (!match)
          throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
        const [, year, month, day, hour, minute, second] = match.map(Number);
        const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
        let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
        const tz = match[8];
        if (tz && tz !== "Z") {
          let d = parseSexagesimal(tz, false);
          if (Math.abs(d) < 30)
            d *= 60;
          date -= 6e4 * d;
        }
        return new Date(date);
      },
      stringify: /* @__PURE__ */ __name(({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? "", "stringify")
    };
    exports.floatTime = floatTime;
    exports.intTime = intTime;
    exports.timestamp = timestamp;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/schema.js
var require_schema3 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/schema.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var binary = require_binary();
    var bool = require_bool2();
    var float = require_float2();
    var int = require_int2();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var set = require_set();
    var timestamp = require_timestamp();
    var schema = [
      map.map,
      seq.seq,
      string.string,
      _null.nullTag,
      bool.trueTag,
      bool.falseTag,
      int.intBin,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float,
      binary.binary,
      merge.merge,
      omap.omap,
      pairs.pairs,
      set.set,
      timestamp.intTime,
      timestamp.floatTime,
      timestamp.timestamp
    ];
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/tags.js
var require_tags = __commonJS({
  "node_modules/yaml/dist/schema/tags.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = require_schema();
    var schema$1 = require_schema2();
    var binary = require_binary();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var schema$2 = require_schema3();
    var set = require_set();
    var timestamp = require_timestamp();
    var schemas = /* @__PURE__ */ new Map([
      ["core", schema.schema],
      ["failsafe", [map.map, seq.seq, string.string]],
      ["json", schema$1.schema],
      ["yaml11", schema$2.schema],
      ["yaml-1.1", schema$2.schema]
    ]);
    var tagsByName = {
      binary: binary.binary,
      bool: bool.boolTag,
      float: float.float,
      floatExp: float.floatExp,
      floatNaN: float.floatNaN,
      floatTime: timestamp.floatTime,
      int: int.int,
      intHex: int.intHex,
      intOct: int.intOct,
      intTime: timestamp.intTime,
      map: map.map,
      merge: merge.merge,
      null: _null.nullTag,
      omap: omap.omap,
      pairs: pairs.pairs,
      seq: seq.seq,
      set: set.set,
      timestamp: timestamp.timestamp
    };
    var coreKnownTags = {
      "tag:yaml.org,2002:binary": binary.binary,
      "tag:yaml.org,2002:merge": merge.merge,
      "tag:yaml.org,2002:omap": omap.omap,
      "tag:yaml.org,2002:pairs": pairs.pairs,
      "tag:yaml.org,2002:set": set.set,
      "tag:yaml.org,2002:timestamp": timestamp.timestamp
    };
    function getTags(customTags, schemaName, addMergeTag) {
      const schemaTags = schemas.get(schemaName);
      if (schemaTags && !customTags) {
        return addMergeTag && !schemaTags.includes(merge.merge) ? schemaTags.concat(merge.merge) : schemaTags.slice();
      }
      let tags = schemaTags;
      if (!tags) {
        if (Array.isArray(customTags))
          tags = [];
        else {
          const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
        }
      }
      if (Array.isArray(customTags)) {
        for (const tag of customTags)
          tags = tags.concat(tag);
      } else if (typeof customTags === "function") {
        tags = customTags(tags.slice());
      }
      if (addMergeTag)
        tags = tags.concat(merge.merge);
      return tags.reduce((tags2, tag) => {
        const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
        if (!tagObj) {
          const tagName = JSON.stringify(tag);
          const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
        }
        if (!tags2.includes(tagObj))
          tags2.push(tagObj);
        return tags2;
      }, []);
    }
    __name(getTags, "getTags");
    exports.coreKnownTags = coreKnownTags;
    exports.getTags = getTags;
  }
});

// node_modules/yaml/dist/schema/Schema.js
var require_Schema = __commonJS({
  "node_modules/yaml/dist/schema/Schema.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var identity = require_identity();
    var map = require_map();
    var seq = require_seq();
    var string = require_string();
    var tags = require_tags();
    var sortMapEntriesByKey = /* @__PURE__ */ __name((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0, "sortMapEntriesByKey");
    var Schema = class _Schema {
      static {
        __name(this, "Schema");
      }
      constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
        this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
        this.name = typeof schema === "string" && schema || "core";
        this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
        this.tags = tags.getTags(customTags, this.name, merge);
        this.toStringOptions = toStringDefaults ?? null;
        Object.defineProperty(this, identity.MAP, { value: map.map });
        Object.defineProperty(this, identity.SCALAR, { value: string.string });
        Object.defineProperty(this, identity.SEQ, { value: seq.seq });
        this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
      }
      clone() {
        const copy = Object.create(_Schema.prototype, Object.getOwnPropertyDescriptors(this));
        copy.tags = this.tags.slice();
        return copy;
      }
    };
    exports.Schema = Schema;
  }
});

// node_modules/yaml/dist/stringify/stringifyDocument.js
var require_stringifyDocument = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyDocument.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var identity = require_identity();
    var stringify3 = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyDocument(doc, options) {
      const lines = [];
      let hasDirectives = options.directives === true;
      if (options.directives !== false && doc.directives) {
        const dir = doc.directives.toString(doc);
        if (dir) {
          lines.push(dir);
          hasDirectives = true;
        } else if (doc.directives.docStart)
          hasDirectives = true;
      }
      if (hasDirectives)
        lines.push("---");
      const ctx = stringify3.createStringifyContext(doc, options);
      const { commentString } = ctx.options;
      if (doc.commentBefore) {
        if (lines.length !== 1)
          lines.unshift("");
        const cs = commentString(doc.commentBefore);
        lines.unshift(stringifyComment.indentComment(cs, ""));
      }
      let chompKeep = false;
      let contentComment = null;
      if (doc.contents) {
        if (identity.isNode(doc.contents)) {
          if (doc.contents.spaceBefore && hasDirectives)
            lines.push("");
          if (doc.contents.commentBefore) {
            const cs = commentString(doc.contents.commentBefore);
            lines.push(stringifyComment.indentComment(cs, ""));
          }
          ctx.forceBlockIndent = !!doc.comment;
          contentComment = doc.contents.comment;
        }
        const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
        let body = stringify3.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
        if (contentComment)
          body += stringifyComment.lineComment(body, "", commentString(contentComment));
        if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
          lines[lines.length - 1] = `--- ${body}`;
        } else
          lines.push(body);
      } else {
        lines.push(stringify3.stringify(doc.contents, ctx));
      }
      if (doc.directives?.docEnd) {
        if (doc.comment) {
          const cs = commentString(doc.comment);
          if (cs.includes("\n")) {
            lines.push("...");
            lines.push(stringifyComment.indentComment(cs, ""));
          } else {
            lines.push(`... ${cs}`);
          }
        } else {
          lines.push("...");
        }
      } else {
        let dc = doc.comment;
        if (dc && chompKeep)
          dc = dc.replace(/^\n+/, "");
        if (dc) {
          if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
            lines.push("");
          lines.push(stringifyComment.indentComment(commentString(dc), ""));
        }
      }
      return lines.join("\n") + "\n";
    }
    __name(stringifyDocument, "stringifyDocument");
    exports.stringifyDocument = stringifyDocument;
  }
});

// node_modules/yaml/dist/doc/Document.js
var require_Document = __commonJS({
  "node_modules/yaml/dist/doc/Document.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var Alias = require_Alias();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var toJS = require_toJS();
    var Schema = require_Schema();
    var stringifyDocument = require_stringifyDocument();
    var anchors = require_anchors();
    var applyReviver = require_applyReviver();
    var createNode = require_createNode();
    var directives = require_directives();
    var Document = class _Document {
      static {
        __name(this, "Document");
      }
      constructor(value, replacer, options) {
        this.commentBefore = null;
        this.comment = null;
        this.errors = [];
        this.warnings = [];
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.DOC });
        let _replacer = null;
        if (typeof replacer === "function" || Array.isArray(replacer)) {
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const opt = Object.assign({
          intAsBigInt: false,
          keepSourceTokens: false,
          logLevel: "warn",
          prettyErrors: true,
          strict: true,
          stringKeys: false,
          uniqueKeys: true,
          version: "1.2"
        }, options);
        this.options = opt;
        let { version } = opt;
        if (options?._directives) {
          this.directives = options._directives.atDocument();
          if (this.directives.yaml.explicit)
            version = this.directives.yaml.version;
        } else
          this.directives = new directives.Directives({ version });
        this.setSchema(version, options);
        this.contents = value === void 0 ? null : this.createNode(value, _replacer, options);
      }
      /**
       * Create a deep copy of this Document and its contents.
       *
       * Custom Node values that inherit from `Object` still refer to their original instances.
       */
      clone() {
        const copy = Object.create(_Document.prototype, {
          [identity.NODE_TYPE]: { value: identity.DOC }
        });
        copy.commentBefore = this.commentBefore;
        copy.comment = this.comment;
        copy.errors = this.errors.slice();
        copy.warnings = this.warnings.slice();
        copy.options = Object.assign({}, this.options);
        if (this.directives)
          copy.directives = this.directives.clone();
        copy.schema = this.schema.clone();
        copy.contents = identity.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** Adds a value to the document. */
      add(value) {
        if (assertCollection(this.contents))
          this.contents.add(value);
      }
      /** Adds a value to the document. */
      addIn(path3, value) {
        if (assertCollection(this.contents))
          this.contents.addIn(path3, value);
      }
      /**
       * Create a new `Alias` node, ensuring that the target `node` has the required anchor.
       *
       * If `node` already has an anchor, `name` is ignored.
       * Otherwise, the `node.anchor` value will be set to `name`,
       * or if an anchor with that name is already present in the document,
       * `name` will be used as a prefix for a new unique anchor.
       * If `name` is undefined, the generated anchor will use 'a' as a prefix.
       */
      createAlias(node, name) {
        if (!node.anchor) {
          const prev = anchors.anchorNames(this);
          node.anchor = // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
        }
        return new Alias.Alias(node.anchor);
      }
      createNode(value, replacer, options) {
        let _replacer = void 0;
        if (typeof replacer === "function") {
          value = replacer.call({ "": value }, "", value);
          _replacer = replacer;
        } else if (Array.isArray(replacer)) {
          const keyToStr = /* @__PURE__ */ __name((v) => typeof v === "number" || v instanceof String || v instanceof Number, "keyToStr");
          const asStr = replacer.filter(keyToStr).map(String);
          if (asStr.length > 0)
            replacer = replacer.concat(asStr);
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
        const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(
          this,
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          anchorPrefix || "a"
        );
        const ctx = {
          aliasDuplicateObjects: aliasDuplicateObjects ?? true,
          keepUndefined: keepUndefined ?? false,
          onAnchor,
          onTagObj,
          replacer: _replacer,
          schema: this.schema,
          sourceObjects
        };
        const node = createNode.createNode(value, tag, ctx);
        if (flow && identity.isCollection(node))
          node.flow = true;
        setAnchors();
        return node;
      }
      /**
       * Convert a key and a value into a `Pair` using the current schema,
       * recursively wrapping all values as `Scalar` or `Collection` nodes.
       */
      createPair(key, value, options = {}) {
        const k = this.createNode(key, null, options);
        const v = this.createNode(value, null, options);
        return new Pair.Pair(k, v);
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        return assertCollection(this.contents) ? this.contents.delete(key) : false;
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path3) {
        if (Collection.isEmptyPath(path3)) {
          if (this.contents == null)
            return false;
          this.contents = null;
          return true;
        }
        return assertCollection(this.contents) ? this.contents.deleteIn(path3) : false;
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      get(key, keepScalar) {
        return identity.isCollection(this.contents) ? this.contents.get(key, keepScalar) : void 0;
      }
      /**
       * Returns item at `path`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path3, keepScalar) {
        if (Collection.isEmptyPath(path3))
          return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
        return identity.isCollection(this.contents) ? this.contents.getIn(path3, keepScalar) : void 0;
      }
      /**
       * Checks if the document includes a value with the key `key`.
       */
      has(key) {
        return identity.isCollection(this.contents) ? this.contents.has(key) : false;
      }
      /**
       * Checks if the document includes a value at `path`.
       */
      hasIn(path3) {
        if (Collection.isEmptyPath(path3))
          return this.contents !== void 0;
        return identity.isCollection(this.contents) ? this.contents.hasIn(path3) : false;
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      set(key, value) {
        if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, [key], value);
        } else if (assertCollection(this.contents)) {
          this.contents.set(key, value);
        }
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path3, value) {
        if (Collection.isEmptyPath(path3)) {
          this.contents = value;
        } else if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, Array.from(path3), value);
        } else if (assertCollection(this.contents)) {
          this.contents.setIn(path3, value);
        }
      }
      /**
       * Change the YAML version and schema used by the document.
       * A `null` version disables support for directives, explicit tags, anchors, and aliases.
       * It also requires the `schema` option to be given as a `Schema` instance value.
       *
       * Overrides all previously set schema options.
       */
      setSchema(version, options = {}) {
        if (typeof version === "number")
          version = String(version);
        let opt;
        switch (version) {
          case "1.1":
            if (this.directives)
              this.directives.yaml.version = "1.1";
            else
              this.directives = new directives.Directives({ version: "1.1" });
            opt = { resolveKnownTags: false, schema: "yaml-1.1" };
            break;
          case "1.2":
          case "next":
            if (this.directives)
              this.directives.yaml.version = version;
            else
              this.directives = new directives.Directives({ version });
            opt = { resolveKnownTags: true, schema: "core" };
            break;
          case null:
            if (this.directives)
              delete this.directives;
            opt = null;
            break;
          default: {
            const sv = JSON.stringify(version);
            throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
          }
        }
        if (options.schema instanceof Object)
          this.schema = options.schema;
        else if (opt)
          this.schema = new Schema.Schema(Object.assign(opt, options));
        else
          throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
      }
      // json & jsonArg are only used from toJSON()
      toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc: this,
          keep: !json,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this.contents, jsonArg ?? "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
      /**
       * A JSON representation of the document `contents`.
       *
       * @param jsonArg Used by `JSON.stringify` to indicate the array index or
       *   property name.
       */
      toJSON(jsonArg, onAnchor) {
        return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
      }
      /** A YAML representation of the document. */
      toString(options = {}) {
        if (this.errors.length > 0)
          throw new Error("Document with errors cannot be stringified");
        if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
          const s = JSON.stringify(options.indent);
          throw new Error(`"indent" option must be a positive integer, not ${s}`);
        }
        return stringifyDocument.stringifyDocument(this, options);
      }
    };
    function assertCollection(contents) {
      if (identity.isCollection(contents))
        return true;
      throw new Error("Expected a YAML collection as document contents");
    }
    __name(assertCollection, "assertCollection");
    exports.Document = Document;
  }
});

// node_modules/yaml/dist/errors.js
var require_errors = __commonJS({
  "node_modules/yaml/dist/errors.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var YAMLError = class extends Error {
      static {
        __name(this, "YAMLError");
      }
      constructor(name, pos, code, message) {
        super();
        this.name = name;
        this.code = code;
        this.message = message;
        this.pos = pos;
      }
    };
    var YAMLParseError = class extends YAMLError {
      static {
        __name(this, "YAMLParseError");
      }
      constructor(pos, code, message) {
        super("YAMLParseError", pos, code, message);
      }
    };
    var YAMLWarning = class extends YAMLError {
      static {
        __name(this, "YAMLWarning");
      }
      constructor(pos, code, message) {
        super("YAMLWarning", pos, code, message);
      }
    };
    var prettifyError = /* @__PURE__ */ __name((src, lc) => (error) => {
      if (error.pos[0] === -1)
        return;
      error.linePos = error.pos.map((pos) => lc.linePos(pos));
      const { line, col } = error.linePos[0];
      error.message += ` at line ${line}, column ${col}`;
      let ci = col - 1;
      let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
      if (ci >= 60 && lineStr.length > 80) {
        const trimStart = Math.min(ci - 39, lineStr.length - 79);
        lineStr = "\u2026" + lineStr.substring(trimStart);
        ci -= trimStart - 1;
      }
      if (lineStr.length > 80)
        lineStr = lineStr.substring(0, 79) + "\u2026";
      if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
        let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
        if (prev.length > 80)
          prev = prev.substring(0, 79) + "\u2026\n";
        lineStr = prev + lineStr;
      }
      if (/[^ ]/.test(lineStr)) {
        let count = 1;
        const end = error.linePos[1];
        if (end?.line === line && end.col > col) {
          count = Math.max(1, Math.min(end.col - col, 80 - ci));
        }
        const pointer = " ".repeat(ci) + "^".repeat(count);
        error.message += `:

${lineStr}
${pointer}
`;
      }
    }, "prettifyError");
    exports.YAMLError = YAMLError;
    exports.YAMLParseError = YAMLParseError;
    exports.YAMLWarning = YAMLWarning;
    exports.prettifyError = prettifyError;
  }
});

// node_modules/yaml/dist/compose/resolve-props.js
var require_resolve_props = __commonJS({
  "node_modules/yaml/dist/compose/resolve-props.js"(exports) {
    "use strict";
    init_esbuild_shims();
    function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
      let spaceBefore = false;
      let atNewline = startOnNewline;
      let hasSpace = startOnNewline;
      let comment = "";
      let commentSep = "";
      let hasNewline = false;
      let reqSpace = false;
      let tab = null;
      let anchor = null;
      let tag = null;
      let newlineAfterProp = null;
      let comma = null;
      let found = null;
      let start = null;
      for (const token of tokens) {
        if (reqSpace) {
          if (token.type !== "space" && token.type !== "newline" && token.type !== "comma")
            onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
          reqSpace = false;
        }
        if (tab) {
          if (atNewline && token.type !== "comment" && token.type !== "newline") {
            onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
          }
          tab = null;
        }
        switch (token.type) {
          case "space":
            if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("	")) {
              tab = token;
            }
            hasSpace = true;
            break;
          case "comment": {
            if (!hasSpace)
              onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
            const cb = token.source.substring(1) || " ";
            if (!comment)
              comment = cb;
            else
              comment += commentSep + cb;
            commentSep = "";
            atNewline = false;
            break;
          }
          case "newline":
            if (atNewline) {
              if (comment)
                comment += token.source;
              else if (!found || indicator !== "seq-item-ind")
                spaceBefore = true;
            } else
              commentSep += token.source;
            atNewline = true;
            hasNewline = true;
            if (anchor || tag)
              newlineAfterProp = token;
            hasSpace = true;
            break;
          case "anchor":
            if (anchor)
              onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
            if (token.source.endsWith(":"))
              onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
            anchor = token;
            start ?? (start = token.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          case "tag": {
            if (tag)
              onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
            tag = token;
            start ?? (start = token.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          }
          case indicator:
            if (anchor || tag)
              onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
            if (found)
              onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
            found = token;
            atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
            hasSpace = false;
            break;
          case "comma":
            if (flow) {
              if (comma)
                onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
              comma = token;
              atNewline = false;
              hasSpace = false;
              break;
            }
          // else fallthrough
          default:
            onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
            atNewline = false;
            hasSpace = false;
        }
      }
      const last = tokens[tokens.length - 1];
      const end = last ? last.offset + last.source.length : offset;
      if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
        onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
      }
      if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
        onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
      return {
        comma,
        found,
        spaceBefore,
        comment,
        hasNewline,
        anchor,
        tag,
        newlineAfterProp,
        end,
        start: start ?? end
      };
    }
    __name(resolveProps, "resolveProps");
    exports.resolveProps = resolveProps;
  }
});

// node_modules/yaml/dist/compose/util-contains-newline.js
var require_util_contains_newline = __commonJS({
  "node_modules/yaml/dist/compose/util-contains-newline.js"(exports) {
    "use strict";
    init_esbuild_shims();
    function containsNewline(key) {
      if (!key)
        return null;
      switch (key.type) {
        case "alias":
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          if (key.source.includes("\n"))
            return true;
          if (key.end) {
            for (const st of key.end)
              if (st.type === "newline")
                return true;
          }
          return false;
        case "flow-collection":
          for (const it of key.items) {
            for (const st of it.start)
              if (st.type === "newline")
                return true;
            if (it.sep) {
              for (const st of it.sep)
                if (st.type === "newline")
                  return true;
            }
            if (containsNewline(it.key) || containsNewline(it.value))
              return true;
          }
          return false;
        default:
          return true;
      }
    }
    __name(containsNewline, "containsNewline");
    exports.containsNewline = containsNewline;
  }
});

// node_modules/yaml/dist/compose/util-flow-indent-check.js
var require_util_flow_indent_check = __commonJS({
  "node_modules/yaml/dist/compose/util-flow-indent-check.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var utilContainsNewline = require_util_contains_newline();
    function flowIndentCheck(indent, fc, onError) {
      if (fc?.type === "flow-collection") {
        const end = fc.end[0];
        if (end.indent === indent && (end.source === "]" || end.source === "}") && utilContainsNewline.containsNewline(fc)) {
          const msg = "Flow end indicator should be more indented than parent";
          onError(end, "BAD_INDENT", msg, true);
        }
      }
    }
    __name(flowIndentCheck, "flowIndentCheck");
    exports.flowIndentCheck = flowIndentCheck;
  }
});

// node_modules/yaml/dist/compose/util-map-includes.js
var require_util_map_includes = __commonJS({
  "node_modules/yaml/dist/compose/util-map-includes.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var identity = require_identity();
    function mapIncludes(ctx, items, search) {
      const { uniqueKeys } = ctx.options;
      if (uniqueKeys === false)
        return false;
      const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity.isScalar(a) && identity.isScalar(b) && a.value === b.value;
      return items.some((pair) => isEqual(pair.key, search));
    }
    __name(mapIncludes, "mapIncludes");
    exports.mapIncludes = mapIncludes;
  }
});

// node_modules/yaml/dist/compose/resolve-block-map.js
var require_resolve_block_map = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-map.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    var utilMapIncludes = require_util_map_includes();
    var startColMsg = "All mapping items must start at the same column";
    function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLMap.YAMLMap;
      const map = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      let offset = bm.offset;
      let commentEnd = null;
      for (const collItem of bm.items) {
        const { start, key, sep: sep2, value } = collItem;
        const keyProps = resolveProps.resolveProps(start, {
          indicator: "explicit-key-ind",
          next: key ?? sep2?.[0],
          offset,
          onError,
          parentIndent: bm.indent,
          startOnNewline: true
        });
        const implicitKey = !keyProps.found;
        if (implicitKey) {
          if (key) {
            if (key.type === "block-seq")
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
            else if ("indent" in key && key.indent !== bm.indent)
              onError(offset, "BAD_INDENT", startColMsg);
          }
          if (!keyProps.anchor && !keyProps.tag && !sep2) {
            commentEnd = keyProps.end;
            if (keyProps.comment) {
              if (map.comment)
                map.comment += "\n" + keyProps.comment;
              else
                map.comment = keyProps.comment;
            }
            continue;
          }
          if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) {
            onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
          }
        } else if (keyProps.found?.indent !== bm.indent) {
          onError(offset, "BAD_INDENT", startColMsg);
        }
        ctx.atKey = true;
        const keyStart = keyProps.end;
        const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
        ctx.atKey = false;
        if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
          onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
        const valueProps = resolveProps.resolveProps(sep2 ?? [], {
          indicator: "map-value-ind",
          next: value,
          offset: keyNode.range[2],
          onError,
          parentIndent: bm.indent,
          startOnNewline: !key || key.type === "block-scalar"
        });
        offset = valueProps.end;
        if (valueProps.found) {
          if (implicitKey) {
            if (value?.type === "block-map" && !valueProps.hasNewline)
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
            if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
              onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep2, null, valueProps, onError);
          if (ctx.schema.compat)
            utilFlowIndentCheck.flowIndentCheck(bm.indent, value, onError);
          offset = valueNode.range[2];
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        } else {
          if (implicitKey)
            onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
          if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        }
      }
      if (commentEnd && commentEnd < offset)
        onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
      map.range = [bm.offset, offset, commentEnd ?? offset];
      return map;
    }
    __name(resolveBlockMap, "resolveBlockMap");
    exports.resolveBlockMap = resolveBlockMap;
  }
});

// node_modules/yaml/dist/compose/resolve-block-seq.js
var require_resolve_block_seq = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-seq.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var YAMLSeq = require_YAMLSeq();
    var resolveProps = require_resolve_props();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLSeq.YAMLSeq;
      const seq = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = bs.offset;
      let commentEnd = null;
      for (const { start, value } of bs.items) {
        const props = resolveProps.resolveProps(start, {
          indicator: "seq-item-ind",
          next: value,
          offset,
          onError,
          parentIndent: bs.indent,
          startOnNewline: true
        });
        if (!props.found) {
          if (props.anchor || props.tag || value) {
            if (value?.type === "block-seq")
              onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
            else
              onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
          } else {
            commentEnd = props.end;
            if (props.comment)
              seq.comment = props.comment;
            continue;
          }
        }
        const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
        offset = node.range[2];
        seq.items.push(node);
      }
      seq.range = [bs.offset, offset, commentEnd ?? offset];
      return seq;
    }
    __name(resolveBlockSeq, "resolveBlockSeq");
    exports.resolveBlockSeq = resolveBlockSeq;
  }
});

// node_modules/yaml/dist/compose/resolve-end.js
var require_resolve_end = __commonJS({
  "node_modules/yaml/dist/compose/resolve-end.js"(exports) {
    "use strict";
    init_esbuild_shims();
    function resolveEnd(end, offset, reqSpace, onError) {
      let comment = "";
      if (end) {
        let hasSpace = false;
        let sep2 = "";
        for (const token of end) {
          const { source, type } = token;
          switch (type) {
            case "space":
              hasSpace = true;
              break;
            case "comment": {
              if (reqSpace && !hasSpace)
                onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
              const cb = source.substring(1) || " ";
              if (!comment)
                comment = cb;
              else
                comment += sep2 + cb;
              sep2 = "";
              break;
            }
            case "newline":
              if (comment)
                sep2 += source;
              hasSpace = true;
              break;
            default:
              onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
          }
          offset += source.length;
        }
      }
      return { comment, offset };
    }
    __name(resolveEnd, "resolveEnd");
    exports.resolveEnd = resolveEnd;
  }
});

// node_modules/yaml/dist/compose/resolve-flow-collection.js
var require_resolve_flow_collection = __commonJS({
  "node_modules/yaml/dist/compose/resolve-flow-collection.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilMapIncludes = require_util_map_includes();
    var blockMsg = "Block collections are not allowed within flow collections";
    var isBlock = /* @__PURE__ */ __name((token) => token && (token.type === "block-map" || token.type === "block-seq"), "isBlock");
    function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
      const isMap = fc.start.source === "{";
      const fcName = isMap ? "flow map" : "flow sequence";
      const NodeClass = tag?.nodeClass ?? (isMap ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq);
      const coll = new NodeClass(ctx.schema);
      coll.flow = true;
      const atRoot = ctx.atRoot;
      if (atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = fc.offset + fc.start.source.length;
      for (let i = 0; i < fc.items.length; ++i) {
        const collItem = fc.items[i];
        const { start, key, sep: sep2, value } = collItem;
        const props = resolveProps.resolveProps(start, {
          flow: fcName,
          indicator: "explicit-key-ind",
          next: key ?? sep2?.[0],
          offset,
          onError,
          parentIndent: fc.indent,
          startOnNewline: false
        });
        if (!props.found) {
          if (!props.anchor && !props.tag && !sep2 && !value) {
            if (i === 0 && props.comma)
              onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
            else if (i < fc.items.length - 1)
              onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
            if (props.comment) {
              if (coll.comment)
                coll.comment += "\n" + props.comment;
              else
                coll.comment = props.comment;
            }
            offset = props.end;
            continue;
          }
          if (!isMap && ctx.options.strict && utilContainsNewline.containsNewline(key))
            onError(
              key,
              // checked by containsNewline()
              "MULTILINE_IMPLICIT_KEY",
              "Implicit keys of flow sequence pairs need to be on a single line"
            );
        }
        if (i === 0) {
          if (props.comma)
            onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
        } else {
          if (!props.comma)
            onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
          if (props.comment) {
            let prevItemComment = "";
            loop: for (const st of start) {
              switch (st.type) {
                case "comma":
                case "space":
                  break;
                case "comment":
                  prevItemComment = st.source.substring(1);
                  break loop;
                default:
                  break loop;
              }
            }
            if (prevItemComment) {
              let prev = coll.items[coll.items.length - 1];
              if (identity.isPair(prev))
                prev = prev.value ?? prev.key;
              if (prev.comment)
                prev.comment += "\n" + prevItemComment;
              else
                prev.comment = prevItemComment;
              props.comment = props.comment.substring(prevItemComment.length + 1);
            }
          }
        }
        if (!isMap && !sep2 && !props.found) {
          const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep2, null, props, onError);
          coll.items.push(valueNode);
          offset = valueNode.range[2];
          if (isBlock(value))
            onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
        } else {
          ctx.atKey = true;
          const keyStart = props.end;
          const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
          if (isBlock(key))
            onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
          ctx.atKey = false;
          const valueProps = resolveProps.resolveProps(sep2 ?? [], {
            flow: fcName,
            indicator: "map-value-ind",
            next: value,
            offset: keyNode.range[2],
            onError,
            parentIndent: fc.indent,
            startOnNewline: false
          });
          if (valueProps.found) {
            if (!isMap && !props.found && ctx.options.strict) {
              if (sep2)
                for (const st of sep2) {
                  if (st === valueProps.found)
                    break;
                  if (st.type === "newline") {
                    onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                    break;
                  }
                }
              if (props.start < valueProps.found.offset - 1024)
                onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
            }
          } else if (value) {
            if ("source" in value && value.source?.[0] === ":")
              onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
            else
              onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep2, null, valueProps, onError) : null;
          if (valueNode) {
            if (isBlock(value))
              onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
          } else if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          if (isMap) {
            const map = coll;
            if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
              onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
            map.items.push(pair);
          } else {
            const map = new YAMLMap.YAMLMap(ctx.schema);
            map.flow = true;
            map.items.push(pair);
            const endRange = (valueNode ?? keyNode).range;
            map.range = [keyNode.range[0], endRange[1], endRange[2]];
            coll.items.push(map);
          }
          offset = valueNode ? valueNode.range[2] : valueProps.end;
        }
      }
      const expectedEnd = isMap ? "}" : "]";
      const [ce, ...ee] = fc.end;
      let cePos = offset;
      if (ce?.source === expectedEnd)
        cePos = ce.offset + ce.source.length;
      else {
        const name = fcName[0].toUpperCase() + fcName.substring(1);
        const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
        onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
        if (ce && ce.source.length !== 1)
          ee.unshift(ce);
      }
      if (ee.length > 0) {
        const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
        if (end.comment) {
          if (coll.comment)
            coll.comment += "\n" + end.comment;
          else
            coll.comment = end.comment;
        }
        coll.range = [fc.offset, cePos, end.offset];
      } else {
        coll.range = [fc.offset, cePos, cePos];
      }
      return coll;
    }
    __name(resolveFlowCollection, "resolveFlowCollection");
    exports.resolveFlowCollection = resolveFlowCollection;
  }
});

// node_modules/yaml/dist/compose/compose-collection.js
var require_compose_collection = __commonJS({
  "node_modules/yaml/dist/compose/compose-collection.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveBlockMap = require_resolve_block_map();
    var resolveBlockSeq = require_resolve_block_seq();
    var resolveFlowCollection = require_resolve_flow_collection();
    function resolveCollection(CN, ctx, token, onError, tagName, tag) {
      const coll = token.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token, onError, tag) : resolveFlowCollection.resolveFlowCollection(CN, ctx, token, onError, tag);
      const Coll = coll.constructor;
      if (tagName === "!" || tagName === Coll.tagName) {
        coll.tag = Coll.tagName;
        return coll;
      }
      if (tagName)
        coll.tag = tagName;
      return coll;
    }
    __name(resolveCollection, "resolveCollection");
    function composeCollection(CN, ctx, token, props, onError) {
      const tagToken = props.tag;
      const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
      if (token.type === "block-seq") {
        const { anchor, newlineAfterProp: nl } = props;
        const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
        if (lastProp && (!nl || nl.offset < lastProp.offset)) {
          const message = "Missing newline after block sequence props";
          onError(lastProp, "MISSING_CHAR", message);
        }
      }
      const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
      if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.YAMLSeq.tagName && expType === "seq") {
        return resolveCollection(CN, ctx, token, onError, tagName);
      }
      let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
      if (!tag) {
        const kt = ctx.schema.knownTags[tagName];
        if (kt?.collection === expType) {
          ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
          tag = kt;
        } else {
          if (kt) {
            onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
          } else {
            onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
          }
          return resolveCollection(CN, ctx, token, onError, tagName);
        }
      }
      const coll = resolveCollection(CN, ctx, token, onError, tagName, tag);
      const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
      const node = identity.isNode(res) ? res : new Scalar.Scalar(res);
      node.range = coll.range;
      node.tag = tagName;
      if (tag?.format)
        node.format = tag.format;
      return node;
    }
    __name(composeCollection, "composeCollection");
    exports.composeCollection = composeCollection;
  }
});

// node_modules/yaml/dist/compose/resolve-block-scalar.js
var require_resolve_block_scalar = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-scalar.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var Scalar = require_Scalar();
    function resolveBlockScalar(ctx, scalar, onError) {
      const start = scalar.offset;
      const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
      if (!header)
        return { value: "", type: null, comment: "", range: [start, start, start] };
      const type = header.mode === ">" ? Scalar.Scalar.BLOCK_FOLDED : Scalar.Scalar.BLOCK_LITERAL;
      const lines = scalar.source ? splitLines(scalar.source) : [];
      let chompStart = lines.length;
      for (let i = lines.length - 1; i >= 0; --i) {
        const content = lines[i][1];
        if (content === "" || content === "\r")
          chompStart = i;
        else
          break;
      }
      if (chompStart === 0) {
        const value2 = header.chomp === "+" && lines.length > 0 ? "\n".repeat(Math.max(1, lines.length - 1)) : "";
        let end2 = start + header.length;
        if (scalar.source)
          end2 += scalar.source.length;
        return { value: value2, type, comment: header.comment, range: [start, end2, end2] };
      }
      let trimIndent = scalar.indent + header.indent;
      let offset = scalar.offset + header.length;
      let contentStart = 0;
      for (let i = 0; i < chompStart; ++i) {
        const [indent, content] = lines[i];
        if (content === "" || content === "\r") {
          if (header.indent === 0 && indent.length > trimIndent)
            trimIndent = indent.length;
        } else {
          if (indent.length < trimIndent) {
            const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
            onError(offset + indent.length, "MISSING_CHAR", message);
          }
          if (header.indent === 0)
            trimIndent = indent.length;
          contentStart = i;
          if (trimIndent === 0 && !ctx.atRoot) {
            const message = "Block scalar values in collections must be indented";
            onError(offset, "BAD_INDENT", message);
          }
          break;
        }
        offset += indent.length + content.length + 1;
      }
      for (let i = lines.length - 1; i >= chompStart; --i) {
        if (lines[i][0].length > trimIndent)
          chompStart = i + 1;
      }
      let value = "";
      let sep2 = "";
      let prevMoreIndented = false;
      for (let i = 0; i < contentStart; ++i)
        value += lines[i][0].slice(trimIndent) + "\n";
      for (let i = contentStart; i < chompStart; ++i) {
        let [indent, content] = lines[i];
        offset += indent.length + content.length + 1;
        const crlf = content[content.length - 1] === "\r";
        if (crlf)
          content = content.slice(0, -1);
        if (content && indent.length < trimIndent) {
          const src = header.indent ? "explicit indentation indicator" : "first line";
          const message = `Block scalar lines must not be less indented than their ${src}`;
          onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
          indent = "";
        }
        if (type === Scalar.Scalar.BLOCK_LITERAL) {
          value += sep2 + indent.slice(trimIndent) + content;
          sep2 = "\n";
        } else if (indent.length > trimIndent || content[0] === "	") {
          if (sep2 === " ")
            sep2 = "\n";
          else if (!prevMoreIndented && sep2 === "\n")
            sep2 = "\n\n";
          value += sep2 + indent.slice(trimIndent) + content;
          sep2 = "\n";
          prevMoreIndented = true;
        } else if (content === "") {
          if (sep2 === "\n")
            value += "\n";
          else
            sep2 = "\n";
        } else {
          value += sep2 + content;
          sep2 = " ";
          prevMoreIndented = false;
        }
      }
      switch (header.chomp) {
        case "-":
          break;
        case "+":
          for (let i = chompStart; i < lines.length; ++i)
            value += "\n" + lines[i][0].slice(trimIndent);
          if (value[value.length - 1] !== "\n")
            value += "\n";
          break;
        default:
          value += "\n";
      }
      const end = start + header.length + scalar.source.length;
      return { value, type, comment: header.comment, range: [start, end, end] };
    }
    __name(resolveBlockScalar, "resolveBlockScalar");
    function parseBlockScalarHeader({ offset, props }, strict, onError) {
      if (props[0].type !== "block-scalar-header") {
        onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
        return null;
      }
      const { source } = props[0];
      const mode = source[0];
      let indent = 0;
      let chomp = "";
      let error = -1;
      for (let i = 1; i < source.length; ++i) {
        const ch = source[i];
        if (!chomp && (ch === "-" || ch === "+"))
          chomp = ch;
        else {
          const n = Number(ch);
          if (!indent && n)
            indent = n;
          else if (error === -1)
            error = offset + i;
        }
      }
      if (error !== -1)
        onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
      let hasSpace = false;
      let comment = "";
      let length = source.length;
      for (let i = 1; i < props.length; ++i) {
        const token = props[i];
        switch (token.type) {
          case "space":
            hasSpace = true;
          // fallthrough
          case "newline":
            length += token.source.length;
            break;
          case "comment":
            if (strict && !hasSpace) {
              const message = "Comments must be separated from other tokens by white space characters";
              onError(token, "MISSING_CHAR", message);
            }
            length += token.source.length;
            comment = token.source.substring(1);
            break;
          case "error":
            onError(token, "UNEXPECTED_TOKEN", token.message);
            length += token.source.length;
            break;
          /* istanbul ignore next should not happen */
          default: {
            const message = `Unexpected token in block scalar header: ${token.type}`;
            onError(token, "UNEXPECTED_TOKEN", message);
            const ts = token.source;
            if (ts && typeof ts === "string")
              length += ts.length;
          }
        }
      }
      return { mode, indent, chomp, comment, length };
    }
    __name(parseBlockScalarHeader, "parseBlockScalarHeader");
    function splitLines(source) {
      const split = source.split(/\n( *)/);
      const first = split[0];
      const m = first.match(/^( *)/);
      const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
      const lines = [line0];
      for (let i = 1; i < split.length; i += 2)
        lines.push([split[i], split[i + 1]]);
      return lines;
    }
    __name(splitLines, "splitLines");
    exports.resolveBlockScalar = resolveBlockScalar;
  }
});

// node_modules/yaml/dist/compose/resolve-flow-scalar.js
var require_resolve_flow_scalar = __commonJS({
  "node_modules/yaml/dist/compose/resolve-flow-scalar.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var Scalar = require_Scalar();
    var resolveEnd = require_resolve_end();
    function resolveFlowScalar(scalar, strict, onError) {
      const { offset, type, source, end } = scalar;
      let _type;
      let value;
      const _onError = /* @__PURE__ */ __name((rel, code, msg) => onError(offset + rel, code, msg), "_onError");
      switch (type) {
        case "scalar":
          _type = Scalar.Scalar.PLAIN;
          value = plainValue(source, _onError);
          break;
        case "single-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_SINGLE;
          value = singleQuotedValue(source, _onError);
          break;
        case "double-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_DOUBLE;
          value = doubleQuotedValue(source, _onError);
          break;
        /* istanbul ignore next should not happen */
        default:
          onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
          return {
            value: "",
            type: null,
            comment: "",
            range: [offset, offset + source.length, offset + source.length]
          };
      }
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
      return {
        value,
        type: _type,
        comment: re.comment,
        range: [offset, valueEnd, re.offset]
      };
    }
    __name(resolveFlowScalar, "resolveFlowScalar");
    function plainValue(source, onError) {
      let badChar = "";
      switch (source[0]) {
        /* istanbul ignore next should not happen */
        case "	":
          badChar = "a tab character";
          break;
        case ",":
          badChar = "flow indicator character ,";
          break;
        case "%":
          badChar = "directive indicator character %";
          break;
        case "|":
        case ">": {
          badChar = `block scalar indicator ${source[0]}`;
          break;
        }
        case "@":
        case "`": {
          badChar = `reserved character ${source[0]}`;
          break;
        }
      }
      if (badChar)
        onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
      return foldLines(source);
    }
    __name(plainValue, "plainValue");
    function singleQuotedValue(source, onError) {
      if (source[source.length - 1] !== "'" || source.length === 1)
        onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
      return foldLines(source.slice(1, -1)).replace(/''/g, "'");
    }
    __name(singleQuotedValue, "singleQuotedValue");
    function foldLines(source) {
      let first, line;
      try {
        first = new RegExp("(.*?)(?<![ 	])[ 	]*\r?\n", "sy");
        line = new RegExp("[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?\n", "sy");
      } catch {
        first = /(.*?)[ \t]*\r?\n/sy;
        line = /[ \t]*(.*?)[ \t]*\r?\n/sy;
      }
      let match = first.exec(source);
      if (!match)
        return source;
      let res = match[1];
      let sep2 = " ";
      let pos = first.lastIndex;
      line.lastIndex = pos;
      while (match = line.exec(source)) {
        if (match[1] === "") {
          if (sep2 === "\n")
            res += sep2;
          else
            sep2 = "\n";
        } else {
          res += sep2 + match[1];
          sep2 = " ";
        }
        pos = line.lastIndex;
      }
      const last = /[ \t]*(.*)/sy;
      last.lastIndex = pos;
      match = last.exec(source);
      return res + sep2 + (match?.[1] ?? "");
    }
    __name(foldLines, "foldLines");
    function doubleQuotedValue(source, onError) {
      let res = "";
      for (let i = 1; i < source.length - 1; ++i) {
        const ch = source[i];
        if (ch === "\r" && source[i + 1] === "\n")
          continue;
        if (ch === "\n") {
          const { fold, offset } = foldNewline(source, i);
          res += fold;
          i = offset;
        } else if (ch === "\\") {
          let next = source[++i];
          const cc = escapeCodes[next];
          if (cc)
            res += cc;
          else if (next === "\n") {
            next = source[i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "\r" && source[i + 1] === "\n") {
            next = source[++i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "x" || next === "u" || next === "U") {
            const length = next === "x" ? 2 : next === "u" ? 4 : 8;
            res += parseCharCode(source, i + 1, length, onError);
            i += length;
          } else {
            const raw = source.substr(i - 1, 2);
            onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
            res += raw;
          }
        } else if (ch === " " || ch === "	") {
          const wsStart = i;
          let next = source[i + 1];
          while (next === " " || next === "	")
            next = source[++i + 1];
          if (next !== "\n" && !(next === "\r" && source[i + 2] === "\n"))
            res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
        } else {
          res += ch;
        }
      }
      if (source[source.length - 1] !== '"' || source.length === 1)
        onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
      return res;
    }
    __name(doubleQuotedValue, "doubleQuotedValue");
    function foldNewline(source, offset) {
      let fold = "";
      let ch = source[offset + 1];
      while (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
        if (ch === "\r" && source[offset + 2] !== "\n")
          break;
        if (ch === "\n")
          fold += "\n";
        offset += 1;
        ch = source[offset + 1];
      }
      if (!fold)
        fold = " ";
      return { fold, offset };
    }
    __name(foldNewline, "foldNewline");
    var escapeCodes = {
      "0": "\0",
      // null character
      a: "\x07",
      // bell character
      b: "\b",
      // backspace
      e: "\x1B",
      // escape character
      f: "\f",
      // form feed
      n: "\n",
      // line feed
      r: "\r",
      // carriage return
      t: "	",
      // horizontal tab
      v: "\v",
      // vertical tab
      N: "\x85",
      // Unicode next line
      _: "\xA0",
      // Unicode non-breaking space
      L: "\u2028",
      // Unicode line separator
      P: "\u2029",
      // Unicode paragraph separator
      " ": " ",
      '"': '"',
      "/": "/",
      "\\": "\\",
      "	": "	"
    };
    function parseCharCode(source, offset, length, onError) {
      const cc = source.substr(offset, length);
      const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
      const code = ok ? parseInt(cc, 16) : NaN;
      try {
        return String.fromCodePoint(code);
      } catch {
        const raw = source.substr(offset - 2, length + 2);
        onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
        return raw;
      }
    }
    __name(parseCharCode, "parseCharCode");
    exports.resolveFlowScalar = resolveFlowScalar;
  }
});

// node_modules/yaml/dist/compose/compose-scalar.js
var require_compose_scalar = __commonJS({
  "node_modules/yaml/dist/compose/compose-scalar.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    function composeScalar(ctx, token, tagToken, onError) {
      const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar.resolveBlockScalar(ctx, token, onError) : resolveFlowScalar.resolveFlowScalar(token, ctx.options.strict, onError);
      const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
      let tag;
      if (ctx.options.stringKeys && ctx.atKey) {
        tag = ctx.schema[identity.SCALAR];
      } else if (tagName)
        tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
      else if (token.type === "scalar")
        tag = findScalarTagByTest(ctx, value, token, onError);
      else
        tag = ctx.schema[identity.SCALAR];
      let scalar;
      try {
        const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
        scalar = identity.isScalar(res) ? res : new Scalar.Scalar(res);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
        scalar = new Scalar.Scalar(value);
      }
      scalar.range = range;
      scalar.source = value;
      if (type)
        scalar.type = type;
      if (tagName)
        scalar.tag = tagName;
      if (tag.format)
        scalar.format = tag.format;
      if (comment)
        scalar.comment = comment;
      return scalar;
    }
    __name(composeScalar, "composeScalar");
    function findScalarTagByName(schema, value, tagName, tagToken, onError) {
      if (tagName === "!")
        return schema[identity.SCALAR];
      const matchWithTest = [];
      for (const tag of schema.tags) {
        if (!tag.collection && tag.tag === tagName) {
          if (tag.default && tag.test)
            matchWithTest.push(tag);
          else
            return tag;
        }
      }
      for (const tag of matchWithTest)
        if (tag.test?.test(value))
          return tag;
      const kt = schema.knownTags[tagName];
      if (kt && !kt.collection) {
        schema.tags.push(Object.assign({}, kt, { default: false, test: void 0 }));
        return kt;
      }
      onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
      return schema[identity.SCALAR];
    }
    __name(findScalarTagByName, "findScalarTagByName");
    function findScalarTagByTest({ atKey, directives, schema }, value, token, onError) {
      const tag = schema.tags.find((tag2) => (tag2.default === true || atKey && tag2.default === "key") && tag2.test?.test(value)) || schema[identity.SCALAR];
      if (schema.compat) {
        const compat = schema.compat.find((tag2) => tag2.default && tag2.test?.test(value)) ?? schema[identity.SCALAR];
        if (tag.tag !== compat.tag) {
          const ts = directives.tagString(tag.tag);
          const cs = directives.tagString(compat.tag);
          const msg = `Value may be parsed as either ${ts} or ${cs}`;
          onError(token, "TAG_RESOLVE_FAILED", msg, true);
        }
      }
      return tag;
    }
    __name(findScalarTagByTest, "findScalarTagByTest");
    exports.composeScalar = composeScalar;
  }
});

// node_modules/yaml/dist/compose/util-empty-scalar-position.js
var require_util_empty_scalar_position = __commonJS({
  "node_modules/yaml/dist/compose/util-empty-scalar-position.js"(exports) {
    "use strict";
    init_esbuild_shims();
    function emptyScalarPosition(offset, before, pos) {
      if (before) {
        pos ?? (pos = before.length);
        for (let i = pos - 1; i >= 0; --i) {
          let st = before[i];
          switch (st.type) {
            case "space":
            case "comment":
            case "newline":
              offset -= st.source.length;
              continue;
          }
          st = before[++i];
          while (st?.type === "space") {
            offset += st.source.length;
            st = before[++i];
          }
          break;
        }
      }
      return offset;
    }
    __name(emptyScalarPosition, "emptyScalarPosition");
    exports.emptyScalarPosition = emptyScalarPosition;
  }
});

// node_modules/yaml/dist/compose/compose-node.js
var require_compose_node = __commonJS({
  "node_modules/yaml/dist/compose/compose-node.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var Alias = require_Alias();
    var identity = require_identity();
    var composeCollection = require_compose_collection();
    var composeScalar = require_compose_scalar();
    var resolveEnd = require_resolve_end();
    var utilEmptyScalarPosition = require_util_empty_scalar_position();
    var CN = { composeNode, composeEmptyNode };
    function composeNode(ctx, token, props, onError) {
      const atKey = ctx.atKey;
      const { spaceBefore, comment, anchor, tag } = props;
      let node;
      let isSrcToken = true;
      switch (token.type) {
        case "alias":
          node = composeAlias(ctx, token, onError);
          if (anchor || tag)
            onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
          break;
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "block-scalar":
          node = composeScalar.composeScalar(ctx, token, tag, onError);
          if (anchor)
            node.anchor = anchor.source.substring(1);
          break;
        case "block-map":
        case "block-seq":
        case "flow-collection":
          try {
            node = composeCollection.composeCollection(CN, ctx, token, props, onError);
            if (anchor)
              node.anchor = anchor.source.substring(1);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            onError(token, "RESOURCE_EXHAUSTION", message);
          }
          break;
        default: {
          const message = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
          onError(token, "UNEXPECTED_TOKEN", message);
          isSrcToken = false;
        }
      }
      node ?? (node = composeEmptyNode(ctx, token.offset, void 0, null, props, onError));
      if (anchor && node.anchor === "")
        onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      if (atKey && ctx.options.stringKeys && (!identity.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
        const msg = "With stringKeys, all keys must be strings";
        onError(tag ?? token, "NON_STRING_KEY", msg);
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        if (token.type === "scalar" && token.source === "")
          node.comment = comment;
        else
          node.commentBefore = comment;
      }
      if (ctx.options.keepSourceTokens && isSrcToken)
        node.srcToken = token;
      return node;
    }
    __name(composeNode, "composeNode");
    function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
      const token = {
        type: "scalar",
        offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
        indent: -1,
        source: ""
      };
      const node = composeScalar.composeScalar(ctx, token, tag, onError);
      if (anchor) {
        node.anchor = anchor.source.substring(1);
        if (node.anchor === "")
          onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        node.comment = comment;
        node.range[2] = end;
      }
      return node;
    }
    __name(composeEmptyNode, "composeEmptyNode");
    function composeAlias({ options }, { offset, source, end }, onError) {
      const alias = new Alias.Alias(source.substring(1));
      if (alias.source === "")
        onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
      if (alias.source.endsWith(":"))
        onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, options.strict, onError);
      alias.range = [offset, valueEnd, re.offset];
      if (re.comment)
        alias.comment = re.comment;
      return alias;
    }
    __name(composeAlias, "composeAlias");
    exports.composeEmptyNode = composeEmptyNode;
    exports.composeNode = composeNode;
  }
});

// node_modules/yaml/dist/compose/compose-doc.js
var require_compose_doc = __commonJS({
  "node_modules/yaml/dist/compose/compose-doc.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var Document = require_Document();
    var composeNode = require_compose_node();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    function composeDoc(options, directives, { offset, start, value, end }, onError) {
      const opts = Object.assign({ _directives: directives }, options);
      const doc = new Document.Document(void 0, opts);
      const ctx = {
        atKey: false,
        atRoot: true,
        directives: doc.directives,
        options: doc.options,
        schema: doc.schema
      };
      const props = resolveProps.resolveProps(start, {
        indicator: "doc-start",
        next: value ?? end?.[0],
        offset,
        onError,
        parentIndent: 0,
        startOnNewline: true
      });
      if (props.found) {
        doc.directives.docStart = true;
        if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
          onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
      }
      doc.contents = value ? composeNode.composeNode(ctx, value, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
      const contentEnd = doc.contents.range[2];
      const re = resolveEnd.resolveEnd(end, contentEnd, false, onError);
      if (re.comment)
        doc.comment = re.comment;
      doc.range = [offset, contentEnd, re.offset];
      return doc;
    }
    __name(composeDoc, "composeDoc");
    exports.composeDoc = composeDoc;
  }
});

// node_modules/yaml/dist/compose/composer.js
var require_composer = __commonJS({
  "node_modules/yaml/dist/compose/composer.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var node_process = __require("process");
    var directives = require_directives();
    var Document = require_Document();
    var errors = require_errors();
    var identity = require_identity();
    var composeDoc = require_compose_doc();
    var resolveEnd = require_resolve_end();
    function getErrorPos(src) {
      if (typeof src === "number")
        return [src, src + 1];
      if (Array.isArray(src))
        return src.length === 2 ? src : [src[0], src[1]];
      const { offset, source } = src;
      return [offset, offset + (typeof source === "string" ? source.length : 1)];
    }
    __name(getErrorPos, "getErrorPos");
    function parsePrelude(prelude) {
      let comment = "";
      let atComment = false;
      let afterEmptyLine = false;
      for (let i = 0; i < prelude.length; ++i) {
        const source = prelude[i];
        switch (source[0]) {
          case "#":
            comment += (comment === "" ? "" : afterEmptyLine ? "\n\n" : "\n") + (source.substring(1) || " ");
            atComment = true;
            afterEmptyLine = false;
            break;
          case "%":
            if (prelude[i + 1]?.[0] !== "#")
              i += 1;
            atComment = false;
            break;
          default:
            if (!atComment)
              afterEmptyLine = true;
            atComment = false;
        }
      }
      return { comment, afterEmptyLine };
    }
    __name(parsePrelude, "parsePrelude");
    var Composer = class {
      static {
        __name(this, "Composer");
      }
      constructor(options = {}) {
        this.doc = null;
        this.atDirectives = false;
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
        this.onError = (source, code, message, warning) => {
          const pos = getErrorPos(source);
          if (warning)
            this.warnings.push(new errors.YAMLWarning(pos, code, message));
          else
            this.errors.push(new errors.YAMLParseError(pos, code, message));
        };
        this.directives = new directives.Directives({ version: options.version || "1.2" });
        this.options = options;
      }
      decorate(doc, afterDoc) {
        const { comment, afterEmptyLine } = parsePrelude(this.prelude);
        if (comment) {
          const dc = doc.contents;
          if (afterDoc) {
            doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
          } else if (afterEmptyLine || doc.directives.docStart || !dc) {
            doc.commentBefore = comment;
          } else if (identity.isCollection(dc) && !dc.flow && dc.items.length > 0) {
            let it = dc.items[0];
            if (identity.isPair(it))
              it = it.key;
            const cb = it.commentBefore;
            it.commentBefore = cb ? `${comment}
${cb}` : comment;
          } else {
            const cb = dc.commentBefore;
            dc.commentBefore = cb ? `${comment}
${cb}` : comment;
          }
        }
        if (afterDoc) {
          for (let i = 0; i < this.errors.length; ++i)
            doc.errors.push(this.errors[i]);
          for (let i = 0; i < this.warnings.length; ++i)
            doc.warnings.push(this.warnings[i]);
        } else {
          doc.errors = this.errors;
          doc.warnings = this.warnings;
        }
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
      }
      /**
       * Current stream status information.
       *
       * Mostly useful at the end of input for an empty stream.
       */
      streamInfo() {
        return {
          comment: parsePrelude(this.prelude).comment,
          directives: this.directives,
          errors: this.errors,
          warnings: this.warnings
        };
      }
      /**
       * Compose tokens into documents.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *compose(tokens, forceDoc = false, endOffset = -1) {
        for (const token of tokens)
          yield* this.next(token);
        yield* this.end(forceDoc, endOffset);
      }
      /** Advance the composer by one CST token. */
      *next(token) {
        if (node_process.env.LOG_STREAM)
          console.dir(token, { depth: null });
        switch (token.type) {
          case "directive":
            this.directives.add(token.source, (offset, message, warning) => {
              const pos = getErrorPos(token);
              pos[0] += offset;
              this.onError(pos, "BAD_DIRECTIVE", message, warning);
            });
            this.prelude.push(token.source);
            this.atDirectives = true;
            break;
          case "document": {
            const doc = composeDoc.composeDoc(this.options, this.directives, token, this.onError);
            if (this.atDirectives && !doc.directives.docStart)
              this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
            this.decorate(doc, false);
            if (this.doc)
              yield this.doc;
            this.doc = doc;
            this.atDirectives = false;
            break;
          }
          case "byte-order-mark":
          case "space":
            break;
          case "comment":
          case "newline":
            this.prelude.push(token.source);
            break;
          case "error": {
            const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
            const error = new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
            if (this.atDirectives || !this.doc)
              this.errors.push(error);
            else
              this.doc.errors.push(error);
            break;
          }
          case "doc-end": {
            if (!this.doc) {
              const msg = "Unexpected doc-end without preceding document";
              this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
              break;
            }
            this.doc.directives.docEnd = true;
            const end = resolveEnd.resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
            this.decorate(this.doc, true);
            if (end.comment) {
              const dc = this.doc.comment;
              this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
            }
            this.doc.range[2] = end.offset;
            break;
          }
          default:
            this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
        }
      }
      /**
       * Call at end of input to yield any remaining document.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *end(forceDoc = false, endOffset = -1) {
        if (this.doc) {
          this.decorate(this.doc, true);
          yield this.doc;
          this.doc = null;
        } else if (forceDoc) {
          const opts = Object.assign({ _directives: this.directives }, this.options);
          const doc = new Document.Document(void 0, opts);
          if (this.atDirectives)
            this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
          doc.range = [0, endOffset, endOffset];
          this.decorate(doc, false);
          yield doc;
        }
      }
    };
    exports.Composer = Composer;
  }
});

// node_modules/yaml/dist/parse/cst-scalar.js
var require_cst_scalar = __commonJS({
  "node_modules/yaml/dist/parse/cst-scalar.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    var errors = require_errors();
    var stringifyString = require_stringifyString();
    function resolveAsScalar(token, strict = true, onError) {
      if (token) {
        const _onError = /* @__PURE__ */ __name((pos, code, message) => {
          const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
          if (onError)
            onError(offset, code, message);
          else
            throw new errors.YAMLParseError([offset, offset + 1], code, message);
        }, "_onError");
        switch (token.type) {
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return resolveFlowScalar.resolveFlowScalar(token, strict, _onError);
          case "block-scalar":
            return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token, _onError);
        }
      }
      return null;
    }
    __name(resolveAsScalar, "resolveAsScalar");
    function createScalarToken(value, context) {
      const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey,
        indent: indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      const end = context.end ?? [
        { type: "newline", offset: -1, indent, source: "\n" }
      ];
      switch (source[0]) {
        case "|":
        case ">": {
          const he = source.indexOf("\n");
          const head = source.substring(0, he);
          const body = source.substring(he + 1) + "\n";
          const props = [
            { type: "block-scalar-header", offset, indent, source: head }
          ];
          if (!addEndtoBlockProps(props, end))
            props.push({ type: "newline", offset: -1, indent, source: "\n" });
          return { type: "block-scalar", offset, indent, props, source: body };
        }
        case '"':
          return { type: "double-quoted-scalar", offset, indent, source, end };
        case "'":
          return { type: "single-quoted-scalar", offset, indent, source, end };
        default:
          return { type: "scalar", offset, indent, source, end };
      }
    }
    __name(createScalarToken, "createScalarToken");
    function setScalarValue(token, value, context = {}) {
      let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
      let indent = "indent" in token ? token.indent : null;
      if (afterKey && typeof indent === "number")
        indent += 2;
      if (!type)
        switch (token.type) {
          case "single-quoted-scalar":
            type = "QUOTE_SINGLE";
            break;
          case "double-quoted-scalar":
            type = "QUOTE_DOUBLE";
            break;
          case "block-scalar": {
            const header = token.props[0];
            if (header.type !== "block-scalar-header")
              throw new Error("Invalid block scalar header");
            type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
            break;
          }
          default:
            type = "PLAIN";
        }
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey: implicitKey || indent === null,
        indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      switch (source[0]) {
        case "|":
        case ">":
          setBlockScalarValue(token, source);
          break;
        case '"':
          setFlowScalarValue(token, source, "double-quoted-scalar");
          break;
        case "'":
          setFlowScalarValue(token, source, "single-quoted-scalar");
          break;
        default:
          setFlowScalarValue(token, source, "scalar");
      }
    }
    __name(setScalarValue, "setScalarValue");
    function setBlockScalarValue(token, source) {
      const he = source.indexOf("\n");
      const head = source.substring(0, he);
      const body = source.substring(he + 1) + "\n";
      if (token.type === "block-scalar") {
        const header = token.props[0];
        if (header.type !== "block-scalar-header")
          throw new Error("Invalid block scalar header");
        header.source = head;
        token.source = body;
      } else {
        const { offset } = token;
        const indent = "indent" in token ? token.indent : -1;
        const props = [
          { type: "block-scalar-header", offset, indent, source: head }
        ];
        if (!addEndtoBlockProps(props, "end" in token ? token.end : void 0))
          props.push({ type: "newline", offset: -1, indent, source: "\n" });
        for (const key of Object.keys(token))
          if (key !== "type" && key !== "offset")
            delete token[key];
        Object.assign(token, { type: "block-scalar", indent, props, source: body });
      }
    }
    __name(setBlockScalarValue, "setBlockScalarValue");
    function addEndtoBlockProps(props, end) {
      if (end)
        for (const st of end)
          switch (st.type) {
            case "space":
            case "comment":
              props.push(st);
              break;
            case "newline":
              props.push(st);
              return true;
          }
      return false;
    }
    __name(addEndtoBlockProps, "addEndtoBlockProps");
    function setFlowScalarValue(token, source, type) {
      switch (token.type) {
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          token.type = type;
          token.source = source;
          break;
        case "block-scalar": {
          const end = token.props.slice(1);
          let oa = source.length;
          if (token.props[0].type === "block-scalar-header")
            oa -= token.props[0].source.length;
          for (const tok of end)
            tok.offset += oa;
          delete token.props;
          Object.assign(token, { type, source, end });
          break;
        }
        case "block-map":
        case "block-seq": {
          const offset = token.offset + source.length;
          const nl = { type: "newline", offset, indent: token.indent, source: "\n" };
          delete token.items;
          Object.assign(token, { type, source, end: [nl] });
          break;
        }
        default: {
          const indent = "indent" in token ? token.indent : -1;
          const end = "end" in token && Array.isArray(token.end) ? token.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
          for (const key of Object.keys(token))
            if (key !== "type" && key !== "offset")
              delete token[key];
          Object.assign(token, { type, indent, source, end });
        }
      }
    }
    __name(setFlowScalarValue, "setFlowScalarValue");
    exports.createScalarToken = createScalarToken;
    exports.resolveAsScalar = resolveAsScalar;
    exports.setScalarValue = setScalarValue;
  }
});

// node_modules/yaml/dist/parse/cst-stringify.js
var require_cst_stringify = __commonJS({
  "node_modules/yaml/dist/parse/cst-stringify.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var stringify3 = /* @__PURE__ */ __name((cst) => "type" in cst ? stringifyToken(cst) : stringifyItem(cst), "stringify");
    function stringifyToken(token) {
      switch (token.type) {
        case "block-scalar": {
          let res = "";
          for (const tok of token.props)
            res += stringifyToken(tok);
          return res + token.source;
        }
        case "block-map":
        case "block-seq": {
          let res = "";
          for (const item of token.items)
            res += stringifyItem(item);
          return res;
        }
        case "flow-collection": {
          let res = token.start.source;
          for (const item of token.items)
            res += stringifyItem(item);
          for (const st of token.end)
            res += st.source;
          return res;
        }
        case "document": {
          let res = stringifyItem(token);
          if (token.end)
            for (const st of token.end)
              res += st.source;
          return res;
        }
        default: {
          let res = token.source;
          if ("end" in token && token.end)
            for (const st of token.end)
              res += st.source;
          return res;
        }
      }
    }
    __name(stringifyToken, "stringifyToken");
    function stringifyItem({ start, key, sep: sep2, value }) {
      let res = "";
      for (const st of start)
        res += st.source;
      if (key)
        res += stringifyToken(key);
      if (sep2)
        for (const st of sep2)
          res += st.source;
      if (value)
        res += stringifyToken(value);
      return res;
    }
    __name(stringifyItem, "stringifyItem");
    exports.stringify = stringify3;
  }
});

// node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = __commonJS({
  "node_modules/yaml/dist/parse/cst-visit.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var BREAK = Symbol("break visit");
    var SKIP = Symbol("skip children");
    var REMOVE = Symbol("remove item");
    function visit(cst, visitor) {
      if ("type" in cst && cst.type === "document")
        cst = { start: cst.start, value: cst.value };
      _visit(Object.freeze([]), cst, visitor);
    }
    __name(visit, "visit");
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    visit.itemAtPath = (cst, path3) => {
      let item = cst;
      for (const [field, index] of path3) {
        const tok = item?.[field];
        if (tok && "items" in tok) {
          item = tok.items[index];
        } else
          return void 0;
      }
      return item;
    };
    visit.parentCollection = (cst, path3) => {
      const parent = visit.itemAtPath(cst, path3.slice(0, -1));
      const field = path3[path3.length - 1][0];
      const coll = parent?.[field];
      if (coll && "items" in coll)
        return coll;
      throw new Error("Parent collection not found");
    };
    function _visit(path3, item, visitor) {
      let ctrl = visitor(item, path3);
      if (typeof ctrl === "symbol")
        return ctrl;
      for (const field of ["key", "value"]) {
        const token = item[field];
        if (token && "items" in token) {
          for (let i = 0; i < token.items.length; ++i) {
            const ci = _visit(Object.freeze(path3.concat([[field, i]])), token.items[i], visitor);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              token.items.splice(i, 1);
              i -= 1;
            }
          }
          if (typeof ctrl === "function" && field === "key")
            ctrl = ctrl(item, path3);
        }
      }
      return typeof ctrl === "function" ? ctrl(item, path3) : ctrl;
    }
    __name(_visit, "_visit");
    exports.visit = visit;
  }
});

// node_modules/yaml/dist/parse/cst.js
var require_cst = __commonJS({
  "node_modules/yaml/dist/parse/cst.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var cstScalar = require_cst_scalar();
    var cstStringify = require_cst_stringify();
    var cstVisit = require_cst_visit();
    var BOM = "\uFEFF";
    var DOCUMENT = "";
    var FLOW_END = "";
    var SCALAR = "";
    var isCollection = /* @__PURE__ */ __name((token) => !!token && "items" in token, "isCollection");
    var isScalar = /* @__PURE__ */ __name((token) => !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar" || token.type === "block-scalar"), "isScalar");
    function prettyToken(token) {
      switch (token) {
        case BOM:
          return "<BOM>";
        case DOCUMENT:
          return "<DOC>";
        case FLOW_END:
          return "<FLOW_END>";
        case SCALAR:
          return "<SCALAR>";
        default:
          return JSON.stringify(token);
      }
    }
    __name(prettyToken, "prettyToken");
    function tokenType(source) {
      switch (source) {
        case BOM:
          return "byte-order-mark";
        case DOCUMENT:
          return "doc-mode";
        case FLOW_END:
          return "flow-error-end";
        case SCALAR:
          return "scalar";
        case "---":
          return "doc-start";
        case "...":
          return "doc-end";
        case "":
        case "\n":
        case "\r\n":
          return "newline";
        case "-":
          return "seq-item-ind";
        case "?":
          return "explicit-key-ind";
        case ":":
          return "map-value-ind";
        case "{":
          return "flow-map-start";
        case "}":
          return "flow-map-end";
        case "[":
          return "flow-seq-start";
        case "]":
          return "flow-seq-end";
        case ",":
          return "comma";
      }
      switch (source[0]) {
        case " ":
        case "	":
          return "space";
        case "#":
          return "comment";
        case "%":
          return "directive-line";
        case "*":
          return "alias";
        case "&":
          return "anchor";
        case "!":
          return "tag";
        case "'":
          return "single-quoted-scalar";
        case '"':
          return "double-quoted-scalar";
        case "|":
        case ">":
          return "block-scalar-header";
      }
      return null;
    }
    __name(tokenType, "tokenType");
    exports.createScalarToken = cstScalar.createScalarToken;
    exports.resolveAsScalar = cstScalar.resolveAsScalar;
    exports.setScalarValue = cstScalar.setScalarValue;
    exports.stringify = cstStringify.stringify;
    exports.visit = cstVisit.visit;
    exports.BOM = BOM;
    exports.DOCUMENT = DOCUMENT;
    exports.FLOW_END = FLOW_END;
    exports.SCALAR = SCALAR;
    exports.isCollection = isCollection;
    exports.isScalar = isScalar;
    exports.prettyToken = prettyToken;
    exports.tokenType = tokenType;
  }
});

// node_modules/yaml/dist/parse/lexer.js
var require_lexer = __commonJS({
  "node_modules/yaml/dist/parse/lexer.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var cst = require_cst();
    function isEmpty(ch) {
      switch (ch) {
        case void 0:
        case " ":
        case "\n":
        case "\r":
        case "	":
          return true;
        default:
          return false;
      }
    }
    __name(isEmpty, "isEmpty");
    var hexDigits = new Set("0123456789ABCDEFabcdef");
    var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
    var flowIndicatorChars = new Set(",[]{}");
    var invalidAnchorChars = new Set(" ,[]{}\n\r	");
    var isNotAnchorChar = /* @__PURE__ */ __name((ch) => !ch || invalidAnchorChars.has(ch), "isNotAnchorChar");
    var Lexer = class {
      static {
        __name(this, "Lexer");
      }
      constructor() {
        this.atEnd = false;
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        this.buffer = "";
        this.flowKey = false;
        this.flowLevel = 0;
        this.indentNext = 0;
        this.indentValue = 0;
        this.lineEndPos = null;
        this.next = null;
        this.pos = 0;
      }
      /**
       * Generate YAML tokens from the `source` string. If `incomplete`,
       * a part of the last line may be left as a buffer for the next call.
       *
       * @returns A generator of lexical tokens
       */
      *lex(source, incomplete = false) {
        if (source) {
          if (typeof source !== "string")
            throw TypeError("source is not a string");
          this.buffer = this.buffer ? this.buffer + source : source;
          this.lineEndPos = null;
        }
        this.atEnd = !incomplete;
        let next = this.next ?? "stream";
        while (next && (incomplete || this.hasChars(1)))
          next = yield* this.parseNext(next);
      }
      atLineEnd() {
        let i = this.pos;
        let ch = this.buffer[i];
        while (ch === " " || ch === "	")
          ch = this.buffer[++i];
        if (!ch || ch === "#" || ch === "\n")
          return true;
        if (ch === "\r")
          return this.buffer[i + 1] === "\n";
        return false;
      }
      charAt(n) {
        return this.buffer[this.pos + n];
      }
      continueScalar(offset) {
        let ch = this.buffer[offset];
        if (this.indentNext > 0) {
          let indent = 0;
          while (ch === " ")
            ch = this.buffer[++indent + offset];
          if (ch === "\r") {
            const next = this.buffer[indent + offset + 1];
            if (next === "\n" || !next && !this.atEnd)
              return offset + indent + 1;
          }
          return ch === "\n" || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
        }
        if (ch === "-" || ch === ".") {
          const dt = this.buffer.substr(offset, 3);
          if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
            return -1;
        }
        return offset;
      }
      getLine() {
        let end = this.lineEndPos;
        if (typeof end !== "number" || end !== -1 && end < this.pos) {
          end = this.buffer.indexOf("\n", this.pos);
          this.lineEndPos = end;
        }
        if (end === -1)
          return this.atEnd ? this.buffer.substring(this.pos) : null;
        if (this.buffer[end - 1] === "\r")
          end -= 1;
        return this.buffer.substring(this.pos, end);
      }
      hasChars(n) {
        return this.pos + n <= this.buffer.length;
      }
      setNext(state) {
        this.buffer = this.buffer.substring(this.pos);
        this.pos = 0;
        this.lineEndPos = null;
        this.next = state;
        return null;
      }
      peek(n) {
        return this.buffer.substr(this.pos, n);
      }
      *parseNext(next) {
        switch (next) {
          case "stream":
            return yield* this.parseStream();
          case "line-start":
            return yield* this.parseLineStart();
          case "block-start":
            return yield* this.parseBlockStart();
          case "doc":
            return yield* this.parseDocument();
          case "flow":
            return yield* this.parseFlowCollection();
          case "quoted-scalar":
            return yield* this.parseQuotedScalar();
          case "block-scalar":
            return yield* this.parseBlockScalar();
          case "plain-scalar":
            return yield* this.parsePlainScalar();
        }
      }
      *parseStream() {
        let line = this.getLine();
        if (line === null)
          return this.setNext("stream");
        if (line[0] === cst.BOM) {
          yield* this.pushCount(1);
          line = line.substring(1);
        }
        if (line[0] === "%") {
          let dirEnd = line.length;
          let cs = line.indexOf("#");
          while (cs !== -1) {
            const ch = line[cs - 1];
            if (ch === " " || ch === "	") {
              dirEnd = cs - 1;
              break;
            } else {
              cs = line.indexOf("#", cs + 1);
            }
          }
          while (true) {
            const ch = line[dirEnd - 1];
            if (ch === " " || ch === "	")
              dirEnd -= 1;
            else
              break;
          }
          const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
          yield* this.pushCount(line.length - n);
          this.pushNewline();
          return "stream";
        }
        if (this.atLineEnd()) {
          const sp = yield* this.pushSpaces(true);
          yield* this.pushCount(line.length - sp);
          yield* this.pushNewline();
          return "stream";
        }
        yield cst.DOCUMENT;
        return yield* this.parseLineStart();
      }
      *parseLineStart() {
        const ch = this.charAt(0);
        if (!ch && !this.atEnd)
          return this.setNext("line-start");
        if (ch === "-" || ch === ".") {
          if (!this.atEnd && !this.hasChars(4))
            return this.setNext("line-start");
          const s = this.peek(3);
          if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
            yield* this.pushCount(3);
            this.indentValue = 0;
            this.indentNext = 0;
            return s === "---" ? "doc" : "stream";
          }
        }
        this.indentValue = yield* this.pushSpaces(false);
        if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
          this.indentNext = this.indentValue;
        return yield* this.parseBlockStart();
      }
      *parseBlockStart() {
        const [ch0, ch1] = this.peek(2);
        if (!ch1 && !this.atEnd)
          return this.setNext("block-start");
        if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
          const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
          this.indentNext = this.indentValue + 1;
          this.indentValue += n;
          return "block-start";
        }
        return "doc";
      }
      *parseDocument() {
        yield* this.pushSpaces(true);
        const line = this.getLine();
        if (line === null)
          return this.setNext("doc");
        let n = yield* this.pushIndicators();
        switch (line[n]) {
          case "#":
            yield* this.pushCount(line.length - n);
          // fallthrough
          case void 0:
            yield* this.pushNewline();
            return yield* this.parseLineStart();
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel = 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            return "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "doc";
          case '"':
          case "'":
            return yield* this.parseQuotedScalar();
          case "|":
          case ">":
            n += yield* this.parseBlockScalarHeader();
            n += yield* this.pushSpaces(true);
            yield* this.pushCount(line.length - n);
            yield* this.pushNewline();
            return yield* this.parseBlockScalar();
          default:
            return yield* this.parsePlainScalar();
        }
      }
      *parseFlowCollection() {
        let nl, sp;
        let indent = -1;
        do {
          nl = yield* this.pushNewline();
          if (nl > 0) {
            sp = yield* this.pushSpaces(false);
            this.indentValue = indent = sp;
          } else {
            sp = 0;
          }
          sp += yield* this.pushSpaces(true);
        } while (nl + sp > 0);
        const line = this.getLine();
        if (line === null)
          return this.setNext("flow");
        if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
          const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
          if (!atFlowEndMarker) {
            this.flowLevel = 0;
            yield cst.FLOW_END;
            return yield* this.parseLineStart();
          }
        }
        let n = 0;
        while (line[n] === ",") {
          n += yield* this.pushCount(1);
          n += yield* this.pushSpaces(true);
          this.flowKey = false;
        }
        n += yield* this.pushIndicators();
        switch (line[n]) {
          case void 0:
            return "flow";
          case "#":
            yield* this.pushCount(line.length - n);
            return "flow";
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel += 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            this.flowKey = true;
            this.flowLevel -= 1;
            return this.flowLevel ? "flow" : "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "flow";
          case '"':
          case "'":
            this.flowKey = true;
            return yield* this.parseQuotedScalar();
          case ":": {
            const next = this.charAt(1);
            if (this.flowKey || isEmpty(next) || next === ",") {
              this.flowKey = false;
              yield* this.pushCount(1);
              yield* this.pushSpaces(true);
              return "flow";
            }
          }
          // fallthrough
          default:
            this.flowKey = false;
            return yield* this.parsePlainScalar();
        }
      }
      *parseQuotedScalar() {
        const quote = this.charAt(0);
        let end = this.buffer.indexOf(quote, this.pos + 1);
        if (quote === "'") {
          while (end !== -1 && this.buffer[end + 1] === "'")
            end = this.buffer.indexOf("'", end + 2);
        } else {
          while (end !== -1) {
            let n = 0;
            while (this.buffer[end - 1 - n] === "\\")
              n += 1;
            if (n % 2 === 0)
              break;
            end = this.buffer.indexOf('"', end + 1);
          }
        }
        const qb = this.buffer.substring(0, end);
        let nl = qb.indexOf("\n", this.pos);
        if (nl !== -1) {
          while (nl !== -1) {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = qb.indexOf("\n", cs);
          }
          if (nl !== -1) {
            end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
          }
        }
        if (end === -1) {
          if (!this.atEnd)
            return this.setNext("quoted-scalar");
          end = this.buffer.length;
        }
        yield* this.pushToIndex(end + 1, false);
        return this.flowLevel ? "flow" : "doc";
      }
      *parseBlockScalarHeader() {
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        let i = this.pos;
        while (true) {
          const ch = this.buffer[++i];
          if (ch === "+")
            this.blockScalarKeep = true;
          else if (ch > "0" && ch <= "9")
            this.blockScalarIndent = Number(ch) - 1;
          else if (ch !== "-")
            break;
        }
        return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
      }
      *parseBlockScalar() {
        let nl = this.pos - 1;
        let indent = 0;
        let ch;
        loop: for (let i2 = this.pos; ch = this.buffer[i2]; ++i2) {
          switch (ch) {
            case " ":
              indent += 1;
              break;
            case "\n":
              nl = i2;
              indent = 0;
              break;
            case "\r": {
              const next = this.buffer[i2 + 1];
              if (!next && !this.atEnd)
                return this.setNext("block-scalar");
              if (next === "\n")
                break;
            }
            // fallthrough
            default:
              break loop;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("block-scalar");
        if (indent >= this.indentNext) {
          if (this.blockScalarIndent === -1)
            this.indentNext = indent;
          else {
            this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
          }
          do {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = this.buffer.indexOf("\n", cs);
          } while (nl !== -1);
          if (nl === -1) {
            if (!this.atEnd)
              return this.setNext("block-scalar");
            nl = this.buffer.length;
          }
        }
        let i = nl + 1;
        ch = this.buffer[i];
        while (ch === " ")
          ch = this.buffer[++i];
        if (ch === "	") {
          while (ch === "	" || ch === " " || ch === "\r" || ch === "\n")
            ch = this.buffer[++i];
          nl = i - 1;
        } else if (!this.blockScalarKeep) {
          do {
            let i2 = nl - 1;
            let ch2 = this.buffer[i2];
            if (ch2 === "\r")
              ch2 = this.buffer[--i2];
            const lastChar = i2;
            while (ch2 === " ")
              ch2 = this.buffer[--i2];
            if (ch2 === "\n" && i2 >= this.pos && i2 + 1 + indent > lastChar)
              nl = i2;
            else
              break;
          } while (true);
        }
        yield cst.SCALAR;
        yield* this.pushToIndex(nl + 1, true);
        return yield* this.parseLineStart();
      }
      *parsePlainScalar() {
        const inFlow = this.flowLevel > 0;
        let end = this.pos - 1;
        let i = this.pos - 1;
        let ch;
        while (ch = this.buffer[++i]) {
          if (ch === ":") {
            const next = this.buffer[i + 1];
            if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
              break;
            end = i;
          } else if (isEmpty(ch)) {
            let next = this.buffer[i + 1];
            if (ch === "\r") {
              if (next === "\n") {
                i += 1;
                ch = "\n";
                next = this.buffer[i + 1];
              } else
                end = i;
            }
            if (next === "#" || inFlow && flowIndicatorChars.has(next))
              break;
            if (ch === "\n") {
              const cs = this.continueScalar(i + 1);
              if (cs === -1)
                break;
              i = Math.max(i, cs - 2);
            }
          } else {
            if (inFlow && flowIndicatorChars.has(ch))
              break;
            end = i;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("plain-scalar");
        yield cst.SCALAR;
        yield* this.pushToIndex(end + 1, true);
        return inFlow ? "flow" : "doc";
      }
      *pushCount(n) {
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos += n;
          return n;
        }
        return 0;
      }
      *pushToIndex(i, allowEmpty) {
        const s = this.buffer.slice(this.pos, i);
        if (s) {
          yield s;
          this.pos += s.length;
          return s.length;
        } else if (allowEmpty)
          yield "";
        return 0;
      }
      *pushIndicators() {
        let n = 0;
        loop: while (true) {
          switch (this.charAt(0)) {
            case "!":
              n += yield* this.pushTag();
              n += yield* this.pushSpaces(true);
              continue loop;
            case "&":
              n += yield* this.pushUntil(isNotAnchorChar);
              n += yield* this.pushSpaces(true);
              continue loop;
            case "-":
            // this is an error
            case "?":
            // this is an error outside flow collections
            case ":": {
              const inFlow = this.flowLevel > 0;
              const ch1 = this.charAt(1);
              if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
                if (!inFlow)
                  this.indentNext = this.indentValue + 1;
                else if (this.flowKey)
                  this.flowKey = false;
                n += yield* this.pushCount(1);
                n += yield* this.pushSpaces(true);
                continue loop;
              }
            }
          }
          break loop;
        }
        return n;
      }
      *pushTag() {
        if (this.charAt(1) === "<") {
          let i = this.pos + 2;
          let ch = this.buffer[i];
          while (!isEmpty(ch) && ch !== ">")
            ch = this.buffer[++i];
          return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
        } else {
          let i = this.pos + 1;
          let ch = this.buffer[i];
          while (ch) {
            if (tagChars.has(ch))
              ch = this.buffer[++i];
            else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
              ch = this.buffer[i += 3];
            } else
              break;
          }
          return yield* this.pushToIndex(i, false);
        }
      }
      *pushNewline() {
        const ch = this.buffer[this.pos];
        if (ch === "\n")
          return yield* this.pushCount(1);
        else if (ch === "\r" && this.charAt(1) === "\n")
          return yield* this.pushCount(2);
        else
          return 0;
      }
      *pushSpaces(allowTabs) {
        let i = this.pos - 1;
        let ch;
        do {
          ch = this.buffer[++i];
        } while (ch === " " || allowTabs && ch === "	");
        const n = i - this.pos;
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos = i;
        }
        return n;
      }
      *pushUntil(test) {
        let i = this.pos;
        let ch = this.buffer[i];
        while (!test(ch))
          ch = this.buffer[++i];
        return yield* this.pushToIndex(i, false);
      }
    };
    exports.Lexer = Lexer;
  }
});

// node_modules/yaml/dist/parse/line-counter.js
var require_line_counter = __commonJS({
  "node_modules/yaml/dist/parse/line-counter.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var LineCounter = class {
      static {
        __name(this, "LineCounter");
      }
      constructor() {
        this.lineStarts = [];
        this.addNewLine = (offset) => this.lineStarts.push(offset);
        this.linePos = (offset) => {
          let low = 0;
          let high = this.lineStarts.length;
          while (low < high) {
            const mid = low + high >> 1;
            if (this.lineStarts[mid] < offset)
              low = mid + 1;
            else
              high = mid;
          }
          if (this.lineStarts[low] === offset)
            return { line: low + 1, col: 1 };
          if (low === 0)
            return { line: 0, col: offset };
          const start = this.lineStarts[low - 1];
          return { line: low, col: offset - start + 1 };
        };
      }
    };
    exports.LineCounter = LineCounter;
  }
});

// node_modules/yaml/dist/parse/parser.js
var require_parser = __commonJS({
  "node_modules/yaml/dist/parse/parser.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var node_process = __require("process");
    var cst = require_cst();
    var lexer = require_lexer();
    function includesToken(list, type) {
      for (let i = 0; i < list.length; ++i)
        if (list[i].type === type)
          return true;
      return false;
    }
    __name(includesToken, "includesToken");
    function findNonEmptyIndex(list) {
      for (let i = 0; i < list.length; ++i) {
        switch (list[i].type) {
          case "space":
          case "comment":
          case "newline":
            break;
          default:
            return i;
        }
      }
      return -1;
    }
    __name(findNonEmptyIndex, "findNonEmptyIndex");
    function isFlowToken(token) {
      switch (token?.type) {
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "flow-collection":
          return true;
        default:
          return false;
      }
    }
    __name(isFlowToken, "isFlowToken");
    function getPrevProps(parent) {
      switch (parent.type) {
        case "document":
          return parent.start;
        case "block-map": {
          const it = parent.items[parent.items.length - 1];
          return it.sep ?? it.start;
        }
        case "block-seq":
          return parent.items[parent.items.length - 1].start;
        /* istanbul ignore next should not happen */
        default:
          return [];
      }
    }
    __name(getPrevProps, "getPrevProps");
    function getFirstKeyStartProps(prev) {
      if (prev.length === 0)
        return [];
      let i = prev.length;
      loop: while (--i >= 0) {
        switch (prev[i].type) {
          case "doc-start":
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
          case "newline":
            break loop;
        }
      }
      while (prev[++i]?.type === "space") {
      }
      return prev.splice(i, prev.length);
    }
    __name(getFirstKeyStartProps, "getFirstKeyStartProps");
    function arrayPushArray(target, source) {
      if (source.length < 1e5)
        Array.prototype.push.apply(target, source);
      else
        for (let i = 0; i < source.length; ++i)
          target.push(source[i]);
    }
    __name(arrayPushArray, "arrayPushArray");
    function fixFlowSeqItems(fc) {
      if (fc.start.type === "flow-seq-start") {
        for (const it of fc.items) {
          if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
            if (it.key)
              it.value = it.key;
            delete it.key;
            if (isFlowToken(it.value)) {
              if (it.value.end)
                arrayPushArray(it.value.end, it.sep);
              else
                it.value.end = it.sep;
            } else
              arrayPushArray(it.start, it.sep);
            delete it.sep;
          }
        }
      }
    }
    __name(fixFlowSeqItems, "fixFlowSeqItems");
    var Parser = class {
      static {
        __name(this, "Parser");
      }
      /**
       * @param onNewLine - If defined, called separately with the start position of
       *   each new line (in `parse()`, including the start of input).
       */
      constructor(onNewLine) {
        this.atNewLine = true;
        this.atScalar = false;
        this.indent = 0;
        this.offset = 0;
        this.onKeyLine = false;
        this.stack = [];
        this.source = "";
        this.type = "";
        this.lexer = new lexer.Lexer();
        this.onNewLine = onNewLine;
      }
      /**
       * Parse `source` as a YAML stream.
       * If `incomplete`, a part of the last line may be left as a buffer for the next call.
       *
       * Errors are not thrown, but yielded as `{ type: 'error', message }` tokens.
       *
       * @returns A generator of tokens representing each directive, document, and other structure.
       */
      *parse(source, incomplete = false) {
        if (this.onNewLine && this.offset === 0)
          this.onNewLine(0);
        for (const lexeme of this.lexer.lex(source, incomplete))
          yield* this.next(lexeme);
        if (!incomplete)
          yield* this.end();
      }
      /**
       * Advance the parser by the `source` of one lexical token.
       */
      *next(source) {
        this.source = source;
        if (node_process.env.LOG_TOKENS)
          console.log("|", cst.prettyToken(source));
        if (this.atScalar) {
          this.atScalar = false;
          yield* this.step();
          this.offset += source.length;
          return;
        }
        const type = cst.tokenType(source);
        if (!type) {
          const message = `Not a YAML token: ${source}`;
          yield* this.pop({ type: "error", offset: this.offset, message, source });
          this.offset += source.length;
        } else if (type === "scalar") {
          this.atNewLine = false;
          this.atScalar = true;
          this.type = "scalar";
        } else {
          this.type = type;
          yield* this.step();
          switch (type) {
            case "newline":
              this.atNewLine = true;
              this.indent = 0;
              if (this.onNewLine)
                this.onNewLine(this.offset + source.length);
              break;
            case "space":
              if (this.atNewLine && source[0] === " ")
                this.indent += source.length;
              break;
            case "explicit-key-ind":
            case "map-value-ind":
            case "seq-item-ind":
              if (this.atNewLine)
                this.indent += source.length;
              break;
            case "doc-mode":
            case "flow-error-end":
              return;
            default:
              this.atNewLine = false;
          }
          this.offset += source.length;
        }
      }
      /** Call at end of input to push out any remaining constructions */
      *end() {
        while (this.stack.length > 0)
          yield* this.pop();
      }
      get sourceToken() {
        const st = {
          type: this.type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
        return st;
      }
      *step() {
        const top = this.peek(1);
        if (this.type === "doc-end" && top?.type !== "doc-end") {
          while (this.stack.length > 0)
            yield* this.pop();
          this.stack.push({
            type: "doc-end",
            offset: this.offset,
            source: this.source
          });
          return;
        }
        if (!top)
          return yield* this.stream();
        switch (top.type) {
          case "document":
            return yield* this.document(top);
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return yield* this.scalar(top);
          case "block-scalar":
            return yield* this.blockScalar(top);
          case "block-map":
            return yield* this.blockMap(top);
          case "block-seq":
            return yield* this.blockSequence(top);
          case "flow-collection":
            return yield* this.flowCollection(top);
          case "doc-end":
            return yield* this.documentEnd(top);
        }
        yield* this.pop();
      }
      peek(n) {
        return this.stack[this.stack.length - n];
      }
      *pop(error) {
        const token = error ?? this.stack.pop();
        if (!token) {
          const message = "Tried to pop an empty stack";
          yield { type: "error", offset: this.offset, source: "", message };
        } else if (this.stack.length === 0) {
          yield token;
        } else {
          const top = this.peek(1);
          if (token.type === "block-scalar") {
            token.indent = "indent" in top ? top.indent : 0;
          } else if (token.type === "flow-collection" && top.type === "document") {
            token.indent = 0;
          }
          if (token.type === "flow-collection")
            fixFlowSeqItems(token);
          switch (top.type) {
            case "document":
              top.value = token;
              break;
            case "block-scalar":
              top.props.push(token);
              break;
            case "block-map": {
              const it = top.items[top.items.length - 1];
              if (it.value) {
                top.items.push({ start: [], key: token, sep: [] });
                this.onKeyLine = true;
                return;
              } else if (it.sep) {
                it.value = token;
              } else {
                Object.assign(it, { key: token, sep: [] });
                this.onKeyLine = !it.explicitKey;
                return;
              }
              break;
            }
            case "block-seq": {
              const it = top.items[top.items.length - 1];
              if (it.value)
                top.items.push({ start: [], value: token });
              else
                it.value = token;
              break;
            }
            case "flow-collection": {
              const it = top.items[top.items.length - 1];
              if (!it || it.value)
                top.items.push({ start: [], key: token, sep: [] });
              else if (it.sep)
                it.value = token;
              else
                Object.assign(it, { key: token, sep: [] });
              return;
            }
            /* istanbul ignore next should not happen */
            default:
              yield* this.pop();
              yield* this.pop(token);
          }
          if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
            const last = token.items[token.items.length - 1];
            if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
              if (top.type === "document")
                top.end = last.start;
              else
                top.items.push({ start: last.start });
              token.items.splice(-1, 1);
            }
          }
        }
      }
      *stream() {
        switch (this.type) {
          case "directive-line":
            yield { type: "directive", offset: this.offset, source: this.source };
            return;
          case "byte-order-mark":
          case "space":
          case "comment":
          case "newline":
            yield this.sourceToken;
            return;
          case "doc-mode":
          case "doc-start": {
            const doc = {
              type: "document",
              offset: this.offset,
              start: []
            };
            if (this.type === "doc-start")
              doc.start.push(this.sourceToken);
            this.stack.push(doc);
            return;
          }
        }
        yield {
          type: "error",
          offset: this.offset,
          message: `Unexpected ${this.type} token in YAML stream`,
          source: this.source
        };
      }
      *document(doc) {
        if (doc.value)
          return yield* this.lineEnd(doc);
        switch (this.type) {
          case "doc-start": {
            if (findNonEmptyIndex(doc.start) !== -1) {
              yield* this.pop();
              yield* this.step();
            } else
              doc.start.push(this.sourceToken);
            return;
          }
          case "anchor":
          case "tag":
          case "space":
          case "comment":
          case "newline":
            doc.start.push(this.sourceToken);
            return;
        }
        const bv = this.startBlockValue(doc);
        if (bv)
          this.stack.push(bv);
        else {
          yield {
            type: "error",
            offset: this.offset,
            message: `Unexpected ${this.type} token in YAML document`,
            source: this.source
          };
        }
      }
      *scalar(scalar) {
        if (this.type === "map-value-ind") {
          const prev = getPrevProps(this.peek(2));
          const start = getFirstKeyStartProps(prev);
          let sep2;
          if (scalar.end) {
            sep2 = scalar.end;
            sep2.push(this.sourceToken);
            delete scalar.end;
          } else
            sep2 = [this.sourceToken];
          const map = {
            type: "block-map",
            offset: scalar.offset,
            indent: scalar.indent,
            items: [{ start, key: scalar, sep: sep2 }]
          };
          this.onKeyLine = true;
          this.stack[this.stack.length - 1] = map;
        } else
          yield* this.lineEnd(scalar);
      }
      *blockScalar(scalar) {
        switch (this.type) {
          case "space":
          case "comment":
          case "newline":
            scalar.props.push(this.sourceToken);
            return;
          case "scalar":
            scalar.source = this.source;
            this.atNewLine = true;
            this.indent = 0;
            if (this.onNewLine) {
              let nl = this.source.indexOf("\n") + 1;
              while (nl !== 0) {
                this.onNewLine(this.offset + nl);
                nl = this.source.indexOf("\n", nl) + 1;
              }
            }
            yield* this.pop();
            break;
          /* istanbul ignore next should not happen */
          default:
            yield* this.pop();
            yield* this.step();
        }
      }
      *blockMap(map) {
        const it = map.items[map.items.length - 1];
        switch (this.type) {
          case "newline":
            this.onKeyLine = false;
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              it.start.push(this.sourceToken);
            }
            return;
          case "space":
          case "comment":
            if (it.value) {
              map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              if (this.atIndentedComment(it.start, map.indent)) {
                const prev = map.items[map.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  map.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
        }
        if (this.indent >= map.indent) {
          const atMapIndent = !this.onKeyLine && this.indent === map.indent;
          const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
          let start = [];
          if (atNextItem && it.sep && !it.value) {
            const nl = [];
            for (let i = 0; i < it.sep.length; ++i) {
              const st = it.sep[i];
              switch (st.type) {
                case "newline":
                  nl.push(i);
                  break;
                case "space":
                  break;
                case "comment":
                  if (st.indent > map.indent)
                    nl.length = 0;
                  break;
                default:
                  nl.length = 0;
              }
            }
            if (nl.length >= 2)
              start = it.sep.splice(nl[1]);
          }
          switch (this.type) {
            case "anchor":
            case "tag":
              if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start });
                this.onKeyLine = true;
              } else if (it.sep) {
                it.sep.push(this.sourceToken);
              } else {
                it.start.push(this.sourceToken);
              }
              return;
            case "explicit-key-ind":
              if (!it.sep && !it.explicitKey) {
                it.start.push(this.sourceToken);
                it.explicitKey = true;
              } else if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start, explicitKey: true });
              } else {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: [this.sourceToken], explicitKey: true }]
                });
              }
              this.onKeyLine = true;
              return;
            case "map-value-ind":
              if (it.explicitKey) {
                if (!it.sep) {
                  if (includesToken(it.start, "newline")) {
                    Object.assign(it, { key: null, sep: [this.sourceToken] });
                  } else {
                    const start2 = getFirstKeyStartProps(it.start);
                    this.stack.push({
                      type: "block-map",
                      offset: this.offset,
                      indent: this.indent,
                      items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                    });
                  }
                } else if (it.value) {
                  map.items.push({ start: [], key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start, key: null, sep: [this.sourceToken] }]
                  });
                } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
                  const start2 = getFirstKeyStartProps(it.start);
                  const key = it.key;
                  const sep2 = it.sep;
                  sep2.push(this.sourceToken);
                  delete it.key;
                  delete it.sep;
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start2, key, sep: sep2 }]
                  });
                } else if (start.length > 0) {
                  it.sep = it.sep.concat(start, this.sourceToken);
                } else {
                  it.sep.push(this.sourceToken);
                }
              } else {
                if (!it.sep) {
                  Object.assign(it, { key: null, sep: [this.sourceToken] });
                } else if (it.value || atNextItem) {
                  map.items.push({ start, key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: [], key: null, sep: [this.sourceToken] }]
                  });
                } else {
                  it.sep.push(this.sourceToken);
                }
              }
              this.onKeyLine = true;
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs3 = this.flowScalar(this.type);
              if (atNextItem || it.value) {
                map.items.push({ start, key: fs3, sep: [] });
                this.onKeyLine = true;
              } else if (it.sep) {
                this.stack.push(fs3);
              } else {
                Object.assign(it, { key: fs3, sep: [] });
                this.onKeyLine = true;
              }
              return;
            }
            default: {
              const bv = this.startBlockValue(map);
              if (bv) {
                if (bv.type === "block-seq") {
                  if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                    yield* this.pop({
                      type: "error",
                      offset: this.offset,
                      message: "Unexpected block-seq-ind on same line with key",
                      source: this.source
                    });
                    return;
                  }
                } else if (atMapIndent) {
                  map.items.push({ start });
                }
                this.stack.push(bv);
                return;
              }
            }
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *blockSequence(seq) {
        const it = seq.items[seq.items.length - 1];
        switch (this.type) {
          case "newline":
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                seq.items.push({ start: [this.sourceToken] });
            } else
              it.start.push(this.sourceToken);
            return;
          case "space":
          case "comment":
            if (it.value)
              seq.items.push({ start: [this.sourceToken] });
            else {
              if (this.atIndentedComment(it.start, seq.indent)) {
                const prev = seq.items[seq.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  seq.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
          case "anchor":
          case "tag":
            if (it.value || this.indent <= seq.indent)
              break;
            it.start.push(this.sourceToken);
            return;
          case "seq-item-ind":
            if (this.indent !== seq.indent)
              break;
            if (it.value || includesToken(it.start, "seq-item-ind"))
              seq.items.push({ start: [this.sourceToken] });
            else
              it.start.push(this.sourceToken);
            return;
        }
        if (this.indent > seq.indent) {
          const bv = this.startBlockValue(seq);
          if (bv) {
            this.stack.push(bv);
            return;
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *flowCollection(fc) {
        const it = fc.items[fc.items.length - 1];
        if (this.type === "flow-error-end") {
          let top;
          do {
            yield* this.pop();
            top = this.peek(1);
          } while (top?.type === "flow-collection");
        } else if (fc.end.length === 0) {
          switch (this.type) {
            case "comma":
            case "explicit-key-ind":
              if (!it || it.sep)
                fc.items.push({ start: [this.sourceToken] });
              else
                it.start.push(this.sourceToken);
              return;
            case "map-value-ind":
              if (!it || it.value)
                fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              return;
            case "space":
            case "comment":
            case "newline":
            case "anchor":
            case "tag":
              if (!it || it.value)
                fc.items.push({ start: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                it.start.push(this.sourceToken);
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs3 = this.flowScalar(this.type);
              if (!it || it.value)
                fc.items.push({ start: [], key: fs3, sep: [] });
              else if (it.sep)
                this.stack.push(fs3);
              else
                Object.assign(it, { key: fs3, sep: [] });
              return;
            }
            case "flow-map-end":
            case "flow-seq-end":
              fc.end.push(this.sourceToken);
              return;
          }
          const bv = this.startBlockValue(fc);
          if (bv)
            this.stack.push(bv);
          else {
            yield* this.pop();
            yield* this.step();
          }
        } else {
          const parent = this.peek(2);
          if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
            yield* this.pop();
            yield* this.step();
          } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            fixFlowSeqItems(fc);
            const sep2 = fc.end.splice(1, fc.end.length);
            sep2.push(this.sourceToken);
            const map = {
              type: "block-map",
              offset: fc.offset,
              indent: fc.indent,
              items: [{ start, key: fc, sep: sep2 }]
            };
            this.onKeyLine = true;
            this.stack[this.stack.length - 1] = map;
          } else {
            yield* this.lineEnd(fc);
          }
        }
      }
      flowScalar(type) {
        if (this.onNewLine) {
          let nl = this.source.indexOf("\n") + 1;
          while (nl !== 0) {
            this.onNewLine(this.offset + nl);
            nl = this.source.indexOf("\n", nl) + 1;
          }
        }
        return {
          type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
      }
      startBlockValue(parent) {
        switch (this.type) {
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return this.flowScalar(this.type);
          case "block-scalar-header":
            return {
              type: "block-scalar",
              offset: this.offset,
              indent: this.indent,
              props: [this.sourceToken],
              source: ""
            };
          case "flow-map-start":
          case "flow-seq-start":
            return {
              type: "flow-collection",
              offset: this.offset,
              indent: this.indent,
              start: this.sourceToken,
              items: [],
              end: []
            };
          case "seq-item-ind":
            return {
              type: "block-seq",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: [this.sourceToken] }]
            };
          case "explicit-key-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            start.push(this.sourceToken);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, explicitKey: true }]
            };
          }
          case "map-value-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, key: null, sep: [this.sourceToken] }]
            };
          }
        }
        return null;
      }
      atIndentedComment(start, indent) {
        if (this.type !== "comment")
          return false;
        if (this.indent <= indent)
          return false;
        return start.every((st) => st.type === "newline" || st.type === "space");
      }
      *documentEnd(docEnd) {
        if (this.type !== "doc-mode") {
          if (docEnd.end)
            docEnd.end.push(this.sourceToken);
          else
            docEnd.end = [this.sourceToken];
          if (this.type === "newline")
            yield* this.pop();
        }
      }
      *lineEnd(token) {
        switch (this.type) {
          case "comma":
          case "doc-start":
          case "doc-end":
          case "flow-seq-end":
          case "flow-map-end":
          case "map-value-ind":
            yield* this.pop();
            yield* this.step();
            break;
          case "newline":
            this.onKeyLine = false;
          // fallthrough
          case "space":
          case "comment":
          default:
            if (token.end)
              token.end.push(this.sourceToken);
            else
              token.end = [this.sourceToken];
            if (this.type === "newline")
              yield* this.pop();
        }
      }
    };
    exports.Parser = Parser;
  }
});

// node_modules/yaml/dist/public-api.js
var require_public_api = __commonJS({
  "node_modules/yaml/dist/public-api.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var composer = require_composer();
    var Document = require_Document();
    var errors = require_errors();
    var log = require_log();
    var identity = require_identity();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    function parseOptions(options) {
      const prettyErrors = options.prettyErrors !== false;
      const lineCounter$1 = options.lineCounter || prettyErrors && new lineCounter.LineCounter() || null;
      return { lineCounter: lineCounter$1, prettyErrors };
    }
    __name(parseOptions, "parseOptions");
    function parseAllDocuments(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      const docs = Array.from(composer$1.compose(parser$1.parse(source)));
      if (prettyErrors && lineCounter2)
        for (const doc of docs) {
          doc.errors.forEach(errors.prettifyError(source, lineCounter2));
          doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
        }
      if (docs.length > 0)
        return docs;
      return Object.assign([], { empty: true }, composer$1.streamInfo());
    }
    __name(parseAllDocuments, "parseAllDocuments");
    function parseDocument(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      let doc = null;
      for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) {
        if (!doc)
          doc = _doc;
        else if (doc.options.logLevel !== "silent") {
          doc.errors.push(new errors.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
          break;
        }
      }
      if (prettyErrors && lineCounter2) {
        doc.errors.forEach(errors.prettifyError(source, lineCounter2));
        doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
      }
      return doc;
    }
    __name(parseDocument, "parseDocument");
    function parse3(src, reviver, options) {
      let _reviver = void 0;
      if (typeof reviver === "function") {
        _reviver = reviver;
      } else if (options === void 0 && reviver && typeof reviver === "object") {
        options = reviver;
      }
      const doc = parseDocument(src, options);
      if (!doc)
        return null;
      doc.warnings.forEach((warning) => log.warn(doc.options.logLevel, warning));
      if (doc.errors.length > 0) {
        if (doc.options.logLevel !== "silent")
          throw doc.errors[0];
        else
          doc.errors = [];
      }
      return doc.toJS(Object.assign({ reviver: _reviver }, options));
    }
    __name(parse3, "parse");
    function stringify3(value, replacer, options) {
      let _replacer = null;
      if (typeof replacer === "function" || Array.isArray(replacer)) {
        _replacer = replacer;
      } else if (options === void 0 && replacer) {
        options = replacer;
      }
      if (typeof options === "string")
        options = options.length;
      if (typeof options === "number") {
        const indent = Math.round(options);
        options = indent < 1 ? void 0 : indent > 8 ? { indent: 8 } : { indent };
      }
      if (value === void 0) {
        const { keepUndefined } = options ?? replacer ?? {};
        if (!keepUndefined)
          return void 0;
      }
      if (identity.isDocument(value) && !_replacer)
        return value.toString(options);
      return new Document.Document(value, _replacer, options).toString(options);
    }
    __name(stringify3, "stringify");
    exports.parse = parse3;
    exports.parseAllDocuments = parseAllDocuments;
    exports.parseDocument = parseDocument;
    exports.stringify = stringify3;
  }
});

// node_modules/yaml/dist/index.js
var require_dist = __commonJS({
  "node_modules/yaml/dist/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var composer = require_composer();
    var Document = require_Document();
    var Schema = require_Schema();
    var errors = require_errors();
    var Alias = require_Alias();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var cst = require_cst();
    var lexer = require_lexer();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    var publicApi = require_public_api();
    var visit = require_visit();
    exports.Composer = composer.Composer;
    exports.Document = Document.Document;
    exports.Schema = Schema.Schema;
    exports.YAMLError = errors.YAMLError;
    exports.YAMLParseError = errors.YAMLParseError;
    exports.YAMLWarning = errors.YAMLWarning;
    exports.Alias = Alias.Alias;
    exports.isAlias = identity.isAlias;
    exports.isCollection = identity.isCollection;
    exports.isDocument = identity.isDocument;
    exports.isMap = identity.isMap;
    exports.isNode = identity.isNode;
    exports.isPair = identity.isPair;
    exports.isScalar = identity.isScalar;
    exports.isSeq = identity.isSeq;
    exports.Pair = Pair.Pair;
    exports.Scalar = Scalar.Scalar;
    exports.YAMLMap = YAMLMap.YAMLMap;
    exports.YAMLSeq = YAMLSeq.YAMLSeq;
    exports.CST = cst;
    exports.Lexer = lexer.Lexer;
    exports.LineCounter = lineCounter.LineCounter;
    exports.Parser = parser.Parser;
    exports.parse = publicApi.parse;
    exports.parseAllDocuments = publicApi.parseAllDocuments;
    exports.parseDocument = publicApi.parseDocument;
    exports.stringify = publicApi.stringify;
    exports.visit = visit.visit;
    exports.visitAsync = visit.visitAsync;
  }
});

// packages/core/src/telemetry/config.ts
init_esbuild_shims();

// packages/core/src/telemetry/index.ts
init_esbuild_shims();

// packages/core/src/telemetry/goal-events.ts
init_esbuild_shims();

// packages/core/src/goals/goal-reducer.ts
init_esbuild_shims();

// packages/core/src/goals/goal-protocol.ts
init_esbuild_shims();

// packages/core/src/utils/terminalSafe.ts
init_esbuild_shims();
var TERMINAL_OSC_REGEX = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
var TERMINAL_CSI_REGEX = /\x1b\[[\d;?]*[a-zA-Z]/g;
var TERMINAL_SHIFT_DCS_REGEX = /\x1b[NOP]/g;
function stripTerminalControlSequences(s) {
  return s.replace(TERMINAL_OSC_REGEX, " ").replace(TERMINAL_CSI_REGEX, " ").replace(TERMINAL_SHIFT_DCS_REGEX, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}
__name(stripTerminalControlSequences, "stripTerminalControlSequences");
function isBidiControlChar(code) {
  return code >= 8234 && code <= 8238 || code >= 8294 && code <= 8297;
}
__name(isBidiControlChar, "isBidiControlChar");
function stripDisplayControlChars(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 9) {
      out += text[i];
      continue;
    }
    if (code < 32) continue;
    if (code >= 128 && code <= 159) continue;
    if (isBidiControlChar(code)) continue;
    out += text[i];
  }
  return out;
}
__name(stripDisplayControlChars, "stripDisplayControlChars");
var NOTIFICATION_LABEL_MAX_LENGTH = 80;
function truncateNotificationLabel(label) {
  const normalized = stripDisplayControlChars(label).replace(/\s+/g, " ").trim();
  const codePoints = [...normalized];
  if (codePoints.length <= NOTIFICATION_LABEL_MAX_LENGTH) {
    return normalized;
  }
  return codePoints.slice(0, NOTIFICATION_LABEL_MAX_LENGTH - 3).join("") + "...";
}
__name(truncateNotificationLabel, "truncateNotificationLabel");

// packages/core/src/goals/goal-protocol.ts
var GOAL_STATE_VERSION = 2;
var GOAL_PROPOSAL_REASON_MAX_CHARACTERS = 8e3;
var GOAL_PROPOSAL_REASON_MAX_BYTES = 16e3;
var GOAL_CHECKPOINT_CLAIM_LIMIT = 32;
var GOAL_CHECKPOINT_CLAIM_MAX_CHARACTERS = 2e3;
var GOAL_CHECKPOINT_CLAIM_MAX_BYTES = 16e3;
var GOAL_CHECKPOINT_SOURCE_REFERENCE_LIMIT = 32;
var GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON = "The current Goal revision exceeded the bounded evidence catalog. Automatic retries cannot recover. Edit or replace the Goal before resuming it.";
var GOAL_CHECKPOINT_REQUEST_TOO_LARGE_REASON = "The current Goal revision exceeded the checkpoint verifier request limit. Automatic retries cannot recover. Edit or replace the Goal before resuming it.";
var GOAL_CHECKPOINT_STALL_LIMIT = 3;
var GOAL_NO_PROGRESS_TURN_LIMIT = 3;
var GOAL_CHECKPOINT_STALLED_REASON = "The current Goal revision ran three consecutive evidence checkpoints without relief: the evidence window overflowed every time, and the last check could not fit it within the checkpoint claim bounds, so every turn paid a checkpoint call and lost uncatalogued evidence. Automatic retries cannot recover. Edit or replace the Goal with a narrower objective before resuming it.";
var GOAL_CHECKPOINT_UNUSABLE_REASON = "The current Goal revision ran three consecutive evidence checkpoints without relief: the evidence window overflowed every time, and the last check answered with output that could not be folded into claims. Narrowing the objective does not fix this. Check that the checkpoint model returns the structured JSON it is asked for, or switch models, then resume the Goal; resuming starts a fresh evidence window.";
var GOAL_CHECKPOINT_UNREACHABLE_REASON = "The current Goal revision ran three consecutive evidence checkpoints without relief: the evidence window overflowed every time, and the last check failed before the checkpoint verifier returned an answer. The recorded checkpoint failure says why: an unreachable or rate-limited provider, a check that did not finish within model.goalCheckpointTimeoutSeconds, or an error in the check itself. Fix the provider, raise that timeout, or narrow the objective so the window checkpoints in time, then resume the Goal; resuming starts a fresh evidence window.";
function goalCheckpointStalledReason(shape) {
  switch (shape) {
    case "capacity":
      return GOAL_CHECKPOINT_STALLED_REASON;
    case "unusable":
      return GOAL_CHECKPOINT_UNUSABLE_REASON;
    case "unreachable":
      return GOAL_CHECKPOINT_UNREACHABLE_REASON;
    default: {
      const exhaustive = shape;
      return exhaustive;
    }
  }
}
__name(goalCheckpointStalledReason, "goalCheckpointStalledReason");
var GOAL_CHECKPOINT_FAILURE_MAX_CHARACTERS = 500;
function capGoalCheckpointFailure(text) {
  const oneLine = stripDisplayControlChars(stripTerminalControlSequences(text)).replace(/\s+/g, " ").trim();
  const codePoints = [...oneLine];
  return codePoints.length <= GOAL_CHECKPOINT_FAILURE_MAX_CHARACTERS ? oneLine : `${codePoints.slice(0, GOAL_CHECKPOINT_FAILURE_MAX_CHARACTERS - 1).join("")}\u2026`;
}
__name(capGoalCheckpointFailure, "capGoalCheckpointFailure");
var GOAL_DEFAULT_TOKEN_BUDGET = 3e7;
function goalTokenBudgetReason(tokenBudget) {
  return `The Goal spent its autonomous token budget (${tokenBudget.toLocaleString("en-US")} tokens). Resume the Goal to authorize another budget window, or clear it.`;
}
__name(goalTokenBudgetReason, "goalTokenBudgetReason");
function isGoalTokenBudgetSpent(goal) {
  return goal.tokenBudget !== void 0 && goal.tokensUsed >= goal.tokenBudget;
}
__name(isGoalTokenBudgetSpent, "isGoalTokenBudgetSpent");
function goalTurnBudgetReason(turnBudget) {
  return `The Goal ran its Goal-turn budget (${turnBudget.toLocaleString("en-US")} ${turnBudget === 1 ? "turn" : "turns"}). Resume the Goal to authorize another window of turns, or clear it.`;
}
__name(goalTurnBudgetReason, "goalTurnBudgetReason");
function isGoalTurnBudgetSpent(goal) {
  return goal.turnBudget !== void 0 && goal.turnCount >= goal.turnBudget;
}
__name(isGoalTurnBudgetSpent, "isGoalTurnBudgetSpent");
function formatGoalActiveTimeBudget(activeTimeBudgetMs) {
  const minutes = activeTimeBudgetMs / 6e4;
  if (minutes >= 1) {
    const rounded = Math.round(minutes);
    return `${rounded.toLocaleString("en-US")} ${rounded === 1 ? "minute" : "minutes"}`;
  }
  const seconds = Math.max(1, Math.round(activeTimeBudgetMs / 1e3));
  return `${seconds.toLocaleString("en-US")} ${seconds === 1 ? "second" : "seconds"}`;
}
__name(formatGoalActiveTimeBudget, "formatGoalActiveTimeBudget");
function goalActiveTimeBudgetReason(activeTimeBudgetMs) {
  return `The Goal ran its active-time budget (${formatGoalActiveTimeBudget(activeTimeBudgetMs)}). Resume the Goal to authorize another window of time, or clear it.`;
}
__name(goalActiveTimeBudgetReason, "goalActiveTimeBudgetReason");
function isGoalActiveTimeBudgetSpent(goal, elapsedActiveMs) {
  return goal.activeTimeBudgetMs !== void 0 && elapsedActiveMs >= goal.activeTimeBudgetMs;
}
__name(isGoalActiveTimeBudgetSpent, "isGoalActiveTimeBudgetSpent");
function isGoalLimitKind(value) {
  return value === "evidence_catalog" || value === "checkpoint_request" || isGoalBudgetLimitKind(value);
}
__name(isGoalLimitKind, "isGoalLimitKind");
function isGoalBudgetLimitKind(value) {
  return value === "token_budget" || value === "turn_budget" || value === "time_budget";
}
__name(isGoalBudgetLimitKind, "isGoalBudgetLimitKind");
function goalLimitKindForReason(reason) {
  if (reason === GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON) {
    return "evidence_catalog";
  }
  if (reason === GOAL_CHECKPOINT_REQUEST_TOO_LARGE_REASON) {
    return "checkpoint_request";
  }
  return void 0;
}
__name(goalLimitKindForReason, "goalLimitKindForReason");
var PAUSED_GOAL_SYSTEM_REMINDER = "<system-reminder>\nThe Goal is paused. Do not continue its objective unless the user resumes it. Treat this message as ordinary conversation.\n</system-reminder>";
function isGoalEvidenceProofKind(value) {
  return value === "user_input" || value === "delivered_output" || value === "external_fact";
}
__name(isGoalEvidenceProofKind, "isGoalEvidenceProofKind");
function emptyGoalSnapshot() {
  return { v: GOAL_STATE_VERSION, goal: null, activity: "idle" };
}
__name(emptyGoalSnapshot, "emptyGoalSnapshot");
function goalRequiresExactPermit(snapshot) {
  return snapshot.goal !== null && (snapshot.goal.status === "active" || snapshot.activity === "running");
}
__name(goalRequiresExactPermit, "goalRequiresExactPermit");
function isRepeatedBlockerProposal(proposal) {
  return proposal.status === "blocked" && proposal.blockerKind !== "authority" && proposal.blockerKind !== "external" && proposal.blockerKind !== "infeasible";
}
__name(isRepeatedBlockerProposal, "isRepeatedBlockerProposal");
var GOAL_INFEASIBLE_NEXT_STEP = "The objective cannot be satisfied as written; edit or replace the Goal with an objective the evidence allows before resuming it.";
function validateGoalProposalReason(reason) {
  if (!reason.trim()) return "Goal proposal reason must not be empty";
  if ([...reason].length > GOAL_PROPOSAL_REASON_MAX_CHARACTERS) {
    return `Goal proposal reason exceeds ${GOAL_PROPOSAL_REASON_MAX_CHARACTERS} characters`;
  }
  if (new TextEncoder().encode(reason).byteLength > GOAL_PROPOSAL_REASON_MAX_BYTES) {
    return `Goal proposal reason exceeds ${GOAL_PROPOSAL_REASON_MAX_BYTES} UTF-8 bytes`;
  }
  return null;
}
__name(validateGoalProposalReason, "validateGoalProposalReason");
var GOAL_PAUSE_REASON_MAX_CHARACTERS = 500;
function validateGoalPauseReason(reason) {
  if (!reason.trim()) return "Goal pause reason must not be empty";
  if (reason.length > GOAL_PAUSE_REASON_MAX_CHARACTERS) {
    let codePoints = 0;
    for (const _codePoint of reason) {
      if (++codePoints > GOAL_PAUSE_REASON_MAX_CHARACTERS) {
        return `Goal pause reason exceeds ${GOAL_PAUSE_REASON_MAX_CHARACTERS} characters`;
      }
    }
  }
  return null;
}
__name(validateGoalPauseReason, "validateGoalPauseReason");
var GOAL_PAUSE_REASON_USER_INTERRUPT = "Interrupted by the user. Run /goal resume to continue.";
var GOAL_PAUSE_REASON_COMMAND = "Paused with /goal pause.";
var GOAL_PAUSE_REASON_SESSION_TOKEN_LIMIT = "The session token limit was exceeded before the model request. Start a new session or increase sessionTokenLimit in settings.json before resuming the Goal.";
var GOAL_PAUSE_REASON_STOP_HOOK_CAP = "A Stop hook blocked this session too many times in a row. Run /goal resume to continue.";
var GOAL_PAUSE_REASON_SESSION_DISPOSED = "The session started closing before the turn finished. Run /goal resume to continue.";
var GOAL_PAUSE_REASON_HEADLESS_RUN_ENDED = "The headless run finished before the Goal did. Resume the Goal in a later run.";
var GOAL_PAUSE_REASON_NO_PROGRESS = "Three Goal turns in a row recorded nothing to judge and no proposal. Resume the Goal to try again, or edit its objective into one the model can act on and then resume it.";
function truncateGoalPauseReason(reason) {
  const codePoints = [...reason];
  return codePoints.length <= GOAL_PAUSE_REASON_MAX_CHARACTERS ? reason : `${codePoints.slice(0, GOAL_PAUSE_REASON_MAX_CHARACTERS - 1).join("")}\u2026`;
}
__name(truncateGoalPauseReason, "truncateGoalPauseReason");
function goalPauseReasonForFailure(message) {
  const detail = message.trim();
  return truncateGoalPauseReason(
    detail ? `The Goal turn could not finish: ${detail}. Run /goal resume to continue.` : "The Goal turn could not finish. Run /goal resume to continue."
  );
}
__name(goalPauseReasonForFailure, "goalPauseReasonForFailure");
function goalPauseReasonForVerifierFailure(message) {
  const detail = message.trim();
  return truncateGoalPauseReason(
    detail ? `The Goal verifier could not judge the proposal: ${detail}. Run /goal resume to continue.` : "The Goal verifier could not judge the proposal. Run /goal resume to continue."
  );
}
__name(goalPauseReasonForVerifierFailure, "goalPauseReasonForVerifierFailure");
function goalPauseReasonForHeadlessFailure(message) {
  const detail = message.trim();
  return truncateGoalPauseReason(
    detail ? `The headless run stopped: ${detail}. Resume the Goal in a later run.` : "The headless run stopped before the Goal turn finished. Resume the Goal in a later run."
  );
}
__name(goalPauseReasonForHeadlessFailure, "goalPauseReasonForHeadlessFailure");
function goalPauseReasonForRunBudget(budget) {
  const detail = budget.trim();
  return truncateGoalPauseReason(
    detail ? `The headless run stopped at its ${detail} budget. Resume the Goal in a later run.` : "The headless run stopped at a budget. Resume the Goal in a later run."
  );
}
__name(goalPauseReasonForRunBudget, "goalPauseReasonForRunBudget");

// packages/core/src/goals/goal-reducer.ts
var MAX_BLOCKED_AUDIT_COUNT = 3;
function reduceGoalSpend(goal, tokens, now) {
  if (!Number.isFinite(tokens) || tokens <= 0) return goal;
  return {
    ...goal,
    tokensUsed: goal.tokensUsed + tokens,
    activeTimeMs: elapsedActiveTime(goal, now),
    updatedAt: now
  };
}
__name(reduceGoalSpend, "reduceGoalSpend");
var GoalConflictError = class extends Error {
  constructor(current) {
    super("Goal version does not match the current session Goal");
    this.current = current;
    this.name = "GoalConflictError";
  }
  static {
    __name(this, "GoalConflictError");
  }
};
var GoalInvalidTransitionError = class extends Error {
  constructor(message, current) {
    super(message);
    this.current = current;
    this.name = "GoalInvalidTransitionError";
  }
  static {
    __name(this, "GoalInvalidTransitionError");
  }
};
function elapsedActiveTime(goal, now) {
  return goal.activeTimeMs + (goal.status === "active" ? Math.max(0, now - goal.updatedAt) : 0);
}
__name(elapsedActiveTime, "elapsedActiveTime");
function reduceGoalControl(current, transition) {
  const { request } = transition;
  if (request.action === "create") {
    if (current) throw new GoalConflictError(snapshotOf(current));
    return createGoal(
      transition.nextGoalId,
      normalizeObjective(request.objective, snapshotOf(null)),
      transition.now,
      transition.cursor,
      transition
    );
  }
  assertExpectedVersion(
    current,
    request.expectedGoalId,
    request.expectedRevision
  );
  if (request.action === "clear") return null;
  if (request.action === "replace") {
    return createGoal(
      transition.nextGoalId,
      normalizeObjective(request.objective, snapshotOf(current)),
      transition.now,
      transition.cursor,
      transition
    );
  }
  if (request.action === "edit") {
    if (current.status === "complete") {
      throw new GoalInvalidTransitionError(
        "A completed Goal cannot be edited",
        snapshotOf(current)
      );
    }
    return transitionGoal(current, transition.now, {
      revision: current.revision + 1,
      objective: normalizeObjective(request.objective, snapshotOf(current)),
      evidenceCursor: copyCursor(transition.cursor),
      evidenceCheckpoint: void 0,
      checkpointStalls: void 0,
      lastCheckpointFailure: void 0,
      noProgressTurns: void 0,
      ...rearmedBudgets(current, transition.now, transition),
      lastReason: void 0,
      limitKind: void 0
    });
  }
  if (request.action === "pause") {
    if (current.status !== "active") {
      throw new GoalInvalidTransitionError(
        "Only an active Goal can be paused",
        snapshotOf(current)
      );
    }
    return transitionGoal(current, transition.now, {
      status: "paused",
      lastReason: request.reason
    });
  }
  if (current.status === "complete") {
    throw new GoalInvalidTransitionError(
      "A completed Goal cannot be resumed",
      snapshotOf(current)
    );
  }
  if (current.status === "active") {
    throw new GoalInvalidTransitionError(
      "An active Goal cannot be resumed",
      snapshotOf(current)
    );
  }
  if (request.action === "resume" && current.status === "usage_limited" && isGoalBudgetLimitKind(current.limitKind)) {
    return transitionGoal(current, transition.now, {
      status: "active",
      noProgressTurns: void 0,
      ...rearmedBudgets(current, transition.now, transition),
      lastReason: void 0,
      limitKind: void 0
    });
  }
  if (request.action !== "resume") {
    return assertNever(request, snapshotOf(current));
  }
  if (current.status === "usage_limited" && isEvidenceLimited(current)) {
    return transitionGoal(current, transition.now, {
      status: "active",
      evidenceCursor: copyCursor(transition.cursor),
      evidenceCheckpoint: void 0,
      // The streak counts checkpoints against one window; this resume starts
      // a different one, so carrying it over would spend the new window's
      // allowance on the old window's failures.
      checkpointStalls: void 0,
      lastCheckpointFailure: void 0,
      noProgressTurns: void 0,
      ...rearmedBudgets(current, transition.now, transition),
      lastReason: void 0,
      limitKind: void 0
    });
  }
  return transitionGoal(current, transition.now, {
    status: "active",
    noProgressTurns: void 0,
    ...rearmedBudgets(current, transition.now, transition),
    ...current.status === "paused" ? { lastReason: void 0 } : {}
  });
}
__name(reduceGoalControl, "reduceGoalControl");
function reduceGoalTurnFinished(current, transition) {
  if (current.status !== "active" && current.status !== "paused") {
    throw new GoalInvalidTransitionError(
      "Only an active or paused Goal can finish a turn",
      snapshotOf(current)
    );
  }
  return transitionGoal(current, transition.now, {
    turnCount: current.turnCount + 1,
    tokensUsed: current.tokensUsed + Math.max(0, transition.tokensUsed ?? 0),
    ...transition.lastReason === void 0 ? {} : { lastReason: transition.lastReason },
    ...transition.windDownTurnId === void 0 ? {} : { windDownTurnId: transition.windDownTurnId },
    // Zero is spelled as no field, the same way the record persists it.
    ...transition.noProgressTurns === void 0 ? {} : {
      noProgressTurns: transition.noProgressTurns > 0 ? transition.noProgressTurns : void 0
    }
  });
}
__name(reduceGoalTurnFinished, "reduceGoalTurnFinished");
function parseGoalControlRequest(value) {
  if (!isRecord(value) || typeof value["action"] !== "string") {
    return void 0;
  }
  switch (value["action"]) {
    case "create":
      if (!hasOnlyKeys(value, ["action", "objective"])) return void 0;
      return typeof value["objective"] === "string" ? parseObjectiveRequest(value["action"], value["objective"]) : void 0;
    case "replace":
    case "edit":
      if (!hasOnlyKeys(value, [
        "action",
        "objective",
        "expectedGoalId",
        "expectedRevision"
      ]) || typeof value["objective"] !== "string" || !isExpectedVersion(value)) {
        return void 0;
      }
      return parseObjectiveVersionedRequest(
        value["action"],
        value["objective"],
        value["expectedGoalId"],
        value["expectedRevision"]
      );
    case "pause": {
      if (!hasOnlyKeys(value, [
        "action",
        "expectedGoalId",
        "expectedRevision",
        "reason"
      ]) || !isExpectedVersion(value)) {
        return void 0;
      }
      const reason = value["reason"];
      if (reason !== void 0) {
        if (typeof reason !== "string" || validateGoalPauseReason(reason)) {
          return void 0;
        }
      }
      return {
        action: "pause",
        expectedGoalId: value["expectedGoalId"],
        expectedRevision: value["expectedRevision"],
        ...reason === void 0 ? {} : { reason }
      };
    }
    case "resume":
    case "clear":
      if (!hasOnlyKeys(value, ["action", "expectedGoalId", "expectedRevision"]) || !isExpectedVersion(value)) {
        return void 0;
      }
      return {
        action: value["action"],
        expectedGoalId: value["expectedGoalId"],
        expectedRevision: value["expectedRevision"]
      };
    default:
      return void 0;
  }
}
__name(parseGoalControlRequest, "parseGoalControlRequest");
function parseGoalStateRecordPayloadV2(value) {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "v",
    "cause",
    "snapshot",
    "checkpointPending",
    "blockedAudit"
  ]) || value["v"] !== GOAL_STATE_VERSION || !isGoalStateCause(value["cause"]) || !isCheckpointPending(value["checkpointPending"]) || !isBlockedAudit(value["blockedAudit"])) {
    return void 0;
  }
  const parsedSnapshot = parseGoalSnapshotV2(value["snapshot"]);
  if (parsedSnapshot?.activity !== "idle") return void 0;
  const checkpointPending = value["checkpointPending"];
  if (checkpointPending && (parsedSnapshot.goal?.status !== "active" || checkpointPending.permit.goalId !== parsedSnapshot.goal.goalId || checkpointPending.permit.revision !== parsedSnapshot.goal.revision || checkpointPending.recordUuid === parsedSnapshot.goal.evidenceCursor.recordId || value["cause"] !== "turn_finished" && value["cause"] !== "verifier_reject")) {
    return void 0;
  }
  return {
    v: GOAL_STATE_VERSION,
    cause: value["cause"],
    snapshot: parsedSnapshot,
    ...checkpointPending ? { checkpointPending: structuredClone(checkpointPending) } : {},
    ...value["blockedAudit"] ? { blockedAudit: structuredClone(value["blockedAudit"]) } : {}
  };
}
__name(parseGoalStateRecordPayloadV2, "parseGoalStateRecordPayloadV2");
function parseGoalSnapshotV2(value) {
  if (!isRecord(value) || !hasOnlyKeys(value, ["v", "goal", "activity", "clearedGoal"]) || value["v"] !== GOAL_STATE_VERSION || !isGoalActivity(value["activity"])) {
    return void 0;
  }
  if (value["goal"] === null) {
    const clearedGoal = parseGoalOrder(value["clearedGoal"]);
    if (value["clearedGoal"] !== void 0 && !clearedGoal) return void 0;
    return {
      v: GOAL_STATE_VERSION,
      goal: null,
      activity: value["activity"],
      ...clearedGoal ? { clearedGoal } : {}
    };
  }
  if (value["clearedGoal"] !== void 0) return void 0;
  const goal = parseGoalRecord(value["goal"]);
  return goal ? { v: GOAL_STATE_VERSION, goal, activity: value["activity"] } : void 0;
}
__name(parseGoalSnapshotV2, "parseGoalSnapshotV2");
function parseGoalOrder(value) {
  if (!isRecord(value) || !hasOnlyKeys(value, ["goalId", "revision", "updatedAt"]) || typeof value["goalId"] !== "string" || !value["goalId"] || !isNonNegativeInteger(value["revision"]) || value["revision"] === 0 || !isFiniteNumber(value["updatedAt"])) {
    return void 0;
  }
  return {
    goalId: value["goalId"],
    revision: value["revision"],
    updatedAt: value["updatedAt"]
  };
}
__name(parseGoalOrder, "parseGoalOrder");
function parseGoalStateCause(value) {
  return isGoalStateCause(value) ? value : void 0;
}
__name(parseGoalStateCause, "parseGoalStateCause");
function createGoal(goalId, objective, now, cursor, grants) {
  return {
    goalId,
    revision: 1,
    objective,
    status: "active",
    evidenceCursor: copyCursor(cursor),
    turnCount: 0,
    activeTimeMs: 0,
    tokensUsed: 0,
    ...armedBudget("tokenBudget", grants.tokenBudgetGrant),
    ...armedBudget("turnBudget", grants.turnBudgetGrant),
    ...armedBudget("activeTimeBudgetMs", grants.activeTimeBudgetGrantMs),
    createdAt: now,
    updatedAt: now
  };
}
__name(createGoal, "createGoal");
function armedBudget(field, grant) {
  return grant !== void 0 && Number.isFinite(grant) ? { [field]: grant } : {};
}
__name(armedBudget, "armedBudget");
function assertExpectedVersion(current, expectedGoalId, expectedRevision) {
  if (!current || current.goalId !== expectedGoalId || current.revision !== expectedRevision) {
    throw new GoalConflictError(snapshotOf(current));
  }
}
__name(assertExpectedVersion, "assertExpectedVersion");
function normalizeObjective(objective, current) {
  const normalized = objective.trim();
  if (!normalized) {
    throw new GoalInvalidTransitionError(
      "Goal objective must not be empty",
      current
    );
  }
  return normalized;
}
__name(normalizeObjective, "normalizeObjective");
function isEvidenceLimited(goal) {
  return goal.limitKind === "evidence_catalog" || goal.limitKind === "checkpoint_request" || goal.lastReason !== void 0 && goalLimitKindForReason(goal.lastReason) !== void 0;
}
__name(isEvidenceLimited, "isEvidenceLimited");
function rearmedTokenBudget(current, grant) {
  if (grant === void 0 || !isGoalTokenBudgetSpent(current)) {
    return {};
  }
  return Number.isFinite(grant) ? { tokenBudget: current.tokensUsed + grant, windDownTurnId: void 0 } : { tokenBudget: void 0, windDownTurnId: void 0 };
}
__name(rearmedTokenBudget, "rearmedTokenBudget");
function rearmedTurnBudget(current, grant) {
  if (grant === void 0 || !isGoalTurnBudgetSpent(current)) {
    return {};
  }
  return Number.isFinite(grant) ? { turnBudget: current.turnCount + grant, windDownTurnId: void 0 } : { turnBudget: void 0, windDownTurnId: void 0 };
}
__name(rearmedTurnBudget, "rearmedTurnBudget");
function rearmedActiveTimeBudget(current, now, grant) {
  const elapsed = elapsedActiveTime(current, now);
  if (grant === void 0 || !isGoalActiveTimeBudgetSpent(current, elapsed)) {
    return {};
  }
  return Number.isFinite(grant) ? { activeTimeBudgetMs: elapsed + grant, windDownTurnId: void 0 } : { activeTimeBudgetMs: void 0, windDownTurnId: void 0 };
}
__name(rearmedActiveTimeBudget, "rearmedActiveTimeBudget");
function rearmedBudgets(current, now, grants) {
  return {
    ...rearmedTokenBudget(current, grants.tokenBudgetGrant),
    ...rearmedTurnBudget(current, grants.turnBudgetGrant),
    ...rearmedActiveTimeBudget(current, now, grants.activeTimeBudgetGrantMs)
  };
}
__name(rearmedBudgets, "rearmedBudgets");
function transitionGoal(goal, now, changes) {
  const transitioned = {
    ...goal,
    ...changes,
    activeTimeMs: elapsedActiveTime(goal, now),
    updatedAt: now
  };
  if ("tokenBudget" in changes && changes.tokenBudget === void 0) {
    delete transitioned.tokenBudget;
  }
  if ("turnBudget" in changes && changes.turnBudget === void 0) {
    delete transitioned.turnBudget;
  }
  if ("activeTimeBudgetMs" in changes && changes.activeTimeBudgetMs === void 0) {
    delete transitioned.activeTimeBudgetMs;
  }
  if ("windDownTurnId" in changes && changes.windDownTurnId === void 0) {
    delete transitioned.windDownTurnId;
  }
  if ("noProgressTurns" in changes && changes.noProgressTurns === void 0) {
    delete transitioned.noProgressTurns;
  }
  return transitioned;
}
__name(transitionGoal, "transitionGoal");
function snapshotOf(goal) {
  return { v: GOAL_STATE_VERSION, goal, activity: "idle" };
}
__name(snapshotOf, "snapshotOf");
function copyCursor(cursor) {
  return { recordId: cursor.recordId };
}
__name(copyCursor, "copyCursor");
function parseObjectiveRequest(action, objective) {
  const normalized = objective.trim();
  return normalized ? { action, objective: normalized } : void 0;
}
__name(parseObjectiveRequest, "parseObjectiveRequest");
function parseObjectiveVersionedRequest(action, objective, expectedGoalId, expectedRevision) {
  const normalized = objective.trim();
  return normalized ? { action, objective: normalized, expectedGoalId, expectedRevision } : void 0;
}
__name(parseObjectiveVersionedRequest, "parseObjectiveVersionedRequest");
function parseGoalRecord(value) {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "goalId",
    "revision",
    "objective",
    "status",
    "evidenceCursor",
    "turnCount",
    "activeTimeMs",
    "tokensUsed",
    "tokenBudget",
    "turnBudget",
    "activeTimeBudgetMs",
    "windDownTurnId",
    "createdAt",
    "updatedAt",
    "evidenceCheckpoint",
    "checkpointStalls",
    "lastCheckpointFailure",
    "noProgressTurns",
    "lastReason",
    "limitKind"
  ]) || typeof value["goalId"] !== "string" || !value["goalId"] || !isNonNegativeInteger(value["revision"]) || value["revision"] === 0 || typeof value["objective"] !== "string" || !value["objective"].trim() || !isGoalStatus(value["status"]) || !isTranscriptCursor(value["evidenceCursor"]) || !isNonNegativeInteger(value["turnCount"]) || !isNonNegativeNumber(value["activeTimeMs"]) || value["tokensUsed"] !== void 0 && !isNonNegativeNumber(value["tokensUsed"]) || value["tokenBudget"] !== void 0 && !isNonNegativeNumber(value["tokenBudget"]) || value["turnBudget"] !== void 0 && !isNonNegativeInteger(value["turnBudget"]) || value["activeTimeBudgetMs"] !== void 0 && !isNonNegativeNumber(value["activeTimeBudgetMs"]) || value["windDownTurnId"] !== void 0 && (typeof value["windDownTurnId"] !== "string" || !value["windDownTurnId"]) || !isFiniteNumber(value["createdAt"]) || !isFiniteNumber(value["updatedAt"]) || !isGoalEvidenceCheckpoint(value["evidenceCheckpoint"]) || value["checkpointStalls"] !== void 0 && !isNonNegativeInteger(value["checkpointStalls"]) || value["lastCheckpointFailure"] !== void 0 && (typeof value["lastCheckpointFailure"] !== "string" || !value["lastCheckpointFailure"]) || value["noProgressTurns"] !== void 0 && !isNonNegativeInteger(value["noProgressTurns"]) || value["lastReason"] !== void 0 && typeof value["lastReason"] !== "string" || value["limitKind"] !== void 0 && (!isGoalLimitKind(value["limitKind"]) || value["status"] !== "usage_limited")) {
    return void 0;
  }
  if (value["evidenceCheckpoint"] && value["evidenceCursor"].recordId !== value["evidenceCheckpoint"].checkpointId) {
    return void 0;
  }
  return {
    goalId: value["goalId"],
    revision: value["revision"],
    objective: value["objective"],
    status: value["status"],
    evidenceCursor: copyCursor(value["evidenceCursor"]),
    turnCount: value["turnCount"],
    activeTimeMs: value["activeTimeMs"],
    // Goals persisted before `tokensUsed` existed carry no spend to restore.
    tokensUsed: value["tokensUsed"] ?? 0,
    // And no budget: a Goal from before budgets existed stays unbounded.
    ...value["tokenBudget"] === void 0 ? {} : { tokenBudget: value["tokenBudget"] },
    ...value["turnBudget"] === void 0 ? {} : { turnBudget: value["turnBudget"] },
    ...value["activeTimeBudgetMs"] === void 0 ? {} : { activeTimeBudgetMs: value["activeTimeBudgetMs"] },
    ...value["windDownTurnId"] === void 0 ? {} : { windDownTurnId: value["windDownTurnId"] },
    createdAt: value["createdAt"],
    updatedAt: value["updatedAt"],
    ...value["evidenceCheckpoint"] === void 0 ? {} : {
      evidenceCheckpoint: structuredClone(value["evidenceCheckpoint"])
    },
    // Zero is spelled as no field; a persisted 0 restores the same way.
    ...value["checkpointStalls"] ? { checkpointStalls: value["checkpointStalls"] } : {},
    ...value["lastCheckpointFailure"] === void 0 ? {} : { lastCheckpointFailure: value["lastCheckpointFailure"] },
    ...value["noProgressTurns"] ? { noProgressTurns: value["noProgressTurns"] } : {},
    ...value["lastReason"] === void 0 ? {} : { lastReason: value["lastReason"] },
    ...value["limitKind"] === void 0 ? {} : { limitKind: value["limitKind"] }
  };
}
__name(parseGoalRecord, "parseGoalRecord");
function isExpectedVersion(value) {
  return typeof value["expectedGoalId"] === "string" && value["expectedGoalId"].length > 0 && isNonNegativeInteger(value["expectedRevision"]) && value["expectedRevision"] > 0;
}
__name(isExpectedVersion, "isExpectedVersion");
function isTranscriptCursor(value) {
  return isRecord(value) && hasOnlyKeys(value, ["recordId"]) && (typeof value["recordId"] === "string" || value["recordId"] === null);
}
__name(isTranscriptCursor, "isTranscriptCursor");
function isGoalStatus(value) {
  return value === "active" || value === "paused" || value === "blocked" || value === "usage_limited" || value === "complete";
}
__name(isGoalStatus, "isGoalStatus");
function isGoalActivity(value) {
  return value === "idle" || value === "running" || value === "verifying";
}
__name(isGoalActivity, "isGoalActivity");
function isGoalStateCause(value) {
  return value === "create" || value === "replace" || value === "edit" || value === "pause" || value === "resume" || value === "turn_finished" || value === "checkpoint" || value === "verifier_accept" || value === "verifier_reject" || value === "complete" || value === "blocked" || value === "usage_limited" || value === "clear" || value === "migrated";
}
__name(isGoalStateCause, "isGoalStateCause");
function isGoalEvidenceCheckpoint(value) {
  if (value === void 0) return true;
  if (!isRecord(value) || !hasOnlyKeys(value, ["checkpointId", "createdAt", "claims"]) || typeof value["checkpointId"] !== "string" || value["checkpointId"].length === 0 || !isFiniteNumber(value["createdAt"]) || !Array.isArray(value["claims"]) || value["claims"].length === 0 || value["claims"].length > GOAL_CHECKPOINT_CLAIM_LIMIT) {
    return false;
  }
  let checkpointBytes = 0;
  for (const [index, claim] of value["claims"].entries()) {
    if (!isRecord(claim) || !hasOnlyKeys(claim, ["id", "proofKind", "claim", "sourceRefs"]) || claim["id"] !== `${value["checkpointId"]}:${index + 1}` || !isGoalEvidenceProofKind(claim["proofKind"]) || typeof claim["claim"] !== "string" || claim["claim"].trim().length === 0 || [...claim["claim"]].length > GOAL_CHECKPOINT_CLAIM_MAX_CHARACTERS || !Array.isArray(claim["sourceRefs"]) || claim["sourceRefs"].length === 0 || claim["sourceRefs"].length > GOAL_CHECKPOINT_SOURCE_REFERENCE_LIMIT || new Set(claim["sourceRefs"]).size !== claim["sourceRefs"].length || claim["sourceRefs"].some(
      (reference) => typeof reference !== "string" || reference.length === 0
    )) {
      return false;
    }
    checkpointBytes += new TextEncoder().encode(claim["claim"]).byteLength;
    if (checkpointBytes > GOAL_CHECKPOINT_CLAIM_MAX_BYTES) return false;
  }
  return true;
}
__name(isGoalEvidenceCheckpoint, "isGoalEvidenceCheckpoint");
function isCheckpointPending(value) {
  return value === void 0 || isRecord(value) && hasOnlyKeys(value, ["permit", "recordUuid"]) && isGoalTurnPermit(value["permit"]) && typeof value["recordUuid"] === "string" && value["recordUuid"].length > 0;
}
__name(isCheckpointPending, "isCheckpointPending");
function isGoalTurnPermit(value) {
  return isRecord(value) && hasOnlyKeys(value, ["goalId", "revision", "turnId"]) && typeof value["goalId"] === "string" && value["goalId"].length > 0 && isNonNegativeInteger(value["revision"]) && value["revision"] > 0 && typeof value["turnId"] === "string" && value["turnId"].length > 0;
}
__name(isGoalTurnPermit, "isGoalTurnPermit");
function isBlockedAudit(value) {
  return value === void 0 || isRecord(value) && hasOnlyKeys(value, ["fingerprint", "count", "turnIds"]) && typeof value["fingerprint"] === "string" && value["fingerprint"].length > 0 && isNonNegativeInteger(value["count"]) && value["count"] > 0 && value["count"] <= MAX_BLOCKED_AUDIT_COUNT && Array.isArray(value["turnIds"]) && value["turnIds"].length === value["count"] && value["turnIds"].every(
    (turnId) => typeof turnId === "string" && turnId.length > 0
  );
}
__name(isBlockedAudit, "isBlockedAudit");
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isRecord, "isRecord");
function hasOnlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key));
}
__name(hasOnlyKeys, "hasOnlyKeys");
function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
__name(isNonNegativeInteger, "isNonNegativeInteger");
function isNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
__name(isNonNegativeNumber, "isNonNegativeNumber");
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
__name(isFiniteNumber, "isFiniteNumber");
function assertNever(value, snapshot) {
  throw new GoalInvalidTransitionError(
    `Unsupported Goal control action: ${String(value)}`,
    snapshot
  );
}
__name(assertNever, "assertNever");

// packages/core/src/telemetry/goal-events.ts
var REPORTED_CAUSES = new Set(
  GOAL_STATE_EVENT_CAUSES
);
function isGoalStateEventCause(cause) {
  return cause !== void 0 && REPORTED_CAUSES.has(cause);
}
__name(isGoalStateEventCause, "isGoalStateEventCause");
function goalStateEventFromSnapshot(snapshot, cause, now = Date.now()) {
  if (!isGoalStateEventCause(cause)) return void 0;
  const goal = snapshot.goal;
  if (!goal) {
    const cleared = snapshot.clearedGoal;
    return cause === "clear" && cleared ? makeGoalStateEvent({
      cause,
      goal_id: cleared.goalId,
      revision: cleared.revision
    }) : void 0;
  }
  return makeGoalStateEvent({
    cause,
    goal_id: goal.goalId,
    revision: goal.revision,
    status: goal.status,
    limit_kind: goal.limitKind,
    turn_count: goal.turnCount,
    tokens_used: goal.tokensUsed,
    no_progress_turns: goal.noProgressTurns,
    token_budget: goal.tokenBudget,
    turn_budget: goal.turnBudget,
    active_time_ms: elapsedActiveTime(goal, now),
    active_time_budget_ms: goal.activeTimeBudgetMs,
    objective_length: [...goal.objective].length
  });
}
__name(goalStateEventFromSnapshot, "goalStateEventFromSnapshot");

// packages/core/src/telemetry/daemon-metrics.ts
init_esbuild_shims();
init_esm();
var DAEMON_HTTP_REQUEST_COUNT = `${SERVICE_NAME}.daemon.http.request.count`;
var DAEMON_HTTP_REQUEST_DURATION = `${SERVICE_NAME}.daemon.http.request.duration`;
var DAEMON_SESSION_ACTIVE = `${SERVICE_NAME}.daemon.session.active`;
var DAEMON_SESSION_LIFECYCLE = `${SERVICE_NAME}.daemon.session.lifecycle`;
var DAEMON_CHANNEL_LIFECYCLE = `${SERVICE_NAME}.daemon.channel.lifecycle`;
var DAEMON_PROMPT_QUEUE_WAIT = `${SERVICE_NAME}.daemon.prompt.queue_wait`;
var DAEMON_PROMPT_DURATION = `${SERVICE_NAME}.daemon.prompt.duration`;
var DAEMON_BRIDGE_ERROR_COUNT = `${SERVICE_NAME}.daemon.bridge.error.count`;
var DAEMON_CANCEL_COUNT = `${SERVICE_NAME}.daemon.cancel.count`;
var DAEMON_PIPE_MESSAGE_BYTES = `${SERVICE_NAME}.daemon.pipe.message_bytes`;
var DAEMON_SSE_ACTIVE = `${SERVICE_NAME}.daemon.sse.active`;
var DAEMON_PROCESS_HEAP_USED = `${SERVICE_NAME}.daemon.process.heap_used`;
var KNOWN_ERROR_TYPES = /* @__PURE__ */ new Set([
  "SessionNotFoundError",
  "WorkspaceMismatchError",
  "InvalidClientIdError",
  "SessionLimitExceededError",
  "RestoreInProgressError",
  "InvalidSessionScopeError",
  "TrustGateError",
  "WorkspaceInitConflictError",
  "WorkspaceInitPathEscapeError",
  "WorkspaceInitSymlinkError",
  "WorkspaceInitRaceError",
  "McpServerNotFoundError",
  "McpServerRestartFailedError",
  "PromptDeadlineExceededError",
  "InvalidSessionMetadataError",
  "SubscriberLimitExceededError",
  "BridgeChannelClosedError",
  "BridgeTimeoutError",
  "SessionRestoreTimeoutError",
  "BridgeChannelQuarantinedError",
  "PermissionForbiddenError"
]);
var initialized = false;
var httpRequestCounter;
var httpRequestDurationHistogram;
var sessionLifecycleCounter;
var channelLifecycleCounter;
var promptQueueWaitHistogram;
var promptDurationHistogram;
var bridgeErrorCounter;
var cancelCounter;
var pipeMessageBytesHistogram;
function normalizeErrorType(err) {
  const name = err instanceof Error ? err.name : typeof err;
  return KNOWN_ERROR_TYPES.has(name) ? name : "unknown";
}
__name(normalizeErrorType, "normalizeErrorType");
function initializeDaemonMetrics() {
  if (initialized) return;
  const meter = getMeter();
  if (!meter) return;
  httpRequestCounter = meter.createCounter(DAEMON_HTTP_REQUEST_COUNT, {
    description: "Daemon HTTP request count by route and status class.",
    valueType: ValueType.INT
  });
  httpRequestDurationHistogram = meter.createHistogram(
    DAEMON_HTTP_REQUEST_DURATION,
    {
      description: "Daemon HTTP request duration in milliseconds.",
      unit: "ms",
      valueType: ValueType.DOUBLE,
      advice: {
        explicitBucketBoundaries: [
          1,
          2,
          5,
          10,
          25,
          50,
          100,
          250,
          500,
          1e3,
          2500,
          5e3,
          1e4,
          3e4
        ]
      }
    }
  );
  sessionLifecycleCounter = meter.createCounter(DAEMON_SESSION_LIFECYCLE, {
    description: "Daemon session lifecycle events (spawn, close, die).",
    valueType: ValueType.INT
  });
  channelLifecycleCounter = meter.createCounter(DAEMON_CHANNEL_LIFECYCLE, {
    description: "Daemon ACP channel lifecycle events (spawn, exit).",
    valueType: ValueType.INT
  });
  promptQueueWaitHistogram = meter.createHistogram(DAEMON_PROMPT_QUEUE_WAIT, {
    description: "Time a prompt waited in the per-session FIFO queue.",
    unit: "ms",
    valueType: ValueType.DOUBLE,
    advice: {
      explicitBucketBoundaries: [
        1,
        5,
        10,
        50,
        100,
        500,
        1e3,
        5e3,
        1e4,
        3e4,
        6e4
      ]
    }
  });
  promptDurationHistogram = meter.createHistogram(DAEMON_PROMPT_DURATION, {
    description: "End-to-end prompt duration from dispatch to completion.",
    unit: "ms",
    valueType: ValueType.DOUBLE,
    advice: {
      explicitBucketBoundaries: [
        100,
        500,
        1e3,
        2500,
        5e3,
        1e4,
        3e4,
        6e4,
        12e4,
        3e5,
        6e5
      ]
    }
  });
  bridgeErrorCounter = meter.createCounter(DAEMON_BRIDGE_ERROR_COUNT, {
    description: "Daemon bridge error count by normalized error type.",
    valueType: ValueType.INT
  });
  cancelCounter = meter.createCounter(DAEMON_CANCEL_COUNT, {
    description: "Daemon cancel request count.",
    valueType: ValueType.INT
  });
  pipeMessageBytesHistogram = meter.createHistogram(DAEMON_PIPE_MESSAGE_BYTES, {
    description: "Daemon ACP child pipe message payload size in bytes.",
    unit: "By",
    valueType: ValueType.INT,
    advice: {
      explicitBucketBoundaries: [
        256,
        1024,
        4096,
        16384,
        65536,
        262144,
        1048576,
        4194304,
        16777216
      ]
    }
  });
  initialized = true;
}
__name(initializeDaemonMetrics, "initializeDaemonMetrics");
var gaugesRegistered = false;
function registerDaemonGaugeCallbacks(callbacks) {
  if (gaugesRegistered) return;
  const meter = getMeter();
  if (!meter) return;
  meter.createObservableGauge(DAEMON_SESSION_ACTIVE, {
    description: "Current number of active daemon sessions.",
    valueType: ValueType.INT
  }).addCallback((result) => {
    try {
      result.observe(callbacks.sessionCount());
    } catch {
    }
  });
  meter.createObservableGauge(DAEMON_SSE_ACTIVE, {
    description: "Current number of active SSE connections.",
    valueType: ValueType.INT
  }).addCallback((result) => {
    try {
      result.observe(callbacks.sseCount());
    } catch {
    }
  });
  meter.createObservableGauge(DAEMON_PROCESS_HEAP_USED, {
    description: "Daemon process heap memory usage in bytes.",
    unit: "bytes",
    valueType: ValueType.INT
  }).addCallback((result) => {
    try {
      result.observe(callbacks.heapUsed());
    } catch {
    }
  });
  gaugesRegistered = true;
}
__name(registerDaemonGaugeCallbacks, "registerDaemonGaugeCallbacks");
function recordDaemonHttpRequest(durationMs, route, statusCode, deferredRuntimePath) {
  if (!initialized) return;
  const statusClass = `${Math.floor(statusCode / 100)}xx`;
  httpRequestCounter?.add(1, { route, status_class: statusClass });
  httpRequestDurationHistogram?.record(durationMs, {
    route,
    runtime_path: deferredRuntimePath ?? "none"
  });
}
__name(recordDaemonHttpRequest, "recordDaemonHttpRequest");
function recordDaemonSessionLifecycle(action) {
  if (!initialized) return;
  sessionLifecycleCounter?.add(1, { action });
}
__name(recordDaemonSessionLifecycle, "recordDaemonSessionLifecycle");
function recordDaemonChannelLifecycle(action, expected) {
  if (!initialized) return;
  channelLifecycleCounter?.add(1, {
    action,
    ...expected != null ? { expected } : {}
  });
}
__name(recordDaemonChannelLifecycle, "recordDaemonChannelLifecycle");
function recordDaemonPromptQueueWait(durationMs) {
  if (!initialized) return;
  promptQueueWaitHistogram?.record(durationMs);
}
__name(recordDaemonPromptQueueWait, "recordDaemonPromptQueueWait");
function recordDaemonPromptDuration(durationMs) {
  if (!initialized) return;
  promptDurationHistogram?.record(durationMs);
}
__name(recordDaemonPromptDuration, "recordDaemonPromptDuration");
function recordDaemonBridgeError(err) {
  if (!initialized) return;
  bridgeErrorCounter?.add(1, { error_type: normalizeErrorType(err) });
}
__name(recordDaemonBridgeError, "recordDaemonBridgeError");
function recordDaemonCancel() {
  if (!initialized) return;
  cancelCounter?.add(1);
}
__name(recordDaemonCancel, "recordDaemonCancel");
function recordDaemonPipeMessage(direction, bytes) {
  if (!initialized) return;
  pipeMessageBytesHistogram?.record(bytes, { direction });
}
__name(recordDaemonPipeMessage, "recordDaemonPipeMessage");

// packages/core/src/telemetry/event-loop-lag.ts
init_esbuild_shims();
import { monitorEventLoopDelay } from "node:perf_hooks";
var DEFAULT_RESOLUTION_MS = 20;
var DEFAULT_STALL_THRESHOLD_MS = 1e3;
var DEFAULT_EVENT_LOOP_SUSPEND_THRESHOLD_MS = 5 * 60 * 1e3;
var DEFAULT_SUSPEND_CPU_RATIO = 0.01;
var NS_PER_MS = 1e6;
function startEventLoopLagMonitor(options = {}) {
  const resolutionMs = positiveFiniteOrDefault(
    options.resolutionMs,
    DEFAULT_RESOLUTION_MS
  );
  const stallThresholdMs = positiveFiniteOrDefault(
    options.stallThresholdMs,
    DEFAULT_STALL_THRESHOLD_MS
  );
  const suspendThresholdMs = positiveFiniteOrDefault(
    options.suspendThresholdMs,
    DEFAULT_EVENT_LOOP_SUSPEND_THRESHOLD_MS
  );
  const suspendCpuRatio = fractionOrDefault(
    options.suspendCpuRatio,
    DEFAULT_SUSPEND_CPU_RATIO
  );
  const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();
  let disposed = false;
  let lastReportedMaxMs = 0;
  let lastObservedMaxMs = 0;
  let lastCheckTimeMs = Date.now();
  let lastCpuUsage = safeCpuUsage();
  let pendingSuspendGapMs = 0;
  const readMaxMs = /* @__PURE__ */ __name(() => nsToMs(histogram.max), "readMaxMs");
  const checkHistogram = /* @__PURE__ */ __name(() => {
    if (disposed) return;
    const nowMs = Date.now();
    const cpuUsage = safeCpuUsage();
    const elapsedMs = Math.max(0, nowMs - lastCheckTimeMs);
    const maxMs = readMaxMs();
    const newMaxMs = maxMs > lastObservedMaxMs ? maxMs : 0;
    const cpuRatio = calculateCpuRatio(lastCpuUsage, cpuUsage, elapsedMs);
    lastCheckTimeMs = nowMs;
    if (cpuUsage) lastCpuUsage = cpuUsage;
    lastObservedMaxMs = maxMs;
    const isLowCpuGap = elapsedMs >= suspendThresholdMs && cpuRatio !== void 0 && cpuRatio <= suspendCpuRatio;
    const suspendGapMs = isLowCpuGap ? elapsedMs : pendingSuspendGapMs;
    pendingSuspendGapMs = isLowCpuGap ? elapsedMs : 0;
    if (newMaxMs >= suspendThresholdMs && suspendGapMs >= suspendThresholdMs && newMaxMs <= suspendGapMs * 1.5) {
      histogram.reset();
      lastObservedMaxMs = 0;
      lastReportedMaxMs = 0;
      pendingSuspendGapMs = 0;
      return;
    }
    if (options.onNewMaxStall && maxMs >= stallThresholdMs && maxMs > lastReportedMaxMs) {
      lastReportedMaxMs = maxMs;
      try {
        options.onNewMaxStall(maxMs);
      } catch {
      }
    }
  }, "checkHistogram");
  const interval = setInterval(checkHistogram, resolutionMs);
  interval.unref();
  return {
    snapshot() {
      return {
        meanMs: nsToMs(histogram.mean),
        p50Ms: nsToMs(histogram.percentile(50)),
        p99Ms: nsToMs(histogram.percentile(99)),
        maxMs: readMaxMs()
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(interval);
      histogram.disable();
    }
  };
}
__name(startEventLoopLagMonitor, "startEventLoopLagMonitor");
function safeCpuUsage() {
  try {
    return process.cpuUsage();
  } catch {
    return void 0;
  }
}
__name(safeCpuUsage, "safeCpuUsage");
function calculateCpuRatio(previous, current, elapsedMs) {
  if (!previous || !current || elapsedMs <= 0) return void 0;
  const cpuMicroseconds = current.user - previous.user + (current.system - previous.system);
  return Math.max(0, cpuMicroseconds / (elapsedMs * 1e3));
}
__name(calculateCpuRatio, "calculateCpuRatio");
function nsToMs(value) {
  return Number.isFinite(value) ? value / NS_PER_MS : 0;
}
__name(nsToMs, "nsToMs");
function positiveFiniteOrDefault(value, fallback) {
  return value !== void 0 && Number.isFinite(value) && value > 0 ? value : fallback;
}
__name(positiveFiniteOrDefault, "positiveFiniteOrDefault");
function fractionOrDefault(value, fallback) {
  return value !== void 0 && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}
__name(fractionOrDefault, "fractionOrDefault");

// packages/core/src/telemetry/event-loop-lag-metrics.ts
init_esbuild_shims();
init_esm();
var DAEMON_EVENT_LOOP_LAG = `${SERVICE_NAME}.daemon.event_loop.lag`;
var ACP_EVENT_LOOP_LAG = `${SERVICE_NAME}.acp.event_loop.lag`;
var daemonGaugeRegistered = false;
var acpGaugeRegistered = false;
function registerDaemonEventLoopLagGauge(read) {
  if (daemonGaugeRegistered) return;
  daemonGaugeRegistered = registerEventLoopLagGauge(
    DAEMON_EVENT_LOOP_LAG,
    read
  );
}
__name(registerDaemonEventLoopLagGauge, "registerDaemonEventLoopLagGauge");
function registerAcpEventLoopLagGauge(read) {
  if (acpGaugeRegistered) return;
  acpGaugeRegistered = registerEventLoopLagGauge(ACP_EVENT_LOOP_LAG, read);
}
__name(registerAcpEventLoopLagGauge, "registerAcpEventLoopLagGauge");
function registerEventLoopLagGauge(name, read) {
  const meter = getMeter();
  if (!meter) return false;
  meter.createObservableGauge(name, {
    description: "Event loop lag in milliseconds.",
    unit: "ms",
    valueType: ValueType.DOUBLE
  }).addCallback((result) => {
    try {
      const snapshot = read();
      result.observe(snapshot.meanMs, { stat: "mean" });
      result.observe(snapshot.p50Ms, { stat: "p50" });
      result.observe(snapshot.p99Ms, { stat: "p99" });
      result.observe(snapshot.maxMs, { stat: "max" });
    } catch {
    }
  });
  return true;
}
__name(registerEventLoopLagGauge, "registerEventLoopLagGauge");

// packages/core/src/telemetry/detailed-span-attributes.ts
init_esbuild_shims();
var SHORT_TRUNCATION_SUFFIX = "...[TRUNCATED]";
var debugLogger = createDebugLogger("GEN_AI_CONTENT");
function areSensitiveSpanAttributesEnabled(config) {
  return isTelemetrySdkInitialized() && config.getTelemetryIncludeSensitiveSpanAttributes();
}
__name(areSensitiveSpanAttributesEnabled, "areSensitiveSpanAttributesEnabled");
function truncateContent(content, maxSize = DEFAULT_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH, originalLength = content.length) {
  if (!Number.isSafeInteger(maxSize) || maxSize < 1) {
    throw new TypeError(
      `maxSize must be a positive safe integer, got ${String(maxSize)}`
    );
  }
  if (!Number.isSafeInteger(originalLength) || originalLength < 0) {
    throw new TypeError(
      `originalLength must be a non-negative safe integer, got ${String(
        originalLength
      )}`
    );
  }
  if (originalLength < content.length) {
    throw new TypeError(
      `originalLength must be greater than or equal to content length, got ${originalLength} for content length ${content.length}`
    );
  }
  if (originalLength <= maxSize && content.length <= maxSize) {
    return { content, truncated: false };
  }
  if (originalLength > content.length && content.length <= maxSize) {
    return { content, truncated: true };
  }
  const suffix = `

[TRUNCATED - Content exceeds configured limit of ${maxSize} characters]`;
  if (suffix.length >= maxSize) {
    if (SHORT_TRUNCATION_SUFFIX.length >= maxSize) {
      return {
        content: SHORT_TRUNCATION_SUFFIX.slice(0, maxSize),
        truncated: true
      };
    }
    return {
      content: content.slice(0, maxSize - SHORT_TRUNCATION_SUFFIX.length) + SHORT_TRUNCATION_SUFFIX,
      truncated: true
    };
  }
  return {
    content: content.slice(0, maxSize - suffix.length) + suffix,
    truncated: true
  };
}
__name(truncateContent, "truncateContent");
function getMaxContentSize(config) {
  return config.getTelemetrySensitiveSpanAttributeMaxLength();
}
__name(getMaxContentSize, "getMaxContentSize");
function truncatePrefixedContent(prefix, content, maxSize) {
  const prefixedContent = `${prefix}${content}`;
  const result = truncateContent(prefixedContent, maxSize);
  return {
    ...result,
    originalLength: content.length
  };
}
__name(truncatePrefixedContent, "truncatePrefixedContent");
function addAgentInputMessageAttributes(config, span, promptText) {
  if (!areSensitiveSpanAttributesEnabled(config) || promptText.trim().length === 0) {
    return;
  }
  writeJsonAttribute(config, span, "gen_ai.input.messages", [
    {
      role: "user",
      parts: [{ type: "text", content: promptText }]
    }
  ]);
}
__name(addAgentInputMessageAttributes, "addAgentInputMessageAttributes");
function addAgentOutputMessageAttributes(config, span, responseText, finishReason) {
  if (!areSensitiveSpanAttributesEnabled(config) || responseText.trim().length === 0) {
    return;
  }
  const reason = normalizeAgentFinishReason(finishReason);
  if (!reason) return;
  writeJsonAttribute(config, span, "gen_ai.output.messages", [
    {
      role: "assistant",
      parts: [{ type: "text", content: responseText }],
      finish_reason: reason
    }
  ]);
}
__name(addAgentOutputMessageAttributes, "addAgentOutputMessageAttributes");
function normalizeAgentFinishReason(finishReason) {
  const reason = finishReason?.trim().toLowerCase();
  if (!reason || reason === "finish_reason_unspecified") return void 0;
  if (reason === "stop") return "stop";
  if (reason === "max_tokens") return "length";
  if (reason === "tool_calls" || reason === "function_call" || reason === "tool_call") {
    return "tool_call";
  }
  if (reason === "safety" || reason === "recitation" || reason === "language" || reason === "blocklist" || reason === "prohibited_content" || reason === "spii" || reason === "image_safety" || reason === "image_prohibited_content" || reason === "image_recitation" || reason === "image_other") {
    return "content_filter";
  }
  return reason;
}
__name(normalizeAgentFinishReason, "normalizeAgentFinishReason");
var AgentOutputMessageCapture = class {
  constructor(config) {
    this.config = config;
    this.enabled = areSensitiveSpanAttributesEnabled(config);
    this.maxLength = this.enabled ? config.getTelemetrySensitiveSpanAttributeMaxLength() : 0;
  }
  static {
    __name(this, "AgentOutputMessageCapture");
  }
  enabled;
  maxLength;
  responseText = "";
  finishReason;
  overflow = false;
  committed;
  beginResponse() {
    if (!this.enabled) return;
    this.clearResponse();
    this.committed = void 0;
  }
  appendText(text) {
    if (!this.enabled || !text || this.overflow) return;
    const remaining = this.maxLength - this.responseText.length;
    if (text.length > remaining) {
      this.responseText = "";
      this.overflow = true;
      this.committed = void 0;
      return;
    }
    this.responseText += text;
  }
  observeFinishReason(finishReason) {
    if (!this.enabled) return;
    const normalized = normalizeAgentFinishReason(finishReason);
    if (normalized) this.finishReason = normalized;
  }
  restartAttempt(preserveText) {
    if (!this.enabled) return;
    if (!preserveText) {
      this.clearResponse();
    } else {
      this.finishReason = void 0;
    }
    this.committed = void 0;
  }
  commitResponse(hasToolCalls) {
    if (!this.enabled || hasToolCalls || this.overflow || this.responseText.trim().length === 0 || !this.finishReason) {
      this.committed = void 0;
      return;
    }
    this.committed = {
      responseText: this.responseText,
      finishReason: this.finishReason
    };
  }
  writeToSpan(span) {
    if (!span || !this.committed) return;
    addAgentOutputMessageAttributes(
      this.config,
      span,
      this.committed.responseText,
      this.committed.finishReason
    );
  }
  clearResponse() {
    this.responseText = "";
    this.finishReason = void 0;
    this.overflow = false;
  }
};
function addUserPromptAttributes(config, span, promptText) {
  if (!areSensitiveSpanAttributesEnabled(config) || !promptText) return;
  const { content, truncated, originalLength } = truncatePrefixedContent(
    `[USER PROMPT]
`,
    promptText,
    getMaxContentSize(config)
  );
  span.setAttributes({
    new_context: content,
    ...truncated && {
      new_context_truncated: true,
      new_context_original_length: originalLength
    }
  });
}
__name(addUserPromptAttributes, "addUserPromptAttributes");
function addToolArgumentsAttributes(config, span, argumentsValue) {
  if (!areSensitiveSpanAttributesEnabled(config)) return;
  writeJsonAttribute(
    config,
    span,
    "gen_ai.tool.call.arguments",
    argumentsValue,
    true
  );
}
__name(addToolArgumentsAttributes, "addToolArgumentsAttributes");
function addToolCallResultAttributes(config, span, result) {
  if (!areSensitiveSpanAttributesEnabled(config)) return;
  writeJsonAttribute(config, span, "gen_ai.tool.call.result", result, true);
}
__name(addToolCallResultAttributes, "addToolCallResultAttributes");
function writeJsonAttribute(config, span, key, value, requireObject = false) {
  let serialized;
  try {
    serialized = stringifyGenAiJson(
      value,
      getMaxContentSize(config),
      requireObject
    );
  } catch {
    debugLogger.debug(`Failed to serialize ${key} span attribute`);
    return;
  }
  if (serialized === void 0) return;
  try {
    span.setAttribute(key, serialized);
  } catch {
    debugLogger.debug(`Failed to set ${key} span attribute`);
  }
}
__name(writeJsonAttribute, "writeJsonAttribute");

// packages/core/src/telemetry/index.ts
var DEFAULT_TELEMETRY_TARGET = "local" /* LOCAL */;
var DEFAULT_OTLP_ENDPOINT = "http://localhost:4317";

// packages/core/src/telemetry/resource-attributes.ts
init_esbuild_shims();
init_esm();
var RESERVED_RESOURCE_ATTRIBUTE_KEYS = /* @__PURE__ */ new Set([
  "service.version",
  "session.id"
]);
function warn(msg, warnings) {
  diag.warn(msg);
  warnings?.push(msg);
}
__name(warn, "warn");
function parseOtelResourceAttributes(raw, warnings) {
  if (!raw) return {};
  const out = {};
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) {
      warn(
        `Skipping malformed OTEL_RESOURCE_ATTRIBUTES entry: "${trimmed}" (hint: percent-encode literal commas as %2C)`,
        warnings
      );
      continue;
    }
    const rawKey = trimmed.slice(0, idx).trim();
    if (!rawKey) continue;
    const valueRaw = trimmed.slice(idx + 1).trim();
    let key;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      warn(
        `Invalid percent-encoding in OTEL_RESOURCE_ATTRIBUTES key "${rawKey}", using raw key`,
        warnings
      );
      key = rawKey;
    }
    let value;
    try {
      value = decodeURIComponent(valueRaw);
    } catch {
      warn(
        `Invalid percent-encoding in OTEL_RESOURCE_ATTRIBUTES for key "${key}", using raw value`,
        warnings
      );
      value = valueRaw;
    }
    out[key] = value;
  }
  return out;
}
__name(parseOtelResourceAttributes, "parseOtelResourceAttributes");
function stripReservedResourceAttributes(attrs, source, warnings) {
  for (const k of RESERVED_RESOURCE_ATTRIBUTE_KEYS) {
    if (k in attrs) {
      warn(`${source} cannot override reserved key "${k}"; ignoring`, warnings);
      delete attrs[k];
    }
  }
  return attrs;
}
__name(stripReservedResourceAttributes, "stripReservedResourceAttributes");
function coerceStringResourceAttributes(raw, warnings) {
  if (raw === null || raw === void 0) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warn(
      "settings.telemetry.resourceAttributes must be an object; ignoring",
      warnings
    );
    return {};
  }
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = k.trim();
    if (!key) {
      warn(
        "settings.telemetry.resourceAttributes has an empty or whitespace-only key; ignoring",
        warnings
      );
      continue;
    }
    if (typeof v === "string") {
      out[key] = v;
    } else {
      warn(
        `settings.telemetry.resourceAttributes value for "${key}" must be a string (got ${typeof v}); ignoring`,
        warnings
      );
    }
  }
  return out;
}
__name(coerceStringResourceAttributes, "coerceStringResourceAttributes");

// packages/core/src/telemetry/config.ts
function parseBooleanEnvFlag(value) {
  if (value === void 0) return void 0;
  return value === "true" || value === "1";
}
__name(parseBooleanEnvFlag, "parseBooleanEnvFlag");
function parseTelemetryTargetValue(value) {
  if (value === void 0) return void 0;
  if (value === "local" /* LOCAL */ || value === "local") {
    return "local" /* LOCAL */;
  }
  if (value === "gcp" /* GCP */ || value === "gcp") {
    return "gcp" /* GCP */;
  }
  return void 0;
}
__name(parseTelemetryTargetValue, "parseTelemetryTargetValue");
function parseSensitiveSpanAttributeMaxLengthEnvValue(envName, value) {
  if (value === void 0) return void 0;
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !isValidSensitiveSpanAttributeMaxLength(parsed)) {
    throw new FatalConfigError(
      `Invalid ${envName}: must be a positive integer no greater than ${SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT}, got '${value}'`
    );
  }
  return parsed;
}
__name(parseSensitiveSpanAttributeMaxLengthEnvValue, "parseSensitiveSpanAttributeMaxLengthEnvValue");
function parseSensitiveSpanAttributeMaxLengthSetting(settingName, value) {
  if (value === void 0) return void 0;
  if (typeof value !== "number" || !isValidSensitiveSpanAttributeMaxLength(value)) {
    throw new FatalConfigError(
      `Invalid ${settingName}: must be a positive integer no greater than ${SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT}, got ${String(
        value
      )}`
    );
  }
  return value;
}
__name(parseSensitiveSpanAttributeMaxLengthSetting, "parseSensitiveSpanAttributeMaxLengthSetting");
function parseTelemetryUserId(source, value) {
  if (value === void 0) return void 0;
  if (typeof value !== "string") {
    throw new FatalConfigError(
      `Invalid ${source}: must be a string, got ${typeof value}`
    );
  }
  return value.trim() || void 0;
}
__name(parseTelemetryUserId, "parseTelemetryUserId");
async function resolveTelemetrySettings(options) {
  const argv = options.argv ?? {};
  const env = options.env ?? {};
  const settings = options.settings ?? {};
  const enabled = argv.telemetry ?? parseBooleanEnvFlag(env["QWEN_TELEMETRY_ENABLED"]) ?? settings.enabled;
  const rawTarget = argv.telemetryTarget ?? env["QWEN_TELEMETRY_TARGET"] ?? settings.target;
  const target = parseTelemetryTargetValue(rawTarget);
  if (rawTarget !== void 0 && target === void 0) {
    throw new FatalConfigError(
      `Invalid telemetry target: ${String(
        rawTarget
      )}. Valid values are: local, gcp`
    );
  }
  const otlpEndpoint = argv.telemetryOtlpEndpoint ?? env["QWEN_TELEMETRY_OTLP_ENDPOINT"] ?? env["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? settings.otlpEndpoint;
  const rawProtocol = argv.telemetryOtlpProtocol ?? env["QWEN_TELEMETRY_OTLP_PROTOCOL"] ?? settings.otlpProtocol;
  const otlpProtocol = ["grpc", "http"].find(
    (p) => p === rawProtocol
  );
  if (rawProtocol !== void 0 && otlpProtocol === void 0) {
    throw new FatalConfigError(
      `Invalid telemetry OTLP protocol: ${String(
        rawProtocol
      )}. Valid values are: grpc, http`
    );
  }
  const logPrompts = argv.telemetryLogPrompts ?? parseBooleanEnvFlag(env["QWEN_TELEMETRY_LOG_PROMPTS"]) ?? settings.logPrompts;
  const userId = parseTelemetryUserId(
    "QWEN_TELEMETRY_USER_ID",
    env["QWEN_TELEMETRY_USER_ID"]
  ) ?? parseTelemetryUserId("telemetry.userId", settings.userId);
  const includeSensitiveSpanAttributes = parseBooleanEnvFlag(
    env["QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES"]
  ) ?? settings.includeSensitiveSpanAttributes ?? false;
  const sensitiveSpanAttributeMaxLength = parseSensitiveSpanAttributeMaxLengthEnvValue(
    "QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH",
    env["QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH"]
  ) ?? parseSensitiveSpanAttributeMaxLengthSetting(
    "telemetry.sensitiveSpanAttributeMaxLength",
    settings.sensitiveSpanAttributeMaxLength
  ) ?? DEFAULT_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH;
  const outfile = argv.telemetryOutfile ?? env["QWEN_TELEMETRY_OUTFILE"] ?? settings.outfile;
  const otlpTracesEndpoint = env["QWEN_TELEMETRY_OTLP_TRACES_ENDPOINT"] ?? env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] ?? settings.otlpTracesEndpoint;
  const otlpLogsEndpoint = env["QWEN_TELEMETRY_OTLP_LOGS_ENDPOINT"] ?? env["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"] ?? settings.otlpLogsEndpoint;
  const otlpMetricsEndpoint = env["QWEN_TELEMETRY_OTLP_METRICS_ENDPOINT"] ?? env["OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"] ?? settings.otlpMetricsEndpoint;
  const resourceAttributeWarnings = [];
  const envResourceAttrs = stripReservedResourceAttributes(
    parseOtelResourceAttributes(
      env["OTEL_RESOURCE_ATTRIBUTES"],
      resourceAttributeWarnings
    ),
    "OTEL_RESOURCE_ATTRIBUTES",
    resourceAttributeWarnings
  );
  const settingsResourceAttrs = stripReservedResourceAttributes(
    coerceStringResourceAttributes(
      settings.resourceAttributes,
      resourceAttributeWarnings
    ),
    "settings.telemetry.resourceAttributes",
    resourceAttributeWarnings
  );
  const mergedResourceAttrs = {
    ...envResourceAttrs,
    ...settingsResourceAttrs
  };
  const otelServiceName = env["OTEL_SERVICE_NAME"]?.trim();
  if (otelServiceName) {
    mergedResourceAttrs["service.name"] = otelServiceName;
  }
  const resourceAttributes = Object.keys(mergedResourceAttrs).length ? mergedResourceAttrs : void 0;
  const metricsIncludeSessionId = parseBooleanEnvFlag(env["QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID"]) ?? settings.metrics?.includeSessionId ?? false;
  return {
    enabled,
    target,
    otlpEndpoint,
    otlpProtocol,
    otlpTracesEndpoint,
    otlpLogsEndpoint,
    otlpMetricsEndpoint,
    logPrompts,
    userId,
    includeSensitiveSpanAttributes,
    sensitiveSpanAttributeMaxLength,
    outfile,
    resourceAttributes,
    metrics: { includeSessionId: metricsIncludeSessionId },
    resourceAttributeWarnings: resourceAttributeWarnings.length ? resourceAttributeWarnings : void 0
  };
}
__name(resolveTelemetrySettings, "resolveTelemetrySettings");

// packages/core/src/skills/types.ts
init_esbuild_shims();
function parseModelField(frontmatter) {
  const raw = frontmatter["model"];
  if (raw === void 0) {
    return void 0;
  }
  if (typeof raw !== "string") {
    throw new Error('"model" must be a string');
  }
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "inherit") {
    return void 0;
  }
  return trimmed;
}
__name(parseModelField, "parseModelField");
function parseUserInvocableField(frontmatter) {
  const raw = frontmatter["user-invocable"];
  if (raw === void 0) {
    return void 0;
  }
  if (raw === true || raw === "true") {
    return true;
  }
  if (raw === false || raw === "false") {
    return false;
  }
  return void 0;
}
__name(parseUserInvocableField, "parseUserInvocableField");
function parsePathsField(frontmatter) {
  const raw = frontmatter["paths"];
  if (raw === void 0 || raw === null) {
    return void 0;
  }
  if (!Array.isArray(raw)) {
    throw new Error('"paths" must be an array of glob patterns');
  }
  const cleaned = raw.map((p) => String(p).trim()).filter((p) => p.length > 0);
  for (const pattern of cleaned) {
    const normalized = pattern.replace(/\\/g, "/");
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
      throw new Error(
        `"paths" entry "${pattern}" looks absolute; patterns are project-root-relative \u2014 drop the leading slash / drive letter`
      );
    }
    const segments = normalized.split("/");
    if (segments.some((seg) => seg === "..")) {
      throw new Error(
        `"paths" entry "${pattern}" contains a ".." segment that escapes the project root; patterns must stay within the project`
      );
    }
  }
  return cleaned.length > 0 ? cleaned : void 0;
}
__name(parsePathsField, "parsePathsField");
var SKILL_NAME_PATTERN = /^[\p{L}\p{N}_:.-]+$/u;
function parseAllowedToolsField(frontmatter) {
  const raw = frontmatter["allowedTools"];
  if (raw == null) {
    return void 0;
  }
  if (!Array.isArray(raw)) {
    throw new Error('"allowedTools" must be an array');
  }
  return raw.map(String);
}
__name(parseAllowedToolsField, "parseAllowedToolsField");
function validateSkillName(name) {
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(
      `"name" must match ${SKILL_NAME_PATTERN} (letters, digits, _, :, ., -); got "${name}"`
    );
  }
}
__name(validateSkillName, "validateSkillName");
function qualifySkillName(extensionName, authoredName) {
  return `${extensionName}:${authoredName}`;
}
__name(qualifySkillName, "qualifySkillName");
function skillRestrictionNames(skill) {
  const { name, authoredName } = skill;
  const canonical = name.trim().toLowerCase();
  const authored = authoredName?.trim().toLowerCase();
  return authored && authored !== canonical ? [canonical, authored] : [canonical];
}
__name(skillRestrictionNames, "skillRestrictionNames");
function authoredSkillName(skill) {
  return skill.authoredName ?? skill.name;
}
__name(authoredSkillName, "authoredSkillName");
var SkillError = class extends Error {
  constructor(message, code, skillName) {
    super(message);
    this.code = code;
    this.skillName = skillName;
    this.name = "SkillError";
  }
  static {
    __name(this, "SkillError");
  }
};
var SkillErrorCode = {
  NOT_FOUND: "NOT_FOUND",
  INVALID_CONFIG: "INVALID_CONFIG",
  INVALID_NAME: "INVALID_NAME",
  FILE_ERROR: "FILE_ERROR",
  PARSE_ERROR: "PARSE_ERROR"
};

// packages/core/src/skills/skill-curator.ts
init_esbuild_shims();
var import_proper_lockfile = __toESM(require_proper_lockfile(), 1);
import * as fs2 from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path2 from "node:path";

// packages/core/src/utils/yaml-parser.ts
init_esbuild_shims();
var yaml = __toESM(require_dist(), 1);
var debugLogger2 = createDebugLogger("YAML_PARSER");
function parse2(yamlString) {
  try {
    const result = yaml.parse(yamlString, {
      schema: "core",
      // Belt-and-suspenders: filter timestamp/binary from schema tags.
      // The core schema doesn't include them, so this is a no-op in
      // practice — the real defense is in sanitizeValue() which catches
      // Date/Uint8Array from explicit !!tags that bypass schema filtering.
      customTags: /* @__PURE__ */ __name((tags) => tags.filter((tag) => {
        const uri = typeof tag === "string" ? tag : tag.tag;
        return uri !== "tag:yaml.org,2002:timestamp" && uri !== "tag:yaml.org,2002:binary" && uri !== "timestamp" && uri !== "binary";
      }), "customTags")
    });
    if (result && typeof result === "object" && !Array.isArray(result)) {
      return stripNullValues(result);
    }
    debugLogger2.warn(
      `Full YAML parser returned non-object (${typeof result}), falling back to simple parser`
    );
  } catch (error) {
    debugLogger2.warn(
      `Full YAML parser failed, falling back to simple parser: ${error}`
    );
  }
  return stripNullValues(parseSimple(yamlString));
}
__name(parse2, "parse");
function sanitizeValue(value) {
  if (value === null) {
    return void 0;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return stripNullValues(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue).filter((v) => v !== void 0);
  }
  return value;
}
__name(sanitizeValue, "sanitizeValue");
function stripNullValues(obj) {
  const cleaned = /* @__PURE__ */ Object.create(null);
  for (const [key, value] of Object.entries(obj)) {
    const sanitized = sanitizeValue(value);
    if (sanitized !== void 0) {
      cleaned[key] = sanitized;
    }
  }
  return cleaned;
}
__name(stripNullValues, "stripNullValues");
function parseSimple(yamlString) {
  const lines = yamlString.split("\n").filter((line) => line.trim() && !line.trim().startsWith("#"));
  const result = /* @__PURE__ */ Object.create(null);
  let currentKey = "";
  let currentArray = [];
  let inArray = false;
  let currentObject = /* @__PURE__ */ Object.create(null);
  let inObject = false;
  let objectKey = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("  - ")) {
      if (!inArray) {
        inArray = true;
        currentArray = [];
      }
      const itemRaw = line.substring(4).trim();
      currentArray.push(parseValue(itemRaw));
      continue;
    }
    if (inArray && !line.startsWith("  - ")) {
      result[currentKey] = currentArray;
      inArray = false;
      currentArray = [];
      currentKey = "";
    }
    if (line.startsWith("  ") && inObject) {
      const [key, ...valueParts] = line.trim().split(":");
      const value = valueParts.join(":").trim();
      currentObject[key.trim()] = parseValue(value);
      continue;
    }
    if (inObject && !line.startsWith("  ")) {
      result[objectKey] = currentObject;
      inObject = false;
      currentObject = /* @__PURE__ */ Object.create(null);
      objectKey = "";
    }
    if (line.includes(":")) {
      const [key, ...valueParts] = line.split(":");
      const value = valueParts.join(":").trim();
      if (value === "") {
        currentKey = key.trim();
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1];
          if (nextLine.startsWith("  - ")) {
            continue;
          } else if (nextLine.startsWith("  ")) {
            inObject = true;
            objectKey = currentKey;
            currentObject = /* @__PURE__ */ Object.create(null);
            currentKey = "";
            continue;
          }
        }
      } else {
        result[key.trim()] = parseValue(value);
      }
    }
  }
  if (inArray) {
    result[currentKey] = currentArray;
  }
  if (inObject) {
    result[objectKey] = currentObject;
  }
  return result;
}
__name(parseSimple, "parseSimple");
function stringify2(obj, options) {
  return yaml.stringify(obj, {
    lineWidth: options?.lineWidth ?? 0,
    minContentWidth: options?.minContentWidth ?? 20
  });
}
__name(stringify2, "stringify");
function parseValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value === "") return "";
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    const unquoted = value.slice(1, -1);
    return unquoted.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  const num = Number(value);
  if (!isNaN(num) && isFinite(num)) {
    return num;
  }
  return value;
}
__name(parseValue, "parseValue");

// packages/core/src/skills/skill-paths.ts
init_esbuild_shims();
import * as path from "node:path";
import * as fs from "node:fs/promises";
var PROJECT_SKILLS_RELATIVE_DIR = path.join(".qwen", "skills");
var ARCHIVED_SKILLS_RELATIVE_DIR = path.join(
  ".qwen",
  "archived-skills"
);
var SKILL_FILE_NAME = "SKILL.md";
function getProjectSkillsRoot(projectRoot) {
  return path.join(projectRoot, PROJECT_SKILLS_RELATIVE_DIR);
}
__name(getProjectSkillsRoot, "getProjectSkillsRoot");
function getArchivedSkillsRoot(projectRoot) {
  return path.join(projectRoot, ARCHIVED_SKILLS_RELATIVE_DIR);
}
__name(getArchivedSkillsRoot, "getArchivedSkillsRoot");
var PENDING_SKILLS_RELATIVE_DIR = path.join(".qwen", "pending-skills");
function getPendingSkillsRoot(projectRoot) {
  return path.join(projectRoot, PENDING_SKILLS_RELATIVE_DIR);
}
__name(getPendingSkillsRoot, "getPendingSkillsRoot");
function isProjectSkillPath(filePath, projectRoot) {
  const skillsRoot = path.resolve(getProjectSkillsRoot(projectRoot));
  const resolved = path.resolve(projectRoot, filePath);
  return resolved === skillsRoot || resolved.startsWith(skillsRoot + path.sep);
}
__name(isProjectSkillPath, "isProjectSkillPath");
function assertProjectSkillPath(targetPath, projectRoot) {
  if (!isProjectSkillPath(targetPath, projectRoot)) {
    throw new Error(
      `Skills writes are restricted to ${getProjectSkillsRoot(projectRoot)}. Use the Skills UI to manage user or bundled skills.`
    );
  }
}
__name(assertProjectSkillPath, "assertProjectSkillPath");
async function assertRealProjectSkillPath(targetPath, projectRoot) {
  assertProjectSkillPath(targetPath, projectRoot);
  const skillsRoot = getProjectSkillsRoot(projectRoot);
  let realSkillsRoot;
  try {
    realSkillsRoot = await fs.realpath(skillsRoot);
  } catch {
    return;
  }
  let check = targetPath;
  for (; ; ) {
    try {
      const real = await fs.realpath(check);
      if (real !== realSkillsRoot && !real.startsWith(realSkillsRoot + path.sep)) {
        throw new Error(
          `Skills write blocked: symlink traversal detected \u2014 resolved path "${real}" is outside the project skills directory "${realSkillsRoot}".`
        );
      }
      return;
    } catch (err) {
      if (err.code === "ENOENT") {
        try {
          const lstatResult = await fs.lstat(check);
          if (lstatResult.isSymbolicLink()) {
            throw new Error(
              `Skills write blocked: dangling symlink detected at "${check}".`
            );
          }
        } catch (lstatErr) {
          if (lstatErr.code !== "ENOENT") {
            throw lstatErr;
          }
        }
        const parent = path.dirname(check);
        if (parent === check) {
          return;
        }
        check = parent;
        continue;
      }
      throw err;
    }
  }
}
__name(assertRealProjectSkillPath, "assertRealProjectSkillPath");

// packages/core/src/skills/skill-curator.ts
var AUTO_SKILL_CURATOR_INTERVAL_MS = 7 * 24 * 60 * 60 * 1e3;
var AUTO_SKILL_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1e3;
var AUTO_SKILL_ARCHIVE_AFTER_MS = 90 * 24 * 60 * 60 * 1e3;
var debugLogger3 = createDebugLogger("SKILL_CURATOR");
var AUTO_SKILL_PREFIX = "auto-skill-";
var CURATOR_STATE_VERSION = 1;
var CURATOR_STATE_FILE = "skill-curator.json";
var CURATOR_LOCK_FILE = "skill-curator.lock";
var MAX_STATE_FILE_BYTES = 1024 * 1024;
var MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
function noFollowReadFlags() {
  return (fsConstants.O_RDONLY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
}
__name(noFollowReadFlags, "noFollowReadFlags");
async function readRegularFileNoFollow(filePath, maxBytes) {
  const handle = await fs2.open(filePath, noFollowReadFlags());
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(
        `Auto-skill curator refuses unsafe path ${filePath} (not a regular file).`
      );
    }
    if (stat.size > maxBytes) {
      throw new Error(`Auto-skill curator file too large at ${filePath}.`);
    }
    const content = await handle.readFile("utf8");
    return { content, stat };
  } finally {
    await handle.close().catch(() => {
    });
  }
}
__name(readRegularFileNoFollow, "readRegularFileNoFollow");
var LOCK_OPTIONS = {
  realpath: false,
  retries: {
    retries: 8,
    minTimeout: 25,
    maxTimeout: 500,
    factor: 2,
    randomize: true
  },
  stale: 1e4,
  onCompromised: /* @__PURE__ */ __name((err) => {
    debugLogger3.warn("skill curator lock compromised:", err);
  }, "onCompromised")
};
function getCuratorPaths(projectRoot) {
  const qwenRoot = path2.join(projectRoot, QWEN_DIR);
  return {
    qwenRoot,
    skillsRoot: getProjectSkillsRoot(projectRoot),
    archiveRoot: getArchivedSkillsRoot(projectRoot),
    statePath: path2.join(qwenRoot, CURATOR_STATE_FILE),
    lockPath: path2.join(qwenRoot, CURATOR_LOCK_FILE)
  };
}
__name(getCuratorPaths, "getCuratorPaths");
function emptyState() {
  return { version: CURATOR_STATE_VERSION, skills: /* @__PURE__ */ Object.create(null) };
}
__name(emptyState, "emptyState");
function isMissing(error) {
  return error != null && typeof error === "object" && error.code === "ENOENT";
}
__name(isMissing, "isMissing");
function parseTimestamp(value) {
  if (typeof value !== "string") return void 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : void 0;
}
__name(parseTimestamp, "parseTimestamp");
function requireTimestamp(value, field) {
  if (parseTimestamp(value) === void 0) {
    throw new Error(`Invalid auto-skill curator state: ${field} is invalid.`);
  }
  return value;
}
__name(requireTimestamp, "requireTimestamp");
function parseState(raw, statePath) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid auto-skill curator state at ${statePath}.`);
  }
  const input = raw;
  if (input["version"] !== CURATOR_STATE_VERSION) {
    throw new Error(
      `Unsupported auto-skill curator state version at ${statePath}.`
    );
  }
  const rawSkills = input["skills"];
  if (!rawSkills || typeof rawSkills !== "object" || Array.isArray(rawSkills)) {
    throw new Error(`Invalid auto-skill curator state at ${statePath}.`);
  }
  const skills = /* @__PURE__ */ Object.create(null);
  for (const [directoryName, value] of Object.entries(rawSkills)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(
        `Invalid auto-skill curator record for ${directoryName}.`
      );
    }
    const record = value;
    const state = record["state"];
    if (state !== "active" && state !== "stale" && state !== "archived") {
      throw new Error(
        `Invalid auto-skill curator record for ${directoryName}.`
      );
    }
    const skillName = record["skillName"];
    const useCount = record["useCount"];
    const pinned = record["pinned"];
    if (typeof skillName !== "string" || !Number.isInteger(useCount) || useCount < 0 || pinned !== void 0 && typeof pinned !== "boolean") {
      throw new Error(
        `Invalid auto-skill curator record for ${directoryName}.`
      );
    }
    skills[directoryName] = {
      skillName,
      firstSeenAt: requireTimestamp(
        record["firstSeenAt"],
        `${directoryName}.firstSeenAt`
      ),
      lastActivityAt: requireTimestamp(
        record["lastActivityAt"],
        `${directoryName}.lastActivityAt`
      ),
      useCount,
      state,
      pinned: pinned ?? false,
      ...record["lastUsedAt"] !== void 0 ? {
        lastUsedAt: requireTimestamp(
          record["lastUsedAt"],
          `${directoryName}.lastUsedAt`
        )
      } : {},
      ...record["archivedAt"] !== void 0 ? {
        archivedAt: requireTimestamp(
          record["archivedAt"],
          `${directoryName}.archivedAt`
        )
      } : {}
    };
  }
  return {
    version: CURATOR_STATE_VERSION,
    skills,
    ...input["lastRunAt"] !== void 0 ? { lastRunAt: requireTimestamp(input["lastRunAt"], "lastRunAt") } : {}
  };
}
__name(parseState, "parseState");
async function readState(statePath) {
  let stat;
  try {
    stat = await fs2.lstat(statePath);
  } catch (error) {
    if (isMissing(error)) return emptyState();
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Auto-skill curator refuses unsafe path ${statePath}.`);
  }
  if (stat.size > MAX_STATE_FILE_BYTES) {
    throw new Error(`Invalid auto-skill curator state at ${statePath}.`);
  }
  let content;
  try {
    ({ content } = await readRegularFileNoFollow(
      statePath,
      MAX_STATE_FILE_BYTES
    ));
  } catch (error) {
    if (isMissing(error)) return emptyState();
    throw new Error(`Auto-skill curator refuses unsafe path ${statePath}.`, {
      cause: error
    });
  }
  try {
    return parseState(JSON.parse(content), statePath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid auto-skill curator state at ${statePath}.`);
    }
    throw error;
  }
}
__name(readState, "readState");
function parseAutoSkillName(content) {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(
    content
  );
  if (!match) return void 0;
  const frontmatter = parse2(match[1]);
  if (frontmatter["source"] !== "auto-skill") return void 0;
  const name = frontmatter["name"];
  if (typeof name !== "string") return void 0;
  try {
    validateSkillName(name);
  } catch {
    return void 0;
  }
  return name;
}
__name(parseAutoSkillName, "parseAutoSkillName");
function isManagedDirectoryName(directoryName) {
  return directoryName.startsWith(AUTO_SKILL_PREFIX) && path2.basename(directoryName) === directoryName && // Restrict to the skill-name charset (letters, digits, _ : . -). A managed
  // directory is always `auto-skill-<name>` where `<name>` passes
  // validateSkillName and the prefix chars are within the same set, so this
  // never rejects a legitimately generated directory. It does reject names
  // carrying ANSI/control bytes, whose `directoryName` is later printed
  // verbatim by the non-interactive `/curator` output (which, unlike the TUI,
  // does not run escapeAnsiCtrlCodes) — closing a terminal control-sequence
  // injection via a crafted directory committed to a cloned repo.
  SKILL_NAME_PATTERN.test(directoryName);
}
__name(isManagedDirectoryName, "isManagedDirectoryName");
async function readManagedSkill(root, directoryName) {
  if (!isManagedDirectoryName(directoryName)) return void 0;
  const directoryPath = path2.join(root, directoryName);
  const manifestPath = path2.join(directoryPath, SKILL_FILE_NAME);
  try {
    const directoryStat = await fs2.lstat(directoryPath);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      return void 0;
    }
    const { content, stat: manifestStat } = await readRegularFileNoFollow(
      manifestPath,
      MAX_MANIFEST_BYTES
    );
    const skillName = parseAutoSkillName(content);
    if (!skillName) return void 0;
    return {
      directoryName,
      skillName,
      directoryPath,
      manifestPath,
      modifiedAt: manifestStat.mtime.toISOString()
    };
  } catch {
    return void 0;
  }
}
__name(readManagedSkill, "readManagedSkill");
async function scanManagedSkills(root) {
  let entries;
  try {
    const rootStat = await fs2.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`Auto-skill curator refuses unsafe path ${root}.`);
    }
    entries = await fs2.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const skills = await Promise.all(
    entries.filter(
      (entry) => entry.isDirectory() && isManagedDirectoryName(entry.name)
    ).map((entry) => readManagedSkill(root, entry.name))
  );
  return skills.filter((skill) => skill !== void 0).sort((a, b) => a.directoryName.localeCompare(b.directoryName));
}
__name(scanManagedSkills, "scanManagedSkills");
async function ensureSafeQwenRoot(paths) {
  await fs2.mkdir(paths.qwenRoot, { recursive: true });
  const stat = await fs2.lstat(paths.qwenRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `Auto-skill curator refuses unsafe path ${paths.qwenRoot}.`
    );
  }
}
__name(ensureSafeQwenRoot, "ensureSafeQwenRoot");
async function ensureSafeDirectory(directory) {
  await fs2.mkdir(directory, { recursive: true });
  const stat = await fs2.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Auto-skill curator refuses unsafe path ${directory}.`);
  }
}
__name(ensureSafeDirectory, "ensureSafeDirectory");
async function withCuratorLock(projectRoot, operation) {
  const paths = getCuratorPaths(projectRoot);
  await ensureSafeQwenRoot(paths);
  const release = await import_proper_lockfile.default.lock(paths.lockPath, LOCK_OPTIONS);
  try {
    return await operation(paths);
  } finally {
    try {
      await release();
    } catch {
    }
  }
}
__name(withCuratorLock, "withCuratorLock");
function recordForSkill(state, skill, firstSeenAt = skill.modifiedAt) {
  const existing = state.skills[skill.directoryName];
  if (existing) {
    existing.skillName = skill.skillName;
    return existing;
  }
  const record = {
    skillName: skill.skillName,
    firstSeenAt,
    lastActivityAt: firstSeenAt,
    useCount: 0,
    state: "active",
    pinned: false
  };
  state.skills[skill.directoryName] = record;
  return record;
}
__name(recordForSkill, "recordForSkill");
function lastActivityMs(skill, record, nowMs) {
  const mtimeMs = parseTimestamp(skill.modifiedAt) ?? 0;
  return Math.max(
    mtimeMs <= nowMs ? mtimeMs : 0,
    parseTimestamp(record.firstSeenAt) ?? 0,
    parseTimestamp(record.lastActivityAt) ?? 0,
    parseTimestamp(record.lastUsedAt) ?? 0
  );
}
__name(lastActivityMs, "lastActivityMs");
function entryFor(skill, record, state, nowMs) {
  return {
    directoryName: skill.directoryName,
    skillName: skill.skillName,
    state,
    lastActivityAt: new Date(
      lastActivityMs(skill, record, nowMs)
    ).toISOString(),
    useCount: record.useCount,
    pinned: record.pinned
  };
}
__name(entryFor, "entryFor");
async function rollbackMoves(moved) {
  const errors = [];
  for (const move of [...moved].reverse()) {
    try {
      await fs2.rename(move.destination, move.source);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}
__name(rollbackMoves, "rollbackMoves");
async function runLocked(paths, state, now) {
  const skills = await scanManagedSkills(paths.skillsRoot);
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const result = {
    dryRun: false,
    checked: skills.length,
    seeded: [],
    markedStale: [],
    reactivated: [],
    archived: [],
    skippedCollisions: [],
    skippedErrors: []
  };
  const moved = [];
  try {
    for (const scanned of skills) {
      const existing = state.skills[scanned.directoryName];
      const record = recordForSkill(state, scanned, nowIso);
      if (!existing) {
        result.seeded.push(scanned.directoryName);
        continue;
      }
      if (record.pinned) continue;
      const inactivityMs = nowMs - lastActivityMs(scanned, record, nowMs);
      if (inactivityMs >= AUTO_SKILL_ARCHIVE_AFTER_MS) {
        const current = await readManagedSkill(
          paths.skillsRoot,
          scanned.directoryName
        );
        if (!current) continue;
        const currentInactivityMs = nowMs - lastActivityMs(current, record, nowMs);
        if (currentInactivityMs < AUTO_SKILL_ARCHIVE_AFTER_MS) {
          if (currentInactivityMs >= AUTO_SKILL_STALE_AFTER_MS) {
            if (record.state !== "stale") {
              record.state = "stale";
              delete record.archivedAt;
              result.markedStale.push(scanned.directoryName);
            }
          } else if (record.state !== "active") {
            record.state = "active";
            delete record.archivedAt;
            result.reactivated.push(scanned.directoryName);
          }
          continue;
        }
        await ensureSafeDirectory(paths.archiveRoot);
        const destination = path2.join(paths.archiveRoot, scanned.directoryName);
        try {
          await fs2.lstat(destination);
          result.skippedCollisions.push(scanned.directoryName);
          continue;
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        try {
          await fs2.rename(current.directoryPath, destination);
        } catch {
          result.skippedErrors.push(scanned.directoryName);
          continue;
        }
        moved.push({ source: current.directoryPath, destination });
        record.state = "archived";
        record.archivedAt = nowIso;
        result.archived.push(scanned.directoryName);
      } else if (inactivityMs >= AUTO_SKILL_STALE_AFTER_MS) {
        if (record.state !== "stale") {
          record.state = "stale";
          delete record.archivedAt;
          result.markedStale.push(scanned.directoryName);
        }
      } else if (record.state !== "active") {
        record.state = "active";
        delete record.archivedAt;
        result.reactivated.push(scanned.directoryName);
      }
    }
    const listDirs = /* @__PURE__ */ __name(async (root) => {
      try {
        const entries = await fs2.readdir(root, { withFileTypes: true });
        return new Set(
          entries.filter((e) => e.isDirectory()).map((e) => e.name)
        );
      } catch {
        return /* @__PURE__ */ new Set();
      }
    }, "listDirs");
    const [liveDirs, archiveDirs] = await Promise.all([
      listDirs(paths.skillsRoot),
      listDirs(paths.archiveRoot)
    ]);
    for (const dirName of Object.keys(state.skills)) {
      if (!liveDirs.has(dirName) && !archiveDirs.has(dirName)) {
        delete state.skills[dirName];
      }
    }
    state.lastRunAt = nowIso;
    await atomicWriteJSON(paths.statePath, state, {
      mode: 384,
      noFollow: true
    });
    return result;
  } catch (error) {
    const rollbackErrors = await rollbackMoves(moved);
    if (rollbackErrors.length > 0) {
      throw new Error(`Rollback failed: ${rollbackErrors.join("; ")}`, {
        cause: error
      });
    }
    throw error;
  }
}
__name(runLocked, "runLocked");
async function previewRun(projectRoot, now) {
  const paths = getCuratorPaths(projectRoot);
  const [state, skills] = await Promise.all([
    readState(paths.statePath),
    scanManagedSkills(paths.skillsRoot)
  ]);
  const result = {
    dryRun: true,
    checked: skills.length,
    seeded: [],
    markedStale: [],
    reactivated: [],
    archived: [],
    skippedCollisions: [],
    skippedErrors: []
  };
  const nowMs = now.getTime();
  for (const skill of skills) {
    const existing = state.skills[skill.directoryName];
    if (!existing) {
      result.seeded.push(skill.directoryName);
      continue;
    }
    const record = recordForSkill(state, skill);
    if (record.pinned) continue;
    const inactivityMs = nowMs - lastActivityMs(skill, record, nowMs);
    if (inactivityMs >= AUTO_SKILL_ARCHIVE_AFTER_MS) {
      try {
        await fs2.lstat(path2.join(paths.archiveRoot, skill.directoryName));
        result.skippedCollisions.push(skill.directoryName);
      } catch (error) {
        if (!isMissing(error)) throw error;
        result.archived.push(skill.directoryName);
      }
    } else if (inactivityMs >= AUTO_SKILL_STALE_AFTER_MS && record.state !== "stale") {
      result.markedStale.push(skill.directoryName);
    } else if (inactivityMs < AUTO_SKILL_STALE_AFTER_MS && record.state !== "active") {
      result.reactivated.push(skill.directoryName);
    }
  }
  return result;
}
__name(previewRun, "previewRun");
async function runAutoSkillCurator(projectRoot, options = {}) {
  const now = options.now ?? /* @__PURE__ */ new Date();
  if (options.dryRun) return previewRun(projectRoot, now);
  return withCuratorLock(
    projectRoot,
    async (paths) => runLocked(paths, await readState(paths.statePath), now)
  );
}
__name(runAutoSkillCurator, "runAutoSkillCurator");
async function maybeRunAutoSkillCurator(projectRoot, now = /* @__PURE__ */ new Date()) {
  const paths = getCuratorPaths(projectRoot);
  const unlocked = await readState(paths.statePath);
  if (unlocked.lastRunAt) {
    const lastRunMs = parseTimestamp(unlocked.lastRunAt);
    if (now.getTime() - lastRunMs < AUTO_SKILL_CURATOR_INTERVAL_MS) {
      return { status: "not_due" };
    }
  }
  return withCuratorLock(projectRoot, async (lockedPaths) => {
    const state = await readState(lockedPaths.statePath);
    if (!state.lastRunAt) {
      const nowIso = now.toISOString();
      const skills = await scanManagedSkills(lockedPaths.skillsRoot);
      if (skills.length === 0 && Object.keys(state.skills).length === 0) {
        return { status: "seeded", checked: 0 };
      }
      for (const skill of skills) {
        const existing = state.skills[skill.directoryName];
        state.skills[skill.directoryName] = {
          skillName: skill.skillName,
          // Preserve an existing baseline the way useCount/pinned/lastUsedAt are
          // preserved below: if recordAutoSkillUsage already created a record
          // before this first curator run, overwriting firstSeenAt/
          // lastActivityAt with `now` would reset the inactivity clock and delay
          // the stale transition. A brand-new skill still gets a fresh `now`
          // baseline (never the old manifest mtime), keeping first-sight grace.
          firstSeenAt: existing?.firstSeenAt ?? nowIso,
          lastActivityAt: existing?.lastActivityAt ?? nowIso,
          useCount: existing?.useCount ?? 0,
          state: "active",
          pinned: existing?.pinned ?? false,
          ...existing?.lastUsedAt ? { lastUsedAt: existing.lastUsedAt } : {}
        };
      }
      state.lastRunAt = nowIso;
      await atomicWriteJSON(lockedPaths.statePath, state, {
        mode: 384,
        noFollow: true
      });
      return { status: "seeded", checked: skills.length };
    }
    const lastRunMs = parseTimestamp(state.lastRunAt);
    if (now.getTime() - lastRunMs < AUTO_SKILL_CURATOR_INTERVAL_MS) {
      return { status: "not_due" };
    }
    return {
      status: "ran",
      result: await runLocked(lockedPaths, state, now)
    };
  });
}
__name(maybeRunAutoSkillCurator, "maybeRunAutoSkillCurator");
async function recordAutoSkillUsage(projectRoot, skill, now = /* @__PURE__ */ new Date()) {
  if (skill.level !== "project") return false;
  const paths = getCuratorPaths(projectRoot);
  const resolvedManifestPath = path2.resolve(skill.filePath);
  const directoryPath = path2.dirname(resolvedManifestPath);
  if (path2.dirname(directoryPath) !== path2.resolve(paths.skillsRoot)) {
    return false;
  }
  const directoryName = path2.basename(directoryPath);
  const candidate = await readManagedSkill(paths.skillsRoot, directoryName);
  if (!candidate || candidate.manifestPath !== resolvedManifestPath) {
    return false;
  }
  return withCuratorLock(projectRoot, async (lockedPaths) => {
    const managed = await readManagedSkill(
      lockedPaths.skillsRoot,
      directoryName
    );
    if (!managed || managed.manifestPath !== resolvedManifestPath) {
      return false;
    }
    const state = await readState(lockedPaths.statePath);
    const nowIso = now.toISOString();
    const record = recordForSkill(state, managed, nowIso);
    record.lastActivityAt = nowIso;
    record.lastUsedAt = nowIso;
    record.useCount += 1;
    record.state = "active";
    delete record.archivedAt;
    await atomicWriteJSON(lockedPaths.statePath, state, {
      mode: 384,
      noFollow: true
    });
    return true;
  });
}
__name(recordAutoSkillUsage, "recordAutoSkillUsage");
async function setAutoSkillPinned(projectRoot, directoryName, pinned, now = /* @__PURE__ */ new Date()) {
  if (!isManagedDirectoryName(directoryName)) {
    throw new Error(
      `Managed auto-skill not found: ${JSON.stringify(directoryName)}.`
    );
  }
  await withCuratorLock(projectRoot, async (paths) => {
    const managed = await readManagedSkill(paths.skillsRoot, directoryName);
    if (!managed) {
      throw new Error(`Managed auto-skill not found: ${directoryName}.`);
    }
    const state = await readState(paths.statePath);
    const record = recordForSkill(state, managed, now.toISOString());
    record.pinned = pinned;
    await atomicWriteJSON(paths.statePath, state, {
      mode: 384,
      noFollow: true
    });
  });
}
__name(setAutoSkillPinned, "setAutoSkillPinned");
async function getAutoSkillCuratorStatus(projectRoot, now = /* @__PURE__ */ new Date()) {
  const paths = getCuratorPaths(projectRoot);
  const [state, liveSkills, archivedSkills] = await Promise.all([
    readState(paths.statePath),
    scanManagedSkills(paths.skillsRoot),
    scanManagedSkills(paths.archiveRoot)
  ]);
  const status = {
    lastRunAt: state.lastRunAt,
    active: [],
    stale: [],
    archived: []
  };
  const nowMs = now.getTime();
  for (const skill of liveSkills) {
    const record = recordForSkill(state, skill, now.toISOString());
    const inactivityMs = nowMs - lastActivityMs(skill, record, nowMs);
    const effectiveState = record.pinned ? record.state === "stale" ? "stale" : "active" : inactivityMs >= AUTO_SKILL_STALE_AFTER_MS ? "stale" : "active";
    status[effectiveState].push(entryFor(skill, record, effectiveState, nowMs));
  }
  const liveNames = new Set(liveSkills.map((s) => s.directoryName));
  for (const skill of archivedSkills) {
    if (liveNames.has(skill.directoryName)) continue;
    const record = recordForSkill(state, skill);
    status.archived.push(entryFor(skill, record, "archived", nowMs));
  }
  return status;
}
__name(getAutoSkillCuratorStatus, "getAutoSkillCuratorStatus");
async function restoreArchivedAutoSkill(projectRoot, directoryName, now = /* @__PURE__ */ new Date()) {
  await withCuratorLock(projectRoot, async (paths) => {
    if (!isManagedDirectoryName(directoryName)) {
      throw new Error(
        `Archived auto-skill not found: ${JSON.stringify(directoryName)}.`
      );
    }
    const archiveRootStat = await fs2.lstat(paths.archiveRoot).catch((error) => {
      if (isMissing(error)) return void 0;
      throw error;
    });
    if (!archiveRootStat) {
      throw new Error(`Archived auto-skill not found: ${directoryName}.`);
    }
    if (!archiveRootStat.isDirectory() || archiveRootStat.isSymbolicLink()) {
      throw new Error(
        `Auto-skill curator refuses unsafe path ${paths.archiveRoot}.`
      );
    }
    const archived = await readManagedSkill(paths.archiveRoot, directoryName);
    if (!archived) {
      let directoryExists = true;
      try {
        await fs2.lstat(path2.join(paths.archiveRoot, directoryName));
      } catch (error) {
        if (!isMissing(error)) throw error;
        directoryExists = false;
      }
      throw new Error(
        directoryExists ? `Archived auto-skill ${directoryName} is not an eligible managed skill.` : `Archived auto-skill not found: ${directoryName}.`
      );
    }
    const destination = path2.join(paths.skillsRoot, directoryName);
    try {
      await fs2.lstat(destination);
      throw new Error(
        `Cannot restore ${directoryName}: an active directory already exists.`
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await ensureSafeDirectory(paths.skillsRoot);
    const state = await readState(paths.statePath);
    const record = recordForSkill(state, archived);
    record.state = "active";
    record.lastActivityAt = now.toISOString();
    delete record.archivedAt;
    await fs2.rename(archived.directoryPath, destination);
    try {
      await atomicWriteJSON(paths.statePath, state, {
        mode: 384,
        noFollow: true
      });
    } catch (error) {
      try {
        await fs2.rename(destination, archived.directoryPath);
      } catch (rollbackError) {
        throw new Error(
          `Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          { cause: error }
        );
      }
      throw error;
    }
  });
}
__name(restoreArchivedAutoSkill, "restoreArchivedAutoSkill");

export {
  parseBooleanEnvFlag,
  resolveTelemetrySettings,
  TERMINAL_OSC_REGEX,
  TERMINAL_CSI_REGEX,
  TERMINAL_SHIFT_DCS_REGEX,
  stripTerminalControlSequences,
  isBidiControlChar,
  stripDisplayControlChars,
  truncateNotificationLabel,
  GOAL_STATE_VERSION,
  GOAL_PROPOSAL_REASON_MAX_CHARACTERS,
  GOAL_CHECKPOINT_CLAIM_LIMIT,
  GOAL_CHECKPOINT_CLAIM_MAX_CHARACTERS,
  GOAL_CHECKPOINT_CLAIM_MAX_BYTES,
  GOAL_CHECKPOINT_SOURCE_REFERENCE_LIMIT,
  GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON,
  GOAL_CHECKPOINT_REQUEST_TOO_LARGE_REASON,
  GOAL_CHECKPOINT_STALL_LIMIT,
  GOAL_NO_PROGRESS_TURN_LIMIT,
  goalCheckpointStalledReason,
  capGoalCheckpointFailure,
  GOAL_DEFAULT_TOKEN_BUDGET,
  goalTokenBudgetReason,
  isGoalTokenBudgetSpent,
  goalTurnBudgetReason,
  isGoalTurnBudgetSpent,
  goalActiveTimeBudgetReason,
  isGoalActiveTimeBudgetSpent,
  PAUSED_GOAL_SYSTEM_REMINDER,
  isGoalEvidenceProofKind,
  emptyGoalSnapshot,
  goalRequiresExactPermit,
  isRepeatedBlockerProposal,
  GOAL_INFEASIBLE_NEXT_STEP,
  validateGoalProposalReason,
  GOAL_PAUSE_REASON_USER_INTERRUPT,
  GOAL_PAUSE_REASON_COMMAND,
  GOAL_PAUSE_REASON_SESSION_TOKEN_LIMIT,
  GOAL_PAUSE_REASON_STOP_HOOK_CAP,
  GOAL_PAUSE_REASON_SESSION_DISPOSED,
  GOAL_PAUSE_REASON_HEADLESS_RUN_ENDED,
  GOAL_PAUSE_REASON_NO_PROGRESS,
  goalPauseReasonForFailure,
  goalPauseReasonForVerifierFailure,
  goalPauseReasonForHeadlessFailure,
  goalPauseReasonForRunBudget,
  reduceGoalSpend,
  GoalConflictError,
  GoalInvalidTransitionError,
  elapsedActiveTime,
  reduceGoalControl,
  reduceGoalTurnFinished,
  parseGoalControlRequest,
  parseGoalStateRecordPayloadV2,
  parseGoalSnapshotV2,
  parseGoalStateCause,
  goalStateEventFromSnapshot,
  initializeDaemonMetrics,
  registerDaemonGaugeCallbacks,
  recordDaemonHttpRequest,
  recordDaemonSessionLifecycle,
  recordDaemonChannelLifecycle,
  recordDaemonPromptQueueWait,
  recordDaemonPromptDuration,
  recordDaemonBridgeError,
  recordDaemonCancel,
  recordDaemonPipeMessage,
  startEventLoopLagMonitor,
  registerDaemonEventLoopLagGauge,
  registerAcpEventLoopLagGauge,
  areSensitiveSpanAttributesEnabled,
  addAgentInputMessageAttributes,
  addAgentOutputMessageAttributes,
  AgentOutputMessageCapture,
  addUserPromptAttributes,
  addToolArgumentsAttributes,
  addToolCallResultAttributes,
  DEFAULT_TELEMETRY_TARGET,
  DEFAULT_OTLP_ENDPOINT,
  require_dist,
  SKILL_FILE_NAME,
  getProjectSkillsRoot,
  getArchivedSkillsRoot,
  getPendingSkillsRoot,
  isProjectSkillPath,
  assertRealProjectSkillPath,
  parseModelField,
  parseUserInvocableField,
  parsePathsField,
  SKILL_NAME_PATTERN,
  parseAllowedToolsField,
  validateSkillName,
  qualifySkillName,
  skillRestrictionNames,
  authoredSkillName,
  SkillError,
  SkillErrorCode,
  parse2 as parse,
  stringify2 as stringify,
  runAutoSkillCurator,
  maybeRunAutoSkillCurator,
  recordAutoSkillUsage,
  setAutoSkillPinned,
  getAutoSkillCuratorStatus,
  restoreArchivedAutoSkill
};
/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
