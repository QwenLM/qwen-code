/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ExtensionEnablementConfig {
  overrides: string[];
}

export interface AllExtensionsEnablementConfig {
  [extensionName: string]: ExtensionEnablementConfig;
}

export class Override {
  constructor(
    public baseRule: string,
    public isDisable: boolean,
    public includeSubdirs: boolean,
  ) {}

  static fromInput(inputRule: string, includeSubdirs: boolean): Override {
    const isDisable = inputRule.startsWith('!');
    let baseRule = isDisable ? inputRule.substring(1) : inputRule;
    baseRule = ensureLeadingAndTrailingSlash(baseRule);
    return new Override(baseRule, isDisable, includeSubdirs);
  }

  static fromFileRule(fileRule: string): Override {
    const isDisable = fileRule.startsWith('!');
    let baseRule = isDisable ? fileRule.substring(1) : fileRule;
    const includeSubdirs = baseRule.endsWith('*');
    baseRule = includeSubdirs
      ? baseRule.substring(0, baseRule.length - 1)
      : baseRule;
    return new Override(baseRule, isDisable, includeSubdirs);
  }

  conflictsWith(other: Override): boolean {
    if (this.baseRule === other.baseRule) {
      return (
        this.includeSubdirs !== other.includeSubdirs ||
        this.isDisable !== other.isDisable
      );
    }
    return false;
  }

  isEqualTo(other: Override): boolean {
    return (
      this.baseRule === other.baseRule &&
      this.includeSubdirs === other.includeSubdirs &&
      this.isDisable === other.isDisable
    );
  }

  asRegex(): RegExp {
    return globToRegex(`${this.baseRule}${this.includeSubdirs ? '*' : ''}`);
  }

  isChildOf(parent: Override) {
    if (!parent.includeSubdirs) {
      return false;
    }
    return parent.asRegex().test(this.baseRule);
  }

  output(): string {
    return `${this.isDisable ? '!' : ''}${this.baseRule}${this.includeSubdirs ? '*' : ''}`;
  }

  matchesPath(path: string) {
    return this.asRegex().test(path);
  }
}

const ensureLeadingAndTrailingSlash = function (dirPath: string): string {
  // Normalize separators to forward slashes for consistent matching across platforms.
  let result = dirPath.replace(/\\/g, '/');
  if (result.charAt(0) !== '/') {
    result = '/' + result;
  }
  if (result.charAt(result.length - 1) !== '/') {
    result = result + '/';
  }
  return result;
};

/**
 * Converts a glob pattern to a RegExp object.
 * This is a simplified implementation that supports `*`.
 *
 * @param glob The glob pattern to convert.
 * @returns A RegExp object.
 */
function globToRegex(glob: string): RegExp {
  const regexString = glob
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special regex characters
    .replace(/(\/?)\*/g, '($1.*)?'); // Convert * to optional group

  return new RegExp(`^${regexString}$`);
}
