/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import path from 'node:path';
import os from 'node:os';
import type {
  ParsedPowerShellCommand,
  PowerShellCommandElement,
} from './powerShellParser.js';
import { normalizeDash } from './powerShellParser.js';

type ParameterRole = 'read' | 'write' | 'value' | 'switch' | 'leaf';
type PathSpec = {
  parameters: Record<string, ParameterRole>;
  positionals: string[];
  required?: string[];
  defaultPath?: string;
  acceptEdits?: boolean;
};
const common: Record<string, ParameterRole> = {
  verbose: 'switch',
  debug: 'switch',
  whatif: 'switch',
  confirm: 'value',
  erroraction: 'value',
  warningaction: 'value',
  informationaction: 'value',
  progressaction: 'value',
};
const pathParameters = (
  role: 'read' | 'write',
): Record<string, ParameterRole> => ({
  path: role,
  literalpath: role,
  filter: 'value',
  include: 'value',
  exclude: 'value',
  force: 'switch',
});
const contentParameters: Record<string, ParameterRole> = {
  ...pathParameters('write'),
  value: 'value',
  encoding: 'value',
  nonewline: 'switch',
  passthru: 'switch',
};
const specs: Record<string, PathSpec> = {
  'set-content': {
    parameters: contentParameters,
    positionals: ['path', 'value'],
    required: ['path'],
    acceptEdits: true,
  },
  'add-content': {
    parameters: contentParameters,
    positionals: ['path', 'value'],
    required: ['path'],
    acceptEdits: true,
  },
  'clear-content': {
    parameters: pathParameters('write'),
    positionals: ['path'],
    required: ['path'],
    acceptEdits: true,
  },
  'remove-item': {
    parameters: { ...pathParameters('write'), recurse: 'switch' },
    positionals: ['path'],
    required: ['path'],
    acceptEdits: true,
  },
  'get-winevent': {
    parameters: {
      path: 'read',
      logname: 'value',
      listlog: 'value',
      listprovider: 'value',
      providername: 'value',
      maxevents: 'value',
      filterxpath: 'value',
      force: 'switch',
      oldest: 'switch',
    },
    positionals: ['logname'],
  },
  'get-content': {
    parameters: {
      ...pathParameters('read'),
      totalcount: 'value',
      head: 'value',
      tail: 'value',
      raw: 'switch',
      encoding: 'value',
      delimiter: 'value',
      readcount: 'value',
    },
    positionals: ['path'],
    required: ['path'],
  },
  'get-childitem': {
    parameters: {
      ...pathParameters('read'),
      recurse: 'switch',
      depth: 'value',
      name: 'switch',
      attributes: 'value',
      directory: 'switch',
      file: 'switch',
      hidden: 'switch',
      readonly: 'switch',
      system: 'switch',
    },
    positionals: ['path', 'filter'],
    defaultPath: '.',
  },
  'get-item': {
    parameters: pathParameters('read'),
    positionals: ['path'],
    required: ['path'],
  },
  'test-path': {
    parameters: {
      ...pathParameters('read'),
      pathtype: 'value',
      isvalid: 'switch',
      newerthan: 'value',
      olderthan: 'value',
    },
    positionals: ['path'],
    required: ['path'],
  },
  'resolve-path': {
    parameters: { ...pathParameters('read'), relative: 'switch' },
    positionals: ['path'],
    required: ['path'],
  },
  'get-filehash': {
    parameters: { ...pathParameters('read'), algorithm: 'value' },
    positionals: ['path'],
    required: ['path'],
  },
  'get-acl': {
    parameters: { ...pathParameters('read'), audit: 'switch' },
    positionals: ['path'],
    defaultPath: '.',
  },
  'select-string': {
    parameters: {
      ...pathParameters('read'),
      pattern: 'value',
      inputobject: 'value',
      simplematch: 'switch',
      casesensitive: 'switch',
      quiet: 'switch',
      list: 'switch',
      notmatch: 'switch',
      allmatches: 'switch',
      encoding: 'value',
      context: 'value',
      raw: 'switch',
      noemphasis: 'switch',
    },
    positionals: ['pattern', 'path'],
  },
  'format-hex': {
    parameters: {
      ...pathParameters('read'),
      inputobject: 'value',
      encoding: 'value',
      count: 'value',
      offset: 'value',
    },
    positionals: ['path'],
  },
  'out-file': {
    parameters: {
      filepath: 'write',
      literalpath: 'write',
      inputobject: 'value',
      encoding: 'value',
      width: 'value',
      append: 'switch',
      force: 'switch',
      noclobber: 'switch',
      nonewline: 'switch',
    },
    positionals: ['filepath'],
    required: ['filepath'],
  },
  'tee-object': {
    parameters: {
      filepath: 'write',
      literalpath: 'write',
      inputobject: 'value',
      append: 'switch',
      encoding: 'value',
    },
    positionals: ['filepath'],
    required: ['filepath'],
  },
  'copy-item': {
    parameters: {
      ...pathParameters('read'),
      destination: 'write',
      recurse: 'switch',
      container: 'switch',
      passthru: 'switch',
    },
    positionals: ['path', 'destination'],
    required: ['path', 'destination'],
  },
  'move-item': {
    parameters: {
      ...pathParameters('write'),
      destination: 'write',
      passthru: 'switch',
    },
    positionals: ['path', 'destination'],
    required: ['path', 'destination'],
  },
  'rename-item': {
    parameters: {
      ...pathParameters('write'),
      newname: 'leaf',
      passthru: 'switch',
    },
    positionals: ['path', 'newname'],
    required: ['path', 'newname'],
  },
  'new-item': {
    parameters: {
      ...pathParameters('write'),
      name: 'leaf',
      itemtype: 'value',
      value: 'value',
    },
    positionals: ['path'],
    required: ['path'],
  },
};
for (const name of ['invoke-webrequest', 'invoke-restmethod']) {
  specs[name] = {
    parameters: {
      uri: 'value',
      method: 'value',
      body: 'value',
      contenttype: 'value',
      infile: 'read',
      outfile: 'write',
      passthru: 'switch',
      usebasicparsing: 'switch',
      usedefaultcredentials: 'switch',
      timeoutsec: 'value',
      connectiontimeoutseconds: 'value',
      operationtimeoutseconds: 'value',
      maximumredirection: 'value',
      useragent: 'value',
      disablekeepalive: 'switch',
      skiphttperrorcheck: 'switch',
      skipcertificatecheck: 'switch',
    },
    positionals: ['uri'],
    required: ['uri'],
  };
}
for (const name of ['get-itemproperty', 'get-itempropertyvalue']) {
  specs[name] = {
    parameters: { ...pathParameters('read'), name: 'value' },
    positionals: ['path', 'name'],
    required: ['path'],
  };
}
for (const name of ['convert-path', 'split-path']) {
  specs[name] = {
    parameters: {
      ...pathParameters('read'),
      qualifier: 'switch',
      noqualifier: 'switch',
      parent: 'switch',
      leaf: 'switch',
      leafbase: 'switch',
      extension: 'switch',
      isabsolute: 'switch',
    },
    positionals: ['path'],
    required: ['path'],
  };
}
for (const name of ['set-item', 'set-itemproperty', 'remove-itemproperty']) {
  specs[name] = {
    parameters: {
      ...pathParameters('write'),
      name: 'value',
      value: 'value',
      passthru: 'switch',
    },
    positionals:
      name === 'set-item' ? ['path', 'value'] : ['path', 'name', 'value'],
    required: ['path'],
  };
}

export type PowerShellPathAnalysis = {
  targets: Array<{ path: string; access: 'read' | 'write' }>;
  issue?: string;
  acceptEditsEligible: boolean;
};

/** Values come from Parser.ParseInput, never from evaluating user expressions. */
function values(
  element: PowerShellCommandElement | undefined,
): string[] | undefined {
  if (!element) return undefined;
  if (element.staticValue !== undefined) return [element.staticValue];
  if (element.elementType === 'ArrayLiteral') {
    const result = element.children.map(values);
    return result.every((v) => v !== undefined)
      ? result.flatMap((v) => v!)
      : undefined;
  }
  return undefined;
}

/** Native argv is not a cmdlet parameter set. Unknown binding stays ask. */
function analyzeNativeReadPaths(
  command: ParsedPowerShellCommand,
  cwd: string,
): PowerShellPathAnalysis | undefined {
  const name = (command.canonicalName ?? command.name ?? '')
    .toLowerCase()
    .replace(/\.exe$/u, '');
  if (!['findstr', 'tree', 'where'].includes(name)) return undefined;
  const result: PowerShellPathAnalysis = {
    targets: [],
    acceptEditsEligible: false,
  };
  const fail = () => ({
    ...result,
    issue:
      'Native file arguments cannot be safely resolved; confirmation is required.',
  });
  const add = (value: string) => {
    // Control characters cannot be safely approved as file operands.
    if (
      !value ||
      // eslint-disable-next-line no-control-regex
      /[\x00-\x1f*?[\]]/u.test(value) ||
      value.startsWith('~') ||
      /^(?:[\\/]{2}|[^/\\:]+::|[^/\\:]{2,}:)/u.test(value) ||
      /^[A-Za-z]:(?![\\/])/u.test(value)
    )
      return false;
    result.targets.push({ path: path.resolve(cwd, value), access: 'read' });
    return true;
  };
  const args = command.elements.slice(1).map((element) => element.staticValue);
  if (args.some((value) => value === undefined)) return fail();
  const positional: string[] = [];
  let hasPattern = false;
  let recursive = false;
  for (let i = 0; i < args.length; i++) {
    const value = args[i]!;
    if (name === 'findstr' && /^\/(?:g|d):/iu.test(value)) {
      const directorySearch = /^\/d:/iu.test(value);
      const paths = directorySearch
        ? value.slice(3).split(';')
        : [value.slice(3)];
      if (paths.some((entry) => !add(entry))) return fail();
      if (directorySearch) return fail();
      hasPattern = true;
    } else if (name === 'findstr' && /^\/c:/iu.test(value)) {
      hasPattern = true;
    } else if (
      name === 'findstr' &&
      /^\/(?:b|e|l|r|s|i|x|v|n|m|o|p|off|offline)$/iu.test(value)
    ) {
      if (/^\/s$/iu.test(value)) recursive = true;
    } else if (name === 'findstr' && /^\/a:[0-9a-f]{2}$/iu.test(value)) {
      continue;
    } else if (name === 'tree' && /^\/[fa]$/iu.test(value)) {
      continue;
    } else if (name === 'where' && /^\/r$/iu.test(value)) {
      if (!args[++i] || !add(args[i]!)) return fail();
      recursive = true;
    } else if (name === 'where' && /^\/[qft]$/iu.test(value)) {
      continue;
    } else if (value.startsWith('-') || value.startsWith('/')) {
      // Absolute Unix targets can still be checked; native switches cannot.
      if (value.startsWith('/') && value.slice(1).includes('/'))
        positional.push(value);
      else return fail();
    } else positional.push(value);
  }
  if (name === 'findstr') {
    if (!hasPattern && !positional.shift()) return fail();
    // Recursive search can touch denied descendants not named in argv.
    if (recursive || positional.some((value) => !add(value))) return fail();
  } else if (name === 'tree') {
    // A directory read alone cannot enforce rules for each enumerated child.
    if (positional.length > 1 || !add(positional[0] ?? cwd)) return fail();
    result.issue = 'Recursive directory enumeration requires confirmation.';
  } else {
    // PATH/PATHEXT and recursive glob expansion cannot be enumerated statically.
    return fail();
  }
  return result;
}

export function analyzePowerShellPaths(
  command: ParsedPowerShellCommand,
  cwd: string,
  hasPipelineInput = false,
): PowerShellPathAnalysis {
  const result: PowerShellPathAnalysis = {
    targets: [],
    acceptEditsEligible: false,
  };
  const name = (command.canonicalName ?? command.name ?? '').toLowerCase();
  const spec = specs[name];
  const fail = (issue: string) => ({ ...result, issue });
  for (const redirect of command.redirectionDetails ?? []) {
    if (redirect.kind === 'merge') continue;
    if (
      redirect.target?.elementType === 'Variable' &&
      redirect.target.text.toLowerCase() === '$null'
    )
      continue;
    const targets = values(redirect.target ?? undefined);
    if (!targets || targets.length !== 1)
      return fail('A redirection target cannot be statically determined.');
    const target = targets[0];
    if (
      !target ||
      // Control characters make a redirection target unsafe to approve statically.
      // eslint-disable-next-line no-control-regex
      /[\0-\x1f*?[\]]/u.test(target) ||
      target.startsWith('~') ||
      /^(?:[\\/]{2}|[^/\\:]+::|[^/\\:]{2,}:)/u.test(target) ||
      /^[A-Za-z]:(?![\\/])/u.test(target)
    )
      return fail('An unverified redirection target requires confirmation.');
    result.targets.push({ path: path.resolve(cwd, target), access: 'write' });
  }
  // Legacy/incomplete AST must not erase a possible file write.
  if (
    !command.redirectionDetails &&
    command.redirections.some((text) => !/^(?:\*|\d+)>&\d+$/u.test(text.trim()))
  )
    return fail('Redirection details are unavailable.');
  const hasFileRedirection = result.targets.length > 0;
  if (!spec) {
    const native = analyzeNativeReadPaths(command, cwd);
    return native
      ? { ...native, targets: [...result.targets, ...native.targets] }
      : result;
  }
  const parameters = { ...common, ...spec.parameters };
  const bound = new Map<string, string[]>();
  let positional = 0;
  const elements = command.elements.slice(1);
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index];
    let key: string;
    let value: string[] | undefined;
    if (element.elementType === 'Parameter') {
      const supplied = normalizeDash(element.parameterName ?? '').toLowerCase();
      const matches = Object.keys(parameters).filter((key) =>
        key.startsWith(supplied),
      );
      key = Object.hasOwn(parameters, supplied)
        ? supplied
        : matches.length === 1
          ? matches[0]
          : '';
      if (!key) return fail('Unknown or ambiguous PowerShell path parameter.');
      const role = parameters[key];
      if (role === 'switch') {
        if (
          element.children.length &&
          !['true', 'false'].includes(element.children[0]?.staticValue ?? '')
        )
          return fail('Explicit switch expressions require confirmation.');
        value = [];
      } else {
        value = values(element.children[0] ?? elements[++index]);
      }
    } else {
      while (
        bound.has(spec.positionals[positional]) ||
        (bound.has('literalpath') &&
          ['path', 'filepath'].includes(spec.positionals[positional]))
      )
        positional++;
      key = spec.positionals[positional++];
      if (!key)
        return fail(
          'PowerShell positional argument binding cannot be verified.',
        );
      value = values(element);
    }
    if (!value || bound.has(key))
      return fail('PowerShell argument values cannot be statically bound.');
    bound.set(key, value);
  }
  // Path and LiteralPath are mutually exclusive parameter sets.
  if (bound.has('literalpath')) {
    const main = Object.hasOwn(spec.parameters, 'path') ? 'path' : 'filepath';
    if (bound.has(main))
      return fail('Conflicting PowerShell path parameter sets.');
    bound.set(main, bound.get('literalpath')!);
  }
  if (spec.defaultPath && !bound.has('path'))
    bound.set('path', [spec.defaultPath]);
  if (spec.required?.some((key) => !bound.get(key)?.length))
    return fail(
      'PowerShell file target is missing or supplied through the pipeline.',
    );
  if (
    hasPipelineInput &&
    (spec.acceptEdits || name === 'copy-item' || name === 'move-item')
  )
    return fail('Pipeline binding of file operations requires confirmation.');
  if (
    name === 'new-item' &&
    bound.get('itemtype')?.some((value) => /link|junction/i.test(value))
  )
    return fail('Creating filesystem links requires confirmation.');
  for (const [key, entries] of bound) {
    const role = parameters[key];
    if (role !== 'read' && role !== 'write' && role !== 'leaf') continue;
    if (key === 'literalpath') continue;
    for (const value of entries) {
      // Intentionally reject control characters in statically approved file targets.
      // eslint-disable-next-line no-control-regex
      if (!value || /[\0-\x1f]/u.test(value))
        return fail(
          'Empty or control-character file targets require confirmation.',
        );
      if (
        /^(?:[\\/]{2}|[^/\\:]+::|[^/\\:]{2,}:)/u.test(value) ||
        /^[A-Za-z]:(?![\\/])/u.test(value)
      )
        return fail(
          'UNC, provider, and drive-relative targets require confirmation.',
        );
      if (/[?*[\]]/u.test(value) && !bound.has('literalpath'))
        return fail('Wildcard file targets require confirmation.');
      if (value.startsWith('~'))
        return fail('Home-relative file targets require confirmation.');
      if (role === 'leaf') {
        if (/[\\/:]/u.test(value) || value === '.' || value === '..')
          return fail('A new filename must be a single path component.');
        for (const source of bound.get('path') ?? [])
          result.targets.push({
            path: path.resolve(
              cwd,
              name === 'new-item' ? source : path.dirname(source),
              value,
            ),
            access: 'write',
          });
      } else {
        const resolved = path.resolve(cwd, value);
        if (
          name === 'remove-item' &&
          [path.parse(resolved).root, path.resolve(cwd), os.homedir()].includes(
            resolved,
          )
        )
          return fail(
            'Deleting a filesystem root, workspace root, or home requires confirmation.',
          );
        result.targets.push({ path: path.resolve(cwd, value), access: role });
      }
    }
  }
  result.acceptEditsEligible =
    !hasFileRedirection &&
    spec.acceptEdits === true &&
    result.targets.some((target) => target.access === 'write');
  return result;
}
