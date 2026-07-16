/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

export type SedScriptSafety = 'read-only' | 'write' | 'unknown';
export type AwkScriptSafety = SedScriptSafety;

const SED_ADDRESS =
  /^\s*(?:(?:\d+|\$)(?:\s*,\s*(?:\d+|\$))?|\/(?:\\[\s\S]|[^/\\])*\/)?\s*/;
const SED_ADDRESS_AT =
  /\s*(?:(?:\d+|\$)(?:\s*,\s*(?:\d+|\$))?|\/(?:\\[\s\S]|[^/\\])*\/)?\s*/y;
const SAFE_SED_COMMAND = /^[dDgGhHlnNpPqQxz=]$/;
const SAFE_SUBSTITUTION_FLAGS = /^[0-9gIpM]*$/;
const SAFE_SED_OPTION =
  /^(?:-[nElrsuz]|--(?:quiet|silent|line-length(?:=.*)?))$/;
const SED_VALUE_OPTIONS = '-f --file -e --expression -l --line-length'.split(
  ' ',
);
const AWK_STATIC_WRITE =
  /^\s*(?:print|printf)\b(?!\s*\()(?:(?:"(?:\\[\s\S]|[^"\\])*")|[^">|])*>>?\s*"[^"]*"\s*$/;
const AWK_UNKNOWN_OPERATION =
  /(?:system|close)\s*\(|getline\b|@(?:include|load)\b/;
const AWK_PRINT = /\b(?:print|printf)\b/;

function scanDelimitedSection(
  script: string,
  start: number,
  delimiter: string,
): number {
  let escaped = false;
  for (let i = start; i < script.length; i++) {
    const char = script[i]!;
    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === delimiter) {
      return i + 1;
    }
  }
  return -1;
}

function classifySingleSedCommandSafety(script: string): SedScriptSafety {
  const compatibilityUnknown = /(?:^|[^\\])[ewr]\s/.test(script);
  const commandOffset = SED_ADDRESS.exec(script)?.[0].length ?? 0;
  if (commandOffset === script.length) return 'read-only';

  const command = script[commandOffset]!;
  if (command === 'w' || command === 'W')
    return script.slice(commandOffset + 1).trim() ? 'write' : 'unknown';
  if (/[eErR]/.test(command)) return 'unknown';

  if (command === 's') {
    const delimiter = script[commandOffset + 1];
    if (!delimiter || delimiter === '\\' || /\s/.test(delimiter))
      return 'unknown';
    const replacementStart = scanDelimitedSection(
      script,
      commandOffset + 2,
      delimiter,
    );
    if (replacementStart < 0) return 'unknown';
    const flagsStart = scanDelimitedSection(
      script,
      replacementStart,
      delimiter,
    );
    if (flagsStart < 0) return 'unknown';

    const flags = script.slice(flagsStart).trim();
    if (/[;\n{}]/.test(flags)) return 'unknown';
    const writeFlag = flags.indexOf('w');
    if (writeFlag >= 0)
      return flags.slice(writeFlag + 1).trim() ? 'write' : 'unknown';
    if (/[eErRwW]/.test(flags)) return 'unknown';
    if (!SAFE_SUBSTITUTION_FLAGS.test(flags)) return 'unknown';
    return compatibilityUnknown ? 'unknown' : 'read-only';
  }

  if (/[;\n{}]/.test(script.slice(commandOffset + 1))) return 'unknown';
  if (!SAFE_SED_COMMAND.test(command)) return 'unknown';
  return compatibilityUnknown ? 'unknown' : 'read-only';
}

function nextSedSeparator(script: string, start: number): number {
  for (let i = start; i < script.length; i++) {
    if (script[i] === ';' || script[i] === '\n') return i;
  }
  return script.length;
}

export function classifySedScriptSafety(script: string): SedScriptSafety {
  let result: SedScriptSafety = 'read-only';
  let start = 0;
  while (start < script.length) {
    SED_ADDRESS_AT.lastIndex = start;
    const address = SED_ADDRESS_AT.exec(script);
    if (!address) return 'unknown';
    const commandOffset = SED_ADDRESS_AT.lastIndex;
    if (commandOffset === script.length) return result;
    const command = script[commandOffset]!;

    if (command === 'w' || command === 'W') {
      const writer = classifySingleSedCommandSafety(script.slice(start));
      return writer === 'write' ? 'write' : 'unknown';
    }
    if (/[eErR]/.test(command)) return 'unknown';
    if (command !== 's' && !SAFE_SED_COMMAND.test(command)) return 'unknown';

    let separator: number;
    if (command === 's') {
      const delimiter = script[commandOffset + 1];
      if (!delimiter || delimiter === '\\' || /\s/.test(delimiter))
        return 'unknown';
      const replacementStart = scanDelimitedSection(
        script,
        commandOffset + 2,
        delimiter,
      );
      if (replacementStart < 0) return 'unknown';
      const flagsStart = scanDelimitedSection(
        script,
        replacementStart,
        delimiter,
      );
      if (flagsStart < 0) return 'unknown';
      separator = nextSedSeparator(script, flagsStart);
    } else {
      separator = nextSedSeparator(script, commandOffset + 1);
    }

    const current = classifySingleSedCommandSafety(
      script.slice(start, separator),
    );
    if (current === 'write') return 'write';
    if (current === 'unknown') result = 'unknown';
    if (separator === script.length) return result;
    start = separator + 1;
  }
  return result;
}

export function classifySedCommandSafety(args: string[]): SedScriptSafety {
  const terminator = args.indexOf('--');
  const options = args.slice(0, terminator < 0 ? args.length : terminator);
  if (
    options.some(
      (arg, index) =>
        /^(?:--help|--version)$/i.test(arg) &&
        !SED_VALUE_OPTIONS.includes(options[index - 1]!),
    )
  )
    return 'unknown';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') break;
    if (SED_VALUE_OPTIONS.includes(arg)) i++;
    else if (/^-[nErsuz]*e.+/.test(arg)) continue;
    else if (/^(?:-[nErsuz]*[iI]|--in-place(?:=|$))/.test(arg)) return 'write';
  }

  const scripts: string[] = [];
  const scriptArguments = new Set<number>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      if (scripts.length === 0) {
        const script = args[i + 1];
        if (script === undefined || script.startsWith('-')) return 'unknown';
        scripts.push(script);
        scriptArguments.add(i + 1);
      }
      break;
    }
    if (/^(?:-l|--line-length)$/.test(arg) && !args[++i]) return 'unknown';
    if (/^(?:-f|--file(?:=|$))/.test(arg)) return 'unknown';
    if (arg === '-e' || arg === '--expression') {
      const script = args[++i];
      if (!script || script.startsWith('-')) return 'unknown';
      scripts.push(script);
      scriptArguments.add(i);
    } else if (/^(?:-e.+|--expression=)/.test(arg)) {
      const script = arg.slice(arg.startsWith('-e') ? 2 : 13);
      if (script.startsWith('-')) return 'unknown';
      scripts.push(script);
      scriptArguments.add(i);
    } else if (/^--(?!line-length(?:=|$))/.test(arg)) {
      return 'unknown';
    } else if (arg.startsWith('-') && !SAFE_SED_OPTION.test(arg)) {
      return 'unknown';
    } else if (!arg.startsWith('-') && scripts.length === 0) {
      scripts.push(arg);
      scriptArguments.add(i);
    }
  }

  let result: SedScriptSafety = 'read-only';
  for (const script of scripts) {
    const current = classifySedScriptSafety(script);
    if (current === 'write') return 'write';
    if (current === 'unknown') result = 'unknown';
  }
  const remainingArgs = args.filter((_, index) => !scriptArguments.has(index));
  return /(?:^|[^\\])[ewr]\s/.test(remainingArgs.join(' '))
    ? 'unknown'
    : result;
}

function splitAwkStatements(script: string): {
  statements: string[];
  ambiguousSlash: boolean;
} {
  const statements: string[] = [];
  let ambiguousSlash = false;
  let start = 0;
  let escaped = false;
  let inString = false;
  let inRegex = false;
  let previousSignificant = '';

  for (let i = 0; i < script.length; i++) {
    const char = script[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if ((inString || inRegex) && char === '\\') {
      escaped = true;
      continue;
    }
    if (inString) {
      if (char === '"') inString = false;
      continue;
    }
    if (inRegex) {
      if (char === '/') inRegex = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (
      char === '/' &&
      (!previousSignificant || '({[=,:;!~?&|'.includes(previousSignificant))
    ) {
      inRegex = true;
      continue;
    }
    if (char === '/') ambiguousSlash = true;
    if (char === '#') {
      statements.push(script.slice(start, i));
      const newline = script.indexOf('\n', i + 1);
      if (newline < 0) return { statements, ambiguousSlash };
      start = newline + 1;
      i = newline;
      previousSignificant = '\n';
      continue;
    }
    if (/[;{}\n]/.test(char)) {
      statements.push(script.slice(start, i));
      start = i + 1;
      previousSignificant = char;
      continue;
    }
    if (!/\s/.test(char)) previousSignificant = char;
  }
  statements.push(script.slice(start));
  return { statements, ambiguousSlash };
}

export function classifyAwkScriptSafety(script: string): AwkScriptSafety {
  const { statements, ambiguousSlash } = splitAwkStatements(script);
  if (
    !ambiguousSlash &&
    statements.some((statement) => AWK_STATIC_WRITE.test(statement))
  )
    return 'write';
  if (AWK_UNKNOWN_OPERATION.test(script)) return 'unknown';
  return AWK_PRINT.test(script) && /[>|]/.test(script)
    ? 'unknown'
    : 'read-only';
}

export function classifyAwkCommandSafety(args: string[]): AwkScriptSafety {
  let programIndex = -1;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      programIndex = i + 1;
      break;
    }
    if (arg === '-F' || arg === '-v') {
      if (!args[++i]) return 'unknown';
      continue;
    }
    if (/^-[Fv].+/.test(arg)) continue;
    if (arg.startsWith('-')) return 'unknown';
    programIndex = i;
    break;
  }
  if (programIndex < 0) return 'read-only';
  const program = args[programIndex];
  if (program === undefined) return 'unknown';
  const result = classifyAwkScriptSafety(program);
  if (result !== 'read-only') return result;
  return classifyAwkScriptSafety(args.join(' ')) === 'read-only'
    ? 'read-only'
    : 'unknown';
}

export function hasShellBraceExpansion(text: string): boolean {
  let braceDepth = 0;
  let previousDot = false;
  for (const char of text) {
    if (char === '{') {
      braceDepth++;
      previousDot = false;
    } else if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      previousDot = false;
    } else if (braceDepth > 0) {
      if (char === ',' || (char === '.' && previousDot)) return true;
      previousDot = char === '.';
    }
  }
  return false;
}

export function hasShellPatternExpansion(text: string): boolean {
  return /[[*?]/.test(text) || hasShellBraceExpansion(text);
}
