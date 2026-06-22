/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type { Config } from '../../config/config.js';
import type {
  ToolCallConfirmationDetails,
  ToolInfoConfirmationDetails,
  ToolInvocation,
  ToolResult,
} from '../tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from '../tools.js';
import type { PermissionDecision } from '../../permissions/types.js';
import { ToolErrorType } from '../tool-error.js';
import { ToolNames, ToolDisplayNames } from '../tool-names.js';
import { makeRelative, shortenPath, unescapePath } from '../../utils/paths.js';
import {
  getErrorMessage,
  isAbortError,
  isNodeError,
} from '../../utils/errors.js';
import { openBrowserSecurely } from '../../utils/secure-browser-launcher.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import {
  MAX_ARTIFACT_BYTES,
  byteLength,
  sanitizeArtifactTitle,
  validateSelfContained,
  wrapArtifactHtml,
} from './html.js';
import { artifactIdFromPath, type ArtifactPublisher } from './publisher.js';
import { createArtifactPublisher } from './create-publisher.js';

/** Opens a URL in the browser. Injectable so tests don't launch a browser. */
export type UrlOpener = (
  url: string,
  options: { allowFile: boolean; allowedFilePaths: string[] },
) => Promise<void>;

export interface ArtifactToolParams {
  /** Absolute path to the body-only HTML fragment file to publish. */
  file_path: string;
  /** Concise title for the artifact (browser tab / listing). */
  title?: string;
}

const DESCRIPTION = `Publishes a self-contained HTML page as an interactive Artifact, optionally opens it in the browser depending on settings, and returns a shareable link when a remote host is configured. Use it to turn session output into a durable, interactive page — a PR walkthrough, an architecture tour, a project dashboard.

Workflow:
- Write the page to a file first (via Write/Edit), then call Artifact with that file's absolute path.
- Write a BODY-ONLY fragment: no <!doctype>, <html>, <head>, or <body> tags — they are added at publish time, along with a minimal CSS reset.
- Self-contained only: inline all CSS and JS; embed images/fonts as data: URIs. No external scripts, stylesheets, fonts, or remote images.
- Responsive: relative units, flex/grid, max-width:100% on media; wide content (tables, diagrams, code) scrolls inside its own overflow-x:auto container.
- Set a concise \`title\` — it names the browser tab.

To update an artifact, call Artifact again with the SAME file path: it redeploys to the same URL. A different path creates a separate Artifact.

Set artifact.autoOpen=false in settings.json, or QWEN_ARTIFACT_NO_AUTO_OPEN=1, to publish without launching a browser.`;

const debugLogger = createDebugLogger('artifact');

class ArtifactToolInvocation extends BaseToolInvocation<
  ArtifactToolParams,
  ToolResult
> {
  private readonly shouldAutoOpen: boolean;

  constructor(
    private readonly config: Config,
    private readonly publisher: ArtifactPublisher,
    private readonly openUrl: UrlOpener,
    params: ArtifactToolParams,
  ) {
    super(params);
    this.shouldAutoOpen = config.shouldAutoOpenArtifact();
  }

  override getDescription(): string {
    const relativePath = makeRelative(
      this.params.file_path,
      this.config.getTargetDir(),
    );
    return `Publishing artifact from ${shortenPath(relativePath)}`;
  }

  /** Publishing writes outside the project and may open a browser — always ask. */
  override getDefaultPermission(): Promise<PermissionDecision> {
    return Promise.resolve('ask');
  }

  override getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    const relativePath = makeRelative(
      this.params.file_path,
      this.config.getTargetDir(),
    );
    const backendLabel =
      this.publisher.kind === 'host' ? 'custom upload' : this.publisher.kind;
    const openSuffix = this.shouldAutoOpen
      ? ' and open it in your browser'
      : '';
    const remoteOpenSuffix = this.shouldAutoOpen
      ? ' and opens the shareable link in your browser'
      : '';
    // Remote backends (host/oss) upload the HTML to a server and hand back a
    // shareable link — say so in the prompt so the user knows the page leaves
    // their machine before they approve.
    const prompt =
      this.publisher.kind === 'local'
        ? `Publish ${shortenPath(relativePath)} as an interactive Artifact${openSuffix}.`
        : `Publish ${shortenPath(relativePath)} as an interactive Artifact. This uploads the page to a remote host (${backendLabel})${remoteOpenSuffix}.`;
    const details: ToolInfoConfirmationDetails = {
      type: 'info',
      title: 'Publish Artifact',
      prompt,
      onConfirm: async () => {
        // Persistence handled by coreToolScheduler via PM rules.
      },
    };
    return Promise.resolve(details);
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const { file_path } = this.params;

    // Read the fragment the model wrote.
    let fragment: string;
    try {
      const { content } = await this.config
        .getFileSystemService()
        .readTextFile({ path: file_path });
      fragment = content;
    } catch (err) {
      const notFound = isNodeError(err) && err.code === 'ENOENT';
      const message = notFound
        ? `Artifact source file not found: ${file_path}. Write the page content to this file first.`
        : `Error reading artifact source file '${file_path}': ${getErrorMessage(err)}`;
      return {
        llmContent: message,
        returnDisplay: message,
        error: {
          message,
          type: notFound
            ? ToolErrorType.FILE_NOT_FOUND
            : ToolErrorType.READ_CONTENT_FAILURE,
        },
      };
    }

    // Reject external dependencies / full-document wrappers.
    const contentError = validateSelfContained(fragment);
    if (contentError) {
      return {
        llmContent: contentError,
        returnDisplay: contentError,
        error: { message: contentError, type: ToolErrorType.EXECUTION_FAILED },
      };
    }

    const title = sanitizeArtifactTitle(
      this.params.title ?? path.basename(file_path).replace(/\.html?$/i, ''),
    );
    const html = wrapArtifactHtml(fragment, title);

    // Enforce the size cap on the published document.
    const bytes = byteLength(html);
    if (bytes > MAX_ARTIFACT_BYTES) {
      const message = `Artifact is too large (${bytes} bytes > ${MAX_ARTIFACT_BYTES} byte limit). Trim the content or split it across multiple artifacts.`;
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message, type: ToolErrorType.FILE_TOO_LARGE },
      };
    }

    // Publish (idempotent per source path → stable URL).
    let url: string;
    let filePath: string | undefined;
    try {
      const published = await this.publisher.publish(
        { id: artifactIdFromPath(file_path), title, html },
        signal,
      );
      url = published.url;
      filePath = published.filePath;
    } catch (err) {
      // A user-initiated cancel (Esc / aborted signal) is not a failure —
      // surface it as a cancellation rather than a publish error.
      if (signal.aborted || isAbortError(err)) {
        const message = 'Artifact publishing was cancelled.';
        return {
          llmContent: message,
          returnDisplay: message,
        };
      }
      const message = `Failed to publish artifact: ${getErrorMessage(err)}`;
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message, type: ToolErrorType.EXECUTION_FAILED },
      };
    }

    // Open in the browser unless disabled. Best-effort: never fail the publish
    // because the browser could not be launched.
    if (this.shouldAutoOpen) {
      try {
        await this.openUrl(url, {
          allowFile: true,
          allowedFilePaths: filePath ? [filePath] : [],
        });
      } catch (err) {
        debugLogger.warn(
          `Failed to open browser for artifact "${title}": ${getErrorMessage(err)}`,
        );
      }
    }

    const llmContent = `Published artifact "${title}" to ${url}. Share or open this URL to view the interactive page. Re-run Artifact with the same file path to update it.`;
    return {
      llmContent,
      returnDisplay: `📄 Published artifact **${title}**\n\n${url}`,
      resultFilePaths: filePath ? [filePath] : undefined,
    };
  }
}

/**
 * The Artifact tool: publishes a self-contained HTML fragment as an interactive
 * page and opens it. The backend is pluggable via {@link ArtifactPublisher}
 * (local file://, a custom upload command, or native OSS).
 */
export class ArtifactTool extends BaseDeclarativeTool<
  ArtifactToolParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.ARTIFACT;

  private readonly publisher: ArtifactPublisher;

  constructor(
    private readonly config: Config,
    publisher?: ArtifactPublisher,
    private readonly openUrl: UrlOpener = openBrowserSecurely,
  ) {
    super(
      ArtifactTool.Name,
      ToolDisplayNames.ARTIFACT,
      DESCRIPTION,
      Kind.Other,
      {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description:
              'Absolute path to the body-only HTML fragment file to publish.',
          },
          title: {
            type: 'string',
            description:
              'Concise title for the artifact (names the browser tab and listing).',
          },
        },
        required: ['file_path'],
      },
    );
    this.publisher = publisher ?? createArtifactPublisher(config);
  }

  protected override validateToolParamValues(
    params: ArtifactToolParams,
  ): string | null {
    const filePath = unescapePath((params.file_path ?? '').trim());
    params.file_path = filePath;
    if (!filePath) {
      return 'Missing or empty "file_path"';
    }
    if (!path.isAbsolute(filePath)) {
      return `File path must be absolute: ${filePath}`;
    }
    return null;
  }

  override toAutoClassifierInput(
    params: ArtifactToolParams,
  ): Record<string, unknown> {
    return { file_path: params.file_path, title: params.title };
  }

  protected createInvocation(
    params: ArtifactToolParams,
  ): ToolInvocation<ArtifactToolParams, ToolResult> {
    return new ArtifactToolInvocation(
      this.config,
      this.publisher,
      this.openUrl,
      params,
    );
  }
}
