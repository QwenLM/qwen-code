import type {
  ManagedSideQuery,
  ManagedSideQueryContext,
} from './managed-side-query-types';

export const sideQueryContext: ManagedSideQueryContext = {
  actorScopeKey: 'opaque-actor-a',
  contentVersion: 'v3',
  completedUserTurnCount: 3,
  mainInputBoundary: 3,
  automaticEligible: true,
  generationAvailable: true,
  unavailableReason: null,
  latestRecapContentVersion: null,
  latestRecapUserTurnCount: null,
};

export const sideQuery: ManagedSideQuery = {
  queryId: 'q1',
  sessionId: 's1',
  kind: 'btw',
  question: 'A private question',
  status: 'completed',
  outcome: 'success',
  resultRevision: 3,
  text: 'A private answer',
  trigger: 'manual',
  usage: null,
  errorCode: null,
  source: {
    journalRevision: 3,
    committedSequence: 30,
    lastCommitDigest: 'digest',
    completedTurnSequence: 30,
    contentVersion: 'v3',
    completedUserTurnCount: 3,
    mainInputBoundary: 3,
  },
  createdAt: 10,
  updatedAt: 20,
  deadlineAt: 300_010,
};
