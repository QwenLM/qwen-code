/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStateStore } from '@qwen-code/core';
import {
  ArtifactPresentationError,
  ArtifactRegistry,
  type ArtifactRegistryPersistence,
} from './artifactRegistry.js';
import {
  ARTIFACT_REGISTRY_SEGMENT_KEY,
  SessionStateArtifactRegistryPersistence,
} from './artifactRegistryStore.js';
import { PresentFilesTool } from './presentFilesTool.js';
import { SessionArtifactRuntime } from './sessionArtifactRuntime.js';

const execFileAsync = promisify(execFile);

class MemoryPersistence implements ArtifactRegistryPersistence {
  value: unknown;
  saves: unknown[] = [];
  loadError: Error | undefined;
  saveError: Error | undefined;

  async load(): Promise<unknown> {
    if (this.loadError) {
      throw this.loadError;
    }
    return structuredClone(this.value);
  }

  async save(value: unknown): Promise<void> {
    if (this.saveError) {
      const error = this.saveError;
      this.saveError = undefined;
      throw error;
    }
    this.value = structuredClone(value);
    this.saves.push(structuredClone(value));
  }
}

function assistantEvent(
  text: string,
  extraBlocks: unknown[] = [],
): Record<string, unknown> {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }, ...extraBlocks],
    },
  };
}

function toolResultEvent(
  toolUseResult: unknown,
  options: {
    content?: unknown[];
    parentToolUseId?: string | null;
  } = {},
): Record<string, unknown> {
  return {
    type: 'user',
    parent_tool_use_id: options.parentToolUseId ?? null,
    message: {
      role: 'user',
      content: options.content ?? [
        {
          type: 'tool_result',
          tool_use_id: 'toolu-file',
          content: 'ok',
        },
      ],
    },
    toolUseResult,
  };
}

function promptEvent(text = 'continue'): Record<string, unknown> {
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: text,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('ArtifactRegistry', () => {
  let tempDirectory: string;
  let workspace: string;
  let outside: string;

  beforeEach(async () => {
    tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-artifact-registry-'),
    );
    workspace = path.join(tempDirectory, 'workspace');
    outside = path.join(tempDirectory, 'outside');
    await fs.mkdir(path.join(workspace, 'reports'), { recursive: true });
    await fs.mkdir(outside, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  function createRegistry(
    persistence?: ArtifactRegistryPersistence,
    workingDirectory = workspace,
    initialWorkspaceRoots: readonly string[] = [workspace],
  ): ArtifactRegistry {
    return new ArtifactRegistry({
      workingDirectory,
      initialWorkspaceRoots,
      persistence,
    });
  }

  it('accepts the explicit presentation extension allowlist case-insensitively', async () => {
    const allowedNames = [
      'one.md',
      'two.MARKDOWN',
      'three.PDF',
      'four.png',
      'five.JPG',
      'six.jpeg',
      'seven.GIF',
      'eight.webp',
      'nine.HTML',
      'ten.doc',
      'eleven.DOCX',
      'twelve.xls',
      'thirteen.XLSX',
      'fourteen.ppt',
      'fifteen.PPTX',
    ];
    for (const name of [
      ...allowedNames,
      'source.ts',
      'archive.zip',
      'vector.svg',
    ]) {
      await fs.writeFile(path.join(workspace, name), name);
    }
    await fs.symlink(
      path.join(workspace, 'source.ts'),
      path.join(workspace, 'disguised.pdf'),
    );

    const markdown = [
      ...allowedNames,
      'source.ts',
      'archive.zip',
      'disguised.pdf',
    ]
      .map((name) => `[${name}](${name})`)
      .join(' ');
    const registry = createRegistry();
    await expect(
      registry.processEvent(assistantEvent(markdown)),
    ).resolves.toBeNull();
    const observation = await registry.present(allowedNames);

    expect(observation.presented.map((entry) => entry.name)).toEqual(
      allowedNames,
    );
    expect(
      observation.presented.find((entry) => entry.name === 'nine.HTML')?.mime,
    ).toBe('text/html');
    expect(
      observation.presented.find((entry) => entry.name === 'thirteen.XLSX')
        ?.mime,
    ).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(
      observation.presented.find((entry) => entry.name === 'fifteen.PPTX')
        ?.mime,
    ).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
  });

  it('accepts an in-root alias selected for explicit presentation', async () => {
    const canonicalFile = path.join(workspace, 'allowed.pdf');
    await fs.writeFile(canonicalFile, 'allowed');
    await fs.symlink(canonicalFile, path.join(workspace, 'disguised.ts'));

    await expect(
      createRegistry().present(['disguised.ts']),
    ).resolves.toMatchObject({
      presented: [
        {
          path: await fs.realpath(canonicalFile),
          name: 'allowed.pdf',
          mime: 'application/pdf',
        },
      ],
    });
  });

  it('rejects external, scheme, query, fragment, malformed, NUL, and directory targets', async () => {
    await fs.writeFile(path.join(workspace, 'valid.pdf'), 'valid');
    await fs.mkdir(path.join(workspace, 'directory.pdf'));
    const markdown = [
      '[valid](valid.pdf)',
      '[http](https://example.com/x.pdf)',
      '[data](data:application/pdf;base64,AA==)',
      '[mail](mailto:x@example.com)',
      '[other](ftp://example.com/x.pdf)',
      '[scheme-relative](//example.com/x.pdf)',
      '[fragment](#section)',
      '[fragment-path](valid.pdf#page=1)',
      '[query](valid.pdf?download=1)',
      '[malformed](bad%ZZ.pdf)',
      '[nul](bad%00.pdf)',
      '[directory](directory.pdf)',
    ].join(' ');

    await expect(
      createRegistry().processEvent(assistantEvent(markdown)),
    ).resolves.toBeNull();
  });

  it('rejects a file URL with a remote hostname', async () => {
    await expect(
      createRegistry().present(['file://remote-host/workspace/report.pdf']),
    ).rejects.toBeInstanceOf(ArtifactPresentationError);
  });

  it('rejects a NUL decoded from a local file URL', async () => {
    await expect(
      createRegistry().present(['file:///workspace/bad%00.pdf']),
    ).rejects.toBeInstanceOf(ArtifactPresentationError);
  });

  it('decodes a local file URL exactly once without relying on an alias', async () => {
    const encodedName = 'encoded%20once.pdf';
    const canonicalFile = path.join(workspace, encodedName);
    await fs.writeFile(canonicalFile, 'once');
    const href = pathToFileURL(canonicalFile).href;

    const update = await createRegistry().present([href]);

    expect(update.presented).toHaveLength(1);
    expect(update.presented[0]?.path).toBe(await fs.realpath(canonicalFile));
  });

  it('decodes a regular href exactly once without relying on an alias', async () => {
    const literalPercentName = 'encoded%20once.pdf';
    const artifactPath = path.join(workspace, literalPercentName);
    await fs.writeFile(artifactPath, 'once');

    const update = await createRegistry().present(['encoded%2520once.pdf']);

    expect(update.presented.map((entry) => entry.path)).toEqual([
      await fs.realpath(artifactPath),
    ]);
  });

  it.skipIf(process.platform !== 'win32')(
    'accepts a Windows drive-absolute artifact path',
    async () => {
      const artifactPath = path.join(workspace, 'windows.pdf');
      await fs.writeFile(artifactPath, 'artifact');

      await expect(
        createRegistry().present([artifactPath.replaceAll('\\', '/')]),
      ).resolves.toMatchObject({
        presented: [{ name: 'windows.pdf' }],
      });
    },
  );

  it('deduplicates a symlink alias by canonical path', async () => {
    const canonicalFile = path.join(workspace, 'canonical.pdf');
    const alias = path.join(workspace, 'alias.pdf');
    await fs.writeFile(canonicalFile, 'content');
    await fs.symlink(canonicalFile, alias);

    const update = await createRegistry().present([
      'canonical.pdf',
      'alias.pdf',
    ]);

    expect(update.presented.map((entry) => entry.path)).toEqual([
      await fs.realpath(canonicalFile),
    ]);
  });

  it('accepts external files and deduplicates symlink aliases by canonical path', async () => {
    const insideFile = path.join(workspace, 'inside.pdf');
    const outsideFile = path.join(outside, 'outside.pdf');
    await fs.writeFile(insideFile, 'inside');
    await fs.writeFile(outsideFile, 'outside');
    await fs.symlink(outsideFile, path.join(workspace, 'escape.pdf'));
    const canonicalInside = await fs.realpath(insideFile);
    const canonicalOutside = await fs.realpath(outsideFile);

    const registry = createRegistry();
    await expect(registry.present(['inside.pdf'])).resolves.toMatchObject({
      presented: [{ path: canonicalInside }],
    });
    const external = await registry.present([outsideFile, 'escape.pdf']);

    expect(external.presented).toEqual([
      expect.objectContaining({
        path: canonicalOutside,
        display_path: canonicalOutside,
        name: 'outside.pdf',
      }),
    ]);
    expect(external.presented[0]).not.toHaveProperty('relative_path');
    expect(external.snapshot?.map(({ path: pathname }) => pathname)).toEqual([
      canonicalInside,
      canonicalOutside,
    ]);
  });

  it.skipIf(process.platform !== 'darwin')(
    'canonicalizes an external /tmp artifact to its real path',
    async () => {
      const temporaryDirectory = await fs.mkdtemp(
        '/tmp/qwen-artifact-external-',
      );
      try {
        const artifactPath = path.join(temporaryDirectory, 'demo.md');
        await fs.writeFile(artifactPath, 'demo');
        const canonicalPath = await fs.realpath(artifactPath);

        const observation = await createRegistry().present([artifactPath]);

        expect(observation.presented).toEqual([
          expect.objectContaining({
            path: canonicalPath,
            display_path: canonicalPath,
            name: 'demo.md',
          }),
        ]);
        expect(observation.presented[0]).not.toHaveProperty('relative_path');
      } finally {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
      }
    },
  );

  it('emits cumulative snapshots in first-presentation order', async () => {
    await fs.writeFile(path.join(workspace, 'first.pdf'), 'first');
    await fs.writeFile(path.join(workspace, 'second.md'), 'second');
    const registry = createRegistry();

    const first = await registry.present(['first.pdf']);
    const noLinks = await registry.processEvent(
      assistantEvent('Nothing to publish.'),
    );
    const duplicate = await registry.present(['first.pdf']);
    const second = await registry.present(['second.md']);

    expect(first.snapshot?.map((entry) => entry.name)).toEqual(['first.pdf']);
    expect(noLinks).toBeNull();
    expect(duplicate.snapshot?.map((entry) => entry.name)).toEqual([
      'first.pdf',
    ]);
    expect(second.snapshot?.map((entry) => entry.name)).toEqual([
      'first.pdf',
      'second.md',
    ]);
  });

  it('does not discover an intermediate file from a failure status after a failed root tool result', async () => {
    const intermediatePath = path.join(workspace, 'intermediate.png');
    await fs.writeFile(intermediatePath, 'temporary image');
    const registry = createRegistry();

    await expect(
      registry.observeEvent(
        toolResultEvent(
          { isHardFailure: true },
          {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu-convert',
                content: 'Conversion failed',
                is_error: true,
              },
            ],
          },
        ),
      ),
    ).resolves.toBeNull();
    await expect(
      registry.observeEvent(
        assistantEvent(
          [
            'Status:',
            '',
            `- Generated PNG exists at: \`${intermediatePath}\``,
            '- Cannot produce the target JPEG file.',
          ].join('\n'),
        ),
      ),
    ).resolves.toBeNull();

    expect(registry.snapshot()).toEqual([]);
  });

  it('ignores final-text paths after later successful tool results in the same turn', async () => {
    const intermediatePath = path.join(workspace, 'intermediate.png');
    await fs.writeFile(intermediatePath, 'temporary image');
    const registry = createRegistry();

    await registry.observeEvent(
      toolResultEvent(
        { isHardFailure: true },
        {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu-first-attempt',
              content: 'First attempt failed',
              is_error: true,
            },
          ],
        },
      ),
    );
    await registry.observeEvent(
      toolResultEvent(
        { kind: 'completed' },
        {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu-recovery',
              content: 'Recovery succeeded',
              is_error: false,
            },
          ],
        },
      ),
    );

    await expect(
      registry.observeEvent(
        assistantEvent(
          `Conversion still failed. Intermediate image: \`${intermediatePath}\`.`,
        ),
      ),
    ).resolves.toBeNull();

    expect(registry.snapshot()).toEqual([]);
  });

  it('continues ignoring final-text paths after the next root user prompt', async () => {
    const artifactPath = path.join(workspace, 'recovered.png');
    await fs.writeFile(artifactPath, 'recovered image');
    const registry = createRegistry();

    await registry.observeEvent(
      toolResultEvent(
        { isHardFailure: true },
        {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu-failed-turn',
              content: 'First turn failed',
              is_error: true,
            },
          ],
        },
      ),
    );
    await registry.observeEvent(promptEvent('Try a new delivery'));

    const observation = await registry.observeEvent(
      assistantEvent(`Delivered \`${artifactPath}\`.`),
    );
    expect(observation).toBeNull();
    expect(registry.snapshot()).toEqual([]);
  });

  it('does not rediscover failure-status intermediates during history initialization', async () => {
    const intermediatePath = path.join(workspace, 'history-temp.png');
    await fs.writeFile(intermediatePath, 'temporary image');
    const registry = createRegistry();

    const snapshot = await registry.initialize([
      toolResultEvent(
        { isHardFailure: true },
        {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu-history-convert',
              content: 'Conversion failed',
              is_error: true,
            },
          ],
        },
      ),
      assistantEvent(
        `Unable to finish. Intermediate image: \`${intermediatePath}\`.`,
      ),
    ]);

    expect(snapshot).toEqual([]);
    expect(registry.snapshot()).toEqual([]);
  });

  it('reports explicit per-turn presentations even when the full snapshot is unchanged', async () => {
    const artifactPath = path.join(workspace, 'repeat.pdf');
    await fs.writeFile(artifactPath, 'repeat');
    const registry = createRegistry();

    const first = await registry.present(['repeat.pdf']);
    const repeated = await registry.present(['repeat.pdf']);

    expect(first).toEqual({
      snapshot: [
        expect.objectContaining({
          path: await fs.realpath(artifactPath),
          kind: 'presented',
        }),
      ],
      presented: [
        expect.objectContaining({
          path: await fs.realpath(artifactPath),
          kind: 'presented',
        }),
      ],
      changedArtifacts: [],
    });
    expect(repeated).toEqual({
      snapshot: [
        expect.objectContaining({
          path: await fs.realpath(artifactPath),
          kind: 'presented',
        }),
      ],
      presented: [
        expect.objectContaining({
          path: await fs.realpath(artifactPath),
          kind: 'presented',
        }),
      ],
      changedArtifacts: [],
    });
  });

  it('does not discover the reproduced path-only final reply', async () => {
    const artifactPath = path.join(workspace, 'sample.md');
    await fs.writeFile(artifactPath, '# Sample');

    const snapshot = await createRegistry().processEvent(
      assistantEvent(
        `Done! Created \`sample.md\`. You can view it at \`${artifactPath}\`.`,
      ),
    );

    expect(snapshot).toBeNull();
  });

  it('does not discover a plain directory-scoped final list', async () => {
    const artifactDirectory = path.join(workspace, 'misc');
    await fs.mkdir(artifactDirectory);
    const artifactNames = [
      'guide.md',
      'todo.md',
      'summary.md',
      'ideas.md',
      'checklist.md',
      'notes2.md',
      'landscape.png',
      'abstract.png',
      'index.html',
      'page.html',
    ];
    for (const name of artifactNames) {
      await fs.writeFile(path.join(artifactDirectory, name), name);
    }

    const observation = await createRegistry().observeEvent(
      assistantEvent(
        [
          'All 10 files are present.',
          '',
          'misc/',
          '',
          '- guide.md',
          '- todo.md',
          '- summary.md',
          '- ideas.md',
          '- checklist.md',
          '- notes2.md',
          '- landscape.png（日落山景）',
          '- abstract.png（抽象几何）',
          '- index.html',
          '- page.html',
        ].join('\n'),
      ),
    );

    expect(observation).toBeNull();
  });

  it.each([
    ['plain list item', (relativePath: string) => `- ${relativePath}`],
    ['standalone plain path', (relativePath: string) => relativePath],
  ])(
    'does not discover a path-qualified %s containing spaces and parentheses',
    async (_name, renderReference) => {
      const relativePath = 'rc-e2e/repro-paren/中文 报告 (最终).md';
      const artifactPath = path.join(workspace, relativePath);
      await fs.mkdir(path.dirname(artifactPath), { recursive: true });
      await fs.writeFile(artifactPath, 'PAREN BARE PATH');

      const observation = await createRegistry().observeEvent(
        assistantEvent(renderReference(relativePath)),
      );

      expect(observation).toBeNull();
    },
  );

  it('does not discover directory-scoped path-only codespans', async () => {
    const artifactDirectory = path.join(workspace, 'misc', 'random_files');
    await fs.mkdir(artifactDirectory, { recursive: true });
    const artifactNames = [
      'coffee_guide.md',
      'sunset_landscape.png',
      'abstract_geometry.png',
      'weather_dashboard.html',
      'task_board.html',
    ];
    for (const name of artifactNames) {
      await fs.writeFile(path.join(artifactDirectory, name), name);
    }

    const observation = await createRegistry().observeEvent(
      assistantEvent(
        [
          'All files were created in `misc/random_files/`:',
          '',
          '1. `coffee_guide.md`',
          '2 images: 7. `sunset_landscape.png` 8. `abstract_geometry.png`',
          '2 HTML: 9. `weather_dashboard.html` 10. `task_board.html`',
        ].join('\n'),
      ),
    );

    expect(observation).toBeNull();
  });

  it('does not discover a unique bare artifact name from final text', async () => {
    await fs.mkdir(path.join(workspace, 'first'));
    await fs.mkdir(path.join(workspace, 'second'));
    const artifactPath = path.join(workspace, 'second', 'report.pdf');
    await fs.writeFile(artifactPath, 'report');

    const observation = await createRegistry().observeEvent(
      assistantEvent(
        'Possible directories: `first/`, `second/`. File: `report.pdf`.',
      ),
    );

    expect(observation).toBeNull();
  });

  it('rejects a bare name when both its declared directory and workspace root contain it', async () => {
    await fs.mkdir(path.join(workspace, 'misc'));
    await fs.writeFile(path.join(workspace, 'report.pdf'), 'root');
    await fs.writeFile(path.join(workspace, 'misc', 'report.pdf'), 'misc');

    const observation = await createRegistry().observeEvent(
      assistantEvent('Files are in `misc/`: `report.pdf`.'),
    );

    expect(observation).toBeNull();
  });

  it('does not discover a workspace-root file from directory hints', async () => {
    const artifactPath = path.join(workspace, 'report.pdf');
    await fs.writeFile(artifactPath, 'root');

    const observation = await createRegistry().observeEvent(
      assistantEvent('Files are in `missing/`: `report.pdf`.'),
    );

    expect(observation).toBeNull();
  });

  it('rejects a bare artifact name found in multiple declared directories', async () => {
    await fs.mkdir(path.join(workspace, 'first'));
    await fs.mkdir(path.join(workspace, 'second'));
    await fs.writeFile(path.join(workspace, 'report.pdf'), 'root');
    await fs.writeFile(path.join(workspace, 'first', 'report.pdf'), 'first');
    await fs.writeFile(path.join(workspace, 'second', 'report.pdf'), 'second');

    await expect(
      createRegistry().observeEvent(
        assistantEvent(
          'Possible directories: `first/`, `second/`. File: `report.pdf`.',
        ),
      ),
    ).resolves.toBeNull();
  });

  it('does not discover Markdown link targets from final text', async () => {
    await fs.mkdir(path.join(workspace, 'misc'));
    const rootArtifact = path.join(workspace, 'report.pdf');
    await fs.writeFile(rootArtifact, 'root');
    await fs.writeFile(path.join(workspace, 'misc', 'report.pdf'), 'misc');

    const observation = await createRegistry().observeEvent(
      assistantEvent('Files are in `misc/`. [Root report](report.pdf).'),
    );

    expect(observation).toBeNull();
  });

  it('does not discover path-qualified codespans from final text', async () => {
    await fs.mkdir(path.join(workspace, 'misc'));
    await fs.mkdir(path.join(workspace, 'docs'));
    await fs.writeFile(path.join(workspace, 'misc', 'report.pdf'), 'misc');
    const docsArtifact = path.join(workspace, 'docs', 'report.pdf');
    await fs.writeFile(docsArtifact, 'docs');

    const observation = await createRegistry().observeEvent(
      assistantEvent('Files are in `misc/`. Use `docs/report.pdf`.'),
    );

    expect(observation).toBeNull();
  });

  it('does not discover bare-name alternatives from final text', async () => {
    const rootArtifact = path.join(workspace, 'report.pdf');
    await fs.writeFile(rootArtifact, 'root');
    await fs.mkdir(path.join(workspace, 'misc'));
    await fs.symlink(rootArtifact, path.join(workspace, 'misc', 'report.pdf'));

    const observation = await createRegistry().observeEvent(
      assistantEvent('Files are in `misc/`: `report.pdf`.'),
    );

    expect(observation).toBeNull();
  });

  it('discovers successful Write and Edit tool results inside and outside the workspace', async () => {
    const createdPath = path.join(workspace, 'created.md');
    const editedPath = path.join(outside, 'edited.pdf');
    await fs.writeFile(createdPath, 'first\nsecond\n');
    await fs.writeFile(editedPath, 'updated');
    const canonicalEditedPath = await fs.realpath(editedPath);
    const registry = createRegistry();

    const created = await registry.processEvent(
      toolResultEvent({
        type: 'create',
        filePath: createdPath,
        content: 'first\nsecond\n',
        structuredPatch: [],
        originalFile: null,
      }),
    );
    const edited = await registry.processEvent(
      toolResultEvent({
        filePath: editedPath,
        oldString: 'old',
        newString: 'updated',
        originalFile: 'old',
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ['-old', '+updated'],
          },
        ],
        userModified: false,
        replaceAll: false,
      }),
    );

    expect(created).toEqual([
      expect.objectContaining({
        path: await fs.realpath(createdPath),
        kind: 'changed',
        additions: 2,
        deletions: 0,
        is_new: true,
      }),
    ]);
    expect(edited).toEqual([
      expect.objectContaining({
        name: 'created.md',
        kind: 'changed',
      }),
      expect.objectContaining({
        path: canonicalEditedPath,
        display_path: canonicalEditedPath,
        kind: 'changed',
        additions: 1,
        deletions: 1,
        is_new: false,
      }),
    ]);
    expect(edited?.[1]).not.toHaveProperty('relative_path');
  });

  it('reports only artifacts changed by the current structured file event', async () => {
    const firstPath = path.join(workspace, 'first.md');
    const secondPath = path.join(workspace, 'second.md');
    await fs.writeFile(firstPath, 'first');
    await fs.writeFile(secondPath, 'second');
    const registry = createRegistry();

    const first = await registry.observeEvent(
      toolResultEvent({
        type: 'create',
        filePath: firstPath,
        content: 'first',
        structuredPatch: [],
        originalFile: null,
      }),
    );
    const second = await registry.observeEvent(
      toolResultEvent({
        type: 'create',
        filePath: secondPath,
        content: 'second',
        structuredPatch: [],
        originalFile: null,
      }),
    );

    expect(first?.changedArtifacts).toEqual([
      expect.objectContaining({ path: await fs.realpath(firstPath) }),
    ]);
    expect(second?.snapshot).toHaveLength(2);
    expect(second?.changedArtifacts).toEqual([
      expect.objectContaining({ path: await fs.realpath(secondPath) }),
    ]);
  });

  it('keeps explicit-only file types out of automatic discovery', async () => {
    const filePath = path.join(workspace, 'data.json');
    await fs.writeFile(filePath, '{}');
    const registry = createRegistry();

    await expect(
      registry.observeEvent(
        toolResultEvent({
          type: 'create',
          filePath,
          content: '{}',
          structuredPatch: [],
          originalFile: null,
        }),
      ),
    ).resolves.toBeNull();
    expect(registry.snapshot()).toEqual([]);
  });

  it('automatically discovers Office files from structured file events', async () => {
    const spreadsheetPath = path.join(workspace, 'report.xlsx');
    await fs.writeFile(spreadsheetPath, 'xlsx');
    const registry = createRegistry();

    await expect(
      registry.observeEvent(
        toolResultEvent({
          type: 'create',
          filePath: spreadsheetPath,
          content: 'xlsx',
          structuredPatch: [],
          originalFile: null,
        }),
      ),
    ).resolves.toMatchObject({
      changedArtifacts: [
        {
          path: await fs.realpath(spreadsheetPath),
          name: 'report.xlsx',
          mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          kind: 'changed',
        },
      ],
    });
  });

  it('discovers a successful ImageGen result without parsing its text output', async () => {
    const imagePath = path.join(workspace, 'generated.png');
    await fs.writeFile(imagePath, 'png');

    const observation = await createRegistry().observeEvent(
      toolResultEvent({
        filePath: imagePath,
        requestId: 'image-request-1',
      }),
    );

    expect(observation).toEqual({
      snapshot: [
        expect.objectContaining({
          path: await fs.realpath(imagePath),
          kind: 'changed',
          additions: 0,
          deletions: 0,
          is_new: true,
        }),
      ],
      presented: [],
      changedArtifacts: [
        expect.objectContaining({ path: await fs.realpath(imagePath) }),
      ],
    });
  });

  it('derives is_new from whether the original file content was empty', async () => {
    const writtenPath = path.join(workspace, 'written.md');
    const editedPath = path.join(workspace, 'edited-empty.md');
    await fs.writeFile(writtenPath, 'written');
    await fs.writeFile(editedPath, 'edited');
    const registry = createRegistry();

    await registry.processEvent(
      toolResultEvent({
        type: 'update',
        filePath: writtenPath,
        content: 'written',
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            lines: ['+written'],
          },
        ],
        originalFile: '',
      }),
    );
    const snapshot = await registry.processEvent(
      toolResultEvent({
        filePath: editedPath,
        oldString: '',
        newString: 'edited',
        originalFile: '',
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            lines: ['+edited'],
          },
        ],
        userModified: false,
        replaceAll: false,
      }),
    );

    expect(snapshot).toEqual([
      expect.objectContaining({ name: 'written.md', is_new: true }),
      expect.objectContaining({ name: 'edited-empty.md', is_new: true }),
    ]);
  });

  it('aligns batched structured results with successful root tool_result blocks', async () => {
    const acceptedPath = path.join(workspace, 'accepted.md');
    const rejectedPath = path.join(workspace, 'rejected.md');
    await fs.writeFile(acceptedPath, 'accepted');
    await fs.writeFile(rejectedPath, 'rejected');

    const snapshot = await createRegistry().processEvent(
      toolResultEvent(
        [
          {
            type: 'create',
            filePath: acceptedPath,
            content: 'accepted',
            structuredPatch: [],
            originalFile: null,
          },
          {
            type: 'create',
            filePath: rejectedPath,
            content: 'rejected',
            structuredPatch: [],
            originalFile: null,
          },
        ],
        {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu-accepted',
              content: 'ok',
            },
            {
              type: 'tool_result',
              tool_use_id: 'toolu-rejected',
              content: 'denied',
              is_error: true,
            },
          ],
        },
      ),
    );

    expect(snapshot?.map((entry) => entry.name)).toEqual(['accepted.md']);
    await expect(
      createRegistry().processEvent(
        toolResultEvent(
          {
            type: 'create',
            filePath: acceptedPath,
            content: 'accepted',
            structuredPatch: [],
            originalFile: null,
          },
          { parentToolUseId: 'toolu-parent' },
        ),
      ),
    ).resolves.toBeNull();
  });

  it('does not treat a single semantic content-block array as positional tool results', async () => {
    const embeddedPath = path.join(workspace, 'must-not-register.md');
    await fs.writeFile(embeddedPath, 'not a file-tool result');

    const snapshot = await createRegistry().processEvent(
      toolResultEvent([
        {
          type: 'text',
          text: 'semantic block',
          filePath: embeddedPath,
          content: 'not a file-tool result',
          structuredPatch: [],
          originalFile: null,
        },
      ]),
    );

    expect(snapshot).toBeNull();
  });

  it('upgrades a changed artifact only through explicit presentation', async () => {
    const artifactPath = path.join(workspace, 'deliverable.md');
    await fs.writeFile(artifactPath, 'deliverable');
    const registry = createRegistry();

    await registry.processEvent(
      toolResultEvent({
        type: 'create',
        filePath: artifactPath,
        content: 'deliverable',
        structuredPatch: [],
        originalFile: null,
      }),
    );
    await expect(
      registry.processEvent(assistantEvent(`Done: \`${artifactPath}\``)),
    ).resolves.toBeNull();
    const observation = await registry.present([artifactPath]);
    const presented = observation.presented;

    expect(presented).toEqual([
      expect.objectContaining({
        kind: 'presented',
      }),
    ]);
    expect(presented[0]).not.toHaveProperty('additions');
    expect(presented[0]).not.toHaveProperty('deletions');
    expect(presented[0]).not.toHaveProperty('is_new');
  });

  it('refreshes metadata for a previously discovered canonical artifact', async () => {
    const artifactPath = path.join(workspace, 'refresh.pdf');
    await fs.writeFile(artifactPath, 'first');
    const registry = createRegistry();

    await registry.present(['refresh.pdf']);
    await fs.writeFile(artifactPath, 'updated');
    const refreshed = await registry.present(['refresh.pdf']);

    expect(refreshed.snapshot).toEqual([
      expect.objectContaining({
        path: await fs.realpath(artifactPath),
        size: 7,
      }),
    ]);
  });

  it('removes a deleted artifact before adding another local artifact', async () => {
    const deletedPath = path.join(workspace, 'deleted.pdf');
    await fs.writeFile(deletedPath, 'deleted');
    await fs.writeFile(path.join(workspace, 'new.pdf'), 'new');
    const registry = createRegistry();

    await registry.present(['deleted.pdf']);
    await fs.unlink(deletedPath);
    const observation = await registry.present(['new.pdf']);

    expect(observation.snapshot?.map((entry) => entry.name)).toEqual([
      'new.pdf',
    ]);
  });

  it('refreshes existing metadata in place when another artifact is discovered', async () => {
    const existingPath = path.join(workspace, 'existing.pdf');
    await fs.writeFile(existingPath, 'old');
    await fs.writeFile(path.join(workspace, 'new.md'), 'new');
    const registry = createRegistry();

    await registry.present(['existing.pdf']);
    await fs.writeFile(existingPath, 'updated content');
    const observation = await registry.present(['new.md']);

    expect(
      observation.snapshot?.map((entry) => [entry.name, entry.size]),
    ).toEqual([
      ['existing.pdf', 15],
      ['new.md', 3],
    ]);
  });

  it('drops an entry whose canonical path was replaced by a symlink', async () => {
    const originalPath = path.join(workspace, 'original.pdf');
    const replacementPath = path.join(workspace, 'replacement.pdf');
    await fs.writeFile(originalPath, 'original');
    await fs.writeFile(replacementPath, 'replacement');
    await fs.writeFile(path.join(workspace, 'new.md'), 'new');
    const registry = createRegistry();

    await registry.present(['original.pdf']);
    await fs.unlink(originalPath);
    await fs.symlink(replacementPath, originalPath);
    const observation = await registry.present(['new.md']);

    expect(observation.snapshot?.map((entry) => entry.name)).toEqual([
      'new.md',
    ]);

    const withReplacement = await registry.present(['replacement.pdf']);
    expect(withReplacement.snapshot?.map((entry) => entry.name)).toEqual([
      'new.md',
      'replacement.pdf',
    ]);
  });

  it('does not revalidate entries when a message has no eligible local links', async () => {
    const artifactPath = path.join(workspace, 'historical.pdf');
    await fs.writeFile(artifactPath, 'historical');
    const registry = createRegistry();

    await registry.present(['historical.pdf']);
    await fs.unlink(artifactPath);

    await expect(
      registry.processEvent(
        assistantEvent(
          '[remote](https://example.test/remote.pdf) [code](source.ts)',
        ),
      ),
    ).resolves.toBeNull();
    expect(registry.snapshot().map((entry) => entry.name)).toEqual([
      'historical.pdf',
    ]);
  });

  it('produces safe POSIX display fields and filesystem metadata', async () => {
    const project = path.join(workspace, 'nested', 'project');
    await fs.mkdir(project, { recursive: true });
    const unsafeName = 'unsafe\n\u0085\u202e\u200bname.PDF';
    const artifactPath = path.join(workspace, unsafeName);
    await fs.writeFile(artifactPath, 'payload');
    const mtime = new Date('2026-07-27T08:00:00.123Z');
    await fs.utimes(artifactPath, mtime, mtime);
    // 文件系统可能截断小数精度；产物应忠实反映实际 stat 元数据。
    const { mtimeMs } = await fs.stat(artifactPath);

    const update = await createRegistry(undefined, project, [
      workspace,
    ]).present([pathToFileURL(artifactPath).href]);

    expect(update.presented).toEqual([
      {
        path: await fs.realpath(artifactPath),
        display_path: 'unsafe____name.PDF',
        name: 'unsafe____name.PDF',
        kind: 'presented',
        relative_path: 'unsafe____name.PDF',
        size: 7,
        mime: 'application/pdf',
        mtime: mtimeMs,
      },
    ]);
  });

  it('sanitizes external display fields without changing the canonical path', async () => {
    const unsafeName = 'external\n\u0085\u202e\u200bname.md';
    const artifactPath = path.join(outside, unsafeName);
    await fs.writeFile(artifactPath, 'payload');
    const canonicalPath = await fs.realpath(artifactPath);

    const update = await createRegistry().present([artifactPath]);

    expect(update.presented).toEqual([
      expect.objectContaining({
        path: canonicalPath,
        display_path: path.join(
          path.dirname(canonicalPath),
          'external____name.md',
        ),
        name: 'external____name.md',
      }),
    ]);
    expect(path.isAbsolute(update.presented[0]!.display_path)).toBe(true);
    expect(update.presented[0]).not.toHaveProperty('relative_path');
  });

  it('skips only snapshot-covered historical results and retains coverage after new output and restart', async () => {
    await fs.writeFile(path.join(workspace, 'old.md'), 'old');
    await fs.writeFile(path.join(workspace, 'new.md'), 'new');
    const old = {
      ...toolResultEvent({
        type: 'present_files',
        isHardFailure: false,
        files: [{ file_path: path.join(workspace, 'old.md') }],
      }),
      uuid: 'old-result',
    };
    const fresh = {
      ...toolResultEvent({
        type: 'present_files',
        isHardFailure: false,
        files: [{ file_path: path.join(workspace, 'new.md') }],
      }),
      uuid: 'new-result',
    };
    const persistence = new MemoryPersistence();
    persistence.value = {
      version: 1,
      records: [],
      coveredToolResultUuids: ['old-result'],
    };
    const registry = createRegistry(persistence);
    await registry.initialize([]);
    expect(await registry.initialize([old])).toEqual([]);
    await registry.observeEvent(fresh);
    expect(persistence.value).toMatchObject({
      coveredToolResultUuids: ['old-result'],
    });
    const recreated = createRegistry(persistence);
    expect(
      (await recreated.initialize([old, fresh]))?.map((entry) => entry.name),
    ).toEqual(['new.md']);
    await recreated.observeEvent({
      ...old,
      uuid: 'new-presentation-of-old-file',
    });
    expect(recreated.snapshot().map((entry) => entry.name)).toEqual([
      'new.md',
      'old.md',
    ]);
  });

  it('omits ENOENT recovery files only when requested and still rejects directories and canonical duplicates', async () => {
    const registry = createRegistry();
    await fs.writeFile(path.join(workspace, 'available.md'), 'available');
    const entry = (await registry.present(['available.md'])).presented[0]!;
    const missing = { ...entry, path: path.join(workspace, 'missing.md') };
    await expect(
      registry.validateExternalSnapshot([missing, entry]),
    ).rejects.toBeInstanceOf(ArtifactPresentationError);
    await expect(
      registry.validateExternalSnapshot([missing, entry], {
        skipMissingFiles: true,
      }),
    ).resolves.toEqual([entry]);
    await expect(
      registry.validateExternalSnapshot([{ ...entry, path: workspace }], {
        skipMissingFiles: true,
      }),
    ).rejects.toBeInstanceOf(ArtifactPresentationError);
    const alias = path.join(workspace, 'available-alias.md');
    await fs.symlink(entry.path, alias);
    await expect(
      registry.validateExternalSnapshot([entry, { ...entry, path: alias }], {
        skipMissingFiles: true,
      }),
    ).rejects.toBeInstanceOf(ArtifactPresentationError);
  });

  it('keeps history discovery unchanged without a recovery marker', async () => {
    await fs.writeFile(path.join(workspace, 'old.md'), 'old');
    const persistence = new MemoryPersistence();
    persistence.value = { version: 1, records: [] };
    const snapshot = await createRegistry(persistence).initialize([
      {
        ...toolResultEvent({
          type: 'present_files',
          isHardFailure: false,
          files: [{ file_path: path.join(workspace, 'old.md') }],
        }),
        uuid: 'old-result',
      },
    ]);
    expect(snapshot?.map((entry) => entry.name)).toEqual(['old.md']);
    expect(persistence.value).not.toHaveProperty('coveredToolResultUuids');
  });

  it.each([null, 'old-result', [null], [''], ['old-result', 'old-result']])(
    'rejects malformed recovery coverage %j without rewriting state',
    async (coveredToolResultUuids) => {
      const persistence = new MemoryPersistence();
      persistence.value = { version: 1, records: [], coveredToolResultUuids };
      expect(await createRegistry(persistence).initialize([])).toBeNull();
      expect(persistence.saves).toEqual([]);
    },
  );

  it('restores persisted artifacts without scanning historical final text', async () => {
    await fs.writeFile(path.join(workspace, 'persisted.pdf'), 'persisted');
    await fs.writeFile(path.join(workspace, 'history.png'), 'history');
    const persistence = new MemoryPersistence();
    const firstRegistry = createRegistry(persistence);
    await firstRegistry.present(['persisted.pdf']);

    const recreated = createRegistry(persistence);
    const snapshot = await recreated.initialize([
      assistantEvent('[history](history.png)', [
        { type: 'text', text: ' [persisted again](persisted.pdf)' },
      ]),
      {
        ...assistantEvent('[child](ignored.pdf)'),
        parent_tool_use_id: 'toolu-parent',
      },
      {
        ...assistantEvent('[not-final](ignored.pdf)'),
        message: {
          stop_reason: 'tool_use',
          content: [{ type: 'text', text: '[ignored](ignored.pdf)' }],
        },
      },
    ]);

    expect(snapshot?.map((entry) => entry.name)).toEqual(['persisted.pdf']);
    expect(persistence.value).toEqual({
      version: 1,
      records: [
        { path: await fs.realpath(path.join(workspace, 'persisted.pdf')) },
      ],
    });
  });

  it('restores changed and presented classifications from real transcript toolUseResult shapes with canonical identity', async () => {
    const firstReport = path.join(workspace, 'reports', 'report.md');
    const secondDirectory = path.join(workspace, 'other');
    const secondReport = path.join(secondDirectory, 'report.md');
    const sharedPath = path.join(workspace, 'shared.md');
    const sharedAlias = path.join(workspace, 'shared-alias.md');
    await fs.mkdir(secondDirectory);
    await fs.writeFile(firstReport, 'first\n');
    await fs.writeFile(secondReport, 'second');
    await fs.writeFile(sharedPath, 'shared');
    await fs.symlink(sharedPath, sharedAlias);

    const snapshot = await createRegistry().initialize([
      toolResultEvent({
        type: 'create',
        filePath: firstReport,
        content: 'first\n',
        structuredPatch: [],
        originalFile: null,
      }),
      toolResultEvent({
        type: 'create',
        filePath: sharedPath,
        content: 'shared',
        structuredPatch: [],
        originalFile: null,
      }),
      toolResultEvent({
        type: 'present_files',
        files: [
          {
            file_path: secondReport,
            path: secondReport,
            display_path: 'other/report.md',
            name: 'report.md',
            kind: 'presented',
            size: 6,
          },
          {
            file_path: sharedAlias,
            path: sharedPath,
            display_path: 'shared.md',
            name: 'shared.md',
            kind: 'presented',
            size: 6,
          },
        ],
        isHardFailure: false,
      }),
    ]);

    expect(snapshot).toEqual([
      expect.objectContaining({
        path: await fs.realpath(firstReport),
        name: 'report.md',
        kind: 'changed',
        additions: 1,
        deletions: 0,
        is_new: true,
      }),
      expect.objectContaining({
        path: await fs.realpath(sharedPath),
        kind: 'presented',
      }),
      expect.objectContaining({
        path: await fs.realpath(secondReport),
        name: 'report.md',
        kind: 'presented',
      }),
    ]);
    expect(snapshot).toHaveLength(3);
  });

  it('restores extensionless and external unknown-extension files from a live present_files typed transcript result', async () => {
    const extensionlessPath = path.join(workspace, 'DELIVERABLE');
    const unknownExtensionPath = path.join(outside, 'archive.custom-output');
    await fs.writeFile(extensionlessPath, 'extensionless');
    await fs.writeFile(unknownExtensionPath, 'unknown extension');
    const liveRegistry = createRegistry();
    const tool = new PresentFilesTool(async (paths) => {
      const observation = await liveRegistry.present(paths);
      return observation.presented;
    });

    const liveResult = await tool
      .build({
        files: [
          { file_path: extensionlessPath },
          { file_path: unknownExtensionPath },
        ],
      })
      .execute(new AbortController().signal);
    expect(liveResult.error).toBeUndefined();
    expect(liveRegistry.snapshot()).toEqual([
      expect.objectContaining({
        path: await fs.realpath(extensionlessPath),
        kind: 'presented',
      }),
      expect.objectContaining({
        path: await fs.realpath(unknownExtensionPath),
        kind: 'presented',
      }),
    ]);

    await expect(
      createRegistry().initialize([toolResultEvent(liveResult.toolUseResult)]),
    ).resolves.toEqual([
      expect.objectContaining({
        path: await fs.realpath(extensionlessPath),
        kind: 'presented',
      }),
      expect.objectContaining({
        path: await fs.realpath(unknownExtensionPath),
        kind: 'presented',
      }),
    ]);
  });

  it('restores a compact Write result from a projected transcript', async () => {
    const filePath = path.join(workspace, 'output.md');
    await fs.writeFile(filePath, 'hello\nworld\n');
    const snapshot = await createRegistry().initialize([
      toolResultEvent({
        success: true,
        file_path: filePath,
        bytesWritten: 12,
        additions: 2,
        deletions: 0,
      }),
    ]);
    expect(snapshot).toEqual([
      expect.objectContaining({
        path: await fs.realpath(filePath),
        name: 'output.md',
        kind: 'changed',
        additions: 2,
        deletions: 0,
        is_new: false,
      }),
    ]);
  });

  it('discovers a compact Edit result from live observeEvent', async () => {
    const filePath = path.join(workspace, 'existing.md');
    await fs.writeFile(filePath, '# Title\n');
    const registry = createRegistry();
    await registry.initialize([]);
    const observation = await registry.observeEvent(
      toolResultEvent({
        success: true,
        file_path: filePath,
        additions: 3,
        deletions: 1,
        diff: '@@ -1,1 +1,3 @@\n-# Title\n+# Updated\n+Line 2\n+Line 3\n',
      }),
    );
    expect(observation?.snapshot).toEqual([
      expect.objectContaining({
        path: await fs.realpath(filePath),
        kind: 'changed',
        additions: 3,
        deletions: 1,
        is_new: false,
      }),
    ]);
  });

  it('rejects a compact-shaped result when mcpMeta is present', async () => {
    const filePath = path.join(workspace, 'mcp-output.md');
    await fs.writeFile(filePath, 'data');
    const snapshot = await createRegistry().initialize([
      {
        ...toolResultEvent({
          success: true,
          file_path: filePath,
          additions: 1,
          deletions: 0,
        }),
        mcpMeta: { _meta: { source: 'mcp-server' } },
      },
    ]);
    expect(snapshot).toEqual([]);
  });

  it('restores multiple compact results from a multi-tool message', async () => {
    const fileA = path.join(workspace, 'a.md');
    const fileB = path.join(workspace, 'b.md');
    await fs.writeFile(fileA, 'a');
    await fs.writeFile(fileB, 'b');
    const snapshot = await createRegistry().initialize([
      {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu-1', content: 'ok' },
            { type: 'tool_result', tool_use_id: 'toolu-2', content: 'ok' },
          ],
        },
        toolUseResult: [
          {
            success: true,
            file_path: fileA,
            bytesWritten: 1,
            additions: 1,
            deletions: 0,
          },
          {
            success: true,
            file_path: fileB,
            additions: 0,
            deletions: 1,
          },
        ],
      },
    ]);
    expect(snapshot).toEqual([
      expect.objectContaining({
        path: await fs.realpath(fileA),
        kind: 'changed',
        additions: 1,
        deletions: 0,
        is_new: false,
      }),
      expect.objectContaining({
        path: await fs.realpath(fileB),
        kind: 'changed',
        additions: 0,
        deletions: 1,
        is_new: false,
      }),
    ]);
  });

  it('restores the default encrypted SessionState segment and revalidates current filesystem metadata', async () => {
    const changedPath = path.join(workspace, 'changed.md');
    const presentedPath = path.join(workspace, 'presented.pdf');
    await fs.writeFile(changedPath, 'old\n');
    await fs.writeFile(presentedPath, 'old');
    const storeOptions = {
      projectRoot: workspace,
      sessionId: '11111111-2222-4333-8444-555555555555',
      configHomeDir: tempDirectory,
      encryptPrivateSegments: true,
    };
    const firstStore = new SessionStateStore(storeOptions);
    const firstRegistry = createRegistry(
      new SessionStateArtifactRegistryPersistence(firstStore),
    );
    await firstRegistry.observeEvent(
      toolResultEvent({
        type: 'create',
        filePath: changedPath,
        content: 'old\n',
        structuredPatch: [],
        originalFile: null,
      }),
    );
    await firstRegistry.present([presentedPath]);

    const serialized = JSON.parse(
      await fs.readFile(firstStore.getSessionStatePath(), 'utf8'),
    ) as { data: Record<string, unknown>; items: Record<string, unknown> };
    expect(serialized.data[ARTIFACT_REGISTRY_SEGMENT_KEY]).toBeUndefined();
    expect(serialized.items[ARTIFACT_REGISTRY_SEGMENT_KEY]).toBeDefined();

    await fs.writeFile(changedPath, 'current changed payload');
    await fs.writeFile(presentedPath, 'current presented payload');
    const restored = await createRegistry(
      new SessionStateArtifactRegistryPersistence(
        new SessionStateStore(storeOptions),
      ),
    ).initialize();

    expect(restored).toEqual([
      expect.objectContaining({
        path: await fs.realpath(changedPath),
        kind: 'changed',
        additions: 1,
        deletions: 0,
        is_new: true,
        size: 'current changed payload'.length,
      }),
      expect.objectContaining({
        path: await fs.realpath(presentedPath),
        kind: 'presented',
        size: 'current presented payload'.length,
      }),
    ]);
  });

  it('keeps an automatic presented classification authoritative when a real runtime replays older create history', async () => {
    const automaticPath = path.join(workspace, 'automatic.md');
    const historyOnlyPath = path.join(workspace, 'history-only.md');
    await fs.writeFile(automaticPath, 'automatic\n');
    await fs.writeFile(historyOnlyPath, 'history only\n');
    const automaticCreate = toolResultEvent({
      type: 'create',
      filePath: automaticPath,
      content: 'automatic\n',
      structuredPatch: [],
      originalFile: null,
    });
    const historyOnlyCreate = toolResultEvent({
      type: 'create',
      filePath: historyOnlyPath,
      content: 'history only\n',
      structuredPatch: [],
      originalFile: null,
    });
    const storeOptions = {
      projectRoot: workspace,
      sessionId: '55555555-6666-4777-8888-999999999999',
      configHomeDir: tempDirectory,
      encryptPrivateSegments: true,
    };
    const createRuntime = () =>
      new SessionArtifactRuntime({
        workingDirectory: workspace,
        initialWorkspaceRoots: [workspace],
        persistence: new SessionStateArtifactRegistryPersistence(
          new SessionStateStore(storeOptions),
        ),
      });
    const firstRuntime = createRuntime();
    await firstRuntime.initialize([]);
    await firstRuntime.observeEvent(automaticCreate);
    await firstRuntime.present([automaticPath]);
    expect(firstRuntime.snapshot()).toEqual([
      expect.objectContaining({ kind: 'presented' }),
    ]);

    await expect(
      createRuntime().initialize([automaticCreate, historyOnlyCreate]),
    ).resolves.toEqual([
      expect.objectContaining({
        path: await fs.realpath(automaticPath),
        kind: 'presented',
      }),
      expect.objectContaining({
        path: await fs.realpath(historyOnlyPath),
        kind: 'changed',
      }),
    ]);
  });

  it('restores external files while omitting unavailable or non-regular records', async () => {
    const validPath = path.join(workspace, 'valid.pdf');
    const missingPath = path.join(workspace, 'missing.pdf');
    const directoryPath = path.join(workspace, 'directory.pdf');
    const outsidePath = path.join(outside, 'outside.pdf');
    const escapePath = path.join(workspace, 'escape.pdf');
    const fifoPath = path.join(workspace, 'artifact.fifo');
    await fs.writeFile(validPath, 'valid');
    await fs.mkdir(directoryPath);
    await fs.writeFile(outsidePath, 'outside');
    await fs.symlink(outsidePath, escapePath);
    if (process.platform !== 'win32') {
      await execFileAsync('mkfifo', [fifoPath]);
    }
    const canonicalValidPath = await fs.realpath(validPath);
    const canonicalOutsidePath = await fs.realpath(outsidePath);
    const storeOptions = {
      projectRoot: workspace,
      sessionId: '22222222-3333-4444-8555-666666666666',
      configHomeDir: tempDirectory,
      encryptPrivateSegments: true,
    };
    const store = new SessionStateStore(storeOptions);
    const persistence = new SessionStateArtifactRegistryPersistence(store);
    await persistence.save({
      version: 1,
      records: [
        { path: validPath },
        { path: missingPath },
        { path: directoryPath },
        { path: outsidePath },
        { path: escapePath },
        ...(process.platform === 'win32' ? [] : [{ path: fifoPath }]),
      ],
    });

    await expect(createRegistry(persistence).initialize()).resolves.toEqual([
      expect.objectContaining({
        path: canonicalValidPath,
        kind: 'presented',
      }),
      expect.objectContaining({
        path: canonicalOutsidePath,
        display_path: canonicalOutsidePath,
        kind: 'presented',
      }),
    ]);
    await expect(persistence.load()).resolves.toEqual({
      version: 1,
      records: [{ path: canonicalValidPath }, { path: canonicalOutsidePath }],
    });

    await fs.unlink(validPath);
    await expect(
      createRegistry(
        new SessionStateArtifactRegistryPersistence(
          new SessionStateStore(storeOptions),
        ),
      ).initialize(),
    ).resolves.toEqual([
      expect.objectContaining({
        path: canonicalOutsidePath,
        kind: 'presented',
      }),
    ]);
    await expect(persistence.load()).resolves.toEqual({
      version: 1,
      records: [{ path: canonicalOutsidePath }],
    });
  });

  it('preserves changed metadata across persistence and revalidation', async () => {
    const artifactPath = path.join(workspace, 'changed.md');
    await fs.writeFile(artifactPath, 'one\ntwo\n');
    const persistence = new MemoryPersistence();
    await createRegistry(persistence).processEvent(
      toolResultEvent({
        type: 'create',
        filePath: artifactPath,
        content: 'one\ntwo\n',
        structuredPatch: [],
        originalFile: null,
      }),
    );

    expect(persistence.value).toEqual({
      version: 1,
      records: [
        {
          path: await fs.realpath(artifactPath),
          kind: 'changed',
          additions: 2,
          deletions: 0,
          is_new: true,
        },
      ],
    });
    await expect(createRegistry(persistence).initialize()).resolves.toEqual([
      expect.objectContaining({
        kind: 'changed',
        additions: 2,
        deletions: 0,
        is_new: true,
      }),
    ]);
  });

  it('keeps valid external records while removing stale persisted records', async () => {
    const outsideFile = path.join(outside, 'outside.pdf');
    await fs.writeFile(outsideFile, 'outside');
    const canonicalOutsideFile = await fs.realpath(outsideFile);
    const persistence = new MemoryPersistence();
    persistence.value = {
      version: 1,
      records: [
        { path: outsideFile },
        { path: path.join(workspace, 'stale.pdf') },
      ],
    };

    await expect(createRegistry(persistence).initialize()).resolves.toEqual([
      expect.objectContaining({
        path: canonicalOutsideFile,
        display_path: canonicalOutsideFile,
      }),
    ]);
    expect(persistence.value).toEqual({
      version: 1,
      records: [{ path: canonicalOutsideFile }],
    });
  });

  it('returns an authoritative empty snapshot for an absent or valid-empty segment', async () => {
    const absentPersistence = new MemoryPersistence();
    await expect(
      createRegistry(absentPersistence).initialize(),
    ).resolves.toEqual([]);
    expect(absentPersistence.saves).toEqual([]);
    const persistence = new MemoryPersistence();
    persistence.value = { version: 1, records: [] };

    await expect(createRegistry(persistence).initialize()).resolves.toEqual([]);
    expect(persistence.saves).toEqual([]);
  });

  it.each([
    ['unknown version', { version: 2, records: [] }],
    ['corrupt top-level state', null],
    ['record with missing path', { version: 1, records: [{}] }],
    [
      'record with relative path',
      { version: 1, records: [{ path: 'relative.pdf' }] },
    ],
  ])('returns unknown without rewriting %s', async (_name, value) => {
    const persistence = new MemoryPersistence();
    persistence.value = value;

    await expect(createRegistry(persistence).initialize()).resolves.toBeNull();
    expect(persistence.saves).toEqual([]);
  });

  it('rejects decoded scheme, file, query, fragment, and scheme-relative names before filesystem access', async () => {
    const decodedHrefs = [
      'https://example.test/report.pdf',
      'file:///decoded-file.pdf',
      `//${workspace.slice(1)}/decoded-relative.pdf`,
      'query.pdf?download=1',
      'fragment.pdf#page=1',
    ];
    for (const href of decodedHrefs) {
      const oldCandidate = path.isAbsolute(href)
        ? href
        : path.resolve(workspace, href);
      await fs.mkdir(path.dirname(oldCandidate), { recursive: true });
      await fs.writeFile(oldCandidate, 'old implementation would accept this');
    }

    const encoded = decodedHrefs.map((href) => encodeURIComponent(href));
    await expect(createRegistry().present(encoded)).rejects.toBeInstanceOf(
      ArtifactPresentationError,
    );
  });

  it('returns null without writing a clearing snapshot when persistence loading fails', async () => {
    await fs.writeFile(path.join(workspace, 'history.pdf'), 'history');
    const persistence = new MemoryPersistence();
    persistence.loadError = new Error('corrupt encrypted segment');

    await expect(
      createRegistry(persistence).initialize([
        assistantEvent('[history](history.pdf)'),
      ]),
    ).resolves.toBeNull();
    expect(persistence.saves).toEqual([]);
  });

  it('rolls back an event when persistence fails so it can be retried', async () => {
    const retryPath = path.join(workspace, 'retry.pdf');
    await fs.writeFile(retryPath, 'artifact');
    const persistence = new MemoryPersistence();
    const registry = createRegistry(persistence);
    persistence.saveError = new Error('disk full');
    const event = toolResultEvent({
      type: 'create',
      filePath: retryPath,
      content: 'artifact',
      structuredPatch: [],
      originalFile: null,
    });

    await expect(registry.processEvent(event)).rejects.toThrow('disk full');
    expect(registry.snapshot()).toEqual([]);

    await expect(registry.processEvent(event)).resolves.toMatchObject([
      { name: 'retry.pdf' },
    ]);
    expect(persistence.saves).toHaveLength(1);
  });

  it('explicitly presents exact same-basename paths and special characters without ambiguity', async () => {
    const relativePaths = [
      'report.md',
      'left/report.md',
      'right/中文 报告 (最终).md',
    ];
    for (const [index, relativePath] of relativePaths.entries()) {
      const pathname = path.join(workspace, relativePath);
      await fs.mkdir(path.dirname(pathname), { recursive: true });
      await fs.writeFile(pathname, `artifact-${index}`);
    }
    const persistence = new MemoryPersistence();
    const registry = createRegistry(persistence);

    const observation = await registry.present(relativePaths);

    expect(
      observation.presented.map(({ display_path }) => display_path),
    ).toEqual(relativePaths);
    expect(
      observation.snapshot?.map(({ display_path }) => display_path),
    ).toEqual(relativePaths);
    expect(persistence.saves).toHaveLength(1);
  });

  it('keeps same-basename files at workspace and external paths distinct', async () => {
    const insidePath = path.join(workspace, 'report.md');
    const outsidePath = path.join(outside, 'report.md');
    await fs.writeFile(insidePath, 'inside');
    await fs.writeFile(outsidePath, 'outside');
    const canonicalInsidePath = await fs.realpath(insidePath);
    const canonicalOutsidePath = await fs.realpath(outsidePath);

    const observation = await createRegistry().present([
      insidePath,
      outsidePath,
    ]);

    expect(observation.presented.map(({ path: pathname }) => pathname)).toEqual(
      [canonicalInsidePath, canonicalOutsidePath],
    );
    expect(observation.presented.map(({ name }) => name)).toEqual([
      'report.md',
      'report.md',
    ]);
    expect(
      observation.presented.map(({ display_path }) => display_path),
    ).toEqual(['report.md', canonicalOutsidePath]);
  });

  it('explicitly presents regular files outside the automatic discovery allowlist', async () => {
    const names = ['notes.txt', 'data.json', 'style.css'];
    for (const name of names) {
      await fs.writeFile(path.join(workspace, name), name);
    }
    const persistence = new MemoryPersistence();
    const registry = createRegistry(persistence);

    const observation = await registry.present(names);

    expect(
      observation.presented.map(({ display_path }) => display_path),
    ).toEqual(names);
    expect(observation.presented.map(({ mime }) => mime)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(observation.snapshot).toHaveLength(3);
    await expect(createRegistry(persistence).initialize()).resolves.toEqual(
      expect.arrayContaining(
        names.map((displayPath) =>
          expect.objectContaining({ display_path: displayPath }),
        ),
      ),
    );
  });

  it('removes unchanged current-turn working artifacts superseded by an explicit delivery', async () => {
    const temporaryPath = path.join(workspace, 'vibe_images', 'draft.png');
    const finalPath = path.join(workspace, 'generated', 'final.png');
    await fs.mkdir(path.dirname(temporaryPath), { recursive: true });
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.writeFile(temporaryPath, 'temporary');
    await fs.writeFile(finalPath, 'final');
    const registry = createRegistry();
    const temporaryObservation = await registry.observeEvent(
      toolResultEvent({
        filePath: temporaryPath,
        requestId: 'image-request-1',
      }),
    );
    const temporaryArtifact = temporaryObservation?.changedArtifacts[0];
    if (!temporaryArtifact) throw new Error('temporary artifact not observed');

    const observation = await registry.present([finalPath], {
      supersededArtifacts: [temporaryArtifact],
    });

    expect(observation.snapshot).toEqual([
      expect.objectContaining({
        path: await fs.realpath(finalPath),
        kind: 'presented',
      }),
    ]);
  });

  it('preserves a superseded working path when it changed after the snapshot', async () => {
    const temporaryPath = path.join(workspace, 'draft.png');
    const finalPath = path.join(workspace, 'final.png');
    await fs.writeFile(temporaryPath, 'v1');
    await fs.writeFile(finalPath, 'final');
    const registry = createRegistry();
    const firstObservation = await registry.observeEvent(
      toolResultEvent({
        filePath: temporaryPath,
        requestId: 'image-request-1',
      }),
    );
    const firstArtifact = firstObservation?.changedArtifacts[0];
    if (!firstArtifact) throw new Error('first artifact not observed');
    await fs.writeFile(temporaryPath, 'version-2');
    await registry.observeEvent(
      toolResultEvent({
        filePath: temporaryPath,
        requestId: 'image-request-2',
      }),
    );

    const observation = await registry.present([finalPath], {
      supersededArtifacts: [firstArtifact],
    });

    expect(observation.snapshot).toEqual([
      expect.objectContaining({
        path: await fs.realpath(temporaryPath),
        kind: 'changed',
        size: 'version-2'.length,
      }),
      expect.objectContaining({
        path: await fs.realpath(finalPath),
        kind: 'presented',
      }),
    ]);
  });

  it('rejects an explicit presentation atomically when any path is invalid', async () => {
    await fs.writeFile(path.join(workspace, 'valid.md'), 'valid');
    await fs.writeFile(path.join(workspace, 'additional.txt'), 'additional');
    const registry = createRegistry();

    await expect(
      registry.present(['valid.md', 'missing.md', 'additional.txt']),
    ).rejects.toEqual(new ArtifactPresentationError(['missing.md']));
    expect(registry.snapshot()).toEqual([]);
  });

  it('returns a full snapshot for an already indexed presentation without rewriting state', async () => {
    await fs.writeFile(path.join(workspace, 'existing.md'), 'existing');
    const persistence = new MemoryPersistence();
    const registry = createRegistry(persistence);
    await registry.present(['existing.md']);
    persistence.saves = [];

    const observation = await registry.present(['existing.md', 'existing.md']);

    expect(observation).toEqual({
      snapshot: [expect.objectContaining({ display_path: 'existing.md' })],
      presented: [expect.objectContaining({ display_path: 'existing.md' })],
      changedArtifacts: [],
    });
    expect(persistence.saves).toEqual([]);
  });

  it('serializes mutations so one failed save cannot roll back a concurrent revalidation', async () => {
    const existingPath = path.join(workspace, 'existing.pdf');
    const pendingPath = path.join(workspace, 'pending.md');
    await fs.writeFile(existingPath, 'existing');
    await fs.writeFile(pendingPath, 'pending');
    const canonicalExistingPath = await fs.realpath(existingPath);
    const persistence = new MemoryPersistence();
    const registry = createRegistry(persistence);
    await registry.present(['existing.pdf']);

    const firstSaveStarted = deferred<void>();
    const firstSave = deferred<void>();
    const secondSaveStarted = deferred<void>();
    let saveAttempt = 0;
    persistence.save = async (value: unknown) => {
      saveAttempt++;
      if (saveAttempt === 1) {
        firstSaveStarted.resolve();
        await firstSave.promise;
      } else {
        secondSaveStarted.resolve();
      }
      persistence.value = structuredClone(value);
      persistence.saves.push(structuredClone(value));
    };

    const pendingEvent = registry.processEvent(
      toolResultEvent({
        type: 'create',
        filePath: pendingPath,
        content: 'pending',
        structuredPatch: [],
        originalFile: null,
      }),
    );
    const pendingFailure = pendingEvent.catch((error: unknown) => error);
    await firstSaveStarted.promise;
    await fs.unlink(existingPath);
    const revalidation = registry.revalidate(canonicalExistingPath);
    const concurrentSaveStarted = await Promise.race([
      secondSaveStarted.promise.then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), 50);
      }),
    ]);
    firstSave.reject(new Error('disk full'));

    expect(await pendingFailure).toEqual(new Error('disk full'));
    await expect(revalidation).resolves.toEqual({
      status: 'unavailable',
      snapshot: [],
    });
    expect(registry.snapshot()).toEqual([]);
    expect(concurrentSaveStarted).toBe(false);
  });

  it('revalidates only an exact registered key, refreshes metadata, removes unavailable entries, and persists each snapshot', async () => {
    const artifactPath = path.join(workspace, 'selected.pdf');
    await fs.writeFile(artifactPath, 'first');
    const canonicalPath = await fs.realpath(artifactPath);
    const persistence = new MemoryPersistence();
    const registry = createRegistry(persistence);
    await registry.present(['selected.pdf']);
    persistence.saves = [];

    await fs.writeFile(artifactPath, 'updated payload');
    const changed = await registry.revalidate(canonicalPath);

    expect(changed).toEqual({
      status: 'changed',
      snapshot: [
        expect.objectContaining({
          path: canonicalPath,
          size: 15,
        }),
      ],
    });
    expect(persistence.saves).toHaveLength(1);

    await fs.unlink(artifactPath);
    const unavailable = await registry.revalidate(canonicalPath);

    expect(unavailable).toEqual({
      status: 'unavailable',
      snapshot: [],
    });
    expect(persistence.saves).toHaveLength(2);
    await expect(
      registry.revalidate(path.join(workspace, '.', 'selected.pdf')),
    ).resolves.toEqual({ status: 'not_registered' });
  });

  it('rolls back initialization when persistence fails', async () => {
    await fs.writeFile(path.join(workspace, 'history.pdf'), 'artifact');
    const persistence = new MemoryPersistence();
    persistence.value = { version: 1, records: [] };
    persistence.saveError = new Error('disk full');
    const registry = createRegistry(persistence);
    const history = [
      toolResultEvent({
        type: 'create',
        filePath: path.join(workspace, 'history.pdf'),
        content: 'artifact',
        structuredPatch: [],
        originalFile: null,
      }),
    ];

    await expect(registry.initialize(history)).rejects.toThrow('disk full');
    expect(registry.snapshot()).toEqual([]);

    await expect(registry.initialize(history)).resolves.toMatchObject([
      { name: 'history.pdf' },
    ]);
  });

  it('the SessionStateStore adapter uses one versioned segment with default encryption', async () => {
    const calls: unknown[][] = [];
    const stateStore = {
      async getSegment(segmentKey: string): Promise<unknown> {
        calls.push(['get', segmentKey]);
        return { version: 1, records: [] };
      },
      async setSegment(
        segmentKey: string,
        value: unknown,
        options?: { encrypted?: boolean },
      ): Promise<unknown> {
        calls.push(['set', segmentKey, value, options]);
        return undefined;
      },
    };
    const persistence = new SessionStateArtifactRegistryPersistence(stateStore);

    await expect(persistence.load()).resolves.toEqual({
      version: 1,
      records: [],
    });
    await persistence.save({ version: 1, records: [] });

    expect(calls).toEqual([
      ['get', ARTIFACT_REGISTRY_SEGMENT_KEY],
      [
        'set',
        ARTIFACT_REGISTRY_SEGMENT_KEY,
        { version: 1, records: [] },
        undefined,
      ],
    ]);
  });
});
