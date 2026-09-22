// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/cronParser.ts
init_esbuild_shims();
var FIELD_RANGES = [
  [0, 59],
  // minute
  [0, 23],
  // hour
  [1, 31],
  // day of month
  [1, 12],
  // month
  [0, 7]
  // day of week (0 and 7 both mean Sunday)
];
var INTEGER_TOKEN_RE = /^\d+$/;
function parseField(field, min, max) {
  const values = /* @__PURE__ */ new Set();
  for (const part of field.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) {
      throw new Error(`Empty field segment in "${field}"`);
    }
    const stepParts = trimmed.split("/");
    if (stepParts.length > 2) {
      throw new Error(`Invalid step expression: "${trimmed}"`);
    }
    let rangeStart;
    let rangeEnd;
    const base = stepParts[0];
    if (base === "*") {
      rangeStart = min;
      rangeEnd = max;
    } else if (base.includes("-")) {
      const rangeParts = base.split("-");
      if (rangeParts.length !== 2 || !INTEGER_TOKEN_RE.test(rangeParts[0]) || !INTEGER_TOKEN_RE.test(rangeParts[1])) {
        throw new Error(`Invalid range: "${base}"`);
      }
      const [startStr, endStr] = rangeParts;
      rangeStart = parseInt(startStr, 10);
      rangeEnd = parseInt(endStr, 10);
      if (rangeStart < min || rangeEnd > max || rangeStart > rangeEnd) {
        throw new Error(`Range ${base} out of bounds [${min}-${max}]`);
      }
    } else {
      if (!INTEGER_TOKEN_RE.test(base)) {
        throw new Error(`Invalid value: "${base}"`);
      }
      const val = parseInt(base, 10);
      if (val < min || val > max) {
        throw new Error(`Value "${base}" out of bounds [${min}-${max}]`);
      }
      rangeStart = val;
      rangeEnd = stepParts.length === 2 ? max : val;
    }
    if (stepParts.length === 2 && !INTEGER_TOKEN_RE.test(stepParts[1])) {
      throw new Error(`Invalid step: "${stepParts[1]}"`);
    }
    const step = stepParts.length === 2 ? parseInt(stepParts[1], 10) : 1;
    if (step <= 0) {
      throw new Error(`Invalid step: "${stepParts[1]}"`);
    }
    for (let i = rangeStart; i <= rangeEnd; i += step) {
      values.add(i);
    }
  }
  return values;
}
__name(parseField, "parseField");
function parseCron(cronExpr) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Cron expression must have exactly 5 fields, got ${parts.length}: "${cronExpr}"`
    );
  }
  const dayOfWeek = parseField(
    parts[4],
    FIELD_RANGES[4][0],
    FIELD_RANGES[4][1]
  );
  if (dayOfWeek.has(7)) {
    dayOfWeek.delete(7);
    dayOfWeek.add(0);
  }
  return {
    minute: parseField(parts[0], FIELD_RANGES[0][0], FIELD_RANGES[0][1]),
    hour: parseField(parts[1], FIELD_RANGES[1][0], FIELD_RANGES[1][1]),
    dayOfMonth: parseField(parts[2], FIELD_RANGES[2][0], FIELD_RANGES[2][1]),
    month: parseField(parts[3], FIELD_RANGES[3][0], FIELD_RANGES[3][1]),
    dayOfWeek,
    domIsWild: parts[2].trim().startsWith("*"),
    dowIsWild: parts[4].trim().startsWith("*")
  };
}
__name(parseCron, "parseCron");
function matches(cronExpr, date) {
  const fields = parseCron(cronExpr);
  if (!fields.minute.has(date.getMinutes()) || !fields.hour.has(date.getHours()) || !fields.month.has(date.getMonth() + 1)) {
    return false;
  }
  const domMatch = fields.dayOfMonth.has(date.getDate());
  const dowMatch = fields.dayOfWeek.has(date.getDay());
  if (!fields.domIsWild && !fields.dowIsWild) {
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}
__name(matches, "matches");
function nextFireTime(cronExpr, after) {
  const fields = parseCron(cronExpr);
  const candidate = new Date(
    Math.floor(after.getTime() / 6e4) * 6e4 + 6e4
  );
  const maxIterations = 4 * 366 * 24 * 60;
  for (let i = 0; i < maxIterations; i++) {
    const minuteOk = fields.minute.has(candidate.getMinutes());
    const hourOk = fields.hour.has(candidate.getHours());
    const monthOk = fields.month.has(candidate.getMonth() + 1);
    const domOk = fields.dayOfMonth.has(candidate.getDate());
    const dowOk = fields.dayOfWeek.has(candidate.getDay());
    const dayOk = !fields.domIsWild && !fields.dowIsWild ? domOk || dowOk : domOk && dowOk;
    if (minuteOk && hourOk && monthOk && dayOk) {
      return candidate;
    }
    candidate.setTime(candidate.getTime() + 6e4);
  }
  throw new Error(
    `No matching fire time found within 4 years for: "${cronExpr}"`
  );
}
__name(nextFireTime, "nextFireTime");

export {
  parseCron,
  matches,
  nextFireTime
};
