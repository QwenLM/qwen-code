/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { useEffect, useState } from 'react';
import {
  readSubagentTranscript,
  TranscriptRepository,
  type Message,
  type WorkflowUnifiedTask,
} from '@qwen-code/core';
import type { WorkflowAgentView } from '../workflows/workflowPanelSelectors.js';
import { useConfig } from '../contexts/ConfigContext.js';

export interface WorkflowAgentTranscriptState {
  messages: Message[];
  loading: boolean;
  error?: string;
  source?: 'transcriptPath' | 'agentId' | 'manifest' | 'none';
}

interface StoredWorkflowAgentTranscriptState
  extends WorkflowAgentTranscriptState {
  transcriptKey: string;
}

interface WorkflowManifestAgentIndex {
  index: number;
  transcriptPath?: string;
  agentId?: string;
}

interface WorkflowManifestWithAgents {
  agents?: WorkflowManifestAgentIndex[];
}

export function useWorkflowAgentTranscript(params: {
  task: WorkflowUnifiedTask;
  agent: WorkflowAgentView | undefined;
}): WorkflowAgentTranscriptState {
  const { task, agent } = params;
  const config = useConfig();
  const sessionId = config.getSessionId();
  const sessionTranscriptPath = config.getActiveSessionTranscriptPath();
  const transcriptDir = task.transcriptDir;
  const agentIndex = agent?.index;
  const agentId = agent?.agentId;
  const transcriptPath = agent?.transcriptPath;
  const transcriptKey = [
    sessionId,
    sessionTranscriptPath,
    transcriptDir,
    agentIndex ?? 'none',
    agentId ?? '',
    transcriptPath ?? '',
  ].join(':');
  const [state, setState] = useState<StoredWorkflowAgentTranscriptState>({
    messages: [],
    loading: false,
    source: 'none',
    transcriptKey,
  });

  useEffect(() => {
    if (agentIndex === undefined) {
      setState({
        messages: [],
        loading: false,
        source: 'none',
        transcriptKey,
      });
      return;
    }

    let cancelled = false;
    setState((previous) =>
      previous.transcriptKey === transcriptKey
        ? { ...previous, loading: true, error: undefined }
        : {
            messages: [],
            loading: true,
            source: 'none',
            transcriptKey,
          },
    );

    void loadWorkflowAgentTranscript({
      sessionId,
      sessionTranscriptPath,
      transcriptDir,
      agentIndex,
      agentId,
      transcriptPath,
    })
      .then((next) => {
        if (cancelled) return;
        setState({ ...next, transcriptKey });
      })
      .catch((error) => {
        if (cancelled) return;
        setState({
          messages: [],
          loading: false,
          error: error instanceof Error ? error.message : String(error),
          source: 'none',
          transcriptKey,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    agentId,
    agentIndex,
    sessionId,
    sessionTranscriptPath,
    transcriptDir,
    transcriptKey,
    transcriptPath,
  ]);

  return state.transcriptKey === transcriptKey
    ? state
    : {
        messages: [],
        loading: agentIndex !== undefined,
        source: 'none',
      };
}

async function loadWorkflowAgentTranscript(params: {
  sessionId: string;
  sessionTranscriptPath: string;
  transcriptDir: string;
  agentIndex: number;
  agentId?: string;
  transcriptPath?: string;
}): Promise<WorkflowAgentTranscriptState> {
  if (params.transcriptPath) {
    return {
      messages: await readTranscriptPath(params.transcriptPath),
      loading: false,
      source: 'transcriptPath',
    };
  }

  if (params.agentId) {
    const transcript = await readSubagentTranscript(
      { sessionTranscriptPath: params.sessionTranscriptPath },
      params.sessionId,
      params.agentId,
    );
    return {
      messages: transcript?.messages ?? [],
      loading: false,
      source: 'agentId',
    };
  }

  const manifestAgent = await readManifestAgent(
    params.transcriptDir,
    params.agentIndex,
  );
  if (manifestAgent?.transcriptPath) {
    return {
      messages: await readTranscriptPath(manifestAgent.transcriptPath),
      loading: false,
      source: 'manifest',
    };
  }
  if (manifestAgent?.agentId) {
    const transcript = await readSubagentTranscript(
      { sessionTranscriptPath: params.sessionTranscriptPath },
      params.sessionId,
      manifestAgent.agentId,
    );
    return {
      messages: transcript?.messages ?? [],
      loading: false,
      source: 'manifest',
    };
  }

  return { messages: [], loading: false, source: 'none' };
}

async function readManifestAgent(
  transcriptDir: string,
  agentIndex: number,
): Promise<WorkflowManifestAgentIndex | undefined> {
  const manifestPath = path.join(transcriptDir, 'manifest.json');
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (error) {
    if (isFileNotFoundError(error)) return undefined;
    throw error;
  }
  const manifest = JSON.parse(raw) as WorkflowManifestWithAgents;
  return manifest.agents?.find((agent) => agent.index === agentIndex);
}

async function readTranscriptPath(filePath: string): Promise<Message[]> {
  const session = await new TranscriptRepository().resolveSession(filePath);
  return [...(session?.messages ?? [])];
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
