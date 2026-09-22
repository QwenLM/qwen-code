// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/commands/channel/cli-entry-path.ts
init_esbuild_shims();
import * as path from "node:path";
function findCliEntryPath() {
  const mainModule = process.argv[1];
  if (mainModule) {
    return path.resolve(mainModule);
  }
  throw new Error("Cannot determine CLI entry path");
}
__name(findCliEntryPath, "findCliEntryPath");

export {
  findCliEntryPath
};
