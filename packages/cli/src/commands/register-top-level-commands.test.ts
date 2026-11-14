/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yargs from 'yargs';
import type { Argv, CommandModule } from 'yargs';
import { commandMetadata } from './command-metadata.js';

const language = vi.hoisted(() => ({ current: 'en' }));
vi.mock('../i18n/index.js', () => ({
  t: (key: string) => `${language.current}:${key}`,
  initializeI18n: vi.fn(),
  resolveLanguageSetting: (value: string) => value,
}));

const keys = Object.keys(commandMetadata) as Array<
  keyof typeof commandMetadata
>;
const loaded: string[] = [];
const handler = vi.fn();
const nestedHandler = vi.fn();
const builder = vi.fn((parser: Argv, _help?: boolean) =>
  parser
    .option('fixture-value', { type: 'string', default: 'default' })
    .option('required-value', {
      type: 'string',
      requiresArg: true,
      choices: ['valid'],
    })
    .command('nested <value>', 'nested fixture', {}, nestedHandler),
);

function parserFor(args: string[]) {
  return yargs(args)
    .scriptName('qwen')
    .wrap(240)
    .exitProcess(false)
    .help()
    .strict()
    .command('$0', false, (parser) => parser.option('acp', { type: 'boolean' }))
    .fail((message, error) => {
      throw error ?? new Error(message);
    });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  language.current = 'en';
  loaded.length = 0;
  for (const key of keys) {
    vi.doMock(`./${key}.js`, () => {
      loaded.push(key);
      const command: CommandModule = {
        ...commandMetadata[key],
        builder,
        handler,
      };
      return { [`${key}Command`]: command };
    });
  }
});

afterEach(() => {
  for (const key of keys) vi.doUnmock(`./${key}.js`);
});

describe('lazy top-level commands', () => {
  it('registers and parses the default ACP options without loading commands', async () => {
    const { registerTopLevelCommands } = await import(
      './register-top-level-commands.js'
    );
    const parser = parserFor(['--acp']);
    await registerTopLevelCommands(parser, ['--acp']);
    expect(await parser.parseAsync()).toMatchObject({ acp: true });
    expect(loaded).toEqual([]);
    expect(builder).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('loads only the selected command and preserves its builder defaults', async () => {
    const { registerTopLevelCommands } = await import(
      './register-top-level-commands.js'
    );
    const parser = parserFor(['attach']);
    const commands = vi.spyOn(parser, 'command');
    await registerTopLevelCommands(parser, ['attach']);
    expect(loaded).toEqual(['attach']);
    expect(commands.mock.calls).toContainEqual([
      expect.objectContaining({ command: 'attach', builder, handler }),
    ]);
    await parser.parseAsync();
    expect(loaded).toEqual(['attach']);
    expect(builder).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ fixtureValue: 'default' }),
    );
  });

  it('preserves command aliases and nested handlers', async () => {
    const { registerTopLevelCommands } = await import(
      './register-top-level-commands.js'
    );
    const args = ['hook', 'nested', 'value'];
    const parser = parserFor(args);
    await registerTopLevelCommands(parser, args);
    await parser.parseAsync();
    expect(loaded).toEqual(['hooks']);
    expect(nestedHandler).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'value' }),
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('awaits the selected handler and propagates import failures', async () => {
    const { registerTopLevelCommands } = await import(
      './register-top-level-commands.js'
    );
    let finish!: () => void;
    handler.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const parser = parserFor(['attach']);
    await registerTopLevelCommands(parser, ['attach']);
    const complete = vi.fn();
    const parsing = parser.parseAsync().then(complete);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(complete).not.toHaveBeenCalled();
    finish();
    await parsing;
    expect(complete).toHaveBeenCalledOnce();

    vi.doMock('./daemon.js', () => {
      throw new Error('fixture module import failed');
    });
    const failing = parserFor(['daemon']);
    await expect(
      registerTopLevelCommands(failing, ['daemon']),
    ).rejects.toMatchObject({
      cause: { message: 'fixture module import failed' },
    });
  });

  it.each([
    ['attach', '--required-value'],
    ['attach', '--required-value', 'invalid'],
    ['attach', '--unknown-option'],
    ['--_=attach', '--required-value'],
    ['--_="attach"', '--required-value'],
  ])(
    'retains synchronous validation and failure rendering for %j',
    async (...args) => {
      const { registerTopLevelCommands } = await import(
        './register-top-level-commands.js'
      );
      const parser = parserFor(args);
      const fail = vi.fn((message: string) => {
        throw new Error(`rendered: ${message}`);
      });
      parser.fail(fail);
      await registerTopLevelCommands(parser, args);
      await expect(async () => parser.parse()).rejects.toThrow('rendered:');
      expect(fail).toHaveBeenCalledOnce();
      expect(loaded).toEqual(['attach']);
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it('preserves original builder and asynchronous handler exceptions', async () => {
    const { registerTopLevelCommands } = await import(
      './register-top-level-commands.js'
    );
    const failure = new Error('original command exception');
    const parser = parserFor(['attach']);
    const fail = vi.fn((_message: string, error: Error | undefined) => {
      throw error;
    });
    parser.fail(fail);
    await registerTopLevelCommands(parser, ['attach']);
    builder.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(async () => parser.parse()).rejects.toBe(failure);
    expect(fail).not.toHaveBeenCalled();

    const handlerParser = parserFor(['daemon']);
    handlerParser.fail(fail);
    await registerTopLevelCommands(handlerParser, ['daemon']);
    handler.mockRejectedValueOnce(failure);
    await expect(async () => handlerParser.parse()).rejects.toBe(failure);
    expect(fail).toHaveBeenCalledWith(null, failure, expect.anything());
  });

  it('allows conservative command-name matches in option values without dispatching them', async () => {
    const { registerTopLevelCommands } = await import(
      './register-top-level-commands.js'
    );
    const args = ['--acp', '--prompt', 'path/to/attach.log'];
    const parser = parserFor(args).option('prompt', { type: 'string' });
    await registerTopLevelCommands(parser, args);
    expect(await parser.parse()).toMatchObject({ acp: true, prompt: args[2] });
    expect(loaded).toEqual(['attach']);
    expect(builder).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('loads the requested help builder without running a handler', async () => {
    const { registerTopLevelCommands } = await import(
      './register-top-level-commands.js'
    );
    const args = ['daemon', '--help'];
    const parser = parserFor(args);
    await registerTopLevelCommands(parser, args);
    let output = '';
    await parser.parseAsync(
      args,
      (_error: Error | undefined, _argv: unknown, text: string) => {
        output = text;
      },
    );
    expect(output).toContain('--fixture-value');
    expect(loaded).toEqual(['daemon']);
    expect(builder.mock.calls[0]?.[1]).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    '--get-yargs-completions',
    '--no-get-yargs-completions',
    '--get-yargs-completions=false',
    '--get-yargs-completions.nested',
    '--get-yargs-completions.nested=false',
    'prompt containing get-yargs-completions',
  ])(
    'keeps original synchronous builders for marker form %s',
    async (marker) => {
      const { registerTopLevelCommands } = await import(
        './register-top-level-commands.js'
      );
      const parser = parserFor([]);
      const original = vi.spyOn(parser, 'command');
      await registerTopLevelCommands(parser, [marker]);
      expect(loaded).toEqual(keys);
      for (const [command] of original.mock.calls) {
        expect(command).toMatchObject({ builder, handler });
      }
    },
  );

  it('retains auth translation before a delayed real-module import and update getter', async () => {
    const { registerTopLevelCommands } = await import(
      './register-top-level-commands.js'
    );
    language.current = 'zh';
    vi.doUnmock('./auth.js');
    vi.doUnmock('./update.js');
    const [{ authCommand }, { updateCommand }] = await Promise.all([
      import('./auth.js'),
      import('./update.js'),
    ]);
    expect(authCommand.describe).toBe(`en:${commandMetadata.auth.describe}`);
    expect(updateCommand.describe).toBe(
      `zh:${commandMetadata.update.describe}`,
    );
    expect(
      Object.getOwnPropertyDescriptor(updateCommand, 'describe')?.get,
    ).toBeTypeOf('function');
    const parser = parserFor([]);
    await registerTopLevelCommands(parser, []);
    const help = await parser.getHelp();
    expect(help).toContain(`en:${commandMetadata.auth.describe}`);
    expect(help).toContain(`zh:${commandMetadata.update.describe}`);
    language.current = 'fr';
    expect(authCommand.describe).toBe(`en:${commandMetadata.auth.describe}`);
    expect(updateCommand.describe).toBe(
      `fr:${commandMetadata.update.describe}`,
    );
    expect(loaded).toEqual([]);
  });

  it('does not freeze auth translation when only pure metadata is imported', async () => {
    await import('./command-metadata.js');
    language.current = 'zh';
    vi.doUnmock('./auth.js');
    const { authCommand } = await import('./auth.js');
    expect(authCommand.describe).toBe(`zh:${commandMetadata.auth.describe}`);
  });
});
