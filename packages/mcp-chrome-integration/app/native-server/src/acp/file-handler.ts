import { promises as fs } from 'node:fs';
import * as path from 'node:path';

type ReadTextFileParams = {
  path: string;
  sessionId: string;
  line: number | null;
  limit: number | null;
};

type WriteTextFileParams = {
  path: string;
  content: string;
  sessionId: string;
};

export class AcpFileHandler {
  async handleReadTextFile(
    params: ReadTextFileParams,
  ): Promise<{ content: string }> {
    const content = await fs.readFile(params.path, 'utf-8');

    if (params.line !== null || params.limit !== null) {
      const lines = content.split('\n');
      const startLine = params.line || 0;
      const endLine = params.limit ? startLine + params.limit : lines.length;
      const selectedLines = lines.slice(startLine, endLine);
      return { content: selectedLines.join('\n') };
    }

    return { content };
  }

  async handleWriteTextFile(params: WriteTextFileParams): Promise<null> {
    const dirName = path.dirname(params.path);
    await fs.mkdir(dirName, { recursive: true });
    await fs.writeFile(params.path, params.content, 'utf-8');
    return null;
  }
}
