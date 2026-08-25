import { createHash } from 'node:crypto';

const FILE_OPENING = '[FILE:';
const MAX_FILE_PATH_CHARS = 4096;
export const MAX_FILES_PER_RESPONSE = 5;

export interface FileProjection {
  text: string;
  paths: string[];
  invalidMarkers: number;
  excessMarkers: number;
  markerCount: number;
}

export class OutboundFileProjector {
  private readonly hash = createHash('sha256');
  private inputLength = 0;
  private candidate = '';
  private reserved = '';
  private reservedAtLineStart = false;
  private reservedTooLong = false;
  private atLineStart = true;
  private readonly paths: string[] = [];
  private invalidMarkers = 0;
  private excessMarkers = 0;
  private markerCount = 0;

  append(chunk: string): string {
    this.hash.update(chunk);
    this.inputLength += chunk.length;
    let safe = '';
    for (const char of chunk) {
      if (this.reserved) {
        if (char === '\n') {
          this.finishReservedLine();
          safe += '\n';
          this.atLineStart = true;
        } else if (this.reserved.length <= MAX_FILE_PATH_CHARS + 9) {
          this.reserved += char;
        } else {
          this.reservedTooLong = true;
        }
        continue;
      }
      if (char === '\n') {
        safe += `${this.candidate}\n`;
        this.candidate = '';
        this.atLineStart = true;
        continue;
      }
      this.candidate += char;
      while (this.candidate && !FILE_OPENING.startsWith(this.candidate)) {
        safe += this.candidate[0];
        this.candidate = this.candidate.slice(1);
        this.atLineStart = false;
      }
      if (this.candidate === FILE_OPENING) {
        this.reserved = this.candidate;
        this.reservedAtLineStart = this.atLineStart;
        this.candidate = '';
        this.markerCount++;
      }
    }
    return safe;
  }

  complete(): string {
    if (!this.reserved) {
      const safe = this.candidate;
      this.candidate = '';
      return safe;
    }
    this.finishReservedLine();
    return '';
  }

  matches(text: string): boolean {
    return (
      text.length === this.inputLength &&
      this.hash.digest('hex') ===
        createHash('sha256').update(text).digest('hex')
    );
  }

  result(text: string): FileProjection {
    return {
      text,
      paths: [...this.paths],
      invalidMarkers: this.invalidMarkers,
      excessMarkers: this.excessMarkers,
      markerCount: this.markerCount,
    };
  }

  hasReservedLine(): boolean {
    return this.reserved.length > 0;
  }

  private finishReservedLine(): void {
    const match = /^\[FILE: ([^\]\r\n]+)\]\r?$/u.exec(this.reserved);
    const path = match?.[1];
    if (
      !this.reservedTooLong &&
      this.reservedAtLineStart &&
      path &&
      path.length <= MAX_FILE_PATH_CHARS &&
      path === path.trim()
    ) {
      if (this.paths.length < MAX_FILES_PER_RESPONSE) {
        this.paths.push(path);
      } else {
        this.excessMarkers++;
      }
    } else {
      this.invalidMarkers++;
    }
    this.reserved = '';
    this.reservedAtLineStart = false;
    this.reservedTooLong = false;
  }
}

export function projectFileText(text: string): FileProjection {
  const projector = new OutboundFileProjector();
  const safe = projector.append(text) + projector.complete();
  return projector.result(safe);
}
