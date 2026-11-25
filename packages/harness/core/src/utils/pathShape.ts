/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unified path-shape classification.
 *
 * Two INDEPENDENT axes, because the threats are different:
 *
 * 1. `network` — can this spelling reach a remote host? Windows resolves a
 *    double-separator path by opening an SMB/WebDAV connection and performing
 *    an NTLM handshake, which discloses the user's credential hash before any
 *    authorization decision is made. POSIX `/net/<host>` autofs triggers a DNS
 *    lookup plus an NFS mount.
 * 2. `local` — does this spelling defeat path comparison? Alternate data
 *    streams, 8.3 short names, trailing dots and reserved device names all name
 *    a resource that differs from the literal string, so a name-based allow or
 *    deny list can be walked around.
 *
 * SECURITY: this module takes filesystem PATH INPUTS. It must never be applied
 * to permission RULE PATTERNS — a leading `//` in a rule means "absolute from
 * the filesystem root" (documented syntax, e.g. `Read(//tmp/data/**)`), and
 * `//c/Users` as a pattern is a drive-absolute path. Rule patterns are parsed by
 * `patternWithRoot` in permissions/filesystem.ts, which owns that domain.
 *
 * This module deliberately has NO IMPORTS: it is pure string/regex work, so
 * utils, permissions, tools and workflows can all depend on it without
 * creating a cycle, and it is platform-independent for testing.
 */

/** Which separator style introduces the path. */
export type PathSigil = 'backslash' | 'slash' | 'mixed' | 'none';

/** Axis 1: can this spelling reach a remote host? */
export type NetworkTrust =
  | { kind: 'local' }
  | { kind: 'localMount'; mount: 'wsl' | 'devicePath' | 'volumeGuid' }
  | {
      kind: 'network';
      host: string | null;
      via: 'unc' | 'uncDevice' | 'automount' | 'webdav';
    };

/** Axis 2: which comparison-defeating spelling was used. */
export type SuspiciousReason =
  | 'alternateDataStream'
  | 'shortName83'
  | 'devicePath'
  | 'ntObjectPath'
  | 'trailingDot'
  | 'consecutiveDots'
  | 'reservedDeviceName';

export type LocalSuspicion =
  | { kind: 'clean' }
  | { kind: 'suspicious'; reasons: readonly SuspiciousReason[] };

export interface PathShape {
  readonly input: string;
  /**
   * The form both axes were judged on, after stripping a local device prefix:
   * `\\?\C:\x` -> `C:\x`, `\\?\UNC\srv\share` -> `\\srv\share`. Identity for
   * everything else (including `\\?\Volume{GUID}\x`, where stripping would
   * produce a string that is not a usable path).
   */
  readonly canonical: string;
  readonly sigil: PathSigil;
  readonly network: NetworkTrust;
  readonly local: LocalSuspicion;
}

// ============================================================================
// Prefix patterns
//
// SECURITY: every pattern uses the [\\/] class so a path classifies identically
// before and after windowsPathToPosixPath, which flips `\\srv\share` to
// `//srv/share` while preserving the shape. Callers convert at different points
// in the pipeline, so the classifier must be sigil-agnostic.
// ============================================================================

const DOUBLE_SEP = /^[\\/]{2}/;

/** Local WSL2 distro mounts. Guaranteed local, never a remote host. */
const WSL_MOUNT = /^[\\/]{2}wsl(?:\$|\.localhost)[\\/]/i;

/** Extended-length UNC: a remote share wearing a local device prefix. */
const DEVICE_UNC = /^[\\/]{2}[?.][\\/]unc[\\/](.+)$/i;

/** Extended-length local drive: `\\?\C:\...`. */
const DEVICE_DRIVE = /^[\\/]{2}[?.][\\/]([A-Za-z]:(?:[\\/].*)?)$/;

/** Local volume by GUID: `\\?\Volume{...}\...`. */
const DEVICE_VOLUME = /^[\\/]{2}[?.][\\/]volume\{[^}]*\}(?:[\\/]|$)/i;

/** Any remaining DOS device namespace, e.g. `\\.\COM1`, `\\?\GLOBALROOT\...`. */
const DEVICE_ANY = /^[\\/]{2}[?.][\\/]/;

/** NT object-manager prefix `\??\`, which also bypasses Win32 normalization. */
const NT_OBJECT = /^[\\/]\?\?[\\/]/;

/** Hostname of a double-separator path, with the device-UNC form allowed. */
const UNC_HOST = /^[\\/]{2}(?:[?.][\\/]unc[\\/])?([^\\/]+)/i;

/** autofs `-hosts` map: `/net/<host>/...` triggers DNS + NFS mount. */
const AUTOMOUNT = /^[\\/]net[\\/]([^\\/]+)(?:[\\/]|$)/;

/** WebDAV redirector markers — force HTTP(S) auth instead of SMB. */
const WEBDAV_MARKERS = [/@SSL@\d+/i, /@\d+@SSL/i, /DavWWWRoot/i];

/** Leading drive letter, stripped before looking for an ADS colon. */
const DRIVE_PREFIX = /^[A-Za-z]:/;

const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

const SHORT_NAME_83 = /~\d/;

/** Three or more dots as a whole segment. `[...slug]` is not a match. */
const CONSECUTIVE_DOTS = /(?:^|[\\/])\.{3,}(?:[\\/]|$)/;

// ============================================================================
// Public API
// ============================================================================

/**
 * Strips a local device prefix, revealing the path Win32 would act on.
 *
 * `\\?\C:\x` -> `C:\x`, `\\?\UNC\srv\share` -> `\\srv\share`. Identity for
 * anything else, including `\\?\Volume{GUID}\x` (stripping that prefix yields a
 * string that is not a usable path, so it is left intact).
 */
export function stripLocalDevicePrefix(input: string): string {
  const uncDevice = DEVICE_UNC.exec(input);
  if (uncDevice) {
    return `\\\\${uncDevice[1]}`;
  }
  const drive = DEVICE_DRIVE.exec(input);
  if (drive) {
    return drive[1];
  }
  return input;
}

/**
 * Classifies a filesystem path input on both axes.
 *
 * SECURITY: pass a path, never a permission rule pattern (see the module
 * comment). Order is load-bearing: the device prefix is stripped BEFORE the
 * network test, which is what makes `\\?\C:\x` local and `\\?\UNC\srv\share`
 * network — the two axes would otherwise disagree about the same prefix.
 */
export function classifyPathShape(input: string): PathShape {
  const sigil = detectSigil(input);

  // ── Step 2: device-prefix canonicalization ──
  let canonical = input;
  let localMount: 'wsl' | 'devicePath' | 'volumeGuid' | undefined;
  let viaDevice = false;
  const deviceReasons: SuspiciousReason[] = [];

  const uncDevice = DEVICE_UNC.exec(input);
  const drive = DEVICE_DRIVE.exec(input);
  let deviceNamespace = false;
  if (uncDevice) {
    // Falls through to the network test below: this is a remote share.
    canonical = `\\\\${uncDevice[1]}`;
    viaDevice = true;
  } else if (drive) {
    canonical = drive[1];
    localMount = 'devicePath';
  } else if (DEVICE_VOLUME.test(input)) {
    localMount = 'volumeGuid';
  } else if (WSL_MOUNT.test(input)) {
    localMount = 'wsl';
  } else if (DEVICE_ANY.test(input)) {
    // A device path we cannot vouch for (`\\.\COM1`, `\\?\GLOBALROOT\...`).
    // The segment after the prefix is a device name, not a hostname, so this
    // must not read as network — but it still defeats path comparison.
    deviceNamespace = true;
    deviceReasons.push('devicePath');
  }
  if (NT_OBJECT.test(input)) {
    deviceReasons.push('ntObjectPath');
  }

  return {
    input,
    canonical,
    sigil,
    network: classifyNetwork(canonical, localMount, viaDevice, deviceNamespace),
    local: classifyLocal(canonical, deviceReasons),
  };
}

/** True when the path could reach a remote host. */
export function isNetworkShapedPath(input: string): boolean {
  return classifyPathShape(input).network.kind === 'network';
}

/** True when the path uses a spelling that defeats path comparison. */
export function isLocallySuspiciousPath(input: string): boolean {
  return classifyPathShape(input).local.kind === 'suspicious';
}

/**
 * True when network-shaped path enforcement is active on this platform.
 *
 * Enforcement (the ask gate in the read/write/shell permission pipelines and
 * the outright refusal on non-prompting channels) applies on Windows only:
 * the SMB/WebDAV NTLM credential-disclosure threat is a Windows resolver
 * behavior. Classification itself stays platform-independent — callers that
 * merely avoid touching the filesystem (`isFsTouchUnsafePath`) do not consult
 * this switch.
 */
export function isNetworkPathEnforced(): boolean {
  return process.platform === 'win32';
}

/**
 * True when the path must not be handed to the filesystem — no `existsSync`,
 * `statSync`, `realpathSync`, and no `path.resolve`.
 *
 * SECURITY: the fs call itself is the attack. A `stat` on a UNC path performs
 * the NTLM handshake, so this must be consulted BEFORE the call, not after.
 * `path.resolve` is included because it collapses `//srv/share` to `/srv/share`
 * on POSIX, laundering a network path into a local-looking one.
 */
export function isFsTouchUnsafePath(input: string): boolean {
  const shape = classifyPathShape(input);
  if (shape.network.kind === 'network') {
    return true;
  }
  return (
    shape.local.kind === 'suspicious' &&
    shape.local.reasons.some(
      (reason) => reason === 'devicePath' || reason === 'ntObjectPath',
    )
  );
}

// ============================================================================
// Axis 1: network
// ============================================================================

function classifyNetwork(
  canonical: string,
  localMount: 'wsl' | 'devicePath' | 'volumeGuid' | undefined,
  viaDevice: boolean,
  deviceNamespace: boolean,
): NetworkTrust {
  // A vouched local mount short-circuits: `\\?\Volume{GUID}\x` keeps its
  // double-separator prefix, so the test below would otherwise call it network.
  if (localMount) {
    return { kind: 'localMount', mount: localMount };
  }

  // An unvouched device namespace also keeps the prefix, but what follows it is
  // a device name — there is no host to reach.
  if (deviceNamespace) {
    return { kind: 'local' };
  }

  if (DOUBLE_SEP.test(canonical)) {
    return {
      kind: 'network',
      host: uncHostname(canonical),
      via: viaDevice ? 'uncDevice' : hasWebdavMarker(canonical) ? 'webdav' : 'unc',
    };
  }

  const automount = AUTOMOUNT.exec(canonical);
  if (automount) {
    return {
      kind: 'network',
      host: automount[1].toLowerCase(),
      via: 'automount',
    };
  }

  return { kind: 'local' };
}

function hasWebdavMarker(path: string): boolean {
  return WEBDAV_MARKERS.some((marker) => marker.test(path));
}

function uncHostname(canonical: string): string | null {
  const match = UNC_HOST.exec(canonical);
  if (!match) {
    return null;
  }
  // Windows ignores a trailing dot on a hostname, so `\\evil.com.\share` and
  // `\\evil.com\share` reach the same host and must produce the same identity.
  return match[1].toLowerCase().replace(/\.+$/, '');
}

// ============================================================================
// Axis 2: local suspicion
// ============================================================================

function classifyLocal(
  canonical: string,
  deviceReasons: readonly SuspiciousReason[],
): LocalSuspicion {
  // Reasons are COLLECTED, not short-circuited: the previous implementation
  // returned on the first hit, which made the device-path branch unreachable
  // for `\\?\` inputs because the ADS check always fired first.
  const reasons: SuspiciousReason[] = [...deviceReasons];

  if (hasAlternateDataStream(canonical)) {
    reasons.push('alternateDataStream');
  }
  if (CONSECUTIVE_DOTS.test(canonical)) {
    reasons.push('consecutiveDots');
  }

  const segments = canonical.split(/[\\/]/);
  let shortName = false;
  let trailingDot = false;
  let reservedName = false;
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      continue;
    }
    if (SHORT_NAME_83.test(segment)) {
      shortName = true;
    }
    // Windows silently strips trailing dots and spaces, so `.git.` resolves to
    // `.git` — a name-based rule on `.git` would not see it coming.
    if (/[. ]$/.test(segment)) {
      trailingDot = true;
    }
    if (RESERVED_DEVICE_NAME.test(segment)) {
      reservedName = true;
    }
  }
  if (shortName) {
    reasons.push('shortName83');
  }
  if (trailingDot) {
    reasons.push('trailingDot');
  }
  if (reservedName) {
    reasons.push('reservedDeviceName');
  }

  return reasons.length > 0 ? { kind: 'suspicious', reasons } : { kind: 'clean' };
}

function hasAlternateDataStream(canonical: string): boolean {
  // A drive letter's own colon is not a stream separator.
  const withoutDrive = canonical.replace(DRIVE_PREFIX, '');
  return withoutDrive.includes(':');
}

// ============================================================================
// Sigil
// ============================================================================

function detectSigil(input: string): PathSigil {
  const leading = /^[\\/]{2}/.exec(input);
  if (leading) {
    const [first, second] = leading[0];
    if (first !== second) {
      return 'mixed';
    }
    return first === '\\' ? 'backslash' : 'slash';
  }

  const hasBackslash = input.includes('\\');
  const hasSlash = input.includes('/');
  if (hasBackslash && hasSlash) {
    return 'mixed';
  }
  if (hasBackslash) {
    return 'backslash';
  }
  if (hasSlash) {
    return 'slash';
  }
  return 'none';
}
