/**
 * Incident Response Workflow Sample
 * A complete production incident response flow demonstrating cross-service orchestration
 */

import type { ActivityItem, ResponseContent } from '@craft-agent/ui'
import { nativeToolIcons, sourceIcons, internalIcons } from '../sample-icons'

const now = Date.now()

// Activity 1: Sentry - Fetch error details
const sentryFetchError: ActivityItem = {
  id: 'incident-1',
  type: 'tool',
  status: 'completed',
  toolName: 'mcp__sentry__sentry_get_issue',
  toolInput: {
    issue_id: 'PROD-4521',
    _intent: 'Fetching error details and stack trace for authentication failure',
    _displayName: 'Get Issue Details',
  },
  intent: 'Fetching error details and stack trace for authentication failure',
  displayName: 'Get Issue Details',
  toolDisplayMeta: {
    displayName: 'Sentry',
    category: 'source',
    iconDataUrl: sourceIcons.sentry,
  },
  timestamp: now - 60000,
}

// Activity 2: Slack - Post incident alert
const slackPostAlert: ActivityItem = {
  id: 'incident-2',
  type: 'tool',
  status: 'completed',
  toolName: 'mcp__slack__slack_send_message',
  toolInput: {
    channel: '#incidents',
    text: '🚨 P1 Incident: Auth service returning 500 errors - investigating',
    _intent: 'Alerting the engineering team about the production incident',
    _displayName: 'Post Alert',
  },
  intent: 'Alerting the engineering team about the production incident',
  displayName: 'Post Alert',
  toolDisplayMeta: {
    displayName: 'Slack',
    category: 'source',
    iconDataUrl: sourceIcons.slack,
  },
  timestamp: now - 55000,
}

// Activity 3: Read - Examine error file from stack trace
const readErrorFile: ActivityItem = {
  id: 'incident-3',
  type: 'tool',
  status: 'completed',
  toolName: 'Read',
  toolInput: { file_path: '/src/services/auth/jwt-validator.ts' },
  timestamp: now - 50000,
}

// Activity 4: Grep - Search for related error patterns
const grepErrorPattern: ActivityItem = {
  id: 'incident-4',
  type: 'tool',
  status: 'completed',
  toolName: 'Grep',
  toolInput: { pattern: 'TokenExpiredError', path: 'src/' },
  intent: 'Searching for all occurrences of TokenExpiredError handling',
  timestamp: now - 45000,
}

// Activity 5: Read - Check configuration
const readConfig: ActivityItem = {
  id: 'incident-5',
  type: 'tool',
  status: 'completed',
  toolName: 'Read',
  toolInput: { file_path: '/config/jwt-config.json' },
  timestamp: now - 40000,
}

// Activity 6: Edit - Apply hotfix
const editHotfix: ActivityItem = {
  id: 'incident-6',
  type: 'tool',
  status: 'completed',
  toolName: 'Edit',
  toolInput: {
    file_path: '/src/services/auth/jwt-validator.ts',
    old_string: 'const KEY_ROTATION_INTERVAL = 86400',
    new_string: 'const KEY_ROTATION_INTERVAL = 3600 // Reduced after incident PROD-4521',
  },
  timestamp: now - 35000,
}

// Activity 7: Bash (git) - Create hotfix branch
const gitCreateBranch: ActivityItem = {
  id: 'incident-7',
  type: 'tool',
  status: 'completed',
  toolName: 'Bash',
  toolInput: {
    command: 'git checkout -b hotfix/auth-key-rotation-4521',
    description: 'Creating hotfix branch for the authentication fix',
  },
  intent: 'Creating hotfix branch for the authentication fix',
  toolDisplayMeta: {
    displayName: 'Git',
    category: 'native',
    iconDataUrl: nativeToolIcons.git,
  },
  timestamp: now - 30000,
}

// Activity 8: Bash (npm) - Run tests
const npmRunTests: ActivityItem = {
  id: 'incident-8',
  type: 'tool',
  status: 'completed',
  toolName: 'Bash',
  toolInput: {
    command: 'npm test -- --testPathPattern=auth',
    description: 'Running authentication service tests',
  },
  intent: 'Running authentication service tests',
  toolDisplayMeta: {
    displayName: 'npm',
    category: 'native',
    iconDataUrl: nativeToolIcons.npm,
  },
  timestamp: now - 25000,
}

// Activity 9: Bash (git) - Commit and push
const gitCommitPush: ActivityItem = {
  id: 'incident-9',
  type: 'tool',
  status: 'completed',
  toolName: 'Bash',
  toolInput: {
    command: 'git add -A && git commit -m "fix: reduce JWT key rotation interval (PROD-4521)" && git push -u origin hotfix/auth-key-rotation-4521',
    description: 'Committing hotfix and pushing to remote',
  },
  intent: 'Committing hotfix and pushing to remote',
  toolDisplayMeta: {
    displayName: 'Git',
    category: 'native',
    iconDataUrl: nativeToolIcons.git,
  },
  timestamp: now - 20000,
}

// Activity 10: GitHub - Create pull request
const githubCreatePR: ActivityItem = {
  id: 'incident-10',
  type: 'tool',
  status: 'completed',
  toolName: 'Bash',
  toolInput: {
    command: 'gh pr create --title "fix: reduce JWT key rotation interval (PROD-4521)" --body "## Summary\\nHotfix for production incident PROD-4521\\n\\n## Changes\\n- Reduced key rotation from 24h to 1h" --label "hotfix,p1"',
    description: 'Creating pull request for the hotfix',
  },
  intent: 'Creating pull request for the hotfix',
  toolDisplayMeta: {
    displayName: 'GitHub',
    category: 'native',
    iconDataUrl: nativeToolIcons.github,
  },
  timestamp: now - 15000,
}

// Activity 11: Slack - Update with fix status
const slackUpdateStatus: ActivityItem = {
  id: 'incident-11',
  type: 'tool',
  status: 'completed',
  toolName: 'mcp__slack__slack_send_message',
  toolInput: {
    channel: '#incidents',
    text: '✅ Hotfix PR #1847 created and ready for review. Root cause: JWT signing key rotation interval too long.',
    _intent: 'Updating the team with fix status and PR link',
    _displayName: 'Update Status',
  },
  intent: 'Updating the team with fix status and PR link',
  displayName: 'Update Status',
  toolDisplayMeta: {
    displayName: 'Slack',
    category: 'source',
    iconDataUrl: sourceIcons.slack,
  },
  timestamp: now - 10000,
}

// Activity 12: Sentry - Mark issue as resolving
const sentryResolve: ActivityItem = {
  id: 'incident-12',
  type: 'tool',
  status: 'completed',
  toolName: 'mcp__sentry__sentry_update_issue',
  toolInput: {
    issue_id: 'PROD-4521',
    status: 'resolving',
    _intent: 'Marking the Sentry issue as resolving with PR reference',
    _displayName: 'Update Issue Status',
  },
  intent: 'Marking the Sentry issue as resolving with PR reference',
  displayName: 'Update Issue Status',
  toolDisplayMeta: {
    displayName: 'Sentry',
    category: 'source',
    iconDataUrl: sourceIcons.sentry,
  },
  timestamp: now - 5000,
}

export const incidentResponseActivities: ActivityItem[] = [
  sentryFetchError,
  slackPostAlert,
  readErrorFile,
  grepErrorPattern,
  readConfig,
  editHotfix,
  gitCreateBranch,
  npmRunTests,
  gitCommitPush,
  githubCreatePR,
  slackUpdateStatus,
  sentryResolve,
]

export const incidentResponseResponse: ResponseContent = {
  text: `## Incident Resolution Summary

### Issue
**PROD-4521**: Authentication service returning 500 errors affecting ~15% of login attempts.

### Root Cause
The JWT signing key rotation interval was set to 24 hours, but the key had expired mid-rotation due to a clock skew between services. This caused token validation failures for users with tokens signed by the expired key.

### Timeline
| Time | Action |
|------|--------|
| 08:15 | Alert triggered in Sentry |
| 08:17 | Incident posted to #incidents |
| 08:22 | Root cause identified in jwt-validator.ts |
| 08:25 | Hotfix implemented and tested |
| 08:28 | PR #1847 created and pushed |

### Changes Made
- Reduced \`KEY_ROTATION_INTERVAL\` from 24h to 1h in \`/src/services/auth/jwt-validator.ts\`
- Added comment documenting the incident reference

### Verification
- All 47 auth-related tests passing
- No new errors in Sentry since deployment

### Follow-up Actions
- [ ] Add monitoring for key rotation events
- [ ] Update runbook with this failure mode
- [ ] Schedule post-mortem for Monday 10am

The hotfix PR is ready for expedited review. Once merged and deployed, error rates should return to normal within 5 minutes.`,
  isStreaming: false,
}
