declare module 'wrap-ansi' {
  type WrapAnsiOptions = {
    hard?: boolean;
    wordWrap?: boolean;
    trim?: boolean;
  };
  export default function wrapAnsi(
    input: string,
    columns: number,
    options?: WrapAnsiOptions,
  ): string;
}
