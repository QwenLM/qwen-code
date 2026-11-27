export default class StackUtils {
  static nodeInternals(): RegExp[];
  constructor(opts?: { cwd?: string; internals?: RegExp[] });
  clean(stack: string): string;
  capture(limit?: number, startStackFunction?: Function): any;
  parse(stack: string): Array<{
    file?: string;
    line?: number;
    column?: number;
    function?: string;
  }>;
  parseLine(line: string): {
    file?: string;
    line?: number;
    column?: number;
    function?: string;
  } | null;
}
