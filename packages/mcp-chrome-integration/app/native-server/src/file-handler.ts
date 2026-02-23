import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import fetch from 'node-fetch';

/**
 * File handler for managing file uploads through the native messaging host
 */
export class FileHandler {
  private tempDir: string;

  constructor() {
    // Create a temp directory for file operations
    this.tempDir = path.join(os.tmpdir(), 'chrome-mcp-uploads');
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Handle file preparation request from the extension
   */
  async handleFileRequest(request: any): Promise<any> {
    const { action, fileUrl, base64Data, fileName, filePath, traceFilePath, insightName } = request;

    try {
      switch (action) {
        case 'prepareFile':
          if (fileUrl) {
            return await this.downloadFile(fileUrl, fileName);
          } else if (base64Data) {
            return await this.saveBase64File(base64Data, fileName);
          } else if (filePath) {
            return await this.verifyFile(filePath);
          }
          break;

        case 'readBase64File': {
          if (!filePath) return { success: false, error: 'filePath is required' };
          return await this.readBase64File(filePath);
        }

        case 'cleanupFile':
          return await this.cleanupFile(filePath);

        case 'analyzeTrace': {
          const targetPath = traceFilePath || filePath;
          if (!targetPath) {
            return { success: false, error: 'traceFilePath is required' };
          }
          try {
            // With tsconfig moduleResolution=NodeNext, relative ESM imports need explicit .js extension
            const { analyzeTraceFile } = await import('./trace-analyzer.js');
            const res = await analyzeTraceFile(targetPath, insightName);
            return { success: true, ...res };
          } catch (e: any) {
            return { success: false, error: e?.message || String(e) };
          }
        }

        default:
          return {
            success: false,
            error: `Unknown file action: ${action}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Download a file from URL and save to temp directory
   */
  private async downloadFile(fileUrl: string, fileName?: string): Promise<any> {
    try {
      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.statusText}`);
      }

      // Generate filename if not provided
      const finalFileName = fileName || this.generateFileName(fileUrl);
      const filePath = path.join(this.tempDir, finalFileName);

      // Get the file buffer
      const buffer = await response.buffer();

      // Save to file
      fs.writeFileSync(filePath, buffer);

      return {
        success: true,
        filePath: filePath,
        fileName: finalFileName,
        size: buffer.length,
      };
    } catch (error) {
      throw new Error(`Failed to download file from URL: ${error}`);
    }
  }

  /**
   * Save base64 data as a file
   */
  private async saveBase64File(base64Data: string, fileName?: string): Promise<any> {
    try {
      // Remove data URL prefix if present
      const base64Content = base64Data.replace(/^data:.*?;base64,/, '');

      // Convert base64 to buffer
      const buffer = Buffer.from(base64Content, 'base64');

      // Generate filename if not provided
      const finalFileName = fileName || `upload-${Date.now()}.bin`;
      const filePath = path.join(this.tempDir, finalFileName);

      // Save to file
      fs.writeFileSync(filePath, buffer);

      return {
        success: true,
        filePath: filePath,
        fileName: finalFileName,
        size: buffer.length,
      };
    } catch (error) {
      throw new Error(`Failed to save base64 file: ${error}`);
    }
  }

  /**
   * Verify that a file exists and is accessible
   */
  private async verifyFile(filePath: string): Promise<any> {
    try {
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        throw new Error(`File does not exist: ${filePath}`);
      }

      // Get file stats
      const stats = fs.statSync(filePath);

      // Check if it's actually a file
      if (!stats.isFile()) {
        throw new Error(`Path is not a file: ${filePath}`);
      }

      // Check if file is readable
      fs.accessSync(filePath, fs.constants.R_OK);

      return {
        success: true,
        filePath: filePath,
        fileName: path.basename(filePath),
        size: stats.size,
      };
    } catch (error) {
      throw new Error(`Failed to verify file: ${error}`);
    }
  }

  /**
   * Read file content and return as base64 string
   */
  private async readBase64File(filePath: string): Promise<any> {
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`File does not exist: ${filePath}`);
      }
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) {
        throw new Error(`Path is not a file: ${filePath}`);
      }
      const buf = fs.readFileSync(filePath);
      const base64 = buf.toString('base64');
      return {
        success: true,
        filePath,
        fileName: path.basename(filePath),
        size: stats.size,
        base64Data: base64,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Clean up a temporary file
   */
  private async cleanupFile(filePath: string): Promise<any> {
    try {
      // Only allow cleanup of files in our temp directory
      if (!filePath.startsWith(this.tempDir)) {
        return {
          success: false,
          error: 'Can only cleanup files in temp directory',
        };
      }

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      return {
        success: true,
        message: 'File cleaned up successfully',
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to cleanup file: ${error}`,
      };
    }
  }

  /**
   * Generate a filename from URL or create a unique one
   */
  private generateFileName(url?: string): string {
    if (url) {
      try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        const basename = path.basename(pathname);
        if (basename && basename !== '/') {
          // Add random suffix to avoid collisions
          const ext = path.extname(basename);
          const name = path.basename(basename, ext);
          const randomSuffix = crypto.randomBytes(4).toString('hex');
          return `${name}-${randomSuffix}${ext}`;
        }
      } catch {
        // Invalid URL, fall through to generate random name
      }
    }

    // Generate random filename
    return `upload-${crypto.randomBytes(8).toString('hex')}.bin`;
  }

  /**
   * Clean up old temporary files (older than 1 hour)
   */
  cleanupOldFiles(): void {
    try {
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;

      const files = fs.readdirSync(this.tempDir);
      for (const file of files) {
        const filePath = path.join(this.tempDir, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > oneHour) {
          fs.unlinkSync(filePath);
          // Use stderr to avoid polluting stdout (Native Messaging protocol)
          console.error(`Cleaned up old temp file: ${file}`);
        }
      }
    } catch (error) {
      console.error('Error cleaning up old files:', error);
    }
  }
}

export default new FileHandler();
