/**
 * Full-Stack Deployment Workflow Sample
 * Complete CI/CD pipeline from feature development to production
 */

import type { ActivityItem, ResponseContent } from '@craft-agent/ui'
import { nativeToolIcons, sourceIcons } from '../sample-icons'

const now = Date.now()

// Activity 1: Read - Feature specification
const readSpec: ActivityItem = {
  id: 'deploy-1',
  type: 'tool',
  status: 'completed',
  toolName: 'Read',
  toolInput: { file_path: '/docs/features/user-preferences-api.md' },
  timestamp: now - 120000,
}

// Activity 2: Git - Check branch status
const gitStatus: ActivityItem = {
  id: 'deploy-2',
  type: 'tool',
  status: 'completed',
  toolName: 'Bash',
  toolInput: {
    command: 'git status && git log --oneline -5',
    description: 'Checking current branch status and recent commits',
  },
  intent: 'Checking current branch status and recent commits',
  toolDisplayMeta: {
    displayName: 'Git',
    category: 'native',
    iconDataUrl: nativeToolIcons.git,
  },
  timestamp: now - 115000,
}

// Activity 3: Write - Create new API endpoint
const writeEndpoint: ActivityItem = {
  id: 'deploy-3',
  type: 'tool',
  status: 'completed',
  toolName: 'Write',
  toolInput: {
    file_path: '/src/api/routes/preferences.ts',
    content: '// User preferences API endpoint...',
  },
  timestamp: now - 110000,
}

// Activity 4: Edit - Update routing configuration
const editRoutes: ActivityItem = {
  id: 'deploy-4',
  type: 'tool',
  status: 'completed',
  toolName: 'Edit',
  toolInput: {
    file_path: '/src/api/index.ts',
    old_string: "// Route imports",
    new_string: "// Route imports\nimport { preferencesRouter } from './routes/preferences'",
  },
  timestamp: now - 105000,
}

// Activity 5: Write - Create React component
const writeComponent: ActivityItem = {
  id: 'deploy-5',
  type: 'tool',
  status: 'completed',
  toolName: 'Write',
  toolInput: {
    file_path: '/src/components/preferences/PreferencesPanel.tsx',
    content: '// React component for user preferences...',
  },
  timestamp: now - 100000,
}

// Activity 6: npm - Install new dependencies
const npmInstall: ActivityItem = {
  id: 'deploy-6',
  type: 'tool',
  status: 'completed',
  toolName: 'Bash',
  toolInput: {
    command: 'npm install @tanstack/react-query zod',
    description: 'Installing React Query and Zod for the new feature',
  },
  intent: 'Installing React Query and Zod for the new feature',
  toolDisplayMeta: {
    displayName: 'npm',
    category: 'native',
    iconDataUrl: nativeToolIcons.npm,
  },
  timestamp: now - 95000,
}

// Activity 7: Jest - Run unit tests
const jestTests: ActivityItem = {
  id: 'deploy-7',
  type: 'tool',
  status: 'completed',
  toolName: 'Bash',
  toolInput: {
    command: 'npm test -- --coverage --testPathPattern="preferences"',
    description: 'Running unit tests with coverage for preferences feature',
  },
  intent: 'Running unit tests with coverage for preferences feature',
  toolDisplayMeta: {
    displayName: 'Jest',
    category: 'native',
    iconDataUrl: nativeToolIcons.jest,
  },
  timestamp: now - 85000,
}

// Activity 8: ESLint - Lint check
const eslintCheck: ActivityItem = {
  id: 'deploy-8',
  type: 'tool',
  status: 'completed',
  toolName: 'Bash',
  toolInput: {
    command: 'npm run lint -- --fix',
    description: 'Running ESLint and auto-fixing issues',
  },
  intent: 'Running ESLint and auto-fixing issues',
  toolDisplayMeta: {
    displayName: 'ESLint',
    category: 'native',
    iconDataUrl: nativeToolIcons.eslint,
  },
  timestamp: now - 80000,
}

// Activity 9: Docker - Build container
const dockerBuild: ActivityItem = {
  id: 'deploy-9',
  type: 'tool',
  status: 'completed',
  toolName: 'Bash',
  toolInput: {
    command: 'docker build -t myapp:feature-preferences-v1.2.0 .',
    description: 'Building Docker container image for deployment',
  },
  intent: 'Building Docker container image for deployment',
  toolDisplayMeta: {
    displayName: 'Docker',
    category: 'native',
    iconDataUrl: nativeToolIcons.docker,
  },
  timestamp: now - 70000,
}

// Activity 10: Docker - Push to registry
const dockerPush: ActivityItem = {
  id: 'deploy-10',
  type: 'tool',
  status: 'completed',
  toolName: 'Bash',
  toolInput: {
    command: 'docker push gcr.io/myproject/myapp:feature-preferences-v1.2.0',
    description: 'Pushing container image to Google Container Registry',
  },
  intent: 'Pushing container image to Google Container Registry',
  toolDisplayMeta: {
    displayName: 'Docker',
    category: 'native',
    iconDataUrl: nativeToolIcons.docker,
  },
  timestamp: now - 60000,
}

// Activity 11: Kubernetes - Deploy to staging
const k8sDeployStaging: ActivityItem = {
  id: 'deploy-11',
  type: 'tool',
  status: 'completed',
  toolName: 'Bash',
  toolInput: {
    command: 'kubectl apply -f k8s/staging/ --namespace=staging && kubectl rollout status deployment/myapp -n staging',
    description: 'Deploying to staging cluster and waiting for rollout',
  },
  intent: 'Deploying to staging cluster and waiting for rollout',
  toolDisplayMeta: {
    displayName: 'Kubernetes',
    category: 'native',
    iconDataUrl: nativeToolIcons.kubernetes,
  },
  timestamp: now - 50000,
}

// Activity 12: Playwright - Run E2E tests
const playwrightE2E: ActivityItem = {
  id: 'deploy-12',
  type: 'tool',
  status: 'completed',
  toolName: 'mcp__playwright__playwright_navigate',
  toolInput: {
    url: 'https://staging.myapp.com/preferences',
    _intent: 'Running E2E tests against staging environment',
    _displayName: 'E2E Tests',
  },
  intent: 'Running E2E tests against staging environment',
  displayName: 'E2E Tests',
  toolDisplayMeta: {
    displayName: 'Playwright',
    category: 'source',
    iconDataUrl: sourceIcons.playwright,
  },
  timestamp: now - 40000,
}

// Activity 13: Terraform - Update infrastructure
const terraformApply: ActivityItem = {
  id: 'deploy-13',
  type: 'tool',
  status: 'completed',
  toolName: 'Bash',
  toolInput: {
    command: 'terraform plan -out=tfplan && terraform apply tfplan',
    description: 'Applying infrastructure changes for new API endpoint',
  },
  intent: 'Applying infrastructure changes for new API endpoint',
  toolDisplayMeta: {
    displayName: 'Terraform',
    category: 'native',
    iconDataUrl: nativeToolIcons.terraform,
  },
  timestamp: now - 30000,
}

// Activity 14: Kubernetes - Promote to production
const k8sDeployProd: ActivityItem = {
  id: 'deploy-14',
  type: 'tool',
  status: 'completed',
  toolName: 'Bash',
  toolInput: {
    command: 'kubectl apply -f k8s/production/ --namespace=production && kubectl rollout status deployment/myapp -n production',
    description: 'Deploying to production cluster',
  },
  intent: 'Deploying to production cluster',
  toolDisplayMeta: {
    displayName: 'Kubernetes',
    category: 'native',
    iconDataUrl: nativeToolIcons.kubernetes,
  },
  timestamp: now - 20000,
}

// Activity 15: Slack - Announce deployment
const slackAnnounce: ActivityItem = {
  id: 'deploy-15',
  type: 'tool',
  status: 'completed',
  toolName: 'mcp__slack__slack_send_message',
  toolInput: {
    channel: '#deployments',
    text: '🚀 v1.2.0 deployed to production - User Preferences API now live!',
    _intent: 'Announcing successful deployment to the team',
    _displayName: 'Announce Deployment',
  },
  intent: 'Announcing successful deployment to the team',
  displayName: 'Announce Deployment',
  toolDisplayMeta: {
    displayName: 'Slack',
    category: 'source',
    iconDataUrl: sourceIcons.slack,
  },
  timestamp: now - 10000,
}

// Activity 16: Gmail - Send release notes
const gmailRelease: ActivityItem = {
  id: 'deploy-16',
  type: 'tool',
  status: 'completed',
  toolName: 'mcp__gmail__api_gmail',
  toolInput: {
    path: 'gmail/v1/users/me/messages/send',
    method: 'POST',
    body: { to: 'stakeholders@company.com', subject: 'v1.2.0 Release Notes' },
    _intent: 'Sending release notes to stakeholders',
    _displayName: 'Send Release Notes',
  },
  intent: 'Sending release notes to stakeholders',
  displayName: 'Send Release Notes',
  toolDisplayMeta: {
    displayName: 'Gmail',
    category: 'source',
    iconDataUrl: sourceIcons.gmail,
  },
  timestamp: now - 5000,
}

export const deploymentActivities: ActivityItem[] = [
  readSpec,
  gitStatus,
  writeEndpoint,
  editRoutes,
  writeComponent,
  npmInstall,
  jestTests,
  eslintCheck,
  dockerBuild,
  dockerPush,
  k8sDeployStaging,
  playwrightE2E,
  terraformApply,
  k8sDeployProd,
  slackAnnounce,
  gmailRelease,
]

export const deploymentResponse: ResponseContent = {
  text: `## Deployment Complete: v1.2.0

### Feature: User Preferences API

The User Preferences feature has been successfully deployed to production.

### Deployment Summary

| Stage | Status | Duration |
|-------|--------|----------|
| Build | ✅ Passed | 45s |
| Unit Tests | ✅ 127 passing | 12s |
| Lint | ✅ No issues | 3s |
| Docker Build | ✅ Image built | 89s |
| Staging Deploy | ✅ Healthy | 34s |
| E2E Tests | ✅ 23 passing | 67s |
| Infrastructure | ✅ Applied | 28s |
| Production Deploy | ✅ Healthy | 41s |

### Changes Included

**New Files:**
- \`src/api/routes/preferences.ts\` - REST API endpoint
- \`src/components/preferences/PreferencesPanel.tsx\` - UI component

**Modified Files:**
- \`src/api/index.ts\` - Added route registration
- \`package.json\` - Added @tanstack/react-query, zod

### Metrics

- **Test Coverage**: 94.2% (+2.1%)
- **Bundle Size**: 245kb (no change)
- **Build Time**: 89s (-12s from previous)

### Rollback Instructions

If issues arise, rollback with:
\`\`\`bash
kubectl rollout undo deployment/myapp -n production
\`\`\`

The team has been notified via Slack and stakeholders have received release notes.`,
  isStreaming: false,
}
