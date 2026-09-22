// Force strict mode and setup for ESM
"use strict";
import {
  generateImage
} from "./chunk-EVZT24AF.js";
import "./chunk-6C3D7BKK.js";
import "./chunk-KKPIFWTZ.js";
import "./chunk-NFC4WTY2.js";
import "./chunk-YSD6IY6F.js";
import "./chunk-MS4SXNJ6.js";
import {
  atomicWriteFile
} from "./chunk-CA63HYHU.js";
import "./chunk-SBP43AO6.js";
import {
  BaseDeclarativeTool,
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  Storage
} from "./chunk-ZYDMQCQP.js";
import {
  getErrorMessage
} from "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/image-gen.ts
init_esbuild_shims();
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
var MIN_TOTAL_PIXELS = 512 * 512;
var MAX_TOTAL_PIXELS = 2048 * 2048;
var MAX_PROMPT_CHARS = 1e4;
var ImageGenInvocation = class extends BaseToolInvocation {
  constructor(config, generateImage2, params) {
    super(params);
    this.config = config;
    this.generateImage = generateImage2;
    const sessionDir = Storage.sanitizePlanSessionId(config.getSessionId());
    this.outputPath = path.join(
      config.getTargetDir(),
      ".qwen",
      "generated-images",
      sessionDir,
      `${randomUUID()}.png`
    );
  }
  static {
    __name(this, "ImageGenInvocation");
  }
  outputPath;
  toolLocations() {
    return [{ path: this.outputPath }];
  }
  getDescription() {
    const imageConfig = this.config.getImageGenerationConfig();
    const size = this.params.size ? ` at ${this.params.size}` : "";
    return `Generate an image with ${imageConfig?.model ?? "the configured model"}${size}: ${this.params.prompt}`;
  }
  getDefaultPermission() {
    return Promise.resolve("ask");
  }
  async execute(signal) {
    const imageConfig = this.config.getImageGenerationConfig();
    if (!imageConfig) {
      return failureResult(
        "Image generation is not configured with a valid endpoint."
      );
    }
    const apiKey = process.env[imageConfig.apiKeyEnv]?.trim();
    if (!apiKey) {
      return failureResult(
        `Image generation requires the ${imageConfig.apiKeyEnv} environment variable.`
      );
    }
    try {
      signal.throwIfAborted();
      const outputDir = path.dirname(this.outputPath);
      Storage.assertPathWithinDirectory(
        outputDir,
        this.config.getTargetDir(),
        "Generated image path must stay inside the workspace."
      );
      await mkdir(outputDir, { recursive: true });
      Storage.assertPathWithinDirectory(
        outputDir,
        this.config.getTargetDir(),
        "Generated image path must stay inside the workspace."
      );
      signal.throwIfAborted();
      const generated = await this.generateImage({
        baseUrl: imageConfig.baseUrl,
        apiKey,
        model: imageConfig.model,
        prompt: this.params.prompt,
        size: this.params.size,
        signal
      });
      signal.throwIfAborted();
      Storage.assertPathWithinDirectory(
        outputDir,
        this.config.getTargetDir(),
        "Generated image path must stay inside the workspace."
      );
      await atomicWriteFile(this.outputPath, generated.bytes, {
        mode: 384,
        noFollow: true
      });
      const workspacePath = path.relative(this.config.getTargetDir(), this.outputPath).split(path.sep).join("/");
      const metadata = {
        model: imageConfig.model,
        ...generated.requestId ? { requestId: generated.requestId } : {},
        ...this.params.size ? { size: this.params.size } : {}
      };
      const llmContent = [
        {
          text: `Generated image saved to ${this.outputPath}.`
        }
      ];
      if (this.config.getEffectiveInputModalities().image === true) {
        llmContent.push({
          inlineData: {
            mimeType: generated.mimeType,
            data: generated.bytes.toString("base64")
          }
        });
      }
      return {
        llmContent,
        returnDisplay: `Generated image saved to **${this.outputPath}**.`,
        resultFilePaths: [this.outputPath],
        artifacts: [
          {
            title: "Generated image",
            kind: "image",
            storage: "workspace",
            workspacePath,
            mimeType: generated.mimeType,
            sizeBytes: generated.bytes.length,
            metadata
          }
        ]
      };
    } catch (error) {
      return failureResult(
        error instanceof Error ? error.message : getErrorMessage(error)
      );
    }
  }
};
var ImageGenTool = class _ImageGenTool extends BaseDeclarativeTool {
  constructor(config, generateImage2 = generateImage) {
    super(
      _ImageGenTool.Name,
      ToolDisplayNames.IMAGE_GEN,
      "Generates a PNG image with the configured image model and saves it as a workspace artifact. Use size in width*height form when the user requests a specific aspect ratio.",
      "execute" /* Execute */,
      {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            minLength: 1,
            maxLength: MAX_PROMPT_CHARS,
            description: "Detailed text description of the image to generate."
          },
          size: {
            type: "string",
            pattern: "^\\d+\\*\\d+$",
            description: "Optional output size in width*height form, for example 1536*864."
          }
        },
        required: ["prompt"]
      },
      true,
      false,
      false,
      false,
      "image generation picture poster illustration"
    );
    this.config = config;
    this.generateImage = generateImage2;
  }
  static {
    __name(this, "ImageGenTool");
  }
  static Name = ToolNames.IMAGE_GEN;
  validateToolParamValues(params) {
    params.prompt = params.prompt.trim();
    if (!params.prompt) {
      return "The image prompt must be non-empty.";
    }
    if (params.prompt.length > MAX_PROMPT_CHARS) {
      return `The image prompt must not exceed ${MAX_PROMPT_CHARS} characters.`;
    }
    if (!params.size) {
      return null;
    }
    const match = /^(\d+)\*(\d+)$/.exec(params.size);
    if (!match) {
      return "Image size must use width*height form, for example 1536*864.";
    }
    const width = Number(match[1]);
    const height = Number(match[2]);
    const totalPixels = width * height;
    if (!Number.isSafeInteger(totalPixels) || totalPixels < MIN_TOTAL_PIXELS || totalPixels > MAX_TOTAL_PIXELS) {
      return `Image size total pixels must be between 512*512 and 2048*2048.`;
    }
    return null;
  }
  createInvocation(params) {
    return new ImageGenInvocation(this.config, this.generateImage, params);
  }
};
function failureResult(message) {
  return {
    llmContent: `Image generation failed: ${message}`,
    returnDisplay: `Image generation failed: ${message}`,
    error: {
      message,
      type: "execution_failed" /* EXECUTION_FAILED */
    }
  };
}
__name(failureResult, "failureResult");
export {
  ImageGenTool
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
