// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/local-bind-addresses.ts
init_esbuild_shims();
import { networkInterfaces } from "node:os";
function bareAddress(hostname) {
  const unbracketed = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const decoded = unbracketed.replace(/%25/gi, "%");
  const zoneAt = decoded.indexOf("%");
  return (zoneAt === -1 ? decoded : decoded.slice(0, zoneAt)).toLowerCase();
}
__name(bareAddress, "bareAddress");
function isOwnInterfaceAddress(hostname) {
  const target = bareAddress(hostname);
  if (target === "") return false;
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.address.toLowerCase() === target) return true;
    }
  }
  return false;
}
__name(isOwnInterfaceAddress, "isOwnInterfaceAddress");
function hostAssignsIpv6Loopback(interfaces = networkInterfaces()) {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv6" && entry.address === "::1") return true;
    }
  }
  return false;
}
__name(hostAssignsIpv6Loopback, "hostAssignsIpv6Loopback");

export {
  isOwnInterfaceAddress,
  hostAssignsIpv6Loopback
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
