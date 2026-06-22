import {
  ViewPlugin,
  Decoration,
  DecorationSet,
  EditorView,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import type { CommandInfo } from '../adapters/types';
import { getSlashCommandArgumentHint } from '../completions/slashCompletion';
import type { WebShellLanguage } from '../i18n';

const slashDeco = Decoration.mark({ class: 'cm-input-slash' });
const atDeco = Decoration.mark({ class: 'cm-input-at' });
const backtickDeco = Decoration.mark({ class: 'cm-input-code' });

class SlashArgumentHintWidget extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }

  eq(other: SlashArgumentHintWidget) {
    return other.text === this.text;
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-input-slash-argument-hint';
    span.textContent = this.text;
    return span;
  }

  ignoreEvent() {
    return true;
  }
}

function buildDecorations(
  view: EditorView,
  getCommands: () => CommandInfo[],
  getLanguage: () => WebShellLanguage,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const ranges: Array<{ from: number; to: number; deco: Decoration }> = [];

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const text = line.text;
    const offset = line.from;

    // /command at start of line
    if (text.startsWith('/')) {
      const end = text.indexOf(' ');
      const slashEnd = end === -1 ? text.length : end;
      ranges.push({ from: offset, to: offset + slashEnd, deco: slashDeco });
    }

    const argumentHint = getSlashCommandArgumentHint(
      text,
      getCommands(),
      getLanguage(),
    );
    if (argumentHint) {
      const prefix = text.endsWith(' ') ? '' : ' ';
      ranges.push({
        from: offset + text.length,
        to: offset + text.length,
        deco: Decoration.widget({
          widget: new SlashArgumentHintWidget(`${prefix}${argumentHint}`),
          side: 1,
        }),
      });
    }

    // @path tokens
    const atRe = /@[^\s]+/g;
    let m: RegExpExecArray | null;
    while ((m = atRe.exec(text)) !== null) {
      ranges.push({
        from: offset + m.index,
        to: offset + m.index + m[0].length,
        deco: atDeco,
      });
    }

    // `inline code`
    const codeRe = /`[^`]+`/g;
    while ((m = codeRe.exec(text)) !== null) {
      ranges.push({
        from: offset + m.index,
        to: offset + m.index + m[0].length,
        deco: backtickDeco,
      });
    }
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  for (const { from, to, deco } of ranges) {
    builder.add(from, to, deco);
  }

  return builder.finish();
}

export function inputHighlight(
  getCommands: () => CommandInfo[] = () => [],
  getLanguage: () => WebShellLanguage = () => 'en',
) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, getCommands, getLanguage);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildDecorations(
            update.view,
            getCommands,
            getLanguage,
          );
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );
}

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
  '.cm-input-slash-argument-hint': {
    color: 'var(--text-tertiary, rgba(160, 174, 192, 0.55))',
    pointerEvents: 'none',
  },
});
