/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { extensionsCommand } from './extensions.js';
import { updateCommand } from './extensions/update.js';
import { disableCommand } from './extensions/disable.js';
import { enableCommand } from './extensions/enable.js';
import { linkCommand } from './extensions/link.js';
import { newCommand } from './extensions/new.js';
import yargs from 'yargs';

describe('extensions command', () => {
  it('should have correct command name', () => {
    expect(extensionsCommand.command).toBe('extensions <command>');
  });

  it('should have a description', () => {
    expect(extensionsCommand.describe).toBe('Manage Qwen Code extensions.');
  });

  it('should require a subcommand', () => {
    const parser = yargs([])
      .command(extensionsCommand)
      .fail(false)
      .locale('en');

    expect(() => parser.parse('extensions')).toThrow();
  });

  it('should register install subcommand', () => {
    const parser = yargs([])
      .command(extensionsCommand)
      .fail(false)
      .locale('en');

    // This should throw as 'install' requires a source argument
    expect(() => parser.parse('extensions install')).toThrow(
      'Not enough non-option arguments',
    );
  });

  it('should register uninstall subcommand', () => {
    const parser = yargs([])
      .command(extensionsCommand)
      .fail(false)
      .locale('en');

    expect(() => parser.parse('extensions uninstall')).toThrow(
      'Not enough non-option arguments',
    );
  });

  it('should register list subcommand', () => {
    const parser = yargs([])
      .command(extensionsCommand)
      .fail(false)
      .locale('en');

    // list doesn't require arguments, so it should not throw
    expect(() => parser.parse('extensions list')).not.toThrow();
  });

  it('should register update subcommand', () => {
    const parser = yargs([]).command(updateCommand).fail(false).locale('en');

    expect(() => parser.parse('update')).toThrow(
      'Either an extension name or --all must be provided',
    );
  });

  it('should register disable subcommand', () => {
    const parser = yargs([]).command(disableCommand).fail(false).locale('en');

    expect(() => parser.parse('disable')).toThrow(
      'Not enough non-option arguments',
    );
  });

  it('should register enable subcommand', () => {
    const parser = yargs([]).command(enableCommand).fail(false).locale('en');

    expect(() => parser.parse('enable')).toThrow(
      'Not enough non-option arguments',
    );
  });

  it('should register link subcommand', () => {
    const parser = yargs([]).command(linkCommand).fail(false).locale('en');

    expect(() => parser.parse('link')).toThrow(
      'Not enough non-option arguments',
    );
  });

  it('should register new subcommand', async () => {
    const parser = yargs([]).command(newCommand).fail(false).locale('en');

    await expect(parser.parseAsync('new')).rejects.toThrow(
      'Not enough non-option arguments',
    );
  });
});
