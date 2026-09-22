// Force strict mode and setup for ESM
"use strict";
import {
  DEFAULT_DARK_THEME_NAME,
  DEFAULT_LIGHT_THEME_NAME
} from "./chunk-RKUWKYED.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/ui/themes/theme-manager.ts
init_esbuild_shims();

// packages/cli/src/ui/themes/ayu.ts
init_esbuild_shims();

// packages/cli/src/ui/themes/theme.ts
init_esbuild_shims();

// packages/cli/src/ui/themes/color-utils.ts
init_esbuild_shims();
var CSS_NAME_TO_HEX_MAP = {
  aliceblue: "#f0f8ff",
  antiquewhite: "#faebd7",
  aqua: "#00ffff",
  aquamarine: "#7fffd4",
  azure: "#f0ffff",
  beige: "#f5f5dc",
  bisque: "#ffe4c4",
  blanchedalmond: "#ffebcd",
  blueviolet: "#8a2be2",
  brown: "#a52a2a",
  burlywood: "#deb887",
  cadetblue: "#5f9ea0",
  chartreuse: "#7fff00",
  chocolate: "#d2691e",
  coral: "#ff7f50",
  cornflowerblue: "#6495ed",
  cornsilk: "#fff8dc",
  crimson: "#dc143c",
  darkblue: "#00008b",
  darkcyan: "#008b8b",
  darkgoldenrod: "#b8860b",
  darkgray: "#a9a9a9",
  darkgrey: "#a9a9a9",
  darkgreen: "#006400",
  darkkhaki: "#bdb76b",
  darkmagenta: "#8b008b",
  darkolivegreen: "#556b2f",
  darkorange: "#ff8c00",
  darkorchid: "#9932cc",
  darkred: "#8b0000",
  darksalmon: "#e9967a",
  darkseagreen: "#8fbc8f",
  darkslateblue: "#483d8b",
  darkslategray: "#2f4f4f",
  darkslategrey: "#2f4f4f",
  darkturquoise: "#00ced1",
  darkviolet: "#9400d3",
  deeppink: "#ff1493",
  deepskyblue: "#00bfff",
  dimgray: "#696969",
  dimgrey: "#696969",
  dodgerblue: "#1e90ff",
  firebrick: "#b22222",
  floralwhite: "#fffaf0",
  forestgreen: "#228b22",
  fuchsia: "#ff00ff",
  gainsboro: "#dcdcdc",
  ghostwhite: "#f8f8ff",
  gold: "#ffd700",
  goldenrod: "#daa520",
  greenyellow: "#adff2f",
  honeydew: "#f0fff0",
  hotpink: "#ff69b4",
  indianred: "#cd5c5c",
  indigo: "#4b0082",
  ivory: "#fffff0",
  khaki: "#f0e68c",
  lavender: "#e6e6fa",
  lavenderblush: "#fff0f5",
  lawngreen: "#7cfc00",
  lemonchiffon: "#fffacd",
  lightblue: "#add8e6",
  lightcoral: "#f08080",
  lightcyan: "#e0ffff",
  lightgoldenrodyellow: "#fafad2",
  lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3",
  lightgreen: "#90ee90",
  lightpink: "#ffb6c1",
  lightsalmon: "#ffa07a",
  lightseagreen: "#20b2aa",
  lightskyblue: "#87cefa",
  lightslategray: "#778899",
  lightslategrey: "#778899",
  lightsteelblue: "#b0c4de",
  lightyellow: "#ffffe0",
  lime: "#00ff00",
  limegreen: "#32cd32",
  linen: "#faf0e6",
  maroon: "#800000",
  mediumaquamarine: "#66cdaa",
  mediumblue: "#0000cd",
  mediumorchid: "#ba55d3",
  mediumpurple: "#9370db",
  mediumseagreen: "#3cb371",
  mediumslateblue: "#7b68ee",
  mediumspringgreen: "#00fa9a",
  mediumturquoise: "#48d1cc",
  mediumvioletred: "#c71585",
  midnightblue: "#191970",
  mintcream: "#f5fffa",
  mistyrose: "#ffe4e1",
  moccasin: "#ffe4b5",
  navajowhite: "#ffdead",
  navy: "#000080",
  oldlace: "#fdf5e6",
  olive: "#808000",
  olivedrab: "#6b8e23",
  orange: "#ffa500",
  orangered: "#ff4500",
  orchid: "#da70d6",
  palegoldenrod: "#eee8aa",
  palegreen: "#98fb98",
  paleturquoise: "#afeeee",
  palevioletred: "#db7093",
  papayawhip: "#ffefd5",
  peachpuff: "#ffdab9",
  peru: "#cd853f",
  pink: "#ffc0cb",
  plum: "#dda0dd",
  powderblue: "#b0e0e6",
  purple: "#800080",
  rebeccapurple: "#663399",
  rosybrown: "#bc8f8f",
  royalblue: "#4169e1",
  saddlebrown: "#8b4513",
  salmon: "#fa8072",
  sandybrown: "#f4a460",
  seagreen: "#2e8b57",
  seashell: "#fff5ee",
  sienna: "#a0522d",
  silver: "#c0c0c0",
  skyblue: "#87ceeb",
  slateblue: "#6a5acd",
  slategray: "#708090",
  slategrey: "#708090",
  snow: "#fffafa",
  springgreen: "#00ff7f",
  steelblue: "#4682b4",
  tan: "#d2b48c",
  teal: "#008080",
  thistle: "#d8bfd8",
  tomato: "#ff6347",
  turquoise: "#40e0d0",
  violet: "#ee82ee",
  wheat: "#f5deb3",
  whitesmoke: "#f5f5f5",
  yellowgreen: "#9acd32"
};
var debugLogger = createDebugLogger("COLOR_UTILS");
var INK_SUPPORTED_NAMES = /* @__PURE__ */ new Set([
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "cyan",
  "magenta",
  "white",
  "gray",
  "grey",
  "blackbright",
  "redbright",
  "greenbright",
  "yellowbright",
  "bluebright",
  "cyanbright",
  "magentabright",
  "whitebright"
]);
function resolveColor(colorValue) {
  const lowerColor = colorValue.toLowerCase();
  if (lowerColor.startsWith("#")) {
    if (/^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/.test(colorValue)) {
      return lowerColor;
    } else {
      return void 0;
    }
  } else if (INK_SUPPORTED_NAMES.has(lowerColor)) {
    return lowerColor;
  } else if (CSS_NAME_TO_HEX_MAP[lowerColor]) {
    return CSS_NAME_TO_HEX_MAP[lowerColor];
  }
  debugLogger.warn(
    `[ColorUtils] Could not resolve color "${colorValue}" to an Ink-compatible format.`
  );
  return void 0;
}
__name(resolveColor, "resolveColor");

// packages/cli/src/ui/themes/theme.ts
var lightTheme = {
  type: "light",
  Background: "#FAFAFA",
  Foreground: "",
  LightBlue: "#89BDCD",
  AccentBlue: "#3B82F6",
  AccentPurple: "#8B5CF6",
  AccentCyan: "#06B6D4",
  AccentGreen: "#3CA84B",
  AccentYellow: "#D5A40A",
  AccentRed: "#DD4C4C",
  AccentYellowDim: "#8B7000",
  AccentRedDim: "#993333",
  DiffAdded: "#C6EAD8",
  DiffRemoved: "#FFCCCC",
  Comment: "#008000",
  Gray: "#97a0b0",
  GradientColors: ["#4796E4", "#847ACE", "#C3677F"]
};
var darkTheme = {
  type: "dark",
  Background: "#1E1E2E",
  Foreground: "",
  LightBlue: "#ADD8E6",
  AccentBlue: "#89B4FA",
  AccentPurple: "#CBA6F7",
  AccentCyan: "#89DCEB",
  AccentGreen: "#A6E3A1",
  AccentYellow: "#F9E2AF",
  AccentRed: "#F38BA8",
  AccentYellowDim: "#8B7530",
  AccentRedDim: "#8B3A4A",
  DiffAdded: "#28350B",
  DiffRemoved: "#430000",
  Comment: "#6C7086",
  Gray: "#6C7086",
  GradientColors: ["#4796E4", "#847ACE", "#C3677F"]
};
var ansiTheme = {
  type: "ansi",
  Background: "black",
  Foreground: "white",
  LightBlue: "blue",
  AccentBlue: "blue",
  AccentPurple: "magenta",
  AccentCyan: "cyan",
  AccentGreen: "green",
  AccentYellow: "yellow",
  AccentRed: "red",
  AccentYellowDim: "yellow",
  AccentRedDim: "red",
  DiffAdded: "green",
  DiffRemoved: "red",
  Comment: "gray",
  Gray: "gray"
};
var Theme = class _Theme {
  /**
   * Creates a new Theme instance.
   * @param name The name of the theme.
   * @param rawMappings The raw CSSProperties mappings from a react-syntax-highlighter theme object.
   */
  constructor(name, type, rawMappings, colors, semanticColors) {
    this.name = name;
    this.type = type;
    this.colors = colors;
    this.semanticColors = semanticColors ?? {
      text: {
        primary: this.colors.Foreground,
        secondary: this.colors.Gray,
        link: this.colors.AccentBlue,
        accent: this.colors.AccentPurple,
        code: this.colors.LightBlue
      },
      background: {
        primary: this.colors.Background,
        diff: {
          added: this.colors.DiffAdded,
          removed: this.colors.DiffRemoved
        }
      },
      border: {
        default: this.colors.Gray,
        focused: this.colors.AccentBlue
      },
      ui: {
        comment: this.colors.Gray,
        symbol: this.colors.AccentCyan,
        gradient: this.colors.GradientColors
      },
      status: {
        error: this.colors.AccentRed,
        success: this.colors.AccentGreen,
        warning: this.colors.AccentYellow,
        errorDim: this.colors.AccentRedDim,
        warningDim: this.colors.AccentYellowDim
      }
    };
    this._colorMap = Object.freeze(this._buildColorMap(rawMappings));
    const rawDefaultColor = rawMappings["hljs"]?.color;
    this.defaultColor = (rawDefaultColor ? _Theme._resolveColor(rawDefaultColor) : void 0) ?? "";
  }
  static {
    __name(this, "Theme");
  }
  /**
   * The default foreground color for text when no specific highlight rule applies.
   * This is an Ink-compatible color string (hex or name).
   */
  defaultColor;
  /**
   * Stores the mapping from highlight.js class names (e.g., 'hljs-keyword')
   * to Ink-compatible color strings (hex or name).
   */
  _colorMap;
  semanticColors;
  /**
   * Gets the Ink-compatible color string for a given highlight.js class name.
   * @param hljsClass The highlight.js class name (e.g., 'hljs-keyword', 'hljs-string').
   * @returns The corresponding Ink color string (hex or name) if it exists.
   */
  getInkColor(hljsClass) {
    return this._colorMap[hljsClass];
  }
  /**
   * Resolves a CSS color value (name or hex) into an Ink-compatible color string.
   * @param colorValue The raw color string (e.g., 'blue', '#ff0000', 'darkkhaki').
   * @returns An Ink-compatible color string (hex or name), or undefined if not resolvable.
   */
  static _resolveColor(colorValue) {
    return resolveColor(colorValue);
  }
  /**
   * Builds the internal map from highlight.js class names to Ink-compatible color strings.
   * This method is protected and primarily intended for use by the constructor.
   * @param hljsTheme The raw CSSProperties mappings from a react-syntax-highlighter theme object.
   * @returns An Ink-compatible theme map (Record<string, string>).
   */
  _buildColorMap(hljsTheme) {
    const inkTheme = {};
    for (const key in hljsTheme) {
      if (!key.startsWith("hljs-") && key !== "hljs") {
        continue;
      }
      const style = hljsTheme[key];
      if (style?.color) {
        const resolvedColor = _Theme._resolveColor(style.color);
        if (resolvedColor !== void 0) {
          inkTheme[key] = resolvedColor;
        }
      }
    }
    return inkTheme;
  }
};
function createCustomTheme(customTheme) {
  const colors = {
    type: "custom",
    Background: customTheme.background?.primary ?? customTheme.Background ?? "",
    Foreground: customTheme.text?.primary ?? customTheme.Foreground ?? "",
    LightBlue: customTheme.text?.code ?? customTheme.LightBlue ?? "",
    AccentBlue: customTheme.text?.link ?? customTheme.AccentBlue ?? "",
    AccentPurple: customTheme.text?.accent ?? customTheme.AccentPurple ?? "",
    AccentCyan: customTheme.text?.link ?? customTheme.AccentCyan ?? "",
    AccentGreen: customTheme.status?.success ?? customTheme.AccentGreen ?? "",
    AccentYellow: customTheme.status?.warning ?? customTheme.AccentYellow ?? "",
    AccentRed: customTheme.status?.error ?? customTheme.AccentRed ?? "",
    AccentYellowDim: customTheme.status?.warningDim ?? customTheme.AccentYellowDim ?? "",
    AccentRedDim: customTheme.status?.errorDim ?? customTheme.AccentRedDim ?? "",
    DiffAdded: customTheme.background?.diff?.added ?? customTheme.DiffAdded ?? "",
    DiffRemoved: customTheme.background?.diff?.removed ?? customTheme.DiffRemoved ?? "",
    Comment: customTheme.ui?.comment ?? customTheme.Comment ?? "",
    Gray: customTheme.text?.secondary ?? customTheme.Gray ?? "",
    GradientColors: customTheme.ui?.gradient ?? customTheme.GradientColors
  };
  const rawMappings = {
    hljs: {
      display: "block",
      overflowX: "auto",
      padding: "0.5em",
      background: colors.Background,
      color: colors.Foreground
    },
    "hljs-keyword": {
      color: colors.AccentBlue
    },
    "hljs-literal": {
      color: colors.AccentBlue
    },
    "hljs-symbol": {
      color: colors.AccentBlue
    },
    "hljs-name": {
      color: colors.AccentBlue
    },
    "hljs-link": {
      color: colors.AccentBlue,
      textDecoration: "underline"
    },
    "hljs-built_in": {
      color: colors.AccentCyan
    },
    "hljs-type": {
      color: colors.AccentCyan
    },
    "hljs-number": {
      color: colors.AccentGreen
    },
    "hljs-class": {
      color: colors.AccentGreen
    },
    "hljs-string": {
      color: colors.AccentYellow
    },
    "hljs-meta-string": {
      color: colors.AccentYellow
    },
    "hljs-regexp": {
      color: colors.AccentRed
    },
    "hljs-template-tag": {
      color: colors.AccentRed
    },
    "hljs-subst": {
      color: colors.Foreground
    },
    "hljs-function": {
      color: colors.Foreground
    },
    "hljs-title": {
      color: colors.Foreground
    },
    "hljs-params": {
      color: colors.Foreground
    },
    "hljs-formula": {
      color: colors.Foreground
    },
    "hljs-comment": {
      color: colors.Comment,
      fontStyle: "italic"
    },
    "hljs-quote": {
      color: colors.Comment,
      fontStyle: "italic"
    },
    "hljs-doctag": {
      color: colors.Comment
    },
    "hljs-meta": {
      color: colors.Gray
    },
    "hljs-meta-keyword": {
      color: colors.Gray
    },
    "hljs-tag": {
      color: colors.Gray
    },
    "hljs-variable": {
      color: colors.AccentPurple
    },
    "hljs-template-variable": {
      color: colors.AccentPurple
    },
    "hljs-attr": {
      color: colors.LightBlue
    },
    "hljs-attribute": {
      color: colors.LightBlue
    },
    "hljs-builtin-name": {
      color: colors.LightBlue
    },
    "hljs-section": {
      color: colors.AccentYellow
    },
    "hljs-emphasis": {
      fontStyle: "italic"
    },
    "hljs-strong": {
      fontWeight: "bold"
    },
    "hljs-bullet": {
      color: colors.AccentYellow
    },
    "hljs-selector-tag": {
      color: colors.AccentYellow
    },
    "hljs-selector-id": {
      color: colors.AccentYellow
    },
    "hljs-selector-class": {
      color: colors.AccentYellow
    },
    "hljs-selector-attr": {
      color: colors.AccentYellow
    },
    "hljs-selector-pseudo": {
      color: colors.AccentYellow
    },
    "hljs-addition": {
      backgroundColor: colors.AccentGreen,
      display: "inline-block",
      width: "100%"
    },
    "hljs-deletion": {
      backgroundColor: colors.AccentRed,
      display: "inline-block",
      width: "100%"
    }
  };
  const semanticColors = {
    text: {
      primary: customTheme.text?.primary ?? colors.Foreground,
      secondary: customTheme.text?.secondary ?? colors.Gray,
      link: customTheme.text?.link ?? colors.AccentBlue,
      accent: customTheme.text?.accent ?? colors.AccentPurple,
      code: customTheme.text?.code ?? colors.LightBlue
    },
    background: {
      primary: customTheme.background?.primary ?? colors.Background,
      diff: {
        added: customTheme.background?.diff?.added ?? colors.DiffAdded,
        removed: customTheme.background?.diff?.removed ?? colors.DiffRemoved
      }
    },
    border: {
      default: customTheme.border?.default ?? colors.Gray,
      focused: customTheme.border?.focused ?? colors.AccentBlue
    },
    ui: {
      comment: customTheme.ui?.comment ?? colors.Comment,
      symbol: customTheme.ui?.symbol ?? colors.Gray,
      gradient: customTheme.ui?.gradient ?? colors.GradientColors
    },
    status: {
      error: customTheme.status?.error ?? colors.AccentRed,
      success: customTheme.status?.success ?? colors.AccentGreen,
      warning: customTheme.status?.warning ?? colors.AccentYellow,
      errorDim: customTheme.status?.errorDim ?? colors.AccentRedDim,
      warningDim: customTheme.status?.warningDim ?? colors.AccentYellowDim
    }
  };
  return new Theme(
    customTheme.name,
    "custom",
    rawMappings,
    colors,
    semanticColors
  );
}
__name(createCustomTheme, "createCustomTheme");
function validateCustomTheme(customTheme) {
  if (customTheme.name && !isValidThemeName(customTheme.name)) {
    return {
      isValid: false,
      error: `Invalid theme name: ${customTheme.name}`
    };
  }
  return {
    isValid: true
  };
}
__name(validateCustomTheme, "validateCustomTheme");
function isValidThemeName(name) {
  return name.trim().length > 0 && name.trim().length <= 50;
}
__name(isValidThemeName, "isValidThemeName");

// packages/cli/src/ui/themes/ayu.ts
var ayuDarkColors = {
  type: "dark",
  Background: "#0b0e14",
  Foreground: "#aeaca6",
  LightBlue: "#59C2FF",
  AccentBlue: "#39BAE6",
  AccentPurple: "#D2A6FF",
  AccentCyan: "#95E6CB",
  AccentGreen: "#AAD94C",
  AccentYellow: "#FFB454",
  AccentRed: "#F26D78",
  AccentYellowDim: "#8B7530",
  AccentRedDim: "#8B3A4A",
  DiffAdded: "#293022",
  DiffRemoved: "#3D1215",
  Comment: "#646A71",
  Gray: "#3D4149",
  GradientColors: ["#FFB454", "#F26D78"]
};
var AyuDark = new Theme(
  "Ayu",
  "dark",
  {
    hljs: {
      display: "block",
      overflowX: "auto",
      padding: "0.5em",
      background: ayuDarkColors.Background,
      color: ayuDarkColors.Foreground
    },
    "hljs-keyword": {
      color: ayuDarkColors.AccentYellow
    },
    "hljs-literal": {
      color: ayuDarkColors.AccentPurple
    },
    "hljs-symbol": {
      color: ayuDarkColors.AccentCyan
    },
    "hljs-name": {
      color: ayuDarkColors.LightBlue
    },
    "hljs-link": {
      color: ayuDarkColors.AccentBlue
    },
    "hljs-function .hljs-keyword": {
      color: ayuDarkColors.AccentYellow
    },
    "hljs-subst": {
      color: ayuDarkColors.Foreground
    },
    "hljs-string": {
      color: ayuDarkColors.AccentGreen
    },
    "hljs-title": {
      color: ayuDarkColors.AccentYellow
    },
    "hljs-type": {
      color: ayuDarkColors.AccentBlue
    },
    "hljs-attribute": {
      color: ayuDarkColors.AccentYellow
    },
    "hljs-bullet": {
      color: ayuDarkColors.AccentYellow
    },
    "hljs-addition": {
      color: ayuDarkColors.AccentGreen
    },
    "hljs-variable": {
      color: ayuDarkColors.Foreground
    },
    "hljs-template-tag": {
      color: ayuDarkColors.AccentYellow
    },
    "hljs-template-variable": {
      color: ayuDarkColors.AccentYellow
    },
    "hljs-comment": {
      color: ayuDarkColors.Comment,
      fontStyle: "italic"
    },
    "hljs-quote": {
      color: ayuDarkColors.AccentCyan,
      fontStyle: "italic"
    },
    "hljs-deletion": {
      color: ayuDarkColors.AccentRed
    },
    "hljs-meta": {
      color: ayuDarkColors.AccentYellow
    },
    "hljs-doctag": {
      fontWeight: "bold"
    },
    "hljs-strong": {
      fontWeight: "bold"
    },
    "hljs-emphasis": {
      fontStyle: "italic"
    }
  },
  ayuDarkColors
);

// packages/cli/src/ui/themes/ayu-light.ts
init_esbuild_shims();
var ayuLightColors = {
  type: "light",
  Background: "#f8f9fa",
  Foreground: "#5c6166",
  LightBlue: "#55b4d4",
  AccentBlue: "#399ee6",
  AccentPurple: "#a37acc",
  AccentCyan: "#4cbf99",
  AccentGreen: "#86b300",
  AccentYellow: "#f2ae49",
  AccentRed: "#f07171",
  AccentYellowDim: "#8B7000",
  AccentRedDim: "#993333",
  DiffAdded: "#C6EAD8",
  DiffRemoved: "#FFCCCC",
  Comment: "#ABADB1",
  Gray: "#a6aaaf",
  GradientColors: ["#399ee6", "#86b300"]
};
var AyuLight = new Theme(
  "Ayu Light",
  "light",
  {
    hljs: {
      display: "block",
      overflowX: "auto",
      padding: "0.5em",
      background: ayuLightColors.Background,
      color: ayuLightColors.Foreground
    },
    "hljs-comment": {
      color: ayuLightColors.Comment,
      fontStyle: "italic"
    },
    "hljs-quote": {
      color: ayuLightColors.AccentCyan,
      fontStyle: "italic"
    },
    "hljs-string": {
      color: ayuLightColors.AccentGreen
    },
    "hljs-constant": {
      color: ayuLightColors.AccentCyan
    },
    "hljs-number": {
      color: ayuLightColors.AccentPurple
    },
    "hljs-keyword": {
      color: ayuLightColors.AccentYellow
    },
    "hljs-selector-tag": {
      color: ayuLightColors.AccentYellow
    },
    "hljs-attribute": {
      color: ayuLightColors.AccentYellow
    },
    "hljs-variable": {
      color: ayuLightColors.Foreground
    },
    "hljs-variable.language": {
      color: ayuLightColors.LightBlue,
      fontStyle: "italic"
    },
    "hljs-title": {
      color: ayuLightColors.AccentBlue
    },
    "hljs-section": {
      color: ayuLightColors.AccentGreen,
      fontWeight: "bold"
    },
    "hljs-type": {
      color: ayuLightColors.LightBlue
    },
    "hljs-class .hljs-title": {
      color: ayuLightColors.AccentBlue
    },
    "hljs-tag": {
      color: ayuLightColors.LightBlue
    },
    "hljs-name": {
      color: ayuLightColors.AccentBlue
    },
    "hljs-builtin-name": {
      color: ayuLightColors.AccentYellow
    },
    "hljs-meta": {
      color: ayuLightColors.AccentYellow
    },
    "hljs-symbol": {
      color: ayuLightColors.AccentRed
    },
    "hljs-bullet": {
      color: ayuLightColors.AccentYellow
    },
    "hljs-regexp": {
      color: ayuLightColors.AccentCyan
    },
    "hljs-link": {
      color: ayuLightColors.LightBlue
    },
    "hljs-deletion": {
      color: ayuLightColors.AccentRed
    },
    "hljs-addition": {
      color: ayuLightColors.AccentGreen
    },
    "hljs-emphasis": {
      fontStyle: "italic"
    },
    "hljs-strong": {
      fontWeight: "bold"
    },
    "hljs-literal": {
      color: ayuLightColors.AccentCyan
    },
    "hljs-built_in": {
      color: ayuLightColors.AccentRed
    },
    "hljs-doctag": {
      color: ayuLightColors.AccentRed
    },
    "hljs-template-variable": {
      color: ayuLightColors.AccentCyan
    },
    "hljs-selector-id": {
      color: ayuLightColors.AccentRed
    }
  },
  ayuLightColors
);

// packages/cli/src/ui/themes/atom-one-dark.ts
init_esbuild_shims();
var atomOneDarkColors = {
  type: "dark",
  Background: "#282c34",
  Foreground: "#abb2bf",
  LightBlue: "#61aeee",
  AccentBlue: "#61aeee",
  AccentPurple: "#c678dd",
  AccentCyan: "#56b6c2",
  AccentGreen: "#98c379",
  AccentYellow: "#e6c07b",
  AccentRed: "#e06c75",
  AccentYellowDim: "#8B7530",
  AccentRedDim: "#8B3A4A",
  DiffAdded: "#39544E",
  DiffRemoved: "#562B2F",
  Comment: "#5c6370",
  Gray: "#5c6370",
  GradientColors: ["#61aeee", "#98c379"]
};
var AtomOneDark = new Theme(
  "Atom One",
  "dark",
  {
    hljs: {
      display: "block",
      overflowX: "auto",
      padding: "0.5em",
      color: atomOneDarkColors.Foreground,
      background: atomOneDarkColors.Background
    },
    "hljs-comment": {
      color: atomOneDarkColors.Comment,
      fontStyle: "italic"
    },
    "hljs-quote": {
      color: atomOneDarkColors.Comment,
      fontStyle: "italic"
    },
    "hljs-doctag": {
      color: atomOneDarkColors.AccentPurple
    },
    "hljs-keyword": {
      color: atomOneDarkColors.AccentPurple
    },
    "hljs-formula": {
      color: atomOneDarkColors.AccentPurple
    },
    "hljs-section": {
      color: atomOneDarkColors.AccentRed
    },
    "hljs-name": {
      color: atomOneDarkColors.AccentRed
    },
    "hljs-selector-tag": {
      color: atomOneDarkColors.AccentRed
    },
    "hljs-deletion": {
      color: atomOneDarkColors.AccentRed
    },
    "hljs-subst": {
      color: atomOneDarkColors.AccentRed
    },
    "hljs-literal": {
      color: atomOneDarkColors.AccentCyan
    },
    "hljs-string": {
      color: atomOneDarkColors.AccentGreen
    },
    "hljs-regexp": {
      color: atomOneDarkColors.AccentGreen
    },
    "hljs-addition": {
      color: atomOneDarkColors.AccentGreen
    },
    "hljs-attribute": {
      color: atomOneDarkColors.AccentGreen
    },
    "hljs-meta-string": {
      color: atomOneDarkColors.AccentGreen
    },
    "hljs-built_in": {
      color: atomOneDarkColors.AccentYellow
    },
    "hljs-class .hljs-title": {
      color: atomOneDarkColors.AccentYellow
    },
    "hljs-attr": {
      color: atomOneDarkColors.AccentYellow
    },
    "hljs-variable": {
      color: atomOneDarkColors.AccentYellow
    },
    "hljs-template-variable": {
      color: atomOneDarkColors.AccentYellow
    },
    "hljs-type": {
      color: atomOneDarkColors.AccentYellow
    },
    "hljs-selector-class": {
      color: atomOneDarkColors.AccentYellow
    },
    "hljs-selector-attr": {
      color: atomOneDarkColors.AccentYellow
    },
    "hljs-selector-pseudo": {
      color: atomOneDarkColors.AccentYellow
    },
    "hljs-number": {
      color: atomOneDarkColors.AccentYellow
    },
    "hljs-symbol": {
      color: atomOneDarkColors.AccentBlue
    },
    "hljs-bullet": {
      color: atomOneDarkColors.AccentBlue
    },
    "hljs-link": {
      color: atomOneDarkColors.AccentBlue,
      textDecoration: "underline"
    },
    "hljs-meta": {
      color: atomOneDarkColors.AccentBlue
    },
    "hljs-selector-id": {
      color: atomOneDarkColors.AccentBlue
    },
    "hljs-title": {
      color: atomOneDarkColors.AccentBlue
    },
    "hljs-emphasis": {
      fontStyle: "italic"
    },
    "hljs-strong": {
      fontWeight: "bold"
    }
  },
  atomOneDarkColors
);

// packages/cli/src/ui/themes/dracula.ts
init_esbuild_shims();
var draculaColors = {
  type: "dark",
  Background: "#282a36",
  Foreground: "#a3afb7",
  LightBlue: "#8be9fd",
  AccentBlue: "#8be9fd",
  AccentPurple: "#ff79c6",
  AccentCyan: "#8be9fd",
  AccentGreen: "#50fa7b",
  AccentYellow: "#fff783",
  AccentRed: "#ff5555",
  AccentYellowDim: "#8B7530",
  AccentRedDim: "#8B3A4A",
  DiffAdded: "#11431d",
  DiffRemoved: "#6e1818",
  Comment: "#6272a4",
  Gray: "#6272a4",
  GradientColors: ["#ff79c6", "#8be9fd"]
};
var Dracula = new Theme(
  "Dracula",
  "dark",
  {
    hljs: {
      display: "block",
      overflowX: "auto",
      padding: "0.5em",
      background: draculaColors.Background,
      color: draculaColors.Foreground
    },
    "hljs-keyword": {
      color: draculaColors.AccentBlue,
      fontWeight: "bold"
    },
    "hljs-selector-tag": {
      color: draculaColors.AccentBlue,
      fontWeight: "bold"
    },
    "hljs-literal": {
      color: draculaColors.AccentBlue,
      fontWeight: "bold"
    },
    "hljs-section": {
      color: draculaColors.AccentBlue,
      fontWeight: "bold"
    },
    "hljs-link": {
      color: draculaColors.AccentBlue
    },
    "hljs-function .hljs-keyword": {
      color: draculaColors.AccentPurple
    },
    "hljs-subst": {
      color: draculaColors.Foreground
    },
    "hljs-string": {
      color: draculaColors.AccentYellow
    },
    "hljs-title": {
      color: draculaColors.AccentYellow,
      fontWeight: "bold"
    },
    "hljs-name": {
      color: draculaColors.AccentYellow,
      fontWeight: "bold"
    },
    "hljs-type": {
      color: draculaColors.AccentYellow,
      fontWeight: "bold"
    },
    "hljs-attribute": {
      color: draculaColors.AccentYellow
    },
    "hljs-symbol": {
      color: draculaColors.AccentYellow
    },
    "hljs-bullet": {
      color: draculaColors.AccentYellow
    },
    "hljs-addition": {
      color: draculaColors.AccentGreen
    },
    "hljs-variable": {
      color: draculaColors.AccentYellow
    },
    "hljs-template-tag": {
      color: draculaColors.AccentYellow
    },
    "hljs-template-variable": {
      color: draculaColors.AccentYellow
    },
    "hljs-comment": {
      color: draculaColors.Comment
    },
    "hljs-quote": {
      color: draculaColors.Comment
    },
    "hljs-deletion": {
      color: draculaColors.AccentRed
    },
    "hljs-meta": {
      color: draculaColors.Comment
    },
    "hljs-doctag": {
      fontWeight: "bold"
    },
    "hljs-strong": {
      fontWeight: "bold"
    },
    "hljs-emphasis": {
      fontStyle: "italic"
    }
  },
  draculaColors
);

// packages/cli/src/ui/themes/github-dark.ts
init_esbuild_shims();
var githubDarkColors = {
  type: "dark",
  Background: "#24292e",
  Foreground: "#c0c4c8",
  LightBlue: "#79B8FF",
  AccentBlue: "#79B8FF",
  AccentPurple: "#B392F0",
  AccentCyan: "#9ECBFF",
  AccentGreen: "#85E89D",
  AccentYellow: "#FFAB70",
  AccentRed: "#F97583",
  AccentYellowDim: "#8B7530",
  AccentRedDim: "#8B3A4A",
  DiffAdded: "#3C4636",
  DiffRemoved: "#502125",
  Comment: "#6A737D",
  Gray: "#6A737D",
  GradientColors: ["#79B8FF", "#85E89D"]
};
var GitHubDark = new Theme(
  "GitHub",
  "dark",
  {
    hljs: {
      display: "block",
      overflowX: "auto",
      padding: "0.5em",
      color: githubDarkColors.Foreground,
      background: githubDarkColors.Background
    },
    "hljs-comment": {
      color: githubDarkColors.Comment,
      fontStyle: "italic"
    },
    "hljs-quote": {
      color: githubDarkColors.Comment,
      fontStyle: "italic"
    },
    "hljs-keyword": {
      color: githubDarkColors.AccentRed,
      fontWeight: "bold"
    },
    "hljs-selector-tag": {
      color: githubDarkColors.AccentRed,
      fontWeight: "bold"
    },
    "hljs-subst": {
      color: githubDarkColors.Foreground
    },
    "hljs-number": {
      color: githubDarkColors.LightBlue
    },
    "hljs-literal": {
      color: githubDarkColors.LightBlue
    },
    "hljs-variable": {
      color: githubDarkColors.AccentYellow
    },
    "hljs-template-variable": {
      color: githubDarkColors.AccentYellow
    },
    "hljs-tag .hljs-attr": {
      color: githubDarkColors.AccentYellow
    },
    "hljs-string": {
      color: githubDarkColors.AccentCyan
    },
    "hljs-doctag": {
      color: githubDarkColors.AccentCyan
    },
    "hljs-title": {
      color: githubDarkColors.AccentPurple,
      fontWeight: "bold"
    },
    "hljs-section": {
      color: githubDarkColors.AccentPurple,
      fontWeight: "bold"
    },
    "hljs-selector-id": {
      color: githubDarkColors.AccentPurple,
      fontWeight: "bold"
    },
    "hljs-type": {
      color: githubDarkColors.AccentGreen,
      fontWeight: "bold"
    },
    "hljs-class .hljs-title": {
      color: githubDarkColors.AccentGreen,
      fontWeight: "bold"
    },
    "hljs-tag": {
      color: githubDarkColors.AccentGreen
    },
    "hljs-name": {
      color: githubDarkColors.AccentGreen
    },
    "hljs-attribute": {
      color: githubDarkColors.LightBlue
    },
    "hljs-regexp": {
      color: githubDarkColors.AccentCyan
    },
    "hljs-link": {
      color: githubDarkColors.AccentCyan
    },
    "hljs-symbol": {
      color: githubDarkColors.AccentPurple
    },
    "hljs-bullet": {
      color: githubDarkColors.AccentPurple
    },
    "hljs-built_in": {
      color: githubDarkColors.LightBlue
    },
    "hljs-builtin-name": {
      color: githubDarkColors.LightBlue
    },
    "hljs-meta": {
      color: githubDarkColors.LightBlue,
      fontWeight: "bold"
    },
    "hljs-deletion": {
      background: "#86181D",
      color: githubDarkColors.AccentRed
    },
    "hljs-addition": {
      background: "#144620",
      color: githubDarkColors.AccentGreen
    },
    "hljs-emphasis": {
      fontStyle: "italic"
    },
    "hljs-strong": {
      fontWeight: "bold"
    }
  },
  githubDarkColors
);

// packages/cli/src/ui/themes/github-light.ts
init_esbuild_shims();
var githubLightColors = {
  type: "light",
  Background: "#f8f8f8",
  Foreground: "#24292E",
  LightBlue: "#0086b3",
  AccentBlue: "#458",
  AccentPurple: "#900",
  AccentCyan: "#009926",
  AccentGreen: "#008080",
  AccentYellow: "#990073",
  AccentRed: "#d14",
  AccentYellowDim: "#8B7000",
  AccentRedDim: "#993333",
  DiffAdded: "#C6EAD8",
  DiffRemoved: "#FFCCCC",
  Comment: "#998",
  Gray: "#999",
  GradientColors: ["#458", "#008080"]
};
var GitHubLight = new Theme(
  "GitHub Light",
  "light",
  {
    hljs: {
      display: "block",
      overflowX: "auto",
      padding: "0.5em",
      color: githubLightColors.Foreground,
      background: githubLightColors.Background
    },
    "hljs-comment": {
      color: githubLightColors.Comment,
      fontStyle: "italic"
    },
    "hljs-quote": {
      color: githubLightColors.Comment,
      fontStyle: "italic"
    },
    "hljs-keyword": {
      color: githubLightColors.Foreground,
      fontWeight: "bold"
    },
    "hljs-selector-tag": {
      color: githubLightColors.Foreground,
      fontWeight: "bold"
    },
    "hljs-subst": {
      color: githubLightColors.Foreground,
      fontWeight: "normal"
    },
    "hljs-number": {
      color: githubLightColors.AccentGreen
    },
    "hljs-literal": {
      color: githubLightColors.AccentGreen
    },
    "hljs-variable": {
      color: githubLightColors.AccentGreen
    },
    "hljs-template-variable": {
      color: githubLightColors.AccentGreen
    },
    "hljs-tag .hljs-attr": {
      color: githubLightColors.AccentGreen
    },
    "hljs-string": {
      color: githubLightColors.AccentRed
    },
    "hljs-doctag": {
      color: githubLightColors.AccentRed
    },
    "hljs-title": {
      color: githubLightColors.AccentPurple,
      fontWeight: "bold"
    },
    "hljs-section": {
      color: githubLightColors.AccentPurple,
      fontWeight: "bold"
    },
    "hljs-selector-id": {
      color: githubLightColors.AccentPurple,
      fontWeight: "bold"
    },
    "hljs-type": {
      color: githubLightColors.AccentBlue,
      fontWeight: "bold"
    },
    "hljs-class .hljs-title": {
      color: githubLightColors.AccentBlue,
      fontWeight: "bold"
    },
    "hljs-tag": {
      color: githubLightColors.AccentBlue,
      fontWeight: "normal"
    },
    "hljs-name": {
      color: githubLightColors.AccentBlue,
      fontWeight: "normal"
    },
    "hljs-attribute": {
      color: githubLightColors.AccentBlue,
      fontWeight: "normal"
    },
    "hljs-regexp": {
      color: githubLightColors.AccentCyan
    },
    "hljs-link": {
      color: githubLightColors.AccentCyan
    },
    "hljs-symbol": {
      color: githubLightColors.AccentYellow
    },
    "hljs-bullet": {
      color: githubLightColors.AccentYellow
    },
    "hljs-built_in": {
      color: githubLightColors.LightBlue
    },
    "hljs-builtin-name": {
      color: githubLightColors.LightBlue
    },
    "hljs-meta": {
      color: githubLightColors.Gray,
      fontWeight: "bold"
    },
    "hljs-deletion": {
      background: "#fdd"
    },
    "hljs-addition": {
      background: "#dfd"
    },
    "hljs-emphasis": {
      fontStyle: "italic"
    },
    "hljs-strong": {
      fontWeight: "bold"
    }
  },
  githubLightColors
);

// packages/cli/src/ui/themes/googlecode.ts
init_esbuild_shims();
var googleCodeColors = {
  type: "light",
  Background: "white",
  Foreground: "#444",
  LightBlue: "#066",
  AccentBlue: "#008",
  AccentPurple: "#606",
  AccentCyan: "#066",
  AccentGreen: "#080",
  AccentYellow: "#660",
  AccentRed: "#800",
  AccentYellowDim: "#8B7000",
  AccentRedDim: "#993333",
  DiffAdded: "#C6EAD8",
  DiffRemoved: "#FEDEDE",
  Comment: "#5f6368",
  Gray: lightTheme.Gray,
  GradientColors: ["#066", "#606"]
};
var GoogleCode = new Theme(
  "Google Code",
  "light",
  {
    hljs: {
      display: "block",
      overflowX: "auto",
      padding: "0.5em",
      background: googleCodeColors.Background,
      color: googleCodeColors.Foreground
    },
    "hljs-comment": {
      color: googleCodeColors.AccentRed
    },
    "hljs-quote": {
      color: googleCodeColors.AccentRed
    },
    "hljs-keyword": {
      color: googleCodeColors.AccentBlue
    },
    "hljs-selector-tag": {
      color: googleCodeColors.AccentBlue
    },
    "hljs-section": {
      color: googleCodeColors.AccentBlue
    },
    "hljs-title": {
      color: googleCodeColors.AccentPurple
    },
    "hljs-name": {
      color: googleCodeColors.AccentBlue
    },
    "hljs-variable": {
      color: googleCodeColors.AccentYellow
    },
    "hljs-template-variable": {
      color: googleCodeColors.AccentYellow
    },
    "hljs-string": {
      color: googleCodeColors.AccentGreen
    },
    "hljs-selector-attr": {
      color: googleCodeColors.AccentGreen
    },
    "hljs-selector-pseudo": {
      color: googleCodeColors.AccentGreen
    },
    "hljs-regexp": {
      color: googleCodeColors.AccentGreen
    },
    "hljs-literal": {
      color: googleCodeColors.AccentCyan
    },
    "hljs-symbol": {
      color: googleCodeColors.AccentCyan
    },
    "hljs-bullet": {
      color: googleCodeColors.AccentCyan
    },
    "hljs-meta": {
      color: googleCodeColors.AccentCyan
    },
    "hljs-number": {
      color: googleCodeColors.AccentCyan
    },
    "hljs-link": {
      color: googleCodeColors.AccentCyan
    },
    "hljs-doctag": {
      color: googleCodeColors.AccentPurple,
      fontWeight: "bold"
    },
    "hljs-type": {
      color: googleCodeColors.AccentPurple
    },
    "hljs-attr": {
      color: googleCodeColors.AccentPurple
    },
    "hljs-built_in": {
      color: googleCodeColors.AccentPurple
    },
    "hljs-builtin-name": {
      color: googleCodeColors.AccentPurple
    },
    "hljs-params": {
      color: googleCodeColors.AccentPurple
    },
    "hljs-attribute": {
      color: googleCodeColors.Foreground
    },
    "hljs-subst": {
      color: googleCodeColors.Foreground
    },
    "hljs-formula": {
      backgroundColor: "#eee",
      fontStyle: "italic"
    },
    "hljs-selector-id": {
      color: googleCodeColors.AccentYellow
    },
    "hljs-selector-class": {
      color: googleCodeColors.AccentYellow
    },
    "hljs-addition": {
      backgroundColor: "#baeeba"
    },
    "hljs-deletion": {
      backgroundColor: "#ffc8bd"
    },
    "hljs-strong": {
      fontWeight: "bold"
    },
    "hljs-emphasis": {
      fontStyle: "italic"
    }
  },
  googleCodeColors
);

// packages/cli/src/ui/themes/default-light.ts
init_esbuild_shims();
var DefaultLight = new Theme(
  DEFAULT_LIGHT_THEME_NAME,
  "light",
  {
    hljs: {
      display: "block",
      overflowX: "auto",
      padding: "0.5em",
      background: lightTheme.Background,
      color: lightTheme.Foreground
    },
    "hljs-comment": {
      color: lightTheme.Comment
    },
    "hljs-quote": {
      color: lightTheme.Comment
    },
    "hljs-variable": {
      color: lightTheme.Foreground
    },
    "hljs-keyword": {
      color: lightTheme.AccentBlue
    },
    "hljs-selector-tag": {
      color: lightTheme.AccentBlue
    },
    "hljs-built_in": {
      color: lightTheme.AccentBlue
    },
    "hljs-name": {
      color: lightTheme.AccentBlue
    },
    "hljs-tag": {
      color: lightTheme.AccentBlue
    },
    "hljs-string": {
      color: lightTheme.AccentRed
    },
    "hljs-title": {
      color: lightTheme.AccentRed
    },
    "hljs-section": {
      color: lightTheme.AccentRed
    },
    "hljs-attribute": {
      color: lightTheme.AccentRed
    },
    "hljs-literal": {
      color: lightTheme.AccentRed
    },
    "hljs-template-tag": {
      color: lightTheme.AccentRed
    },
    "hljs-template-variable": {
      color: lightTheme.AccentRed
    },
    "hljs-type": {
      color: lightTheme.AccentRed
    },
    "hljs-addition": {
      color: lightTheme.AccentGreen
    },
    "hljs-deletion": {
      color: lightTheme.AccentRed
    },
    "hljs-selector-attr": {
      color: lightTheme.AccentCyan
    },
    "hljs-selector-pseudo": {
      color: lightTheme.AccentCyan
    },
    "hljs-meta": {
      color: lightTheme.AccentCyan
    },
    "hljs-doctag": {
      color: lightTheme.Gray
    },
    "hljs-attr": {
      color: lightTheme.AccentRed
    },
    "hljs-symbol": {
      color: lightTheme.AccentCyan
    },
    "hljs-bullet": {
      color: lightTheme.AccentCyan
    },
    "hljs-link": {
      color: lightTheme.AccentCyan
    },
    "hljs-emphasis": {
      fontStyle: "italic"
    },
    "hljs-strong": {
      fontWeight: "bold"
    }
  },
  lightTheme
);

// packages/cli/src/ui/themes/default.ts
init_esbuild_shims();
var DefaultDark = new Theme(
  DEFAULT_DARK_THEME_NAME,
  "dark",
  {
    hljs: {
      display: "block",
      overflowX: "auto",
      padding: "0.5em",
      background: darkTheme.Background,
      color: darkTheme.Foreground
    },
    "hljs-keyword": {
      color: darkTheme.AccentBlue
    },
    "hljs-literal": {
      color: darkTheme.AccentBlue
    },
    "hljs-symbol": {
      color: darkTheme.AccentBlue
    },
    "hljs-name": {
      color: darkTheme.AccentBlue
    },
    "hljs-link": {
      color: darkTheme.AccentBlue,
      textDecoration: "underline"
    },
    "hljs-built_in": {
      color: darkTheme.AccentCyan
    },
    "hljs-type": {
      color: darkTheme.AccentCyan
    },
    "hljs-number": {
      color: darkTheme.AccentGreen
    },
    "hljs-class": {
      color: darkTheme.AccentGreen
    },
    "hljs-string": {
      color: darkTheme.AccentYellow
    },
    "hljs-meta-string": {
      color: darkTheme.AccentYellow
    },
    "hljs-regexp": {
      color: darkTheme.AccentRed
    },
    "hljs-template-tag": {
      color: darkTheme.AccentRed
    },
    "hljs-subst": {
      color: darkTheme.Foreground
    },
    "hljs-function": {
      color: darkTheme.Foreground
    },
    "hljs-title": {
      color: darkTheme.Foreground
    },
    "hljs-params": {
      color: darkTheme.Foreground
    },
    "hljs-formula": {
      color: darkTheme.Foreground
    },
    "hljs-comment": {
      color: darkTheme.Comment,
      fontStyle: "italic"
    },
    "hljs-quote": {
      color: darkTheme.Comment,
      fontStyle: "italic"
    },
    "hljs-doctag": {
      color: darkTheme.Comment
    },
    "hljs-meta": {
      color: darkTheme.Gray
    },
    "hljs-meta-keyword": {
      color: darkTheme.Gray
    },
    "hljs-tag": {
      color: darkTheme.Gray
    },
    "hljs-variable": {
      color: darkTheme.AccentPurple
    },
    "hljs-template-variable": {
      color: darkTheme.AccentPurple
    },
    "hljs-attr": {
      color: darkTheme.LightBlue
    },
    "hljs-attribute": {
      color: darkTheme.LightBlue
    },
    "hljs-builtin-name": {
      color: darkTheme.LightBlue
    },
    "hljs-section": {
      color: darkTheme.AccentYellow
    },
    "hljs-emphasis": {
      fontStyle: "italic"
    },
    "hljs-strong": {
      fontWeight: "bold"
    },
    "hljs-bullet": {
      color: darkTheme.AccentYellow
    },
    "hljs-selector-tag": {
      color: darkTheme.AccentYellow
    },
    "hljs-selector-id": {
      color: darkTheme.AccentYellow
    },
    "hljs-selector-class": {
      color: darkTheme.AccentYellow
    },
    "hljs-selector-attr": {
      color: darkTheme.AccentYellow
    },
    "hljs-selector-pseudo": {
      color: darkTheme.AccentYellow
    },
    "hljs-addition": {
      backgroundColor: "#144212",
      display: "inline-block",
      width: "100%"
    },
    "hljs-deletion": {
      backgroundColor: "#600",
      display: "inline-block",
      width: "100%"
    }
  },
  darkTheme
);

// packages/cli/src/ui/themes/shades-of-purple.ts
init_esbuild_shims();
var shadesOfPurpleColors = {
  type: "dark",
  // Required colors for ColorsTheme interface
  Background: "#2d2b57",
  // Main background
  Foreground: "#e3dfff",
  // Default text color (hljs, hljs-subst)
  LightBlue: "#847ace",
  // Light blue/purple accent
  AccentBlue: "#a599e9",
  // Borders, secondary blue
  AccentPurple: "#ac65ff",
  // Comments (main purple)
  AccentCyan: "#a1feff",
  // Names
  AccentGreen: "#A5FF90",
  // Strings and many others
  AccentYellow: "#fad000",
  // Title, main yellow
  AccentRed: "#ff628c",
  // Error/deletion accent
  AccentYellowDim: "#8B7530",
  AccentRedDim: "#8B3A4A",
  DiffAdded: "#383E45",
  DiffRemoved: "#572244",
  Comment: "#B362FF",
  // Comment color (same as AccentPurple)
  Gray: "#726c86",
  // Gray color
  GradientColors: ["#4d21fc", "#847ace", "#ff628c"]
};
var additionalColors = {
  AccentYellowAlt: "#f8d000",
  // Attr yellow (slightly different)
  AccentOrange: "#fb9e00",
  // Keywords, built_in, meta
  AccentPink: "#fa658d",
  // Numbers, literals
  AccentLightPurple: "#c991ff",
  // For params and properties
  AccentDarkPurple: "#6943ff",
  // For operators
  AccentTeal: "#2ee2fa"
  // For special constructs
};
var ShadesOfPurple = new Theme(
  "Shades Of Purple",
  "dark",
  {
    // Base styles
    hljs: {
      display: "block",
      overflowX: "auto",
      background: shadesOfPurpleColors.Background,
      color: shadesOfPurpleColors.Foreground
    },
    // Title elements
    "hljs-title": {
      color: shadesOfPurpleColors.AccentYellow,
      fontWeight: "normal"
    },
    // Names
    "hljs-name": {
      color: shadesOfPurpleColors.AccentCyan,
      fontWeight: "normal"
    },
    // Tags
    "hljs-tag": {
      color: shadesOfPurpleColors.Foreground
    },
    // Attributes
    "hljs-attr": {
      color: additionalColors.AccentYellowAlt,
      fontStyle: "italic"
    },
    // Built-ins, selector tags, sections
    "hljs-built_in": {
      color: additionalColors.AccentOrange
    },
    "hljs-selector-tag": {
      color: additionalColors.AccentOrange,
      fontWeight: "normal"
    },
    "hljs-section": {
      color: additionalColors.AccentOrange
    },
    // Keywords
    "hljs-keyword": {
      color: additionalColors.AccentOrange,
      fontWeight: "normal"
    },
    // Default text and substitutions
    "hljs-subst": {
      color: shadesOfPurpleColors.Foreground
    },
    // Strings and related elements (all green)
    "hljs-string": {
      color: shadesOfPurpleColors.AccentGreen
    },
    "hljs-attribute": {
      color: shadesOfPurpleColors.AccentGreen
    },
    "hljs-symbol": {
      color: shadesOfPurpleColors.AccentGreen
    },
    "hljs-bullet": {
      color: shadesOfPurpleColors.AccentGreen
    },
    "hljs-addition": {
      color: shadesOfPurpleColors.AccentGreen
    },
    "hljs-code": {
      color: shadesOfPurpleColors.AccentGreen
    },
    "hljs-regexp": {
      color: shadesOfPurpleColors.AccentGreen
    },
    "hljs-selector-class": {
      color: shadesOfPurpleColors.AccentGreen
    },
    "hljs-selector-attr": {
      color: shadesOfPurpleColors.AccentGreen
    },
    "hljs-selector-pseudo": {
      color: shadesOfPurpleColors.AccentGreen
    },
    "hljs-template-tag": {
      color: shadesOfPurpleColors.AccentGreen
    },
    "hljs-quote": {
      color: shadesOfPurpleColors.AccentGreen
    },
    "hljs-deletion": {
      color: shadesOfPurpleColors.AccentRed
    },
    // Meta elements
    "hljs-meta": {
      color: additionalColors.AccentOrange
    },
    "hljs-meta-string": {
      color: additionalColors.AccentOrange
    },
    // Comments
    "hljs-comment": {
      color: shadesOfPurpleColors.AccentPurple
    },
    // Literals and numbers
    "hljs-literal": {
      color: additionalColors.AccentPink,
      fontWeight: "normal"
    },
    "hljs-number": {
      color: additionalColors.AccentPink
    },
    // Emphasis and strong
    "hljs-emphasis": {
      fontStyle: "italic"
    },
    "hljs-strong": {
      fontWeight: "bold"
    },
    // Diff-specific classes
    "hljs-diff": {
      color: shadesOfPurpleColors.Foreground
    },
    "hljs-meta.hljs-diff": {
      color: shadesOfPurpleColors.AccentBlue
    },
    "hljs-ln": {
      color: shadesOfPurpleColors.Gray
    },
    // Additional elements that might be needed
    "hljs-type": {
      color: shadesOfPurpleColors.AccentYellow,
      fontWeight: "normal"
    },
    "hljs-variable": {
      color: shadesOfPurpleColors.AccentYellow
    },
    "hljs-template-variable": {
      color: shadesOfPurpleColors.AccentGreen
    },
    "hljs-function .hljs-keyword": {
      color: additionalColors.AccentOrange
    },
    "hljs-link": {
      color: shadesOfPurpleColors.LightBlue
    },
    "hljs-doctag": {
      fontWeight: "bold"
    },
    // Function parameters
    "hljs-params": {
      color: additionalColors.AccentLightPurple,
      fontStyle: "italic"
    },
    // Class definitions
    "hljs-class": {
      color: shadesOfPurpleColors.AccentCyan,
      fontWeight: "bold"
    },
    // Function definitions
    "hljs-function": {
      color: shadesOfPurpleColors.AccentCyan
    },
    // Object properties
    "hljs-property": {
      color: shadesOfPurpleColors.AccentBlue
    },
    // Operators
    "hljs-operator": {
      color: additionalColors.AccentDarkPurple
    },
    // Punctuation (if supported by the parser)
    "hljs-punctuation": {
      color: shadesOfPurpleColors.Gray
    },
    // CSS ID selectors
    "hljs-selector-id": {
      color: shadesOfPurpleColors.AccentYellow,
      fontWeight: "bold"
    },
    // Character literals
    "hljs-char": {
      color: shadesOfPurpleColors.AccentGreen
    },
    // Escape sequences
    "hljs-escape": {
      color: additionalColors.AccentPink,
      fontWeight: "bold"
    },
    // Meta keywords
    "hljs-meta-keyword": {
      color: additionalColors.AccentOrange,
      fontWeight: "bold"
    },
    // Built-in names
    "hljs-builtin-name": {
      color: additionalColors.AccentTeal
    },
    // Modules
    "hljs-module": {
      color: shadesOfPurpleColors.AccentCyan
    },
    // Namespaces
    "hljs-namespace": {
      color: shadesOfPurpleColors.LightBlue
    },
    // Important annotations
    "hljs-important": {
      color: shadesOfPurpleColors.AccentRed,
      fontWeight: "bold"
    },
    // Formulas (for LaTeX, etc.)
    "hljs-formula": {
      color: shadesOfPurpleColors.AccentCyan,
      fontStyle: "italic"
    },
    // Language-specific additions
    // Python decorators
    "hljs-decorator": {
      color: additionalColors.AccentTeal,
      fontWeight: "bold"
    },
    // Ruby symbols
    "hljs-symbol.ruby": {
      color: additionalColors.AccentPink
    },
    // SQL keywords
    "hljs-keyword.sql": {
      color: additionalColors.AccentOrange,
      textTransform: "uppercase"
    },
    // Markdown specific
    "hljs-section.markdown": {
      color: shadesOfPurpleColors.AccentYellow,
      fontWeight: "bold"
    },
    // JSON keys
    "hljs-attr.json": {
      color: shadesOfPurpleColors.AccentCyan
    },
    // XML/HTML specific
    "hljs-tag .hljs-name": {
      color: shadesOfPurpleColors.AccentRed
    },
    "hljs-tag .hljs-attr": {
      color: additionalColors.AccentYellowAlt
    },
    // Line highlighting (if line numbers are enabled)
    "hljs.hljs-line-numbers": {
      borderRight: `1px solid ${shadesOfPurpleColors.Gray}`
    },
    "hljs.hljs-line-numbers .hljs-ln-numbers": {
      color: shadesOfPurpleColors.Gray,
      paddingRight: "1em"
    },
    "hljs.hljs-line-numbers .hljs-ln-code": {
      paddingLeft: "1em"
    },
    // Selection styling
    "hljs::selection": {
      background: shadesOfPurpleColors.AccentBlue + "40"
      // 40 = 25% opacity
    },
    "hljs ::-moz-selection": {
      background: shadesOfPurpleColors.AccentBlue + "40"
    },
    // Highlighted lines (for emphasis)
    "hljs .hljs-highlight": {
      background: shadesOfPurpleColors.AccentPurple + "20",
      // 20 = 12.5% opacity
      display: "block",
      width: "100%"
    }
  },
  shadesOfPurpleColors
);

// packages/cli/src/ui/themes/xcode.ts
init_esbuild_shims();
var xcodeColors = {
  type: "light",
  Background: "#fff",
  Foreground: "#444",
  LightBlue: "#0E0EFF",
  AccentBlue: "#1c00cf",
  AccentPurple: "#aa0d91",
  AccentCyan: "#3F6E74",
  AccentGreen: "#007400",
  AccentYellow: "#836C28",
  AccentRed: "#c41a16",
  AccentYellowDim: "#8B7000",
  AccentRedDim: "#993333",
  DiffAdded: "#C6EAD8",
  DiffRemoved: "#FEDEDE",
  Comment: "#007400",
  Gray: "#c0c0c0",
  GradientColors: ["#1c00cf", "#007400"]
};
var XCode = new Theme(
  "Xcode",
  "light",
  {
    hljs: {
      display: "block",
      overflowX: "auto",
      padding: "0.5em",
      background: xcodeColors.Background,
      color: xcodeColors.Foreground
    },
    "xml .hljs-meta": {
      color: xcodeColors.Gray
    },
    "hljs-comment": {
      color: xcodeColors.Comment
    },
    "hljs-quote": {
      color: xcodeColors.Comment
    },
    "hljs-tag": {
      color: xcodeColors.AccentPurple
    },
    "hljs-attribute": {
      color: xcodeColors.AccentPurple
    },
    "hljs-keyword": {
      color: xcodeColors.AccentPurple
    },
    "hljs-selector-tag": {
      color: xcodeColors.AccentPurple
    },
    "hljs-literal": {
      color: xcodeColors.AccentPurple
    },
    "hljs-name": {
      color: xcodeColors.AccentPurple
    },
    "hljs-variable": {
      color: xcodeColors.AccentCyan
    },
    "hljs-template-variable": {
      color: xcodeColors.AccentCyan
    },
    "hljs-code": {
      color: xcodeColors.AccentRed
    },
    "hljs-string": {
      color: xcodeColors.AccentRed
    },
    "hljs-meta-string": {
      color: xcodeColors.AccentRed
    },
    "hljs-regexp": {
      color: xcodeColors.LightBlue
    },
    "hljs-link": {
      color: xcodeColors.LightBlue
    },
    "hljs-title": {
      color: xcodeColors.AccentBlue
    },
    "hljs-symbol": {
      color: xcodeColors.AccentBlue
    },
    "hljs-bullet": {
      color: xcodeColors.AccentBlue
    },
    "hljs-number": {
      color: xcodeColors.AccentBlue
    },
    "hljs-section": {
      color: xcodeColors.AccentYellow
    },
    "hljs-meta": {
      color: xcodeColors.AccentYellow
    },
    "hljs-class .hljs-title": {
      color: xcodeColors.AccentPurple
    },
    "hljs-type": {
      color: xcodeColors.AccentPurple
    },
    "hljs-built_in": {
      color: xcodeColors.AccentPurple
    },
    "hljs-builtin-name": {
      color: xcodeColors.AccentPurple
    },
    "hljs-params": {
      color: xcodeColors.AccentPurple
    },
    "hljs-attr": {
      color: xcodeColors.AccentYellow
    },
    "hljs-subst": {
      color: xcodeColors.Foreground
    },
    "hljs-formula": {
      backgroundColor: "#eee",
      fontStyle: "italic"
    },
    "hljs-addition": {
      backgroundColor: "#baeeba"
    },
    "hljs-deletion": {
      backgroundColor: "#ffc8bd"
    },
    "hljs-selector-id": {
      color: xcodeColors.AccentYellow
    },
    "hljs-selector-class": {
      color: xcodeColors.AccentYellow
    },
    "hljs-doctag": {
      fontWeight: "bold"
    },
    "hljs-strong": {
      fontWeight: "bold"
    },
    "hljs-emphasis": {
      fontStyle: "italic"
    }
  },
  xcodeColors
);

// packages/cli/src/ui/themes/qwen-light.ts
init_esbuild_shims();

// packages/cli/src/ui/themes/semantic-tokens.ts
init_esbuild_shims();
var lightSemanticColors = {
  text: {
    primary: lightTheme.Foreground,
    secondary: lightTheme.Gray,
    link: lightTheme.AccentBlue,
    accent: lightTheme.AccentPurple,
    code: lightTheme.LightBlue
  },
  background: {
    primary: lightTheme.Background,
    diff: {
      added: lightTheme.DiffAdded,
      removed: lightTheme.DiffRemoved
    }
  },
  border: {
    default: lightTheme.Gray,
    focused: lightTheme.AccentBlue
  },
  ui: {
    comment: lightTheme.Comment,
    symbol: lightTheme.Gray,
    gradient: lightTheme.GradientColors
  },
  status: {
    error: lightTheme.AccentRed,
    success: lightTheme.AccentGreen,
    warning: lightTheme.AccentYellow,
    errorDim: lightTheme.AccentRedDim,
    warningDim: lightTheme.AccentYellowDim
  }
};
var darkSemanticColors = {
  text: {
    primary: darkTheme.Foreground,
    secondary: darkTheme.Gray,
    link: darkTheme.AccentBlue,
    accent: darkTheme.AccentPurple,
    code: darkTheme.LightBlue
  },
  background: {
    primary: darkTheme.Background,
    diff: {
      added: darkTheme.DiffAdded,
      removed: darkTheme.DiffRemoved
    }
  },
  border: {
    default: darkTheme.Gray,
    focused: darkTheme.AccentBlue
  },
  ui: {
    comment: darkTheme.Comment,
    symbol: darkTheme.Gray,
    gradient: darkTheme.GradientColors
  },
  status: {
    error: darkTheme.AccentRed,
    success: darkTheme.AccentGreen,
    warning: darkTheme.AccentYellow,
    errorDim: darkTheme.AccentRedDim,
    warningDim: darkTheme.AccentYellowDim
  }
};
var ansiSemanticColors = {
  text: {
    primary: ansiTheme.Foreground,
    secondary: ansiTheme.Gray,
    link: ansiTheme.AccentBlue,
    accent: ansiTheme.AccentPurple,
    code: ansiTheme.LightBlue
  },
  background: {
    primary: ansiTheme.Background,
    diff: {
      added: ansiTheme.DiffAdded,
      removed: ansiTheme.DiffRemoved
    }
  },
  border: {
    default: ansiTheme.Gray,
    focused: ansiTheme.AccentBlue
  },
  ui: {
    comment: ansiTheme.Comment,
    symbol: ansiTheme.Gray,
    gradient: ansiTheme.GradientColors
  },
  status: {
    error: ansiTheme.AccentRed,
    success: ansiTheme.AccentGreen,
    warning: ansiTheme.AccentYellow,
    errorDim: ansiTheme.AccentRedDim,
    warningDim: ansiTheme.AccentYellowDim
  }
};

// packages/cli/src/ui/themes/qwen-light.ts
var qwenLightColors = {
  type: "light",
  Background: "#f8f9fa",
  Foreground: "#5c6166",
  LightBlue: "#55b4d4",
  AccentBlue: "#399ee6",
  AccentPurple: "#a37acc",
  AccentCyan: "#4cbf99",
  AccentGreen: "#86b300",
  AccentYellow: "#f2ae49",
  AccentRed: "#f07171",
  AccentYellowDim: "#8B7000",
  AccentRedDim: "#993333",
  DiffAdded: "#86b300",
  DiffRemoved: "#f07171",
  Comment: "#ABADB1",
  Gray: "#CCCFD3",
  GradientColors: ["#399ee6", "#86b300"]
};
var QwenLight = new Theme(
  "Qwen Light",
  "light",
  {
    hljs: {
      display: "block",
      overflowX: "auto",
      padding: "0.5em",
      background: qwenLightColors.Background,
      color: qwenLightColors.Foreground
    },
    "hljs-comment": {
      color: qwenLightColors.Comment,
      fontStyle: "italic"
    },
    "hljs-quote": {
      color: qwenLightColors.AccentCyan,
      fontStyle: "italic"
    },
    "hljs-string": {
      color: qwenLightColors.AccentGreen
    },
    "hljs-constant": {
      color: qwenLightColors.AccentCyan
    },
    "hljs-number": {
      color: qwenLightColors.AccentPurple
    },
    "hljs-keyword": {
      color: qwenLightColors.AccentYellow
    },
    "hljs-selector-tag": {
      color: qwenLightColors.AccentYellow
    },
    "hljs-attribute": {
      color: qwenLightColors.AccentYellow
    },
    "hljs-variable": {
      color: qwenLightColors.Foreground
    },
    "hljs-variable.language": {
      color: qwenLightColors.LightBlue,
      fontStyle: "italic"
    },
    "hljs-title": {
      color: qwenLightColors.AccentBlue
    },
    "hljs-section": {
      color: qwenLightColors.AccentGreen,
      fontWeight: "bold"
    },
    "hljs-type": {
      color: qwenLightColors.LightBlue
    },
    "hljs-class .hljs-title": {
      color: qwenLightColors.AccentBlue
    },
    "hljs-tag": {
      color: qwenLightColors.LightBlue
    },
    "hljs-name": {
      color: qwenLightColors.AccentBlue
    },
    "hljs-builtin-name": {
      color: qwenLightColors.AccentYellow
    },
    "hljs-meta": {
      color: qwenLightColors.AccentYellow
    },
    "hljs-symbol": {
      color: qwenLightColors.AccentRed
    },
    "hljs-bullet": {
      color: qwenLightColors.AccentYellow
    },
    "hljs-regexp": {
      color: qwenLightColors.AccentCyan
    },
    "hljs-link": {
      color: qwenLightColors.LightBlue
    },
    "hljs-deletion": {
      color: qwenLightColors.AccentRed
    },
    "hljs-addition": {
      color: qwenLightColors.AccentGreen
    },
    "hljs-emphasis": {
      fontStyle: "italic"
    },
    "hljs-strong": {
      fontWeight: "bold"
    },
    "hljs-literal": {
      color: qwenLightColors.AccentCyan
    },
    "hljs-built_in": {
      color: qwenLightColors.AccentRed
    },
    "hljs-doctag": {
      color: qwenLightColors.AccentRed
    },
    "hljs-template-variable": {
      color: qwenLightColors.AccentCyan
    },
    "hljs-selector-id": {
      color: qwenLightColors.AccentRed
    }
  },
  qwenLightColors,
  lightSemanticColors
);

// packages/cli/src/ui/themes/qwen-dark.ts
init_esbuild_shims();
var qwenDarkColors = {
  type: "dark",
  Background: "#0b0e14",
  Foreground: "#bfbdb6",
  LightBlue: "#59C2FF",
  AccentBlue: "#39BAE6",
  AccentPurple: "#D2A6FF",
  AccentCyan: "#95E6CB",
  AccentGreen: "#AAD94C",
  AccentYellow: "#FFD700",
  AccentRed: "#F26D78",
  AccentYellowDim: "#8B7530",
  AccentRedDim: "#8B3A4A",
  DiffAdded: "#AAD94C",
  DiffRemoved: "#F26D78",
  Comment: "#646A71",
  Gray: "#3D4149",
  GradientColors: ["#FFD700", "#da7959"]
};
var QwenDark = new Theme(
  "Qwen Dark",
  "dark",
  {
    hljs: {
      display: "block",
      overflowX: "auto",
      padding: "0.5em",
      background: qwenDarkColors.Background,
      color: qwenDarkColors.Foreground
    },
    "hljs-keyword": {
      color: qwenDarkColors.AccentYellow
    },
    "hljs-literal": {
      color: qwenDarkColors.AccentPurple
    },
    "hljs-symbol": {
      color: qwenDarkColors.AccentCyan
    },
    "hljs-name": {
      color: qwenDarkColors.LightBlue
    },
    "hljs-link": {
      color: qwenDarkColors.AccentBlue
    },
    "hljs-function .hljs-keyword": {
      color: qwenDarkColors.AccentYellow
    },
    "hljs-subst": {
      color: qwenDarkColors.Foreground
    },
    "hljs-string": {
      color: qwenDarkColors.AccentGreen
    },
    "hljs-title": {
      color: qwenDarkColors.AccentYellow
    },
    "hljs-type": {
      color: qwenDarkColors.AccentBlue
    },
    "hljs-attribute": {
      color: qwenDarkColors.AccentYellow
    },
    "hljs-bullet": {
      color: qwenDarkColors.AccentYellow
    },
    "hljs-addition": {
      color: qwenDarkColors.AccentGreen
    },
    "hljs-variable": {
      color: qwenDarkColors.Foreground
    },
    "hljs-template-tag": {
      color: qwenDarkColors.AccentYellow
    },
    "hljs-template-variable": {
      color: qwenDarkColors.AccentYellow
    },
    "hljs-comment": {
      color: qwenDarkColors.Comment,
      fontStyle: "italic"
    },
    "hljs-quote": {
      color: qwenDarkColors.AccentCyan,
      fontStyle: "italic"
    },
    "hljs-deletion": {
      color: qwenDarkColors.AccentRed
    },
    "hljs-meta": {
      color: qwenDarkColors.AccentYellow
    },
    "hljs-doctag": {
      fontWeight: "bold"
    },
    "hljs-strong": {
      fontWeight: "bold"
    },
    "hljs-emphasis": {
      fontStyle: "italic"
    }
  },
  qwenDarkColors,
  darkSemanticColors
);

// packages/cli/src/ui/themes/theme-manager.ts
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// packages/cli/src/ui/themes/ansi.ts
init_esbuild_shims();
var ansiColors = {
  type: "dark",
  Background: "black",
  Foreground: "white",
  LightBlue: "bluebright",
  AccentBlue: "blue",
  AccentPurple: "magenta",
  AccentCyan: "cyan",
  AccentGreen: "green",
  AccentYellow: "yellow",
  AccentRed: "red",
  AccentYellowDim: "yellow",
  AccentRedDim: "red",
  DiffAdded: "#003300",
  DiffRemoved: "#4D0000",
  Comment: "gray",
  Gray: "gray",
  GradientColors: ["cyan", "green"]
};
var ANSI = new Theme(
  "ANSI",
  "dark",
  // Consistent with its color palette base
  {
    hljs: {
      display: "block",
      overflowX: "auto",
      padding: "0.5em",
      background: "black",
      // Mapped from #1E1E1E
      color: "white"
      // Mapped from #DCDCDC
    },
    "hljs-keyword": {
      color: "blue"
      // Mapped from #569CD6
    },
    "hljs-literal": {
      color: "blue"
      // Mapped from #569CD6
    },
    "hljs-symbol": {
      color: "blue"
      // Mapped from #569CD6
    },
    "hljs-name": {
      color: "blue"
      // Mapped from #569CD6
    },
    "hljs-link": {
      color: "blue"
      // Mapped from #569CD6
      // textDecoration is ignored by Theme class
    },
    "hljs-built_in": {
      color: "cyan"
      // Mapped from #4EC9B0
    },
    "hljs-type": {
      color: "cyan"
      // Mapped from #4EC9B0
    },
    "hljs-number": {
      color: "green"
      // Mapped from #B8D7A3
    },
    "hljs-class": {
      color: "green"
      // Mapped from #B8D7A3
    },
    "hljs-string": {
      color: "yellow"
      // Mapped from #D69D85
    },
    "hljs-meta-string": {
      color: "yellow"
      // Mapped from #D69D85
    },
    "hljs-regexp": {
      color: "red"
      // Mapped from #9A5334
    },
    "hljs-template-tag": {
      color: "red"
      // Mapped from #9A5334
    },
    "hljs-subst": {
      color: "white"
      // Mapped from #DCDCDC
    },
    "hljs-function": {
      color: "white"
      // Mapped from #DCDCDC
    },
    "hljs-title": {
      color: "white"
      // Mapped from #DCDCDC
    },
    "hljs-params": {
      color: "white"
      // Mapped from #DCDCDC
    },
    "hljs-formula": {
      color: "white"
      // Mapped from #DCDCDC
    },
    "hljs-comment": {
      color: "green"
      // Mapped from #57A64A
      // fontStyle is ignored by Theme class
    },
    "hljs-quote": {
      color: "green"
      // Mapped from #57A64A
      // fontStyle is ignored by Theme class
    },
    "hljs-doctag": {
      color: "green"
      // Mapped from #608B4E
    },
    "hljs-meta": {
      color: "gray"
      // Mapped from #9B9B9B
    },
    "hljs-meta-keyword": {
      color: "gray"
      // Mapped from #9B9B9B
    },
    "hljs-tag": {
      color: "gray"
      // Mapped from #9B9B9B
    },
    "hljs-variable": {
      color: "magenta"
      // Mapped from #BD63C5
    },
    "hljs-template-variable": {
      color: "magenta"
      // Mapped from #BD63C5
    },
    "hljs-attr": {
      color: "bluebright"
      // Mapped from #9CDCFE
    },
    "hljs-attribute": {
      color: "bluebright"
      // Mapped from #9CDCFE
    },
    "hljs-builtin-name": {
      color: "bluebright"
      // Mapped from #9CDCFE
    },
    "hljs-section": {
      color: "yellow"
      // Mapped from gold
    },
    "hljs-emphasis": {
      // fontStyle is ignored by Theme class
    },
    "hljs-strong": {
      // fontWeight is ignored by Theme class
    },
    "hljs-bullet": {
      color: "yellow"
      // Mapped from #D7BA7D
    },
    "hljs-selector-tag": {
      color: "yellow"
      // Mapped from #D7BA7D
    },
    "hljs-selector-id": {
      color: "yellow"
      // Mapped from #D7BA7D
    },
    "hljs-selector-class": {
      color: "yellow"
      // Mapped from #D7BA7D
    },
    "hljs-selector-attr": {
      color: "yellow"
      // Mapped from #D7BA7D
    },
    "hljs-selector-pseudo": {
      color: "yellow"
      // Mapped from #D7BA7D
    }
  },
  ansiColors,
  darkSemanticColors
);

// packages/cli/src/ui/themes/ansi-light.ts
init_esbuild_shims();
var ansiLightColors = {
  type: "light",
  Background: "white",
  Foreground: "#444",
  LightBlue: "blue",
  AccentBlue: "blue",
  AccentPurple: "purple",
  AccentCyan: "cyan",
  AccentGreen: "green",
  AccentYellow: "orange",
  AccentRed: "red",
  AccentYellowDim: "orange",
  AccentRedDim: "red",
  DiffAdded: "#E5F2E5",
  DiffRemoved: "#FFE5E5",
  Comment: "gray",
  Gray: "gray",
  GradientColors: ["blue", "green"]
};
var ANSILight = new Theme(
  "ANSI Light",
  "light",
  {
    hljs: {
      display: "block",
      overflowX: "auto",
      padding: "0.5em",
      background: "white",
      color: "black"
    },
    "hljs-keyword": {
      color: "blue"
    },
    "hljs-literal": {
      color: "blue"
    },
    "hljs-symbol": {
      color: "blue"
    },
    "hljs-name": {
      color: "blue"
    },
    "hljs-link": {
      color: "blue"
    },
    "hljs-built_in": {
      color: "cyan"
    },
    "hljs-type": {
      color: "cyan"
    },
    "hljs-number": {
      color: "green"
    },
    "hljs-class": {
      color: "green"
    },
    "hljs-string": {
      color: "red"
    },
    "hljs-meta-string": {
      color: "red"
    },
    "hljs-regexp": {
      color: "magenta"
    },
    "hljs-template-tag": {
      color: "magenta"
    },
    "hljs-subst": {
      color: "black"
    },
    "hljs-function": {
      color: "black"
    },
    "hljs-title": {
      color: "black"
    },
    "hljs-params": {
      color: "black"
    },
    "hljs-formula": {
      color: "black"
    },
    "hljs-comment": {
      color: "gray"
    },
    "hljs-quote": {
      color: "gray"
    },
    "hljs-doctag": {
      color: "gray"
    },
    "hljs-meta": {
      color: "gray"
    },
    "hljs-meta-keyword": {
      color: "gray"
    },
    "hljs-tag": {
      color: "gray"
    },
    "hljs-variable": {
      color: "purple"
    },
    "hljs-template-variable": {
      color: "purple"
    },
    "hljs-attr": {
      color: "blue"
    },
    "hljs-attribute": {
      color: "blue"
    },
    "hljs-builtin-name": {
      color: "blue"
    },
    "hljs-section": {
      color: "orange"
    },
    "hljs-bullet": {
      color: "orange"
    },
    "hljs-selector-tag": {
      color: "orange"
    },
    "hljs-selector-id": {
      color: "orange"
    },
    "hljs-selector-class": {
      color: "orange"
    },
    "hljs-selector-attr": {
      color: "orange"
    },
    "hljs-selector-pseudo": {
      color: "orange"
    }
  },
  ansiLightColors,
  lightSemanticColors
);

// packages/cli/src/ui/themes/no-color.ts
init_esbuild_shims();
var noColorColorsTheme = {
  type: "ansi",
  Background: "",
  Foreground: "",
  LightBlue: "",
  AccentBlue: "",
  AccentPurple: "",
  AccentCyan: "",
  AccentGreen: "",
  AccentYellow: "",
  AccentRed: "",
  AccentYellowDim: "",
  AccentRedDim: "",
  DiffAdded: "",
  DiffRemoved: "",
  Comment: "",
  Gray: ""
};
var noColorSemanticColors = {
  text: {
    primary: "",
    secondary: "",
    link: "",
    accent: "",
    code: ""
  },
  background: {
    primary: "",
    diff: {
      added: "",
      removed: ""
    }
  },
  border: {
    default: "",
    focused: ""
  },
  ui: {
    comment: "",
    symbol: "",
    gradient: []
  },
  status: {
    error: "",
    success: "",
    warning: "",
    errorDim: "",
    warningDim: ""
  }
};
var NoColorTheme = new Theme(
  "NoColor",
  "dark",
  {
    hljs: {
      display: "block",
      overflowX: "auto",
      padding: "0.5em"
    },
    "hljs-keyword": {},
    "hljs-literal": {},
    "hljs-symbol": {},
    "hljs-name": {},
    "hljs-link": {
      textDecoration: "underline"
    },
    "hljs-built_in": {},
    "hljs-type": {},
    "hljs-number": {},
    "hljs-class": {},
    "hljs-string": {},
    "hljs-meta-string": {},
    "hljs-regexp": {},
    "hljs-template-tag": {},
    "hljs-subst": {},
    "hljs-function": {},
    "hljs-title": {},
    "hljs-params": {},
    "hljs-formula": {},
    "hljs-comment": {
      fontStyle: "italic"
    },
    "hljs-quote": {
      fontStyle: "italic"
    },
    "hljs-doctag": {},
    "hljs-meta": {},
    "hljs-meta-keyword": {},
    "hljs-tag": {},
    "hljs-variable": {},
    "hljs-template-variable": {},
    "hljs-attr": {},
    "hljs-attribute": {},
    "hljs-builtin-name": {},
    "hljs-section": {},
    "hljs-emphasis": {
      fontStyle: "italic"
    },
    "hljs-strong": {
      fontWeight: "bold"
    },
    "hljs-bullet": {},
    "hljs-selector-tag": {},
    "hljs-selector-id": {},
    "hljs-selector-class": {},
    "hljs-selector-attr": {},
    "hljs-selector-pseudo": {},
    "hljs-addition": {
      display: "inline-block",
      width: "100%"
    },
    "hljs-deletion": {
      display: "inline-block",
      width: "100%"
    }
  },
  noColorColorsTheme,
  noColorSemanticColors
);

// packages/cli/src/ui/themes/theme-manager.ts
import process2 from "node:process";

// packages/cli/src/ui/themes/detect-terminal-theme.ts
init_esbuild_shims();
import { execSync } from "node:child_process";
import process from "node:process";
var debugLogger2 = createDebugLogger("THEME_DETECT");
var OSC11_TIMEOUT_MS = 200;
function hexComponent(hex) {
  const max = 16 ** hex.length - 1;
  return parseInt(hex, 16) / max;
}
__name(hexComponent, "hexComponent");
function parseOscRgb(data) {
  const rgbMatch = /^rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i.exec(data);
  if (rgbMatch) {
    return {
      r: hexComponent(rgbMatch[1]),
      g: hexComponent(rgbMatch[2]),
      b: hexComponent(rgbMatch[3])
    };
  }
  const hashMatch = /^#([0-9a-f]+)$/i.exec(data);
  if (hashMatch && hashMatch[1].length % 3 === 0) {
    const hex = hashMatch[1];
    const n = hex.length / 3;
    return {
      r: hexComponent(hex.slice(0, n)),
      g: hexComponent(hex.slice(n, 2 * n)),
      b: hexComponent(hex.slice(2 * n))
    };
  }
  return void 0;
}
__name(parseOscRgb, "parseOscRgb");
function themeFromOscColor(data) {
  const rgb = parseOscRgb(data);
  if (!rgb) return void 0;
  const luminance = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
  return luminance > 0.5 ? "light" : "dark";
}
__name(themeFromOscColor, "themeFromOscColor");
function detectOsc11Theme() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.resolve(void 0);
  }
  return new Promise((resolve2) => {
    const stdin = process.stdin;
    let resolved = false;
    let buffer = "";
    const finish = /* @__PURE__ */ __name((result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      stdin.removeListener("data", onData);
      resolve2(result);
    }, "finish");
    const timer = setTimeout(() => finish(void 0), OSC11_TIMEOUT_MS);
    const onData = /* @__PURE__ */ __name((data) => {
      buffer += data.toString();
      const match = /\x1b\]11;(.*?)(?:\x07|\x1b\\)/.exec(buffer);
      if (match) {
        finish(themeFromOscColor(match[1]));
      }
    }, "onData");
    stdin.on("data", onData);
    process.stdout.write("\x1B]11;?\x07");
  });
}
__name(detectOsc11Theme, "detectOsc11Theme");
function detectMacOSTheme() {
  if (process.platform !== "darwin") {
    return void 0;
  }
  try {
    const result = execSync("defaults read -g AppleInterfaceStyle", {
      encoding: "utf-8",
      timeout: 3e3,
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
    return result.toLowerCase() === "dark" ? "dark" : "light";
  } catch (error) {
    const err = error;
    const stderr = typeof err.stderr === "string" ? err.stderr : err.stderr?.toString?.() ?? "";
    const message = err.message ?? "";
    if (/does not exist/i.test(stderr) || /does not exist/i.test(message)) {
      return "light";
    }
    return void 0;
  }
}
__name(detectMacOSTheme, "detectMacOSTheme");
function detectFromColorFgBg() {
  const colorFgBg = process.env["COLORFGBG"];
  if (!colorFgBg) {
    return void 0;
  }
  const parts = colorFgBg.split(";");
  const bgStr = parts[parts.length - 1];
  if (bgStr === void 0) {
    return void 0;
  }
  const bg = parseInt(bgStr, 10);
  if (isNaN(bg)) {
    return void 0;
  }
  if (bg === 7 || bg >= 9 && bg <= 15) {
    return "light";
  }
  return "dark";
}
__name(detectFromColorFgBg, "detectFromColorFgBg");
function detectTerminalTheme() {
  const colorFgBgResult = detectFromColorFgBg();
  if (colorFgBgResult) {
    debugLogger2.info(`Detected theme from COLORFGBG: ${colorFgBgResult}`);
    return colorFgBgResult;
  }
  const macResult = detectMacOSTheme();
  if (macResult) {
    debugLogger2.info(
      `Detected theme from macOS system appearance: ${macResult}`
    );
    return macResult;
  }
  debugLogger2.info("Could not detect terminal theme, defaulting to dark");
  return "dark";
}
__name(detectTerminalTheme, "detectTerminalTheme");
async function detectTerminalThemeAsync() {
  const colorFgBgResult = detectFromColorFgBg();
  if (colorFgBgResult) {
    debugLogger2.info(
      `Detected theme from COLORFGBG (async path): ${colorFgBgResult}`
    );
    return colorFgBgResult;
  }
  const osc11Result = await detectOsc11Theme();
  if (osc11Result) {
    debugLogger2.info(
      `Detected theme from OSC 11 background query: ${osc11Result}`
    );
    return osc11Result;
  }
  const macResult = detectMacOSTheme();
  if (macResult) {
    debugLogger2.info(
      `Detected theme from macOS system appearance: ${macResult}`
    );
    return macResult;
  }
  debugLogger2.info("Could not detect terminal theme, defaulting to dark");
  return "dark";
}
__name(detectTerminalThemeAsync, "detectTerminalThemeAsync");

// packages/cli/src/ui/themes/theme-manager.ts
var debugLogger3 = createDebugLogger("THEME_MANAGER");
var DEFAULT_THEME = QwenDark;
var AUTO_THEME_NAME = "auto";
function isPathWithinDirectory(parent, child) {
  const relativePath = path.relative(parent, child);
  return relativePath === "" || !relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath);
}
__name(isPathWithinDirectory, "isPathWithinDirectory");
var ThemeManager = class {
  static {
    __name(this, "ThemeManager");
  }
  availableThemes;
  activeTheme;
  customThemes = /* @__PURE__ */ new Map();
  constructor() {
    this.availableThemes = [
      AyuDark,
      AyuLight,
      AtomOneDark,
      Dracula,
      DefaultLight,
      DefaultDark,
      GitHubDark,
      GitHubLight,
      GoogleCode,
      QwenLight,
      QwenDark,
      ShadesOfPurple,
      XCode,
      ANSI,
      ANSILight
    ];
    this.activeTheme = DEFAULT_THEME;
  }
  /**
   * Loads custom themes from settings.
   * @param customThemesSettings Custom themes from settings.
   */
  loadCustomThemes(customThemesSettings) {
    this.customThemes.clear();
    if (!customThemesSettings) {
      return;
    }
    for (const [name, customThemeConfig] of Object.entries(
      customThemesSettings
    )) {
      const validation = validateCustomTheme(customThemeConfig);
      if (validation.isValid) {
        if (validation.warning) {
          debugLogger3.warn(`Theme "${name}": ${validation.warning}`);
        }
        const themeWithDefaults = {
          ...DEFAULT_THEME.colors,
          ...customThemeConfig,
          name: customThemeConfig.name || name,
          type: "custom"
        };
        try {
          const theme = createCustomTheme(themeWithDefaults);
          this.customThemes.set(name, theme);
        } catch (error) {
          debugLogger3.warn(`Failed to load custom theme "${name}":`, error);
        }
      } else {
        debugLogger3.warn(`Invalid custom theme "${name}": ${validation.error}`);
      }
    }
    if (this.activeTheme && this.activeTheme.type === "custom" && this.customThemes.has(this.activeTheme.name)) {
      this.activeTheme = this.customThemes.get(this.activeTheme.name);
    }
  }
  /**
   * Sets the active theme.
   * @param themeName The name of the theme to set as active.
   *   If themeName is 'auto', detects the terminal theme and selects
   *   Qwen Dark or Qwen Light accordingly.
   * @returns True if the theme was successfully set, false otherwise.
   */
  setActiveTheme(themeName) {
    if (themeName === AUTO_THEME_NAME) {
      this.activeTheme = this.resolveAutoTheme();
      debugLogger3.info(`Auto-detected theme: ${this.activeTheme.name}`);
      return true;
    }
    const theme = this.findThemeByName(themeName);
    if (!theme) {
      return false;
    }
    this.activeTheme = theme;
    return true;
  }
  /**
   * Cached auto-detection result. Populated by the async probe at startup
   * (which includes OSC 11) and reused by subsequent sync resolutions so
   * reselecting Auto in the /theme dialog never contradicts what was shown
   * when the app first rendered.
   */
  cachedAutoDetection;
  /**
   * Memoised synchronous detection of the terminal's background brightness,
   * used when no async OSC 11 result is available (e.g. an explicitly
   * configured theme, for which the startup probe never runs). Detected at
   * most once per process.
   */
  terminalBackground;
  /**
   * Detects the terminal's dark/light preference (synchronous) and returns
   * the corresponding Qwen theme.
   * Used by the theme dialog for instant preview. Prefers the cached
   * async-detected value when available so we stay consistent with the
   * OSC 11 probe performed at startup.
   */
  resolveAutoTheme() {
    const detected = this.cachedAutoDetection ?? detectTerminalTheme();
    return detected === "light" ? QwenLight : QwenDark;
  }
  /**
   * Asynchronous auto-detection that includes an OSC 11 probe.
   * Intended for startup where a short async delay (~200 ms) is acceptable.
   * The resolved value is cached so later sync resolutions (e.g. the /theme
   * dialog reselecting Auto) stay in sync with what the probe detected.
   */
  async resolveAutoThemeAsync() {
    const detected = await detectTerminalThemeAsync();
    this.cachedAutoDetection = detected;
    this.activeTheme = detected === "light" ? QwenLight : QwenDark;
    debugLogger3.info(`Auto-detected theme (async): ${this.activeTheme.name}`);
  }
  /**
   * Returns the terminal's detected background brightness ('dark' | 'light').
   *
   * Prefers the accurate async OSC 11 result captured at startup (for 'auto'
   * themes); otherwise falls back to a memoised synchronous heuristic
   * (COLORFGBG → macOS appearance → default dark). Lets UI code decide whether
   * the active theme's background matches the terminal without re-probing.
   */
  getTerminalBackgroundType() {
    if (this.cachedAutoDetection) {
      return this.cachedAutoDetection;
    }
    this.terminalBackground ??= detectTerminalTheme();
    return this.terminalBackground;
  }
  /**
   * Gets the currently active theme.
   * @returns The active theme.
   */
  getActiveTheme() {
    if (process2.env["NO_COLOR"]) {
      return NoColorTheme;
    }
    if (this.activeTheme) {
      const isBuiltIn = this.availableThemes.some(
        (t) => t.name === this.activeTheme.name
      );
      const isCustom = [...this.customThemes.values()].includes(
        this.activeTheme
      );
      if (isBuiltIn || isCustom) {
        return this.activeTheme;
      }
    }
    this.activeTheme = DEFAULT_THEME;
    return this.activeTheme;
  }
  /**
   * Gets the semantic colors for the active theme.
   * @returns The semantic colors.
   */
  getSemanticColors() {
    return this.getActiveTheme().semanticColors;
  }
  /**
   * Gets a list of custom theme names.
   * @returns Array of custom theme names.
   */
  getCustomThemeNames() {
    return Array.from(this.customThemes.keys());
  }
  /**
   * Checks if a theme name is a custom theme.
   * @param themeName The theme name to check.
   * @returns True if the theme is custom.
   */
  isCustomTheme(themeName) {
    return this.customThemes.has(themeName);
  }
  /**
   * Returns a list of available theme names.
   */
  getAvailableThemes() {
    const builtInThemes = this.availableThemes.map((theme) => ({
      name: theme.name,
      type: theme.type,
      isCustom: false
    }));
    const customThemes = Array.from(this.customThemes.values()).map(
      (theme) => ({
        name: theme.name,
        type: theme.type,
        isCustom: true
      })
    );
    const qwenThemes = builtInThemes.filter(
      (theme) => theme.name === QwenLight.name || theme.name === QwenDark.name
    );
    const otherBuiltInThemes = builtInThemes.filter(
      (theme) => theme.name !== QwenLight.name && theme.name !== QwenDark.name
    );
    const sortedOtherThemes = [...otherBuiltInThemes, ...customThemes].sort(
      (a, b) => {
        const typeOrder = /* @__PURE__ */ __name((type) => {
          switch (type) {
            case "dark":
              return 1;
            case "light":
              return 2;
            case "ansi":
              return 3;
            case "custom":
              return 4;
            // Custom themes at the end
            default:
              return 5;
          }
        }, "typeOrder");
        const typeComparison = typeOrder(a.type) - typeOrder(b.type);
        if (typeComparison !== 0) {
          return typeComparison;
        }
        return a.name.localeCompare(b.name);
      }
    );
    return [...qwenThemes, ...sortedOtherThemes];
  }
  /**
   * Gets a theme by name.
   * @param themeName The name of the theme to get.
   * @returns The theme if found, undefined otherwise.
   */
  getTheme(themeName) {
    return this.findThemeByName(themeName);
  }
  isPath(themeName) {
    return themeName.endsWith(".json") || themeName.startsWith(".") || path.isAbsolute(themeName);
  }
  loadThemeFromFile(themePath) {
    try {
      const canonicalPath = fs.realpathSync(path.resolve(themePath));
      if (this.customThemes.has(canonicalPath)) {
        return this.customThemes.get(canonicalPath);
      }
      const homeDir = path.resolve(os.homedir());
      if (!isPathWithinDirectory(homeDir, canonicalPath)) {
        debugLogger3.warn(
          `Theme file at "${themePath}" is outside your home directory. Only load themes from trusted sources.`
        );
        return void 0;
      }
      const themeContent = fs.readFileSync(canonicalPath, "utf-8");
      const customThemeConfig = JSON.parse(themeContent);
      const validation = validateCustomTheme(customThemeConfig);
      if (!validation.isValid) {
        debugLogger3.warn(
          `Invalid custom theme from file "${themePath}": ${validation.error}`
        );
        return void 0;
      }
      if (validation.warning) {
        debugLogger3.warn(`Theme from "${themePath}": ${validation.warning}`);
      }
      const themeWithDefaults = {
        ...DEFAULT_THEME.colors,
        ...customThemeConfig,
        name: customThemeConfig.name || canonicalPath,
        type: "custom"
      };
      const theme = createCustomTheme(themeWithDefaults);
      this.customThemes.set(canonicalPath, theme);
      return theme;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        debugLogger3.warn(
          `Could not load theme from file "${themePath}":`,
          error
        );
      }
      return void 0;
    }
  }
  findThemeByName(themeName) {
    if (!themeName) {
      return DEFAULT_THEME;
    }
    const builtInTheme = this.availableThemes.find(
      (theme) => theme.name === themeName
    );
    if (builtInTheme) {
      return builtInTheme;
    }
    if (this.isPath(themeName)) {
      return this.loadThemeFromFile(themeName);
    }
    if (this.customThemes.has(themeName)) {
      return this.customThemes.get(themeName);
    }
    return void 0;
  }
};
var themeManager = new ThemeManager();

export {
  resolveColor,
  DEFAULT_THEME,
  AUTO_THEME_NAME,
  themeManager
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
