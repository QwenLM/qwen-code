/**
 * JSON-escape any ANSI/control escape sequences so a hostile upstream (ASR)
 * server error message can't move the cursor or recolor the terminal when it
 * gets logged. The pattern mirrors `ansi-regex@6` (matches CSI sequences and
 * OSC sequences terminated by BEL, ST `ESC \`, or C1 ``).
 */

const ST = '(?:\\u0007|\\u001B\\u005C|\\u009C)';
const OSC = `\\u001B\\][\\s\\S]*?${ST}`;
const CSI =
  '[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]';
const ANSI_CTRL_REGEX = new RegExp(`${OSC}|${CSI}`, 'g');

export function escapeAnsiCtrlCodes(text: string): string {
  if (text.search(ANSI_CTRL_REGEX) === -1) return text;
  ANSI_CTRL_REGEX.lastIndex = 0;
  return text.replace(ANSI_CTRL_REGEX, (match) =>
    JSON.stringify(match).slice(1, -1),
  );
}
