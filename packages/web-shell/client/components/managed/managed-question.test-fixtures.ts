import type { ManagedAgentPendingQuestionAction } from './managed-agent-provider';

export function pendingQuestion(): ManagedAgentPendingQuestionAction {
  return {
    kind: 'question',
    actionId: 'tool_approval_question',
    sessionId: 'session-1',
    turnId: 'turn-1',
    functionCallId: 'call-1',
    toolName: 'ask_user_question',
    inputRevision: 1,
    policyRevision: 'hosted-user-question/1',
    expiresAt: Date.now() + 600_000,
    questions: [
      {
        id: 'q1',
        prompt: 'Choose the library',
        required: true,
        multiple: false,
        allowText: true,
        options: [
          { id: 'q1o1', label: 'Same, label', description: 'First library' },
          { id: 'q1o2', label: 'Same, label', description: 'Second library' },
        ],
      },
      {
        id: 'q2',
        prompt: 'Choose the features',
        required: true,
        multiple: true,
        allowText: true,
        options: [
          { id: 'q2o1', label: 'Read, write', description: 'File access' },
          { id: 'q2o2', label: 'Search', description: 'Code lookup' },
        ],
      },
    ],
  };
}
