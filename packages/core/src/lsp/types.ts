/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspLocationWithServer extends LspLocation {
  serverName?: string;
}

export interface LspSymbolInformation {
  name: string;
  kind?: string;
  location: LspLocation;
  containerName?: string;
  serverName?: string;
}

export type LspReference = LspLocationWithServer;

export type LspDefinition = LspLocationWithServer;

export interface LspClient {
  workspaceSymbols(
    query: string,
    limit?: number,
  ): Promise<LspSymbolInformation[]>;
  definitions(
    location: LspLocation,
    serverName?: string,
    limit?: number,
  ): Promise<LspDefinition[]>;
  references(
    location: LspLocation,
    serverName?: string,
    includeDeclaration?: boolean,
    limit?: number,
  ): Promise<LspReference[]>;
}
