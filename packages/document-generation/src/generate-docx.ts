/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { z } from 'zod';

export const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_CONTENT_BYTES = 1_048_576;

function isXmlText(text: string): boolean {
  return Array.from(text).every((character) => {
    const point = character.codePointAt(0)!;
    return (
      point === 9 ||
      point === 10 ||
      point === 13 ||
      (point >= 0x20 && point <= 0xd7ff) ||
      (point >= 0xe000 && point <= 0xfffd) ||
      (point >= 0x10000 && point <= 0x10ffff)
    );
  });
}

function isOutputPath(value: string): boolean {
  if (
    !isXmlText(value) ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  )
    return false;
  return (
    /\.docx$/i.test(value) &&
    !/&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/i.test(value) &&
    !/(?:^|[\s"'`])on[a-z][a-z0-9-]*\s*=/i.test(value) &&
    value.split('/').every(
      (part) =>
        part.length > 0 &&
        part !== '.' &&
        part !== '..' &&
        part === part.trim() &&
        !/[<>:"|?*\\]/.test(part) &&
        !Array.from(part).some((character) => {
          const code = character.codePointAt(0)!;
          return (
            code < 32 ||
            code === 127 ||
            (code >= 0x200b && code <= 0x200f) ||
            code === 0x2028 ||
            code === 0x2029 ||
            (code >= 0x202a && code <= 0x202e) ||
            (code >= 0x2066 && code <= 0x2069) ||
            code === 0xfeff
          );
        }) &&
        !/[. ]$/.test(part) &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  );
}

export const docxInputShape = {
  outputPath: z
    .string()
    .min(1)
    .max(500)
    .refine(
      isOutputPath,
      'Use a relative .docx path without traversal or reserved filename characters.',
    )
    .describe(
      'New DOCX path relative to the configured workspace. Existing files cannot be overwritten.',
    ),
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine(isXmlText, 'Title must contain valid XML text.'),
  paragraphs: z
    .array(
      z
        .string()
        .max(MAX_CONTENT_BYTES)
        .refine(isXmlText, 'Paragraphs must contain valid XML text.'),
    )
    .min(1)
    .max(1000),
};

const inputSchema = z
  .object(docxInputShape)
  .strict()
  .refine(
    ({ title, paragraphs }) =>
      Buffer.byteLength(title) +
        paragraphs.reduce((size, text) => size + Buffer.byteLength(text), 0) <=
      MAX_CONTENT_BYTES,
    'Document text must not exceed 1 MiB in UTF-8.',
  );

export const docxResultShape = {
  resolvedPath: z.string(),
  mimeType: z.literal(DOCX_MIME),
  sizeBytes: z.number().int().nonnegative(),
};

export type GeneratedDocx = z.infer<z.ZodObject<typeof docxResultShape>>;

function isWithinWorkspace(root: string, directory: string): boolean {
  const relative = path.relative(root, directory);
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function createTextRuns(text: string): TextRun[] {
  return text
    .split(/\r\n|\r|\n/)
    .map(
      (line, index) => new TextRun({ text: line, break: index > 0 ? 1 : 0 }),
    );
}

async function checkDirectory(
  root: string,
  directory: string,
): Promise<string> {
  const info = await lstat(directory);
  const canonical = await realpath(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !isWithinWorkspace(root, canonical)
  ) {
    throw new Error(
      'Output directories must be real directories inside the workspace.',
    );
  }
  return canonical;
}

export async function createDocxGenerator(workspacePath: string) {
  if (!path.isAbsolute(workspacePath)) {
    throw new Error(
      'The configured workspace must be an absolute directory path.',
    );
  }
  const root = await realpath(workspacePath);
  await checkDirectory(root, root);

  return async (
    input: unknown,
    signal?: AbortSignal,
  ): Promise<GeneratedDocx> => {
    signal?.throwIfAborted();
    const params = inputSchema.parse(input);
    const parts = params.outputPath.split('/');
    const filename = parts.pop()!;
    let parent = root;
    for (const part of parts) {
      signal?.throwIfAborted();
      const directory = path.join(parent, part);
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'EEXIST'
          )
        )
          throw error;
      }
      parent = await checkDirectory(root, directory);
    }
    const destination = path.join(parent, filename);
    const document = new Document({
      sections: [
        {
          children: [
            new Paragraph({
              children: createTextRuns(params.title),
              heading: HeadingLevel.TITLE,
            }),
            ...params.paragraphs.map(
              (text) => new Paragraph({ children: createTextRuns(text) }),
            ),
          ],
        },
      ],
    });
    const bytes = await Packer.toBuffer(document);
    signal?.throwIfAborted();
    await checkDirectory(root, parent);
    const temporaryDirectory = await mkdtemp(path.join(parent, '.qwen-docx-'));
    try {
      const temporaryFile = path.join(temporaryDirectory, 'document.docx');
      const handle = await open(temporaryFile, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      signal?.throwIfAborted();
      await checkDirectory(root, parent);
      // A hard link publishes complete bytes and atomically refuses EEXIST.
      await link(temporaryFile, destination);
      return {
        resolvedPath: destination,
        mimeType: DOCX_MIME,
        sizeBytes: bytes.length,
      };
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(
        () => {
          process.stderr.write(
            'Unable to remove the document temporary directory.\n',
          );
        },
      );
    }
  };
}
