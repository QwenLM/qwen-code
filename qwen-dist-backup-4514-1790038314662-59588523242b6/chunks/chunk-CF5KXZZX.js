// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/schemaConverter.ts
init_esbuild_shims();
function convertSchema(schema, mode = "auto") {
  if (mode === "openapi_30") {
    return toOpenAPI30(schema);
  }
  return schema;
}
__name(convertSchema, "convertSchema");
function toOpenAPI30(schema) {
  const convert = /* @__PURE__ */ __name((obj) => {
    if (typeof obj !== "object" || obj === null) {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(convert);
    }
    const source = obj;
    const target = {};
    if (Array.isArray(source["type"])) {
      const types = source["type"];
      if (types.length === 2 && types.includes("null")) {
        target["type"] = types.find((t) => t !== "null");
        target["nullable"] = true;
      } else {
        target["type"] = types.find((t) => t !== "null") ?? types[0];
        if (types.includes("null")) {
          target["nullable"] = true;
        }
      }
    } else if (source["type"] !== void 0) {
      target["type"] = source["type"];
    }
    if (source["const"] !== void 0) {
      target["enum"] = [String(source["const"])];
      delete target["const"];
    }
    if (typeof source["exclusiveMinimum"] === "number") {
      target["minimum"] = source["exclusiveMinimum"];
      target["exclusiveMinimum"] = true;
    }
    if (typeof source["exclusiveMaximum"] === "number") {
      target["maximum"] = source["exclusiveMaximum"];
      target["exclusiveMaximum"] = true;
    }
    if (Array.isArray(source["items"])) {
      delete target["items"];
    } else if (typeof source["items"] === "object" && source["items"] !== null) {
      target["items"] = convert(source["items"]);
    }
    if (Array.isArray(source["enum"])) {
      target["enum"] = source["enum"].map(String);
    }
    for (const [key, value] of Object.entries(source)) {
      if ((key === "properties" || key === "$defs" || key === "definitions") && typeof value === "object" && value !== null && !Array.isArray(value)) {
        const map = {};
        for (const [mapKey, mapValue] of Object.entries(
          value
        )) {
          map[mapKey] = convert(mapValue);
        }
        target[key] = map;
        continue;
      }
      if (key === "type" || key === "const" || key === "items" || key === "enum" || key === "$schema" || key === "$id" || key === "default" || // Optional: Gemini sometimes complains about defaults conflicting with types
      key === "dependencies" || key === "patternProperties") {
        continue;
      }
      if ((key === "exclusiveMinimum" || key === "exclusiveMaximum") && typeof value === "number") {
        continue;
      }
      target[key] = convert(value);
    }
    return target;
  }, "convert");
  return convert(schema);
}
__name(toOpenAPI30, "toOpenAPI30");
function relaxSchemaForFunctionCalling(schema, relaxGrammarConstraints = false) {
  const relax = /* @__PURE__ */ __name((obj) => {
    if (typeof obj !== "object" || obj === null) {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(relax);
    }
    const source = obj;
    const target = {};
    const properties = source["properties"];
    const required = Array.isArray(source["required"]) ? source["required"].filter(
      (r) => typeof r === "string"
    ) : [];
    const hasOptionalProperties = typeof properties === "object" && properties !== null && !Array.isArray(properties) && Object.keys(properties).some((key) => !required.includes(key));
    const hasEmptyProperties = typeof properties === "object" && properties !== null && !Array.isArray(properties) && Object.keys(properties).length === 0;
    const type = source["type"];
    const canBeObject = type === void 0 || type === "object" || Array.isArray(type) && type.includes("object");
    const hasNoDeclaredProperties = hasEmptyProperties || canBeObject && properties === void 0;
    for (const [key, value] of Object.entries(source)) {
      if (key === "$schema" || key === "$id" || key === "uniqueItems") {
        continue;
      }
      if (relaxGrammarConstraints && key === "properties" && hasEmptyProperties) {
        continue;
      }
      if (relaxGrammarConstraints && (key === "minLength" || key === "maxLength" || key === "minItems" || key === "maxItems") && typeof value === "number" && value >= 1999) {
        continue;
      }
      if (key === "additionalProperties" && value === false && (hasOptionalProperties || relaxGrammarConstraints && hasNoDeclaredProperties)) {
        continue;
      }
      if (key === "const" || key === "default" || key === "enum" || key === "example" || key === "examples") {
        target[key] = structuredClone(value);
        continue;
      }
      if ((key === "properties" || key === "patternProperties" || key === "$defs" || key === "definitions" || key === "dependencies" || key === "dependentSchemas" || key === "dependentRequired") && typeof value === "object" && value !== null && !Array.isArray(value)) {
        const map = {};
        for (const [mapKey, mapValue] of Object.entries(
          value
        )) {
          map[mapKey] = relax(mapValue);
        }
        target[key] = map;
        continue;
      }
      target[key] = relax(value);
    }
    return target;
  }, "relax");
  return relax(schema);
}
__name(relaxSchemaForFunctionCalling, "relaxSchemaForFunctionCalling");

export {
  convertSchema,
  relaxSchemaForFunctionCalling
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
