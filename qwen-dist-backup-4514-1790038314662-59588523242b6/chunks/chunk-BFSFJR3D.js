// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/nonInteractive/permission-suggestions.ts
init_esbuild_shims();
function withWarnings(description, details) {
  const warnings = Array.isArray(details["warnings"]) ? details["warnings"].filter(
    (warning) => typeof warning === "string"
  ) : [];
  return warnings.length > 0 ? `${warnings.join("\n")}
${description}` : description;
}
__name(withWarnings, "withWarnings");
function buildPermissionSuggestions(confirmationDetails) {
  if (!confirmationDetails || typeof confirmationDetails !== "object" || !("type" in confirmationDetails)) {
    return null;
  }
  const details = confirmationDetails;
  const type = String(details["type"] ?? "");
  const title = typeof details["title"] === "string" ? details["title"] : void 0;
  switch (type) {
    case "exec":
      return [
        {
          type: "allow",
          label: "Allow Command",
          description: withWarnings(`Execute: ${details["command"]}`, details)
        },
        {
          type: "deny",
          label: "Deny",
          description: "Block this command execution"
        }
      ];
    case "edit":
      return [
        {
          type: "allow",
          label: "Allow Edit",
          description: withWarnings(
            `Edit file: ${details["fileName"]}`,
            details
          )
        },
        {
          type: "deny",
          label: "Deny",
          description: "Block this file edit"
        },
        ...details["hideModify"] === true ? [] : [
          {
            type: "modify",
            label: "Review Changes",
            description: "Review the proposed changes before applying"
          }
        ]
      ];
    case "plan":
      return [
        {
          type: "allow",
          label: "Approve Plan",
          description: title || "Execute the proposed plan"
        },
        {
          type: "deny",
          label: "Reject Plan",
          description: "Do not execute this plan"
        }
      ];
    case "mcp":
      return [
        {
          type: "allow",
          label: "Allow MCP Call",
          description: `${details["serverName"]}: ${details["toolName"]}`
        },
        {
          type: "deny",
          label: "Deny",
          description: "Block this MCP server call"
        }
      ];
    case "info":
      return [
        {
          type: "allow",
          label: "Allow Info Request",
          description: title || "Allow information request"
        },
        {
          type: "deny",
          label: "Deny",
          description: "Block this information request"
        }
      ];
    default:
      return [
        {
          type: "allow",
          label: "Allow",
          description: title || `Allow ${type} operation`
        },
        {
          type: "deny",
          label: "Deny",
          description: `Block ${type} operation`
        }
      ];
  }
}
__name(buildPermissionSuggestions, "buildPermissionSuggestions");

export {
  buildPermissionSuggestions
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
