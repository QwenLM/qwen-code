/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ChangeDetector } from './changeDetector.js';
import type {
  FileMetadata,
  IFileScanner,
  IMetadataStore,
  ChangeSet,
} from './types.js';

/**
 * Mock FileScanner for testing.
 */
class MockFileScanner implements IFileScanner {
  private files: FileMetadata[] = [];

  setFiles(files: FileMetadata[]): void {
    this.files = files;
  }

  async scanFiles(): Promise<FileMetadata[]> {
    return this.files;
  }

  async countFiles(): Promise<number> {
    return this.files.length;
  }

  async scanSpecificFiles(filePaths: string[]): Promise<FileMetadata[]> {
    return this.files.filter((f) => filePaths.includes(f.path));
  }
}

/**
 * Mock MetadataStore for testing.
 */
class MockMetadataStore implements Partial<IMetadataStore> {
  private files: Map<string, FileMetadata> = new Map();

  setFiles(files: FileMetadata[]): void {
    this.files.clear();
    for (const file of files) {
      this.files.set(file.path, file);
    }
  }

  getAllFileMeta(): FileMetadata[] {
    return Array.from(this.files.values());
  }

  getFileMeta(path: string): FileMetadata | null {
    return this.files.get(path) || null;
  }
}

describe('ChangeDetector', () => {
  let fileScanner: MockFileScanner;
  let metadataStore: MockMetadataStore;
  let changeDetector: ChangeDetector;

  beforeEach(() => {
    fileScanner = new MockFileScanner();
    metadataStore = new MockMetadataStore();
    changeDetector = new ChangeDetector(
      fileScanner,
      metadataStore as unknown as IMetadataStore,
    );
  });

  describe('detectChanges', () => {
    it('should detect added files', async () => {
      // Current files have a new file
      fileScanner.setFiles([
        {
          path: 'src/new.ts',
          contentHash: 'hash1',
          lastModified: 1000,
          size: 100,
        },
      ]);

      // No indexed files
      metadataStore.setFiles([]);

      const changes = await changeDetector.detectChanges();

      expect(changes.added).toHaveLength(1);
      expect(changes.added[0].path).toBe('src/new.ts');
      expect(changes.modified).toHaveLength(0);
      expect(changes.deleted).toHaveLength(0);
    });

    it('should detect deleted files', async () => {
      // No current files
      fileScanner.setFiles([]);

      // Indexed file exists
      metadataStore.setFiles([
        {
          path: 'src/deleted.ts',
          contentHash: 'hash1',
          lastModified: 1000,
          size: 100,
        },
      ]);

      const changes = await changeDetector.detectChanges();

      expect(changes.added).toHaveLength(0);
      expect(changes.modified).toHaveLength(0);
      expect(changes.deleted).toHaveLength(1);
      expect(changes.deleted[0]).toBe('src/deleted.ts');
    });

    it('should detect modified files by hash', async () => {
      // Current file has different hash and newer mtime
      fileScanner.setFiles([
        {
          path: 'src/modified.ts',
          contentHash: 'newhash',
          lastModified: 2000,
          size: 150,
        },
      ]);

      // Indexed file has old hash
      metadataStore.setFiles([
        {
          path: 'src/modified.ts',
          contentHash: 'oldhash',
          lastModified: 1000,
          size: 100,
        },
      ]);

      const changes = await changeDetector.detectChanges();

      expect(changes.added).toHaveLength(0);
      expect(changes.modified).toHaveLength(1);
      expect(changes.modified[0].path).toBe('src/modified.ts');
      expect(changes.modified[0].contentHash).toBe('newhash');
      expect(changes.deleted).toHaveLength(0);
    });

    it('should not detect unchanged files', async () => {
      const file: FileMetadata = {
        path: 'src/unchanged.ts',
        contentHash: 'samehash',
        lastModified: 1000,
        size: 100,
      };

      fileScanner.setFiles([file]);
      metadataStore.setFiles([file]);

      const changes = await changeDetector.detectChanges();

      expect(changes.added).toHaveLength(0);
      expect(changes.modified).toHaveLength(0);
      expect(changes.deleted).toHaveLength(0);
    });

    it('should not detect files with same mtime as modified', async () => {
      // Current file has same mtime but different hash
      // Should not be detected as modified (optimization)
      fileScanner.setFiles([
        {
          path: 'src/file.ts',
          contentHash: 'newhash',
          lastModified: 1000, // Same mtime
          size: 150,
        },
      ]);

      metadataStore.setFiles([
        {
          path: 'src/file.ts',
          contentHash: 'oldhash',
          lastModified: 1000, // Same mtime
          size: 100,
        },
      ]);

      const changes = await changeDetector.detectChanges();

      // With default options (alwaysComputeHash: false), this should not be detected
      expect(changes.modified).toHaveLength(0);
    });

    it('should handle mixed changes', async () => {
      fileScanner.setFiles([
        {
          path: 'src/new.ts',
          contentHash: 'hash1',
          lastModified: 1000,
          size: 100,
        },
        {
          path: 'src/modified.ts',
          contentHash: 'newhash',
          lastModified: 2000,
          size: 150,
        },
        {
          path: 'src/unchanged.ts',
          contentHash: 'hash3',
          lastModified: 1000,
          size: 100,
        },
      ]);

      metadataStore.setFiles([
        {
          path: 'src/deleted.ts',
          contentHash: 'hash0',
          lastModified: 1000,
          size: 100,
        },
        {
          path: 'src/modified.ts',
          contentHash: 'oldhash',
          lastModified: 1000,
          size: 100,
        },
        {
          path: 'src/unchanged.ts',
          contentHash: 'hash3',
          lastModified: 1000,
          size: 100,
        },
      ]);

      const changes = await changeDetector.detectChanges();

      expect(changes.added).toHaveLength(1);
      expect(changes.added[0].path).toBe('src/new.ts');
      expect(changes.modified).toHaveLength(1);
      expect(changes.modified[0].path).toBe('src/modified.ts');
      expect(changes.deleted).toHaveLength(1);
      expect(changes.deleted[0]).toBe('src/deleted.ts');
    });

    it('should handle empty workspace', async () => {
      fileScanner.setFiles([]);
      metadataStore.setFiles([]);

      const changes = await changeDetector.detectChanges();

      expect(changes.added).toHaveLength(0);
      expect(changes.modified).toHaveLength(0);
      expect(changes.deleted).toHaveLength(0);
    });
  });

  describe('detectChangesForFiles', () => {
    it('should detect changes for specific files only', async () => {
      fileScanner.setFiles([
        {
          path: 'src/a.ts',
          contentHash: 'hash1',
          lastModified: 1000,
          size: 100,
        },
        {
          path: 'src/b.ts',
          contentHash: 'hash2',
          lastModified: 1000,
          size: 100,
        },
      ]);

      metadataStore.setFiles([
        {
          path: 'src/a.ts',
          contentHash: 'oldhash',
          lastModified: 500,
          size: 100,
        },
      ]);

      // Only check src/a.ts
      const changes = await changeDetector.detectChangesForFiles(['src/a.ts']);

      expect(changes.modified).toHaveLength(1);
      expect(changes.modified[0].path).toBe('src/a.ts');
      // src/b.ts should not appear (not in the list to check)
    });
  });

  describe('summarize', () => {
    it('should summarize no changes', () => {
      const changes: ChangeSet = { added: [], modified: [], deleted: [] };
      expect(ChangeDetector.summarize(changes)).toBe('No changes detected');
    });

    it('should summarize added files', () => {
      const changes: ChangeSet = {
        added: [{ path: 'a.ts', contentHash: 'h', lastModified: 1, size: 1 }],
        modified: [],
        deleted: [],
      };
      expect(ChangeDetector.summarize(changes)).toBe('1 added');
    });

    it('should summarize mixed changes', () => {
      const changes: ChangeSet = {
        added: [{ path: 'a.ts', contentHash: 'h', lastModified: 1, size: 1 }],
        modified: [
          { path: 'b.ts', contentHash: 'h', lastModified: 1, size: 1 },
          { path: 'c.ts', contentHash: 'h', lastModified: 1, size: 1 },
        ],
        deleted: ['d.ts'],
      };
      expect(ChangeDetector.summarize(changes)).toBe(
        '1 added, 2 modified, 1 deleted',
      );
    });
  });

  describe('with alwaysComputeHash option', () => {
    it('should detect modified files even with same mtime when alwaysComputeHash is true', async () => {
      const detectorWithHash = new ChangeDetector(
        fileScanner,
        metadataStore as unknown as IMetadataStore,
        { alwaysComputeHash: true },
      );

      fileScanner.setFiles([
        {
          path: 'src/file.ts',
          contentHash: 'newhash',
          lastModified: 1000, // Same mtime
          size: 150,
        },
      ]);

      metadataStore.setFiles([
        {
          path: 'src/file.ts',
          contentHash: 'oldhash',
          lastModified: 1000, // Same mtime
          size: 100,
        },
      ]);

      const changes = await detectorWithHash.detectChanges();

      // With alwaysComputeHash: true, this should be detected
      expect(changes.modified).toHaveLength(1);
      expect(changes.modified[0].path).toBe('src/file.ts');
    });
  });
});
