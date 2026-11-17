/**
 * @license
 * Copyright 2026 Alibaba Group Holding Limited
 * SPDX-License-Identifier: Apache-2.0
 */

// Version 1 preserves the prototype's on-disk format. Add new migrations instead
// of changing this baseline once libraries have been created with it.
export const SCHEMA_VERSION = 1;

export const LTM_FIELDS = [
  ['name', 'Name'],
  ['occupation_or_role', 'Occupation/Role'],
  ['long_term_goals', 'Long-term Goals'],
  ['routines', 'Routines'],
  ['appearance', 'Appearance'],
  ['preferences', 'Preferences'],
  ['interests', 'Interests'],
  ['relationships', 'Relationships'],
] as const;

export type LtmField = (typeof LTM_FIELDS)[number][0];
export const LTM_FIELD_NAMES = new Set<string>(LTM_FIELDS.map(([key]) => key));
export const LTM_SINGLE_VALUE = new Set<string>(['name']);
export const LTM_TRIM_ORDER: LtmField[] = [
  'relationships',
  'interests',
  'preferences',
  'appearance',
  'routines',
  'long_term_goals',
];

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS library_sessions (
  session_id TEXT PRIMARY KEY,
  session_name TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  n_turns INTEGER NOT NULL DEFAULT 0,
  n_segments INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  deactivated_at TEXT,
  deactivate_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_libsess_active ON library_sessions(active);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_idx INTEGER NOT NULL,
  user_text TEXT NOT NULL,
  user_ts TEXT NOT NULL,
  user_epoch INTEGER NOT NULL,
  asst_text TEXT NOT NULL,
  asst_ts TEXT NOT NULL,
  asst_epoch INTEGER NOT NULL,
  interrupted INTEGER NOT NULL DEFAULT 0,
  seg_id INTEGER,
  UNIQUE(session_id, turn_idx)
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, turn_idx);
CREATE TABLE IF NOT EXISTS dialogue_segments (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_from INTEGER NOT NULL,
  turn_to INTEGER NOT NULL,
  n_turns INTEGER NOT NULL,
  start_ts TEXT NOT NULL,
  end_ts TEXT NOT NULL,
  start_epoch INTEGER NOT NULL,
  end_epoch INTEGER NOT NULL,
  body TEXT NOT NULL,
  cut_reason TEXT NOT NULL,
  n_chars INTEGER NOT NULL,
  UNIQUE(session_id, turn_from)
);
CREATE INDEX IF NOT EXISTS idx_seg_epoch ON dialogue_segments(start_epoch DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS dialogue_fts USING fts5(
  index_text, seg_id UNINDEXED, tokenize='unicode61'
);
CREATE TABLE IF NOT EXISTS embeddings (
  kind TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  dim INTEGER NOT NULL,
  model TEXT NOT NULL,
  vec BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(kind, ref_id)
);
CREATE TABLE IF NOT EXISTS schema_meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS wm_snapshots (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  wm_json TEXT NOT NULL,
  ops_json TEXT NOT NULL,
  applied_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_wm_session ON wm_snapshots(session_id, seq DESC);
CREATE TABLE IF NOT EXISTS ltm_entries (
  id INTEGER PRIMARY KEY,
  field TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  src_session TEXT,
  UNIQUE(field, content)
);
CREATE INDEX IF NOT EXISTS idx_ltm_field ON ltm_entries(field, updated_at DESC);
CREATE TABLE IF NOT EXISTS stm_items (
  id INTEGER PRIMARY KEY,
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ongoing', 'upcoming')),
  created_at TEXT NOT NULL,
  created_ts INTEGER NOT NULL,
  event_date TEXT,
  expires_at TEXT,
  src_session TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  expired_at TEXT,
  UNIQUE(content, created_at)
);
CREATE INDEX IF NOT EXISTS idx_stm_active ON stm_items(active, created_ts DESC);
CREATE TABLE IF NOT EXISTS preload_log (
  session_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stm_env (
  id INTEGER PRIMARY KEY,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_ts INTEGER NOT NULL,
  src_session TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  expired_at TEXT,
  UNIQUE(content)
);
CREATE INDEX IF NOT EXISTS idx_stm_env_active ON stm_env(active, created_ts DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS env_fts USING fts5(
  index_text, env_id UNINDEXED, tokenize='unicode61'
);
CREATE TABLE IF NOT EXISTS updater_log (
  session_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  model TEXT,
  wm_json TEXT,
  patch_json TEXT,
  report_json TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_updater_status ON updater_log(status, created_at);
`;
