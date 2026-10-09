/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type { ModDiagnostic, ModRequirement } from './mod-types.js';

export const MOD_TARGET = 'claude-code@2.1.295';

const EVENT_STAGES: Record<string, string> = {
  'session.start': 'M3',
  'session.end': 'M3',
  'turn.start': 'M5',
  'turn.complete': 'M5',
  'tool.call': 'M4',
  'tool.check': 'M4',
  'command.run': 'M4',
  'ui.render': 'M6',
  'ui.close': 'M6',
};
const API_STAGES: Record<string, string> = {
  'command.register': 'M4',
  'session.usage': 'M5',
  'session.cwd': 'M5',
  'process.run': 'M5',
  'clock.now': 'M5',
  'clock.sleep': 'M5',
  'fs.read': 'M5',
  'fs.exists': 'M5',
  'ui.resolve': 'M6',
  'ui.invalidate': 'M6',
  'ui.open': 'M6',
  'ui.close': 'M6',
  'ui.toast': 'M6',
};
const ELEMENTS = new Set([
  'Box',
  'Text',
  'Code',
  'Markdown',
  'Button',
  'Input',
  'Select',
  'Link',
  'Image',
  'Svg',
  'Raster',
  'Client',
]);

export function capabilityStage(
  kind: ModRequirement['kind'],
  name: string,
): string {
  if (kind === 'event')
    return Object.hasOwn(EVENT_STAGES, name)
      ? EVENT_STAGES[name]!
      : 'unclassified';
  if (kind === 'api')
    return Object.hasOwn(API_STAGES, name) ? API_STAGES[name]! : 'unclassified';
  return ELEMENTS.has(name) ? 'M6' : 'unclassified';
}

export function isModRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasModControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

const OPTION_FIELDS = new Set([
  'type',
  'title',
  'description',
  'required',
  'default',
  'options',
  'multiple',
  'sensitive',
  'min',
  'max',
]);
const OPTION_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'directory',
  'file',
]);

export function validateModDeclarations(
  manifest: Record<string, unknown>,
  file: string,
): ModDiagnostic[] {
  const diagnostics: ModDiagnostic[] = [];
  const invalid = (code: string, message: string) => {
    if (diagnostics.length < 99) {
      diagnostics.push({ code, severity: 'error', message, file });
    } else if (diagnostics.length === 99) {
      diagnostics.push({
        code: 'MOD_ANALYSIS_LIMIT',
        severity: 'error',
        message: 'Declaration diagnostics exceeded the analysis limit.',
        file,
      });
    }
  };
  if (manifest['userConfig'] !== undefined) {
    if (!isModRecord(manifest['userConfig'])) {
      invalid('MOD_USER_CONFIG_INVALID', 'userConfig must be an object.');
    } else {
      for (const [key, field] of Object.entries(manifest['userConfig'])) {
        if (diagnostics.length >= 100) break;
        let valid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && isModRecord(field);
        if (!isModRecord(field)) {
          invalid(
            'MOD_USER_CONFIG_INVALID',
            'A userConfig option has an invalid declaration.',
          );
          continue;
        }
        valid &&= Object.keys(field).every((name) => OPTION_FIELDS.has(name));
        valid &&=
          typeof field['type'] === 'string' && OPTION_TYPES.has(field['type']);
        valid &&=
          typeof field['title'] === 'string' &&
          typeof field['description'] === 'string';
        for (const name of ['required', 'multiple', 'sensitive']) {
          valid &&=
            field[name] === undefined || typeof field[name] === 'boolean';
        }
        valid &&= field['multiple'] !== true || field['type'] === 'string';
        if ('default' in field) {
          const value = field['default'];
          if (field['multiple'] === true) {
            valid &&=
              Array.isArray(value) &&
              value.every((item) => typeof item === 'string');
          } else if (field['type'] === 'number') {
            valid &&= typeof value === 'number' && Number.isFinite(value);
          } else if (field['type'] === 'boolean') {
            valid &&= typeof value === 'boolean';
          } else {
            valid &&= typeof value === 'string';
          }
        }
        for (const name of ['min', 'max']) {
          if (field[name] !== undefined) {
            valid &&=
              field['type'] === 'number' &&
              typeof field[name] === 'number' &&
              Number.isFinite(field[name]);
          }
        }
        if (
          typeof field['min'] === 'number' &&
          typeof field['max'] === 'number'
        ) {
          valid &&= field['min'] <= field['max'];
        }
        if (typeof field['default'] === 'number') {
          valid &&=
            typeof field['min'] !== 'number' ||
            field['default'] >= field['min'];
          valid &&=
            typeof field['max'] !== 'number' ||
            field['default'] <= field['max'];
        }
        if (field['options'] !== undefined) {
          valid &&=
            field['type'] === 'string' &&
            field['multiple'] !== true &&
            field['sensitive'] !== true;
          valid &&=
            Array.isArray(field['options']) &&
            field['options'].length > 0 &&
            field['options'].every(
              (option) =>
                typeof option === 'string' &&
                option.length >= 1 &&
                option.length <= 64 &&
                !hasModControlCharacters(option),
            );
          valid &&=
            field['default'] === undefined
              ? field['required'] === true
              : Array.isArray(field['options']) &&
                field['options'].includes(field['default']);
        }
        if (!valid)
          invalid(
            'MOD_USER_CONFIG_INVALID',
            'A userConfig option has an invalid declaration.',
          );
      }
    }
  }
  if (
    manifest['types'] !== undefined &&
    (typeof manifest['types'] !== 'string' ||
      !manifest['types'].endsWith('.d.ts') ||
      path.isAbsolute(manifest['types']) ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(manifest['types']) ||
      manifest['types'].includes('\\') ||
      hasModControlCharacters(manifest['types']) ||
      path.posix.normalize(manifest['types']).startsWith('../'))
  ) {
    invalid('MOD_TYPES_INVALID', 'types must name a local .d.ts file.');
  }
  if (manifest['dependencies'] !== undefined) {
    const valid =
      Array.isArray(manifest['dependencies']) &&
      manifest['dependencies'].every((item) => {
        if (typeof item === 'string') return item.trim().length > 0;
        return (
          isModRecord(item) &&
          typeof item['name'] === 'string' &&
          item['name'].trim().length > 0 &&
          Object.keys(item).every((key) =>
            ['name', 'marketplace', 'version'].includes(key),
          ) &&
          (item['marketplace'] === undefined ||
            typeof item['marketplace'] === 'string') &&
          (item['version'] === undefined || typeof item['version'] === 'string')
        );
      });
    if (!valid)
      invalid(
        'MOD_DEPENDENCIES_INVALID',
        'dependencies must be an array of plugin names or dependency declarations.',
      );
    else if (
      (manifest['dependencies'] as unknown[]).length > 0 &&
      diagnostics.length < 100
    ) {
      diagnostics.push({
        code: 'MOD_DEPENDENCY_DEFERRED',
        severity: 'warning',
        message: 'External plugin dependencies require later resolution.',
        file,
      });
    }
  }
  return diagnostics;
}
