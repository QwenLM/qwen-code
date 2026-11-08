const CURSOR_MOVES = new Set([
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'd',
  'f',
]);

export function analyzeAnsi(raw) {
  const m = {
    bytes: Buffer.byteLength(raw, 'utf8'),
    printableChars: 0,
    controlChars: { cr: 0, lf: 0, bs: 0, tab: 0, bel: 0, other: 0 },
    sequences: { csi: 0, osc: 0, otherEsc: 0 },
    fullScreenClears: { csi2J: 0, csi3J: 0, ris: 0, total: 0 },
    partialScreenErases: 0,
    lineErases: { toEnd: 0, toStart: 0, whole: 0, total: 0 },
    dec2026: { begin: 0, end: 0, unbalanced: 0 },
    events: {
      markersPresent: false,
      total: 0,
      unique: 0,
      duplicates: 0,
      covered: 0,
      unwrapped: 0,
    },
    cursorMoves: 0,
    sgrChanges: 0,
  };

  const seenEvents = new Set();
  let syncDepth = 0;
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i];
    if (ch !== '\x1b') {
      if (ch === '\r') m.controlChars.cr += 1;
      else if (ch === '\n') m.controlChars.lf += 1;
      else if (ch === '\b') m.controlChars.bs += 1;
      else if (ch === '\t') m.controlChars.tab += 1;
      else if (ch === '\x07') m.controlChars.bel += 1;
      else if (ch < ' ') m.controlChars.other += 1;
      else m.printableChars += 1;
      i += 1;
      continue;
    }

    const next = raw[i + 1];
    if (next === undefined) {
      m.sequences.otherEsc += 1;
      i += 1;
      continue;
    }

    if (next === '[') {
      m.sequences.csi += 1;
      let j = i + 2;
      let priv = '';
      while (j < raw.length && raw[j] >= '<' && raw[j] <= '?') {
        priv += raw[j];
        j += 1;
      }
      const paramStart = j;
      while (
        j < raw.length &&
        ((raw[j] >= '0' && raw[j] <= '9') || raw[j] === ';')
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
      const p0 = params.length > 0 ? params[0] : 0;

      if (final === 'J') {
        if (p0 === 2) m.fullScreenClears.csi2J += 1;
        else if (p0 === 3) m.fullScreenClears.csi3J += 1;
        else m.partialScreenErases += 1;
      } else if (final === 'K') {
        if (p0 === 1) m.lineErases.toStart += 1;
        else if (p0 === 2) m.lineErases.whole += 1;
        else m.lineErases.toEnd += 1;
        m.lineErases.total += 1;
      } else if (
        (final === 'h' || final === 'l') &&
        priv === '?' &&
        params.includes(2026)
      ) {
        if (final === 'h') {
          m.dec2026.begin += 1;
          syncDepth += 1;
        } else {
          m.dec2026.end += 1;
          if (syncDepth > 0) syncDepth -= 1;
          else m.dec2026.unbalanced += 1;
        }
      } else if (CURSOR_MOVES.has(final)) {
        m.cursorMoves += 1;
      } else if (final === 'm') {
        m.sgrChanges += 1;
      }
      continue;
    }

    if (next === ']') {
      m.sequences.osc += 1;
      let j = i + 2;
      let payload = '';
      while (j < raw.length) {
        if (raw[j] === '\x07') {
          j += 1;
          break;
        }
        if (raw[j] === '\x1b' && raw[j + 1] === '\\') {
          j += 2;
          break;
        }
        payload += raw[j];
        j += 1;
      }
      i = j;
      // Private namespace OSC 697;id;seq marks one live-output event. Each
      // occurrence is classified by whether it landed inside an active DEC
      // 2026 sync interval, so coverage is measured per event, not inferred
      // from begin/end counts.
      if (payload.startsWith('697;')) {
        const body = payload.slice(4);
        const sep = body.indexOf(';');
        const id = sep === -1 ? body : body.slice(0, sep);
        const seq = sep === -1 ? '' : body.slice(sep + 1);
        m.events.total += 1;
        if (syncDepth > 0) m.events.covered += 1;
        else m.events.unwrapped += 1;
        const key = `${id}\u0000${seq}`;
        if (seenEvents.has(key)) m.events.duplicates += 1;
        else seenEvents.add(key);
      }
      continue;
    }

    if (next === 'c') {
      m.fullScreenClears.ris += 1;
      i += 2;
      continue;
    }

    m.sequences.otherEsc += 1;
    i += 2;
  }

  m.dec2026.unbalanced += syncDepth;
  m.fullScreenClears.total =
    m.fullScreenClears.csi2J +
    m.fullScreenClears.csi3J +
    m.fullScreenClears.ris;
  m.events.unique = seenEvents.size;
  m.events.markersPresent = m.events.total > 0;
  return m;
}
