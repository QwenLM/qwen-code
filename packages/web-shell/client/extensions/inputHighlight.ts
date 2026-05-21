import {
  ViewPlugin,
  Decoration,
  DecorationSet,
  EditorView,
  ViewUpdate,
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

const slashDeco = Decoration.mark({ class: 'cm-input-slash' });
const atDeco = Decoration.mark({ class: 'cm-input-at' });
const backtickDeco = Decoration.mark({ class: 'cm-input-code' });

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const text = line.text;
    const offset = line.from;

    // /command at start of line
    if (text.startsWith('/')) {
      const end = text.indexOf(' ');
      const slashEnd = end === -1 ? text.length : end;
      builder.add(offset, offset + slashEnd, slashDeco);
    }

    // @path tokens
    const atRe = /@[^\s]+/g;
    let m: RegExpExecArray | null;
    while ((m = atRe.exec(text)) !== null) {
      builder.add(offset + m.index, offset + m.index + m[0].length, atDeco);
    }

    // `inline code`
    const codeRe = /`[^`]+`/g;
    while ((m = codeRe.exec(text)) !== null) {
      builder.add(
        offset + m.index,
        offset + m.index + m[0].length,
        backtickDeco,
      );
    }
  }

  return builder.finish();
}

export const inputHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

export const inputHighlightTheme = EditorView.baseTheme({
  '.cm-input-slash': {
    color: 'var(--accent-color, #4a9eff)',
    fontWeight: 'bold',
  },
  '.cm-input-at': {
    color: 'var(--success-color, #48bb78)',
  },
  '.cm-input-code': {
    background: 'rgba(255, 255, 255, 0.06)',
    borderRadius: '3px',
    color: 'var(--text-secondary, #a0aec0)',
  },
});
