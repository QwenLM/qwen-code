/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The `<cross-session-message>` envelope.
 *
 * Peer text reaches the model inside this frame, mirroring the existing
 * `<teammate-message>` convention in `agents/teams/agent-team-peer-message.ts`. The
 * `from` attribute is the reply handle the model is told to copy back into
 * `SendMessage`.
 *
 * Parsing is validated by round-trip: after the regex extracts the attributes we
 * rebuild the envelope and require byte equality with the input. A body that
 * tries to smuggle extra attributes or a premature closing tag therefore cannot
 * produce a "successfully parsed" envelope with attacker-chosen metadata.
 */

import {
  HOP_ID_LENGTH,
  MAX_HOP_CHAIN,
  MAX_PEER_ADDRESS_LENGTH,
} from './peer-address.js';

export const CROSS_SESSION_MESSAGE_TAG = 'cross-session-message';

/** Permission-mode class a sender may declare, used for inbound mode parity. */
export type PeerModeClass = 'bypass' | 'prompting';

export interface CrossSessionEnvelope {
  from?: string;
  fromName?: string;
  fromMode?: PeerModeClass;
  hopChain?: string[];
  body: string;
}

const ADDRESS_GROUP = `[A-Za-z0-9%:_/.\\\\-]{1,${MAX_PEER_ADDRESS_LENGTH}}`;
const HOP_CHAIN_GROUP = `[0-9a-f]{${HOP_ID_LENGTH}}(?:,[0-9a-f]{${HOP_ID_LENGTH}})*`;
const NAME_GROUP = '[^"<>\\n\\r]{1,120}';

const ENVELOPE_PATTERN = new RegExp(
  `^<${CROSS_SESSION_MESSAGE_TAG}` +
    `(?: from="(${ADDRESS_GROUP})")?` +
    `(?: hop-chain="(${HOP_CHAIN_GROUP})")?` +
    `(?: from-name="(${NAME_GROUP})")?` +
    `(?: from-mode="(bypass|prompting)")?` +
    `>\\n([\\s\\S]*)\\n</${CROSS_SESSION_MESSAGE_TAG}>$`,
);

/**
 * Neutralizes the envelope tag inside a body so a message quoting the frame
 * cannot terminate it early. Mirrors `guardTeammateMessageText`.
 */
export function guardEnvelopeBody(body: string): string {
  return body.replace(
    new RegExp(`<(?=/?${CROSS_SESSION_MESSAGE_TAG}(?:[>\\s/]|$))`, 'gi'),
    '<\\',
  );
}

function unguardEnvelopeBody(body: string): string {
  return body.replace(
    new RegExp(`<\\\\(?=/?${CROSS_SESSION_MESSAGE_TAG}(?:[>\\s/]|$))`, 'gi'),
    '<',
  );
}

/** Strips characters that would break out of a double-quoted attribute. */
function sanitizeName(name: string): string {
  return name.replace(/["<>\n\r]/g, '').trim().slice(0, 120);
}

function buildAttributes(envelope: Omit<CrossSessionEnvelope, 'body'>): string {
  const attrs: string[] = [];
  if (envelope.from) attrs.push(`from="${envelope.from}"`);
  if (envelope.hopChain?.length) {
    attrs.push(`hop-chain="${envelope.hopChain.join(',')}"`);
  }
  const safeName =
    envelope.fromName === undefined ? '' : sanitizeName(envelope.fromName);
  if (safeName) attrs.push(`from-name="${safeName}"`);
  if (envelope.fromMode) attrs.push(`from-mode="${envelope.fromMode}"`);
  return attrs.length > 0 ? ` ${attrs.join(' ')}` : '';
}

/** Serializes a cross-session message frame. */
export function buildCrossSessionEnvelope(
  envelope: CrossSessionEnvelope,
): string {
  const attributes = buildAttributes(envelope);
  const body = guardEnvelopeBody(envelope.body);
  return `<${CROSS_SESSION_MESSAGE_TAG}${attributes}>\n${body}\n</${CROSS_SESSION_MESSAGE_TAG}>`;
}

/**
 * Parses a frame, or returns undefined when the input is not a frame this
 * function itself could have produced.
 */
export function parseCrossSessionEnvelope(
  raw: string,
): CrossSessionEnvelope | undefined {
  const match = raw.match(ENVELOPE_PATTERN);
  if (!match) return undefined;

  const hopChain = match[2] ? match[2].split(',') : undefined;
  if (hopChain && hopChain.length > MAX_HOP_CHAIN) return undefined;

  const parsed: CrossSessionEnvelope = {
    ...(match[1] !== undefined && { from: match[1] }),
    ...(hopChain && { hopChain }),
    ...(match[3] !== undefined && { fromName: match[3] }),
    ...(match[4] !== undefined && { fromMode: match[4] as PeerModeClass }),
    body: match[5] ?? '',
  };

  // Round-trip check: the captured fields must reproduce the exact input.
  if (buildCrossSessionEnvelope(parsed) !== raw) return undefined;

  return { ...parsed, body: unguardEnvelopeBody(parsed.body) };
}

/**
 * Best-effort metadata read used when routing an inbound frame. Returns
 * undefined for anything that is not a valid envelope.
 */
export function extractEnvelopeMeta(
  raw: string,
): Omit<CrossSessionEnvelope, 'body'> | undefined {
  const parsed = parseCrossSessionEnvelope(raw);
  if (!parsed) return undefined;
  const { body: _body, ...meta } = parsed;
  return meta;
}
