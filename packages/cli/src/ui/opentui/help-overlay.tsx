/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Help overlay for the OpenTUI renderer (PR1 slice 1): renders the same
 * content as the original ink `Help` dialog — tab bar (general / commands /
 * custom-commands), shortcut grid, grouped command listing with the original
 * 18-line scroll window, docs footer. Tab/Shift+Tab/Esc/↑/↓ key handling
 * lives in the backend (the composer owns focus); this component is pure
 * presentation fed by `help-content.ts`.
 *
 * Reconciler-safe: `<text>` children are only strings or `<span>` segments
 * (TextNodeRenderable rejects nested `<text>` renderables). The tab body is
 * height-capped via `computeHelpBodyRows`, so the docs footer and the key
 * hints remain visible on an 80x24 terminal.
 */

import { C } from './theme.js';
import type { SlashCommand } from '../commands/types.js';
import { t } from '../../i18n/index.js';
import {
  HELP_COMMAND_LIST_VISIBLE_LINES,
  HELP_DOCS_URL,
  HELP_KEY_COL_WIDTH,
  HELP_TABS,
  buildHelpCommandsLines,
  buildHelpCustomCommandLines,
  computeHelpWidthLayout,
  getHelpShortcuts,
  truncateHelpText,
  type HelpLine,
  type HelpTab,
  type HelpWidthLayout,
} from './help-content.js';

type SignatureLine = Extract<HelpLine, { type: 'signature' }>;

function ShortcutRow(props: {
  shortcutKey: string;
  desc: string;
  descWidth: number;
}) {
  return (
    <box flexDirection="row">
      <box width={HELP_KEY_COL_WIDTH} flexShrink={0}>
        <text fg={C.accent}>{props.shortcutKey}</text>
      </box>
      <text fg={C.text}>{truncateHelpText(props.desc, props.descWidth)}</text>
    </box>
  );
}

function GeneralHelp(props: { layout: HelpWidthLayout }) {
  const { layout } = props;
  const shortcuts = getHelpShortcuts();
  const left = shortcuts.slice(0, Math.ceil(shortcuts.length / 2));
  const right = shortcuts.slice(Math.ceil(shortcuts.length / 2));
  // Fixed-width columns (ink parity): flex-grow columns without truncation
  // overlapped each other below ~100 terminal columns and wrapped rows out
  // of the capped body window at 80.
  const column = (rows: typeof left, width: number, descWidth: number) => (
    <box flexDirection="column" width={width} flexShrink={0}>
      {rows.map((s) => (
        <ShortcutRow
          key={s.key}
          shortcutKey={s.key}
          desc={s.description}
          descWidth={descWidth}
        />
      ))}
    </box>
  );
  return (
    <box flexDirection="column">
      <box marginBottom={1} width={layout.bodyWidth}>
        <text fg={C.text}>
          {t(
            'Qwen Code understands your codebase, makes edits with your permission, and executes commands right from your terminal.',
          )}
        </text>
      </box>
      <text fg={C.text} attributes={1}>
        {t('Shortcuts')}
      </text>
      <box flexDirection="row" gap={2}>
        {column(left, layout.colWidth, layout.descWidth)}
        {column(right, layout.colWidth, layout.descWidth)}
      </box>
    </box>
  );
}

function CommandListLine(props: { line: HelpLine }) {
  const { line } = props;
  if (line.type === 'blank') {
    return <text> </text>;
  }
  if (line.type === 'group') {
    return (
      <text fg={C.text} attributes={1}>
        {line.text} <span fg={C.dim}>{`(${line.count})`}</span>
      </text>
    );
  }
  if (line.type === 'signature') {
    return (
      <box flexDirection="row">
        <text fg={C.accent}> {line.text}</text>
        {line.meta ? <text fg={C.dim}> {line.meta}</text> : null}
      </box>
    );
  }
  return (
    <box paddingLeft={4}>
      <text fg={line.type === 'description' ? C.text : C.dim}>{line.text}</text>
    </box>
  );
}

/** Scrollable command listing with the original 18-line window. */
export function helpScrollMax(lines: readonly HelpLine[]): number {
  return Math.max(0, lines.length - HELP_COMMAND_LIST_VISIBLE_LINES);
}

function CommandsHelp(props: {
  commands: readonly SlashCommand[];
  customOnly: boolean;
  scroll: number;
  width: number;
}) {
  const { commands, customOnly, scroll, width } = props;
  const lines = customOnly
    ? buildHelpCustomCommandLines(commands, width)
    : buildHelpCommandsLines(commands, width);
  if (lines.length === 0) {
    return (
      <text fg={C.dim}>
        {customOnly
          ? t('No custom commands are currently available.')
          : t('No commands are currently available.')}
      </text>
    );
  }
  const maxScroll = helpScrollMax(lines);
  const offset = Math.max(0, Math.min(scroll, maxScroll));
  const visible = lines.slice(offset, offset + HELP_COMMAND_LIST_VISIBLE_LINES);
  const signatures = lines.filter(
    (l): l is SignatureLine => l.type === 'signature',
  );
  const visibleSignatures = visible.filter(
    (l): l is SignatureLine => l.type === 'signature',
  );
  const firstCmd =
    visibleSignatures.length > 0
      ? signatures.indexOf(visibleSignatures[0]) + 1
      : 0;
  const lastCmd =
    visibleSignatures.length > 0
      ? signatures.indexOf(visibleSignatures[visibleSignatures.length - 1]) + 1
      : 0;
  return (
    <box flexDirection="column">
      <box marginBottom={1}>
        <text fg={C.text}>
          {customOnly
            ? t('Browse custom, skill, plugin, and MCP commands:')
            : t('Browse built-in commands:')}
        </text>
      </box>
      <box flexDirection="column" height={HELP_COMMAND_LIST_VISIBLE_LINES}>
        {visible.map((line, index) => (
          <CommandListLine key={`${line.type}:${index}`} line={line} />
        ))}
      </box>
      {maxScroll > 0 && (
        <box marginTop={1}>
          <text fg={C.dim}>
            {t('Use ↑/↓ to scroll')}{' '}
            {`(${firstCmd === lastCmd ? `${firstCmd}` : `${firstCmd}-${lastCmd}`}/${signatures.length})`}
          </text>
        </box>
      )}
    </box>
  );
}

export function HelpOverlay(props: {
  commands: readonly SlashCommand[];
  tab: HelpTab;
  scroll: number;
  /**
   * Row budget for the tab body (computeHelpBodyRows). The body is capped to
   * this height so the footer/hints below it always fit on screen.
   */
  bodyRows: number;
  /**
   * Available terminal width (the live main-area width in ink terms). Drives
   * the border-box width and the two fixed-width shortcut columns so narrow
   * terminals truncate with an ellipsis instead of overlapping.
   */
  width: number;
}) {
  const { commands, tab, scroll, bodyRows } = props;
  const layout = computeHelpWidthLayout(props.width);
  return (
    <box flexShrink={1} flexGrow={1} paddingLeft={1} paddingRight={1}>
      <box
        flexDirection="column"
        borderStyle="single"
        borderColor={C.accent}
        width={layout.safeWidth}
      >
        <box
          flexDirection="column"
          paddingLeft={2}
          paddingRight={2}
          paddingY={1}
        >
          <box flexDirection="row">
            <text fg={C.accent} attributes={1}>
              Qwen Code
            </text>
            <text fg={C.dim}> </text>
            {HELP_TABS.map(({ tab: tabId, label }) => {
              const active = tabId === tab;
              return (
                <box key={tabId} marginLeft={1}>
                  <text
                    fg={active ? '#000000' : C.text}
                    bg={active ? C.accent : undefined}
                  >
                    {` ${t(label)} `}
                  </text>
                </box>
              );
            })}
          </box>
          <box
            marginTop={1}
            flexDirection="column"
            maxHeight={bodyRows}
            overflow="hidden"
          >
            {tab === 'general' && <GeneralHelp layout={layout} />}
            {tab === 'commands' && (
              <CommandsHelp
                commands={commands}
                customOnly={false}
                scroll={scroll}
                width={layout.safeWidth}
              />
            )}
            {tab === 'custom-commands' && (
              <CommandsHelp
                commands={commands}
                customOnly={true}
                scroll={scroll}
                width={layout.safeWidth}
              />
            )}
          </box>
          <box marginTop={1}>
            <text fg={C.dim}>
              {t('For more help:')} <span fg={C.accent}>{HELP_DOCS_URL}</span>
            </text>
          </box>
          <box marginTop={1}>
            <text fg={C.dim}>
              {t('Tab/Shift+Tab to switch tabs  ·  Esc to cancel')}
            </text>
          </box>
        </box>
      </box>
    </box>
  );
}
