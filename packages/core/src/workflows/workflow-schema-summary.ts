/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function summarizeWorkflowInputSchema(schema: unknown): string {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return 'valid JSON matching the workflow input schema';
  }
  const record = schema as Record<string, unknown>;
  const parts: string[] = [];
  const required = Array.isArray(record['required'])
    ? record['required'].filter((item): item is string => typeof item === 'string')
    : [];
  if (required.length > 0) parts.push(`required fields: ${required.join(', ')}`);
  const properties = record['properties'];
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    const entries = Object.entries(properties as Record<string, unknown>);
    const propertySummary = entries.slice(0, 8).map(([name, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return name;
      }
      const prop = value as Record<string, unknown>;
      const rawType = prop['type'];
      const type = isStringValue(rawType) ? rawType : undefined;
      const enumValues = Array.isArray(prop['enum'])
        ? prop['enum']
            .filter(
              (item): item is string | number | boolean =>
                typeof item === 'string' ||
                typeof item === 'number' ||
                typeof item === 'boolean',
            )
            .slice(0, 6)
        : [];
      const rawDescription = prop['description'];
      const description =
        isStringValue(rawDescription) && rawDescription.trim()
          ? rawDescription.trim()
          : undefined;
      const details = [
        type,
        enumValues.length > 0 ? `enum=${enumValues.join('|')}` : undefined,
        description,
      ].filter(Boolean);
      return details.length > 0 ? `${name}:${details.join(' ')}` : name;
    });
    if (propertySummary.length > 0) {
      parts.push(
        `properties: ${propertySummary.join(', ')}${
          entries.length > propertySummary.length
            ? `, +${entries.length - propertySummary.length} more`
            : ''
        }`,
      );
    }
  }
  return parts.length > 0 ? parts.join('; ') : 'valid JSON matching the schema';
}

function isStringValue(value: unknown): value is string {
  return typeof value === 'string';
}
