/**
 * Customer Support Escalation Workflow Sample
 * Cross-platform support flow demonstrating service integration
 */

import type { ActivityItem, ResponseContent } from '@craft-agent/ui'
import { nativeToolIcons, sourceIcons } from '../sample-icons'

const now = Date.now()

// Activity 1: Gmail - Read customer complaint
const gmailReadComplaint: ActivityItem = {
  id: 'support-1',
  type: 'tool',
  status: 'completed',
  toolName: 'mcp__gmail__api_gmail',
  toolInput: {
    path: 'gmail/v1/users/me/messages/19abc123def',
    method: 'GET',
    _intent: 'Reading customer complaint email about billing issue',
    _displayName: 'Read Email',
  },
  intent: 'Reading customer complaint email about billing issue',
  displayName: 'Read Email',
  toolDisplayMeta: {
    displayName: 'Gmail',
    category: 'source',
    iconDataUrl: sourceIcons.gmail,
  },
  timestamp: now - 60000,
}

// Activity 2: Stripe - Look up customer subscription
const stripeLookup: ActivityItem = {
  id: 'support-2',
  type: 'tool',
  status: 'completed',
  toolName: 'mcp__stripe__api_stripe',
  toolInput: {
    path: '/v1/customers/search',
    method: 'GET',
    query: { query: 'email:"sarah@example.com"' },
    _intent: 'Looking up customer account and subscription details',
    _displayName: 'Search Customer',
  },
  intent: 'Looking up customer account and subscription details',
  displayName: 'Search Customer',
  toolDisplayMeta: {
    displayName: 'Stripe',
    category: 'source',
    iconDataUrl: sourceIcons.stripe,
  },
  timestamp: now - 55000,
}

// Activity 3: Stripe - Get subscription details
const stripeGetSub: ActivityItem = {
  id: 'support-3',
  type: 'tool',
  status: 'completed',
  toolName: 'mcp__stripe__api_stripe',
  toolInput: {
    path: '/v1/subscriptions/sub_1234567890',
    method: 'GET',
    _intent: 'Fetching detailed subscription information',
    _displayName: 'Get Subscription',
  },
  intent: 'Fetching detailed subscription information',
  displayName: 'Get Subscription',
  toolDisplayMeta: {
    displayName: 'Stripe',
    category: 'source',
    iconDataUrl: sourceIcons.stripe,
  },
  timestamp: now - 50000,
}

// Activity 4: Stripe - Get invoice history
const stripeInvoices: ActivityItem = {
  id: 'support-4',
  type: 'tool',
  status: 'completed',
  toolName: 'mcp__stripe__api_stripe',
  toolInput: {
    path: '/v1/invoices',
    method: 'GET',
    query: { customer: 'cus_abc123', limit: 5 },
    _intent: 'Retrieving recent invoices to verify billing issue',
    _displayName: 'List Invoices',
  },
  intent: 'Retrieving recent invoices to verify billing issue',
  displayName: 'List Invoices',
  toolDisplayMeta: {
    displayName: 'Stripe',
    category: 'source',
    iconDataUrl: sourceIcons.stripe,
  },
  timestamp: now - 45000,
}

// Activity 5: PostgreSQL - Query customer data
const psqlQuery: ActivityItem = {
  id: 'support-5',
  type: 'tool',
  status: 'completed',
  toolName: 'Bash',
  toolInput: {
    command: 'psql $DATABASE_URL -c "SELECT * FROM users WHERE email = \'sarah@example.com\' LIMIT 1"',
    description: 'Querying customer account data from database',
  },
  intent: 'Querying customer account data from database',
  toolDisplayMeta: {
    displayName: 'PostgreSQL',
    category: 'native',
    iconDataUrl: nativeToolIcons.postgresql,
  },
  timestamp: now - 40000,
}

// Activity 6: Sentry - Check for errors in timeframe
const sentryErrors: ActivityItem = {
  id: 'support-6',
  type: 'tool',
  status: 'completed',
  toolName: 'mcp__sentry__sentry_search_issues',
  toolInput: {
    query: 'user.email:sarah@example.com is:unresolved',
    _intent: 'Checking for any errors affecting this customer',
    _displayName: 'Search Issues',
  },
  intent: 'Checking for any errors affecting this customer',
  displayName: 'Search Issues',
  toolDisplayMeta: {
    displayName: 'Sentry',
    category: 'source',
    iconDataUrl: sourceIcons.sentry,
  },
  timestamp: now - 35000,
}

// Activity 7: ClickUp - Create support ticket
const clickupTicket: ActivityItem = {
  id: 'support-7',
  type: 'tool',
  status: 'completed',
  toolName: 'mcp__clickup__clickup_create_task',
  toolInput: {
    list_id: 'support-queue',
    name: 'Billing Issue - Double charge for sarah@example.com',
    description: 'Customer reports being charged twice for January subscription',
    priority: 2,
    _intent: 'Creating support ticket for tracking and follow-up',
    _displayName: 'Create Task',
  },
  intent: 'Creating support ticket for tracking and follow-up',
  displayName: 'Create Task',
  toolDisplayMeta: {
    displayName: 'ClickUp',
    category: 'source',
    iconDataUrl: sourceIcons.clickup,
  },
  timestamp: now - 30000,
}

// Activity 8: Slack - Escalate to engineering
const slackEscalate: ActivityItem = {
  id: 'support-8',
  type: 'tool',
  status: 'completed',
  toolName: 'mcp__slack__slack_send_message',
  toolInput: {
    channel: '#billing-engineering',
    text: '⚠️ Customer billing issue: Double charge detected for cus_abc123. Invoice in_xyz789 appears to be a duplicate. Can someone verify the payment processor logs?',
    _intent: 'Escalating to billing engineering team for investigation',
    _displayName: 'Send Message',
  },
  intent: 'Escalating to billing engineering team for investigation',
  displayName: 'Send Message',
  toolDisplayMeta: {
    displayName: 'Slack',
    category: 'source',
    iconDataUrl: sourceIcons.slack,
  },
  timestamp: now - 25000,
}

// Activity 9: Stripe - Create refund
const stripeRefund: ActivityItem = {
  id: 'support-9',
  type: 'tool',
  status: 'completed',
  toolName: 'mcp__stripe__api_stripe',
  toolInput: {
    path: '/v1/refunds',
    method: 'POST',
    body: { charge: 'ch_duplicate123', reason: 'duplicate' },
    _intent: 'Processing refund for the duplicate charge',
    _displayName: 'Create Refund',
  },
  intent: 'Processing refund for the duplicate charge',
  displayName: 'Create Refund',
  toolDisplayMeta: {
    displayName: 'Stripe',
    category: 'source',
    iconDataUrl: sourceIcons.stripe,
  },
  timestamp: now - 15000,
}

// Activity 10: Gmail - Draft response to customer
const gmailResponse: ActivityItem = {
  id: 'support-10',
  type: 'tool',
  status: 'completed',
  toolName: 'mcp__gmail__api_gmail',
  toolInput: {
    path: 'gmail/v1/users/me/drafts',
    method: 'POST',
    body: {
      to: 'sarah@example.com',
      subject: 'Re: Billing Issue - Refund Processed',
      body: 'Dear Sarah, We apologize for the inconvenience...',
    },
    _intent: 'Drafting apology and resolution email to customer',
    _displayName: 'Create Draft',
  },
  intent: 'Drafting apology and resolution email to customer',
  displayName: 'Create Draft',
  toolDisplayMeta: {
    displayName: 'Gmail',
    category: 'source',
    iconDataUrl: sourceIcons.gmail,
  },
  timestamp: now - 5000,
}

export const customerSupportActivities: ActivityItem[] = [
  gmailReadComplaint,
  stripeLookup,
  stripeGetSub,
  stripeInvoices,
  psqlQuery,
  sentryErrors,
  clickupTicket,
  slackEscalate,
  stripeRefund,
  gmailResponse,
]

export const customerSupportResponse: ResponseContent = {
  text: `## Support Case Resolved

### Customer
**Sarah Thompson** (sarah@example.com)
- Customer ID: \`cus_abc123\`
- Plan: Pro ($49/month)
- Member since: March 2024

### Issue Summary
Customer was charged twice for the January 2026 subscription:
- Invoice \`in_xyz789\`: $49.00 (Jan 1) ✅ Legitimate
- Invoice \`in_xyz790\`: $49.00 (Jan 3) ❌ Duplicate

### Root Cause
The Stripe webhook received a timeout during initial processing, causing the payment to be retried. This is a known edge case when webhook responses exceed 30 seconds.

### Resolution
1. **Refund Issued**: $49.00 refund processed (re_abc123)
   - Expected to appear in 5-10 business days
2. **Support Ticket**: Created in ClickUp (#SUP-4521)
3. **Engineering Notified**: Posted to #billing-engineering for webhook timeout investigation

### Customer Communication
Draft email prepared with:
- Sincere apology for the inconvenience
- Confirmation of refund details
- 10% discount code for next renewal (SORRY10)

### Follow-up Actions
- [ ] Engineering to review webhook timeout handling
- [ ] Add duplicate charge detection to billing pipeline
- [ ] Follow up with customer in 7 days to confirm refund received

The draft email is ready for review before sending.`,
  isStreaming: false,
}
