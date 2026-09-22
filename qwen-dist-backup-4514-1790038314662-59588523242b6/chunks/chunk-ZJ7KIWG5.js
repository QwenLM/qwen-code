// Force strict mode and setup for ESM
"use strict";
import {
  atomicWriteFileSync
} from "./chunk-CA63HYHU.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/commands/channel/observed-contact-store.ts
init_esbuild_shims();
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
var REGISTRY_VERSION = 1;
var MAX_OBSERVATIONS = 500;
var MAX_CHANNEL_NAME_LENGTH = 256;
var MAX_LABEL_LENGTH = 256;
var MAX_ID_LENGTH = 4096;
var OBSERVED_CONTACT_MAX_FRESH_WITHIN_SECONDS = 365 * 24 * 60 * 60;
var ObservedChannelContactStore = class {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.now = options.now ?? (() => /* @__PURE__ */ new Date());
    this.maxObservations = options.maxObservations ?? MAX_OBSERVATIONS;
  }
  static {
    __name(this, "ObservedChannelContactStore");
  }
  now;
  maxObservations;
  observe(channelName, observation) {
    this.validateObservation(channelName, observation);
    const observedAt = this.now();
    const next = {
      channelName,
      user: this.normalizeIdentity(observation.user),
      ...observation.group ? { group: this.normalizeIdentity(observation.group) } : {},
      ...observation.topic ? { topic: this.normalizeIdentity(observation.topic) } : {},
      lastObservedAt: observedAt.toISOString()
    };
    const key = this.observationKey(next);
    const retentionCutoff = observedAt.getTime() - OBSERVED_CONTACT_MAX_FRESH_WITHIN_SECONDS * 1e3;
    const observations = this.readObservations().filter(
      (candidate) => Date.parse(candidate.lastObservedAt) >= retentionCutoff && this.observationKey(candidate) !== key
    ).concat(next).sort((a, b) => b.lastObservedAt.localeCompare(a.lastObservedAt)).slice(0, this.maxObservations);
    this.persist(observations);
  }
  list(options) {
    const { freshWithinSeconds } = options;
    if (!Number.isInteger(freshWithinSeconds) || freshWithinSeconds < 1 || freshWithinSeconds > OBSERVED_CONTACT_MAX_FRESH_WITHIN_SECONDS) {
      throw new Error("Invalid observed contact freshness.");
    }
    const cutoff = this.now().getTime() - freshWithinSeconds * 1e3;
    const observations = this.readObservations().filter((observation) => Date.parse(observation.lastObservedAt) >= cutoff).sort((a, b) => b.lastObservedAt.localeCompare(a.lastObservedAt));
    const users = /* @__PURE__ */ new Map();
    const groups = /* @__PURE__ */ new Map();
    for (const observation of observations) {
      if (!observation.group) {
        const key = this.identityKey(
          observation.channelName,
          observation.user.id
        );
        if (!users.has(key)) {
          users.set(key, {
            channelName: observation.channelName,
            ...observation.user,
            lastObservedAt: observation.lastObservedAt
          });
        }
        continue;
      }
      const groupKey = this.identityKey(
        observation.channelName,
        observation.group.id
      );
      let group = groups.get(groupKey);
      if (!group) {
        group = {
          channelName: observation.channelName,
          ...observation.group,
          lastObservedAt: observation.lastObservedAt,
          users: [],
          topics: [],
          userMap: /* @__PURE__ */ new Map(),
          topicMap: /* @__PURE__ */ new Map()
        };
        groups.set(groupKey, group);
      }
      if (!group.userMap.has(observation.user.id)) {
        group.userMap.set(observation.user.id, {
          ...observation.user,
          lastObservedAt: observation.lastObservedAt
        });
      }
      if (observation.topic) {
        let topic = group.topicMap.get(observation.topic.id);
        if (!topic) {
          topic = {
            ...observation.topic,
            lastObservedAt: observation.lastObservedAt,
            users: [],
            userMap: /* @__PURE__ */ new Map()
          };
          group.topicMap.set(observation.topic.id, topic);
        }
        if (!topic.userMap.has(observation.user.id)) {
          topic.userMap.set(observation.user.id, {
            ...observation.user,
            lastObservedAt: observation.lastObservedAt
          });
        }
      }
    }
    return {
      users: [...users.values()],
      groups: [...groups.values()].map((group) => ({
        channelName: group.channelName,
        id: group.id,
        label: group.label,
        lastObservedAt: group.lastObservedAt,
        users: [...group.userMap.values()],
        topics: [...group.topicMap.values()].map((topic) => ({
          id: topic.id,
          label: topic.label,
          lastObservedAt: topic.lastObservedAt,
          users: [...topic.userMap.values()]
        }))
      }))
    };
  }
  readObservations() {
    if (!existsSync(this.filePath)) return [];
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf-8"));
    } catch {
      throw new Error("Invalid observed contact registry.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid observed contact registry.");
    }
    const record = parsed;
    if (record["version"] !== REGISTRY_VERSION) {
      throw new Error("Unsupported observed contact registry version.");
    }
    if (!Array.isArray(record["observations"]) || record["observations"].length > this.maxObservations) {
      throw new Error("Invalid observed contact registry.");
    }
    const observations = record["observations"].map(
      (raw) => this.parseObservation(raw)
    );
    const keys = new Set(observations.map((item) => this.observationKey(item)));
    if (keys.size !== observations.length) {
      throw new Error("Invalid observed contact registry.");
    }
    return observations;
  }
  parseObservation(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Invalid observed contact registry.");
    }
    const record = raw;
    const channelName = record["channelName"];
    const lastObservedAt = record["lastObservedAt"];
    const user = this.parseIdentity(record["user"]);
    const group = record["group"] === void 0 ? void 0 : this.parseIdentity(record["group"]);
    const topic = record["topic"] === void 0 ? void 0 : this.parseIdentity(record["topic"]);
    if (!this.isBoundedString(channelName, MAX_CHANNEL_NAME_LENGTH) || typeof lastObservedAt !== "string" || !this.isCanonicalTimestamp(lastObservedAt) || topic !== void 0 && group === void 0) {
      throw new Error("Invalid observed contact registry.");
    }
    return {
      channelName,
      user,
      ...group ? { group } : {},
      ...topic ? { topic } : {},
      lastObservedAt
    };
  }
  parseIdentity(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Invalid observed contact registry.");
    }
    const record = raw;
    const id = record["id"];
    const label = record["label"];
    if (!this.isBoundedString(id, MAX_ID_LENGTH) || !this.isBoundedString(label, MAX_LABEL_LENGTH)) {
      throw new Error("Invalid observed contact registry.");
    }
    return { id, label };
  }
  validateObservation(channelName, observation) {
    if (!this.isBoundedString(channelName, MAX_CHANNEL_NAME_LENGTH) || !this.isIdentity(observation.user) || observation.group !== void 0 && !this.isIdentity(observation.group) || observation.topic !== void 0 && !this.isIdentity(observation.topic) || observation.topic !== void 0 && observation.group === void 0) {
      throw new Error("Invalid observed contact observation.");
    }
  }
  isIdentity(value) {
    return this.isBoundedString(value.id, MAX_ID_LENGTH) && this.isBoundedString(value.label, MAX_ID_LENGTH);
  }
  normalizeIdentity(value) {
    return {
      id: value.id,
      label: this.truncateLabel(value.label)
    };
  }
  truncateLabel(value) {
    let result = "";
    for (const character of value) {
      if (result.length + character.length > MAX_LABEL_LENGTH) break;
      result += character;
    }
    return result;
  }
  observationKey(observation) {
    return JSON.stringify([
      observation.channelName,
      observation.user.id,
      observation.group?.id ?? "",
      observation.topic?.id ?? ""
    ]);
  }
  identityKey(channelName, id) {
    return JSON.stringify([channelName, id]);
  }
  persist(observations) {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 448 });
    try {
      chmodSync(dir, 448);
    } catch {
    }
    const data = {
      version: REGISTRY_VERSION,
      observations
    };
    atomicWriteFileSync(this.filePath, JSON.stringify(data, null, 2), {
      encoding: "utf-8",
      mode: 384,
      forceMode: true,
      noFollow: true
    });
  }
  isBoundedString(value, maxLength) {
    return typeof value === "string" && value.length > 0 && value.length <= maxLength;
  }
  isCanonicalTimestamp(value) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  }
};

export {
  OBSERVED_CONTACT_MAX_FRESH_WITHIN_SECONDS,
  ObservedChannelContactStore
};
