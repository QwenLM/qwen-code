import type {
  CompletionContext,
  CompletionResult,
} from '@codemirror/autocomplete';

export type GlobFn = (
  pattern: string,
  opts?: { maxResults?: number },
) => Promise<{ matches: string[] }>;

export interface ExtensionCompletionEntry {
  name: string;
  displayName?: string;
  description?: string;
  isActive: boolean;
}

export type LoadExtensionsFn = () => Promise<{
  extensions: ExtensionCompletionEntry[];
}>;

export function createAtCompletionSource(
  getGlob: () => GlobFn | undefined,
  getLoadExtensions: () => LoadExtensionsFn | undefined = () => undefined,
): (
  context: CompletionContext,
) => CompletionResult | null | Promise<CompletionResult | null> {
  return (context) => atCompletionSource(context, getGlob, getLoadExtensions);
}

export function atCompletionSource(
  context: CompletionContext,
  getGlob: () => GlobFn | undefined,
  getLoadExtensions: () => LoadExtensionsFn | undefined = () => undefined,
): CompletionResult | null | Promise<CompletionResult | null> {
  const line = context.state.doc.lineAt(context.pos);
  const textBefore = line.text.slice(0, context.pos - line.from);

  const match = textBefore.match(/@([\w./:-]*)$/);
  if (!match) return null;

  const prefix = match[1];
  const atPos = context.pos - match[0].length;
  const extensionOnly = prefix.startsWith('ext:');
  const extensionQuery = extensionOnly ? prefix.slice('ext:'.length) : prefix;
  const glob = extensionOnly ? undefined : getGlob();
  const loadExtensions = getLoadExtensions();

  return Promise.all([
    fetchExtensions(extensionQuery, loadExtensions),
    glob ? fetchFiles(prefix, glob) : Promise.resolve([]),
  ]).then(([extensions, files]) => {
    if (extensions.length === 0 && files.length === 0) return null;
    return {
      from: atPos,
      options: [
        ...extensions.map((ext) => ({
          label: `@ext:${ext.name}`,
          apply: `@ext:${ext.name} `,
          detail: extensionDetail(ext),
          type: 'keyword',
          section: 'Extensions',
          boost: 20,
        })),
        ...files.map((f) => ({
          label: `@${f}`,
          apply: `@${f} `,
          type: 'file',
          section: 'Files',
        })),
      ],
      filter: false,
    };
  });
}

async function fetchFiles(prefix: string, glob: GlobFn): Promise<string[]> {
  try {
    const pattern = prefix ? `${prefix}*` : '**/*';
    const result = await glob(pattern, { maxResults: 50 });
    return result.matches.filter((file) => file !== '.');
  } catch {
    return [];
  }
}

async function fetchExtensions(
  query: string,
  loadExtensions: LoadExtensionsFn | undefined,
): Promise<ExtensionCompletionEntry[]> {
  if (!loadExtensions) return [];
  try {
    const status = await loadExtensions();
    const lowerQuery = query.toLowerCase();
    return status.extensions
      .filter((ext) => ext.isActive)
      .map((ext) => ({
        ...ext,
        displayName: sanitizeDisplayText(ext.displayName ?? '') ?? undefined,
        description: sanitizeDisplayText(ext.description ?? '') ?? undefined,
      }))
      .filter((ext) => {
        const name = ext.name.toLowerCase();
        const display = ext.displayName?.toLowerCase() ?? '';
        return name.includes(lowerQuery) || display.includes(lowerQuery);
      })
      .sort((a, b) => {
        const aLabel = (a.displayName || a.name).toLowerCase();
        const bLabel = (b.displayName || b.name).toLowerCase();
        const aPrefix = aLabel.startsWith(lowerQuery) ? 0 : 1;
        const bPrefix = bLabel.startsWith(lowerQuery) ? 0 : 1;
        if (aPrefix !== bPrefix) return aPrefix - bPrefix;
        return aLabel.localeCompare(bLabel);
      })
      .slice(0, 50);
  } catch {
    return [];
  }
}

function extensionDetail(ext: ExtensionCompletionEntry): string | undefined {
  const display =
    ext.displayName && ext.displayName !== ext.name
      ? ext.displayName
      : undefined;
  if (display && ext.description) return `${display} - ${ext.description}`;
  return display ?? ext.description;
}

const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])`, 'g');
const BIDI_CONTROL_RE = /[‎‏؜⁦⁧⁨⁩‪‫‬‭‮]/g;

function sanitizeDisplayText(raw: string): string | null {
  const stripped = raw
    .replace(ANSI_RE, '')
    .replace(BIDI_CONTROL_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 0 ? stripped : null;
}
