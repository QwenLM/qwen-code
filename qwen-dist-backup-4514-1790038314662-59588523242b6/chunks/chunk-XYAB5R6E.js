// Force strict mode and setup for ESM
"use strict";
import {
  theme
} from "./chunk-3NHJLWOD.js";
import {
  require_jsx_runtime
} from "./chunk-SV5PQVQE.js";
import {
  Box_default,
  Text
} from "./chunk-ZTBP4SFC.js";
import {
  require_react
} from "./chunk-5QWWOFGG.js";
import {
  toCodePoints
} from "./chunk-47ECGEJC.js";
import {
  stringWidth
} from "./chunk-2MIN6GRR.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/ui/components/shared/MaxSizedBox.tsx
init_esbuild_shims();
var import_react2 = __toESM(require_react(), 1);

// packages/cli/src/ui/contexts/OverflowContext.tsx
init_esbuild_shims();
var import_react = __toESM(require_react(), 1);
var import_jsx_runtime = __toESM(require_jsx_runtime(), 1);
var OverflowStateContext = (0, import_react.createContext)(
  void 0
);
var OverflowActionsContext = (0, import_react.createContext)(
  void 0
);
var useOverflowState = /* @__PURE__ */ __name(() => (0, import_react.useContext)(OverflowStateContext), "useOverflowState");
var useOverflowActions = /* @__PURE__ */ __name(() => (0, import_react.useContext)(OverflowActionsContext), "useOverflowActions");
var OverflowProvider = /* @__PURE__ */ __name(({
  children
}) => {
  const [overflowingIds, setOverflowingIds] = (0, import_react.useState)(/* @__PURE__ */ new Set());
  const addOverflowingId = (0, import_react.useCallback)((id) => {
    setOverflowingIds((prevIds) => {
      if (prevIds.has(id)) {
        return prevIds;
      }
      const newIds = new Set(prevIds);
      newIds.add(id);
      return newIds;
    });
  }, []);
  const removeOverflowingId = (0, import_react.useCallback)((id) => {
    setOverflowingIds((prevIds) => {
      if (!prevIds.has(id)) {
        return prevIds;
      }
      const newIds = new Set(prevIds);
      newIds.delete(id);
      return newIds;
    });
  }, []);
  const stateValue = (0, import_react.useMemo)(
    () => ({
      overflowingIds
    }),
    [overflowingIds]
  );
  const actionsValue = (0, import_react.useMemo)(
    () => ({
      addOverflowingId,
      removeOverflowingId
    }),
    [addOverflowingId, removeOverflowingId]
  );
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(OverflowStateContext.Provider, { value: stateValue, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(OverflowActionsContext.Provider, { value: actionsValue, children }) });
}, "OverflowProvider");

// packages/cli/src/ui/components/shared/MaxSizedBox.tsx
var import_jsx_runtime2 = __toESM(require_jsx_runtime(), 1);
var enableDebugLog = false;
var debugLogger = createDebugLogger("MAX_SIZED_BOX");
var MINIMUM_MAX_HEIGHT = 2;
function setMaxSizedBoxDebugging(value) {
  enableDebugLog = value;
}
__name(setMaxSizedBoxDebugging, "setMaxSizedBoxDebugging");
function debugReportError(message, element) {
  if (!enableDebugLog) return;
  if (!import_react2.default.isValidElement(element)) {
    debugLogger.error(
      message,
      `Invalid element: '${String(element)}' typeof=${typeof element}`
    );
    return;
  }
  let sourceMessage = "<Unknown file>";
  try {
    const elementWithSource = element;
    const fileName = elementWithSource._source?.fileName;
    const lineNumber = elementWithSource._source?.lineNumber;
    sourceMessage = fileName ? `${fileName}:${lineNumber}` : "<Unknown file>";
  } catch (error) {
    debugLogger.error("Error while trying to get file name:", error);
  }
  debugLogger.error(
    message,
    `${String(element.type)}. Source: ${sourceMessage}`
  );
}
__name(debugReportError, "debugReportError");
var MaxSizedBox = /* @__PURE__ */ __name(({
  children,
  maxWidth,
  maxHeight,
  overflowDirection = "top",
  additionalHiddenLinesCount = 0,
  sourceBoundaries,
  registerOverflow = true
}) => {
  const id = (0, import_react2.useId)();
  const { addOverflowingId, removeOverflowingId } = useOverflowActions() || {};
  const laidOutStyledText = [];
  const lineMetadata = /* @__PURE__ */ new Map();
  let rowIndex = 0;
  let sourceBoundaryIndex = 0;
  const targetMaxHeight = Math.max(
    Math.round(maxHeight ?? Number.MAX_SAFE_INTEGER),
    MINIMUM_MAX_HEIGHT
  );
  if (maxWidth === void 0) {
    throw new Error("maxWidth must be defined when maxHeight is set.");
  }
  function visitRows(element) {
    if (!import_react2.default.isValidElement(element)) {
      return;
    }
    if (element.type === import_react2.Fragment) {
      import_react2.default.Children.forEach(element.props.children, visitRows);
      return;
    }
    if (element.type === Box_default) {
      layoutInkElementAsStyledText(
        element,
        maxWidth,
        laidOutStyledText,
        lineMetadata,
        `${id}:${rowIndex++}`,
        () => sourceBoundaries?.[sourceBoundaryIndex++]
      );
      return;
    }
    debugReportError("MaxSizedBox children must be <Box> elements", element);
  }
  __name(visitRows, "visitRows");
  import_react2.default.Children.forEach(children, visitRows);
  const contentWillOverflow = targetMaxHeight !== void 0 && laidOutStyledText.length > targetMaxHeight || additionalHiddenLinesCount > 0;
  const visibleContentHeight = contentWillOverflow && targetMaxHeight !== void 0 ? targetMaxHeight - 1 : targetMaxHeight;
  const hiddenLinesCount = visibleContentHeight !== void 0 ? Math.max(0, laidOutStyledText.length - visibleContentHeight) : 0;
  const totalHiddenLines = hiddenLinesCount + additionalHiddenLinesCount;
  (0, import_react2.useEffect)(() => {
    if (registerOverflow && totalHiddenLines > 0) {
      addOverflowingId?.(id);
    } else {
      removeOverflowingId?.(id);
    }
    return () => {
      removeOverflowingId?.(id);
    };
  }, [
    id,
    registerOverflow,
    totalHiddenLines,
    addOverflowingId,
    removeOverflowingId
  ]);
  const visibleStyledText = hiddenLinesCount > 0 ? overflowDirection === "top" ? laidOutStyledText.slice(hiddenLinesCount, laidOutStyledText.length) : laidOutStyledText.slice(0, visibleContentHeight) : laidOutStyledText;
  const visibleLines = visibleStyledText.map((line, index) => {
    const metadata = lineMetadata.get(line);
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Box_default, { flexShrink: 0, children: line.length > 0 ? line.map((segment, segIndex) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      Text,
      {
        ...segment.props,
        selectionFlow: metadata.flowKey,
        selectionBreakAfter: metadata.breakAfter,
        selectionJoiner: metadata.joiner,
        children: segment.text
      },
      segIndex
    )) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      Text,
      {
        selectable: false,
        selectionFlow: metadata.flowKey,
        selectionBreakAfter: metadata.breakAfter,
        selectionJoiner: metadata.joiner,
        children: " "
      }
    ) }, index);
  });
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(Box_default, { flexDirection: "column", width: maxWidth, flexShrink: 0, children: [
    totalHiddenLines > 0 && overflowDirection === "top" && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(Text, { color: theme.text.secondary, wrap: "truncate", children: [
      "... first ",
      totalHiddenLines,
      " line",
      totalHiddenLines === 1 ? "" : "s",
      " ",
      "hidden ..."
    ] }),
    visibleLines,
    totalHiddenLines > 0 && overflowDirection === "bottom" && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(Text, { color: theme.text.secondary, wrap: "truncate", children: [
      "... last ",
      totalHiddenLines,
      " line",
      totalHiddenLines === 1 ? "" : "s",
      " ",
      "hidden ..."
    ] })
  ] });
}, "MaxSizedBox");
function visitBoxRow(element) {
  if (!import_react2.default.isValidElement(element) || element.type !== Box_default) {
    debugReportError(
      `All children of MaxSizedBox must be <Box> elements`,
      element
    );
    return {
      noWrapSegments: [{ text: "<ERROR>", props: {} }],
      segments: []
    };
  }
  if (enableDebugLog) {
    const boxProps = element.props;
    let maxExpectedProps = 4;
    if (boxProps.children !== void 0) {
      maxExpectedProps += 1;
    }
    if (boxProps.flexDirection !== void 0 && boxProps.flexDirection !== "row") {
      debugReportError(
        'MaxSizedBox children must have flexDirection="row".',
        element
      );
    }
    if (Object.keys(boxProps).length > maxExpectedProps) {
      debugReportError(
        `Boxes inside MaxSizedBox must not have additional props. ${Object.keys(
          boxProps
        ).join(", ")}`,
        element
      );
    }
  }
  const row = {
    noWrapSegments: [],
    segments: []
  };
  let hasSeenWrapped = false;
  function visitRowChild(element2, parentProps) {
    if (element2 === null) {
      return;
    }
    if (typeof element2 === "string" || typeof element2 === "number") {
      const text = String(element2);
      if (!text) {
        return;
      }
      const segment = { text, props: parentProps ?? {} };
      if (parentProps === void 0 || parentProps["wrap"] === "wrap") {
        hasSeenWrapped = true;
        row.segments.push(segment);
      } else {
        if (!hasSeenWrapped) {
          row.noWrapSegments.push(segment);
        } else {
          row.segments.push(segment);
          debugReportError(
            "Text elements without wrapping cannot appear after elements with wrapping in the same row.",
            element2
          );
        }
      }
      return;
    }
    if (!import_react2.default.isValidElement(element2)) {
      debugReportError("Invalid element.", element2);
      return;
    }
    if (element2.type === import_react2.Fragment) {
      import_react2.default.Children.forEach(
        element2.props.children,
        (child) => visitRowChild(child, parentProps)
      );
      return;
    }
    if (element2.type !== Text) {
      debugReportError(
        "Children of a row Box must be <Text> elements.",
        element2
      );
      return;
    }
    const { children, ...currentProps } = element2.props;
    const mergedProps = parentProps === void 0 ? currentProps : { ...parentProps, ...currentProps };
    import_react2.default.Children.forEach(
      children,
      (child) => visitRowChild(child, mergedProps)
    );
  }
  __name(visitRowChild, "visitRowChild");
  import_react2.default.Children.forEach(
    element.props.children,
    (child) => visitRowChild(child, void 0)
  );
  return row;
}
__name(visitBoxRow, "visitBoxRow");
function layoutInkElementAsStyledText(element, maxWidth, output, lineMetadata, flowKey, nextSourceBoundary) {
  const pushOutput = /* @__PURE__ */ __name((line, breakAfter, joiner) => {
    output.push(line);
    lineMetadata.set(line, { flowKey, breakAfter, joiner });
  }, "pushOutput");
  const row = visitBoxRow(element);
  if (row.segments.length === 0 && row.noWrapSegments.length === 0) {
    pushOutput([], "hard", "\n");
    return;
  }
  const lines = [];
  const nonWrappingContent = [];
  let noWrappingWidth = 0;
  row.noWrapSegments.forEach((segment) => {
    nonWrappingContent.push(segment);
    noWrappingWidth += stringWidth(segment.text);
  });
  if (row.segments.length === 0) {
    const lines2 = [];
    let currentLine = [];
    nonWrappingContent.forEach((segment) => {
      const textLines = segment.text.split("\n");
      textLines.forEach((text, index) => {
        if (index > 0) {
          lines2.push(currentLine);
          currentLine = [];
        }
        if (text) {
          currentLine.push({ text, props: segment.props });
        }
      });
    });
    if (currentLine.length > 0 || nonWrappingContent.length > 0 && nonWrappingContent[nonWrappingContent.length - 1].text.endsWith("\n")) {
      lines2.push(currentLine);
    }
    for (const line of lines2) {
      pushOutput(line, "hard", "\n");
    }
    return;
  }
  const availableWidth = maxWidth - noWrappingWidth;
  if (availableWidth < 1) {
    const lines2 = [];
    let currentLine = [];
    let currentLineWidth = 0;
    for (const segment of nonWrappingContent) {
      const textLines = segment.text.split("\n");
      textLines.forEach((text, index) => {
        if (index > 0) {
          lines2.push(currentLine);
          currentLine = [];
          currentLineWidth = 0;
        }
        if (text) {
          const textWidth = stringWidth(text);
          if (index > 0 && textWidth > 0) {
            currentLine.push({ text: "\u2026", props: {} });
            currentLineWidth = stringWidth("\u2026");
          } else {
            const maxContentWidth = Math.max(0, maxWidth - stringWidth("\u2026"));
            if (textWidth <= maxContentWidth && currentLineWidth === 0) {
              currentLine.push({ text, props: segment.props });
              currentLineWidth += textWidth;
            } else {
              const codePoints = toCodePoints(text);
              let truncatedWidth = currentLineWidth;
              let sliceEndIndex = 0;
              for (const char of codePoints) {
                const charWidth = stringWidth(char);
                if (truncatedWidth + charWidth > maxContentWidth) {
                  break;
                }
                truncatedWidth += charWidth;
                sliceEndIndex++;
              }
              const slice = codePoints.slice(0, sliceEndIndex).join("");
              if (slice) {
                currentLine.push({ text: slice, props: segment.props });
              }
              currentLine.push({ text: "\u2026", props: {} });
              currentLineWidth = truncatedWidth + stringWidth("\u2026");
            }
          }
        }
      });
    }
    if (currentLine.length > 0 || nonWrappingContent.length > 0 && nonWrappingContent[nonWrappingContent.length - 1].text.endsWith("\n")) {
      lines2.push(currentLine);
    }
    if (lines2.length === 0) {
      lines2.push([{ text: "\u2026", props: {} }]);
    }
    for (const line of lines2) {
      pushOutput(line, "hard", "\n");
    }
    return;
  }
  let wrappingPart = [];
  let wrappingPartWidth = 0;
  function addWrappingPartToLines(breakAfter, joiner) {
    let line;
    if (lines.length === 0) {
      line = [...nonWrappingContent, ...wrappingPart];
    } else {
      if (noWrappingWidth > 0) {
        line = [
          ...[
            {
              text: " ".repeat(noWrappingWidth),
              props: { selectable: false }
            }
          ],
          ...wrappingPart
        ];
      } else {
        line = wrappingPart;
      }
    }
    lines.push(line);
    lineMetadata.set(line, { flowKey, breakAfter, joiner });
    wrappingPart = [];
    wrappingPartWidth = 0;
  }
  __name(addWrappingPartToLines, "addWrappingPartToLines");
  function addToWrappingPart(text, props) {
    if (wrappingPart.length > 0 && wrappingPart[wrappingPart.length - 1].props === props) {
      wrappingPart[wrappingPart.length - 1].text += text;
    } else {
      wrappingPart.push({ text, props });
    }
  }
  __name(addToWrappingPart, "addToWrappingPart");
  row.segments.forEach((segment) => {
    const linesFromSegment = segment.text.split("\n");
    linesFromSegment.forEach((lineText, lineIndex) => {
      if (lineIndex > 0) {
        const boundary = nextSourceBoundary() ?? {
          kind: "hard",
          joiner: "\n"
        };
        addWrappingPartToLines(boundary.kind, boundary.joiner);
      }
      const words = lineText.split(/(\s+)/);
      words.forEach((word) => {
        if (!word) return;
        const wordWidth = stringWidth(word);
        if (wrappingPartWidth + wordWidth > availableWidth && wrappingPartWidth > 0) {
          addWrappingPartToLines("soft", /^\s+$/u.test(word) ? word : "");
          if (/^\s+$/.test(word)) {
            return;
          }
        }
        if (wordWidth > availableWidth) {
          const wordAsCodePoints = toCodePoints(word);
          let remainingWordAsCodePoints = wordAsCodePoints;
          while (remainingWordAsCodePoints.length > 0) {
            let splitIndex = 0;
            let currentSplitWidth = 0;
            for (const char of remainingWordAsCodePoints) {
              const charWidth = stringWidth(char);
              if (wrappingPartWidth + currentSplitWidth + charWidth > availableWidth) {
                break;
              }
              currentSplitWidth += charWidth;
              splitIndex++;
            }
            if (splitIndex > 0) {
              const part = remainingWordAsCodePoints.slice(0, splitIndex).join("");
              addToWrappingPart(part, segment.props);
              wrappingPartWidth += stringWidth(part);
              remainingWordAsCodePoints = remainingWordAsCodePoints.slice(splitIndex);
            }
            if (remainingWordAsCodePoints.length > 0) {
              addWrappingPartToLines("soft", "");
            }
          }
        } else {
          addToWrappingPart(word, segment.props);
          wrappingPartWidth += wordWidth;
        }
      });
    });
    if (segment.text.endsWith("\n")) {
      addWrappingPartToLines("hard", "\n");
    }
  });
  if (wrappingPart.length > 0) {
    addWrappingPartToLines("hard", "\n");
  }
  for (const line of lines) {
    output.push(line);
  }
}
__name(layoutInkElementAsStyledText, "layoutInkElementAsStyledText");

export {
  useOverflowState,
  OverflowProvider,
  MINIMUM_MAX_HEIGHT,
  setMaxSizedBoxDebugging,
  MaxSizedBox
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
