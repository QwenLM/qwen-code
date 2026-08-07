/**
 * Theme support: detect the terminal's light/dark mode via OSC 10/11
 * (opentui `waitForThemeMode`), subscribe to live changes (`theme_mode`),
 * and swap the palette. POC previously hard-coded a dark palette, which is
 * invisible on light terminal themes (Warp light, etc.).
 */
import { SyntaxStyle } from "@opentui/core";

export interface Palette {
  text: string;
  dim: string;
  accent: string;
  green: string;
  red: string;
  yellow: string;
  purple: string;
  hover: string;
}

const DARK: Palette = {
  text: "#e6edf3",
  dim: "#8b949e",
  accent: "#7aa2f7",
  green: "#9ece6a",
  red: "#f7768e",
  yellow: "#e0af68",
  purple: "#bb9af7",
  hover: "#1c2333",
};

const LIGHT: Palette = {
  text: "#1f2328",
  dim: "#59636e",
  accent: "#0969da",
  green: "#1a7f37",
  red: "#cf222e",
  yellow: "#9a6700",
  purple: "#8250df",
  hover: "#eef1f4",
};

/** Mutable palette object — components read `C.x` at render time;
 *  `applyThemeMode` mutates it and a React re-render picks it up. */
export const C: Palette = { ...DARK };

function buildSyntax(mode: "dark" | "light"): SyntaxStyle {
  return mode === "light"
    ? SyntaxStyle.fromStyles({
        keyword: { fg: "#cf222e", bold: true },
        string: { fg: "#0a3069" },
        comment: { fg: "#59636e", italic: true },
        function: { fg: "#8250df" },
        type: { fg: "#953800" },
        number: { fg: "#0550ae" },
        operator: { fg: "#0550ae" },
        variable: { fg: "#1f2328" },
        heading: { fg: "#0550ae", bold: true },
        emphasis: { italic: true },
        strong: { bold: true },
        link: { fg: "#0969da" },
        code: { fg: "#0a3069" },
      })
    : SyntaxStyle.fromStyles({
        keyword: { fg: "#bb9af7", bold: true },
        string: { fg: "#9ece6a" },
        comment: { fg: "#565f89", italic: true },
        function: { fg: "#7aa2f7" },
        type: { fg: "#e0af68" },
        number: { fg: "#ff9e64" },
        operator: { fg: "#89ddff" },
        variable: { fg: "#e6edf3" },
        heading: { fg: "#7aa2f7", bold: true },
        emphasis: { italic: true },
        strong: { bold: true },
        link: { fg: "#7aa2f7" },
        code: { fg: "#9ece6a" },
      });
}

/** Mutable syntax style — rebuilt on theme change. */
export let SYNTAX: SyntaxStyle = buildSyntax("dark");

export function applyThemeMode(mode: "dark" | "light" | null | undefined): void {
  const m = mode === "light" ? "light" : "dark";
  Object.assign(C, m === "light" ? LIGHT : DARK);
  SYNTAX = buildSyntax(m);
}
