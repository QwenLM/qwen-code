/**
 * File System Access API surface TypeScript's DOM lib does not ship yet: the
 * picker entry point, the handle permission methods, and the directory async
 * iterator. Chromium-only and secure-context-only — `capabilities.ts` probes
 * for all three at runtime instead of assuming them.
 */

type FileSystemPermissionMode = 'read' | 'readwrite';

interface FileSystemHandlePermissionDescriptor {
  mode?: FileSystemPermissionMode;
}

interface FileSystemHandle {
  queryPermission(
    descriptor?: FileSystemHandlePermissionDescriptor,
  ): Promise<PermissionState>;
  requestPermission(
    descriptor?: FileSystemHandlePermissionDescriptor,
  ): Promise<PermissionState>;
}

interface FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemHandle>;
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  keys(): AsyncIterableIterator<string>;
}

interface ShowDirectoryPickerOptions {
  id?: string;
  mode?: FileSystemPermissionMode;
  startIn?: string;
}

interface Window {
  /** Absent on non-Chromium browsers and in insecure contexts. */
  showDirectoryPicker?(
    options?: ShowDirectoryPickerOptions,
  ): Promise<FileSystemDirectoryHandle>;
}
