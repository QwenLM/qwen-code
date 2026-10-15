const makeRow = (columns) => new Array(columns).fill(' ');
const makeGrid = (rows, columns) =>
  Array.from({ length: rows }, () => makeRow(columns));

export function renderFinalScreen(raw, { rows = 24, columns = 80 } = {}) {
  const main = makeGrid(rows, columns);
  let alt = null;
  let grid = main;
  const cur = { r: 0, c: 0 };
  let savedCursor = null;

  const clamp = (value, max) => Math.max(0, Math.min(value, max));
  const clampCursor = () => {
    cur.r = clamp(cur.r, rows - 1);
    cur.c = clamp(cur.c, columns - 1);
  };
  const linefeed = () => {
    if (cur.r >= rows - 1) {
      grid.shift();
      grid.push(makeRow(columns));
    } else {
      cur.r += 1;
    }
  };
  const put = (ch) => {
    if (cur.c >= columns) {
      cur.c = 0;
      linefeed();
    }
    grid[cur.r][cur.c] = ch;
    cur.c += 1;
  };
  const fillRow = (r, from, to) => {
    for (let c = from; c <= to; c += 1) grid[r][c] = ' ';
  };
  const eraseDisplay = (mode) => {
    if (mode === 0) {
      fillRow(cur.r, cur.c, columns - 1);
      for (let r = cur.r + 1; r < rows; r += 1) fillRow(r, 0, columns - 1);
    } else if (mode === 1) {
      for (let r = 0; r < cur.r; r += 1) fillRow(r, 0, columns - 1);
      fillRow(cur.r, 0, cur.c);
    } else {
      for (let r = 0; r < rows; r += 1) fillRow(r, 0, columns - 1);
    }
  };
  const enterAltScreen = () => {
    if (alt) return;
    alt = makeGrid(rows, columns);
    savedCursor = { r: cur.r, c: cur.c };
    grid = alt;
    cur.r = 0;
    cur.c = 0;
  };
  const leaveAltScreen = () => {
    if (!alt) return;
    alt = null;
    grid = main;
    if (savedCursor) {
      cur.r = savedCursor.r;
      cur.c = savedCursor.c;
      savedCursor = null;
    }
    clampCursor();
  };

  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch !== '\x1b') {
      if (ch === '\n') linefeed();
      else if (ch === '\r') cur.c = 0;
      else if (ch === '\b') cur.c = Math.max(0, cur.c - 1);
      else if (ch === '\t')
        cur.c = clamp((Math.floor(cur.c / 8) + 1) * 8, columns - 1);
      else if (ch >= ' ') put(ch);
      i += 1;
      continue;
    }

    const next = raw[i + 1];
    if (next === undefined) {
      i += 1;
      continue;
    }

    if (next === '[') {
      let j = i + 2;
      let priv = '';
      while (j < raw.length && raw[j] >= '<' && raw[j] <= '?') {
        priv += raw[j];
        j += 1;
      }
      const paramStart = j;
      // `:` is the CSI sub-parameter separator (SGR `38:2::r:g:b`); without
      // it the scan stops at the first colon and the rest of the sequence
      // leaks into the grid as printable text.
      while (
        j < raw.length &&
        ((raw[j] >= '0' && raw[j] <= '9') || raw[j] === ';' || raw[j] === ':')
      ) {
        j += 1;
      }
      const paramText = raw.slice(paramStart, j);
      while (j < raw.length && raw[j] >= ' ' && raw[j] <= '/') {
        j += 1;
      }
      const final = j < raw.length ? raw[j] : '';
      j += 1;
      i = j;
      const params =
        paramText === ''
          ? []
          : paramText.split(';').map((part) => {
              const n = Number.parseInt(part, 10);
              return Number.isNaN(n) ? 0 : n;
            });
      const paramAt = (index, dflt) =>
        params.length > index && params[index] > 0 ? params[index] : dflt;
      const n1 = paramAt(0, 1);

      switch (final) {
        case 'A':
          cur.r -= n1;
          break;
        case 'B':
        case 'e':
          cur.r += n1;
          break;
        case 'C':
        case 'a':
          cur.c += n1;
          break;
        case 'D':
          cur.c -= n1;
          break;
        case 'E':
          cur.r += n1;
          cur.c = 0;
          break;
        case 'F':
          cur.r -= n1;
          cur.c = 0;
          break;
        case 'G':
        case '`':
          cur.c = paramAt(0, 1) - 1;
          break;
        case 'd':
          cur.r = paramAt(0, 1) - 1;
          break;
        case 'H':
        case 'f':
          cur.r = paramAt(0, 1) - 1;
          cur.c = paramAt(1, 1) - 1;
          break;
        case 'J':
          eraseDisplay(paramAt(0, 0));
          break;
        case 'K': {
          const mode = paramAt(0, 0);
          if (mode === 0) fillRow(cur.r, cur.c, columns - 1);
          else if (mode === 1) fillRow(cur.r, 0, cur.c);
          else fillRow(cur.r, 0, columns - 1);
          break;
        }
        case 'L': {
          const count = Math.min(paramAt(0, 1), rows - cur.r);
          const blanks = Array.from({ length: count }, () => makeRow(columns));
          grid.splice(cur.r, 0, ...blanks);
          grid.splice(rows, grid.length - rows);
          break;
        }
        case 'M': {
          const count = Math.min(paramAt(0, 1), rows - cur.r);
          grid.splice(cur.r, count);
          while (grid.length < rows) grid.push(makeRow(columns));
          break;
        }
        case '@': {
          const count = Math.min(paramAt(0, 1), columns - cur.c);
          grid[cur.r].splice(cur.c, 0, ...new Array(count).fill(' '));
          grid[cur.r].splice(columns, grid[cur.r].length - columns);
          break;
        }
        case 'P': {
          const count = Math.min(paramAt(0, 1), columns - cur.c);
          grid[cur.r].splice(cur.c, count);
          while (grid[cur.r].length < columns) grid[cur.r].push(' ');
          break;
        }
        case 'X': {
          const count = Math.min(paramAt(0, 1), columns - cur.c);
          fillRow(cur.r, cur.c, cur.c + count - 1);
          break;
        }
        case 'h':
        case 'l':
          if (priv === '?') {
            for (const p of params) {
              if (final === 'h' && (p === 1049 || p === 1047 || p === 47))
                enterAltScreen();
              else if (final === 'l' && (p === 1049 || p === 1047 || p === 47))
                leaveAltScreen();
            }
          }
          break;
        default:
          break;
      }
      clampCursor();
      continue;
    }

    if (next === ']') {
      let j = i + 2;
      while (j < raw.length) {
        if (raw[j] === '\x07') {
          j += 1;
          break;
        }
        if (raw[j] === '\x1b' && raw[j + 1] === '\\') {
          j += 2;
          break;
        }
        j += 1;
      }
      i = j;
      continue;
    }

    if (next === 'c') {
      alt = null;
      grid = main;
      for (let r = 0; r < rows; r += 1) main[r] = makeRow(columns);
      cur.r = 0;
      cur.c = 0;
      i += 2;
      continue;
    }

    // String sequences (DCS `ESC P`, SOS `ESC X`, PM `ESC ^`, APC `ESC _`):
    // consume through ST (`ESC \`) or BEL so payloads stay out of the grid.
    if (next === 'P' || next === 'X' || next === '^' || next === '_') {
      let j = i + 2;
      while (j < raw.length) {
        if (raw[j] === '\x07') {
          j += 1;
          break;
        }
        if (raw[j] === '\x1b' && raw[j + 1] === '\\') {
          j += 2;
          break;
        }
        j += 1;
      }
      i = j;
      continue;
    }

    // Intermediate-byte sequences (charset designation `ESC ( B`,
    // `ESC ) 0`, …): consume ESC + the 0x20–0x2F intermediates + the final
    // byte. The old 2-byte fallback below leaked the tail (e.g. `B`) into
    // the grid as printable text.
    if (next >= ' ' && next <= '/') {
      let j = i + 1;
      while (j < raw.length && raw[j] >= ' ' && raw[j] <= '/') j += 1;
      if (j < raw.length) j += 1;
      i = j;
      continue;
    }

    i += 2;
  }

  const lines = grid.map((row) => row.join('').replace(/[ ]+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
