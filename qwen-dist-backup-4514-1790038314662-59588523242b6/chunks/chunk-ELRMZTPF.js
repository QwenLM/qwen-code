// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/services/session-sources.ts
init_esbuild_shims();
import { createHash } from "node:crypto";
import path from "node:path";
var SessionSourceError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "SessionSourceError";
  }
  static {
    __name(this, "SessionSourceError");
  }
};
var invalid = /* @__PURE__ */ __name((message) => {
  throw new SessionSourceError("invalid_source", message);
}, "invalid");
function object(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("Source must be an object");
  }
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    return invalid("Unknown source field");
  }
  return value;
}
__name(object, "object");
function text(value, field, limit, empty = false, trim = true) {
  if (typeof value !== "string" || /[\p{Cc}\p{Cf}]/u.test(value)) {
    return invalid(`Invalid ${field}`);
  }
  const normalized = trim ? value.trim() : value;
  if (!empty && !normalized || normalized.length > limit) {
    return invalid(`Invalid ${field} length (maximum ${limit})`);
  }
  return normalized;
}
__name(text, "text");
function validateSessionSourceInput(value) {
  const input = object(value, ["title", "description", "locator"]);
  const title = text(input["title"], "title", 200);
  const description = input["description"] === void 0 ? void 0 : text(input["description"], "description", 1e3, true);
  const raw = object(input["locator"], [
    "type",
    "workspacePath",
    "attachmentId",
    "url"
  ]);
  let locator;
  switch (raw["type"]) {
    case "workspace_file": {
      object(raw, ["type", "workspacePath"]);
      const sourcePath = text(
        raw["workspacePath"],
        "workspacePath",
        500,
        false,
        false
      ).replaceAll("\\", "/");
      if (sourcePath.startsWith("/") || /^[a-z]:/iu.test(sourcePath)) {
        return invalid("Workspace path must be relative");
      }
      const segments = [];
      for (const segment of sourcePath.split("/")) {
        if (!segment || segment === ".") continue;
        if (segment === "..") {
          if (!segments.length)
            return invalid("Workspace path escapes its root");
          segments.pop();
        } else {
          segments.push(segment);
        }
      }
      if (!segments.length)
        return invalid("Workspace path must identify a file");
      locator = { type: "workspace_file", workspacePath: segments.join("/") };
      break;
    }
    case "attachment":
      object(raw, ["type", "attachmentId"]);
      locator = {
        type: "attachment",
        attachmentId: text(
          raw["attachmentId"],
          "attachmentId",
          200,
          false,
          false
        )
      };
      break;
    case "url": {
      object(raw, ["type", "url"]);
      const maxUrlLength = 2048;
      const url = text(raw["url"], "url", maxUrlLength);
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return invalid("Invalid source URL");
      }
      if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
        return invalid("Source URL must be HTTP(S) without credentials");
      }
      if (parsed.href.length > maxUrlLength) {
        return invalid(
          `Source URL is too long (maximum ${maxUrlLength} characters after normalization)`
        );
      }
      locator = { type: "url", url: parsed.href };
      break;
    }
    default:
      return invalid("Unknown source locator type");
  }
  return {
    title,
    locator,
    ...description !== void 0 ? { description } : {}
  };
}
__name(validateSessionSourceInput, "validateSessionSourceInput");
function sessionSourceId(sessionId, locator, workspaceCwd) {
  return createHash("sha256").update(JSON.stringify([sessionId, locator, workspaceCwd ?? null])).digest("hex");
}
__name(sessionSourceId, "sessionSourceId");
function ordered(sources) {
  return sources.sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)
  );
}
__name(ordered, "ordered");
function parseSessionSourcesSnapshot(value, sessionId) {
  const raw = object(value, ["version", "revision", "sources"]);
  if (raw["version"] !== 1 || !Number.isSafeInteger(raw["revision"]) || raw["revision"] < 0 || !Array.isArray(raw["sources"]) || raw["sources"].length > 200) {
    return invalid("Unsupported or malformed sources snapshot");
  }
  const ids = /* @__PURE__ */ new Set();
  const sources = raw["sources"].map((value2) => {
    const source = object(value2, [
      "id",
      "kind",
      "workspaceCwd",
      "createdAt",
      "updatedAt",
      "title",
      "description",
      "locator"
    ]);
    const input = validateSessionSourceInput({
      title: source["title"],
      locator: source["locator"],
      ...source["description"] !== void 0 ? { description: source["description"] } : {}
    });
    const workspaceCwd = source["workspaceCwd"];
    if (input.locator.type === "workspace_file" ? typeof workspaceCwd !== "string" || !path.isAbsolute(workspaceCwd) || path.normalize(workspaceCwd) !== workspaceCwd : workspaceCwd !== void 0) {
      return invalid("Invalid source workspace binding");
    }
    const id = sessionSourceId(
      sessionId,
      input.locator,
      workspaceCwd
    );
    const kind = input.locator.type === "url" ? "link" : "file";
    const createdAt = source["createdAt"];
    const updatedAt = source["updatedAt"];
    const isTimestamp = /* @__PURE__ */ __name((value3) => typeof value3 === "string" && Number.isFinite(Date.parse(value3)) && new Date(value3).toISOString() === value3, "isTimestamp");
    if (source["id"] !== id || ids.has(id) || source["kind"] !== kind || !isTimestamp(createdAt) || !isTimestamp(updatedAt) || updatedAt < createdAt || source["title"] !== input.title || source["description"] !== input.description) {
      return invalid("Invalid stored source");
    }
    ids.add(id);
    return {
      ...input,
      id,
      kind,
      ...typeof workspaceCwd === "string" ? { workspaceCwd } : {},
      createdAt,
      updatedAt
    };
  });
  return {
    version: 1,
    revision: raw["revision"],
    sources: ordered(sources)
  };
}
__name(parseSessionSourcesSnapshot, "parseSessionSourcesSnapshot");
function restoreSessionSources(records, sessionId) {
  const latest = records.findLast(
    (record) => record.type === "system" && record.subtype === "session_sources_snapshot"
  );
  if (!latest) return {};
  try {
    return {
      sourcesSnapshot: parseSessionSourcesSnapshot(
        latest.systemPayload,
        sessionId
      )
    };
  } catch {
    return { sourcesUnavailable: true };
  }
}
__name(restoreSessionSources, "restoreSessionSources");
var SessionSourceService = class {
  constructor(options) {
    this.options = options;
  }
  static {
    __name(this, "SessionSourceService");
  }
  snapshot = {
    version: 1,
    revision: 0,
    sources: []
  };
  loaded = false;
  queue = Promise.resolve();
  serial(operation) {
    const result = this.queue.then(async () => {
      if (!this.loaded) {
        let restored;
        try {
          restored = await this.options.load();
        } catch {
          throw new SessionSourceError(
            "source_persistence_unavailable",
            "Stored sources could not be loaded"
          );
        }
        if (restored.sourcesUnavailable)
          throw new SessionSourceError(
            "source_persistence_unavailable",
            "Stored sources are unavailable"
          );
        this.snapshot = restored.sourcesSnapshot ?? {
          version: 1,
          revision: 0,
          sources: []
        };
        this.loaded = true;
      }
      return operation();
    });
    this.queue = result.catch(() => void 0);
    return result;
  }
  async commit(sources) {
    const next = parseSessionSourcesSnapshot(
      { version: 1, revision: this.snapshot.revision + 1, sources },
      this.options.sessionId
    );
    try {
      await this.options.persist(next);
    } catch {
      this.loaded = false;
      throw new SessionSourceError(
        "source_persistence_unavailable",
        "Source metadata could not be persisted"
      );
    }
    this.snapshot = next;
    void Promise.resolve().then(() => this.options.notify?.(next.revision)).catch(() => void 0);
  }
  list() {
    return this.serial(
      async () => structuredClone({
        revision: this.snapshot.revision,
        sources: this.snapshot.sources
      })
    );
  }
  upsert(value) {
    return this.serial(async () => {
      const input = validateSessionSourceInput(value);
      const workspaceCwd = input.locator.type === "workspace_file" ? path.resolve(this.options.workspaceCwd()) : void 0;
      const id = sessionSourceId(
        this.options.sessionId,
        input.locator,
        workspaceCwd
      );
      const previous = this.snapshot.sources.find((source2) => source2.id === id);
      const description = input.description ?? previous?.description;
      if (previous && previous.title === input.title && previous.description === description) {
        return {
          revision: this.snapshot.revision,
          source: structuredClone(previous),
          change: "unchanged"
        };
      }
      if (!previous && this.snapshot.sources.length >= 200)
        throw new SessionSourceError(
          "source_limit_reached",
          "A session can contain at most 200 sources"
        );
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const source = {
        ...input,
        ...description !== void 0 ? { description } : {},
        id,
        kind: input.locator.type === "url" ? "link" : "file",
        ...workspaceCwd ? { workspaceCwd } : {},
        createdAt: previous?.createdAt ?? now,
        updatedAt: now
      };
      await this.commit([
        ...this.snapshot.sources.filter((item) => item.id !== id),
        source
      ]);
      return {
        revision: this.snapshot.revision,
        source: structuredClone(source),
        change: previous ? "updated" : "created"
      };
    });
  }
  remove(sourceId) {
    return this.serial(async () => {
      const sources = this.snapshot.sources.filter(
        (source) => source.id !== sourceId
      );
      const removed = sources.length !== this.snapshot.sources.length;
      if (removed) await this.commit(sources);
      return { revision: this.snapshot.revision, removed };
    });
  }
  copyFrom(sources, attachmentIds) {
    return this.serial(async () => {
      const warnings = [];
      const cwd = path.resolve(this.options.workspaceCwd());
      const copied = sources.flatMap((source) => {
        if (source.locator.type === "attachment" && !attachmentIds.includes(source.locator.attachmentId) || source.locator.type === "workspace_file" && source.workspaceCwd !== cwd) {
          warnings.push(
            `Source ${source.id} was not copied because its resource could not be mapped`
          );
          return [];
        }
        return [
          {
            ...source,
            id: sessionSourceId(
              this.options.sessionId,
              source.locator,
              source.workspaceCwd
            )
          }
        ];
      });
      if (copied.length) await this.commit(copied);
      return { warnings };
    });
  }
};

export {
  SessionSourceError,
  validateSessionSourceInput,
  restoreSessionSources,
  SessionSourceService
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
