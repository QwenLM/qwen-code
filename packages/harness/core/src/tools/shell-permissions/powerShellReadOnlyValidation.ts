/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getPlatform } from '../../utils/platform.js';
import {
  normalizePowerShellFlag as normalizeFlag,
  type ParsedPowerShellCommand,
} from './powerShellParser.js';
import { ALLOWLIST_INDEX } from './shellReadOnlyCommandConfigs.js';
import { validateFlags as validateNativeFlags } from './shellCommandValidation.js';

function stripQuotes(value: string): string {
  return value.trim().replace(/^(['"])(.*)\1$/su, '$2');
}

type ReadOnlySpec = readonly string[];

const READ_ONLY_COMMANDS: Readonly<Record<string, ReadOnlySpec>> = {
  'get-childitem': [
    'Path',
    'LiteralPath',
    'Filter',
    'Include',
    'Exclude',
    'Recurse',
    'Depth',
    'Name',
    'Force',
    'Attributes',
    'Directory',
    'File',
    'Hidden',
    'ReadOnly',
    'System',
  ],
  'get-content': [
    'Path',
    'LiteralPath',
    'TotalCount',
    'Head',
    'Tail',
    'Raw',
    'Encoding',
    'Delimiter',
    'ReadCount',
  ],
  'get-item': ['Path', 'LiteralPath', 'Force', 'Stream'],
  'get-itemproperty': ['Path', 'LiteralPath', 'Name'],
  'test-path': [
    'Path',
    'LiteralPath',
    'PathType',
    'Filter',
    'Include',
    'Exclude',
    'IsValid',
    'NewerThan',
    'OlderThan',
  ],
  'resolve-path': ['Path', 'LiteralPath', 'Relative'],
  'get-filehash': ['Path', 'LiteralPath', 'Algorithm', 'InputStream'],
  'get-acl': ['Path', 'LiteralPath', 'Audit', 'Filter', 'Include', 'Exclude'],
  'set-location': ['Path', 'LiteralPath', 'PassThru', 'StackName'],
  'push-location': ['Path', 'LiteralPath', 'PassThru', 'StackName'],
  'pop-location': ['PassThru', 'StackName'],
  'select-string': [
    'Path',
    'LiteralPath',
    'Pattern',
    'InputObject',
    'SimpleMatch',
    'CaseSensitive',
    'Quiet',
    'List',
    'NotMatch',
    'AllMatches',
    'Encoding',
    'Context',
    'Raw',
    'NoEmphasis',
  ],
  'convertto-json': [
    'InputObject',
    'Depth',
    'Compress',
    'EnumsAsStrings',
    'AsArray',
  ],
  'convertfrom-json': ['InputObject', 'Depth', 'AsHashtable', 'NoEnumerate'],
  'convertto-csv': [
    'InputObject',
    'Delimiter',
    'NoTypeInformation',
    'NoHeader',
    'UseQuotes',
  ],
  'convertfrom-csv': ['InputObject', 'Delimiter', 'Header', 'UseCulture'],
  'convertto-xml': ['InputObject', 'Depth', 'As', 'NoTypeInformation'],
  'convertto-html': [
    'InputObject',
    'Property',
    'Head',
    'Title',
    'Body',
    'Pre',
    'Post',
    'As',
    'Fragment',
  ],
  'format-hex': [
    'Path',
    'LiteralPath',
    'InputObject',
    'Encoding',
    'Count',
    'Offset',
  ],
  'get-member': [
    'InputObject',
    'MemberType',
    'Name',
    'Static',
    'View',
    'Force',
  ],
  'get-unique': ['InputObject', 'AsString', 'CaseInsensitive', 'OnType'],
  'compare-object': [
    'ReferenceObject',
    'DifferenceObject',
    'Property',
    'SyncWindow',
    'CaseSensitive',
    'Culture',
    'ExcludeDifferent',
    'IncludeEqual',
    'PassThru',
  ],
  'join-string': [
    'InputObject',
    'Property',
    'Separator',
    'SingleQuote',
    'DoubleQuote',
    'FormatString',
  ],
  'get-random': [
    'InputObject',
    'Minimum',
    'Maximum',
    'Count',
    'SetSeed',
    'Shuffle',
  ],
  'convert-path': ['Path', 'LiteralPath'],
  'join-path': ['Path', 'ChildPath', 'AdditionalChildPath'],
  'split-path': [
    'Path',
    'LiteralPath',
    'Qualifier',
    'NoQualifier',
    'Parent',
    'Leaf',
    'LeafBase',
    'Extension',
    'IsAbsolute',
  ],
  'get-itempropertyvalue': ['Path', 'LiteralPath', 'Name'],
  'get-psprovider': ['PSProvider'],
  'get-computerinfo': ['Property'],
  'get-host': [],
  'get-date': ['Date', 'Format', 'UFormat', 'DisplayHint', 'AsUTC'],
  'get-location': ['PSProvider', 'PSDrive', 'Stack', 'StackName'],
  'get-psdrive': ['Name', 'PSProvider', 'Scope'],
  'get-module': [
    'Name',
    'ListAvailable',
    'All',
    'FullyQualifiedName',
    'PSEdition',
  ],
  'get-alias': ['Name', 'Definition', 'Scope', 'Exclude'],
  'get-history': ['Id', 'Count'],
  'get-culture': ['Name', 'NoUserOverrides', 'ListAvailable'],
  'get-uiculture': [],
  'get-timezone': ['Name', 'Id', 'ListAvailable'],
  'get-uptime': ['Since'],
  'write-output': ['InputObject', 'NoEnumerate'],
  'write-host': [
    'Object',
    'NoNewline',
    'Separator',
    'ForegroundColor',
    'BackgroundColor',
  ],
  'start-sleep': ['Seconds', 'Milliseconds', 'Duration'],
  'format-table': [
    'AutoSize',
    'RepeatHeader',
    'HideTableHeaders',
    'Wrap',
    'Property',
    'GroupBy',
    'View',
    'ShowError',
    'DisplayError',
    'Force',
    'Expand',
    'InputObject',
  ],
  'format-list': [
    'Property',
    'GroupBy',
    'View',
    'ShowError',
    'DisplayError',
    'Force',
    'Expand',
    'InputObject',
  ],
  'format-wide': [
    'Property',
    'AutoSize',
    'Column',
    'GroupBy',
    'View',
    'ShowError',
    'DisplayError',
    'Force',
    'Expand',
    'InputObject',
  ],
  'format-custom': [
    'Property',
    'Depth',
    'GroupBy',
    'View',
    'ShowError',
    'DisplayError',
    'Force',
    'Expand',
    'InputObject',
  ],
  'measure-object': [
    'InputObject',
    'Property',
    'StandardDeviation',
    'Sum',
    'AllStats',
    'Average',
    'Maximum',
    'Minimum',
    'Line',
    'Word',
    'Character',
    'IgnoreWhiteSpace',
  ],
  'select-object': [
    'InputObject',
    'Property',
    'ExcludeProperty',
    'ExpandProperty',
    'Unique',
    'CaseInsensitive',
    'Last',
    'First',
    'Skip',
    'SkipLast',
    'Wait',
    'Index',
    'SkipIndex',
  ],
  'sort-object': [
    'Stable',
    'Descending',
    'Unique',
    'Top',
    'Bottom',
    'InputObject',
    'Property',
    'Culture',
    'CaseSensitive',
  ],
  'group-object': [
    'NoElement',
    'AsHashTable',
    'AsString',
    'InputObject',
    'Property',
    'Culture',
    'CaseSensitive',
  ],
  'where-object': [
    'InputObject',
    'Property',
    'Value',
    'EQ',
    'CEQ',
    'NE',
    'CNE',
    'GT',
    'CGT',
    'LT',
    'CLT',
    'GE',
    'CGE',
    'LE',
    'CLE',
    'Like',
    'CLike',
    'NotLike',
    'CNotLike',
    'Match',
    'CMatch',
    'NotMatch',
    'CNotMatch',
    'Contains',
    'CContains',
    'NotContains',
    'CNotContains',
    'In',
    'CIn',
    'NotIn',
    'CNotIn',
    'Is',
    'IsNot',
    'Not',
  ],
  'out-string': ['Stream', 'Width', 'NoNewline', 'InputObject'],
  'out-host': ['Paging', 'InputObject'],
  'out-null': ['InputObject'],
  'get-netadapter': [
    'Name',
    'InterfaceDescription',
    'InterfaceIndex',
    'Physical',
  ],
  'get-netipaddress': [
    'InterfaceIndex',
    'InterfaceAlias',
    'AddressFamily',
    'Type',
  ],
  'get-netroute': [
    'InterfaceIndex',
    'InterfaceAlias',
    'AddressFamily',
    'DestinationPrefix',
  ],
  'get-dnsclient': ['InterfaceIndex', 'InterfaceAlias'],
  'get-winevent': [
    'LogName',
    'ListLog',
    'ListProvider',
    'ProviderName',
    'Path',
    'MaxEvents',
    'FilterXPath',
    'Force',
    'Oldest',
  ],
  ipconfig: ['all', 'allcompartments'],
  netstat: ['a', 'b', 'e', 'f', 'n', 'o', 'p', 'q', 'r', 's', 't', 'x', 'y'],
  systeminfo: ['FO', 'NH'],
  tasklist: ['M', 'SVC', 'V', 'FI', 'FO', 'NH'],
  'where.exe': ['R', 'Q', 'F', 'T'],
  hostname: ['a', 'd', 'f', 'i', 'I', 's', 'y', 'A'],
  whoami: ['user', 'groups', 'claims', 'priv', 'logonid', 'all', 'fo', 'nh'],
  ver: [],
  arp: ['a', 'g', 'v', 'n'],
  getmac: ['FO', 'NH', 'V'],
  tree: ['F', 'A', 'Q', 'L'],
  findstr: [
    'B',
    'E',
    'L',
    'R',
    'S',
    'I',
    'X',
    'V',
    'N',
    'M',
    'O',
    'P',
    'C',
    'G',
    'D',
    'A',
  ],
};

const NATIVE_COMMANDS_WITHOUT_POSITIONAL_ARGS = new Set([
  'hostname',
  'whoami',
  'ver',
  'arp',
  'ipconfig',
]);
function isAllowedFlag(flag: string, spec: ReadOnlySpec): boolean {
  const normalized = flag.toLowerCase();
  if (spec.some((candidate) => candidate.toLowerCase() === normalized))
    return true;
  const matches = spec.filter((candidate) =>
    candidate.toLowerCase().startsWith(normalized),
  );
  return matches.length === 1;
}

function validateFlags(
  command: ParsedPowerShellCommand,
  spec: ReadOnlySpec,
): boolean {
  for (const argument of command.args) {
    const flag = normalizeFlag(argument);
    if (flag && !isAllowedFlag(flag, spec)) return false;
  }
  return true;
}

function validateGit(command: ParsedPowerShellCommand): boolean {
  // Reuse argv-based specs, never parse PowerShell source as Bash.
  const args = command.args.map(
    (raw, index) =>
      command.elements[index + 1]?.staticValue ?? stripQuotes(raw),
  );
  const tokens = ['git', ...args];
  const candidate = ALLOWLIST_INDEX.get('git')?.find(({ keyTokens }) =>
    keyTokens.every((token, index) => tokens[index] === token),
  );
  if (!candidate) return false;
  const { config, keyTokens } = candidate;
  return (
    validateNativeFlags(tokens, keyTokens.length, config, {
      commandName: keyTokens.join(' '),
    }) &&
    !config.additionalIsDangerousCallback?.(
      command.text,
      tokens.slice(keyTokens.length),
    )
  );
}

const dockerFlags: Record<
  string,
  Record<string, 'none' | 'string' | 'number'>
> = {
  ps: {
    '--all': 'none',
    '-a': 'none',
    '--filter': 'string',
    '-f': 'string',
    '--format': 'string',
    '--last': 'number',
    '-n': 'number',
    '--latest': 'none',
    '-l': 'none',
    '--no-trunc': 'none',
    '--quiet': 'none',
    '-q': 'none',
    '--size': 'none',
    '-s': 'none',
  },
  images: {
    '--all': 'none',
    '-a': 'none',
    '--digests': 'none',
    '--filter': 'string',
    '-f': 'string',
    '--format': 'string',
    '--no-trunc': 'none',
    '--quiet': 'none',
    '-q': 'none',
  },
  inspect: {
    '--format': 'string',
    '-f': 'string',
    '--size': 'none',
    '-s': 'none',
    '--type': 'string',
  },
  logs: {
    '--details': 'none',
    '--follow': 'none',
    '-f': 'none',
    '--since': 'string',
    '--until': 'string',
    '--tail': 'string',
    '-n': 'string',
    '--timestamps': 'none',
    '-t': 'none',
  },
  stats: {
    '--all': 'none',
    '-a': 'none',
    '--format': 'string',
    '--no-stream': 'none',
    '--no-trunc': 'none',
  },
  version: { '--format': 'string', '-f': 'string' },
  info: { '--format': 'string', '-f': 'string' },
  top: {},
  port: {},
  diff: {},
  events: {
    '--filter': 'string',
    '-f': 'string',
    '--format': 'string',
    '--since': 'string',
    '--until': 'string',
  },
};
function validateDocker(command: ParsedPowerShellCommand): boolean {
  const args = command.args.map(
    (raw, index) =>
      command.elements[index + 1]?.staticValue ?? stripQuotes(raw),
  );
  if (args.length === 0) return true;
  const spec = dockerFlags[args[0]];
  return (
    !!spec &&
    validateNativeFlags(
      args,
      1,
      { safeFlags: spec },
      { commandName: `docker ${args[0]}` },
    )
  );
}

function validateRoute(command: ParsedPowerShellCommand): boolean {
  const args = command.args.map(stripQuotes);
  const firstPositional = args.find((arg) => !arg.startsWith('-'));
  return (
    firstPositional?.toLowerCase() === 'print' &&
    args.every((arg) => /^(?:print|-4|-6)$/iu.test(arg))
  );
}

export function validateReadOnlyPowerShellCommand(
  command: ParsedPowerShellCommand,
): boolean {
  const name = (command.canonicalName ?? command.name ?? '').toLowerCase();
  if (name === 'git' || name === 'git.exe') return validateGit(command);
  if (name === 'gh' || name === 'gh.exe') return false;
  if (name === 'docker' || name === 'docker.exe')
    return validateDocker(command);
  if (name === 'dotnet' || name === 'dotnet.exe') {
    return (
      command.args.length > 0 &&
      command.args.every((arg) =>
        /^(?:--list-runtimes|--list-sdks)$/iu.test(stripQuotes(arg)),
      )
    );
  }
  if (name === 'route' || name === 'route.exe') return validateRoute(command);
  const baseName = name.replace(/\.exe$/u, '');
  // An executable sharing a cmdlet's name is not that cmdlet.
  if (name.endsWith('.exe') && baseName.includes('-')) return false;
  const spec = READ_ONLY_COMMANDS[baseName] ?? READ_ONLY_COMMANDS[name];
  if (spec === undefined) return false;
  if (!baseName.includes('-')) {
    // Native argv has no cmdlet abbreviations, Unicode dash normalization,
    // or case-insensitive flags on Unix. Keep values exactly as parsed.
    const windows = getPlatform() === 'windows';
    return command.args.every((raw, index) => {
      const value =
        command.elements[index + 1]?.staticValue ?? stripQuotes(raw);
      const match = windows
        ? /^(?:-|\/)([a-z0-9]+)(?::(.+))?$/iu.exec(value)
        : /^-([a-zA-Z]+)$/u.exec(value);
      if (!match) {
        if (/^[-/]/u.test(value)) return false;
        return !NATIVE_COMMANDS_WITHOUT_POSITIONAL_ARGS.has(baseName);
      }
      if (match[2] && NATIVE_COMMANDS_WITHOUT_POSITIONAL_ARGS.has(baseName))
        return false;
      return spec.some((flag) =>
        windows
          ? flag.toLowerCase() === match[1].toLowerCase()
          : flag === match[1],
      );
    });
  }
  return validateFlags(command, spec);
}

/** Windows native argument re-parsing and cwd lookup are not cmdlet semantics. */
export function powerShellNativeSafetyIssue(
  command: ParsedPowerShellCommand,
  cwd?: string,
): string | undefined {
  if (getPlatform() !== 'windows') return undefined;
  const name = command.canonicalName ?? command.name ?? '';
  const native = command.nameType === 'Application' || !name.includes('-');
  if (!native) return undefined;
  for (const [index, raw] of command.args.entries()) {
    const value = command.elements[index + 1]?.staticValue ?? stripQuotes(raw);
    if (value.includes('"') || /[\r\n]/u.test(value))
      return 'Windows native argument quoting cannot be safely verified.';
  }
  if (cwd && name && !/[\\/:]/u.test(name)) {
    const candidates = path.extname(name)
      ? [name]
      : [
          name,
          ...['.exe', '.com', '.cmd', '.bat', '.ps1'].map((ext) => name + ext),
        ];
    if (candidates.some((candidate) => existsSync(path.join(cwd, candidate))))
      return 'A file in the execution directory may shadow the native command.';
  }
  return undefined;
}
