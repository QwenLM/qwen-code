/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import {
  HostPublisher,
  parsePublishedUrl,
  tokenizeCommand,
  type RunCommand,
} from './host-publisher.js';

describe('tokenizeCommand', () => {
  it('splits on whitespace', () => {
    expect(tokenizeCommand('aws s3 cp {file} s3://b/{key}')).toEqual([
      'aws',
      's3',
      'cp',
      '{file}',
      's3://b/{key}',
    ]);
  });
  it('honors double and single quotes', () => {
    expect(tokenizeCommand(`scp "{file}" 'user@h:/var/www/{key}'`)).toEqual([
      'scp',
      '{file}',
      'user@h:/var/www/{key}',
    ]);
  });
  it('collapses repeated whitespace', () => {
    expect(tokenizeCommand('a   b\t c')).toEqual(['a', 'b', 'c']);
  });
  it('throws on an unterminated quote', () => {
    expect(() => tokenizeCommand('cp "{file}')).toThrow(/unterminated/i);
  });
});

describe('parsePublishedUrl', () => {
  it.each([
    ['https://preview.example.com', 'https://preview.example.com'],
    [
      '{"deploy_url":"https://netlify.example.com"}',
      'https://netlify.example.com',
    ],
    [
      '{"url":"https://pages.example.com/report"}',
      'https://pages.example.com/report',
    ],
    [
      '{"url":"http://site.example.com","deploy_ssl_url":"https://secure.example.com"}',
      'https://secure.example.com',
    ],
  ])('reads a deployment URL from command output %#', (output, expected) => {
    expect(parsePublishedUrl(output)).toBe(expected);
  });

  it.each([
    ['', /did not print/i],
    ['deployment complete', /valid deployment URL/i],
    ['http://preview.example.com', /HTTPS URL/i],
    ['https://user:secret@example.com', /embedded credentials/i],
    ['{"state":"ready"}', /did not contain/i],
  ])('rejects unsafe or unusable output %#', (output, expected) => {
    expect(() => parsePublishedUrl(output)).toThrow(expected);
  });
});

describe('HostPublisher', () => {
  const input = { id: 'deadbeef', title: 'T', html: '<p>hello</p>' };

  it('uploads via the command and returns the templated url', async () => {
    let captured:
      | { command: string; args: string[]; content: string }
      | undefined;
    const run: RunCommand = async (command, args) => {
      const filePath = args.find((a) => a.endsWith('.html'))!;
      captured = {
        command,
        args,
        content: await fs.readFile(filePath, 'utf8'),
      };
      return '';
    };
    const pub = new HostPublisher(
      {
        uploadCommand:
          'aws s3 cp {file} s3://bkt/{key} --content-type text/html',
        urlTemplate: 'https://bkt.example.com/{key}',
      },
      run,
    );

    const res = await pub.publish(input);

    expect(res.id).toBe('deadbeef');
    expect(res.url).toBe(
      'https://bkt.example.com/artifacts/deadbeef/index.html',
    );
    expect(captured?.command).toBe('aws');
    // {file} substituted with a real temp path, {key} with the object key.
    expect(captured?.args).toContain('s3://bkt/artifacts/deadbeef/index.html');
    expect(captured?.args.some((a) => a.endsWith('.html'))).toBe(true);
    expect(captured?.content).toBe('<p>hello</p>');
  });

  it('removes the temp file after a successful upload', async () => {
    let filePath = '';
    const run: RunCommand = async (_c, args) => {
      filePath = args.find((a) => a.endsWith('.html'))!;
      return '';
    };
    await new HostPublisher(
      { uploadCommand: 'up {file} {key}', urlTemplate: 'https://h/{key}' },
      run,
    ).publish(input);
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it('uses a unique temp file for each upload of the same artifact', async () => {
    const filePaths: string[] = [];
    const run: RunCommand = async (_c, args) => {
      filePaths.push(args.find((a) => a.endsWith('.html'))!);
      return '';
    };
    const pub = new HostPublisher(
      { uploadCommand: 'up {file} {key}', urlTemplate: 'https://h/{key}' },
      run,
    );

    await pub.publish(input);
    await pub.publish(input);

    expect(filePaths[0]).not.toBe(filePaths[1]);
  });

  it('rejects urlTemplate without the key placeholder', async () => {
    const run = vi.fn<RunCommand>(async () => '');
    await expect(
      new HostPublisher(
        { uploadCommand: 'up {file} {key}', urlTemplate: 'https://h/static' },
        run,
      ).publish(input),
    ).rejects.toThrow(/\{key\}/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects urlTemplate with the file placeholder', async () => {
    const run = vi.fn<RunCommand>(async () => '');
    await expect(
      new HostPublisher(
        {
          uploadCommand: 'up {file} {key}',
          urlTemplate: 'https://h/{key}?src={file}',
        },
        run,
      ).publish(input),
    ).rejects.toThrow(/\{file\}/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('honors a custom keyPrefix and strips surrounding slashes', async () => {
    const run = vi.fn<RunCommand>(async () => '');
    const res = await new HostPublisher(
      {
        uploadCommand: 'up {file} {key}',
        urlTemplate: 'https://h/{key}',
        keyPrefix: '/pages/',
      },
      run,
    ).publish(input);
    expect(res.url).toBe('https://h/pages/deadbeef/index.html');
  });

  it('propagates upload failure and still cleans up the temp file', async () => {
    let filePath = '';
    const run: RunCommand = async (_c, args) => {
      filePath = args.find((a) => a.endsWith('.html'))!;
      throw new Error('boom');
    };
    const pub = new HostPublisher(
      { uploadCommand: 'up {file} {key}', urlTemplate: 'https://h/{key}' },
      run,
    );
    await expect(pub.publish(input)).rejects.toThrow(/boom/);
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it('deploys the temporary site directory and returns the command URL', async () => {
    let siteDir = '';
    const run: RunCommand = async (_command, args) => {
      siteDir = args[2];
      expect(await fs.readFile(`${siteDir}/index.html`, 'utf8')).toBe(
        '<p>hello</p>',
      );
      return '{"deploy_url":"https://preview.example.com/report"}';
    };
    const result = await new HostPublisher(
      {
        uploadCommand: 'netlify deploy --dir {dir} --json',
        urlTemplate: '',
        urlFromCommandOutput: true,
        keyPrefix: '/',
      },
      run,
    ).publish(input);

    expect(result.url).toBe('https://preview.example.com/report');
    await expect(fs.access(siteDir)).rejects.toThrow();
  });

  it('removes the temp directory when writing the artifact fails', async () => {
    const writeError = new Error('synthetic write failure');
    const writeFile = vi
      .spyOn(fs, 'writeFile')
      .mockRejectedValueOnce(writeError);
    const remove = vi.spyOn(fs, 'rm');

    try {
      await expect(
        new HostPublisher(
          {
            uploadCommand: 'deploy {dir}',
            urlTemplate: '',
            urlFromCommandOutput: true,
          },
          vi.fn<RunCommand>(async () => 'https://preview.example.com'),
        ).publish(input),
      ).rejects.toThrow(writeError);
      expect(remove).toHaveBeenCalledWith(
        expect.stringContaining('qwen-art-'),
        { recursive: true, force: true },
      );
    } finally {
      writeFile.mockRestore();
      remove.mockRestore();
    }
  });

  it.each([
    [{ uploadCommand: '', urlTemplate: 'https://h/{key}' }, /uploadCommand/i],
    [{ uploadCommand: 'up {file}', urlTemplate: '' }, /urlTemplate/i],
    [
      { uploadCommand: 'up nofile', urlTemplate: 'https://h/{key}' },
      /\{file\}/i,
    ],
    [
      { uploadCommand: 'up {file}', urlTemplate: 'https://h/{key}' },
      /\{key\}/i,
    ],
    [
      {
        uploadCommand: 'up {file} {key}',
        urlTemplate: 'https://h/{key}',
        keyPrefix: '/',
      },
      /keyPrefix/i,
    ],
    [
      {
        uploadCommand: 'up {file} {key}',
        urlTemplate: 'https://h/{key}',
        keyPrefix: 'bad prefix',
      },
      /keyPrefix/i,
    ],
    [
      {
        uploadCommand: 'netlify deploy --json',
        urlTemplate: '',
        urlFromCommandOutput: true,
      },
      /\{dir\}/i,
    ],
  ])('rejects misconfiguration %#', async (config, re) => {
    const run = vi.fn<RunCommand>(async () => '');
    await expect(new HostPublisher(config, run).publish(input)).rejects.toThrow(
      re,
    );
    expect(run).not.toHaveBeenCalled();
  });
});
