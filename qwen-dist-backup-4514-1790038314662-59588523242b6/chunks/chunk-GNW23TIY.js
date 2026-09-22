// Force strict mode and setup for ESM
"use strict";
import {
  getErrorMessage
} from "./chunk-6OHXRCXH.js";
import {
  extensionToOutputString,
  getExtensionManager
} from "./chunk-J6B373DZ.js";
import {
  loadSettings
} from "./chunk-DRYBBTI5.js";
import {
  initializeI18n,
  resolveLanguageSetting,
  t
} from "./chunk-POMFSBEC.js";
import {
  writeStderrLine,
  writeStdoutLine
} from "./chunk-7FA2II6K.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/commands/extensions/list.ts
init_esbuild_shims();
async function handleList() {
  try {
    const settings = loadSettings();
    await initializeI18n(
      resolveLanguageSetting(settings.merged.general?.language)
    );
    const extensionManager = await getExtensionManager();
    const extensions = extensionManager.getLoadedExtensions();
    if (!extensions || extensions.length === 0) {
      writeStdoutLine(t("No extensions installed."));
      return;
    }
    writeStdoutLine(
      extensions.map(
        (extension, _) => extensionToOutputString(extension, extensionManager, process.cwd())
      ).join("\n\n")
    );
  } catch (error) {
    writeStderrLine(getErrorMessage(error));
    process.exit(1);
  }
}
__name(handleList, "handleList");
var listCommand = {
  command: "list",
  describe: t("Lists installed extensions."),
  builder: /* @__PURE__ */ __name((yargs) => yargs, "builder"),
  handler: /* @__PURE__ */ __name(async () => {
    await handleList();
  }, "handler")
};

export {
  handleList,
  listCommand
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
