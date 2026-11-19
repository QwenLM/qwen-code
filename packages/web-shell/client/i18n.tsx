import { MANAGED_EXTENSION_MESSAGES_EN } from './components/managed/managed-extension-messages.js';
import { MANAGED_LIFECYCLE_MESSAGES_EN } from './components/managed/managed-lifecycle-messages.js';
import { plural } from './utils/plural.js';
import { ACTIVITY_MESSAGES_EN } from './components/sidebar/activity-messages.js';
import { MESSAGE_DELETION_MESSAGES_EN } from './components/message-deletion-messages.js';
import { TRAJECTORY_EXECUTION_MESSAGES_EN } from './trajectory/execution-messages.js';
import { FILES_MESSAGES_EN } from './components/artifacts/files-messages.js';
import { TOKEN_USAGE_MESSAGES_EN } from './components/artifacts/token-usage-messages.js';
import { CHANNEL_EVENTS_MESSAGES_EN } from './components/channels/channel-events-messages.js';
import { TRAJECTORY_FILTER_MESSAGES_EN } from './trajectory/filter-messages.js';
import { TRAJECTORY_WINDOW_MESSAGES_EN } from './trajectory/window-messages.js';
import { VOICE_MESSAGES_EN } from './voice/messages.js';
import { LIVE_MESSAGES_EN } from './live/messages.js';
import { MCP_APP_MESSAGES_EN } from './mcp-app/messages.js';
import { COLLAB_MESSAGES_EN } from './components/workspace-agents/messages.js';
import { SETTINGS_MESSAGES_EN } from './settings/messages.js';
import { MANAGED_TASK_MESSAGES_EN } from './components/managed/managed-task-messages.js';
import { BROWSER_NOTIFICATION_MESSAGES_EN } from './browser-notifications/messages.js';
import { WORKSPACE_REGISTRATION_MESSAGES_EN } from './components/managed/managed-workspace-messages.js';
import { ARTIFACT_LIBRARY_MESSAGES_EN } from './components/managed/managed-artifact-library-messages.js';
import { MANAGED_MCP_MESSAGES_EN } from './components/managed/managed-mcp-messages.js';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type PropsWithChildren,
} from 'react';
import { eagerCatalogs, lazyCatalogs } from './i18n-catalogs.js';
import { WEB_SHELL_LANGUAGES, type WebShellLanguage } from './i18n-language.js';

export { WEB_SHELL_LANGUAGES, type WebShellLanguage } from './i18n-language.js';

export type MessageValue =
  | string
  | ((vars?: Record<string, string | number>) => string);

export type Messages = Record<string, MessageValue>;

const EN: Messages = {
  "You've used up your weekly credits.{{reset}} You can wait or run /upgrade to get more credits.":
    (v) =>
      `You've used up your weekly credits.${v?.['reset'] ?? ''} You can wait or run /upgrade to get more credits.`,
  "You've used up your weekly credits.{{reset}} Please try again after the reset.":
    (v) =>
      `You've used up your weekly credits.${v?.['reset'] ?? ''} Please try again after the reset.`,
  "You've used up your credits.{{reset}} Please try again after the reset.": (
    v,
  ) =>
    `You've used up your credits.${v?.['reset'] ?? ''} Please try again after the reset.`,
  ' Your credits are expected to reset in {{time}}.': (v) =>
    ` Your credits are expected to reset in ${v?.['time'] ?? ''}.`,
  '{{days}} and {{hours}}': (v) =>
    `${v?.['days'] ?? ''} and ${v?.['hours'] ?? ''}`,
  '1 day': '1 day',
  '{{count}} days': (v) => `${v?.['count'] ?? ''} days`,
  '1 hour': '1 hour',
  '{{count}} hours': (v) => `${v?.['count'] ?? ''} hours`,
  'subscription.entryTitle': 'Qwen Account with Subscription',
  'subscription.entryDescription':
    'Unlock Qwen Code + Agent with Plus/Pro Plan at chat.qwen.ai',
  'subscription.new': 'New',
  'subscription.openPlansDescription':
    'Opens the Qwen Code plans page in your browser',
  'subscription.switchProviderDescription': 'Choose another model provider',
  'subscription.upgradeDescription': 'Open Qwen subscription plans',
  'subscription.commandUnavailable':
    'Sign in to Qwen and select a Qwen subscription model to use this command.',
  'subscription.upgradeFailed':
    'Could not open Qwen subscription plans. Please try again.',
  'subscription.signOutDescription':
    'Disconnect this device from your Qwen account',
  'subscription.title': 'Qwen Subscription',
  'subscription.waiting':
    'Opening chat.qwen.ai in your browser… Sign in there to connect Qwen Code.',
  'subscription.browserFallback': "If the browser didn't open, visit:",
  'subscription.pending': 'Waiting for sign-in…',
  'subscription.checking': 'Checking your subscription…',
  'subscription.waitingForPurchase':
    'Waiting for your subscription to become active…',
  'subscription.included': 'Qwen Code is included with Qwen Plus and Pro',
  'subscription.openAuthorization': 'Open authorization page',
  'subscription.openPlans': 'View Plans',
  'subscription.checkAgain': 'Retry Connection',
  'subscription.switchProvider': 'Switch Provider',
  'subscription.useAnotherAccount': 'Use another account',
  'subscription.successTitle': 'Signed in successfully',
  'subscription.successDescription': 'You can now use Qwen Code.',
  'subscription.accountLabel': 'Account',
  'subscription.planLabel': 'Plan',
  'subscription.modelLabel': 'Model',
  'subscription.startUsing': 'Start Using',
  'subscription.signOut': 'Sign out',
  'subscription.signedOut': 'Signed out of Qwen. Use /auth to sign in again.',
  'subscription.signedOutLocally':
    'You are signed out locally, but the remote session could not be revoked.',
  'subscription.signOutFailed': 'Could not sign out of Qwen. Please try again.',
  'subscription.logoutNotRequired':
    'This connection does not require /logout. Use /auth to switch model providers.',
  'subscription.unavailable':
    'Qwen subscription is not available in this build.',
  'subscription.cancel': 'Cancel',
  'subscription.connecting': 'Loading models from provider…',
  'subscription.refreshFailed':
    'Could not refresh your Qwen session. Please try again.',
  'subscription.credentialsFailed':
    'Could not read or save Qwen credentials. Check local file permissions and disk space.',
  'subscription.rateLimited': 'Too many requests. Please try again later.',
  'subscription.networkFailed': 'The network request failed or timed out.',
  'subscription.modelsUnavailable':
    'Could not load models. Your account is still signed in. Please try again.',
  'subscription.connected': (v) =>
    `✓ Signed in successfully · ${v?.email ?? ''}  \n✓ Current plan: Qwen ${v?.plan ?? ''}. Qwen Code is ready.${v?.model ? `  \nModel: ${v.model}. Run /upgrade to upgrade your plan, /usage to view usage, or /model to switch models.` : ''}${v?.url ? `  \nIf the browser didn't open, visit:  \n${v.url}` : ''}  \nCommon commands: /usage   /upgrade   /model   /status   /logout`,
  'subscription.signedIn': (v) => `Signed in successfully · ${v?.email ?? ''}`,
  'subscription.modelSummary': (v) =>
    `Model: ${v?.model ?? ''}. Run /upgrade to upgrade your plan, /usage to view usage, or /model to switch models.`,
  'subscription.commonCommands':
    'Common commands: /usage   /upgrade   /model   /status   /logout',
  'subscription.loginRequired':
    'Your login credentials are no longer valid. Run /auth to sign in again.',
  'subscription.signedInWithPlan': (v) =>
    `Signed in as ${v?.email ?? ''} (Qwen ${v?.plan ?? ''})`,
  'subscription.ready': (v) =>
    `Current plan: Qwen ${v?.plan ?? ''}. Qwen Code is ready.`,
  'subscription.purchase-required': (v) =>
    `You're signed in with a ${v?.plan ?? ''} account, which doesn't include Qwen Code. Choose Plus or Pro in your browser; Qwen Code continues automatically after you subscribe.`,
  'remoteAccess.title': 'Allow remote connections',
  'remoteAccess.description':
    'Enable access to this server without restarting it. Local sessions and tasks keep running.',
  'remoteAccess.server': 'Current server',
  'remoteAccess.loading': 'Reading remote access status…',
  'remoteAccess.on': 'Remote access is enabled.',
  'remoteAccess.off':
    'Remote access is off. Enable it here when needed; it defaults to off after a server restart.',
  'remoteAccess.external':
    'The primary listener is externally configured. This switch cannot close access opened by startup or proxy configuration.',
  'remoteAccess.localOnly':
    'Open this server’s settings through its authorized local connection to manage remote access.',
  'remoteAccess.unavailable':
    'This daemon does not support remote access settings.',
  'remoteAccess.network': 'Network interface',
  'remoteAccess.noNetwork':
    'No external IPv4 interface is available on this server.',
  'remoteAccess.address': 'Connection address',
  'remoteAccess.reveal': 'Show token',
  'remoteAccess.hide': 'Hide token',
  'remoteAccess.copyToken': 'Copy token',
  'remoteAccess.reset': 'Reset token',
  'remoteAccess.resetHint':
    'Turning access off or resetting the token disconnects remote clients. Running server tasks continue.',
  'remoteAccess.http':
    'HTTP is unencrypted. Use this address on a trusted network; HTTPS pages require an HTTPS endpoint.',
  'remoteAccess.encrypted':
    'This endpoint uses HTTPS. The client must trust its certificate.',
  'remoteAccess.advanced': 'Advanced connection settings',
  'remoteAccess.port': 'Port (blank uses the current server port)',
  'remoteAccess.origins': 'Additional page origins (one per line)',
  'remoteAccess.originsHint':
    'HTTP pages on localhost and 127.0.0.1 at any port are already allowed. Applying origins reconnects remote clients.',
  'remoteAccess.apply': 'Apply origins',
  'remoteAccess.copied': 'Copied.',
  'remoteAccess.copyFailed':
    'Could not copy. Reveal and select the value to copy it manually.',

  'capacityChoice.persistenceUnconfirmed':
    'Saving the last interrupted turn could not be confirmed.',
  'capacityChoice.title': 'Choose a workspace to stop',
  'capacityChoice.description':
    'No ACP capacity is available. Choose a workspace whose sessions you want to stop, or cancel and keep working.',
  'capacityChoice.warning':
    'Stopping interrupts all listed sessions and their tools. Files, workspace registration and saved history remain. Unsaved work may be lost. Closing this dialog after confirmation does not undo the stop.',
  'capacityChoice.outdated':
    'The draft, session or daemon has changed. Cancel and try the original operation again.',
  'capacityChoice.inProgress':
    'The selected stop is still being resolved. Refresh its status before continuing.',
  'capacityChoice.failedUnreleased':
    'The stop failed. This workspace remains unavailable until its old processes are confirmed stopped. Capacity is still reserved. Refresh to check cleanup.',
  'capacityChoice.failedUnknownCleanup':
    'The stop failed. Cleanup could not be confirmed. Refresh its status before continuing.',
  'capacityChoice.workspaces': 'Workspace to stop',
  'capacityChoice.requester':
    'This workspace owns the operation you are trying to continue.',
  'capacityChoice.running': 'Running',
  'capacityChoice.waiting': 'Waiting for your response',
  'capacityChoice.background': 'Background work running',
  'capacityChoice.backgroundUnknown': 'Background work status unknown',
  'capacityChoice.none':
    'No workspace can currently be stopped here. Review the reasons above, stop the independent work, or cancel.',
  'capacityChoice.refresh': 'Refresh status',
  'capacityChoice.continue': 'Continue original operation',
  'capacityChoice.confirm': 'Stop these sessions and continue',
  'capacityChoice.stopped':
    'This workspace was stopped to free ACP capacity. Resume this conversation when needed.',
  'capacityChoice.resume': 'Resume conversation',
  'capacityChoice.blocked.stopping': 'Stopping',
  'capacityChoice.blocked.not_live': 'No live ACP',
  'capacityChoice.blocked.release_unavailable':
    'Owned process release cannot be observed',
  'capacityChoice.blocked.session_start_pending':
    'Session startup or restore in progress',
  'capacityChoice.blocked.workspace_control_pending':
    'Workspace management or MCP work in progress',
  'capacityChoice.blocked.session_closing':
    'Session close or reset in progress',
  'capacityChoice.blocked.runtime_unavailable':
    'Workspace unavailable or untrusted',
  'capacityChoice.blocked.special_runtime': 'Special-purpose workspace',
  'capacityChoice.blocked.unsupported': 'Runtime stop is not supported',
  'capacityChoice.blocked.activity_unknown': 'Activity could not be observed',
  'capacityChoice.blocked.pendingSessionStarts': 'Session startup pending',
  'capacityChoice.blocked.acpConnections': 'An ACP client is connected',
  'capacityChoice.blocked.memoryTasks': 'Memory task running',
  'capacityChoice.blocked.channelWorkers': 'Channel worker running',
  'capacityChoice.blocked.voiceSessions': 'Voice session active',
  'capacityChoice.blocked.management_pending': 'Workspace management pending',
  'capacityChoice.blocked.scheduler_pending':
    'Scheduled session restore in progress',
  'capacityChoice.blocked.enabled_scheduled_tasks':
    'Disable enabled scheduled tasks first',
  'capacityChoice.blocked.scheduled_tasks_unknown':
    'Scheduled tasks could not be read',
  'capacityChoice.capacity': (v) => `ACP capacity: ${v?.used} / ${v?.limit}`,
  'capacityChoice.sessions': (v) => `${v?.count} loaded session(s)`,
  'capacityChoice.queued': (v) => `${v?.count} queued`,
  'capacityChoice.outcome': (v) =>
    `${v?.closed} session(s) closed; ${v?.remaining} remaining.`,
  'footnotes.note': (v) => `Footnote ${v?.number ?? ''}`,
  'footnotes.references': (v) => `View ${v?.count ?? ''} references`,
  'footnotes.preview': 'Reference preview',
  'footnotes.previous': 'Previous reference',
  'footnotes.next': 'Next reference',
  'footnotes.citations': (v) =>
    `${v?.count ?? 0} ${v?.count === 1 ? 'citation' : 'citations'}`,
  'daemon.connection.paused':
    'Cannot reach the service. Automatic refresh is paused while reconnecting.',
  'daemon.connection.authRequired':
    'Service authentication failed. Check your credentials; automatic refresh is paused.',
  'daemon.connection.unavailable': 'Cannot reach the service.',
  'localControl.connectionRetry':
    'Connection interrupted. Retry to refresh the QR code.',
  'daemon.connection.retry': 'Retry connection',
  'hooksApproval.title': 'This project wants to run hooks',
  'hooksApproval.description':
    'Hooks in this project\u2019s .qwen/settings.json run commands on your machine. They stay disabled until you approve this exact configuration. Any change to the hooks or the project .env asks again.',
  'hooksApproval.scopeNote':
    'Approving records a decision for this project only. If folder trust is enabled and this folder is not trusted, the hooks stay disabled until the folder is trusted.',
  'hooksApproval.approve': 'Approve hooks',
  'hooksApproval.reject': 'Keep disabled',
  'hooksApproval.failed':
    'The decision could not be saved. Nothing changed; please try again.',
  'daemon.capacity.exhausted':
    'The service has reached its concurrent capacity limit and cannot start this session. Try again later or cancel this operation.',
  'managed.title': 'Managed Agents',
  'managed.executionMode': 'Execution mode',
  'workspace.executionDaemon': 'Local (daemon)',
  'workspace.executionManaged': 'Managed (Managed Agent)',
  'workspace.executionHint':
    'New tasks in this workspace use the selected service.',
  'managed.localMode': 'Local',
  'managed.managedMode': 'Managed',
  'managed.sessions': 'Managed sessions',
  'managed.conversation': 'Managed conversation',
  'managed.new': 'New managed task',
  'managed.refresh': 'Refresh',
  'managed.empty': 'No managed tasks yet.',
  'managed.loading': 'Loading…',
  'managed.listLoadFailed': 'Managed sessions could not be loaded.',
  'managed.listRetry': 'Retry loading sessions',
  'managed.errorDetails': (v) =>
    `HTTP ${v?.status ?? ''} · ${v?.code ?? ''}${v?.requestId ? ` · Request ID: ${v.requestId}` : ''}`,
  'managed.todo.loadedWindow': 'From the loaded session transcript.',
  'managed.more': 'Load more',
  'managed.titleSearch': 'Search session titles',
  'managed.titleSearchPlaceholder': 'Filter by title…',
  'managed.prompt': 'Message the managed agent',
  'managed.queue.title': 'Queued messages',
  'managed.queue.paused': 'Paused',
  'managed.queue.resume': 'Continue sending',
  'managed.queue.edit': 'Edit',
  'managed.queue.withdraw': 'Withdraw',
  'managed.queue.discard': 'Discard from queue',
  'managed.queue.unknownDelivery':
    'Delivery is unconfirmed. Discarding stops this message from blocking the queue; it does not undo any input already received. Continue sending explicitly afterward.',
  'managed.queue.save': 'Save',
  'managed.queue.cancelEdit': 'Cancel edit',
  'managed.queue.waiting': 'Waiting to insert',
  'managed.queue.claimed': 'Preparing delivery',
  'managed.queue.blocked': 'Delivery needs recovery',
  'managed.queue.imagesIdleOnly':
    'Wait for the current Turn to finish before sending images.',
  'managed.queue.placeholder': 'Add guidance to the running Turn',
  'managed.runtime': 'Environment',
  'managed.unavailable': 'Managed Agents is unavailable on this daemon.',
  'managed.send': 'Send',
  'managed.sending': 'Submitting…',
  'managed.elapsed': (v) => `${v?.seconds ?? 0}s elapsed`,
  'managed.runningHint':
    'This turn is running. Sending another message is paused.',
  'managed.retry': 'Retry the same request',
  'managed.cancel': 'Cancel turn',
  'managed.uncertain':
    'The previous message was not confirmed as submitted. Retrying reuses the same request and will not run twice.',
  'managed.pendingElsewhere':
    'Another conversation has an unconfirmed request. Return to it before sending a new message.',
  'managed.openPendingOwner': 'Open the original conversation',
  'managed.discard': 'Discard this request',
  'managed.pendingRestoreFailed':
    'The pending request cannot be restored and may already have been submitted. Check the session before discarding this pending record.',
  'managed.pendingDiscardFailed':
    'Could not discard this request. Browser storage is unavailable. Retry or reload the page.',
  'managed.discarded': 'Request discarded. The draft is back in the composer.',
  'managed.newRequired': 'Start a new task to send another message.',
  'managed.truncated': '[Details truncated]',
  'managed.question.title': 'Answer the questions',
  'managed.actions.title': 'Pending requests',
  'managed.actions.root': 'This session',
  'managed.actions.child': (v) => `Child session · ${v?.session}`,
  'managed.actions.childSource': 'Child session request',
  'managed.actions.question': 'Question',
  'managed.actions.permission': 'Permission',
  'managed.actions.expired': 'Expired',
  'managed.actions.expires': (v) => `Expires ${v?.time}`,
  'managed.question.other': 'Other answer',
  'managed.question.expired':
    'This question has expired. Refresh to check the session.',
  'managed.question.tooLarge':
    'Keep each text answer within 8192 characters and all answers within 32 KiB.',
  'managed.question.failed':
    'The answer could not be confirmed. Retry the same answers or refresh to check their status.',
  'managed.question.forbidden':
    "Only the Session's owner or a Workspace operator can answer these questions.",
  'managed.approval.failed':
    'The approval answer could not be confirmed. Retry the same option or refresh to check its status.',
  'managed.approval.loadFailed': 'Pending requests could not be loaded.',
  'managed.approval.refreshFailed': 'Pending requests could not be refreshed.',
  'managed.approval.retry': 'Retry loading requests',
  'managed.approval.forbidden':
    "Only the Session's owner or a Workspace operator can answer this approval.",
  'managed.approval.argumentsUnavailable':
    'Tool arguments are unavailable for this approval.',
  'managed.approval.previewComplete': (v) =>
    `Input preview: ${v?.bytes ?? 0} bytes.`,
  'managed.approval.previewTruncated': (v) =>
    `Input preview truncated. Full input: ${v?.bytes ?? 0} bytes.`,
  'managed.result.range': (v) => `Bytes ${v?.start}–${v?.end} of ${v?.total}`,
  'managed.result.outputs': 'Outputs',
  'managed.result.view': 'View output',
  'managed.result.empty': 'No published output yet.',
  'managed.result.description':
    'Read saved output without running the command again.',
  'managed.result.preview': 'Approved preview',
  'managed.result.previewTruncated':
    'Preview clipped; this does not mean the captured output is incomplete.',
  'managed.result.execution.success': 'Command succeeded',
  'managed.result.execution.error': 'Command failed',
  'managed.result.execution.cancelled': 'Command cancelled',
  'managed.result.execution.not_started': 'Command not executed',
  'managed.result.capture.complete': 'Capture complete',
  'managed.result.capture.partial': 'Capture incomplete',
  'managed.result.capture.unavailable': 'Capture unavailable',
  'managed.result.capture.none': 'No capture',
  'managed.result.delivery.pending': 'Saving output',
  'managed.result.delivery.committed': 'Output saved',
  'managed.result.delivery.blocked': 'Output delivery blocked',
  'managed.result.forbidden':
    'Original output is not available to your account.',
  'managed.result.unavailable': 'Saved bytes are currently unavailable.',
  'managed.result.downloadUnsupported':
    'This browser needs a host integration to save a streaming download.',
  'managed.result.previous': 'Previous page',
  'managed.result.next': 'Next page',
  'managed.result.expired': 'This output revision has expired.',
  'managed.result.changed':
    'This output revision changed. Refresh to choose the current revision.',
  'managed.result.reading': 'Reading output…',
  'managed.result.emptyStream': 'Empty output (0 bytes)',
  'managed.result.close': 'Close output',
  'managed.result.refresh': 'Refresh output',
  'managed.phase.created': 'Created',
  'managed.creationSkillsFromSettings':
    'Enabled Skills on the Skills page are added to new Managed sessions. Existing sessions keep their original Skills.',
  'managed.creationSkillsSourceChanged':
    'The Skills source changed. Retry with the selected source.',
  'managed.creationSkillsUnavailable':
    'Enabled Skills could not be loaded for this Managed session.',
  'managed.workspaceCreateTitle': 'Create a Workspace session',
  'managed.workspaceLabel': 'Workspace',
  'managed.modelPreset': 'Model / Agent preset',
  'managed.modelDefault': 'Server default model',
  'managed.modelPinned':
    'Choose the initial model and Agent preset. Supported conversations can change model while idle.',
  'managed.workspaceChoose': 'Choose a Workspace',
  'managed.workspaceDirectory': 'Relative directory',
  'managed.workspaceWorkingDirectory': 'Working directory',
  'managed.workspaceWorkingDirectoryDescription':
    'Choose where this session starts within the Workspace. Use . for the Workspace root.',
  'managed.cwd.path': 'Directory relative to Workspace root',
  'managed.workspaceCreate': 'Create session',
  'managed.workspaceBound': 'Bound Workspace',
  'managed.workspaceExecutionUnavailable':
    'Workspace is bound. You cannot send messages in this Session.',
  'managed.workspaceSharedFiles':
    'Sessions in the same Workspace share files. Directory availability is checked before execution.',
  'managed.workspaceEmpty': 'No readable Workspaces are available.',
  'managed.newWorkspaceTitle': 'New workspace',
  'managed.modelFixed':
    'The model is fixed for this task. Start a new task to choose another model.',
  'managed.approvalChange.loading': 'Loading approval policies…',
  'managed.approvalChange.optionsError': 'Could not load approval policies.',
  'managed.approvalChange.reload': 'Reload policies',
  'managed.approvalChange.nextTurn':
    'Approval policy changes apply to the next turn.',
  'managed.approvalChange.live':
    'Approval policy changes apply to subsequent tool calls in this turn.',
  'managed.approvalChange.changing': 'Changing approval policy…',
  'managed.approvalChange.unconfirmed':
    'Approval change is not confirmed. Continue confirming the original request.',
  'managed.approvalChange.confirm': 'Continue confirming',
  'managed.approvalChange.busy':
    'Finish the current turn or recovery before changing approval policy.',
  'managed.approvalChange.storage':
    'Browser session storage is unavailable. The approval change was not sent.',
  'managed.approvalChange.conflict':
    'Approval policy changed elsewhere. Review the current selection.',
  'managed.approvalChange.failed':
    'Approval change was refused. Review the available policies.',
  'managed.permissionRules.title': 'Permission rules',
  'managed.permissionRules.description':
    'Rules belong to this conversation. Edit while idle. Deny takes priority, and explicit Ask always requires your approval, including in YOLO.',
  'managed.permissionRules.syntax':
    'One rule per line: Read, Bash(git status*), WebFetch(domain:example.com), or mcp__server__tool. Path rules are not supported. Up to 32 per list and 64 in total.',
  'managed.permissionRules.allow': 'Allow',
  'managed.permissionRules.ask': 'Ask every time',
  'managed.permissionRules.deny': 'Deny',
  'managed.permissionRules.invalid':
    'Check the rule syntax, duplicates and limits: 512 UTF-8 bytes per rule, 8 KiB in total.',
  'managed.permissionRules.clear': 'Clear rules',
  'managed.permissionRules.save': 'Save rules',
  'managed.model.loading': 'Loading available models…',
  'managed.model.optionsError': 'Could not load available models.',
  'managed.model.reload': 'Reload models',
  'managed.model.nextTurn':
    'Your next message uses the selected model. An already running task keeps its model; conversation history is kept.',
  'managed.model.changing': 'Changing model…',
  'managed.model.busy':
    'Model changes are temporarily unavailable for this session. Try again shortly.',
  'managed.model.conflict':
    'The model has changed. Review the current selection and try again.',
  'managed.model.failed':
    'Could not change the model. Check the current selection and try again.',
  'managed.approvalOptionsLoading': 'Loading approval modes…',
  'managed.approvalOptionsLoadFailed': 'Could not load approval modes.',
  'managed.approvalOptionsInvalid':
    'The service returned unsupported approval modes.',
  'managed.approvalFixed':
    'This session does not support changing its approval policy.',
  'managed.newWorkspaceDescription':
    'Choose an existing project directory, or name a new empty workspace.',
  'managed.workspaceDirectoryRoot': 'Authorized directories',
  'managed.localDirectoryHint':
    'Choose an existing project on this computer. Workspace setup is automatic.',
  'managed.workspaceDirectoryHint':
    'Choose an existing project on the execution host within this authorized root.',
  'managed.workspaceChooseDirectory': 'Choose existing directory',
  'managed.workspaceDirectoryScope':
    'Choose a directory inside the selected root.',
  'managed.newWorkspaceName': 'Workspace name',
  'managed.newWorkspaceNameInvalid':
    'Use a name of 1–128 characters without control characters.',
  'managed.newWorkspaceCreate': 'Create workspace',
  'managed.newWorkspaceCreating': 'Creating workspace…',
  'managed.newWorkspaceUncertain':
    'The creation is not yet confirmed. Retry to check the same workspace, or abandon local confirmation to start again. Abandoning does not delete a workspace that may already exist.',
  'managed.newWorkspaceResume': 'Resume workspace creation',
  'managed.newWorkspaceClose': 'Close',
  'managed.workspaceUnsupported':
    'This service does not support Workspace binding.',
  'managed.workspacePermission':
    'You do not have permission to discover Workspaces.',
  'managed.workspaceLoadFailed': 'Could not load Workspaces.',
  'managed.workspaceStorageUnavailable':
    'Browser session storage is unavailable. Creation cannot start safely.',
  'managed.workspaceUncertain':
    'Creation is unconfirmed. Retry the saved request or read the saved session.',
  'managed.workspaceRetryRead': 'Retry reading session',
  'managed.workspaceSessionId': 'Session ID',
  'managed.workspaceProtocolError': (v) =>
    `Session ${v?.sessionId ?? ''} was created, but its Workspace binding could not be confirmed.`,
  'managed.workspaceAbandon': 'Abandon local confirmation',
  'managed.workspaceAbandonWarning':
    'The original empty session may still exist. Abandoning this record does not delete it.',
  'managed.workspaceAbandonInputWarning':
    'A session with this input may already exist or be running. Abandoning this record does not cancel it. Sending it again starts a new request and may repeat its effects.',
  'managed.workspaceSwitchTitle': 'Switch Workspace?',
  'managed.workspaceSwitchDescription':
    'Switching resets the relative directory to the Workspace root.',
  'managed.workspaceKeep': 'Keep selection',
  'managed.workspaceSwitch': 'Switch',
  'managed.phase.admitted': 'Accepted',
  'managed.phase.runtime_starting': 'Preparing environment',
  'managed.phase.agent_running': 'Thinking / responding',
  'managed.phase.waiting_runtime': 'Waiting for environment',
  'managed.phase.tool_running': 'Executing tool',
  'managed.phase.cancelling': 'Cancelling',
  'managed.phase.completed': 'Completed',
  'managed.phase.failed': 'Failed',
  'managed.phase.cancelled': 'Cancelled',
  'managed.runtime.unknown': 'Unknown',
  'managed.runtime.starting': 'Preparing',
  'managed.runtime.ready': 'Ready',
  'managed.runtime.failed': 'Preparation failed',

  'git.currentBranch': (v) => `Current Git branch: ${v?.branch ?? ''}`,
  'git.detached': 'Detached HEAD',
  'git.clean': 'Working tree clean',
  'git.operation.merge': 'Merging',
  'git.operation.rebase': 'Rebasing',
  'git.operation.cherry-pick': 'Cherry-picking',
  'git.operation.revert': 'Reverting',
  'git.operation.bisect': 'Bisecting',
  'git.conflicted': (v) => `${v?.count ?? 0} conflicted`,
  'git.staged': (v) => `${v?.count ?? 0} staged`,
  'git.unstaged': (v) => `${v?.count ?? 0} modified`,
  'git.untracked': (v) => `${v?.count ?? 0} untracked`,
  'git.ahead': (v) => `${v?.count ?? 0} ahead`,
  'git.behind': (v) => `${v?.count ?? 0} behind`,
  'git.stash': (v) => `${v?.count ?? 0} stashed`,
  'branchPicker.label': 'Git',
  'branchPicker.search': 'Search for branches and actions',
  'branchPicker.loading': 'Loading branches…',
  'branchPicker.noBranches': 'No branches',
  'branchPicker.noTags': 'No tags',
  'branchPicker.action.pull': 'Update Project',
  'branchPicker.action.push': 'Push',
  'branchPicker.action.commit': 'Commit',
  'branchPicker.action.newBranch': 'New Branch…',
  'branchPicker.action.checkoutRef': 'Checkout Tag or Revision…',
  'branchPicker.action.viewChanges': 'View Changes',
  'branchPicker.action.worktrees': 'Worktrees…',
  'branchPicker.action.createBranchHere': 'Create branch here',
  'branchPicker.action.handoffToLocal': 'Hand off to local',
  'branchPicker.action.moveToWorktree': 'Move to worktree',
  'branchPicker.moveToWorktreeHint':
    'Your local checkout keeps its uncommitted changes; handing back later requires a clean local checkout.',
  'branchPicker.action.history': 'History',
  'branchPicker.newBranchPlaceholder': 'Branch name',
  'branchPicker.createBranchPlaceholder': 'New branch name',
  'branchPicker.invalidBranchName':
    'Invalid branch name — avoid spaces, ~, ^, :, ? * and leading -',
  'branchPicker.checkoutRefPlaceholder': 'Tag name or commit SHA',
  'branchPicker.section.recent': 'Recent',
  'branchPicker.section.local': 'Local',
  'branchPicker.section.remote': 'Remote',
  'branchPicker.section.tags': 'Tags',
  'branchPicker.checkedOut': (v) => `Checked out ${v?.branch ?? ''}`,
  'branchPicker.createdBranch': (v) => `Created branch ${v?.branch ?? ''}`,
  'branchPicker.pushSuccess': 'Pushed successfully',
  'branchPicker.pullSuccess': 'Updated successfully',
  'branchPicker.pullBlocked': 'Update blocked by uncommitted changes',
  'branchPicker.pullStash': 'Stash Changes and Update',
  'branchPicker.pullDiscard': 'Discard Changes and Update…',
  'branchPicker.pullDiscardConfirm':
    'Discard ALL uncommitted changes (including untracked files)? This cannot be undone.',
  'branchPicker.pullDiscardGo': 'Discard and Update',
  'branchPicker.pullStashConflict': (v) =>
    `Updated, but restoring your stashed changes failed. They are kept in stash entry ${String(v?.sha ?? '').slice(0, 12) || '(see git stash list)'} — resolve any conflict markers, then restore it manually.`,
  'branchPicker.checkoutBlocked': 'Switch blocked by uncommitted changes',
  'branchPicker.checkoutStash': 'Stash Changes and Switch',
  'branchPicker.checkoutDiscard': 'Discard Changes and Switch…',
  'branchPicker.checkoutDiscardGo': 'Discard and Switch',
  'branchPicker.checkoutStashKept': (v) =>
    `Switched to ${v?.branch ?? ''}. Your local changes are kept in stash entry ${String(v?.sha ?? '').slice(0, 12) || '(see git stash list)'} — restore them with git stash apply when wanted.`,
  'branchPicker.cancel': 'Cancel',
  'branchPicker.hint.upToDate': 'Up to date',
  'branchPicker.hint.noUpstream': 'No upstream',
  'branchPicker.hint.upstreamGone': 'Upstream gone',
  'branchPicker.hint.behindDirty': (v) =>
    `↓${v?.count ?? 0} · uncommitted changes`,
  'branchPicker.hint.setsUpstream': 'Sets upstream on push',
  'branchPicker.hint.createsPushBranch': (v) => `Creates ${v?.target ?? ''}`,
  'branchPicker.hint.aheadBehind': (v) =>
    `↑${v?.ahead ?? 0} ↓${v?.behind ?? 0} · diverged`,
  'branchPicker.hint.nothingToPush': 'Nothing to push',
  'branchPicker.hint.noChanges': 'No changes',
  'branchPicker.hint.changes': (v) =>
    `${v?.count ?? 0} ${v?.count === 1 ? 'change' : 'changes'}`,
  'branchPicker.hint.changesUntracked': (v) =>
    `${v?.count ?? 0} ${v?.count === 1 ? 'change' : 'changes'} (${v?.untracked ?? 0} untracked)`,
  'branchPicker.action.manageRemotes': 'Manage Remotes…',
  'branchPicker.remotes.title': 'Remotes',
  'branchPicker.remotes.back': 'Back to branches',
  'branchPicker.remotes.loading': 'Loading remotes…',
  'branchPicker.remotes.empty': 'No remotes configured',
  'branchPicker.remotes.noMatches': 'No remotes match the search',
  'branchPicker.remotes.namePlaceholder': 'Remote name',
  'branchPicker.remotes.urlPlaceholder': 'Remote URL',
  'branchPicker.remotes.add': 'Add',
  'branchPicker.remotes.remove': (v) => `Remove ${v?.name ?? ''}`,
  'branchPicker.remotes.removeConfirm': 'Confirm',
  'branchPicker.remotes.removeConfirmFor': (v) =>
    `Confirm removing ${v?.name ?? ''}${v?.extras ? ` (${v.extras})` : ''}`,
  'branchPicker.remotes.invisibleName': '(invisible name)',
  'branchPicker.remotes.hiddenChars': '(hidden characters)',
  'branchPicker.remotes.lookalikeName': '(lookalike name)',
  'branchPicker.remotes.searchPlaceholder': 'Search remotes',
  'branchPicker.remotes.urlTooltipFetch': (v) => `fetch: ${v?.url ?? ''}`,
  'branchPicker.remotes.urlTooltipPush': (v) => `push: ${v?.url ?? ''}`,
  'branchPicker.remotes.promisor': 'partial clone',
  'branchPicker.remotes.partialClone': (v) => `partial clone (${v?.filter})`,
  'branchPicker.remotes.customRefspec': 'custom refspec',
  'branchPicker.remotes.extraUrls': (v) =>
    `+${v?.count ?? 0} ${v?.count === 1 ? 'URL' : 'URLs'}`,
  'branchPicker.remotes.otherSettings': (v) =>
    `${v?.count ?? 0} ${v?.count === 1 ? 'other setting' : 'other settings'}`,
  'branchPicker.remotes.added': (v) => `Added remote ${v?.name ?? ''}`,
  'branchPicker.remotes.removed': (v) => `Removed remote ${v?.name ?? ''}`,
  'branchPicker.remotes.invalidInput':
    'Enter a remote name and URL (no leading -)',
  'gitCommit.title': 'Commit',
  'gitCommit.messagePlaceholder': 'Commit message (⌘/Ctrl+Enter to commit)',
  'gitCommit.generating': 'Generating commit message…',
  'gitCommit.genFailed': 'Auto-generation failed — write your message',
  'gitCommit.prLogUnavailable':
    'Could not load commits for the selected base branch.',
  'gitCommit.prPushFirst':
    'Push your branch to a remote before creating a pull request.',
  'gitCommit.commit': 'Commit',
  'gitCommit.commitAndPush': 'Commit and Push',
  'gitCommit.createPr': 'Create Pull Request',
  'gitCommit.prTitlePlaceholder': 'Pull request title',
  'gitCommit.prBodyPlaceholder': 'Description (optional)',
  'gitCommit.prEdit': 'Edit',
  'gitCommit.prPreview': 'Preview',
  'gitCommit.prSubmit': 'Create',
  'gitCommit.prCreated': (v) => `Pull Request #${v?.number ?? ''} created`,
  'gitCommit.commitSuccess': (v) => `Committed ${v?.sha ?? ''}`,
  'gitCommit.commitPushSuccess': (v) => `Committed & pushed ${v?.sha ?? ''}`,
  'gitCommit.commitSuccessPushFailed': (v) =>
    `Committed ${v?.sha ?? ''} — push failed: ${v?.error ?? 'unknown'}`,
  'branchSelect.baseBranch': 'Base branch',
  'branchSelect.search': 'Search branches…',
  'branchSelect.loading': 'Loading…',
  'branchSelect.noMatches': 'No matches',
  'branchSelect.error': 'Failed to load branches',
  'branchSelect.retry': 'Retry',
  'branchSelect.local': 'local',
  'gitDiff.title': 'Changes',
  'gitDiff.summary': (v) =>
    `${v?.count ?? 0} files · +${v?.added ?? 0} −${v?.removed ?? 0}`,
  'gitDiff.loading': 'Loading changes…',
  'gitDiff.empty': 'No changes in the working tree',
  'gitDiff.unavailable': 'Git is not available for this workspace',
  'gitDiff.error': 'Failed to load changes',
  'gitDiff.binary': 'Binary',
  'gitDiff.untracked': 'Untracked',
  'gitDiff.deleted': 'Deleted',
  'gitDiff.noDiff': 'No changes to display',
  'gitDiff.fileError': 'Failed to load this diff',
  'gitDiff.truncated': 'Diff truncated — the file is too large to show in full',
  'gitDiff.hidden': (v) => `${v?.count ?? 0} more file(s) not shown`,
  'gitDiff.expand': (v) => `Show changes for ${v?.path ?? 'file'}`,
  'gitDiff.collapse': (v) => `Hide changes for ${v?.path ?? 'file'}`,
  'gitMode.title': 'Git mode',
  'gitMode.current': 'Current branch',
  'gitMode.currentDesc': (v) => `Develop directly on ${v?.branch ?? 'main'}`,
  'gitMode.branch': 'New branch',
  'gitMode.branchDesc': (v) =>
    `Create a new branch from ${v?.branch ?? 'main'}`,
  'gitMode.branchPlaceholder': 'feat/my-feature',
  'gitMode.branchLabel': 'Branch name',
  'gitMode.branchConflictWarning':
    'Only one branch session per workspace at a time',
  'gitMode.branchHint': 'Switches the working directory to a new branch',
  'gitMode.branchInvalidName': 'Invalid branch name',
  'gitMode.worktree': 'Worktree',
  'gitMode.worktreeDesc':
    'Creates an isolated copy when you send your first message',
  'gitMode.confirmBranch': 'Create branch',
  'gitMode.resetToCurrent': 'Reset to current branch',
  'gitLog.title': 'History',
  'gitLog.subtitle': (v) => `${v?.count ?? 0} commits`,
  'gitLog.loading': 'Loading history…',
  'gitLog.empty': 'No commits yet',
  'gitLog.unavailable': 'Git is not available for this workspace',
  'gitLog.error': 'Failed to load history',
  'gitLog.loadMore': 'Load more',
  'gitLog.loadingMore': 'Loading…',
  'gitLog.files': (v) =>
    `${v?.count ?? 0} files · +${v?.added ?? 0} −${v?.removed ?? 0}`,
  'gitLog.detailError': 'Failed to load commit details',
  'gitLog.hidden': (v) => `${v?.count ?? 0} more file(s) not shown`,
  'gitLog.copySha': (v) => `Copy commit ${v?.sha ?? ''}`,
  'gitLog.allBranches': 'All branches',
  'gitLog.search': 'Search message, author, or hash',
  'gitLog.noMatches': 'No commits match',
  'gitWorktrees.title': 'Worktrees',
  'gitWorktrees.subtitle': (v) => `${v?.count ?? 0} worktrees`,
  'gitWorktrees.loading': 'Loading worktrees…',
  'gitWorktrees.error': 'Failed to load worktrees',
  'gitWorktrees.unavailable': 'Git is not available for this workspace',
  'gitWorktrees.empty': 'No worktrees',
  'gitWorktrees.noMatches': 'No worktrees match',
  'gitWorktrees.filter': 'Filter by path or branch',
  'gitWorktrees.newSession': 'New worktree session…',
  'gitWorktrees.main': 'main',
  'gitWorktrees.current': 'this workspace',
  'gitWorktrees.detached': 'detached HEAD',
  'gitWorktrees.bare': 'bare',
  'gitWorktrees.locked': 'locked',
  'gitWorktrees.prunable': 'stale',
  'gitWorktrees.clean': 'clean',
  'gitWorktrees.dirty': (v) => `${v?.count ?? 0} change(s)`,
  'gitWorktrees.statusError': 'status unavailable',
  'gitWorktrees.remove': 'Remove',
  'gitWorktrees.removeLabel': (v) => `Remove worktree ${v?.name ?? ''}`,
  'gitWorktrees.removing': 'Removing…',
  'gitWorktrees.cancel': 'Cancel',
  'gitWorktrees.confirm':
    'Remove this worktree? Its directory is deleted from disk; the branch is kept.',
  'gitWorktrees.confirmStale':
    'Remove this stale entry? Git stops tracking worktrees it can no longer find. Whatever is left in its directory stays; the bookkeeping git keeps for it does not.',
  'gitWorktrees.confirmDetached':
    'Remove this worktree? Its directory is deleted from disk. It is on a detached HEAD, so there is no branch to keep.',
  'gitWorktrees.blockedDirty': (v) =>
    `${v?.count ?? 0} uncommitted change(s) would be discarded.`,
  'gitWorktrees.blockedInUse': (v) =>
    `${v?.count ?? 0} running session(s) would lose their checkout.`,
  'gitWorktrees.blockedInUseUnknown': (v) =>
    `Could not read where ${v?.count ?? 0} running session(s) are working. Any working here would lose their checkout.`,
  'gitWorktrees.blockedUnknown':
    'The working tree could not be checked for uncommitted changes, and any there would be discarded.',
  'gitWorktrees.blockedOperation': (v) =>
    `An unfinished ${v?.operation ?? 'git'} would be lost.`,
  'gitWorktrees.blockedUnmerged': (v) =>
    `No branch keeps the commits here; ${String(v?.head ?? '').slice(0, 7)} would be left for git to collect.`,
  'gitWorktrees.blockedLocked': (v) =>
    v?.reason
      ? `This worktree is locked: ${v.reason}`
      : 'This worktree is locked.',
  'gitWorktrees.blockedRefused': 'Git refused to remove this worktree.',
  'gitWorktrees.blockedWorkspaceHere': (v) =>
    v?.name
      ? `The workspace ${v.name} lives in this worktree, so removing it would take the workspace too. Remove the workspace first.`
      : 'A registered workspace lives in this worktree, so removing it would take the workspace too. Remove the workspace first.',
  'gitWorktrees.blockedSubmodules':
    'A submodule of this worktree keeps a repository of its own, and removing the worktree deletes that repository too.',
  'gitWorktrees.blockedSubmodulesUnknown':
    'Whether a submodule of this worktree keeps a repository of its own could not be checked. If one does, removing the worktree deletes it too.',
  'gitWorktrees.refreshFailed':
    'The list could not be refreshed, so it may be out of date.',
  'gitWorktrees.removeAnyway': 'Remove anyway',
  'gitWorktrees.removeFailed': 'Failed to remove the worktree',
  'gitWorktrees.keptDirectory': (v) =>
    `Git no longer tracks ${v?.name ?? ''}, but its directory is still on disk.`,
  'gitWorktrees.refusedElsewhere': (v) =>
    v?.reason
      ? `Removing ${v?.name ?? ''} was refused while you were looking elsewhere: ${v.reason}`
      : `Removing ${v?.name ?? ''} was refused while you were looking elsewhere.`,
  'githubPrs.title': 'Pull requests',
  'githubPrs.subtitle': (v) => `${v?.count ?? 0} open`,
  'githubPrs.loading': 'Loading pull requests…',
  'githubPrs.empty': 'No open pull requests',
  'githubPrs.unavailable': 'This workspace is not a git repository',
  'githubPrs.error': 'Failed to load pull requests',
  'githubPrs.cliUnavailable':
    'The GitHub CLI (gh) is not installed on the daemon host.\nInstall it and run `gh auth login`, then try again.',
  'githubPrs.reviewApproved': 'Approved',
  'githubPrs.reviewChanges': 'Changes requested',
  'githubPrs.reviewRequired': 'Review required',
  'githubPrs.checksPassing': 'Checks passing',
  'githubPrs.checksFailing': 'Checks failing',
  'githubPrs.checksPending': 'Checks pending',
  'githubPrs.open': (v) => `Open pull request #${v?.number ?? ''} on GitHub`,
  'sessionsOverview.bindPr': 'Bind PR',
  'sessionsOverview.bindPrPlaceholder': 'PR number or URL',
  'sessionsOverview.bindPrSubmit': 'Bind',
  'sessionsOverview.bindPrInvalid': 'Enter a PR number or a full PR URL.',
  'sessionsOverview.bindPrNotInList': (v) =>
    `PR #${v?.number ?? ''} is not in the open PR list. Paste its full URL instead.`,
  'sessionsOverview.bindPrListFailed':
    'Could not load the PR list. Paste the full PR URL instead.',
  'sessionsOverview.bindPrFailed': 'Bind PR failed',
  'sessionsOverview.bindPrUnavailable':
    'This workspace is not a git repository, so PR numbers cannot be looked up. Paste the full PR URL instead.',
  'workspace.paneLabel': (v) => `Workspace: ${v?.name ?? ''}`,
  'about.auth': 'Auth',
  'about.baseUrl': 'Base URL',
  'about.fastModel': 'Fast Model',
  'about.memoryUsage': 'Memory Usage',
  'about.model': 'Model',
  'about.noProxy': 'no proxy',
  'about.noSandbox': 'no sandbox',
  'about.platform': 'OS',
  'about.proxy': 'Proxy',
  'about.runtime': 'Runtime',
  'about.sandbox': 'Sandbox',
  'about.sessionId': 'Session ID',
  'about.title': 'Status',
  'agent.back': 'Back',
  'agent.builtInBadge': '(built-in)',
  'agent.action.delete': 'Delete Agent',
  'agent.action.edit': 'Edit Agent',
  'agent.action.view': 'View Agent',
  'agent.chooseAction': (v) => `Choose action for ${v?.name ?? ''}`,
  'agent.chooseActionTitle': 'Choose Action',
  'agent.colorLabel': 'Color: ',
  'agent.colorUpdated': (v) => `Updated color for ${v?.name ?? ''}`,
  'agent.create': 'Create a new subagent',
  'agent.create.button': 'Create',
  'agent.create.confirm': 'Confirm and Save',
  'agent.create.desc': 'Create a new subagent',
  'agent.create.descPlaceholder': 'What does this agent do?',
  'agent.create.describeAgent': 'Describe requirements',
  'agent.create.description': 'Description',
  'agent.create.editAgain': 'Edit',
  'agent.create.enterDescription': 'Enter Description',
  'agent.create.enterName': 'Enter Subagent Name',
  'agent.create.enterPrompt': 'Enter System Prompt',
  'agent.create.generateFailed': (v) =>
    `Failed to generate subagent: ${v?.error ?? 'Unknown error'}`,
  'agent.create.generate': 'Generate',
  'agent.create.generatedDescription': 'Description',
  'agent.create.generatedSystemPrompt': 'System prompt',
  'agent.create.generatingConfig': 'Generating subagent configuration...',
  'agent.create.generatingPrompt': 'Generating...',
  'agent.create.loading': 'Creating...',
  'agent.create.location': 'Choose Location',
  'agent.create.method': 'Choose Generation Method',
  'agent.create.method.manual': 'Manual Creation',
  'agent.create.method.qwen': 'Generate with Qwen Code',
  'agent.create.method.qwen.recommended':
    'Generate with Qwen Code (Recommended)',
  'agent.create.method.qwen.desc':
    'LLM generates the description and system prompt',
  'agent.create.name': 'Name',
  'agent.create.namePlaceholder': 'my-agent',
  'agent.create.nameHelp': 'Enter a clear, unique name for this subagent.',
  'agent.create.project': 'Project',
  'agent.create.project.cli': 'Workspace',
  'agent.create.project.desc': 'Create a project-level subagent',
  'agent.create.prompt': 'System prompt',
  'agent.create.promptPlaceholder': 'You are a specialized agent that...',
  'agent.create.promptPlaceholder.cli':
    'e.g., You are an expert code reviewer...',
  'agent.create.promptHelp':
    "Write the system prompt that defines this subagent's behavior. Be comprehensive for best results.",
  'agent.create.preview': 'Preview',
  'agent.create.qwenHint':
    'Explain the responsibilities, usage scenarios, and important constraints, then generate each field separately.',
  'agent.create.qwenPlaceholder':
    '> e.g., Expert code reviewer that reviews code based on best practices...',
  'agent.create.regenerate': 'Regenerate draft',
  'agent.create.required': 'Name, description, and system prompt are required.',
  'agent.create.tools': 'Allowed tools',
  'agent.create.toolsHelp':
    'Enter canonical tool names separated by commas or lines. MCP tools use mcp__server__tool; leave blank to inherit all tools.',
  'agent.create.disallowedTools': 'Disallowed tools',
  'agent.create.model': 'Model',
  'agent.create.approvalMode': 'Approval mode',
  'agent.create.maxTurns': 'Maximum execution turns',
  'agent.create.maxTurnsHelp':
    'Limits the model reasoning rounds for a single task. Execution stops at the limit; leave blank for no agent-specific limit.',
  'agent.create.maxTurnsInvalid':
    'Maximum execution turns must be a positive integer.',
  'agent.create.mcpServers': 'MCP servers',
  'agent.create.mcpServers.empty': 'No MCP servers are available.',
  'agent.create.mcpServers.select': 'Select an MCP Server',
  'agent.create.mcpServers.noneSelected': 'No MCP Servers selected.',
  'agent.create.modelGenerate': 'Generate with model',
  'agent.create.modelGenerate.description':
    'Describe what you need, then generate and review the description and system prompt separately.',
  'agent.create.color': 'Color',
  'agent.create.jsonObjectHelp': 'Enter a JSON object, or leave blank.',
  'agent.create.save': 'Save Agent',
  'agent.create.scope': 'Category',
  'agent.create.manualDescHelp':
    'Describe when and how this subagent should be used.',
  'agent.create.manualDescPlaceholder':
    'e.g., Reviews code for best practices and potential bugs.',
  'agent.create.tools.builtin': 'Built-in tools',
  'agent.create.tools.empty': 'No tools are available.',
  'agent.create.tools.mcp': 'MCP tools',
  'agent.create.tools.type': 'Tool type',
  'agent.create.tools.selectServer': 'Select an MCP Server',
  'agent.create.tools.selectTool': 'Select a tool',
  'agent.create.tools.noneSelected': 'No tools selected.',
  'agent.create.tools.initializing': 'Initializing tool catalogs...',
  'agent.create.tools.preheatFailed': 'ACP preheating did not complete.',
  'agent.create.tools.loadFailed': 'Failed to load built-in tools.',
  'agent.create.removeSelection': (v) => `Remove ${v?.name ?? ''}`,
  'agent.create.toolsSelectHelp':
    'Select the tools this subagent may use. Leave all unchecked to inherit all tools.',
  'agent.create.toolsSelection': 'Select Tools',
  'agent.create.tools.all': 'All Tools',
  'agent.create.tools.allDefault': 'All Tools (Default)',
  'agent.create.tools.allInfo': 'All tools selected, including MCP tools',
  'agent.create.tools.allInfoFallback':
    'All tools selected, including MCP tools',
  'agent.create.tools.editLabel': '• Edit tools:',
  'agent.create.tools.executionLabel': '• Execution tools:',
  'agent.create.tools.none': '(none)',
  'agent.create.tools.readEdit': 'Read & Edit Tools',
  'agent.create.tools.readEditExecute': 'Read & Edit & Execution Tools',
  'agent.create.tools.readOnlyLabel': '• Read-only tools:',
  'agent.create.tools.readOnly': 'Read-only Tools',
  'agent.create.tools.selected': 'Selected tools:',
  'agent.create.user': 'User',
  'agent.create.user.cli': 'Global',
  'agent.create.user.desc': 'Create a user-level subagent',
  'agent.create.useGenerated': 'Use this draft',
  'agent.approval.inherit': 'Default',
  'agent.approval.default': 'Default approval',
  'agent.approval.plan': 'Plan only',
  'agent.approval.auto-edit': 'Automatically approve edits',
  'agent.approval.yolo': 'Automatically approve all actions',
  'agent.approval.bubble': 'Bubble approval',
  'agent.approval.desc.inherit': "Use the subagent's default approval rules.",
  'agent.approval.desc.bubble':
    'Forward tool approval requests to the parent session.',
  'agent.createFirstHint':
    "Use '/agents create' to create your first subagent.",
  'agent.created': (v) => `Created ${v?.name ?? ''}`,
  'agent.edit.save': 'Save changes',
  'agent.updated': (v) => `Updated ${v?.name ?? ''}`,
  'agent.turnsBadge': (v) => `${v?.count ?? 0} turns`,
  'agent.delete': 'Delete',
  'agent.delete.confirm': (v) =>
    `Are you sure you want to delete "${v?.name ?? ''}"?`,
  'agent.delete.loading': 'Deleting...',
  'agent.delete.no': 'No',
  'agent.delete.title': (v) => `Delete ${v?.name ?? ''}`,
  'agent.delete.yes': 'Yes, delete',
  'agent.deleted': (v) => `Deleted ${v?.name ?? ''}`,
  'agent.edit': 'Edit',
  'agent.edit.color': 'Edit Color',
  'agent.edit.tools': 'Edit Tools',
  'agent.editColorTitle': (v) => `Edit Color: ${v?.name ?? ''}`,
  'agent.editTitle': (v) => `Edit ${v?.name ?? ''}`,
  'agent.empty': 'No subagents found.',
  'agent.noMatches': 'No matching subagents found.',
  'agent.footer.back': 'Esc to go back',
  'agent.footer.cliBack': 'Enter to select, ↑↓ to navigate, Esc to go back',
  'agent.footer.cliSelect': 'Enter to select, ↑↓ to navigate, Esc to close',
  'agent.footer.close': 'Esc to close',
  'agent.footer.deleteConfirm': 'Enter to confirm, Esc to cancel',
  'agent.footer.enterNext': 'Press Enter to continue, Esc to go back',
  'agent.footer.generating': 'Esc to cancel',
  'agent.footer.createLocation':
    'Press Enter to continue, ↑↓ to navigate, Esc to cancel',
  'agent.footer.createContinue':
    'Press Enter to continue, ↑↓ to navigate, Esc to go back',
  'agent.footer.final':
    'Press Enter to save, e to save and edit, Esc to go back',
  'agent.footer.nav': '↑↓ navigate · Enter select · Esc back',
  'agent.footer.navBack': '↑↓ navigate · Enter select · Esc back',
  'agent.footer.navSelect': '↑↓ navigate · Enter select · Esc close',
  'agent.footer.viewerBack': 'Esc to go back',
  'agent.filePathLabel': 'File Path: ',
  'agent.label': 'Agent',
  'agent.location': 'Location',
  'agent.level.builtin': 'Built-in',
  'agent.level.extension': 'Extension',
  'agent.level.project': 'Project',
  'agent.level.user': 'User',
  'agent.level.filter': 'Filter by agent level',
  'agent.manage': 'Manage',
  'agent.manage.desc': 'Manage existing subagents',
  'agent.modelLabel': 'Model: ',
  'agent.overriddenBadge': '(overridden by project level agent)',
  'agent.readonly': 'This agent is read-only.',
  'agent.select': 'Select an agent.',
  'agent.selectAction': 'Select an action',
  'agent.descriptionLabel': 'Description:',
  'agent.systemPromptLabel': 'System Prompt:',
  'agent.level.label': 'Level',
  'agent.step': (v) => `Step ${v?.n ?? ''}`,
  'agent.tools': 'Tools',
  'agent.toolsLabel': 'Tools: ',
  'agent.detail.overview': 'Basic Information',
  'agent.detail.tools': 'Tools',
  'agent.detail.mcp': 'MCP',
  'agent.detail.hooks': 'Hooks',
  'agent.detail.systemPrompt': 'System Prompt',
  'agent.toolsUpdated': (v) => `Updated tools for ${v?.name ?? ''}`,
  'agent.usingCount': (v) => `Using: ${v?.count ?? 0} agents`,
  'agent.view': 'View',
  'agents.closed': 'Agents panel closed.',
  'agents.title': 'Agents',
  'subagent.result': 'Result',
  'subagent.tools': (v) => `Tools (${v?.count ?? 0})`,
  'subagent.toolsCount': (v) => `${v?.count ?? 0} tools`,
  'subagent.toggleStream': 'Toggle agent stream details',
  'subagent.creating': 'Creating…',
  'subagent.pending': 'pending',
  'subagent.running': 'running',
  'subagent.background': 'background task',
  'subagent.completed': 'completed',
  'subagent.failed': 'failed',
  'subagent.cancelled': 'cancelled',
  'subagent.paused': 'paused',
  'subagent.detailsLoading': 'Loading agent details…',
  'subagent.detailsLoadFailed': 'Failed to load agent details.',
  'agentType.general-purpose': 'General-purpose',
  'agentType.explore': 'Explore',
  'agentType.statusline-setup': 'Status Line Setup',
  'agentType.review-agent': 'Review Agent',
  'agentType.test-engineer': 'Test Engineer',
  'agentType.fork': 'Fork',
  'timeline.parallelAgents': 'Parallel agents',
  'timeline.thinking': 'Thinking',
  'timeline.assistantUpdate': 'Assistant update',
  'timeline.toolCalls': (v) =>
    `${v?.count ?? 0} tool call${v?.count === 1 ? '' : 's'}`,
  'timeline.planUpdate': 'Plan update',
  'timeline.statusUpdate': 'Status update',
  'timeline.userTurn': 'User turn',
  'timeline.planDetail': 'plan update',
  'timeline.parallelAgentsDetail': (v) =>
    `${v?.count ?? 0} parallel agent${v?.count === 1 ? '' : 's'}`,
  'timeline.noActivity': 'No activity',
  'timeline.sessionTimeline': 'Session timeline',
  'timeline.turnPrefix': (v) => `Turn ${v?.index ?? 0}`,
  'timeline.currentTurn': 'Current turn',
  'timeline.kind.thought': 'thinking',
  'timeline.kind.commentary': 'assistant update',
  'timeline.kind.tool': 'tool calls',
  'timeline.kind.agents': 'parallel agents',
  'timeline.kind.plan': 'plan update',
  'timeline.kind.status': 'status update',
  'timeline.kind.none': 'turn',
  'common.copy': 'Copy',
  'common.download': 'Download',
  'common.downloading': 'Downloading…',
  'common.downloadFailed': (v) => `Download failed: ${v?.message ?? ''}`,
  'common.open': 'Open',
  'common.openFailed': (v) => `Could not open link: ${v?.message ?? ''}`,
  'excel.worksheet': 'Worksheet',
  'excel.row': 'Row',
  'excel.truncated': (v) =>
    `Preview limited to ${v?.cells} cells per worksheet. Download the original for all content.`,
  'excel.previousWorksheets': 'Previous worksheets',
  'excel.nextWorksheets': 'Next worksheets',
  'excel.empty': 'This worksheet is empty.',
  'excel.notCalculated': 'Not calculated',
  'excel.tooLarge':
    'Excel preview supports files up to 10 MiB. Download the original to open it.',
  'excel.invalid':
    'Unable to preview this workbook. It may be damaged, password protected, too complex, or unsupported by this browser. You can download the original.',
  'excel.timeout':
    'This workbook took too long to preview. Download the original to open it.',
  'docx.tooLarge':
    'DOCX preview supports files up to 10 MiB. Download the original to open it.',
  'docx.invalid':
    'Unable to preview this DOCX document. You can download the original.',
  'docx.timeout':
    'This document took too long to preview. Download the original or try again.',
  'artifact.openLink': 'Open link',
  'artifact.longDocument': 'File is large. Source is shown by default.',
  'artifact.renderFullPreview': 'Render full preview',
  'artifact.registrationFailed': (v) =>
    `Could not add exported artifact: ${v?.message ?? ''}`,
  'artifact.previewFailed': (v) =>
    `Could not load preview: ${v?.message ?? ''}`,
  'artifact.showSource': 'Show source',
  'common.na': 'N/A',
  'common.server': 'Server',
  'common.agent': 'Agent',
  'common.auto': 'auto',
  'common.runtime': 'Runtime',
  'common.failedToLoad': 'Failed to load',
  'auth.notSet': '(not set)',
  'auth.apiKeyPlaceholder': 'sk-...',
  'auth.modelsPlaceholder': 'model-id-1, model-id-2',
  'model.usingModel': (v) =>
    `Using ${v?.isRuntime ? 'runtime ' : ''}model: ${v?.modelId ?? ''}`,
  'mermaid.label': 'mermaid',
  'mermaid.errorLabel': 'mermaid (error)',
  'user.uploadedImage': (v) => `User uploaded image ${v?.index ?? 1}`,
  'resume.failedToLoad': 'Failed to load sessions',
  'toast.dismiss': 'Dismiss notification',
  'toast.dismissShort': 'Dismiss',
  'insight.ready': 'Insight report generated successfully!',
  'request.cancelled': 'Request cancelled.',
  'visionBridge.model': 'vision model',
  'visionBridge.skipped': (v) =>
    `Vision bridge cancelled.${v?.egressOccurred === 1 ? ` Your image and prompt/context were sent to ${v?.target ?? ''}.` : ''}`,
  'visionBridge.failed': (v) =>
    v?.egressOccurred === 1
      ? `Vision bridge (${v?.modelName ?? ''}) failed: the vision model request failed. Your image and prompt/context were sent to ${v?.target ?? ''}. The image was not interpreted.`
      : `Vision bridge (${v?.target ?? ''}) failed: the vision bridge could not run. The image was not interpreted.`,
  'visionBridge.ok': (v) =>
    `Converted ${v?.convertedCount ?? 0} image(s)${Number(v?.omittedCount ?? 0) > 0 ? ` (${v?.omittedCount ?? 0} image(s) omitted)` : ''} to text via ${v?.target ?? ''}.${v?.egressOccurred === 1 ? ' Your image and prompt/context were sent to that model.' : ''}`,
  'approval.goal.title': 'Confirm session goal',
  'approval.goal.overview': 'Goal overview',
  'approval.goal.full': 'Full content',
  'approval.goal.outcome': 'Outcome',
  'approval.goal.doneWhen': 'Completion criteria',
  'approval.goal.mustNot': 'Constraints',
  'approval.goal.budget': 'Budget',
  'approval.goal.onBlock': 'When blocked',
  'approval.goal.context': 'Context',
  'approval.goal.confirm': 'Set goal and continue',
  'approval.goal.reject': 'Not now',
  'approval.goal.hint':
    'Setting this goal continues execution and checks progress after each turn. Blockers will be reported.',
  'approval.goal.pending': 'Submitting…',
  'approval.goal.failed': 'Could not submit your choice. Please try again.',
  'approval.execQuestion': (v) => `Allow execution of: '${v?.tool ?? ''}'?`,
  'approval.changeQuestion': 'Apply this change?',
  'approval.launchAgentQuestion': 'Launch this agent?',
  'approval.explain': 'Explain',
  'approval.explanation': 'Command explanation',
  'approval.explaining': 'Explaining…',
  'approval.explanationThinking': 'Thinking…',
  'approval.explanationFailed': 'Explanation failed',
  'approval.reExplain': 'Explain again',
  'approval.option.allowOnce': 'Yes, allow once',
  'approval.option.approvalScopes': 'Approval options',
  'approval.option.allowOnceAndSwitchToDefault':
    'Allow once and switch to Default mode',
  'approval.option.restorePrevious': 'Yes, restore previous mode',
  'approval.option.rejectOnce': 'Reject',
  'approval.option.allowAllEdits': 'Allow All Edits',
  'approval.option.allowAlwaysProject': 'Always allow in this project',
  'approval.option.allowAlwaysUser': 'Always allow for this user',
  'approval.option.allowAlwaysServer': 'Always allow for this server',
  'approval.option.allowAlwaysTool': 'Always allow for this tool',
  'assistant.branch': 'New chat from here',
  'assistant.copyContent': 'Copy content',
  'hooks.title': 'Hook statistics',
  'hooks.thisTurn': 'This turn · main agent',
  'hooks.executions': 'Runs',
  'hooks.blocked': 'Blocked',
  'hooks.unsuccessful': 'Failed',
  'hooks.duration': 'Total time',
  'hooks.compactSummary': (v) =>
    `${v?.executions ?? 0} runs · ${v?.blocked ?? 0} blocked · ${v?.unsuccessful ?? 0} failed · ${v?.duration ?? '—'}`,
  'hooks.partial': 'Partial records. Totals cover recorded executions only.',
  'hooks.more': 'More reply actions',
  'hooks.loading': 'Loading hooks…',
  'hooks.loadFailed': 'Could not load hook records.',
  'hooks.retry': 'Retry',
  'hooks.loadMore': 'Load 50 more',
  'hooks.type': 'Hook type',
  'hooks.started': 'Started',
  'hooks.ended': 'Ended',
  'hooks.exitCode': 'Exit code',
  'hooks.dispatchDuration': 'Dispatch duration',
  'hooks.dispatchHelp':
    'Dispatched to background. Final result is not collected.',
  'hooks.unknownHelp':
    'The terminal result was not recorded or the connection was interrupted.',
  'hooks.status.running': 'Running',
  'hooks.status.unknown': 'Outcome unavailable',
  'hooks.status.dispatched': 'Dispatched to background',
  'hooks.status.success': 'Succeeded',
  'hooks.status.blocked': 'Blocked',
  'hooks.status.error': 'Failed',
  'hooks.status.timeout': 'Timed out',
  'hooks.status.cancelled': 'Cancelled',
  'hooks.source.system': 'System',
  'hooks.source.user': 'User',
  'hooks.source.project': 'Project',
  'hooks.source.extensions': 'Extension',
  'hooks.source.session': 'Session',
  'hooks.source.unknown': 'Unknown source',
  'hooks.coverage.recorded': 'No hook executions recorded.',
  'hooks.coverage.unrecorded':
    'Hook executions were not recorded for this turn.',
  'hooks.coverage.unsupported':
    'Hook statistics are not supported for this runtime.',
  'hooks.coverage.partial':
    'No executions are available in the retained records.',
  'assistant.selectionCopy': 'Copy selection',
  'assistant.copyPlainText': 'Copy plain text',
  'assistant.copyMarkdown': 'Copy Markdown',
  'assistant.copyMarkdownSource': 'Copy Markdown source',
  'assistant.dissatisfied': 'Not satisfied',
  'assistant.satisfied': 'Satisfied',
  // A workspace agent's reply in a chat session. These render in exported
  // transcripts too, so they live here rather than in the collab dictionary.
  'agentMessage.status.failed': 'Failed',
  'agentMessage.status.cancelled': 'Stopped',
  'agentMessage.status.offline': 'Runtime offline',
  'agentMessage.tokens': (v) => `${v?.count ?? 0} tokens`,
  'agentMessage.steps': 'Steps',
  'agentMessage.noAction': (v) => `${v?.name ?? ''} had nothing to do`,
  'agentMessage.step.running': 'Running',
  'agentMessage.step.completed': 'Done',
  'agentMessage.step.failed': 'Failed',
  'agentMessage.step.stopped': 'Stopped',
  'at.category.extensions': 'Extensions',
  'at.category.extensions.description': 'Reference active extensions',
  'at.category.files': 'Files',
  'at.category.files.description': 'Reference workspace files',
  'at.files.upload': 'Upload file',
  'at.files.upload.description': 'Upload a file into this folder',
  'composer.upload.pending': 'Waiting',
  'composer.upload.uploading': 'Uploading',
  'composer.upload.done': 'Uploaded',
  'composer.upload.error': 'Failed',
  'composer.upload.error.noDaemon': 'No daemon connection',
  'composer.upload.error.tooLarge': (v) =>
    `File exceeds the ${v?.limit ?? ''} upload limit`,
  'composer.upload.error.tooManyFiles': (v) =>
    `${v?.count ?? 0} more files were not added (limit per batch)`,
  'composer.upload.cancel': 'Cancel upload',
  'composer.upload.dismiss': 'Dismiss',
  'composer.upload.renamed': 'Saved as',
  'composer.upload.drop': 'Drop files',
  'composer.dropChoice.title': (v) =>
    Number(v?.count) === 1
      ? 'Add dropped file'
      : `Add ${v?.count ?? 0} dropped files`,
  'composer.dropChoice.description':
    'Attach the files to this message for the agent to read, or upload them to the workspace and insert @ references.',
  'composer.dropChoice.cancel': 'Cancel',
  'composer.dropChoice.upload': 'Upload to workspace',
  'composer.dropChoice.reference': 'Attach to message',
  'composer.dropChoice.moreFiles': (v) => `and ${v?.count ?? 0} more files`,
  'composerAdd.trigger': 'Add to message',
  'composerMobile.expand': 'Expand editor',
  'composerMobile.advancedMode': 'Switch to advanced mode',
  'composerMobile.simpleMode': 'Switch to simple mode',
  'composerMobile.hideKeyboard': 'Hide keyboard',
  'composerMobile.done': 'Done',
  'composerMobile.photos': 'Photos',
  'composerMobile.camera': 'Take photo',
  'composerMobile.files': 'Attach files',
  'composerMobile.commands': 'All commands',
  'composerMobile.searchCommands': 'Search commands',
  'composerMobile.history': 'Input history',
  'composerMobile.stop': 'Stop',
  'composerMobile.attachments': (v) =>
    `Attached files/images: ${v?.count ?? 0}`,
  'composerAdd.emptyState': 'No add actions are available here',
  'composerAdd.noResults': 'No results',
  'composerAdd.loadError': 'Failed to load results',
  'composerAdd.unavailable': 'Unavailable',
  'composerAdd.file.label': 'Add file',
  'composerAdd.file.description': 'Attach or upload files',
  'composerAdd.file.attachDisabled': 'Message attachments are unavailable',
  'composerAdd.file.uploadDisabled': 'Workspace upload is unavailable',
  'composerAdd.referenceFile.label': 'Reference file',
  'composerAdd.referenceFile.description': 'Reference files or folders',
  'composerAdd.referenceFile.searchPlaceholder': 'Search workspace files',
  'composerAdd.extensions.label': 'Extensions',
  'composerAdd.extensions.description': 'Reference enabled extensions',
  'composerAdd.extensions.empty': 'No extensions are enabled',
  'composerAdd.mcp.label': 'MCP',
  'composerAdd.mcp.description': 'Reference an MCP server',
  'composerAdd.mcp.empty': 'No MCP servers are available',
  'managed.mcp.catalog': (v) =>
    `Catalog snapshot: ${plural(v?.tools, 'tool')} (${v?.toolsState}); ${plural(v?.resources, 'resource')} (${v?.resourcesState}); ${plural(v?.prompts, 'prompt')} (${v?.promptsState})`,
  'managed.mcp.discovery.complete': 'complete',
  'managed.mcp.discovery.partial': 'partial',
  'managed.mcp.discovery.failed': 'failed',
  'managed.mcp.discovery.stale': 'stale',
  'composerAdd.skills.label': 'Skills',
  'composerAdd.skills.description': 'Use specialized skills',
  'composerAdd.plan.label': 'Plan mode',
  'composerAdd.plan.description': 'Plan first, run after you approve',
  'composerAdd.plan.busy': 'Switching mode',
  'composerAdd.btw.label': 'Ask a side question',
  'composerAdd.btw.description': 'Keep the main task running',
  'composerAdd.btw.textOnly': 'Remove attachments first',
  'local.send': 'Send a message to another session',
  'send.noAttachments': '/send takes text only; remove the attachments first',
  'send.workspaceLocked':
    'This view can only send to and open sessions in its workspace.',
  'send.missingMessage':
    'Add the message after the options: /send [--workspace <name>] [--session-id <id>] <message>',
  'send.missingValue': (v) => `${v?.option ?? ''} needs a value`,
  'send.duplicateOption': (v) => `${v?.option ?? ''} is given twice`,
  'send.option.workspace': 'Workspace to send to (default: this one)',
  'send.option.sessionId': 'Session to send to (default: a new one)',
  'at.category.mcpResources': 'MCP resources',
  'at.category.mcpResources.description': 'Reference MCP server resources',
  'at.menu': 'Reference menu',
  'common.back': 'back',
  'common.all': 'All',
  'common.add': 'add',
  'common.cancel': 'cancel',
  'common.close': 'close',
  'common.done': 'Done',
  'common.fullscreen': 'Fullscreen',
  'common.exitFullscreen': 'Exit fullscreen',
  'common.continue': 'continue',
  'common.current': 'current',
  'common.disabled': 'disabled',
  'common.enabled': 'enabled',
  'common.enterSelect': 'Enter to select',
  'common.invalid': 'invalid',
  'common.loading': 'Loading...',
  'common.retry': 'Try again',
  'session.recovery.interrupted_prompt':
    'The previous request was interrupted before the response completed.',
  'session.recovery.interrupted_turn':
    'The previous task was interrupted. Some tool results were not saved.',
  'session.recovery.degraded_history':
    'Conversation history is incomplete. The interrupted task cannot be continued.',
  'session.recovery.continue': 'Continue execution',
  'session.recovery.confirmContinue': 'Confirm and continue',
  'session.recovery.continuing': 'Continuing…',
  'session.recovery.failed': 'Could not continue the conversation.',
  'session.recovery.unknownCancellation':
    'This older session was cancelled, but the reason was not recorded. Confirm before continuing.',
  'session.recovery.confirmCancellation':
    'This turn may have been stopped intentionally. Do you want to continue it?',
  'session.archived': 'This conversation is archived',
  'session.archivedDescription':
    'Unarchive it before opening the conversation.',
  'session.capabilitiesFailed':
    'The daemon capabilities could not be loaded. Try again before opening this conversation.',
  'session.contextConflict':
    'A standalone or Live conversation link cannot include a workspace target.',
  'session.loadFailed': 'Failed to load conversation',
  'session.splitAddFailed':
    'Some sessions could not be added to Split View. Please try again.',
  'session.notFound': 'Conversation not found',
  'session.notFoundDescription':
    'This standalone conversation no longer exists.',
  'session.resolving': 'Opening conversation...',
  'session.standaloneUnavailable': 'Standalone conversations are unavailable',
  'session.standaloneUpgradeRequired':
    'Upgrade the daemon to open standalone conversations.',
  'session.stillCreating':
    'The conversation is still being created. Try checking again.',
  'session.recoveryPending':
    'Creation may have succeeded, but the result could not be confirmed. Sending is paused to avoid creating a duplicate conversation.',
  'session.recoveryChecking': 'Checking the reserved conversation ID...',
  'session.recoveryStillCreating':
    'The conversation is still being created. Check again in a moment.',
  'session.recoveryAbsent':
    'No conversation exists for the reserved ID. You can explicitly start a fresh conversation.',
  'session.recoveryUnknown':
    'The creation result is still unknown. Check again before starting another conversation.',
  'session.recoveryArchived':
    'The recovered conversation is archived. Unarchive it before opening.',
  'session.recoveryCheckFailed': 'Failed to check conversation creation',
  'session.recoveryBlocksAction':
    'Resolve the pending standalone conversation state before continuing.',
  'session.checkStatus': 'Check status',
  'session.retryCreation': 'Start a fresh conversation',
  'session.writerBlocked':
    'Another Qwen process or an unresolved writer lock may be blocking this conversation. Close it in other processes and try again. If it still fails, check local daemon diagnostics before recovery.',
  'session.directoryRecreated':
    'The transcript was recovered, but files from the previous private directory were not available.',
  'session.directoryMissing':
    "This conversation's private working directory is missing. Repair it before sending another prompt.",
  'session.directoryCompromised':
    'This private working directory is unsafe and cannot be repaired automatically. Export the transcript, then delete the conversation.',
  'session.repair': 'Repair directory',
  'session.repairing': 'Repairing...',
  'session.repairFailed': 'Failed to repair the private working directory',
  'session.repairSucceeded': 'The private working directory was repaired.',
  'session.unarchive': 'Unarchive',
  'session.unarchiveFailed': 'Failed to unarchive this conversation.',
  'session.workspaceActionUnavailable':
    'This action is available only in project conversations.',
  'common.save': 'save',
  'common.navigate': '↑↓ to navigate',
  'common.next': 'next',
  'common.noResults': 'No results',
  'common.previous': 'previous',
  'common.expand': 'Expand',
  'common.collapse': 'Collapse',
  'common.refresh': 'Refresh',
  'common.search': 'Search',
  'common.valid': 'valid',
  'common.clients': (v) => `${v?.count ?? 0} clients`,
  'agent.count': (v) => `${v?.count ?? 0} agents`,
  'askUser.submit': 'Submit',
  'askUser.submitting': 'Submitting...',
  'askUser.submitFailed': 'Failed to submit answer',
  'askUser.submitOptionUnavailable': 'Submit option is unavailable',
  'askUser.ignore': 'Ignore',
  'askUser.askDetails': 'Ask for details',
  'askUser.askDetailsHint':
    'Open a side task that explains this question before you answer',
  'askUser.detailsPrompt': (v) =>
    `${v?.questions ?? ''}

The main session is waiting for me to answer the questions above. I want to understand the details before answering. Read the relevant code and context first. Base every claim on what you verify, and mark anything unverified.

Write the explanation as a self-contained single-file HTML (inline CSS, no external resources). Language requirement: write the entire page in English — every heading, body sentence, list item, and label must be in English; do not mix in another language. Borrow the ASD-STE100 controlled-language sentence rules: one idea per sentence, active voice, short sentences (about 20 words max), one term per concept, conditions before actions, lists for three or more items, no metaphors or exclamations. Keep code, commands, paths, and config keys verbatim. Cover the background of each question, every option's meaning, differences, impact and risks, and a recommendation with reasons. Do not answer the questions for me and do not change the main session. Save the file under .qwen/tmp/ (for example .qwen/tmp/ask-details.html), then reply with its path and a one-sentence summary.`,
  'askUser.multiHint': 'multiple choice',
  'askUser.progress': (v) => `${v?.current ?? 0}/${v?.total ?? 0} questions`,
  'askUser.selectAnswer': 'Select an answer',
  'askUser.typePlaceholder': 'Type something...',
  'askUser.shortcuts.previous': '← previous',
  'askUser.shortcuts.optionsSingle': '↑↓ select · Enter submit',
  'askUser.shortcuts.optionsNext': '↑↓ select · Enter next',
  'askUser.shortcuts.optionsFinal': '↑↓ select · Enter submit',
  'askUser.shortcuts.multiSingle':
    '↑↓ move · Space select/deselect · Enter select & submit',
  'askUser.shortcuts.multiNext':
    '↑↓ move · Space select/deselect · Enter select & next',
  'askUser.shortcuts.multiFinal':
    '↑↓ move · Space select/deselect · Enter select & submit',
  'askUser.shortcuts.customTrigger': '↑↓ select · Enter edit',
  'askUser.shortcuts.customTriggerMulti': '↑↓ move · Enter edit',
  'askUser.shortcuts.inputEmpty': 'Type an answer · Esc stop editing',
  'askUser.shortcuts.inputSingle': 'Enter submit · Esc stop editing',
  'askUser.shortcuts.inputNext': 'Enter next · Esc stop editing',
  'askUser.shortcuts.inputFinal': 'Enter submit · Esc stop editing',
  'copy.failedFallback': 'Failed to copy to the clipboard',
  'copy.inlineLatexMissing':
    'No matching inline LaTeX expression found in the last AI output.',
  'copy.latexMissing': 'No matching LaTeX block found in the last AI output.',
  'copy.noOutput': 'No output in history',
  'copy.noText': 'Last AI output contains no text to copy.',
  'copy.codeMissing': 'No matching code block found in the last AI output.',
  'copy.outputCopied': 'Last output copied to the clipboard',
  'copy.toClipboard': (v) =>
    `${v?.label ?? 'Selection'} copied to the clipboard`,
  'code.copy': 'Copy',
  'code.copied': 'Copied!',
  'echartsChart.noData': 'No data',
  'echartsChart.tableNotice': (v) => {
    const omittedRows = Number(v?.omittedRows ?? 0);
    const omittedColumns = Number(v?.omittedColumns ?? 0);
    if (omittedRows > 0 && omittedColumns > 0) {
      return `Showing ${v?.visibleRows ?? 0} of ${v?.totalRows ?? 0} rows and ${v?.visibleColumns ?? 0} of ${v?.totalColumns ?? 0} columns`;
    }
    if (omittedColumns > 0) {
      return `Showing ${v?.visibleColumns ?? 0} of ${v?.totalColumns ?? 0} columns`;
    }
    return `Showing ${v?.visibleRows ?? 0} of ${v?.totalRows ?? 0} rows`;
  },
  'echartsChart.rendering': 'Rendering chart',
  'echartsChart.renderFailed': 'Chart render failed.',
  'echartsChart.viewMode': 'View mode',
  'echartsChart.showChart': 'Show chart',
  'echartsChart.showData': 'Show data',
  'echartsChart.chart': 'Chart',
  'echartsChart.data': 'Data',
  'echartsChart.nodes': 'Nodes',
  'echartsChart.links': 'Links',
  'echartsChart.name': 'Name',
  'echartsChart.category': 'Category',
  'echartsChart.id': 'ID',
  'echartsChart.source': 'Source',
  'echartsChart.target': 'Target',
  'echartsChart.value': 'Value',
  'echartsChart.depth': 'Depth',
  'echartsChart.path': 'Path',
  'echartsChart.idPath': 'ID path',
  'echartsChart.subtreeTotal': 'Subtree total (derived)',
  'markdownTable.blank': '(blank)',
  'markdownTable.column': (v) => `Column ${v?.index ?? ''}`,
  'markdownTable.rows': (v) => {
    const count = Number(v?.count ?? 0);
    return `${count} row${count === 1 ? '' : 's'}`;
  },
  'markdownTable.rowsFiltered': (v) =>
    `${v?.visible ?? 0}/${v?.total ?? 0} rows`,
  'markdownTable.hint': 'Click headers to sort, open filters from ▾.',
  'markdownTable.filtersActive': (v) => {
    const count = Number(v?.count ?? 0);
    return `${count} filter${count === 1 ? '' : 's'}`;
  },
  'markdownTable.selection.selected': 'Selected',
  'markdownTable.selection.nonEmpty': 'Non-empty',
  'markdownTable.selection.numeric': 'Numeric',
  'markdownTable.selection.statistics': 'Numeric selection statistics',
  'markdownTable.selection.sum': 'Sum',
  'markdownTable.selection.average': 'Average',
  'markdownTable.selection.min': 'Min',
  'markdownTable.selection.max': 'Max',
  'markdownTable.copyTsv': 'Copy text',
  'markdownTable.copyTsvHint': 'Copy text for pasting into spreadsheet apps',
  'markdownTable.copyVisible': 'Copy',
  'markdownTable.copyMarkdown': 'Copy Markdown',
  'markdownTable.customColumns': 'Custom columns',
  'markdownTable.customColumns.tableSection': 'Columns shown in the table',
  'markdownTable.customColumns.detailSection': 'Fields shown in expanded rows',
  'markdownTable.customColumns.toggleAllTable': 'Toggle all table columns',
  'markdownTable.customColumns.toggleAllDetails':
    'Toggle all expanded-row fields',
  'markdownTable.customColumns.reset': 'Reset',
  'markdownTable.customColumns.noDetails': 'No expanded-row fields selected.',
  'markdownTable.freezeFirstColumn': 'Freeze first column',
  'markdownTable.unfreezeFirstColumn': 'Unfreeze first column',
  'markdownTable.densityLabel': 'Table density',
  'markdownTable.densityCurrent': (v) => `${v?.density ?? ''} density`.trim(),
  'markdownTable.density': (v) => `Density: ${v?.density ?? ''}`,
  'markdownTable.density.standard': 'Standard',
  'markdownTable.density.compact': 'Compact',
  'markdownTable.density.comfortable': 'Comfortable',
  'markdownTable.expandLongText': 'Expand text',
  'markdownTable.collapseLongText': 'Collapse text',
  'markdownTable.emptyValue': '(blank)',
  'markdownTable.hideColumn': 'Hide column',
  'markdownTable.showHiddenColumns': (v) => {
    const count = Number(v?.count ?? 0);
    return `Show ${count} hidden column${count === 1 ? '' : 's'}`;
  },
  'markdownTable.moveColumn': (v) => `Move ${v?.column ?? ''}`,
  'markdownTable.resizeColumn': (v) => `Resize ${v?.column ?? ''}`,
  'markdownTable.rowDetails': 'Details',
  'markdownTable.rowDetailsAria': (v) =>
    `View details for row ${v?.index ?? ''}`,
  'markdownTable.closeRowDetailsAria': (v) =>
    `Hide details for row ${v?.index ?? ''}`,
  'markdownTable.detailsHeader': 'Row details',
  'markdownTable.cellDialogTitle': 'Current field value',
  'markdownTable.copyCell': 'Copy',
  'markdownTable.close': 'Close',
  'markdownTable.actions': 'Actions',
  'markdownTable.sortByColumn': (v) => `Sort by ${v?.column ?? ''}`,
  'markdownTable.sortByColumnAsc': (v) =>
    `Sort by ${v?.column ?? ''}, ascending`,
  'markdownTable.sortByColumnDesc': (v) =>
    `Sort by ${v?.column ?? ''}, descending`,
  'markdownTable.filterColumn': (v) => `Filter ${v?.column ?? ''}`,
  'markdownTable.empty': 'This table has no data.',
  'markdownTable.emptyFiltered': 'No rows match the filters.',
  'markdownTable.sort.asc': 'Sort ascending',
  'markdownTable.sort.desc': 'Sort descending',
  'markdownTable.sort.clear': 'Clear sort',
  'markdownTable.filter.searchPlaceholder': 'Search filter values',
  'markdownTable.filter.searchAria': (v) => `Search ${v?.column ?? ''}`,
  'markdownTable.filter.selectVisible': 'Select current results',
  'markdownTable.filter.optionLimit': (v) =>
    `Showing first ${v?.count ?? 0} items. Search to narrow results.`,
  'markdownTable.filter.noOptions': 'No matches',
  'markdownTable.filter.custom': 'Custom filter',
  'markdownTable.filter.numberAria': (v) =>
    `Number filter for ${v?.column ?? ''}`,
  'markdownTable.filter.textAria': (v) => `Text filter for ${v?.column ?? ''}`,
  'markdownTable.filter.numberPlaceholder': 'Value',
  'markdownTable.filter.toPlaceholder': 'To',
  'markdownTable.filter.textPlaceholder': 'Enter filter condition',
  'markdownTable.filter.reset': 'Reset',
  'markdownTable.filter.cancel': 'Cancel',
  'markdownTable.filter.confirm': 'Confirm',
  'markdownTable.filter.text.contains': 'Contains',
  'markdownTable.filter.text.equals': 'Equals',
  'markdownTable.filter.text.notEquals': 'Does not equal',
  'markdownTable.filter.text.startsWith': 'Starts with',
  'markdownTable.filter.text.endsWith': 'Ends with',
  'markdownTable.filter.number.gt': 'Greater than',
  'markdownTable.filter.number.gte': 'Greater than or equal to',
  'markdownTable.filter.number.lt': 'Less than',
  'markdownTable.filter.number.lte': 'Less than or equal to',
  'markdownTable.filter.number.between': 'Between',
  'mermaid.rendering': 'Rendering diagram...',
  'mermaid.viewCode': '</>',
  'mermaid.viewDiagram': '⊞',
  'mermaid.zoomIn': '+',
  'mermaid.zoomOut': '−',
  'mermaid.zoomReset': '↺',
  'contextUsage.active': 'active',
  'contextUsage.autocompactBuffer': 'Autocompact buffer',
  'contextUsage.bodyLoaded': 'body loaded',
  'contextUsage.builtinTools': 'Built-in tools',
  'contextUsage.contextWindow': 'Context window',
  'contextUsage.detailHint': 'Run /context detail for per-item breakdown.',
  'contextUsage.estimatedOverhead': 'Estimated base overhead',
  'contextUsage.estimatedUsage': 'Estimated usage, including the conversation',
  'contextUsage.usageEstimatedWithConversation':
    'No provider usage yet. The estimates below include the conversation.',
  'contextUsage.estimatedUntilProviderUsage':
    'Token usage is estimated until provider usage is received.',
  'contextUsage.free': 'Free',
  'contextUsage.instructionFiles': 'Instruction files',
  'contextUsage.autoMemory': 'Auto memory',
  'contextUsage.memoryFiles': 'Memory files',
  'contextUsage.messages': 'Messages',
  'contextUsage.startupContext': 'Startup context',
  'contextUsage.unattributed': 'Unattributed',
  'contextUsage.cachedPrefix': 'Cached prefix',
  'contextUsage.mcpTools': 'MCP tools',
  'contextUsage.model': 'Model',
  'contextUsage.noSession':
    'No active session yet. Send your first message before viewing context usage.',
  'contextUsage.usageUnavailable':
    'Current context usage is unavailable. The estimates below cover base overhead only, excluding conversation messages.',
  'contextUsage.overLimit':
    'Context exceeds limit! Use /compress or /clear to reduce.',
  'contextUsage.skills': 'Skills',
  'contextUsage.systemPrompt': 'System prompt',
  'contextUsage.title': 'Context Usage',
  'contextUsage.tokens': 'tokens',
  'contextUsage.used': 'Used',
  'contextUsage.accessibleUsage': (v) =>
    `${v?.used} of ${v?.total} tokens used`,
  'contextUsage.viewDetails': 'View details',
  'contextUsage.viewInConversation':
    'Click to view the breakdown in the conversation.',
  'daemon.title': 'Daemon Status',
  'daemon.connection.title': 'Connections',
  'daemon.connection.target': 'Current target',
  'daemon.connection.state': 'Connection state',
  'daemon.connection.address': 'Daemon address',
  'daemon.connection.token': 'Bearer token (optional)',
  'daemon.connection.connect': 'Connect',
  'daemon.connection.add': 'Add connection',
  'daemon.connection.saved': 'Connected computers',
  'daemon.connection.forget': (v) => `Forget ${v?.address}`,
  'workspaceHost.local': 'Local',
  'workspaceHost.remote': 'Remote',
  'workspaceHost.openHost': (v) => `Open ${v?.host ?? ''}`,
  'workspaceHost.statusOffline': 'offline',
  'workspaceHost.statusUnauthorized': 'unauthorized',
  'workspaceHost.focused': 'connected',
  'workspaceHost.focusedHint':
    'This page is connected to this daemon — the chat runs against it.',
  'workspaceHost.offlineHint':
    'This host could not be reached; showing its last known projects.',
  'workspaceHost.unauthorizedHint':
    'The saved credential was rejected. Open this host to sign in again.',
  'daemon.connection.invalid': 'Enter a valid HTTP or HTTPS origin.',
  'daemon.connection.notReady':
    'The daemon did not accept the connection; the stored credential was left unchanged.',
  'daemon.connection.authFailed':
    'The daemon rejected that token; the stored credential was left unchanged.',
  'daemon.connection.unreachable':
    'The browser could not reach the daemon. A network, certificate, or cross-origin failure may be responsible. Check the remote connection setup below; your saved token has not changed.',
  'daemon.connection.policyBlocked':
    'The server or proxy refused the request (HTTP 403). Check its access rules, Host policy, and allowed page origins.',
  'daemon.connection.mixedContent':
    'This HTTPS page cannot connect to a remote HTTP daemon. Use an HTTPS address for the remote service.',
  'daemon.connection.setup': 'Remote connection setup',
  'daemon.connection.pageOrigin': "This page's origin",
  'daemon.connection.setupCommand':
    'On the server, open Settings → Connections and turn on Allow remote connections. Then enter the displayed address and bearer token here.',
  'daemon.connection.setupHttps':
    'An HTTPS address requires a trusted TLS certificate or an HTTPS proxy. Use HTTPS on untrusted networks.',
  'daemon.connection.setupOrigins':
    'For an HTTPS page or a custom page hostname, add the page origin shown above in the server’s advanced remote connection settings.',
  'daemon.connection.existingService':
    'The switch takes effect without restarting the server. Existing listeners or proxies configured separately remain independently managed.',
  'daemon.connection.reloadUnavailable':
    'Browser storage is unavailable, so the new token could not be applied to this connection.',
  'daemon.connection.switchUnavailable':
    'Browser storage is unavailable, so the token could not be carried to that daemon.',
  'daemon.connection.status.idle': 'Idle',
  'daemon.connection.status.connecting': 'Connecting',
  'daemon.connection.status.adding': 'Adding',
  'daemon.connection.status.connected': 'Connected',
  'daemon.connection.status.error': 'Error',
  'daemon.details.loading': 'Loading diagnostics...',
  'daemon.details.failed': 'Failed to load diagnostics.',
  'daemon.refresh': 'Refresh',
  'daemon.loading': 'Loading daemon status...',
  'daemon.loadFailed': 'Failed to load daemon status',
  'daemon.updatedAt': (v) => `Updated ${v?.time ?? ''}`,
  'daemon.none': 'none',
  'daemon.level.ok': 'OK',
  'daemon.level.warning': 'Warning',
  'daemon.level.error': 'Error',
  'daemon.level.unavailable': 'Unavailable',
  'daemon.issues.title': 'Issues',
  'daemon.overview.title': 'Daemon',
  'daemon.overview.version': 'Version',
  'daemon.overview.pid': 'PID',
  'daemon.overview.mode': 'Mode',
  'daemon.overview.uptime': 'Uptime',
  'daemon.overview.workspace': 'Workspace',
  'daemon.runtime.title': 'Runtime',
  'daemon.runtime.activeSessions': 'Active sessions',
  'daemon.runtime.activePrompts': 'Active prompts',
  'daemon.runtime.idle': 'Idle for',
  'daemon.runtime.noActivity': 'no activity yet',
  'daemon.runtime.pendingPermissions': 'Pending permissions',
  'daemon.runtime.permissionPolicy': 'Permission policy',
  'daemon.runtime.channel': 'ACP channel',
  'daemon.runtime.channelLive': 'live',
  'daemon.runtime.channelDown': 'down',
  'daemon.runtime.startingUp': 'Runtime is starting...',
  'daemon.runtime.startFailed': 'Runtime failed to start',
  'daemon.runtime.channelWorker': 'Channel worker',
  'daemon.runtime.channelWorkerRestarts': 'Worker restarts',
  'daemon.runtime.memory': 'Memory (RSS / heap)',
  'daemon.transport.title': 'Transport',
  'daemon.transport.restSse': 'REST SSE streams',
  'daemon.transport.sseAdmission': 'SSE admission (used / cap)',
  'daemon.transport.acpDisabled': 'ACP transport disabled',
  'daemon.transport.acpConnections': 'ACP connections',
  'daemon.transport.acpStreams': 'ACP streams (session/SSE/WS)',
  'daemon.transport.pendingRequests': 'Pending client requests',
  'daemon.transport.rateLimitRejected': 'Rate-limit rejects',
  'daemon.security.title': 'Security',
  'daemon.security.token': 'Bearer token',
  'daemon.security.requireAuth': 'Require auth',
  'daemon.security.loopback': 'Loopback bind',
  'daemon.security.allowOrigin': 'Allowed origins',
  'daemon.security.shell': 'Session shell commands',
  'daemon.security.configured': 'configured',
  'daemon.security.notConfigured': 'not configured',
  'daemon.limits.title': 'Limits',
  'daemon.limits.unlimited': 'unlimited',
  'daemon.limits.maxSessions': 'Max sessions',
  'daemon.limits.maxPendingPrompts': 'Max pending prompts / session',
  'daemon.limits.maxConnections': 'Max listener connections',
  'daemon.limits.eventRing': 'Event ring size',
  'daemon.limits.promptDeadline': 'Prompt deadline',
  'daemon.limits.sessionIdle': 'Session idle timeout',
  'daemon.capabilities.title': 'Capabilities',
  'daemon.capabilities.titleCount': (v) => `Capabilities (${v?.count ?? 0})`,
  'daemon.full.sessions.title': 'Sessions',
  'daemon.full.sessions.empty': 'No active sessions',
  'daemon.full.session.pendingPrompts': (v) =>
    `${v?.count ?? 0} pending prompts`,
  'daemon.full.session.pendingPermissions': (v) =>
    `${v?.count ?? 0} pending permissions`,
  'daemon.full.session.prompting': 'prompting',
  'daemon.full.workspace.title': 'Workspace Diagnostics',
  'daemon.full.workspace.empty': 'No workspace diagnostics reported',
  'daemon.full.auth.title': 'Auth',
  'daemon.full.auth.providers': 'Device-flow providers',
  'daemon.full.auth.pending': 'Pending device flows',
  'daemon.full.acp.title': 'ACP connections',
  'daemon.tab.overview': 'Overview',
  'daemon.tab.usage': 'Usage',
  'daemon.tab.metrics': 'Metrics',
  'daemon.tab.diagnostics': 'Diagnostics',
  'daemon.charts.title': 'Metrics',
  'daemon.charts.empty':
    'Collecting metrics… charts appear after the first sample.',
  'daemon.charts.concurrency': 'Concurrency',
  'daemon.charts.activePrompts': 'Active tasks',
  'daemon.charts.activeSessions': 'Sessions',
  'daemon.charts.requests': 'Requests',
  'daemon.charts.reqTotal': 'Total',
  'daemon.charts.reqErrors': 'Errors',
  'daemon.charts.apiLatency': 'API latency',
  'daemon.charts.promptLatency': 'Prompt latency',
  'daemon.charts.queueWait': 'Queue wait',
  'daemon.charts.promptDuration': 'Duration',
  'daemon.charts.eventLoop': 'Event-loop lag',
  'daemon.charts.eventLoopLag': 'Lag p99',
  'daemon.charts.queuedPrompts': 'Queued',
  'daemon.charts.reqRejected': 'Rejected',
  'daemon.charts.llmLatency': 'LLM API latency',
  'daemon.charts.apiHealth': 'Model API health',
  'daemon.charts.apiErrors': 'API errors',
  'daemon.charts.apiRetries': 'Retries',
  'daemon.charts.cpu': 'CPU',
  'daemon.charts.pipe': 'IPC pipe',
  'daemon.charts.pipeIn': 'In',
  'daemon.charts.pipeOut': 'Out',
  'daemon.charts.connections': 'Connections',
  'daemon.charts.cpuDaemon': 'Daemon',
  'daemon.charts.cpuChild': 'Child',
  'daemon.charts.rssDaemon': 'Daemon RSS',
  'daemon.charts.rssChild': 'Child RSS',
  'daemon.charts.memory': 'Memory',
  'daemon.charts.heap': 'Heap',
  'daemon.charts.tokens': 'Token burn',
  'daemon.charts.tokensIn': 'Input',
  'daemon.charts.tokensOut': 'Output',
  'daemon.charts.peak': 'peak',
  'daemon.charts.concurrency.help':
    'Live load at each sample: prompts running now, prompts queued (accepted but not yet dispatched), and active sessions. Queued rising above active is backpressure.',
  'daemon.charts.requests.help':
    'Client↔daemon HTTP traffic per window — NOT model calls. Total requests, those returning 4xx/5xx, and those the rate limiter rejected.',
  'daemon.charts.apiLatency.help':
    "Client↔daemon HTTP request duration (p50/p95) — how fast the daemon answers, not the model. Compare with LLM API latency to separate 'we are slow' from 'the model is slow'.",
  'daemon.charts.llmLatency.help':
    'Per-round model API round-trip (daemon→model→daemon), p50/p95. Model-side latency, distinct from the HTTP API latency above.',
  'daemon.charts.apiHealth.help':
    'Provider-side LLM failures. Each failed attempt = 1 error; each automatic backoff = 1 retry. Transient 429/5xx are usually absorbed by retries (errors ≈ retries); errors climbing above retries means calls are failing outright.',
  'daemon.charts.promptLatency.help':
    'Per prompt (task): p95 time waiting in the per-session queue before dispatch, and p95 end-to-end run time. Rising queue wait signals backpressure.',
  'daemon.charts.eventLoop.help':
    'Daemon event-loop lag p99 per window — the CPU-saturation / blocking signal. High lag means the daemon is starved and everything slows.',
  'daemon.charts.cpu.help':
    'CPU utilization (% of all cores) at each sample: the daemon and the ACP child (where LLM/tool work runs). Child at 0% means no child is running.',
  'daemon.charts.memory.help':
    'Resident memory at each sample: daemon RSS, daemon V8 heap, and ACP child RSS. Steady growth over time hints at a leak.',
  'daemon.charts.pipe.help':
    'Bytes over the stdio pipe to/from the ACP child per window. Sustained high volume points to chatty framing between daemon and child.',
  'daemon.charts.connections.help':
    'Live client transport connections at each sample: REST/SSE streams, ACP WebSocket streams, and ACP connections.',
  'daemon.charts.tokens.help':
    'Input (prompt) and output (completion) tokens attributed to model turns per window — model spend over time.',
  'daemon.usage.today': 'Today',
  'daemon.usage.period7d': '7D',
  'daemon.usage.period30d': '30D',
  'daemon.usage.rangeWeek': 'Last 7 days',
  'daemon.usage.rangeMonth': 'Last 30 days',
  'daemon.usage.rangeGroup': 'Summary period',
  'daemon.usage.tokensConsumed': 'tokens consumed',
  'daemon.usage.sessions': 'Sessions',
  'daemon.usage.requests': 'Requests',
  'daemon.usage.tools': 'Tools',
  'daemon.usage.changes': 'Changes',
  'daemon.usage.breakdownTitle': 'Token Breakdown',
  'daemon.usage.inputTokens': 'Input tokens',
  'daemon.usage.inputHint': 'request + cache read',
  'daemon.usage.outputTokens': 'Output tokens',
  'daemon.usage.outputHint': 'response + reasoning',
  'daemon.usage.cacheRead': 'Cache read',
  'daemon.usage.cacheHint': 'cache read share',
  'daemon.usage.heatmapTitle': 'Token Heatmap',
  'daemon.usage.heatmapSub': (v) =>
    `recent ${v?.months ?? 12} months · daily aggregated tokens`,
  'daemon.usage.low': 'Low',
  'daemon.usage.high': 'High',
  'daemon.usage.dowMon': 'Mon',
  'daemon.usage.dowWed': 'Wed',
  'daemon.usage.dowFri': 'Fri',
  'daemon.usage.empty': 'No token usage recorded yet.',
  'daemon.usage.loading': 'Loading usage…',
  'daemon.usage.failed': 'Failed to load usage',
  'daemon.usage.cellTokens': (v) =>
    `${v?.date ?? ''} · Tokens: ${v?.tokens ?? '0'} · Cache: ${v?.cache ?? 0}%`,
  'daemon.usage.rangeWordToday': 'Today',
  'daemon.usage.rangeWordWeek': '7 days',
  'daemon.usage.rangeWordMonth': '30 days',
  'daemon.usage.modelShareTitle': 'model share',
  'daemon.usage.modelShareSub': 'token share · light green shows cache read',
  'daemon.usage.modelMeta': (v) =>
    `${v?.tokens ?? '0'} tokens · cache ${v?.cache ?? 0}%`,
  'daemon.usage.skillTitle': 'skill calls',
  'daemon.usage.skillSub': 'skill name / count',
  'daemon.usage.skillName': 'Skill name',
  'daemon.usage.skillCount': 'Count',
  'daemon.usage.dailyTokensTitle': 'tokens',
  'daemon.usage.dailyTokensSub': 'daily token totals',
  'daemon.usage.dailySessionsTitle': 'sessions',
  'daemon.usage.dailySessionsSub': 'active session counts per day',
  'delete.cannotCurrent':
    'Cannot delete the current session while it is running.',
  'delete.action': 'Delete',
  'delete.deleted': 'Session deleted.',
  'delete.deletedCount': (v) => `${v?.count ?? 0} session(s) deleted.`,
  'delete.deleting': 'Deleting...',
  'delete.failed': (v) =>
    `Failed to delete session.${v?.reason ? ` ${v.reason}` : ''}`,
  'delete.footer': '↑↓ navigate · Space select · Enter delete · Esc cancel',
  'delete.noMatch': (v) => `No session matching "${v?.query ?? ''}"`,
  'delete.none': 'No sessions to delete',
  'delete.allFailed': (v) =>
    `Failed to delete ${v?.count ?? 0} session(s): ${v?.reason ?? 'unknown error'}`,
  'delete.nonRemoved': 'No sessions were deleted.',
  'delete.notFound': 'Session not found — it may have been deleted already.',
  'delete.partialFail': (v) =>
    `${v?.removed ?? 0} deleted, ${v?.failed ?? 0} failed: ${v?.detail ?? 'unknown error'}`,
  'delete.matches': (v) => `${v?.count ?? 0} matches`,
  'delete.pressSearch': 'Press / to search; Space to select; Enter to delete',
  'delete.selected': (v) => `${v?.count ?? 0} selected`,
  'delete.title': 'Delete Session',
  'time.justNow': 'just now',
  'time.minutesAgo': (v) => `${v?.count ?? 0} min ago`,
  'time.hoursAgo': (v) => `${v?.count ?? 0}h ago`,
  'time.daysAgo': (v) => `${v?.count ?? 0}d ago`,
  'dialog.footer.close': 'Esc to close',
  'dialog.footer.confirmCancel': 'Enter to confirm · Esc to cancel',
  'release.cannotCurrent': 'Cannot release the current active session.',
  'release.action': 'Release',
  'release.released': 'Session released successfully.',
  'release.failed': (v) =>
    `Failed to release session.${v?.reason ? ` ${v.reason}` : ''}`,
  'release.footer': '↑↓ to navigate · Enter to release · Esc to cancel',
  'release.inactive': 'Only active live sessions can be released.',
  'release.inactiveBadge': 'inactive',
  'release.noMatch': (v) => `No session matching "${v?.query ?? ''}"`,
  'release.matches': (v) => `${v?.count ?? 0} matches`,
  'release.none': 'No live sessions to release',
  'release.pressSearch':
    'Press / to search; Enter releases the selected live session',
  'release.releasing': 'Releasing...',
  'release.title': 'Release Session',
  'session.limit.reached':
    'The live-session limit has been reached. Release an idle session, or wait for active work to finish.',
  'session.limit.release': 'Release idle sessions',
  'dialog.footer.menu': 'Esc to menu',
  'dialog.footer.mcpServers':
    '↑↓ to navigate · Enter details · r refresh · Esc close',
  'dialog.footer.mcpSelect': '↑↓ to navigate · Enter select · Esc back',
  'dialog.footer.modelFast':
    '↑↓ to navigate · / to search · c for custom · Enter to set fast model · Esc to cancel',
  'dialog.footer.navSelectCancel':
    '↑↓ to navigate · Enter to select · Esc to cancel',
  'dialog.footer.navSelectClose':
    '↑↓ to navigate · Enter to select · Esc to close',
  'dialog.footer.navSelectMenu':
    '↑↓ to navigate · Enter to select · Esc to menu',
  'dialog.footer.navOpenClose': '↑↓ to navigate · Enter to open · Esc to close',
  'dialog.footer.navOpenMenu': '↑↓ to navigate · Enter to open · Esc to menu',
  'dialog.footer.back': 'Esc to go back',
  'dialog.footer.backClose': 'Esc to close',
  'dialog.footer.saveClose':
    '↑↓ switch fields · ⌘/Ctrl+Enter to save · Esc to close',
  'dialog.footer.saveMenu':
    '↑↓ switch fields · ⌘/Ctrl+Enter to save · Esc to menu',
  'dialog.footer.search': 'Type to search · Enter to commit · Esc to clear',
  'dialog.footer.select': 'Enter to select',
  'editor.escClearHint': 'Press Esc again to clear',
  'editor.hintCommands': 'commands',
  'editor.hintFiles': 'Files',
  'editor.hintNext': 'next',
  'editor.hintPrev': 'previous',
  'editor.hintSearch': 'search',
  'editor.noHistory': 'No matching history',
  'editor.placeholder': 'Type a message or @ file path',
  'history.loadingEarlier': 'Loading earlier messages…',
  'history.openEarlier': 'Open earlier history',
  'history.loadEarlier': 'Load earlier',
  'history.loadNewer': 'Load newer',
  'history.returnLatest': 'Return to latest',
  'history.viewUnavailable':
    'History is temporarily unavailable while the session reconnects or repairs its transcript.',
  'history.snapshotView': 'Historical snapshot · read-only',
  'history.viewError':
    'This section could not be loaded. Move the reading position and retry, or return to latest.',
  'history.capacityReached':
    'History display limit reached. Earlier messages remain saved.',
  'history.paginationError': 'Earlier history could not be loaded.',
  'history.retry': 'Retry',
  'editor.shellPlaceholder': 'Enter terminal command',
  'editor.send': 'Send message',
  'editor.imagesSkipped': (v) =>
    `${v?.count ?? 0} file(s) were unavailable and skipped.`,
  'editor.imagesReadFailed': (v) =>
    `${v?.count ?? 0} file(s) could not be read.`,
  'editor.imagesTooLarge': (v) =>
    `${v?.count ?? 0} file(s) exceeded the attachment size limit.`,
  'editor.pastedTextShowInEditor': 'Show inline',
  'editor.connectionDisconnected':
    'Connection interrupted. Please try again after it reconnects.',
  'editor.sessionLoading': 'Session is still loading. Try again in a moment.',
  'editor.processing': 'Processing. New messages will be queued.',
  'editor.searchHint': 'ctrl+r next · tab accept · enter send · esc cancel',
  'editor.searchLabel': 'reverse-i-search:',
  'editor.searchPlaceholder': 'type to search...',
  'editor.newSessionSuggestionTitle': 'This looks like a new topic',
  'editor.newSessionSuggestionStart': 'Send in new session',
  'editor.btwSuggestionTitle': 'This looks like a side question',
  'editor.btwSuggestionSend': 'Ask with BTW',
  'quickActions.extensions': 'Extensions',
  'quickActions.help': 'Help',
  'quickActions.auth': 'Auth',
  'quickActions.settings': 'Settings',
  'quickActions.copy': 'Copy output',
  'quickActions.shellMode': 'Shell mode',
  'quickActions.exitShellMode': 'Exit Shell',
  'session.missing': 'Current session does not exist',
  'session.new': 'New session',
  'workspace.loadFailed': 'Failed to load workspace',
  'workspace.notFound': 'Workspace not found',
  'workspace.notFoundDescription':
    'This workspace may have been removed or the link is no longer valid.',
  'workspace.loadFailedDescription':
    'The workspace service could not be reached. Check the daemon and try again.',
  // Scheduled tasks page
  'scheduledTasks.title': 'Scheduled Tasks',
  'scheduledTasks.subtitle':
    'Run tasks automatically on a schedule, or trigger them manually anytime.',
  'scheduledTasks.loading': 'Loading…',
  'scheduledTasks.count': (v) =>
    `${v?.count ?? 0} task${Number(v?.count ?? 0) === 1 ? '' : 's'}`,
  'scheduledTasks.refresh': 'Refresh',
  'scheduledTasks.new': 'New scheduled task',
  'scheduledTasks.createViaChat': 'Create via chat',
  'scheduledTasks.chatStarter':
    'Help me set up a recurring scheduled task (keep it long-term). What I want: ',
  'scheduledTasks.name': 'Name',
  'scheduledTasks.workspace': 'Workspace',
  'scheduledTasks.workspaceFixedByHost': 'Fixed by host',
  'scheduledTasks.session.label': 'Conversation',
  'scheduledTasks.session.dedicated': 'Dedicated task conversation',
  'scheduledTasks.session.current': 'Current conversation',
  'scheduledTasks.session.dedicatedHint':
    'Runs are kept in a separate conversation created for this task.',
  'scheduledTasks.session.currentHint':
    'Future runs continue in the conversation that is open now.',
  'scheduledTasks.session.currentUnsupported':
    'Current-conversation scheduling is unavailable on this daemon.',
  'scheduledTasks.session.currentUnavailable':
    'Open an existing conversation before selecting the current conversation.',
  'scheduledTasks.session.currentBusy':
    'Wait for the current turn or pending interaction to finish.',
  'scheduledTasks.session.currentIneligible':
    'This conversation type cannot own a scheduled task.',
  'scheduledTasks.session.currentWorkspaceMismatch':
    'The current conversation belongs to a different workspace.',
  'scheduledTasks.session.currentAlreadyBound':
    'The current conversation is already bound to a scheduled task.',
  'scheduledTasks.taskId': 'Task ID',
  'scheduledTasks.schedule': 'Schedule',
  'scheduledTasks.type': 'Type',
  'scheduledTasks.status': 'Status',
  'scheduledTasks.namePlaceholder': 'Optional — defaults to the prompt',
  'scheduledTasks.prompt': 'Prompt',
  'scheduledTasks.promptPlaceholder': 'What should this task do?',
  'workflowRuns.title': 'Workflows',
  'workflowRuns.saved': 'Saved',
  'workflowRuns.active': 'Running',
  'workflowRuns.history': 'History',
  'workflowRuns.create': 'New',
  'workflowRuns.refresh': 'Refresh',
  'workflowRuns.loading': 'Loading workflow runs…',
  'workflowRuns.loadFailed': 'Failed to load workflow runs.',
  'workflowRuns.noSession':
    'Open a session in this project to view its workflow runs.',
  'workflowRuns.emptyActive': 'No workflows are currently running.',
  'workflowRuns.emptyHistory': 'No saved workflow runs yet.',
  'workflowRuns.emptySaved': 'No reusable workflows saved yet.',
  'workflowRuns.emptySavedHint':
    'Select New to create one with Qwen Code, save a completed run from the terminal, or add a .js file under .qwen/workflows.',
  'workflowRuns.project': 'Project',
  'workflowRuns.user': 'User',
  'workflowRuns.projectDescription': 'Available in this project',
  'workflowRuns.userDescription': 'Available across projects',
  'workflowRuns.extension': 'Extension',
  'workflowRuns.extensionDescription': 'Provided by an installed extension',
  'workflowRuns.detail.toggle': (v) => `Show details for ${v?.name ?? ''}`,
  'workflowRuns.detail.loading': 'Loading workflow definition…',
  'workflowRuns.detail.unavailable':
    'This workflow definition is no longer available.',
  'workflowRuns.detail.loadFailed': 'Could not read the workflow definition.',
  'workflowRuns.detail.retry': 'Retry',
  'workflowRuns.detail.noDescription': 'This workflow declares no description.',
  'workflowRuns.detail.whenToUse': 'When to use',
  'workflowRuns.detail.metaError': (v) =>
    `The meta block could not be parsed: ${v?.error ?? ''}`,
  'workflowRuns.detail.phases': (v) => `Phases (${v?.count ?? 0})`,
  'workflowRuns.detail.recentRuns': 'Recent runs',
  'workflowRuns.detail.noRuns': 'No runs in this session yet.',
  'workflowRuns.detail.viewRuns': (v) =>
    `View ${v?.count ?? 0} ${v?.count === 1 ? 'run' : 'runs'} in History`,
  'workflowRuns.detail.showSource': 'Show source',
  'workflowRuns.detail.hideSource': 'Hide source',
  'workflowRuns.run': 'Run',
  'workflowRuns.starting': 'Starting…',
  'workflowRuns.runNamed': (v) => `Run ${v?.name ?? ''}`,
  'workflowRuns.startFailed':
    'The saved workflow could not be started. Refresh and try again.',
  'scheduledTasks.reference.extension': 'Extensions',
  'scheduledTasks.reference.skill': 'Skills',
  'scheduledTasks.reference.mcp': 'MCP',
  'scheduledTasks.referencePicker': 'Reference picker',
  'scheduledTasks.reference.remove': 'Remove',
  'scheduledTasks.reference.loading': 'Loading…',
  'scheduledTasks.reference.empty': 'No available items.',
  'scheduledTasks.frequency': 'Frequency',
  'scheduledTasks.freq.daily': 'Daily',
  'scheduledTasks.freq.weekdays': 'Weekdays',
  'scheduledTasks.freq.weekly': 'Weekly',
  'scheduledTasks.freq.hourly': 'Hourly',
  'scheduledTasks.freq.minutes': 'Every N minutes',
  'scheduledTasks.freq.custom': 'Custom (cron)',
  'scheduledTasks.time': 'Time',
  'scheduledTasks.weekday': 'Weekday',
  'scheduledTasks.interval': 'Minutes',
  'scheduledTasks.cron': 'Cron expression',
  'scheduledTasks.weekdayNames': 'Sun,Mon,Tue,Wed,Thu,Fri,Sat',
  'scheduledTasks.human.daily': (v) => `Daily at ${v?.time ?? ''}`,
  'scheduledTasks.human.weekdays': (v) => `Weekdays at ${v?.time ?? ''}`,
  'scheduledTasks.human.weekly': (v) =>
    `Every ${v?.day ?? ''} at ${v?.time ?? ''}`,
  'scheduledTasks.human.hourly': (v) => `Hourly at :${v?.min ?? '00'}`,
  'scheduledTasks.human.everyMinutes': (v) => `Every ${v?.n ?? ''} minutes`,
  'scheduledTasks.never': 'Never run',
  'scheduledTasks.repeats': 'Repeats',
  'scheduledTasks.runsOnce': 'Runs once',
  'scheduledTasks.lastFired': (v) => `Last run: ${v?.when ?? ''}`,
  'scheduledTasks.lastChecked': (v) => `Last checked: ${v?.when ?? ''}`,
  'scheduledTasks.runNow': 'Run now',
  'scheduledTasks.enable': 'Enable',
  'scheduledTasks.disable': 'Disable',
  'scheduledTasks.delete': 'Delete',
  'scheduledTasks.deleteConfirmTitle': 'Delete scheduled task',
  'scheduledTasks.deleteConfirm': (v) =>
    `Delete scheduled task "${v?.name ?? ''}"?`,
  'scheduledTasks.deletedSnapshot':
    'This scheduled task has been deleted. Showing the snapshot from when it was created.',
  'scheduledTasks.sessionScopedSnapshot':
    'This is a session-scoped scheduled task. Showing the snapshot from when it was created.',
  'scheduledTasks.empty': 'No scheduled tasks yet. Create one to get started.',
  'scheduledTasks.create': 'Create',
  'scheduledTasks.creating': 'Creating…',
  'scheduledTasks.cancel': 'Cancel',
  'scheduledTasks.error.invalidSchedule': 'Invalid schedule',
  'scheduledTasks.error.workspaceUnavailable':
    'The selected workspace is unavailable or untrusted',
  'scheduledTasks.error.emptyPrompt': 'Prompt is required',
  'scheduledTasks.error.gateUnavailable':
    'This daemon does not accept gate changes; undo the gate change, or reconnect to a daemon that supports gate commands',
  'scheduledTasks.error.promptTooLong': (v) =>
    `Prompt exceeds ${v?.max ?? 100_000}-character limit`,
  'scheduledTasks.error.goalActive':
    'Cannot start a scheduled task while a Goal is active.',
  'scheduledTasks.error.toggleFailed': 'Failed to update task',
  'scheduledTasks.error.deleteFailed': 'Failed to delete task',
  'scheduledTasks.edit': 'Edit',
  'scheduledTasks.editTitle': 'Edit scheduled task',
  'scheduledTasks.save': 'Save',
  'scheduledTasks.saving': 'Saving…',
  'scheduledTasks.runHistory': (v) => `Run history (${v?.count ?? 0})`,
  'scheduledTasks.viewHistory': (v) => `View conversation (${v?.count ?? 0})`,
  'scheduledTasks.viewHistoryEmpty': 'View conversation',
  'scheduledTasks.viewHistoryHint': "Open the task's session to see its runs",
  'scheduledTasks.runKind.catchUp': 'late',
  'scheduledTasks.runKind.manual': 'manual',
  'scheduledTasks.runKind.withheld': 'skipped',
  'scheduledTasks.runKind.sessionDispatchFailed':
    'new session failed, nothing ran',
  'scheduledTasks.runKind.sessionDispatchFallback':
    'new session failed, ran in the task session',
  'scheduledTasks.openRunSession': 'Open this run session',
  'scheduledTasks.runContext.title': 'Scheduled task run',
  'scheduledTasks.runContext.taskId': 'Task ID',
  'scheduledTasks.runContext.schedule': 'Schedule',
  'scheduledTasks.runContext.triggeredAt': 'Triggered',
  'scheduledTasks.runContext.trigger.scheduled': 'Scheduled',
  'scheduledTasks.runContext.trigger.manual': 'Run manually',
  'scheduledTasks.error.runFailed': 'Failed to record the run',
  'scheduledTasks.error.oneShotConsumedButFailed':
    'The task was deleted but the prompt could not be delivered — it never ran. Recreate it to try again.',
  'scheduledTasks.dueNow': 'Due now',
  'scheduledTasks.nextRunTooltip': (v) => `Next run: ${v?.when ?? ''}`,
  'scheduledTasks.dur.d': 'd',
  'scheduledTasks.dur.h': 'h',
  'scheduledTasks.dur.m': 'm',
  'scheduledTasks.dur.s': 's',
  'scheduledTasks.runIn': 'Run in',
  'scheduledTasks.sessionMode.perRun': 'A new session every run',
  'scheduledTasks.sessionMode.persistent': 'Persistent task session',
  'scheduledTasks.sessionMode.perRun.hint':
    'Each run gets a clean context and its own conversation.',
  'scheduledTasks.sessionMode.persistent.hint':
    'All runs continue in the same task conversation.',
  'scheduledTasks.model': 'Model',
  'scheduledTasks.model.workspaceDefault': 'Workspace default',
  'scheduledTasks.model.hint':
    'The selected model is applied when each new run session is created.',
  'scheduledTasks.group': 'Session group',
  'scheduledTasks.group.none': 'No group',
  'scheduledTasks.group.create': 'Create a new group…',
  'scheduledTasks.group.name': 'New group name',
  'scheduledTasks.group.color': 'Group color',
  'scheduledTasks.group.hint': 'Each run conversation is placed in this group.',
  'scheduledTasks.group.nameRequired': 'Enter a name for the new group.',
  'scheduledTasks.routing.loading': 'Loading models and groups…',
  'scheduledTasks.delivery.channel': 'Delivery Channel',
  'scheduledTasks.delivery.configuredGroupHint':
    'Messages are sent to the group configured for this Channel.',
  'scheduledTasks.delivery.configuredEndpointHint':
    'Messages are sent to the endpoint configured for this Channel.',
  'scheduledTasks.delivery.endpoint': 'Endpoint',
  'scheduledTasks.delivery.configuredHint':
    'Messages are sent to the destination configured for this Channel.',
  'scheduledTasks.delivery.useConfiguredDestination':
    'Use configured destination',
  'scheduledTasks.delivery.differentConfiguredDestination':
    'This saved destination differs from the Channel’s configured destination.',
  'scheduledTasks.delivery.off': 'Delivery off',
  'scheduledTasks.delivery.hint':
    'Send the final response of a successful scheduled run to this destination. Delivery depends on the Channel and does not guarantee receipt.',
  'scheduledTasks.delivery.unavailable':
    'This daemon does not support Channel delivery changes.',
  'scheduledTasks.delivery.discardChanges': 'Discard delivery changes',
  'scheduledTasks.delivery.perRun':
    'A new session every run does not support Channel delivery. Choose a persistent session or turn delivery off before saving.',
  'scheduledTasks.delivery.required':
    'Choose a Channel and enter a destination ID.',
  'scheduledTasks.delivery.whitespace':
    'This ID has leading or trailing whitespace, which will be sent as part of the destination.',
  'scheduledTasks.delivery.trimWhitespace': 'Remove surrounding whitespace',
  'scheduledTasks.delivery.loading': 'Loading Channels…',
  'scheduledTasks.delivery.loadingContacts': 'Loading suggested destinations…',
  'scheduledTasks.delivery.channelsFailed':
    'Could not load Channels. Close and reopen the form to retry; existing delivery is preserved.',
  'scheduledTasks.delivery.noChannels':
    'No Channels are configured in this workspace. Configure one in Channels first.',
  'scheduledTasks.delivery.targetUnavailable':
    'This Channel is unavailable in this workspace. The saved destination is preserved; you can choose another Channel or turn delivery off.',
  'scheduledTasks.delivery.notObserved':
    'This destination is not in the recent suggestions. Its ID is preserved; contact discovery is not required for delivery.',
  'scheduledTasks.delivery.suggestion': 'Suggested destination',
  'scheduledTasks.delivery.manual': 'Enter a destination ID below',
  'scheduledTasks.delivery.contactsFailed':
    'Could not load suggestions. You can still enter a destination ID; existing delivery is preserved.',
  'scheduledTasks.delivery.suggestionsHint':
    'Suggestions come from recently observed contacts. You can also enter a known user or chat ID supported by the Channel.',
  'scheduledTasks.delivery.type': 'Destination type',
  'scheduledTasks.delivery.id': 'Destination ID',
  'scheduledTasks.delivery.user': 'User',
  'scheduledTasks.delivery.chat': 'Chat',
  'scheduledTasks.delivery.cardPrefix': 'Delivery:',
  'scheduledTasks.gate': 'Gate command (optional)',
  'scheduledTasks.gatePlaceholder':
    'e.g. ./check-pr.sh 15057 — a command that prints only what changed',
  'scheduledTasks.gate.hint':
    'Runs from the project directory before each scheduled fire, outside the model. Exit 0 with output wakes the session with that output attached as data; exit 0 with nothing on stdout skips the fire with no turn; a non-zero exit reports only its stderr, and only when the gate starts failing. It runs unattended only where the session would run the same command without asking — a saved Monitor(…) or Bash(…) rule, a read-only command, or an auto or yolo session; otherwise every fire is blocked.',
  'scheduledTasks.gate.cardPrefix': 'Gate:',
  'autofixPrWatches.title': 'PR watches',
  'autofixPrWatches.description':
    'The /autofix-pr watches of your workspaces: what each round did, and what waits for you.',
  'autofixPrWatches.empty':
    'No /autofix-pr watch yet. Run /autofix-pr <PR> in a session to start one.',
  'autofixPrWatches.loadFailed': 'Could not load the PR watches',
  'autofixPrWatches.unreadable': (v) =>
    `Could not read the watch of PR #${v?.pr ?? ''}: ${v?.error ?? ''}`,
  'autofixPrWatches.phase.merged': 'PR merged — the watch can be stopped',
  'autofixPrWatches.phase.closed': 'PR closed — the watch can be stopped',
  'autofixPrWatches.phase.ended': (v) => `Stopped: ${v?.reason ?? ''}`,
  'autofixPrWatches.phase.unscheduled': 'No scheduled check',
  'autofixPrWatches.phase.fixing': (v) =>
    `Fixing in the background (${v?.minutes ?? 0} min)`,
  'autofixPrWatches.phase.fixingStarting': 'Fixing in the background',
  'autofixPrWatches.phase.abandonedFix':
    'A background fix was left behind — the next round redoes it',
  'autofixPrWatches.phase.watching': 'Watching',
  'autofixPrWatches.phase.idle': 'Not checked recently',
  'autofixPrWatches.pushes': (v) => `Pushes ${v?.count ?? 0}/${v?.max ?? 0}`,
  'autofixPrWatches.lastCheck': (v) => `Last check ${v?.when ?? ''}`,
  'autofixPrWatches.neverChecked': 'Not checked yet',
  'autofixPrWatches.lastRound': (v) => `Last round ${v?.when ?? ''}`,
  'autofixPrWatches.needsHuman': (v) =>
    `Needs your decision (${v?.count ?? 0})`,
  'autofixPrWatches.staleTask':
    'This task no longer drives the watch; it stops at its next fire.',
  'autofixPrWatches.openSession': 'Open session',
  'autofixPrWatches.stop': 'Stop watch',
  'autofixPrWatches.stopHint': (v) =>
    `Runs /autofix-pr stop ${v?.pr ?? ''} in the session that owns the watch`,
  'autofixPrWatches.outsideDaemon':
    'Owned by a session outside this Web Shell (a terminal, perhaps): stop it there.',
  'autofixPrWatches.stopFailed': 'Could not stop the watch',
  'autofixPrWatches.noOwner': (v) =>
    `No session of this Web Shell runs it. In a session of its workspace, /autofix-pr stop ${v?.pr ?? ''} cleans it up, or /autofix-pr resume ${v?.pr ?? ''} starts it again.`,
  'scheduledTasks.gate.notRunYet': 'gate not run yet',
  'scheduledTasks.gate.neverDelivered': 'never',
  'scheduledTasks.gate.lastFailed': 'last run failed',
  'scheduledTasks.gate.lastBlocked': 'blocked',
  'scheduledTasks.gate.status': (v) =>
    `quiet ×${v?.quiet ?? 0} · last delivered ${v?.delivered ?? 'never'} · ${v?.failures ?? 0} ${v?.failures === 1 ? 'failure' : 'failures'}`,
  'scheduledTasks.runKind.gateFailed': 'gate failed',
  'scheduledTasks.runKind.gateBlocked': 'gate blocked',
  'turnOutputs.filesEdited': (v) => `Edited ${v?.count ?? 0} files`,
  'turnOutputs.imagePreview': 'Image Preview',
  'turnOutputs.viewChanges': 'View changes',
  // Key keeps its historical `review` name; the label moved to "Changes" when
  // the code-review result view (`codeReview.*`) took over the word.
  'turnOutputs.review': 'Changes',
  'turnOutputs.reviewLatest': 'View recent file changes',
  'changeOverview.title': 'Change overview',
  'changeOverview.uncommitted': 'Uncommitted',
  'changeOverview.loading': 'Loading changes…',
  'changeOverview.notGit': 'This workspace is not a git repository.',
  'changeOverview.loadFailed':
    'Couldn’t load the change overview. Use refresh to retry.',
  'changeOverview.empty': 'No changes in this scope.',
  'changeOverview.files': (v) => plural(v?.count, 'file'),
  'changeOverview.prUnavailable':
    'File list unavailable: couldn’t load it. Use refresh to retry.',
  'changeOverview.prUnavailableCli':
    'File list unavailable: the GitHub CLI (gh) is not installed on the daemon host.',
  'changeOverview.prUnavailableRoute':
    'File list unavailable: this daemon predates the PR file-list route.',
  'changeOverview.refresh': 'Refresh',
  'changeOverview.openPr': 'Open PR',
  'changeOverview.description': 'Changed files and scale, by delivery unit.',
  'changeOverview.hiddenFiles': (v) => `…and ${plural(v?.count, 'more file')}`,
  'changeOverview.hiddenCommits': '…and more commits',
  'codeReview.authoritativeVerdict': 'Authoritative verdict',
  'codeReview.targetEffort': (v) =>
    `Target: ${v?.target ?? ''} · Effort: ${v?.effort ?? ''}`,
  'codeReview.openReport': 'Open Markdown report',
  'codeReview.loadingReport': 'Loading Markdown report...',
  'codeReview.back': 'Back to review',
  'codeReview.reviewCounts': 'Review counts',
  'codeReview.total': 'Total',
  'codeReview.confidence': (v) => `${v?.value ?? ''} confidence`,
  'codeReview.held': 'Held',
  'codeReview.heldByMeasurement': 'Held back from Critical by measurement',
  'codeReview.caps': 'Caps',
  'codeReview.none': 'None',
  'codeReview.severity': 'Severity',
  'codeReview.confidenceLabel': 'Confidence',
  'codeReview.all': 'All',
  'codeReview.noMatches': 'No findings match these filters.',
  'codeReview.source': (v) => `Source: ${v?.value ?? ''}`,
  'codeReview.failureScenario': 'Failure scenario',
  'codeReview.witness': 'Witness',
  'codeReview.suggestedFix': 'Suggested fix',
  'codeReview.fixWitness': 'Fix witness',
  'codeReview.outcome': 'Outcome',
  'codeReview.locations': 'Locations',
  'codeReview.evidence': 'Evidence',
  'codeReview.notLinked': 'not linked',
  'codeReview.loadErrorTitle': 'Unable to display code review',
  'codeReview.loading': 'Loading code review...',
  'codeReview.artifactTruncated':
    'Code review artifact is truncated and cannot be validated.',
  'codeReview.reportTruncated': 'Markdown report is truncated.',
  'codeReview.unavailable': (v) =>
    `This code review is no longer authoritative because its artifact status is ${v?.status ?? 'unknown'}. Regenerate the review to view it.`,
  'codeReview.workspaceRequired':
    'Code review artifacts must be readable workspace files.',
  'sideTask.title': 'Side task',
  'sideTask.description': 'View or create side tasks',
  'sideTask.new': 'New',
  'sideTask.create': 'New side task',
  'sideTask.archiveCompleted': 'Archive completed',
  'sideTask.archiveUnavailable': 'Only completed side tasks can be archived.',
  'webPreview.title': 'Web preview',
  'webPreview.openHint': 'Preview web apps',
  'webPreview.address': 'Development URL',
  'webPreview.open': 'Open',
  'webPreview.refresh': 'Refresh preview',
  'webPreview.desktop': 'Desktop width',
  'webPreview.mobile': 'Mobile width (390 px)',
  'webPreview.external': 'Open externally',
  'webPreview.frame': 'Web preview frame',
  'webPreview.saved': 'Saved version',
  'webPreview.savedFrame': 'Saved webpage version',
  'webPreview.savedUnavailable':
    'This saved version is missing or has changed. It cannot be opened.',
  'webPreview.savedLoadFailed': 'Could not load this saved version. Try again.',
  'webPreview.page': 'Application preview',
  'webPreview.empty':
    'Start your development server, then enter its URL above.',
  'webPreview.reachable':
    'Use an address this browser can reach. For a remote server, use its accessible URL or an existing port forward.',
  'webPreview.fallback':
    'Blank page? Check the server or open externally. The address and refresh use the entry URL.',
  'webPreview.live':
    'Live page. Opening a link from an earlier message shows its current content, not a saved version.',
  'webPreview.invalidUrl':
    'Use a separate HTTP/HTTPS development address with a hostname or IPv4 address, without login credentials. Web Shell and daemon addresses cannot be previewed.',
  'terminal.title': 'Terminal',
  'terminal.open': 'Open a terminal',
  'terminal.notice.exited': (v) =>
    `Process exited with code ${v?.exitCode ?? '?'}`,
  'terminal.notice.error': (v) => `Error: ${v?.message ?? ''}`,
  'terminal.notice.unknownError': 'Unknown error',
  'terminal.notice.reconnecting': 'Connection lost — reconnecting…',
  'terminal.notice.lost': 'This terminal is no longer available.',
  'terminal.notice.protocolMismatch':
    'Terminal protocol changed; restart the daemon and reload this page.',
  'localFiles.title': 'Local files',
  'localFiles.trigger': 'Local files',
  'localFiles.hint':
    'Lets this session read and write one directory on your own machine. Files stay on your computer; only what the agent asks for is sent to it.',
  'localFiles.connect': 'Connect a directory…',
  'localFiles.reconnect': 'Reconnect',
  'localFiles.disconnect': 'Disconnect',
  'localFiles.openInNewTab': 'Open in a new tab',
  'localFiles.directory': 'Directory',
  'localFiles.tools': (v) => `${v?.count ?? 0} tools`,
  'localFiles.status.idle': 'Not connected',
  'localFiles.status.connecting': 'Connecting…',
  'localFiles.status.registering': 'Registering…',
  'localFiles.status.connected': 'Connected',
  'localFiles.status.reconnecting': 'Reconnecting…',
  'localFiles.status.heldElsewhere': 'Connected in another tab',
  'localFiles.status.needsSession': 'Waiting for a session',
  'localFiles.status.needsGesture': 'Reconnect to continue',
  'localFiles.status.failed': 'Failed',
  'localFiles.status.unavailable': 'Unavailable here',
  'localFiles.status.resolving': 'Resolving…',
  'localFiles.needsSessionHint':
    'Start a session first. The bridge binds to exactly one session, so no other session can reach your files.',
  'localFiles.blocker.insecureContext': (v) =>
    v?.localPort !== undefined
      ? `This page is not a secure context, so the browser will not grant local file access. Serve the Web Shell over https, or run the copied SSH tunnel command and open http://localhost:${v.localPort}.`
      : 'This page is not a secure context, so the browser will not grant local file access. Serve the Web Shell over https, or forward the daemon port with SSH and open http://localhost:<port>.',
  'localFiles.blocker.crossOriginFrame':
    'Local file access is blocked inside a cross-origin frame. Open the Web Shell in its own browser tab to connect a directory.',
  'localFiles.blocker.unsupportedBrowser':
    'This browser has no File System Access API. Use Chrome or Edge to connect a local directory.',
  'localFiles.blocker.workspaceIneligible':
    "This conversation's workspace cannot host a local directory (untrusted or live workspace). Use a session in a trusted, regular workspace instead.",
  'localFiles.blocker.workspaceResolving':
    'Which workspace this conversation belongs to is not known yet.',
  'localFiles.blocker.unsupportedDaemon':
    'This daemon does not advertise the client filesystem bridge (client_mcp_over_ws). Start the daemon with QWEN_SERVE_CLIENT_MCP_OVER_WS=1 to enable local files.',
  'localFiles.changeDirectory': 'Change directory…',
  'localFiles.session': 'Session',
  'localFiles.newSession': 'New session',
  'localFiles.retry': 'Retry',
  'localFiles.copyStartupCommand': 'Copy startup command',
  'localFiles.copyTunnelCommand': 'Copy SSH tunnel command',
  'localFiles.copied': 'Command copied',
  'localFiles.copyFailed': 'Could not copy the command',
  'localFiles.changeDirectoryFailed':
    'Could not change the directory. The current directory is still connected.',
  'localFiles.changeDirectoryDeferred':
    'Directory change saved. It takes effect once the workspace finishes resolving; until then the current directory stays connected.',
  'localFiles.gestureToast': (v) =>
    v?.name
      ? `Local directory "${v.name}" needs to be reconnected. Open Local files to grant access again.`
      : 'Local files need to be reconnected. Open Local files to grant access again.',
  ...FILES_MESSAGES_EN,
  ...ACTIVITY_MESSAGES_EN,
  'rightPanel.add': 'Add panel',
  'attachment.showPreview': 'Preview',
  'attachment.showSource': 'Source',
  'attachment.previewUnsupported':
    'Preview is not available for this file type.',
  'attachment.readFailed': 'Failed to read attachment.',
  'attachment.loadingFile': 'Loading file...',
  'attachment.loadingPreview': 'Loading preview...',
  'sideTask.creating': 'Creating side task…',
  'sideTask.createFailed': 'Failed to create side task',
  'sideTask.commandsLoadingTimedOut':
    'Command information is still unavailable. Your side-task prompt has been kept and will be checked when it loads.',
  'sideTask.promptFailed': 'Failed to send the side-task question',
  'sideTask.renameFailed': 'Failed to name side task',
  'turnOutputs.preview': 'Preview',
  'turnOutputs.collapseFiles': 'Collapse files',
  'turnOutputs.showMoreFiles': (v) => `Show ${v?.count ?? 0} more files`,
  'turnOutputs.collapseArtifacts': 'Collapse artifacts',
  'turnOutputs.showMoreArtifacts': (v) =>
    `Show ${v?.count ?? 0} more artifacts`,
  'turnOutputs.previousTurn': 'Previous turn',
  'turnOutputs.fileCount': (v) => `${v?.count ?? 0} files`,
  'turnOutputs.openFileTree': 'Open file tree',
  'turnOutputs.closeFileTree': 'Close file tree',
  'turnOutputs.artifactMissing': 'File not found in the workspace',
  'turnOutputs.artifactChanged': 'Modified since recorded',
  'turnOutputs.artifactUnavailable': (v) =>
    v?.path
      ? `File not found in the workspace · ${v.path}`
      : 'File not found in the workspace',
  'sidebar.label': 'Workspace sidebar',
  'sidebar.home': 'Home',
  'sidebar.channelSettings': 'Settings',
  'sidebar.liveSettings': 'Settings',
  'sidebar.liveSettingsUnavailable':
    'Live settings are not available on this server.',
  'sidebar.more': 'More',
  'sidebar.navigation': 'Main navigation',
  'sidebar.toggleMenu': 'Toggle menu',
  'sidebar.newChat': 'New chat',
  'sidebar.newTask': 'New session',
  'sidebar.newWorktreeTask': 'New worktree session',
  'sidebar.moveWorkspaceUp': 'Move up',
  'sidebar.moveWorkspaceDown': 'Move down',
  'sidebar.plugins': 'Plugins',
  'sidebar.channels': 'Channels',
  'sidebar.channelEvents': 'Channel events',
  'sidebar.sessionSource': 'Session source',
  'sidebar.archiveSessionSource': 'Archived session source',
  'sidebar.sessionSource.tasks': 'Tasks',
  'sidebar.sessionSource.channels': 'Channels',
  'sidebar.channelType.other': 'Other channels',
  'sidebar.live': 'Live',
  'sidebar.liveVoicePending': 'Voice chat',
  'sidebar.project': 'Workspaces',
  'sidebar.pinnedSessions': 'Pinned',
  'sidebar.sessionSort': 'Sort sessions',
  'sidebar.sessionDisplay': 'Display options',
  'sidebar.groupBy': 'Group by',
  'sidebar.groupWorkspace': 'Workspace',
  'sidebar.groupActivityDate': 'Activity date',
  'sidebar.groupThisWeek': 'This week',
  'sidebar.groupLast30Days': 'Last 30 days',
  'sidebar.groupOlder': 'Older',
  'sidebar.recentConversations': 'Recent conversations',
  'sidebar.sortBy': 'Sort by',
  'sidebar.sortActivity': 'Recent activity',
  'sidebar.sortQuestion': 'Last question',
  'sidebar.workspaceFilter': 'Workspace',
  'sidebar.filterAll': 'All',
  'sidebar.restoreDefaults': 'Restore defaults',
  'sidebar.recentSessions': 'Recent',
  'sidebar.standalonePinUnavailable':
    'Pinning no-workspace sessions is not supported yet.',
  'sidebar.workspaceSelectLabel': 'Workspace',
  'sidebar.noWorkspace': 'No workspace',
  'sidebar.liveSessions': 'Live sessions',
  'sidebar.noWorkspaceSessions': 'No-workspace sessions',
  'sidebar.copySessionId': 'Copy session ID',
  'sidebar.copySessionIdFailed': 'Failed to copy session ID',
  'sidebar.sessionIdCopied': 'Session ID copied',
  'sidebar.workspaceUntrusted': 'untrusted',
  'sidebar.manageWorkspaces': 'Manage workspaces…',
  'sidebar.collapseAllWorkspaces': 'Collapse all workspaces',
  'sidebar.expandAllWorkspaces': 'Expand all workspaces',
  'sidebar.workspaceOrderError':
    'Could not load or save workspace order. Reload and try again.',
  'sidebar.workspaceReadOnly': 'read-only',
  'sidebar.workspaceTrustToOpen': 'Trust this workspace to open the session.',
  'sidebar.addWorkspace': 'Add workspace',
  'sidebar.newWorkspace': 'New workspace',
  'sidebar.startFromScratch': 'Start from scratch',
  'sidebar.useExistingFolder': 'Use an existing folder…',
  'sidebar.scratchOutcomeUnknownTitle': 'Check workspace creation',
  'sidebar.scratchOutcomeUnknown':
    'The daemon response was interrupted. Check the refreshed workspace list before creating another workspace.',
  'sidebar.scratchOutcomeRefresh': 'Refresh workspace list',
  'sidebar.scratchOutcomeAcknowledge': 'I checked the workspace list',
  'sidebar.addWorkspaceTitle': 'Add workspace',
  'sidebar.addWorkspacePath': 'Directory path',
  'sidebar.addWorkspaceBrowse': 'Browse…',
  'sidebar.addWorkspaceBrowsing': 'Choosing directory…',
  'sidebar.addWorkspaceBrowseError':
    'Unable to open the folder picker. Enter an absolute path instead.',
  'sidebar.addWorkspaceDisplayName': 'Display name (optional)',
  'sidebar.addWorkspaceDisplayNameHint':
    'Shown in Web Shell; the directory path remains the workspace identity.',
  'sidebar.addWorkspaceRegister': 'Add workspace',
  'sidebar.addWorkspaceCancel': 'Cancel',
  'sidebar.addWorkspaceError': 'Failed to add workspace',
  'sidebar.addWorkspaceBusyError': 'Another workspace operation is in progress',
  'sidebar.addWorkspacePersistenceError':
    'The daemon did not confirm persistent workspace registration',
  'sidebar.addWorkspaceRefreshError':
    'Workspace added, but the workspace list could not be refreshed',
  'sidebar.addWorkspaceAbsError':
    'Enter an absolute path or an SSH workspace URL.',
  'sidebar.addWorkspaceHint':
    'Enter a local absolute path or ssh://user@host/absolute/project. SSH requires key authentication, a trusted host key and Python 3 on the remote computer. Shell commands also require Bash; Qwen is not required there.',
  'sidebar.addWorkspaceSuggestions': 'Directory suggestions',
  'sidebar.addWorkspacePersist': 'Keep after daemon restart',
  'sidebar.addWorkspacePersistHint':
    'Persist this workspace registration in the daemon configuration.',
  'sidebar.addWorkspaceAdding': 'Adding…',
  'sidebar.addWorkspaceSource': 'Source',
  'sidebar.addWorkspaceSourceDirectory': 'Existing directory',
  'sidebar.addWorkspaceSourceGit': 'Git repository',
  'sidebar.gitCloneUrl': 'Repository URL',
  'sidebar.gitCloneUrlPlaceholder': 'https://github.com/org/repo.git',
  'sidebar.gitCloneUrlHint':
    'Public URLs, SSH-agent addresses, and URLs that carry their own token work. The daemon passes the token to Git and never writes it into the cloned repository; Git credentials configured on the host are not used.',
  'sidebar.gitCloneTarget': 'Clone into',
  'sidebar.gitCloneTargetPlaceholder': '/absolute/path/for/new/repo',
  'sidebar.gitCloneTargetHint':
    'An absolute path that does not exist yet. Its parent directory must already exist.',
  'sidebar.gitCloneTargetSuggestHint':
    'Type a parent path to pick from its subfolders.',
  'sidebar.gitCloneSubmit': 'Clone and add',
  'sidebar.gitCloneProgress': (vars) => `Cloning… ${vars?.percent}%`,
  'sidebar.gitCloneProgressLabel': 'Clone progress',
  'sidebar.gitCloneCancel': 'Cancel clone',
  'sidebar.gitCloneCancelled': 'Clone cancelled.',
  'sidebar.gitCloneFailed': 'Clone failed',
  'sidebar.gitCloneInvalidInput':
    'Enter a Git URL and an absolute target path.',
  'sidebar.gitCloneInvalidTarget': 'Enter an absolute target path.',
  'sidebar.gitCloneUnknown':
    'Could not confirm the clone result. Check the workspace list before cloning again.',
  'sidebar.gitCloneJobGone':
    'This clone job is no longer available, so its result cannot be confirmed. Check the workspace list or whether the target exists before cloning again.',
  'sidebar.gitCloneRecheck': 'Check again',
  'sidebar.gitCloneBack': 'Back',
  'sidebar.gitCloneRegisterRetry': (vars) =>
    `Cloned to ${vars?.path}. Submit to register it.`,
  'workspaceHost.source': 'Folder source',
  'workspaceHost.thisComputer': 'This computer',
  'workspaceHost.folderOn': (vars) => `Folder on ${vars?.address}`,
  'workspaceHost.folderOnThisComputer': 'Folder on this computer',
  'workspaceHost.browseHint':
    'Choose a folder below, or type an absolute path.',
  'workspaceHost.parent': 'Parent folder',
  'workspaceHost.addFolder': 'Add this folder',
  'workspaceHost.noFolders': 'No subfolders in this directory.',
  'workspaceHost.folderListError':
    'Could not read folders from this computer. Check the path or connection.',
  'workspaceHost.navigationUnavailable':
    'Browser storage is unavailable, so the remote folder flow cannot continue safely.',
  'workspaceHost.unsupported':
    'This computer does not support adding workspaces.',
  'workspaceHost.loadingFolders': 'Loading folders from this computer…',
  'workspaceHost.connectionError':
    'Could not load workspace capabilities from this computer.',
  'workspaceDirectories.title': 'Workspace directories',
  'workspaceDirectories.description':
    'Tools can read and edit these directories in addition to the workspace root. New sessions inherit this list.',
  'workspaceDirectories.warning':
    'Adding a directory widens file access beyond the workspace root. Only add directories you trust.',
  'workspaceDirectories.primary': 'Primary',
  'workspaceDirectories.empty': 'No extra directories.',
  'workspaceDirectories.add': 'Add directory',
  'workspaceDirectories.addTitle': 'Add directory to workspace',
  'workspaceDirectories.addSubmit': 'Add directory',
  'workspaceDirectories.pathHint':
    'Enter an absolute path on the machine running this workspace.',
  'workspaceDirectories.remove': 'Remove directory',
  'workspaceDirectories.loading': 'Loading directories…',
  'workspaceDirectories.loadFailed':
    'Could not load the workspace directories.',
  'workspaceDirectories.removeFailed': 'Could not remove the directory',
  'sidebar.removeWorkspace': 'Remove workspace',
  'sidebar.workspaceActions': 'Workspace actions',
  'sidebar.renameWorkspace': 'Rename…',
  'sidebar.renameWorkspaceTitle': 'Rename workspace',
  'sidebar.workspaceNamePrompt': 'Display name',
  'sidebar.workspaceNameHint': 'Leave empty to show the folder name.',
  'sidebar.workspaceNameInvalid': 'Names cannot contain control characters.',
  'sidebar.renameWorkspaceFailed': 'Failed to rename workspace',
  'sidebar.copyWorkspacePath': 'Copy path',
  'sidebar.copyWorkspacePathFailed': 'Failed to copy workspace path',
  'sidebar.openWorkspaceFolder': 'Open folder',
  'sidebar.openWorkspaceFolderFailed': 'Failed to open the workspace folder',
  'sidebar.openWorkspaceFolderOpened': 'Opened the workspace folder',
  'sidebar.openWorkspaceTerminal': 'Open terminal',
  'sidebar.openWorkspaceTerminalFailed': 'Failed to open a terminal',
  'sidebar.openWorkspaceTerminalOpened': 'Opened a terminal at the workspace',
  'sidebar.manageWorkspace': 'Manage',
  'sidebar.reloadWorkspace': 'Reload runtime',
  'sidebar.reloadWorkspaceFailed': 'Failed to reload workspace runtime',
  'sidebar.workspaceCount': (v) => `${v?.count ?? 0} workspaces`,
  'sidebar.sessionsRunning': (v) =>
    `${v?.count ?? 0} running session${v?.count === 1 ? '' : 's'}`,
  'sidebar.sessionsAttention': (v) =>
    `${v?.count ?? 0} session${v?.count === 1 ? '' : 's'} waiting for you`,
  'sidebar.sessionsTotal': (v) =>
    `${v?.count ?? 0}${v?.truncated ? '+' : ''} session${v?.count === 1 && !v?.truncated ? '' : 's'}`,
  'sidebar.overview.sessions': 'Sessions',
  'sidebar.overview.mcp': 'MCP',
  'sidebar.overview.skills': 'Skills',
  'sidebar.overview.extensions': 'Extensions',
  'sidebar.overview.channels': 'Channels',
  'sidebar.overview.context': 'Context',
  'sidebar.overview.hooks': 'Hooks',
  'sidebar.overview.settings': 'Settings',
  'sidebar.overview.mcpDetail': (v) =>
    `${v?.connected ?? 0} of ${v?.configured ?? 0} connected` +
    (Number(v?.failed) > 0 ? `, ${v?.failed} failed` : '') +
    (Number(v?.disabled) > 0 ? `, ${v?.disabled} disabled` : ''),
  'sidebar.overview.skillsDetail': (v) =>
    `${v?.enabled ?? 0} of ${v?.total ?? 0} enabled`,
  'sidebar.overview.extensionsDetail': (v) =>
    `${v?.active ?? 0} of ${v?.total ?? 0} active`,
  'sidebar.overview.channelsDetail': (v) =>
    `${v?.connected ?? 0} of ${v?.configured ?? 0} connected` +
    (Number(v?.failed) > 0 ? `, ${v?.failed} failed` : ''),
  'sidebar.overview.contextDetail': (v) =>
    `${v?.files ?? 0} context file${v?.files === 1 ? '' : 's'}, ${v?.rules ?? 0} rule${v?.rules === 1 ? '' : 's'}`,
  'sidebar.overview.hooksDetail': (v) =>
    `${v?.count ?? 0} hook${v?.count === 1 ? '' : 's'}`,
  'sidebar.overview.hooksDisabled': (v) =>
    `${v?.count ?? 0} hook${v?.count === 1 ? '' : 's'} (disabled)`,
  'sidebar.overview.hooksUntrusted': (v) =>
    `${v?.count ?? 0} hook${v?.count === 1 ? '' : 's'}, ${v?.untrusted ?? 0} not loaded (folder not trusted). Enable security.folderTrust.enabled and trust the folder, or run qwen interactively to review.`,
  'sidebar.forceRemoveWorkspace': 'Force remove',
  'sidebar.removeWorkspaceTitle': 'Remove workspace',
  'sidebar.removeWorkspaceConfirm': (v) =>
    `Remove the runtime and persistent registration for “${v?.name ?? ''}”? Files, settings, and session history will not be deleted.`,
  'sidebar.removeWorkspaceBusy': (v) =>
    `“${v?.name ?? ''}” still has active runtime resources. Force removal will terminate them.`,
  'sidebar.removeWorkspaceCurrentSession':
    'Switch to another workspace or close the current session before forcing removal.',
  'sidebar.removeWorkspaceInProgress':
    'Another client is already removing this workspace. Refresh after that operation finishes.',
  'sidebar.removeWorkspaceError': 'Failed to remove workspace',
  'sidebar.removeWorkspaceSessions': (v) => `Sessions: ${v?.count ?? 0}`,
  'sidebar.removeWorkspacePrompts': (v) => `Active prompts: ${v?.count ?? 0}`,
  'sidebar.removeWorkspaceStarts': (v) =>
    `Pending session starts: ${v?.count ?? 0}`,
  'sidebar.removeWorkspaceConnections': (v) =>
    `ACP connections: ${v?.count ?? 0}`,
  'sidebar.removeWorkspaceMemoryTasks': (v) => `Memory tasks: ${v?.count ?? 0}`,
  'sidebar.removeWorkspaceWorkers': (v) => `Channel workers: ${v?.count ?? 0}`,
  'sidebar.removeWorkspaceVoiceSessions': (v) =>
    `Voice sessions: ${v?.count ?? 0}`,
  'sidebar.noSessions': 'No sessions.',
  'sidebar.untitledSession': 'Untitled session',
  'user.sentFrom': (v) => `From ${v?.workspace ?? ''} · ${v?.session ?? ''}`,
  'user.sentTo': (v) => `To ${v?.workspace ?? ''} · ${v?.session ?? ''}`,
  'sidebar.projectFallback': 'Workspace',
  'sidebar.sessionsOverview': 'Session Overview',
  'sidebar.splitView': 'Split View',
  'sidebar.addToSplitView': 'Add to Split View',
  'sidebar.splitAtCapacity': (v) =>
    `Split View already shows ${v?.max ?? 6} sessions — close a pane to add another`,
  'sidebar.splitAlreadyOpen': 'This session is already open in Split View',
  'sidebar.splitCurrentDisabled':
    'The current session cannot be added while Split View is closed',
  'sidebar.settings': 'Settings',
  'update.button': 'Update',
  'update.restarting': 'Restarting…',
  'update.readyTitle': (v) => `Update to v${v?.version} and restart`,
  'update.manualTitle': (v) => `Update to v${v?.version} (manual)`,
  'update.manualHint':
    'This installation cannot be updated from the Web Shell. Update guidance:',
  'update.failed':
    'Update could not finish. Check the service connection and retry.',

  'sidebar.daemonStatus': 'Daemon Status',
  'sidebar.scheduledTasks': 'Scheduled Tasks',
  'sidebar.workflows': 'Workflows',
  'sidebar.goals': 'Goals',
  'sidebar.prWatches': 'PR watches',
  'sidebar.themeLight': 'Switch to light theme',
  'sidebar.themeDark': 'Switch to dark theme',
  'sidebar.collapse': 'Collapse',
  'sidebar.expand': 'Expand',
  'sidebar.showAllSessions': 'Show all',
  'sidebar.showMoreSessions': (v) => `Show ${v?.['count'] ?? 0} more`,
  'sidebar.subSessions': (v) => plural(v?.['count'], 'sub-session'),
  'sidebar.collapseProject': 'Collapse workspace',
  'sidebar.expandProject': 'Expand workspace',
  'sidebar.search': 'Search sessions',
  'sidebar.searchPlaceholder': 'Search sessions',
  'sidebar.searchResults': 'Sessions',
  'sidebar.searchLoading': 'Searching sessions…',
  'sidebar.searchEmpty': 'No sessions found',
  'sidebar.searchEmptyHint':
    'Try a different title or a phrase from a conversation.',
  'sidebar.searchRecentEmpty': 'Your recent sessions will appear here.',
  'sidebar.searchPartialFailure': 'Some sessions could not be searched.',
  'sidebar.searchNavigate': 'Navigate',
  'sidebar.searchOpen': 'Open',
  'sidebar.rename': 'Rename',
  'sidebar.export': 'Export conversation record',
  'sidebar.exportFailed': 'Failed to export session',
  'sidebar.delete': 'Delete',
  'sidebar.archive': 'Archive',
  'sidebar.unarchive': 'Restore',
  'sidebar.moreActions': 'More actions',
  'sidebar.archiveCurrentDisabled': 'The current session cannot be archived',
  'sidebar.archiveRunningDisabled':
    'A running session cannot be archived; archiving would stop its work',
  'sidebar.deleteRunningDisabled':
    'A session with background work cannot be deleted; deleting would stop it',
  'sidebar.archivedTitle': 'Archived',
  'sidebar.standaloneLoadFailed': 'Failed to load recent conversations',
  'sidebar.standaloneActionFailed': 'Conversation action failed',
  'sidebar.standaloneDeleteConfirm':
    'Delete this conversation and its private files?',
  'sidebar.standaloneCleanupPending':
    'The conversation was deleted. Private file cleanup will finish automatically.',
  'sidebar.archivedEmpty': 'No archived sessions.',
  'sidebar.archiveFailed': 'Failed to archive session',
  'sidebar.unarchiveFailed': 'Failed to restore session',
  'sidebar.loadFailed': 'Failed to load sessions. Click to retry.',
  'sidebar.renameFailed': 'Failed to rename session',
  'sidebar.deleteFailed': 'Failed to delete session',
  'sidebar.newSessionFailed': 'Failed to create a new session',
  'sidebar.switchFailed': 'Failed to switch session',
  'sidebar.currentDeleteDisabled':
    'The current session is running and cannot be deleted',
  'sidebar.currentStandaloneDeleteDisabled':
    'Open another chat first to delete the current no-workspace session',
  'sidebar.deleteConfirmDescription': (v) =>
    `Delete "${v?.name ?? ''}"? This cannot be undone.`,
  'sidebar.clients': (v) => `${v?.count ?? 0} client(s)`,
  'sidebar.running': 'Running',
  'sidebar.activeWork': 'Active work',
  'sidebar.activityUnknown': 'Background activity unknown',
  'sidebar.waitingForApproval': 'Waiting for approval',
  'sidebar.waitingForApprovalShort': 'Approval',
  'sidebar.sessionPr': (v) => `Pull Request #${v?.number ?? ''}`,
  'sidebar.sessionPrMultiple': (v) =>
    `Pull Request #${v?.number ?? ''} (${v?.count ?? 0} total)`,
  'sidebar.sessionGoal': (v) =>
    `Goal: ${v?.status ?? ''} — ${v?.objective ?? ''}`,
  'sidebar.sessionPrStateMerged': 'Merged',
  'sidebar.sessionPrStateClosed': 'Closed',
  'sidebar.sessionIssue': (v) => `Issue #${v?.number ?? ''}`,
  'sidebar.sessionIssueStateCompleted': 'Completed',
  'sidebar.sessionIssueStateNotPlanned': 'Not planned',
  'sidebar.userInputNeeded': 'User input needed',
  'sidebar.userInputNeededShort': 'Input',
  'sidebar.completedUnread': 'Finished',
  'sidebar.pin': 'Pin',
  'sidebar.selectSessions': 'Select sessions',
  'sidebar.exitSelection': 'Exit selection',
  'sidebar.selectedSessions': (v) =>
    `${v?.count ?? 0} ${v?.count === 1 ? 'session' : 'sessions'} selected`,
  'sidebar.unpin': 'Unpin',
  'sidebar.sessionGroup': 'Group',
  'sidebar.groupFilter': 'Session group',
  'sidebar.groupAll': 'All',
  'sidebar.groupPinned': 'Pinned',
  'sidebar.groupUngrouped': 'Ungrouped',
  'sidebar.groupRecent': 'Recent',
  'sidebar.groupCreate': 'Create group',
  'sidebar.groupRename': 'Rename group',
  'sidebar.groupDelete': 'Delete group',
  'sidebar.groupColor': 'Group color',
  'sidebar.groupNamePrompt': 'Group name',
  'sidebar.groupDeleteConfirm': (v) => `Delete group "${v?.name ?? ''}"?`,
  'sidebar.groupsLoadFailed': 'Failed to load session groups',
  'sidebar.groupCreateFailed': 'Failed to create group',
  'sidebar.groupAssignFailedAfterCreate':
    'Group created, but failed to move session into it',
  'sidebar.groupUpdateFailed': 'Failed to update group',
  'sidebar.groupDeleteFailed': 'Failed to delete group',
  'sidebar.organizationFailed': 'Failed to update session organization',
  'sidebar.groupColor.red': 'Red',
  'sidebar.groupColor.orange': 'Orange',
  'sidebar.groupColor.yellow': 'Yellow',
  'sidebar.groupColor.green': 'Green',
  'sidebar.groupColor.blue': 'Blue',
  'sidebar.groupColor.purple': 'Purple',
  'sidebar.groupColor.custom': 'Custom…',
  'sidebar.groupColor.picker': 'Choose custom group color',
  'sidebar.groupColor.hex': 'Hex color',
  'sidebar.groupColor.invalid': 'Enter a six-digit Hex color such as #416ef5.',
  'quickKeys.retry': 'Retry failed',
  'error.unsupportedTheme':
    'Unsupported theme. Use /theme light or /theme dark.',
  'queue.delete': 'Delete',
  'queue.edit': 'Edit',
  'queue.insert': 'Insert',
  'queue.cleared': 'Queue cleared.',
  'queue.deleteTip': 'Remove from queue',
  'queue.editTip': 'Remove from queue and edit again',
  'queue.submitting': 'Submitting...',
  'queue.midTurnQueued': 'Queued...',
  'queue.serverQueued': 'Queued on server...',
  'queue.editing': 'Editing...',
  'queue.inserting': 'Inserting...',
  'queue.removing': 'Updating...',
  'queue.submittingDisabled': 'Submitting queued message...',
  'queue.summaryEditDisabled':
    'This restored queue summary cannot recover its original attachments.',
  'queue.admissionUnknown':
    'Delivery is uncertain. Check the session before trying again.',
  'queue.restoreUnknown': 'Restore local copy',
  'queue.discardUnknown': 'Discard local copy',
  'queue.continueEditing': 'Continue editing',
  'queue.continueEditingConfirm':
    'The prompt may already be running. Continue editing only if you accept the risk of sending it twice.',
  'queue.commandBlocked':
    "Slash commands can't be queued while a turn is running.",
  'queue.commandGoalBlocked':
    'Slash commands are unavailable while a Goal owns the session or its state is loading.',
  'queue.shellQueued':
    'Shell command queued — it will run after the current turn finishes.',
  'queue.shellDropped': (v) => {
    const count = v?.count ?? 0;
    return count === 1
      ? '1 queued shell command will not run.'
      : `${count} queued shell commands will not run.`;
  },
  'queue.queueFailed': 'Failed to queue message',
  'queue.attachmentCleanupFailed': 'Failed to discard uploaded attachments',
  'queue.deleteFailed': 'Failed to move message out of queue',
  'queue.editFailed': 'Failed to edit queued message',
  'queue.insertFailed': 'Failed to insert queued message',
  'queue.insertTip': 'Insert into the current turn',
  'queue.insertCommandDisabled': 'Commands cannot be inserted mid-turn',
  'queue.sendNow': 'Send now',
  'queue.sendNowTip':
    'Send queued messages now. Interrupts the model if it is responding or calling tools',
  'queue.sendNowFailed': 'Failed to send queued messages now',
  'queue.footer':
    'Press ↑ to edit the latest queued message · Esc to clear queue',
  'queue.imageCount': (v) => `(+${v?.count ?? 0} images)`,
  'queue.fileCount': (v) => `(+${v?.count ?? 0} files)`,
  'queue.more': (v) => `... (+${v?.count ?? 0} more)`,
  'help.builtIn': 'Built-in commands',
  'help.commandCount': (v) => `${v?.count ?? 0} commands`,
  'help.commandMeta.builtIn': 'built-in',
  'help.commandMeta.custom': 'custom',
  'help.commandMeta.subcommands': (v) => `${v?.count ?? 0} subcommands`,
  'help.commandsIntro': 'Browse built-in commands:',
  'help.customGroup': 'Custom, skills, plugins, MCP',
  'help.customIntro': 'Browse custom, skill, plugin, and MCP commands:',
  'help.empty': 'No commands are currently available.',
  'help.emptyCustom': 'No custom commands are currently available.',
  'help.footer':
    'Tab/Shift+Tab to switch tabs · ↑/↓ or PgUp/PgDn to scroll · Esc to close',
  'help.intro':
    'Qwen Code understands your codebase, makes edits with your permission, and executes commands right from your terminal.',
  'help.section.shortcuts': 'Shortcuts',
  'help.search': 'Search commands',
  'help.shortcut.addContext': 'Add files or folders as context',
  'help.shortcut.altWords': 'Jump through words',
  'help.shortcut.clear': 'Clear the screen',
  'help.shortcut.commandMenu': 'Open command menu',
  'help.shortcut.completion': 'Accept completion or switch help tabs',
  'help.shortcut.history': 'Cycle prompt history or scroll lists',
  'help.shortcut.searchHistory': 'Search prompt history',
  'help.shortcut.newline': 'Insert a newline',
  'help.shortcut.pasteImages': 'Paste images',
  'help.shortcut.shell': 'Run shell commands',
  'help.shortcut.togglePanel': 'Toggle this panel',
  'help.shortcut.retry': 'Retry last request',
  'retry.hint': 'Press Ctrl+Y to retry or click to retry',
  'retry.none': 'No failed request to retry.',
  'system.taskNotification': 'Task notification',
  'background.result': 'Background result',
  'background.agent': 'Background agent',
  'background.running': 'Background tasks running',
  'background.task': 'Background task',
  'background.peer': 'Cross-session message',
  'background.details': 'View details',
  'background.processing': (v) => `Processing ${v?.label ?? ''} results`,
  'background.source': 'Source',
  'background.pending': 'Awaiting processing',
  'system.taskCompleted': 'Background task completed',
  'system.taskFailed': 'Background task failed',
  'system.taskCancelled': 'Background task cancelled',
  'notification.shell.completed': (v) =>
    `Background shell "${v?.command ?? ''}" completed.`,
  'notification.shell.failed': (v) =>
    `Background shell "${v?.command ?? ''}" failed.`,
  'notification.shell.cancelled': (v) =>
    `Background shell "${v?.command ?? ''}" was cancelled.`,
  'notification.monitor.completed': (v) =>
    `Monitor "${v?.description ?? ''}" completed. (${v?.events ?? 0} events${
      v?.droppedLines
        ? `, ${v.droppedLines} lines dropped due to throttling`
        : ''
    })`,
  'notification.monitor.failed': (v) =>
    `Monitor "${v?.description ?? ''}" failed. (${v?.events ?? 0} events${
      v?.droppedLines
        ? `, ${v.droppedLines} lines dropped due to throttling`
        : ''
    })`,
  'notification.monitor.cancelled': (v) =>
    `Monitor "${v?.description ?? ''}" was cancelled. (${
      v?.events ?? 0
    } events${
      v?.droppedLines
        ? `, ${v.droppedLines} lines dropped due to throttling`
        : ''
    })`,
  'notification.agent.completed': (v) =>
    `Background agent "${v?.description ?? ''}" completed.`,
  'notification.agent.failed': (v) =>
    `Background agent "${v?.description ?? ''}" failed.`,
  'notification.agent.cancelled': (v) =>
    `Background agent "${v?.description ?? ''}" was cancelled.`,
  'branch.failed': 'Failed to branch session.',
  'branch.stale':
    'This response is no longer on the active history path. The transcript has been refreshed.',
  'branch.staleRefreshFailed':
    'This response is no longer on the active history path, and the transcript could not be refreshed. Please retry.',
  'branch.staleUnsupported':
    'This response is no longer on the active history path. Branching from this point is not supported by the current session.',
  'branch.success': (v) =>
    `Copied session. New session name: "${v?.name ?? ''}". Switched to the new session.`,
  'branch.dialog.title': 'Branch session',
  'branch.dialog.current.title': 'Current workspace',
  'branch.dialog.current.description':
    'Copy the conversation and continue using the current checkout.',
  'branch.dialog.worktree.title': 'New worktree',
  'branch.dialog.worktree.description':
    'Create an isolated checkout from the current Git HEAD. Files are not restored to the state of this response.',
  'branch.dialog.cancel': 'Cancel',
  'branch.dialog.confirm': 'Branch',
  'branch.dialog.creating': 'Creating…',
  'branch.worktreeActivationFailed':
    'The branched session was created, but its worktree could not be opened automatically. Reopen it from the session list.',
  'fork.empty': 'Please provide a directive. Usage: /fork <directive>',
  'fork.failed': (v) => `Failed to launch fork: ${v?.reason ?? ''}`,
  'fork.notStarted': 'Background agent was not launched.',
  'fork.started': (v) =>
    `Started background agent: "${v?.name ?? ''}". Track it in background tasks.`,
  'command.hidden': 'This command is not available.',
  'help.shortcut.approvals': 'Cycle approval modes',
  'help.shortcut.cancel': 'Close dialogs or cancel operation',
  'bug.failed': 'Failed to load system info for bug report.',
  'bug.popupBlocked': 'Popup blocked — please allow popups and try again.',
  'bug.submitted': 'Bug report opened in a new tab.',
  'clear.blocked': 'Cannot clear while streaming — cancel first (Esc).',
  'error.unknown': 'Unknown error',
  'error.modelStreamInterrupted':
    'Model response stream was interrupted. Please retry.',
  'error.loopDetected':
    'The model got stuck while using tools or reached a safety limit, so this turn was stopped. Your session is still open—try a more specific instruction to continue.',
  'error.loopDetected.explicitCap': (vars) =>
    `This turn reached the limit of ${vars?.limit} tool calls set by model.maxToolCallsPerTurn, so it was stopped. Your session is still open—raise the limit in your settings, or send a new instruction to continue.`,
  'error.loopDetected.backstop': (vars) =>
    `This turn reached the safety limit of ${vars?.limit} tool calls, so it was stopped. Your session is still open—send a new instruction to continue, or set model.maxToolCallsPerTurn to choose a different limit.`,
  'error.loopDetected.stuckRepetition': (vars) =>
    `After more than ${vars?.limit} tool calls, the model kept repeating the same call, so this turn was stopped. Your session is still open—try a different or more specific instruction.`,
  'error.loopDetected.repeatedCall':
    'The model kept repeating the same tool call during this turn, so it was stopped. Your session is still open—try a different or more specific instruction.',
  'error.loopDetected.providerDuplicateId':
    'The model service sent a tool call that had already run, so this turn was stopped instead of running it again. Your session is still open—send a new message to continue.',
  'error.loopDetected.invalidToolParams':
    'The model kept sending invalid arguments to the same tool, so this turn was stopped. Your session is still open—try a more specific instruction to continue.',
  'error.loopDetected.repeatedToolFailure':
    'The same tool kept failing for the same reason after a reminder, so this turn was stopped. Your session is still open—check the errors above, or try a different approach.',
  'shell.command': 'Shell Command',
  'shell.result.timedOut': 'Timed out',
  'shell.result.notices': 'Notices',
  'shell.result.truncated': 'Output preview truncated',
  'shell.result.outputFiles': 'Output files',
  'shell.result.output': 'Output',
  'shell.result.command': 'Command',
  'shell.result.copy': 'Copy command',
  'shell.result.details': 'Execution details',
  'shell.result.directory': 'Directory',
  'shell.result.timeout': 'Timeout',
  'shell.result.timeoutMs': (v) => `${v?.milliseconds} ms`,
  'shell.result.defaultTimeout': 'Use default',
  'shell.result.exitCode': 'Exit code',
  'shell.result.signal': 'Signal',
  'shell.result.pending': 'Pending',
  'shell.result.elapsed': 'Elapsed',
  'shell.result.lines': 'Output lines',
  'shell.result.bytes': 'Output bytes',
  'shell.result.running': 'Running',
  'shell.result.completed': 'Completed',
  'shell.result.success': 'Succeeded',
  'shell.result.cancelled': 'Cancelled',
  'shell.result.waiting': 'Waiting for output…',
  'shell.result.empty': 'No output',
  'shell.result.unavailable': 'Output is unavailable for this tool call.',
  'shell.result.exited': (v) => `Exited with code ${v?.code}`,
  'turnCalls.open': 'View tool calls',
  'turnCalls.title': 'Tool calls',
  'turnCalls.count': (v) => `${v?.count ?? 0} tool calls`,
  'turnCalls.tool': 'Tool call',
  'turnCalls.elapsed': (v) => `Elapsed: ${v?.duration ?? ''}`,
  'turnCalls.startedAt': (v) => `Start time: ${v?.time ?? ''}`,
  'turnCalls.endedAt': (v) => `End time: ${v?.time ?? ''}`,
  'turnCalls.empty': 'No tool call records for this turn',
  'turnCalls.arguments': 'Arguments',
  'turnCalls.result': 'Result',
  'turnCalls.other': 'Other',
  'turnCalls.completed': 'Completed',
  'turnCalls.unknown': 'Unknown status',
  'turnCalls.loading': 'Loading this turn’s call records…',
  'turnCalls.loadError': 'Could not load all call records for this turn.',
  'turnCalls.indexError': 'Could not refresh the prompt list.',
  'turnCalls.unresolved':
    'Could not locate this prompt in the session history. Try refreshing.',
  'turnCalls.running': 'Running',
  'turnCalls.pending': 'Pending',
  'turnCalls.cancelled': 'Cancelled',
  'turnCalls.filter': 'Filter by tool type',
  'turnCalls.prompt': 'Prompt',
  'turnCalls.refresh': 'Refresh',
  'turnCalls.all': 'All tools',
  'help.subcommands': 'subcommands',
  'help.tab.commands': 'Built-in commands',
  'help.tab.custom': 'custom-commands',
  'help.tab.general': 'shortcuts',
  'help.title': 'Help',
  'slash.category.custom': 'Custom commands',
  'slash.category.skill': 'Skill commands',
  'slash.category.system': 'System commands',
  'language.changed': (v) => `UI language changed to ${v?.language ?? ''}`,
  'language.current': (v) => `Current UI language: ${v?.language ?? ''}`,
  'language.invalid': `Invalid language. Available: ${WEB_SHELL_LANGUAGES.join(', ')}`,
  'language.options': 'Available options:',
  'language.set': 'Set UI language',
  'language.refreshFailed':
    'UI language saved, but it could not be fully applied.',
  'language.usage': `Usage: /language ui [${WEB_SHELL_LANGUAGES.join('|')}] [--project|--global] | output <language>`,
  'localCommand.noSession':
    'No active session yet. Send your first message before using this command.',
  'localCommand.diffNoWorkspace':
    'No workspace is available yet to show changes for.',
  'localCommand.logNoWorkspace':
    'No workspace is available yet to show history for.',
  'localCommand.prsNoWorkspace':
    'No workspace is available yet to show pull requests for.',
  'localCommand.prsUnsupported':
    'This daemon does not support listing pull requests.',
  'local.agents': 'Manage subagents',
  'local.bug': 'Submit a bug report',
  'local.compress': 'Compress the context into a summary',
  'local.compressFast': 'Fast context compression without AI',
  'local.config': 'Get or set any setting by dot-path key',
  'local.diff': 'Show working-tree change stats versus HEAD',
  'local.log': 'Show commit history for the workspace',
  'local.prs': 'Show open GitHub pull requests for the workspace',
  'local.directory': 'Manage workspace directories',
  'local.docs': 'Open the full Qwen Code documentation',
  'local.doctor': 'Run installation and environment diagnostics',
  'local.dream': 'Consolidate managed auto-memory topic files',
  'local.effort': 'Set reasoning effort for capable models',
  'local.export': 'Export the current session history to a file',
  'local.forget': 'Remove matching entries from managed auto-memory',
  'local.pr': 'Bind a GitHub pull request to this session',
  'local.hooks': 'Manage Qwen Code hooks',
  'local.importConfig': 'Import MCP servers from Claude configs',
  'local.init': 'Analyze the project and create a QWEN.md file',
  'local.insight': 'Generate programming insights from chat history',
  'local.lsp': 'Show LSP server status',
  'local.remember': 'Save a durable memory to the memory system',
  'local.summary': 'Generate a project summary file',
  'local.workflows':
    'List workflow runs or cooperatively pause/resume a live run',
  'skilldesc.autofixPr':
    'Watch a pull request and fix its CI, review feedback and conflicts',
  'skilldesc.batch': 'Run batch operations across many files in parallel',
  'skilldesc.dataviz': 'Design guidance for charts and data visualizations',
  'skilldesc.extensionCreator':
    'Create, test, and customize Qwen Code extensions',
  'skilldesc.goalDraft':
    'Turn a fuzzy intention into a verifiable /goal objective',
  'skilldesc.loop': 'Run a prompt on a schedule or self-paced wakeups',
  'skilldesc.newApp': 'Workflow for building a new app from scratch',
  'skilldesc.qcHelper': 'Answer questions about using Qwen Code',
  'skilldesc.review': 'Review changed code for bugs, security, and quality',
  'skilldesc.simplify': 'Clean up recent changes for reuse and simplicity',
  'skilldesc.stuck': 'Diagnose frozen or slow Qwen Code sessions',
  'skilldesc.agentReproduceAlign':
    'Align a ported Codex/Claude Code feature with the original',
  'skilldesc.agentReproduceFeature':
    'Reproduce an existing Codex/Claude Code feature',
  'skilldesc.autofix':
    'Review and fix local changes or run repository Autofix workflows',
  'skilldesc.bugfix': 'Fix a bug from a GitHub issue, reproduce-first',
  'skilldesc.codegraph': 'Analyze the codebase via graph and vector index',
  'skilldesc.createIssue': 'Draft and submit a GitHub issue from an idea',
  'skilldesc.docsAuditAndRefresh':
    'Audit and refresh docs/ against the codebase',
  'skilldesc.docsUpdateFromDiff': 'Update official docs from local git diff',
  'skilldesc.e2eTesting': 'Run end-to-end tests of the Qwen Code CLI',
  'skilldesc.featDev': 'End-to-end workflow for a non-trivial feature',
  'skilldesc.memoryLeakDebug': 'Diagnose CLI memory leaks via heap snapshots',
  'skilldesc.preparePr': 'Prepare a GitHub PR title and body from the branch',
  'skilldesc.qwenCodeClaw': 'Use Qwen Code as a code-understanding agent',
  'skilldesc.structuredDebugging':
    'Hypothesis-driven methodology for hard bugs',
  'skilldesc.terminalCapture': 'Automate terminal UI screenshot testing',
  'skilldesc.tmuxRealUserTesting': 'Real-user testing with tmux, saving logs',
  'skilldesc.triage': 'Triage and review Qwen Code issues and PRs',
  'local.approvalMode': 'Change approval mode',
  'local.auth': 'Connect an LLM provider',
  'auth.title': 'Connect a Provider',
  'auth.step.group': 'Type',
  'auth.step.authorization': 'Authorization',
  'auth.step.provider': 'Provider',
  'auth.step.protocol': 'Protocol',
  'auth.step.api': 'API',
  'auth.step.baseUrl': 'Base URL',
  'auth.step.apiKey': 'API Key',
  'auth.step.models': 'Model IDs',
  'auth.step.advanced': 'Advanced Config',
  'auth.protocol.openai': 'OpenAI-compatible',
  'auth.protocol.openaiDesc': 'Standard OpenAI API format (most common)',
  'auth.protocol.anthropic': 'Anthropic-compatible',
  'auth.protocol.anthropicDesc': 'Anthropic Messages API format',
  'auth.protocol.gemini': 'Gemini-compatible',
  'auth.protocol.geminiDesc': 'Google Gemini API format',
  'auth.api.chatCompletions': 'Chat Completions',
  'auth.api.responses': 'Responses',
  'auth.apiKeyRequired': 'API key cannot be empty.',
  'auth.baseUrlInvalid': 'Base URL must start with http:// or https://.',
  'auth.baseUrlPrompt': 'Enter the API endpoint for this protocol.',
  'auth.baseUrlRequired': 'Base URL cannot be empty.',
  'auth.documentation': 'Documentation',
  'auth.modelsRequired': 'Model IDs cannot be empty.',
  'auth.review': 'Review',
  'auth.reviewText': 'Review the connection and model settings before saving.',
  'auth.save': 'Save',
  'auth.saving': 'Saving...',
  'auth.termsTitle': 'Terms of Services and Privacy Notice',
  'auth.continue': 'Continue',
  'auth.modelsPrompt': (v) =>
    `Enter model IDs separated by commas. Examples: ${v?.modelIds ?? ''}`,
  'auth.advanced.prompt': 'Optional: configure advanced generation settings.',
  'auth.advanced.thinking': 'Enable thinking',
  'auth.advanced.thinkingDesc':
    'Enable extended reasoning. Leave off to use the model default.',
  'auth.advanced.modality': 'Enable modality',
  'auth.advanced.modalityDesc':
    'Enables multimodal input capabilities (image, video, etc.).',
  'auth.advanced.modalityImage': 'Image',
  'auth.advanced.modalityVideo': 'Video',
  'auth.advanced.modalityAudio': 'Audio',
  'auth.advanced.modalityPdf': 'PDF',
  'auth.advanced.contextWindow': 'Context window',
  'auth.advanced.contextDesc':
    'Context window capacity in tokens. Leave empty to infer the limit from the model ID.',
  'auth.advanced.contextPlaceholder': 'Context window (optional)',
  'auth.advanced.maxTokens': 'Maximum output tokens',
  'auth.advanced.maxTokensDesc':
    'Maximum tokens per response. Leave empty to infer the limit from the model ID.',
  'auth.advanced.tokenLimitInvalid': (v) =>
    `${v?.field ?? 'Token limit'} must be a whole number between 1 and 10,000,000.`,
  'auth.advanced.modalitiesRequired':
    'Select at least one input type or turn off modality.',
  'auth.advanced.defaults': 'Use model defaults',
  'auth.apiKeySet': 'Set (hidden)',
  'local.btw':
    'Ask a quick side question without affecting the main conversation. Usage: /btw <your question>',
  'btw.empty': 'Please provide a question. Usage: /btw <your question>',
  'btw.side.empty':
    'Please provide a question. Usage: /btw side <your question>',
  'btw.emptyAnswer': 'No response received.',
  'btw.failed': 'Failed to answer btw question',
  'btw.answering': '+ Answering...',
  'btw.shortcuts.pending': 'Press Escape, Ctrl+C, or Ctrl+D to cancel',
  'btw.shortcuts.done': 'Press Space, Enter, or Escape to dismiss',
  'local.clear':
    'Start a new session with empty context; previous session stays on disk (resumable with /resume)',
  'local.context':
    'Show context window usage breakdown. Use "/context detail" for per-item breakdown.',
  'local.copy': 'Copy last output or snippet',
  'local.delete': 'Delete a session permanently',
  'local.release': 'Release a live session',
  'local.rewind': 'Rewind the current conversation',
  'local.branch': 'Fork the current conversation into a new session',
  'local.fork': 'Start a background agent from this conversation',
  'local.help': 'Show help and commands',
  'local.language': 'Change UI language',
  'local.mcp': 'Manage MCP servers',
  'local.memory': 'Manage memory',
  'local.model': 'Switch model or set fast model',
  'local.new': 'Start a new conversation',
  'local.plan': 'Enter Plan mode',
  'local.goal': 'Set a goal and keep working until it is met',
  'local.recap': 'Generate a session recap',
  'recap.label': 'Recap',
  'recap.loading': 'Generating recap...',
  'recap.empty': 'Not enough conversation context for a recap yet.',
  'recap.failed': 'Failed to generate recap',
  'rewind.action': 'Rewind',
  'rewind.confirm': 'Confirm rewind',
  'rewind.empty': 'No rewind snapshots are available for this session.',
  'rewind.failed': (v) => `Failed to rewind session: ${v?.reason ?? ''}`,
  'rewind.identityUnavailable':
    'This snapshot has no prompt identity to rewind to.',
  'rewind.loading': 'Loading rewind snapshots...',
  'rewind.promptFallback': (v) => `Prompt ${v?.id ?? ''}`,
  'rewind.rewinding': 'Rewinding...',
  'rewind.subtitle': 'Only the conversation is rewound. Files are not changed.',
  'rewind.title': 'Rewind Conversation',
  'rewind.turn': (v) => `Prompt ${v?.turn ?? 0}`,
  'local.rename': 'Rename current session',
  'rename.empty':
    'Please enter a session name, for example /rename project debugging, or use /rename --auto.',
  'rename.success': (v) => `Session renamed to ${v?.name ?? ''}`,
  'local.reset': 'Reset current conversation',
  'local.resume': 'Resume a previous session',
  'local.skills': 'View available skills',
  'local.stats': 'Show session statistics',
  'local.tasks': 'View background tasks',
  'local.status': 'Show version info',
  'local.theme': 'Change theme',
  'local.settings': 'View and edit settings',
  'local.schedule': 'Manage scheduled tasks',
  'local.extensions':
    'Manage extensions. Usage: /extensions manage|install <source>',
  'extensions.label': 'extension',
  'extensions.action.failed': (v) =>
    `Extension action failed${
      v?.name ? ` for "${v.name}"` : v?.source ? ` from "${v.source}"` : ''
    }: ${v?.error ?? 'Unknown error'}`,
  'extensions.commands.refreshFailed': 'Failed to refresh extension commands.',
  'extensions.install.failed': (v) =>
    `Failed to install extension${
      v?.source ? ` from "${v.source}"` : ''
    }: ${v?.error ?? 'Unknown error'}`,
  'extensions.manage.agents': 'Agents:',
  'extensions.manage.actions': 'Extension actions',
  'extensions.manage.add': 'Add',
  'extensions.manage.checkingUpdates': 'Checking for updates...',
  'extensions.manage.checkUpdates': 'Check for updates',
  'extensions.manage.commands': 'Commands:',
  'extensions.manage.contextFiles': 'Context files:',
  'extensions.manage.count': (v) => `${v?.count ?? 0} extensions installed`,
  'extensions.manage.setting.disabled': 'Disabled',
  'extensions.manage.setting.default': 'Default',
  'extensions.manage.setting.enabled': 'Enabled',
  'extensions.manage.setting.unknown': 'Unavailable',
  'extensions.manage.setting.unavailableDescription':
    'The service did not return scoped extension settings. Restart qwen serve and try again.',
  'extensions.manage.userSetting': 'Global setting',
  'extensions.manage.userSettingDescription':
    'Applies to your workspaces unless a workspace setting overrides it.',
  'extensions.manage.workspaceSetting': 'Workspace setting',
  'extensions.manage.workspaceSettingDescription':
    'Applies only to the current workspace.',
  'extensions.manage.disable': 'Disable Extension',
  'extensions.manage.disabled': (v) =>
    `Extension "${v?.name ?? 'extension'}" disabled.`,
  'extensions.manage.disabling': (v) =>
    `Disabling extension "${v?.name ?? 'extension'}"…`,
  'extensions.manage.inherited': (v) =>
    `Extension "${v?.name ?? 'extension'}" now uses the global setting.`,
  'extensions.manage.inheriting': (v) =>
    `Resetting extension "${v?.name ?? 'extension'}" to the global setting…`,
  'extensions.manage.empty': 'No extensions installed.',
  'extensions.manage.emptyAgents': 'This extension has no agents.',
  'extensions.manage.emptyCommands': 'This extension has no commands.',
  'extensions.manage.emptyContextFiles': 'This extension has no context files.',
  'extensions.manage.emptyDescription':
    'Install an extension to add commands, skills, agents, or MCP servers.',
  'extensions.manage.emptyMcpServers': 'This extension has no MCP servers.',
  'extensions.manage.emptySkills': 'This extension has no skills.',
  'extensions.manage.enable': 'Enable Extension',
  'extensions.manage.enabled': (v) =>
    `Extension "${v?.name ?? 'extension'}" enabled.`,
  'extensions.manage.enabling': (v) =>
    `Enabling extension "${v?.name ?? 'extension'}"…`,
  'extensions.manage.install': 'Install',
  'extensions.manage.installDescription':
    'Enter a GitHub, Git, or npm source, or upload an Extension archive.',
  'extensions.manage.sourceTab': 'Source',
  'extensions.manage.archiveTab': 'Archive',
  'extensions.manage.archiveSelect': 'Select a .zip or .tar.gz archive.',
  'extensions.manage.archiveSelected': (v) =>
    `Selected archive: ${v?.name ?? 'extension archive'}`,
  'extensions.manage.archiveTooLarge':
    'Extension archives must be 10 MB or smaller.',
  'extensions.manage.archiveEmpty': 'The selected Extension archive is empty.',
  'extensions.manage.archiveInvalid':
    'Select a .zip or .tar.gz Extension archive with a valid filename up to 255 bytes.',
  'extensions.manage.installSelectPluginDescription': (v) =>
    `Choose a plugin from "${v?.marketplace ?? 'this marketplace'}".`,
  'extensions.manage.installTitle': 'Add Extension',
  'extensions.manage.installType': 'Install type:',
  'extensions.manage.mcpServers': 'MCP servers:',
  'extensions.manage.marketplaceRoot': 'Marketplace root',
  'extensions.manage.name': 'Name:',
  'extensions.manage.notUpdatable': 'not updatable',
  'extensions.manage.operationFailed': 'Extension operation failed.',
  'extensions.manage.noDescription': 'No description',
  'extensions.manage.noMatches': 'No matching extensions.',
  'extensions.manage.origin': 'Origin:',
  'extensions.manage.overview': 'Overview',
  'extensions.manage.path': 'Path:',
  'extensions.manage.queued': (v) =>
    `Extension action queued for "${v?.name ?? 'extension'}".`,
  'extensions.manage.refreshFailed': (v) =>
    `Extension action succeeded, but session refresh failed${
      v?.error ? `: ${v.error}` : '.'
    }`,
  'extensions.manage.restartRequired': 'updated; restart required',
  'extensions.manage.search': 'Search extensions…',
  'extensions.manage.selectExtension': 'Choose an extension',
  'extensions.manage.settings': 'Settings:',
  'extensions.manage.skills': 'Skills:',
  'extensions.manage.source': 'Source:',
  'extensions.manage.sourcePlaceholder': 'https://github.com/owner/repository',
  'extensions.manage.status': 'Status:',
  'extensions.manage.status.disabled': 'disabled',
  'extensions.manage.status.enabled': 'enabled',
  'extensions.manage.title': 'Manage Extensions',
  'extensions.manage.unknownUpdate': 'unknown',
  'extensions.manage.uninstalled': (v) =>
    `Extension "${v?.name ?? 'extension'}" uninstalled.`,
  'extensions.manage.uninstalling': (v) =>
    `Uninstalling extension "${v?.name ?? 'extension'}"…`,
  'extensions.manage.uninstallAction': 'Uninstall Extension',
  'extensions.manage.uninstallConfirm': (v) =>
    `Uninstall extension "${v?.name ?? 'extension'}"?`,
  'extensions.manage.upToDate': 'up to date',
  'extensions.manage.update': 'Update Extension',
  'extensions.manage.updateAvailable': 'update available',
  'extensions.manage.updateError': 'update check failed',
  'extensions.manage.updateComplete': 'updated',
  'extensions.manage.updatedWithWarnings': 'updated with warnings',
  'extensions.manage.updateStatus': 'Update status:',
  'extensions.manage.updating': 'updating…',
  'extensions.manage.updatingExtension': (v) =>
    `Updating extension "${v?.name ?? 'extension'}"…`,
  'extensions.manage.updated': (v) =>
    `Extension "${v?.name ?? 'extension'}" updated.`,
  'extensions.manage.updatedWithVersion': (v) =>
    `Extension "${v?.name ?? 'extension'}" updated to v${v?.version ?? ''}.`,
  'extensions.manage.version': 'Version:',
  'extensions.manage.viewDetails': 'View Details',
  'extensions.install.installed': (v) =>
    `Extension "${v?.name ?? 'extension'}" installed.`,
  'extensions.install.installedWithVersion': (v) =>
    `Extension "${v?.name ?? 'extension'}" v${v?.version ?? ''} installed.`,
  'extensions.install.missingOptionValue': (v) =>
    `Missing value for ${v?.option ?? 'option'}`,
  'extensions.install.requestFailed': 'Failed to install extension',
  'extensions.install.started': (v) =>
    `Installing extension from "${v?.source ?? ''}"...`,
  'extensions.install.unknownOption': (v) =>
    `Unknown option ${v?.option ?? ''}`,
  'extensions.install.usage': 'Usage: /extensions manage|install <source>',
  'extensions.install.waitForSession':
    'Wait for the session to connect before installing an extension.',
  'local.tools': 'List available tools. Usage: /tools [desc]',
  'loadWarning.commands':
    'Failed to load command list; slash commands may be incomplete.',
  'loadWarning.context':
    'Failed to load session context; current mode may be inaccurate.',
  'loadWarning.models':
    'Failed to load model list; some model details may be unavailable.',
  'mcp.action.auth': 'Authenticate',
  'mcp.action.authHint': 'Not exposed by daemon yet',
  'mcp.action.authMessage':
    'Daemon serve does not expose MCP authentication yet.',
  'mcp.action.clearAuth': 'Clear Authentication',
  'mcp.action.disable': 'Disable',
  'mcp.action.done': (v) => `${v?.action ?? 'Action'} complete.`,
  'mcp.action.enable': 'Enable',
  'mcp.action.enableMessage':
    'Daemon serve does not expose MCP enable/disable yet.',
  'mcp.action.failed': (v) => `Failed: ${v?.error ?? ''}`,
  'mcp.action.running': (v) => `${v?.action ?? 'Action'}...`,
  'mcp.action.reauth': 'Re-authenticate',
  'mcp.action.approve': 'Approve',
  'mcp.actions': 'Server actions',
  'mcp.annotation.destructive': 'destructive',
  'mcp.annotation.idempotent': 'idempotent',
  'mcp.annotation.openWorld': 'open-world',
  'mcp.annotation.readOnly': 'read-only',
  'mcp.annotations': 'Annotations',
  'mcp.oauth.server': 'Server',
  'mcp.oauth.starting': (v) =>
    `Starting OAuth authentication for MCP server '${v?.name ?? ''}'...`,
  'mcp.oauth.title': 'OAuth Authentication',
  'mcp.oauth.timeout': 'Authentication timed out. Refresh to check the status.',
  'mcp.oauth.authenticationFailed': 'Authentication failed.',
  'mcp.oauth.statusFailed': 'Failed to check the authentication status.',
  'mcp.oauth.serverRemoved':
    'The MCP server was removed during authentication.',
  'mcp.clientBudget': (v) =>
    `${v?.count ?? 0}/${v?.budget ?? 0} clients · ${v?.mode ?? 'off'}`,
  'mcp.command': 'Command',
  'mcp.description': 'Description:',
  'mcp.descriptionTitle': 'Description',
  'mcp.basicInfo': 'Basic Information',
  'mcp.action.reconnect': 'Reconnect',
  'mcp.action.edit': 'Edit',
  'mcp.reconnect.skipped': (v) =>
    `Reconnect was not completed: ${v?.reason ?? 'unknown reason'}.`,
  'mcp.reconnect.authenticationRequired':
    'Authentication is required before reconnecting.',
  'mcp.action.restart': 'Restart',
  'mcp.action.tools': 'View tools',
  'mcp.action.toolsHint': 'Enter to inspect',
  'mcp.empty': 'No MCP servers configured.',
  'mcp.emptyDescription': 'Add an MCP server to manage it here.',
  'mcp.emptyTools': 'No tools discovered.',
  'mcp.expand': 'Expand MCP server',
  'mcp.collapse': 'Collapse MCP server',
  'mcp.inputSchema': 'Input schema',
  'mcp.loadingStatus': 'Loading MCP status...',
  'mcp.loadingTools': 'Loading tools...',
  'mcp.name': 'Name',
  'mcp.noDescription': 'No description',
  'mcp.noMatches': 'No matching MCP servers.',
  'mcp.add.button': 'Add',
  'mcp.add.adding': 'Adding MCP Server…',
  'mcp.add.title': 'Add MCP Server',
  'mcp.add.description':
    'Save an MCP server to this workspace with a name and configuration.',
  'mcp.add.name': 'Name',
  'mcp.add.serverDescription': 'Description',
  'mcp.add.serverDescriptionPlaceholder': 'Describe this MCP server',
  'mcp.add.scope': 'Location',
  'mcp.add.scope.global': 'Global',
  'mcp.add.nameRequired': 'Enter an MCP server name.',
  'mcp.add.config': 'Configuration (JSON)',
  'mcp.add.configInvalid': 'Configuration must be a JSON object.',
  'mcp.add.done': (v) => `Added ${v?.name ?? 'MCP server'}.`,
  'mcp.edit.title': 'Edit MCP Server',
  'mcp.edit.description':
    'Update the description or configuration. Name and location cannot be changed.',
  'mcp.edit.save': 'Save Changes',
  'mcp.edit.saving': 'Saving Changes…',
  'mcp.edit.done': (v) => `Updated ${v?.name ?? 'MCP server'}.`,
  'mcp.edit.notFound': 'The MCP server is no longer present in settings.',
  'mcp.runtime.notUpdated':
    'Configuration was saved, but the current session was not updated.',
  'mcp.runtime.removeNotUpdated':
    'Configuration was deleted, but the current session was not updated.',
  'mcp.discovery.empty': 'No MCP servers are configured.',
  'mcp.discovery.timeout':
    'MCP discovery is taking longer than expected. Refresh to check again.',
  'mcp.add.settingsUnavailable': 'Workspace settings are unavailable.',
  'mcp.action.remove': 'Delete',
  'mcp.remove.title': 'Delete MCP Server',
  'mcp.remove.description': (v) =>
    `Remove MCP server “${v?.name ?? ''}” from this workspace?`,
  'mcp.remove.description.global': (v) =>
    `Remove MCP server “${v?.name ?? ''}” from global settings?`,
  'mcp.remove.done': (v) => `Deleted ${v?.name ?? 'MCP server'}.`,
  'mcp.remove.notWorkspace':
    'This MCP server is not defined in workspace settings.',
  'mcp.source.all': 'All',
  'mcp.noSchema': 'No input schema.',
  'mcp.oauth.open': 'Open authentication page',
  'mcp.serverTool': 'Server tool',
  'mcp.servers': (v) => `${v?.count ?? 0} servers`,
  'mcp.configuredServers': 'Configured MCP servers:',
  'mcp.fromExtension': (v) => `(from ${v?.name ?? ''})`,
  'mcp.extensionMcp': 'Extension MCP',
  'mcp.invalidReason': (v) => `invalid: ${v?.reason ?? ''}`,
  'mcp.invalidReasonLabel': 'Reason:',
  'mcp.invalidToolHelp':
    'Tools must have both name and description to be used by the LLM.',
  'mcp.invalidToolWarning': 'Warning: This tool cannot be called by the LLM',
  'mcp.manageServers': 'Manage MCP servers',
  'mcp.viewDetails': 'View details',
  'mcp.parameters': 'Parameters:',
  'mcp.required': ' required',
  'mcp.resources': 'Resources',
  'mcp.resourcesUnavailable': 'Resource details unavailable.',
  'mcp.noResources': 'No resources.',
  'mcp.resourceCount': (v) =>
    `${v?.count ?? 0} ${v?.count === 1 ? 'resource' : 'resources'}`,
  'mcp.promptCount': (v) =>
    `${v?.count ?? 0} ${v?.count === 1 ? 'prompt' : 'prompts'}`,
  'mcp.resource.uriLabel': 'URI:',
  'mcp.resource.nameLabel': 'Name:',
  'mcp.resource.mimeTypeLabel': 'MIME Type:',
  'mcp.resource.sizeLabel': 'Size:',
  'mcp.resource.bytes': (v) =>
    `${v?.count ?? 0} ${v?.count === 1 ? 'byte' : 'bytes'}`,
  'mcp.scrollPosition': (v) => `${v?.current ?? 0}/${v?.total ?? 0}`,
  'mcp.shortcut.back': 'Esc to back',
  'mcp.shortcut.close': 'Esc to close',
  'mcp.shortcut.selectBack': '↑↓ to navigate · Enter to select · Esc to back',
  'mcp.shortcut.selectClose': '↑↓ to navigate · Enter to select · Esc to close',
  'mcp.settings': 'Settings',
  'mcp.extension': (v) => `Extension: ${v?.name ?? ''}`,
  'mcp.starting': (v) =>
    `⏳ MCP servers are starting up (${v?.count ?? 0} initializing)...`,
  'mcp.startingNote':
    'Note: First startup may take longer. Tool availability will update automatically.',
  'mcp.restartSkipped': (v) => `Skipped ${v?.name ?? ''}: ${v?.reason ?? ''}`,
  'mcp.restarted': (v) => `Restarted ${v?.name ?? ''} in ${v?.duration ?? 0}ms`,
  'mcp.restartEntries': (v) =>
    `Restarted ${v?.restarted ?? 0}/${v?.total ?? 0} ${v?.name ?? ''} entries${v?.failedReasons ? ` (failed: ${v.failedReasons})` : ''}`,
  'mcp.source': 'Source',
  'mcp.source.extension': 'Extension',
  'mcp.source.project': 'Project MCP (.mcp.json)',
  'mcp.source.workspace': 'Workspace Settings',
  'mcp.source.user': 'Global Settings',
  'mcp.status': 'Status',
  'mcp.status.blocked': 'Blocked',
  'mcp.status.authenticating': 'Authenticating',
  'mcp.status.authenticationFailed': 'Authentication failed',
  'mcp.status.needsAuthentication': 'Needs authentication',
  'mcp.status.needsApproval': 'Needs approval',
  'mcp.status.rejected': 'Rejected',
  'mcp.status.connected': 'connected',
  'mcp.status.connecting': 'connecting',
  'mcp.status.disconnected': 'disconnected',
  'mcp.status.disconnectedTitle': 'Disconnected',
  'mcp.status.disabled': 'disabled',
  'mcp.status.ready': 'Ready',
  'mcp.status.starting': 'Starting... (first startup may take longer)',
  'mcp.status.unknown': 'unknown',
  'mcp.tipDesc': 'to show server and tool descriptions',
  'mcp.tipNodesc': 'to hide descriptions',
  'mcp.tipSchema': 'to show tool parameter schemas',
  'mcp.tips': '💡 Tips:',
  'mcp.toolCount': (v) => `${v?.count ?? 0} tool`,
  'mcp.toolsCount': (v) => `${v?.count ?? 0} tools`,
  'mcp.toolsLabel': 'Tools:',
  'mcp.title': 'MCP Servers',
  'mcp.toolDetail': 'Tool Detail',
  'mcp.tools': 'Tools',
  'mcp.toolsForServer': (v) => `Tools for ${v?.name ?? 'Server'}`,
  'mcp.transport': 'Transport Protocol',
  'mcp.use': 'Use',
  'mcp.userMcp': 'Global MCP',
  'mcp.workingDirectory': 'Working Directory',
  'goal.aborted': 'Goal aborted',
  'goal.blocked': 'Goal blocked',
  'goal.usageLimited': 'Goal usage limited',
  'goal.paused': 'Goal paused',
  'goal.achieved': 'Goal achieved',
  'goal.check': 'Goal check',
  'goal.cleared': 'Goal cleared',
  'goal.failed': 'Goal could not be achieved',
  'goal.judge': 'Judge',
  'goal.label': 'Goal',
  'goal.expandDetails': 'Expand details',
  'goal.collapseDetails': 'Collapse details',
  'goal.lastCheck': 'Last check',
  'goal.notYetMet': 'not yet met',
  'goal.set': 'Goal set',
  'goal.statusActive': '/goal active',
  'goal.status.active': 'In progress',
  'goal.status.paused': 'Paused',
  'goal.status.blocked': 'Blocked',
  'goal.status.usage_limited': 'Usage limited',
  'goal.status.complete': 'Complete',
  'goal.activity.idle': 'Waiting',
  'goal.activity.running': 'Working',
  'goal.activity.verifying': 'Verifying',
  'goal.edit': 'Edit goal',
  'goal.pause': 'Pause goal',
  'goal.resume': 'Resume goal',
  'goal.turn': (v) => `${v?.count ?? 0} turn`,
  'goal.turnLabel': (v) => `turn ${v?.count ?? 0}`,
  'goal.turns': (v) => `${v?.count ?? 0} turns`,
  'goal.turnsOfBudget': (v) =>
    `${v?.count ?? 0} / ${v?.budget ?? 0} ${v?.budget === 1 ? 'turn' : 'turns'}`,
  'goal.activeOfBudget': (v) => `${v?.used ?? ''} / ${v?.budget ?? ''}`,
  'goal.tokens': (v) => `${v?.used ?? 0} tokens`,
  'goal.tokensOfBudget': (v) => `${v?.used ?? 0} / ${v?.budget ?? 0} tokens`,
  'goals.title': 'Goals',
  'goals.subtitle':
    'A goal keeps its session working until the condition is met. Only sessions that are currently loaded appear here — a goal advances only while its session is running.',
  'goals.loading': 'Loading goals…',
  'goals.count': (v) =>
    `${v?.count ?? 0} active ${Number(v?.count) === 1 ? 'goal' : 'goals'}`,
  'goals.empty': 'No active goals. Set one with /goal <condition>.',
  'goals.refresh': 'Refresh',
  'goals.new': 'New goal',
  'goals.workspace': 'Workspace',
  'goals.newHint':
    'The goal starts in a new session and runs until its condition holds. For an enforced turn or time ceiling, run /config model.goalMaxTurns=20 or /config model.goalMaxActiveMinutes=30 in the chat; it applies after the daemon restarts, to Goals created afterwards.',
  'goals.condition': 'Condition',
  'goals.conditionPlaceholder':
    'e.g. `npm test` exits 0 and `npm run lint` reports no warnings (paste the output); do not modify test files; as model guidance, stop as blocked after 20 turns',
  'goals.cancel': 'Cancel',
  'goals.create': 'Set goal',
  'goals.creating': 'Starting…',
  'goals.saving': 'Saving…',
  'goals.save': 'Save',
  'goals.edit': 'Edit goal',
  'goals.objective': 'Objective',
  'goals.clear': 'Clear goal',
  'goals.clearConfirm': (v) => `Clear the goal "${v?.condition ?? ''}"?`,
  'goals.running': 'Working',
  'goals.idle': 'Waiting',
  'goals.dropped': (v) =>
    `${v?.count ?? 0} session${Number(v?.count) === 1 ? '' : 's'} could not be reached — any goals they are running are missing from this list.`,
  'goals.workspacesSkipped': (v) =>
    `${v?.count ?? 0} workspace${Number(v?.count) === 1 ? '' : 's'} not shown (untrusted or remote).`,
  'goals.notYetEvaluated': 'not yet evaluated',
  'goals.openSessionHint': "Open this goal's session",
  'goals.viewAll': 'View all goals',
  'goals.budget.turns': 'Turns',
  'goals.budget.tokens': 'Tokens',
  'goals.budget.time': 'Active time',
  'goals.error.emptyCondition': 'Enter a condition for the goal.',
  'goals.error.clearKeyword': (v) =>
    `"${v?.word ?? ''}" clears a goal rather than setting one. Describe the condition to work toward.`,
  'goals.error.createFailed': 'Failed to start the goal',
  'goals.error.workspaceUnavailable':
    'The selected workspace is unavailable or untrusted.',
  'goals.error.saveFailed': 'Failed to save the goal',
  'goals.error.goalUnavailable': 'The goal is no longer available.',
  'goals.error.requiresObjective': (v) =>
    `/goal ${v?.keyword ?? 'set'} requires an objective.`,
  'goals.error.invalidCommand': 'Invalid /goal command',
  'goals.error.goalsUnavailable':
    'The goals view is not available on this surface.',
  'goals.error.attachmentsUnsupported':
    'Remove attachments before using /goal.',
  'goals.error.editFailed': 'Failed to edit the goal',
  'goals.error.pauseFailed': 'Failed to pause the goal',
  'goals.error.resumeFailed': 'Failed to resume the goal',
  'goals.error.clearFailed': 'Failed to clear the goal',
  'goals.error.controlBusy':
    'Another goal control is still running. Try again once it finishes.',
  'memory.add': 'Add',
  'memory.add.desc': 'Write a durable memory',
  'memory.autoDream': (v) =>
    `Auto-dream: ${v?.status ?? 'unknown'} · ${v?.lastDream ?? 'never'} · /dream to run`,
  'memory.autoDreamUnsupported':
    'Auto-dream settings are not available from web-shell yet.',
  'memory.autoFolder': 'Open auto-memory folder',
  'memory.autoMemory': (v) => `Auto-memory: ${v?.status ?? 'unknown'}`,
  'memory.autoMemoryUnsupported':
    'Auto-memory settings are not available from web-shell yet.',
  'memory.autoSkill': (v) => `Auto-skill: ${v?.status ?? 'unknown'}`,
  'memory.autoSkillUnsupported':
    'Auto-skill settings are not available from web-shell yet.',
  'memory.chooseScope': 'Choose where to save the memory',
  'memory.closed': 'Memory panel closed.',
  'memory.contentEmpty': 'Memory content is empty.',
  'memory.file': 'Memory file',
  'memory.fileOpen': 'Memory file opened.',
  'memory.fileTruncated':
    'The complete memory file text is unavailable. Editing is disabled.',
  'memory.files': 'Memory Files',
  'memory.footer': 'Enter to confirm · Esc to cancel',
  'memory.footer.back': 'Esc to go back',
  'memory.global': 'User',
  'memory.global.desc': 'Saved to the global user memory file',
  'memory.globalReadUnsupported':
    'Global memory is outside the bound workspace, so the current daemon file-read API cannot open its content.',
  'memory.loading': 'Loading memory...',
  'memory.loadingFile': 'Loading memory file...',
  'memory.lastDream': '5 hours ago',
  'memory.menu': 'Memory',
  'memory.never': 'never',
  'memory.noFiles': 'No memory files found.',
  'memory.on': 'on',
  'memory.openFolderUnsupported':
    'Opening the auto-memory folder is not available from web-shell yet.',
  'memory.placeholder': (v) => `Write ${v?.scope ?? 'memory'} content...`,
  'memory.project': 'Workspace',
  'memory.project.desc': 'Saved to this workspace memory file',
  'memory.refresh': 'Refresh',
  'memory.refresh.desc': 'Reload memory file information',
  'memory.refreshed': 'Memory refreshed.',
  'memory.refreshFailed': 'Could not refresh memory. Please try again.',
  'memory.refreshSuperseded':
    'Memory changed while refreshing. Please try again.',
  'memory.save': 'Save Memory',
  'memory.savedIn': (v) => `Saved in ${v?.path ?? ''}`,
  'memory.saved': (v) =>
    `${v?.scope ?? 'Memory'} saved: ${v?.bytes ?? 0} bytes -> ${v?.path ?? ''}`,
  'memory.saving': 'Saving...',
  'memory.show': 'Show',
  'memory.show.desc': 'Show configured memory files',
  'memory.status': 'Workspace and user memory files',
  'memory.unknown': 'unknown',
  'memory.write': 'Write memory content',
  'mode.auto': 'Classifier Approval',
  'mode.auto.desc':
    'Uses a classifier to approve safe tool calls and block or ask for risky ones',
  'mode.auto.notice':
    'Auto mode enabled. An LLM classifier evaluates each tool call and auto-approves safe actions, blocks risky ones. To exit: Shift+Tab or /approval-mode default.',
  'mode.footer': '(Use Enter to select, Esc to cancel)',
  'mode.name.plan': 'plan',
  'mode.name.default': 'default',
  'mode.name.auto-edit': 'auto-edit',
  'mode.name.auto': 'auto',
  'mode.name.yolo': 'yolo',
  'plan.toggle.on': 'Plan before executing',
  'plan.toggle.off': (v) =>
    `Planning; execute with ${v?.mode} after approval. Click to exit planning.`,
  'approval.option.executePlan': (v) => `Approve and execute · ${v?.mode}`,
  'mode.label.plan': 'Plan',
  'mode.label.default': 'Ask Approval',
  'mode.label.auto-edit': 'Auto Edit',
  'mode.label.auto': 'Classifier Approval',
  'mode.label.yolo': 'Full Access',
  'mode.listLabel.plan': 'Plan (plan)',
  'mode.listLabel.default': 'Ask Approval (default)',
  'mode.listLabel.auto-edit': 'Auto Edit (auto-edit)',
  'mode.listLabel.auto': 'Classifier Approval (auto)',
  'mode.listLabel.yolo': 'Full Access (yolo)',
  'mode.desc.plan': 'Analyze only, do not modify files or execute commands',
  'mode.desc.default':
    'Ask before running commands, editing files, or accessing external resources',
  'mode.desc.auto-edit':
    'Automatically approve file edits and ask before command execution or other sensitive actions',
  'mode.desc.auto':
    'Evaluate tool risk automatically, run safe actions, and confirm risky ones',
  'mode.desc.yolo': 'Automatically approve all tool calls in trusted contexts',
  'mode.select': 'Approval Mode',
  'mode.changePending':
    'A mode change or plan confirmation is pending. Try again when it finishes.',
  'mode.autoApproved': ((v) =>
    v?.tool
      ? `Auto-approved: ${v.tool}`
      : 'Pending tool call auto-approved by mode switch.') as MessageValue,
  'mode.auto-edit': 'Auto-accept edits',
  'mode.auto-edit.desc': 'Automatically approve file read/write operations',
  'mode.default': 'Default mode',
  'mode.default.desc': 'Ask before each tool call',
  'mode.plan': 'Plan mode',
  'mode.plan.desc': 'Analyze and plan without running tools',
  'mode.unknown': 'unknown mode',
  'mode.yolo': 'YOLO mode',
  'mode.yolo.desc': 'Automatically approve all operations',
  'plan.title': 'Plan',
  'model.contextWindow': 'Context Window',
  'model.contextWindow.unknown': '(unknown)',
  'model.current': (v) => `current: ${v?.model ?? 'unknown'}`,
  'model.modality': 'Modality',
  'model.modality.text': 'text',
  'model.modality.textOnly': 'text-only',
  'model.modality.image': 'image',
  'model.modality.pdf': 'pdf',
  'model.modality.audio': 'audio',
  'model.modality.video': 'video',
  'model.baseUrl': 'Base URL',
  'model.apiKey': 'API Key',
  'model.default': '(default)',
  'model.notSet': '(not set)',
  'model.footer': 'Enter select, ↑↓ navigate, Esc close',
  'model.searchHint': 'Press / to search',
  'model.fastHint': 'for suggestions and side tasks',
  'model.refresh': 'Refresh models',
  'model.refreshing': 'Refreshing models…',
  'model.refreshFailed': (v) => `Unable to refresh models: ${v?.error ?? ''}`,
  'model.noMatch': (v) => `No model matching "${v?.query ?? ''}"`,
  'model.unavailable':
    'Models are unavailable; the daemon default will be used.',
  'model.none': 'No models available',
  'model.select': 'Select Model',
  'model.section': 'Model',
  'reasoning.options': 'Options',
  'reasoning.thinking': 'Thinking',
  'reasoning.thinkingOff': 'Thinking Off',
  'reasoning.effort': 'Effort',
  'reasoning.effort.low': 'Low',
  'reasoning.effort.medium': 'Medium',
  'reasoning.effort.high': 'High',
  'reasoning.effort.xhigh': 'Extra High',
  'reasoning.effort.max': 'Max',
  'reasoning.updateFailed': 'Failed to update reasoning options',
  'model.setFast': 'Set Fast Model',
  'model.setVoice': 'Set Voice Model',
  'auth.purpose.label': 'Model purpose',
  'auth.purpose.chat': 'Conversation',
  'auth.purpose.chatHint':
    'Use this provider for conversation. The current model is retained when it is included in the configuration.',
  'auth.purpose.image': 'Image generation',
  'auth.purpose.voice': 'Voice transcription',
  'auth.purpose.realtime': 'Live Voice',
  'auth.purpose.imageHint':
    'Use a DashScope- or MiniMax-compatible HTTPS image-generation endpoint without query or fragment. Adding this model keeps your conversation model.',
  'auth.purpose.voiceHint':
    'Use OpenAI Chat Completions with qwen3-asr-flash, qwen3-asr-flash-realtime, fun-asr-realtime, or paraformer-realtime. Adding this model keeps your conversation model.',
  'model.setAdvisor': 'Set Advisor Model',
  'model.setImage': 'Set Image Model',
  'model.useMain': 'Use main model',
  'model.disabled': 'Disabled',

  'model.setVision': 'Set Vision Model',
  'model.switch': 'Switch Model',
  'model.unknown': 'unknown',
  'resume.current': 'current',
  'resume.activePrompt': 'active prompt',
  'resume.filter': 'Filter',
  'resume.noMatch': (v) => `No session matching "${v?.query ?? ''}"`,
  'resume.none': 'No sessions to resume',
  'resume.pressSearch': 'Press / to search',
  'resume.search': 'Search',
  'resume.title': 'Resume Session',
  'parallelAgents.title': 'Parallel agents',
  'parallelAgents.done': (v) => `${v?.done ?? 0}/${v?.total ?? 0} done`,
  'parallelAgents.failed': (v) => `${v?.count ?? 0} failed`,
  'skills.actions': 'Skill actions',
  'skills.disable': 'Disable',
  'skills.disableInWorkspace': 'Disable in this workspace',
  'skills.disabled': 'Skill disabled.',
  'skills.enable': 'Enable',
  'skills.enabled': 'Skill enabled.',
  'skills.install.action': 'Upload',
  'skills.install.description':
    'Install a skill from GitHub, a local folder, or a ZIP archive.',
  'skills.install.archiveHelp': (v) =>
    `ZIP: ${v?.compressed ?? ''} MiB compressed, ${v?.expanded ?? ''} MiB extracted, ${v?.entries ?? ''} entries; root SKILL.md up to ${v?.manifest ?? ''} MiB. Installation continues after upload finishes.`,
  'skills.install.legacyHelp':
    'Up to 64 MiB total, 32 MiB per file, and 2000 files.',
  'skills.install.legacyZipHelp':
    'ZIP up to 7,864,071 bytes; 64 MiB extracted, 32 MiB per file, and 2000 files.',
  'skills.install.error.archiveTooLarge': (v) =>
    `The ZIP archive exceeds the ${v?.limit ?? ''} MiB compressed limit.`,
  'skills.install.error.archivePackageTooLarge':
    'The archive exceeds 200 MiB extracted, or its root SKILL.md exceeds 32 MiB.',
  'skills.install.error.archiveEntries':
    'The archive contains too many ZIP entries (max 4096, including folders and ignored metadata).',
  'skills.install.error.zipUpgrade':
    'This daemon accepts ZIP files up to 7,864,071 bytes. Upgrade the daemon to upload larger archives.',
  'skills.install.checkingResult': 'Checking the installation result…',
  'skills.install.stillRunning':
    'The installation is still running. Check the result again; the archive will not be uploaded again.',
  'skills.install.resultUnknown':
    'The installation result could not be confirmed. Check again; this does not mean the installation failed.',
  'skills.install.notCommitted': 'This archive was not installed.',
  'skills.install.recoveryRequired':
    'Installation recovery is required. Preserve the recovery paths shown below.',
  'skills.install.checkResult': 'Check result',
  'skills.install.stopChecking': 'Stop checking',
  'skills.install.stoppedChecking':
    'Stopped checking. This does not cancel or undo the installation. Verify its outcome before uploading again.',
  'skills.install.cancelRequest': 'Cancel installation',
  'skills.install.activationWarning': (v) =>
    `Installed, but runtime activation failed: ${v?.detail ?? ''}`,
  'skills.install.error.authentication':
    'Authentication is required to upload skills.',
  'skills.install.error.folderRequired': 'Enter a folder path.',
  'skills.install.error.githubRequired': 'Enter a GitHub SKILL.md URL.',
  'skills.install.error.invalidName':
    'Enter a name such as my-skill using only ASCII letters, digits, dots, underscores, or hyphens.',
  'skills.install.error.manifestMissing':
    'The package must contain a SKILL.md file at its root.',
  'skills.install.error.invalidPackage':
    'Correct the reported file or package structure, then upload the skill again.',
  'skills.install.error.frontmatter':
    'Put the opening --- on the first line of SKILL.md (remove any leading blank lines), and add a closing --- after the YAML fields.',
  'skills.install.error.invalidManifest':
    'Open SKILL.md, correct the field reported above, then upload the skill again.',
  'skills.install.error.nameMismatch':
    'Make the entered skill name match the name in SKILL.md, then upload the skill again.',
  'skills.install.error.unsafePath':
    'Use a regular skill directory and files instead of symbolic links, and check the reported installation path.',
  'skills.install.error.packageTooLarge':
    'The skill exceeds the installer limit of 32 MiB per file or 64 MiB total.',
  'skills.install.error.tooManyFiles':
    'The skill package has too many files (max 2000).',
  'skills.install.error.zipTooLarge':
    'The ZIP file must not exceed 7,864,071 bytes.',
  'skills.install.error.invalidFolder': 'Enter a valid local skill folder.',
  'skills.install.error.githubFailed':
    'Could not download the skill from GitHub. Check the URL or authentication and try again.',
  'skills.install.error.invalidScope':
    'Choose either the workspace or global install location.',
  'skills.install.error.invalidSource':
    'The daemon does not recognize this upload source. Restart the updated daemon and try again.',
  'skills.install.error.notFound': 'The requested skill was not found.',
  'skills.install.error.nameRequired': 'Enter the skill name.',
  'skills.install.error.untrusted':
    'Trust this workspace before uploading skills.',
  'skills.install.failed': 'Failed to upload skill.',
  'skills.install.folder': 'Local folder',
  'skills.install.folderPath': 'Folder path',
  'skills.install.githubUrl': 'SKILL.md URL',
  'skills.install.name': 'Skill name',
  'skills.install.scope': 'Install to',
  'skills.install.scope.global': 'Global',
  'skills.install.scope.workspace': 'Workspace',
  'skills.install.selectZip': 'Select a ZIP archive.',
  'skills.install.title': 'Upload skill',
  'skills.install.succeeded': (v) =>
    `Skill “${v?.name ?? ''}” installed successfully.`,
  'skills.install.zipSelected': (v) => `Selected: ${v?.name ?? ''}`,
  'skills.delete.action': 'Delete skill',
  'skills.delete.description': (v) =>
    `Delete “${v?.name ?? ''}” from disk? This cannot be undone.`,
  'skills.delete.failed': 'Failed to delete skill.',
  'skills.delete.succeeded': (v) =>
    `Skill “${v?.name ?? ''}” deleted successfully.`,
  'skills.delete.title': 'Delete skill?',
  'skills.empty': 'No skills available.',
  'skills.count': (v) =>
    [
      `${v?.count ?? 0} skills`,
      ...(v?.enabled ? [`${v.enabled} enabled`] : []),
      ...(v?.disabled ? [`${v.disabled} disabled`] : []),
    ].join(', '),
  'skills.details': 'Skill details',
  'skills.extension': 'Extension',
  'skills.filter.all': 'All',
  'skills.filter.bundled': 'Built-in',
  'skills.filter.extension': 'Extensions',
  'skills.filter.label': 'Filter skills by source',
  'skills.filter.project': 'Workspace settings',
  'skills.filter.status.all': 'All',
  'skills.filter.status.disabled': 'Disabled',
  'skills.filter.status.enabled': 'Enabled',
  'skills.filter.status.label': 'Filter skills by status',
  'skills.filter.user': 'Global settings',
  'skills.hint': 'Hint',
  'skills.invocation': 'Invocation',
  'skills.level': 'Scope',
  'skills.level.bundled': 'Bundled',
  'skills.level.extension': 'Extension',
  'skills.level.project': 'Project',
  'skills.level.user': 'Global',
  'skills.loading': 'Loading skills...',
  'skills.manualReference': 'Manual reference',
  'skills.manualReferenceHint':
    'The model cannot discover this skill automatically. Reference it manually.',
  'skills.model': 'Model',
  'skills.modelAccess': 'Model access',
  'skills.modelAccess.disabled': 'Not model-invocable',
  'skills.modelAccess.enabled': 'Model-invocable',
  'skills.modelInvocable': 'Model',
  'skills.noDescription': 'No description',
  'skills.noMatches': 'No matching skills.',
  'skills.notToggleable': 'This skill cannot be enabled or disabled.',
  'skills.run': 'Reference skill',
  'skills.search': 'Search skills…',
  'skills.settingUpdated': 'Workspace setting updated.',
  'skills.settingUpdatedAvailabilityUnchanged':
    'Workspace setting updated. Effective Skill availability did not change.',
  'skills.settingUnchanged':
    'Skill already has the requested workspace setting; no setting was changed.',
  'skills.status': 'Status',
  'skills.status.disabled': 'disabled',
  'skills.status.enabled': 'enabled',
  'skills.toggleFailed': 'Failed to update skill.',
  'skills.error.inactiveExtension':
    'This skill belongs to an inactive extension. Enable the extension first.',
  'skills.toggleUnsupported':
    'The connected daemon does not support skill enable or disable actions.',
  'skills.title': 'Skills',
  'plugins.backToChat': 'Back to conversation',
  'plugins.extensions': 'Extensions',
  'plugins.agents': 'Agents',
  'plugins.mcp': 'MCP',
  'plugins.sections': 'Plugin sections',
  'plugins.skills': 'Skills',
  'plugins.title': 'Plugins',
  'plugins.tools': 'Tools',
  'stats.accepted': 'Accepted:',
  'stats.agreementRate': 'Overall Agreement Rate:',
  'stats.api': 'API',
  'stats.apiTime': 'API Time',
  'stats.avgDuration': 'Avg Duration',
  'stats.avgLatency': 'Avg Latency',
  'stats.cached': 'Cached',
  'stats.cacheDesc':
    'of input tokens were served from the cache, reducing costs.',
  'stats.calls': 'Calls',
  'stats.codeChanges': 'Code Changes',
  'stats.decisionSummary': 'User Decision Summary',
  'stats.duration': 'Duration',
  'stats.errors': 'Errors',
  'stats.inputTokens': 'Input Tokens',
  'stats.metric': 'Metric',
  'stats.modelStats': 'Model Stats',
  'stats.modelTip': 'Tip: For a full token breakdown, run /stats model.',
  'stats.modelUsage': 'Model Usage',
  'stats.modified': 'Modified:',
  'stats.noApiCalls': 'No API calls have been made in this session.',
  'stats.noToolCalls': 'No tool calls have been made in this session.',
  'stats.outputTokens': 'Output Tokens',
  'stats.overview': 'Session Overview',
  'stats.performance': 'Performance',
  'stats.prompts': 'Prompts',
  'stats.rejected': 'Rejected:',
  'stats.reqs': 'Reqs',
  'stats.requests': 'Requests',
  'stats.savingsHighlight': 'Savings Highlight:',
  'stats.successRate': 'Success Rate',
  'stats.thoughts': 'Thoughts',
  'stats.title': 'Session Stats',
  'stats.tokens': 'Tokens',
  'stats.toolCalls': 'Tool Calls',
  'stats.toolName': 'Tool Name',
  'stats.toolStats': 'Tool Stats',
  'stats.toolTime': 'Tool Time',
  'stats.total': 'Total',
  'stats.totalReviewed': 'Total Reviewed Suggestions:',
  'contextUsage.refresh': 'Refresh',
  'contextUsage.remaining': 'Remaining',
  'contextUsage.advanced': 'Advanced · usage by category',
  'contextUsage.snapshot': 'Snapshot',
  'contextUsage.viewCurrent': 'View current context',
  'contextUsage.compress': 'Compress context',
  'contextUsage.compressing': 'Compressing…',
  'contextUsage.compressed': 'Compression completed. Context usage refreshed.',
  'contextUsage.compressedUnknown':
    'Compression completed. Context usage will be observed on the next turn.',
  'managed.compression.unconfirmed':
    'Compression is unconfirmed. Check its status before continuing.',
  'managed.compression.recoveryBlocked': 'Compression is waiting for recovery.',
  'managed.compression.confirm': 'Check compression status',
  'managed.compression.storage':
    'Could not save the compression request. Compression was not started.',
  'managed.compression.storageUpdate':
    'Could not save the latest compression status. Check it again after refreshing.',
  'managed.compression.conflict':
    'The context changed. Review its latest state and try again.',
  'managed.compression.busy':
    'The session is busy. Wait until it is idle before compressing.',
  'contextUsage.compressCancelled':
    'Cancellation requested. Refresh to check current usage.',
  'contextUsage.compressInterrupted':
    'Connection changed during compression. Refresh to check current usage.',
  'contextUsage.compressFailed': 'Compression failed. You can try again.',
  'contextUsage.previewTruncated':
    'This file is large; the preview shows only its beginning.',
  'contextUsage.compressRefreshFailed':
    'Compression completed, but usage could not be refreshed. Use Refresh to retry.',
  'contextUsage.compressUnavailable':
    'Requires an idle, connected session with permission to compress context.',
  'contextCompression.result': (v) =>
    `Context compressed ${v?.from ?? ''} → ${v?.to ?? ''}`,
  'contextCompression.instructionsTruncated': (v) =>
    `Compression instructions were truncated to ${v?.max ?? ''} characters.`,
  'contextCompression.noop': 'No compression needed.',
  'contextUsage.retry': 'Retry',
  'contextUsage.loadError': 'Failed to load context usage.',
  'contextUsage.previousReading':
    'Could not refresh. Showing a previous reading.',
  'contextUsage.unavailable': 'Context usage is unavailable for this session.',
  'contextUsage.unknown':
    'Context usage has not been observed for this session yet.',
  ...TOKEN_USAGE_MESSAGES_EN,
  ...CHANNEL_EVENTS_MESSAGES_EN,
  'trajectory.title': 'Trajectory',
  'trajectory.description': 'View time and tokens',
  'trajectory.empty': 'No records in this session yet.',
  'trajectory.noTiming':
    'No request or tool durations are recorded for these records.',
  'trajectory.loadingPages': (v) =>
    `Loading records… (${v?.pages ?? 0} ${Number(v?.pages) === 1 ? 'page' : 'pages'} so far)`,
  'trajectory.olderFailed': (v) =>
    `Earlier records could not be read: ${v?.message ?? ''}`,
  'trajectory.olderPartial':
    'Earlier records could only be read in part, so they are left out.',
  'trajectory.loadFailed': (v) =>
    `Could not read the transcript: ${v?.message ?? ''}`,
  'trajectory.partial':
    'Part of this transcript could not be read, so some records are missing.',
  'trajectory.turn': (v) => `Turn ${v?.index ?? 0}`,
  'trajectory.turnPartial': (v) => `Turn ${v?.index ?? 0} (continued)`,
  'trajectory.turnSummary': (v) =>
    `${plural(v?.requests, 'request')} · ${plural(v?.tools, 'tool')} · main model total ${v?.duration ?? ''}`,
  'trajectory.request': 'Model request',
  'trajectory.requestFailed': 'Request failed',
  'trajectory.toolFailed': 'Tool failed',
  'trajectory.ttft': (v) => `First token ${v?.duration ?? ''}`,
  'trajectory.subagentRollup': (v) =>
    `subagent ${plural(v?.requests, 'request')} · ${plural(v?.tools, 'tool')} · ${v?.duration ?? ''}`,
  'trajectory.badge.user': 'you',
  'trajectory.badge.message': 'say',
  'trajectory.badge.thought': 'think',
  'trajectory.badge.tool': 'tool',
  'trajectory.badge.subagent': 'sub',
  'trajectory.badge.shell': 'shell',
  'trajectory.badge.permission': 'ask',
  'trajectory.badge.status': 'note',
  'trajectory.badge.cancelled': 'stop',
  'trajectory.badge.other': 'other',
  'trajectory.cancelled': 'Turn cancelled',
  'trajectory.overview.label': (v) =>
    `Timeline of ${plural(v?.spans, 'timed record')}, ${v?.busy ?? ''} of activity`,
  'trajectory.overview.busy': (v) => `${v?.duration ?? ''} active`,
  'trajectory.range.status': (v) =>
    `Visible records ${v?.shown ?? 0} / window records ${v?.total ?? 0} (including context)`,
  'trajectory.collapsed': (v) => `${v?.count ?? 0} records collapsed`,
  'trajectory.expand': (v) => `Expand ${v?.name ?? ''}`,
  'trajectory.collapse': (v) => `Collapse ${v?.name ?? ''}`,
  'trajectory.parentUnresolved': 'Parent call not located',
  'trajectory.contextRow': 'Context',
  'trajectory.inspector.hiddenByCollapse':
    'The group containing this record is collapsed.',
  'trajectory.reveal': 'Expand and locate',
  'trajectory.range.clear': 'Clear time selection',
  'trajectory.range.empty': 'No request or tool ran in the selected time.',
  'trajectory.mode.clock': 'Real time, idle included',
  'trajectory.clock.window': (v) =>
    `${v?.elapsed ?? ''} elapsed, ${v?.active ?? ''} active`,
  'trajectory.clock.label': (v) =>
    `Timeline of ${v?.spans ?? 0} timed records over ${v?.elapsed ?? ''}, ${v?.active ?? ''} of activity`,
  'trajectory.clock.status': 'Showing real time, idle included',
  'trajectory.active.status': 'Showing active time only',
  'trajectory.zoom.in': 'Zoom in',
  'trajectory.zoom.out': 'Zoom out',
  'trajectory.zoom.reset': 'Show the whole run',
  'trajectory.zoom.window': (v) => `${v?.to ?? ''} of ${v?.busy ?? ''}`,
  'trajectory.zoom.aria': (v) => `, zoomed to ${v?.from ?? ''}–${v?.to ?? ''}`,
  'trajectory.zoom.status': (v) =>
    `Showing ${v?.from ?? ''}–${v?.to ?? ''} of ${v?.busy ?? ''}`,
  'trajectory.range.aria': (v) =>
    `, ${v?.from ?? ''} to ${v?.to ?? ''} selected`,
  'trajectory.metric.elapsed.help':
    'Elapsed span: earliest recorded start to latest end, including gaps; plotted records only.',
  'trajectory.metric.active.help':
    'Active coverage: time with at least one recorded request or tool running. Parallel time counts once.',
  'trajectory.metric.main.help':
    'Main model total: sum of main-session model request durations, excluding subagent requests and tools. Failed attempts may count.',
  'trajectory.metric.missing.help':
    'Unplotted requests and tools remain in the list. An em dash means unrecorded; zero is a measured zero.',
  'trajectory.unplotted': (v) =>
    `Unplotted: ${v?.starts ?? 0} without start · ${v?.timing ?? 0} without duration`,
  'trajectory.noStart':
    'Recorded durations have no start time, so no bars can be plotted.',
  'trajectory.refreshStale': 'Refresh failed; showing the last successful read',
  'trajectory.historyGap':
    'History may have changed while disconnected. Refresh the latest window to update.',
  'trajectory.lifecycleIncomplete':
    'Lifecycle details may be incomplete or outside the retained limit.',
  'trajectory.inspector.title': 'Record details',
  'trajectory.inspector.close': 'Close details',
  'trajectory.inspector.selectRecord': 'Select a record to inspect.',
  'trajectory.inspector.stale':
    'The record window changed. Select a record again.',
  'trajectory.inspector.hiddenByRange':
    'This record is outside the selected time.',
  'trajectory.inspector.model': 'Model',
  'trajectory.inspector.status': 'Status',
  'trajectory.inspector.permissionTitle': 'Title',
  'trajectory.inspector.permissionPending': 'pending',
  'trajectory.inspector.executionId': 'Execution ID',
  'trajectory.inspector.responseId': 'Response ID',
  'trajectory.inspector.promptId': 'Prompt ID',
  'trajectory.inspector.subagent': 'Subagent',
  'trajectory.inspector.parentCall': 'Parent call ID',
  'trajectory.inspector.duration': 'Duration',
  'trajectory.inspector.start': 'Recorded start',
  'trajectory.inspector.end': 'Calculated end',
  'trajectory.inspector.ttft': 'First token',
  'trajectory.inspector.invalidTtft':
    'Recorded first-token timing is inconsistent',
  'trajectory.inspector.tool': 'Tool',
  'trajectory.inspector.callId': 'Call ID',
  'trajectory.inspector.kind': 'Kind',
  'trajectory.inspector.images': 'Image types',
  'trajectory.inspector.files': 'Files',
  'trajectory.inspector.resourceLinks': 'Resource links',
  'trajectory.inspector.command': 'Command',
  'trajectory.inspector.reason': 'Reason',
  'trajectory.inspector.truncated': 'Content truncated',
  'trajectory.inspector.formatFailed': 'Could not format recorded field',
  'trajectory.inspector.expand': 'Show more',
  'trajectory.inspector.copied': 'Copied',
  'trajectory.inspector.copyFailed': 'Could not copy content',
  'trajectory.mode.group': 'Time scale',
  'trajectory.mode.active': 'Active time, idle removed',
  'trajectory.mode.active.short': 'Active time',
  'trajectory.mode.clock.short': 'Real time',
  'trajectory.legend.ttft': 'Main: first token wait',
  'trajectory.legend.after': 'After first token',
  'trajectory.legend.error': 'Failed',
  'trajectory.overview.lane.requests': 'Model requests',
  'trajectory.overview.lane.tools': 'Tool calls',
  'trajectory.overview.lane.subagents': 'Subagent requests',
  'status.contextUsed': (v) => `${v?.pct ?? '0.0'}% context used`,
  'status.disconnected': 'Disconnected',
  'stream.cancel': 'esc to cancel',
  'stream.cancelArmed': 'Press Esc again to stop',
  'stream.tokens': (v) => `${v?.count ?? 0} tokens`,
  'waitingGame.title': 'Juust Relax',
  'waitingGame.activityTitle': 'Q&A activity',
  'waitingGame.usageTitle': 'Token usage',
  'waitingGame.openActivity': 'Open task activity',
  'waitingGame.startGame': 'Start a random game',
  'waitingGame.backToHeatmap': 'Back to activity',
  'waitingGame.heatmap': 'Activity',
  'waitingGame.tokens': 'Usage',
  'waitingGame.heatmapTooltip': (v) =>
    `${v?.time ?? ''} · ${v?.count ?? 0} Q&A`,
  'waitingGame.jumpToMessage': 'Click to locate',
  'waitingGame.tokenTotal': 'Total tokens',
  'waitingGame.tokenInput': 'Input',
  'waitingGame.tokenOutput': 'Output',
  'waitingGame.tokenCached': 'Cached',
  'waitingGame.tokenContext': 'Context',
  'waitingGame.tokenEmpty': 'No token data yet',
  'waitingGame.snakeControls': 'Arrows / WASD turn · Space pause · Esc close',
  'waitingGame.collapse': 'Collapse',
  'waitingGame.region': 'Waiting minigame',
  'waitingGame.score': (v) => `Score ${v?.score ?? 0}`,
  'waitingGame.best': (v) => `Best ${v?.score ?? 0}`,
  'waitingGame.controls':
    '↑↓ move · → speed up · ← rotate · Space pause/resume · clear a column +50',
  'waitingGame.paused': 'Paused',
  'waitingGame.pausedHint': 'Press Space to resume',
  'waitingGame.gameOver': 'Game over',
  'waitingGame.restart': 'Play again',
  'waitingGame.cleared': (v) => `Cleared ${v?.count ?? 0} · +${v?.score ?? 0}`,
  'waitingGame.mute': 'Mute game sound',
  'waitingGame.unmute': 'Unmute game sound',
  'theme.current': (v) => `current: ${v?.theme ?? ''}`,
  'theme.auto': 'Auto',
  'theme.dark': 'Dark',
  'theme.dark.desc': 'Terminal-style dark skin.',
  'theme.light': 'Light',
  'theme.light.desc': 'Terminal-style light skin.',
  'theme.title': 'Theme',
  'todo.allDone': 'All tasks completed',
  'todo.collapse': 'Collapse task list',
  'todo.completedAbove': (v) => `✓ ${v?.count ?? 0} completed`,
  'todo.detail.api': 'API',
  'todo.detail.cached': 'Cached',
  'todo.detail.end': 'End',
  'todo.detail.hide': 'Hide task detail',
  'todo.detail.input': 'Input',
  'todo.detail.noResources':
    "Token & time usage wasn't captured for this task.",
  'todo.detail.output': 'Output',
  'todo.detail.sectionSpent': 'Time spent',
  'todo.detail.sectionTime': 'Time',
  'todo.detail.sectionTokens': 'Tokens',
  'todo.detail.show': 'Show task detail',
  'todo.detail.start': 'Start',
  'todo.detail.tool': 'Tool',
  'todo.expand': 'Expand task list',
  'todo.more': (v) => `... ${v?.count ?? 0} more`,
  'todo.moreAbove': (v) => `... ${v?.count ?? 0} earlier`,
  'todo.showLess': 'Show less',
  'todo.stepProgress': (v) => `Step ${v?.current ?? 0} / ${v?.total ?? 0}`,
  'todo.stepFraction': (v) => `${v?.current ?? 0} / ${v?.total ?? 0}`,
  'todo.title': 'Current tasks',
  'planExecution.dialogTitle': 'Plan & tasks',
  'planExecution.title': 'Plan execution',
  'planExecution.overview': 'Workflow overview',
  'planExecution.overallProgress': 'Overall progress',
  'planExecution.stepsCompleted': 'Steps completed',
  'planExecution.activeAgents': 'Active agents',
  'planExecution.needsAttention': 'Needs attention',
  'planExecution.stepDetails': 'Step details',
  'planExecution.subagents': 'Subagents',
  'planExecution.noSubagents': 'No agent has been linked to this step yet.',
  'planExecution.openDetails': 'Open subagent details',
  'planExecution.currentActivity': 'Current activity:',
  'planExecution.toolCalls': (v) => `${v?.count ?? 0} tool calls`,
  'planExecution.tokens': (v) => `${v?.count ?? 0} tokens`,
  'planExecution.view': 'View plan execution',
  'planExecution.dependsOn': 'Depends on:',
  'planExecution.unblocks': 'Unblocks:',
  'planExecution.unassigned': 'Unassigned executions',
  'planExecution.attention': 'Needs attention',
  'planExecution.agentCount': (v) =>
    `${v?.count ?? 0} ${Number(v?.count ?? 0) === 1 ? 'agent' : 'agents'}`,
  'planExecution.status.running': 'Running',
  'planExecution.status.paused': 'Paused',
  'planExecution.status.completed': 'Completed',
  'planExecution.status.blocked': 'Blocked',
  'planExecution.status.in_progress': 'In progress',
  'planExecution.status.ready': 'Ready',
  'planExecution.edgesHidden': (v) =>
    `Too many dependencies to draw (${v?.count ?? 0}). Each step lists what it depends on instead.`,
  'workflow.chatTitle': 'Chat',
  'workflow.title': 'Workflow',
  'workflow.inspector.summary': 'Workflow progress',
  'workflow.inspector.selectedStep': 'Selected step',
  'workflow.inspector.allSteps': 'Steps',
  'workflow.inspector.recentActivity': 'Recent Agent activity',
  'workflow.inspector.expandGraph': 'Expand dependency graph',
  'workflow.inspector.graphCanvas': 'Dependency graph',
  'workflow.inspector.canvasHint':
    'Select a graph node to inspect its dependencies and Agent runs here.',
  'workflow.inspector.activeAgents': (v) =>
    `${v?.count ?? 0} active Agent${v?.count === 1 ? '' : 's'}`,
  'workflow.inspector.attentionCount': (v) => `${v?.count ?? 0} need attention`,
  'workflow.planReview.title': 'Plan & Review',
  'workflow.planReview.question': 'Confirm the plan and start collaboration?',
  'workflow.planReview.confirm': 'Confirm and start',
  'workflow.planReview.continuePlanning': 'Continue planning',
  'workflow.empty.title': 'This session has no structured workflow yet',
  'workflow.empty.copy':
    'Return to Chat, enter Plan & Review, and ask for Todos with stable IDs and dependencies.',
  'workflow.empty.action': 'Return to Chat and create a plan',
  'workflow.tabs.attention': 'Needs attention',
  'workflow.connection.connected': 'Daemon connected',
  'workflow.connection.reconnecting': 'Daemon reconnecting',
  'workflow.session.defaultTitle': 'Current Session Workflow',
  'workflow.session.workspace': 'workspace',
  'workflow.dependencies.upstream': 'Depends on',
  'workflow.dependencies.none': 'None',
  'workflow.dependencies.unblocks': 'Unblocks',
  'workflow.dependencies.noDownstream': 'No downstream steps',
  'workflow.activity.empty': 'No Agent runs are linked to a Todo yet.',
  'workflow.activity.showAll': (v) => `Show all ${v?.count ?? 0} runs`,
  'workflow.deliverables.title': 'Session deliverables',
  'workflow.deliverables.none': 'No artifacts have been published yet',
  'workflow.status.running': 'Running',
  'workflow.status.paused': 'Paused',
  'workflow.status.completed': 'Completed',
  'workflow.status.failed': 'Failed',
  'workflow.status.cancelled': 'Cancelled',
  'workflow.task.completed': 'Completed',
  'workflow.task.attention': 'Needs attention',
  'workflow.task.running': 'Collaboration running',
  'workflow.task.waitingExecution': 'Waiting to execute',
  'planExecution.locateCurrent': 'Locate current step',
  'status.mode': 'Approval mode',
  'chat.scrollToBottom': 'Scroll to bottom',
  'chatHeader.toggleEnvironment': 'Toggle environment information',
  'chatHeader.toggleRightPanel': 'Toggle right panel',
  'chatHeader.openArtifacts': (v) => `Artifacts (${v?.count ?? 0})`,
  'environment.title': 'Environment',
  'environment.changes': 'Changes',
  'environment.changeCount': (v) => `${v?.count ?? 0} changed`,
  'environment.clean': 'Clean',
  'environment.workspace': 'Workspace',
  'environment.branch': 'Branch',
  'environment.history': 'Commit history',
  'environment.agents': 'Subagents',
  'environment.unnamedAgent': (v) => `Agent (${v?.index ?? 0})`,
  'workflow.open': 'Open agent workflow',
  'workflow.mainAgent': 'Main agent',
  'workflow.empty': 'No subagents in this workflow',
  'workflow.loadFailed': 'Failed to load agent workflow',
  'environment.unavailable': 'Unavailable',
  'sources.title': 'Sources',
  'sources.count': (v) =>
    `${v?.count ?? 0} ${(v?.count ?? 0) === 1 ? 'source' : 'sources'}`,
  'sources.currentTurn': 'Sources for this turn',
  'sources.add': 'Add source',
  'sources.empty': 'Add files or links for reference.',
  'sources.explanation':
    'Adding a reference does not send its contents to the assistant.',
  'sources.remove': 'Remove source',
  'sources.open': 'Open source',
  'sources.viewAll': 'View all',
  'sources.type': 'Reference type',
  'sources.workspaceFile': 'Workspace file',
  'sources.link': 'Link',
  'sources.location': 'Path or link',
  'sources.name': 'Title (optional)',
  'sources.description': 'Description (optional)',
  'sources.registrationFailed':
    'Message sent; some source details could not be saved',
  'sources.attachmentsLoadFailed': (v) =>
    `Failed to load uploaded files: ${v?.error ?? 'Unknown error'}`,
  'sources.openOriginal': 'Open original',
  'sources.unavailable':
    'This reference is no longer available in this workspace.',
  'environment.attachments': 'Attachments',
  'environment.artifacts': 'Artifacts',
  'environment.artifactsEmpty':
    'Artifacts generated in this session will appear here.',
  'rightPanel.attachmentLoadFailed': (v) =>
    `Failed to load attachment: ${v?.error ?? 'Unknown error'}`,
  'rightPanel.savedContentUnavailable': 'Saved panel content is unavailable',
  'rightPanel.restoreFailed': (v) =>
    `Failed to restore panel: ${v?.error ?? 'Unknown error'}`,
  'userMessage.showMore': 'Show more',
  'userMessage.showLess': 'Collapse',
  'userMessage.sendFailed': 'Failed to send',
  'userMessage.retrySend': 'Retry sending message',
  'userMessage.edit': 'Edit message',
  'message.moreActions': 'More message actions',
  ...MESSAGE_DELETION_MESSAGES_EN,
  'userMessage.editSubmit': 'Send',
  'userMessage.editSending': 'Sending…',
  'userMessage.editBusy': 'Wait for the current turn to finish before editing.',
  'userMessage.editStale':
    'The message changed. Reopen the editor and try again.',
  'userMessage.editAttachmentUnavailable':
    'An attachment is unavailable. The message was not rewound.',
  'userMessage.editSyncFailed':
    'Could not confirm the rewind. Your edit is retained while waiting for synchronization.',
  'userMessage.editFailed': (v) =>
    `Could not resend the edited message: ${v?.reason ?? ''}`,
  'turn.processed': 'Processed',
  'turn.processing': 'Processing',
  'turn.collapse': 'Collapse steps',
  'turn.expand': 'Expand steps',
  'turn.cached': 'cached',
  'turn.executionSteps': (v) => {
    const n = v?.count ?? 0;
    return `${n} step${n === 1 ? '' : 's'}`;
  },
  'turn.toolCalls': (v) => {
    const n = v?.count ?? 0;
    return `${n} tool call${n === 1 ? '' : 's'}`;
  },
  'turn.thinkingCount': (v) => {
    const n = v?.count ?? 0;
    return `${n} thought${n === 1 ? '' : 's'}`;
  },
  'turn.stopped': 'You cancelled this request',
  'turn.stoppedAfter': (v) =>
    `You cancelled this request after ${v?.duration ?? '0s'}`,
  'message.renderError': 'This message could not be displayed.',
  'tasks.title': 'Background tasks',
  'tasks.empty': 'No tasks currently running',
  'tasks.refreshStale': 'Task status may be stale; reconnecting...',
  'tasks.cancelFailed': 'Failed to cancel task',
  'tasks.alreadyStopped': 'Task already stopped',
  'tasks.moreAbove': (v) => `^ ${v?.count ?? 0} more above`,
  'tasks.moreBelow': (v) => `v ${v?.count ?? 0} more below`,
  'tasks.running': 'Running',
  'tasks.pausing': 'Pausing',
  'tasks.completed': 'Completed',
  'tasks.failed': 'Failed',
  'tasks.cancelled': 'Stopped',
  'tasks.paused': 'Paused',
  'tasks.kind.shell': 'Shell',
  'tasks.kind.monitor': 'Monitor',
  'tasks.kind.workflow': 'Workflow',
  'workflow.graph.waiting': 'Waiting for the first agent dispatch…',
  'workflow.graph.notRecorded': 'No execution graph was saved for this run.',
  'workflow.inline.loading': 'Loading live workflow execution…',
  'workflow.inline.unavailable':
    'This workflow run is no longer available in the current session.',
  'workflow.graph.omitted': (v) =>
    `Graph limited for performance: ${v?.lanes ?? 0} phases, ${v?.nodes ?? 0} agents, and ${v?.edges ?? 0} connections omitted.`,
  'workflow.noPhase': 'No phase',
  'workflow.phase.notStarted': 'Not started',
  'workflow.dispatchCount': (v) =>
    `${v?.count ?? 0} dispatch${v?.count === 1 ? '' : 'es'}`,
  'workflow.selectedDispatch': 'Selected dispatch',
  'workflow.dependencies': 'Depends on',
  'workflow.action.pause': 'Pause',
  'workflow.action.resume': 'Resume',
  'workflow.action.retry': 'Retry failed path',
  'workflow.action.rerun': 'Rerun all',
  'workflow.action.unavailable': 'Workflow state changed before the action.',
  'workflow.action.argsUnavailable':
    'No restart: its history does not have the args it was launched with.',
  'workflow.action.failed': 'Could not update the workflow.',
  'workflow.history.retry': (v) => `Retried from ${v?.runId ?? ''}`,
  'workflow.history.rerun': (v) => `Rerun from ${v?.runId ?? ''}`,
  'workflow.history.cached': (v) => `${v?.count ?? 0} cached`,
  'workflow.history.saved': (v) => `${v?.count ?? 0} saved runs`,
  'workflow.history.restored': 'Saved run',
  'workflow.history.showRuns': (v) => `Run history (${v?.count ?? 0})`,
  'workflow.history.hideRuns': 'Hide history',
  'workflow.history.filter': 'Filter runs',
  'workflow.history.filterAll': 'All statuses',
  'workflow.history.visibleCount': (v) =>
    `${v?.count ?? 0} of ${v?.total ?? 0}`,
  'workflow.history.filterEmpty': 'No saved runs match this filter.',
  'workflow.history.exportVisible': 'Export visible',
  'workflow.history.delete': 'Delete',
  'workflow.history.deleteSaved': 'Delete saved run',
  'workflow.history.confirmDelete': 'Confirm delete',
  'workflow.history.deleteUnavailable': 'The saved run is no longer available.',
  'workflow.history.deleteFailed': 'Could not delete the saved run.',
  'workflow.history.compareRun': (v) => `Compare run ${v?.runId ?? ''}`,
  'workflow.history.compare': 'Compare runs',
  'workflow.history.hideComparison': 'Hide comparison',
  'workflow.history.source': 'Source run',
  'workflow.history.compared': 'Compared run',
  'workflow.history.current': 'Current run',
  'workflow.history.status': 'Status',
  'workflow.history.agents': 'Agents',
  'workflow.approvalNeeded': 'Approval needed',
  'workflow.respondInChat': 'Respond in chat',
  'workflow.metric.agents': 'agents',
  'workflow.metric.running': 'running',
  'workflow.metric.queued': 'queued',
  'workflow.metric.tokens': 'tokens',
  'workflow.dispatch.queued': 'Queued',
  'workflow.dispatch.running': 'Running',
  'workflow.dispatch.completed': 'Completed',
  'workflow.dispatch.failed': 'Failed',
  'workflow.dispatch.cancelled': 'Cancelled',
  'workflow.dispatch.cached': 'Cached',
  'tasks.action.stop': 'Stop',
  'tasks.action.abandon': 'Abandon',
  'tasks.action.confirmStop': 'Confirm stop',
  'tasks.action.confirmAbandon': 'Confirm abandon',
  'tasks.action.confirmHint': 'This will end the blocking turn.',
  'tasks.pill.agent': (v) => `${v?.count ?? 0} local agent`,
  'tasks.pill.agents': (v) => `${v?.count ?? 0} local agents`,
  'tasks.pill.session': (v) => `${v?.count ?? 0} other session`,
  'tasks.pill.sessions': (v) => `${v?.count ?? 0} other sessions`,
  'tasks.pill.sessionWaiting': (v) =>
    `${v?.count ?? 0} ${v?.count === 1 ? 'session needs' : 'sessions need'} your answer`,
  'tasks.waitingForInput': 'Needs your answer',
  'tasks.pill.monitor': (v) => `${v?.count ?? 0} monitor`,
  'tasks.pill.monitors': (v) => `${v?.count ?? 0} monitors`,
  'tasks.pill.shell': (v) => `${v?.count ?? 0} shell`,
  'tasks.pill.shells': (v) => `${v?.count ?? 0} shells`,
  'tasks.pill.workflow': (v) => `${v?.count ?? 0} workflow`,
  'tasks.pill.workflows': (v) => `${v?.count ?? 0} workflows`,
  'tasks.explain.tooltip': 'Explain what this task is doing',
  'tasks.explain.aria': (v) => `Explain task: ${v?.label ?? ''}`,
  'tasks.explain.display': (v) =>
    `Explain what this task is doing: ${v?.label ?? ''}`,
  'tasks.explain.question': (v) =>
    `This session has a background task. Using the conversation context and the task facts below, explain what this task is doing and why it was started. Answer concisely in 2-4 sentences.\n\nTask facts:\n${v?.facts ?? ''}`,
  'tasks.confirmStop': 'x again to confirm stop · ends the blocking turn',
  'tasks.shortcut.select': '↑/↓ select',
  'tasks.shortcut.view': 'Enter view',
  'tasks.shortcut.stop': 'x stop',
  'tasks.shortcut.abandon': 'x abandon',
  'tasks.shortcut.listClose': '←/Esc close',
  'tasks.shortcut.detailBack': '← go back',
  'tasks.shortcut.detailClose': 'Esc/Enter/Space close',
  'tasks.shortcut.close': 'Esc close',
  'tasks.shortcut.cancelConfirm': 'Esc cancel',
  'tasks.detail.workingDir': 'Working dir',
  'tasks.detail.outputFile': 'Output file',
  'tasks.detail.startedAt': 'Started',
  'tasks.detail.endedAt': 'Ended',
  'tasks.detail.totalDuration': 'Total duration',
  'tasks.detail.residentMemory': 'Resident memory',
  'tasks.detail.output': 'Output',
  'tasks.detail.outputSize': (v) => `: ${v?.size ?? ''}`,
  'tasks.detail.outputEmpty': 'No output yet',
  'tasks.detail.outputNone': 'No output',
  'tasks.detail.runtimeUnavailable': 'Task details are no longer available',
  'tasks.detail.outputPartial':
    'Output is available, but file details could not be read',
  'tasks.detail.outputRefreshFailed': 'Could not refresh output. ',
  'tasks.detail.outputTruncated': 'Showing the end only',
  'tasks.detail.outputUnavailable': 'Output unavailable',
  'tasks.detail.lastWrite': 'Last write',
  'tasks.detail.command': 'Command',
  'tasks.detail.events': (v) => `${v?.count ?? 0} events`,
  'tasks.detail.exit': (v) => `exit ${v?.exitCode ?? ''}`,
  'tasks.detail.dropped': (v) => `${v?.count ?? 0} dropped`,
  'tasks.detail.error': 'Error',
  'tasks.detail.stoppedBecause': 'Stopped because',
  'tasks.detail.resumeBlocked': 'Resume blocked',
  'tasks.detail.progress': 'Progress',
  'tasks.detail.prompt': 'Prompt',
  'tasks.detail.type': 'Type',
  'tasks.detail.runtime': 'Time',
  'tasks.detail.eventCount': 'Events',
  'tasks.detail.pid': 'PID',
  'tasks.detail.lastEvent': 'Last event',
  'tasks.detail.droppedCount': 'Dropped',
  'tasks.detail.exitCode': 'Exit code',
  'tasks.detail.tokenCount': 'Tokens',
  'tasks.detail.toolCallCount': 'Tool calls',
  'tasks.detail.tokens': (v) => `${v?.count ?? 0} tokens`,
  'tasks.detail.toolCalls': (v) => `${v?.count ?? 0} tool calls`,
  'tasks.detail.nesting': 'Nesting',
  'tasks.detail.nestingValue': (v) =>
    `Level ${v?.level ?? '?'} · from ${v?.parent ?? '?'}`,
  'tasks.detail.nestingLevel': (v) => `Level ${v?.level ?? '?'}`,
  'tasks.row.from': (v) => `from ${v?.parent ?? '?'}`,
  'tasks.row.nested': 'nested',
  'tips.items':
    'Type / to see all available commands.|Use @ to reference file paths.|Press Esc to cancel an in-flight request.|Use Shift+Enter for a newline.|Press ↑↓ to browse message history.',
  'tools.available': 'Available tools:',
  'tools.none': 'No tools available.',
  'tools.empty': 'No built-in tools available. Open a session first.',
  'tools.footer': (v) =>
    v?.name
      ? `${v?.details ? 'Enter/Space for details · ' : ''}t to toggle ${v.name} · r to refresh · Esc to close`
      : 'r to refresh · Esc to close',
  'tools.details.hide': 'Hide details',
  'tools.details.show': 'Show details',
  'tools.description': 'Description',
  'tools.details': 'Tool details',
  'tools.loading': 'Loading tools...',
  'tools.name': 'Tool name',
  'tools.noDescription': 'No description',
  'tools.noMatches': 'No matching tools.',
  'tools.search': 'Search tools…',
  'tools.status': 'Status',
  'tools.status.disabled': 'disabled',
  'tools.status.enabled': 'enabled',
  'tools.summary': (v) => `${v?.enabled ?? 0}/${v?.total ?? 0} enabled`,
  'tools.title': 'Tools',
  'tools.update.disable': 'Disable',
  'tools.update.enable': 'Enable',
  'tools.updating': 'Updating...',
  'tool.collapse': '▲ Collapse',
  'tool.expand': 'Expand',
  'tool.viewFile': 'View file',
  'tool.viewImage': 'View image',
  'tool.viewCurrentFile': 'View the current file',
  'tool.collapseHint': 'Collapse',
  'tool.status.failed': 'Failed',
  'toolGroup.moreKinds': (v) => ` +${v?.count ?? 0}`,
  'toolGroup.summary': (v) =>
    `Ran ${v?.count ?? 0} tool${v?.count === 1 ? '' : 's'}`,
  'toolGroup.summary.ranAgents': (v) =>
    `Ran ${v?.count ?? 0} agent${v?.count === 1 ? '' : 's'}`,
  'toolGroup.summary.editedFiles': (v) =>
    `Edited files ${v?.count ?? 0} time${v?.count === 1 ? '' : 's'}`,
  'toolGroup.summary.ranCommands': (v) =>
    `Ran ${v?.count ?? 0} command${v?.count === 1 ? '' : 's'}`,
  'toolGroup.summary.readFiles': (v) =>
    `Read files ${v?.count ?? 0} time${v?.count === 1 ? '' : 's'}`,
  'toolGroup.summary.searched': (v) =>
    `Searched ${v?.count ?? 0} time${v?.count === 1 ? '' : 's'}`,
  'toolGroup.summary.updatedTodos': (v) =>
    `Updated task list${v?.count === 1 ? '' : ` ${v?.count ?? 0} times`}`,
  'toolGroup.summary.provideInformation': 'Provide information',
  'toolGroup.summary.askedQuestions': (v) =>
    `Asked ${v?.count ?? 0} question${v?.count === 1 ? '' : 's'}`,
  'toolGroup.summary.otherTools': (v) =>
    `Called ${v?.count ?? 0} other tool${v?.count === 1 ? '' : 's'}`,
  'toolGroup.running': (v) =>
    Number(v?.count ?? 0) > 1
      ? `Running ${v?.count ?? 0} tools: ${v?.name ?? 'tool'}`
      : `Running ${v?.name ?? 'tool'}`,
  'toolGroup.runningPrefix': 'Running',
  'thinking.expand': 'Expand thinking',
  'thinking.collapse': 'Collapse thinking',
  'thinking.running': (v) => `Thinking${v?.duration ? ` ${v.duration}` : ''}`,
  'thinking.doneBriefly': 'Thought briefly',
  'thinking.done': (v) =>
    v?.duration ? `Thought for ${v.duration}` : 'Done thinking',
  'thinking.translate': 'Translate',
  'thinking.translation': 'Translated thinking',
  'thinking.translating': 'Translating...',
  'thinking.translationThinking': 'Thinking...',
  'thinking.translationFailed': 'Translation failed',
  'thinking.retranslate': 'Translate again',
  'thinking.cancelTranslation': 'Cancel',
  'thinking.closeTranslation': 'Close',
  'thinking.inputTokens': (v) => `Input tokens: ${v?.count ?? '--'}`,
  'thinking.outputTokens': (v) => `Output tokens: ${v?.count ?? '--'}`,
  'sessionsOverview.current': 'Current',
  'sessionsOverview.empty': 'No sessions yet',
  'sessionsOverview.loadFailed': 'Failed to load sessions',
  'sessionsOverview.loading': 'Loading sessions…',
  'sessionsOverview.noData': 'No data',
  'sessionsOverview.openInSplit': 'Open in split',
  'sessionsOverview.openInSplitHint':
    'Show the selected sessions side by side in this window',
  'sessionsOverview.splitLimit': (v) =>
    `Select at most ${v?.max ?? 6} sessions to open them together`,
  'sessionsOverview.openInTab': 'Open in new tab',
  'sessionsOverview.openInTabHint':
    'Open the selected sessions as a split view in a new browser tab',
  'sessionsOverview.popupBlocked':
    'Pop-up blocked. Allow pop-ups for this site to open sessions in new tabs.',
  'sessionsOverview.refresh': 'Refresh',
  'sessionsOverview.selectAll': 'Select all',
  'sessionsOverview.titleColumn': 'Title',
  'sessionsOverview.actions': 'Actions',
  'sessionsOverview.time': 'Time',
  'sessionsOverview.selectedRows': (v) =>
    `${v?.count ?? 0} of ${v?.total ?? 0} row(s) selected.`,
  'sessionsOverview.previousPage': 'Previous',
  'sessionsOverview.nextPage': 'Next',
  'sessionsOverview.pageInfo': (v) =>
    `Page ${v?.page ?? 0} of ${v?.total ?? 0}`,
  'sessionsOverview.rowsPerPage': 'Rows per page',
  'sessionsOverview.workspaceFilter': 'Filter by workspace',
  'sessionsOverview.allWorkspaces': 'All',
  'sessionsOverview.searchPlaceholder': 'Search title, branch, PR or ID…',
  'sessionsOverview.workspaceAll': 'All workspaces',
  'sessionsOverview.workspacesSelected': (v) =>
    `${v?.count ?? 0}/${v?.total ?? 0} workspaces`,
  'sessionsOverview.statusColumn': 'Status',
  'sessionsOverview.statusFilter': 'Filter by session status',
  'sessionsOverview.filter.all': 'All',
  'sessionsOverview.filter.attention': 'Needs attention',
  'sessionsOverview.filter.running': 'Running',
  'sessionsOverview.filter.idle': 'Idle',
  'sessionsOverview.status.idle': 'Idle',
  'sessionsOverview.details': (v) => `Details for ${v?.name ?? ''}`,
  'sessionsOverview.sessionCount': (v) => `${v?.total ?? 0} session(s)`,
  'sessionsOverview.confirmArchiveTitle': 'Archive session?',
  'sessionsOverview.confirmArchive': (v) =>
    `"${v?.name ?? ''}" will be moved to archived sessions.`,
  'sessionsOverview.confirmArchiveBulkTitle': (v) =>
    `Archive ${v?.count ?? 0} sessions?`,
  'sessionsOverview.confirmArchiveBulk': (v) =>
    `${v?.count ?? 0} selected sessions will be moved to archived sessions.`,
  'sessionsOverview.confirmDeleteTitle': 'Delete session?',
  'sessionsOverview.confirmDelete': (v) =>
    `"${v?.name ?? ''}" and its conversation history will be permanently deleted. This cannot be undone.`,
  'sessionsOverview.deleteFailed': 'Failed to delete session',
  'sessionsOverview.archiveFailed': 'Failed to archive session',
  'sessionsOverview.actionUnavailable':
    'This action is unavailable for the selected session or workspace',
  'sessionsOverview.bulkArchive': 'Archive',
  'sessionsOverview.bulkArchiveHint': (v) =>
    `Archive ${v?.count ?? 0} selected sessions`,
  'sessionsOverview.bulkDelete': 'Delete',
  'sessionsOverview.bulkDeleteHint': (v) =>
    `Delete ${v?.count ?? 0} selected sessions`,
  'sessionsOverview.confirmDeleteBulkTitle': (v) =>
    `Delete ${v?.count ?? 0} sessions?`,
  'sessionsOverview.confirmDeleteBulk': (v) =>
    `${v?.count ?? 0} selected sessions and their conversation history will be permanently deleted. This cannot be undone.`,
  'sessionsOverview.selectSession': (v) => `Select ${v?.name ?? ''}`,
  'sessionsOverview.status.askUserQuestion': 'User input needed',
  'sessionsOverview.status.needsApproval': 'Needs approval',
  'sessionsOverview.status.running': 'Running',
  'sessionsOverview.title': 'Session Overview',
  'workspacesOverview.title': 'Workspaces',
  'workspacesOverview.count': (v) => `${v?.count ?? 0} workspaces`,
  'workspacesOverview.column.name': 'Name',
  'workspacesOverview.column.path': 'Path',
  'workspacesOverview.column.sessions': 'Sessions',
  'workspacesOverview.column.mcp': 'MCP',
  'workspacesOverview.column.git': 'Branch',
  'workspacesOverview.column.lastActivity': 'Last activity',
  'workspacesOverview.column.actions': 'Actions',
  'workspacesOverview.primaryBadge': 'primary',
  'workspacesOverview.running': (v) => `${v?.count ?? 0} running`,
  'workspacesOverview.attention': (v) => `${v?.count ?? 0} need attention`,
  'workspacesOverview.truncated':
    'More sessions than one page; counts are a lower bound.',
  'workspacesOverview.dirty': (v) => `${v?.count ?? 0} changed`,
  'workspacesOverview.mcpFailed': (v) => `${v?.count ?? 0} failed`,
  'workspacesOverview.newTask': 'New session',
  'workspacesOverview.trust': 'Trust',
  'workspacesOverview.trusting': 'Trusting…',
  'workspacesOverview.trustFailed': 'Could not trust the workspace',
  'workspacesOverview.remove': 'Remove workspace',
  'workspacesOverview.back': 'Back',
  'splitView.title': 'Split View',
  'splitView.count': (v) => `${v?.count ?? 0} panes`,
  'splitView.addPane': 'Add session',
  'splitView.closePane': 'Close pane',
  'splitView.maximizePane': 'Maximize pane',
  'splitView.restorePane': 'Restore pane',
  'splitView.morePaneActions': 'More pane actions',
  'splitView.defaultActionLabel': 'Action',
  'splitView.paneError': 'This session pane hit an error',
  'splitView.paneConnectionError': 'Connection lost',
  'splitView.outerApprovalPending':
    'Your main session is waiting for approval.',
  'splitView.goToApproval': 'Go to it',
  'splitView.pendingCount': (v) => `${v?.count ?? 0} awaiting input`,
  'splitView.nextPending': 'Go to the next session awaiting input',
  'splitView.noOtherSessions': 'No other sessions',
  'splitView.empty': 'No sessions in the split. Add one to get started.',
  'splitView.composerPlaceholder': 'Message this session…',
  'channels.title': 'Channels',
  'channels.description':
    'Connect Qwen Code to the places where your team already works.',
  'channels.summary': (v) =>
    `${v?.workspace ?? ''} · ${v?.count ?? 0} configured`,
  'channels.workspace.current': 'Current workspace',
  'channels.workspace.label': 'Workspace',
  'channels.workspace.primary': 'Primary',
  'channels.loading': 'Loading channels',
  'channels.configuredCount': (v) => plural(v?.count, 'configured channel'),
  'channels.configured': 'Configured channels',
  'channels.configured.description':
    'Manage the bots that receive and deliver messages for this workspace.',
  'channels.availablePlatforms': 'Available platforms',
  'channels.availablePlatforms.description':
    'Choose a platform to add another connection to this workspace.',
  'channels.platform.available': 'Available',
  'channels.platform.configure': 'Configure',
  'channels.platform.add': 'Add connection',
  'channels.platform.name.dingtalk': 'DingTalk',
  'channels.platform.name.feishu': 'Feishu',
  'channels.platform.name.wecom': 'WeCom',
  'channels.platform.name.generic-webhook': 'Generic Webhook',
  'channels.method.title': (v) =>
    `Choose a ${v?.platform ?? 'Channel'} connection`,
  'channels.method.description': (v) =>
    `Choose how this Channel connects to ${v?.platform ?? 'the platform'}.`,
  'channels.method.applicationBot': 'Application bot',
  'channels.method.applicationBot.description':
    'Receive messages and reply using an application bot.',
  'channels.method.intelligentBot': 'Intelligent bot',
  'channels.method.intelligentBot.description':
    'Receive messages and reply using an intelligent bot.',
  'channels.method.webhook': 'Webhook (send only)',
  'channels.method.webhook.description':
    'Send notifications to the group configured by a custom bot webhook.',
  'channels.status.readyToSend': 'Ready to send',
  'channels.statusDescription.readyToSend':
    'Ready locally. Remote credentials are checked when sending.',
  'channels.statusDescription.notReadyToSend':
    'Not ready to send notifications.',
  'channels.statusDescription.outbound':
    'Sends notifications to the configured destination.',
  'channels.platform.configureNamed': (v) =>
    `Configure ${v?.platform ?? 'Channel'}`,
  'channels.status.stopped': 'Stopped',
  'channels.status.starting': 'Starting',
  'channels.status.connected': 'Connected',
  'channels.status.partial': 'Partially connected',
  'channels.status.error': 'Error',
  'channels.statusDescription.stopped': 'Offline and not receiving messages.',
  'channels.statusDescription.starting': 'Connecting to the platform now.',
  'channels.statusDescription.connected':
    'Online and ready to receive messages.',
  'channels.statusDescription.partial':
    'Connected, but some capabilities are unavailable.',
  'channels.statusDescription.error': 'Needs attention before it can connect.',
  'channels.startsWithServe': 'Connect when Qwen Code starts',
  'channels.startsWithServe.description':
    'Automatically bring this Channel online after Qwen Code starts.',
  'channels.unsupported.title': 'Channel management is not supported',
  'channels.unsupported.description':
    'Update Qwen Code to a version that supports Channel management.',
  'channels.readOnly.title': 'Channel management is read-only',
  'channels.readOnly.description':
    'Restart Qwen Code with a bearer token to control channels.',
  'channels.loadError.title': 'Channels could not be loaded',
  'channels.empty.title': 'No supported channels configured',
  'channels.empty.description':
    'Configure WeChat, DingTalk, WeCom, Feishu, GitHub, GitLab, or Email to receive messages in this workspace.',
  'channels.runtimeError': 'Channel runtime error',
  'channels.action.back': 'Back',
  'channels.action.refresh': 'Refresh',
  'channels.action.start': 'Start',
  'channels.action.stop': 'Stop',
  'channels.action.restart': 'Restart',
  'channels.action.retry': 'Retry',
  'channels.action.edit': 'Edit',
  'channels.action.editNamed': (v) => `Edit ${v?.name ?? 'Channel'}`,
  'channels.action.moreNamed': (v) =>
    `More actions for ${v?.name ?? 'Channel'}`,
  'channels.action.delete': 'Delete',
  'channels.action.deleteNamed': (v) => `Delete ${v?.name ?? 'Channel'}`,
  'channels.action.startWithServeNamed': (v) =>
    `Start ${v?.name ?? ''} with serve`,
  'channels.delete.title': (v) => `Delete ${v?.name ?? 'Channel'}?`,
  'channels.delete.description':
    'The Channel will be stopped and removed from this workspace. This action cannot be undone.',
  'channels.delete.error': 'Channel was not deleted',
  'channels.editor.addTitle': (v) => `Configure ${v?.platform ?? 'Channel'}`,
  'channels.editor.editTitle': (v) => `Edit ${v?.platform ?? 'Channel'}`,
  'channels.editor.addDescription':
    'Connect a registered workspace with an existing platform application.',
  'channels.editor.editDescription':
    'Update public settings or explicitly change stored credentials.',
  'channels.editor.section.identity': 'Identity',
  'channels.editor.section.credentials': 'Credentials',
  'channels.editor.section.connection': 'Connection',
  'channels.editor.section.routing': 'Notifications and routing',
  'channels.editor.section.boundSessions': 'PR-bound sessions',
  'channels.editor.section.boundSessions.description':
    'Watch events apply to PRs bound to a live session. Enable delivery first, then choose the transitions to watch.',
  'channels.editor.section.session': 'Conversation management',
  'channels.editor.section.access': 'Access control',
  'channels.editor.section.access.description':
    'Configure direct-message and group access separately.',
  'channels.editor.section.advanced': 'Advanced settings',
  'channels.editor.section.advanced.description':
    'Rarely changed tuning for connection, routing, and session behavior.',
  'channels.editor.section.advanced.configuredCount': (v) =>
    `${v?.count ?? 0} configured`,
  'channels.editor.session.isolation': 'Conversation isolation',
  'channels.editor.instanceName': 'Instance name',
  'channels.editor.instanceNamePlaceholder': 'e.g. release-bot',
  'channels.editor.workspace': 'Workspace',
  'channels.editor.workspace.description':
    'Messages, sessions, and Channel settings belong to this workspace. The primary workspace is selected by default.',
  'channels.editor.workspace.lockedDescription':
    'A configured Channel stays bound to its workspace. Create another instance to use a different workspace.',
  'channels.editor.environmentReference': '$ENV_VAR supported',
  'channels.editor.field.sessionScope': 'Session scope',
  'channels.editor.field.sessionScope.description':
    'Controls which incoming conversations share one agent session.',
  'channels.editor.field.sessionScope.option.user': 'Per user and chat',
  'channels.editor.field.sessionScope.option.thread': 'Per thread',
  'channels.editor.field.sessionScope.option.chat_thread':
    'Per chat and thread',
  'channels.editor.field.sessionScope.option.single': 'One shared session',
  'channels.qrLogin.title': 'Bind by QR code',
  'channels.qrLogin.description':
    'Scan with the QQ mobile app to bind a bot. The secret stays on this machine.',
  'channels.qrLogin.start': 'Scan to bind',
  'channels.qrLogin.refresh': 'New code',
  'channels.qrLogin.waiting': 'Preparing the QR code…',
  'channels.qrLogin.scanHint': 'Open QQ on your phone and scan this code.',
  'channels.qrLogin.imageAlt': 'QQ bot binding QR code',
  'channels.qrLogin.bound':
    'Bot bound. The channel now uses the new credentials.',
  'channels.qrLogin.failed': 'Binding failed',
  'channels.qrLogin.expired': 'The code expired. Request a new one.',
  'channels.qrLogin.cancelled': 'Binding cancelled.',
  'channels.qrLogin.error': 'Could not complete the QR binding.',
  'channels.editor.field.dingtalk.clientId': 'Client ID (AppKey)',
  'channels.editor.field.dingtalk.clientSecret': 'Client Secret (AppSecret)',
  'channels.editor.field.webhook.webhookUrl': 'Webhook URL',
  'channels.editor.field.webhook.webhookUrl.description':
    'The secret webhook address of your custom bot.',
  'channels.editor.field.webhook.signingSecret': 'Signing secret',
  'channels.editor.field.webhook.signingSecret.description':
    'Required if signature verification is enabled for the custom bot.',
  'channels.editor.field.genericWebhook.webhookUrl': 'Webhook URL',
  'channels.editor.field.genericWebhook.webhookUrl.description':
    'Your receiver’s HTTPS endpoint. Local or private endpoints require the advanced setting below.',
  'channels.editor.field.genericWebhook.bearerToken': 'Bearer token',
  'channels.editor.field.genericWebhook.bearerToken.description':
    'Optional token sent in the Authorization header. Leave empty if your receiver does not require it.',
  'channels.editor.field.genericWebhook.allowPrivateNetwork':
    'Allow local and private endpoints',
  'channels.editor.field.genericWebhook.networkDescription':
    'Network access for this endpoint.',
  'channels.editor.field.genericWebhook.allowPrivateNetwork.description':
    'Allow this endpoint to use local or private addresses, including HTTP. Localhost refers to the Qwen Code daemon host or container. Public endpoints still require HTTPS.',
  'channels.editor.field.weixin.groupPolicy': 'Group policy',
  'channels.editor.field.weixin.groupPolicy.description':
    'WeChat iLink Bot only supports direct messages, so groups stay disabled.',
  'channels.editor.field.weixin.groupPolicy.option.disabled': 'Disabled',
  'channels.editor.field.weixin.allowedUsers': 'Pre-approved users (optional)',
  'channels.editor.field.weixin.allowedUsers.description':
    'Leave empty and approve people under "Pending requests" below instead — an approval is remembered. Fill this only to pre-approve someone whose platform user ID you already have (looks like oAbCd…@im.wechat). A WeChat name or handle does not match here and is silently ignored.',
  'channels.weixin.title': 'WeChat account',
  'channels.weixin.description':
    'Log in by scanning a QR code with WeChat. This account is shared by every WeChat channel on this daemon.',
  'channels.weixin.loggedIn': 'Logged in',
  'channels.weixin.loggedOut': 'Not logged in',
  'channels.weixin.login': 'Log in with QR code',
  'channels.weixin.relogin': 'Log in again',
  'channels.weixin.logout': 'Log out',
  'channels.weixin.refresh': 'Refresh QR code',
  'channels.weixin.waiting': 'Scan the QR code with WeChat.',
  'channels.weixin.preparing': 'Preparing a new QR code…',
  'channels.weixin.scanned': 'Scanned. Confirm on your phone.',
  'channels.weixin.ready': 'WeChat connected.',
  'channels.weixin.expired': 'QR code expired. Refresh to try again.',
  'channels.weixin.error': 'WeChat login failed. Try again.',
  'channels.weixin.credentialsError':
    'WeChat connected, but the daemon could not save the credential. Check that its home directory is writable, then try again.',
  'channels.weixin.unsupported':
    'This daemon does not support WeChat login. Update the daemon, or run "qwen channel configure-weixin" on the host.',
  'channels.weixin.restartHint':
    'Channels that are already running keep the previous account until they are restarted.',
  'channels.weixin.userId': (v) => `User ID: ${v?.id ?? ''}`,
  'channels.weixin.savedAt': (v) => `Logged in at ${v?.time ?? ''}`,
  'channels.weixin.qrAlt': 'WeChat login QR code',
  'channels.weixin.openUrl': 'Open the login URL',
  'channels.editor.field.wecom.botId': 'Bot ID',
  'channels.editor.field.wecom.secret': 'Bot Secret',
  'channels.editor.field.wecom.wsUrl': 'WebSocket URL',
  'channels.editor.field.feishu.clientId': 'App ID',
  'channels.editor.field.feishu.clientSecret': 'App Secret',
  'channels.editor.field.github.token': 'Personal Access Token',
  'channels.editor.field.github.token.description':
    'Optional classic PAT with "notifications" scope. Overrides local gh authentication',
  'channels.editor.field.github.token.localGhHint':
    'Local gh authentication is selected. The token cannot be edited here, and any stored token is removed on save.',
  'channels.editor.field.github.allowedRepos': 'Allowed repositories',
  'channels.editor.field.github.allowedRepos.description':
    'Comma-separated repository full names, for example owner/repo.',
  'channels.editor.field.github.allowedRepos.placeholder': 'owner/repo',
  'channels.editor.field.gitlab.allowedRepos': 'Allowed projects',
  'channels.editor.field.gitlab.allowedRepos.description':
    'Comma-separated project paths, for example group/subgroup/project.',
  'channels.editor.field.gitlab.allowedRepos.placeholder': 'group/project',
  'channels.editor.field.github.useLocalGh':
    'Use local GitHub CLI authentication',
  'channels.editor.field.github.useLocalGh.description':
    'Explicitly reuse the daemon host’s account-wide gh login when no token is configured',
  'channels.editor.field.github.baseUrl': 'API Base URL',
  'channels.editor.field.github.baseUrl.description':
    'GitHub Enterprise API root (e.g. https://ghe.example.com/api/v3). Leave empty for github.com',
  'channels.editor.field.github.pollInterval': 'Poll Interval (ms)',
  'channels.editor.field.github.pollInterval.description':
    "How often to check GitHub for new notifications. Leave empty for 60000 (one minute). A steady-state poll is raised to the endpoint's X-Poll-Interval when that is larger, which paces the PR watch too, so a smaller value will not make detection faster; at the default the header is also 60s.",
  'channels.editor.field.github.repositorySettings': 'Per-repository settings',
  'channels.editor.field.github.repositorySettings.description':
    'Each allowlisted repository inherits the channel-wide settings below until you override it here.',
  'channels.editor.field.github.requireMention': 'Require a mention',
  'channels.editor.field.github.requireMention.inheritOn':
    'Inherit (require a mention)',
  'channels.editor.field.github.requireMention.inheritOff':
    'Inherit (answer without a mention)',
  'channels.editor.field.github.requireMention.on': 'Require a mention',
  'channels.editor.field.github.requireMention.off': 'Answer without a mention',
  'channels.editor.field.github.repositorySenders': 'Who may speak',
  'channels.editor.field.github.repositorySenders.inheritOpen':
    'Inherit (anyone)',
  'channels.editor.field.github.repositorySenders.inheritAllowlist':
    'Inherit (allowlist only)',
  'channels.editor.field.github.repositorySenders.open': 'Anyone',
  'channels.editor.field.github.repositorySenders.allowlist': 'Allowlist only',
  'channels.editor.field.github.repositorySpeakers': 'Allowed speakers',
  'channels.editor.field.github.repositorySpeakers.placeholder': 'alice, bob',
  'channels.editor.field.github.repositorySpeakers.description':
    'GitHub logins allowed to start tasks in this repository. Empty means nobody.',
  'channels.editor.field.github.repositorySpeakers.inherited':
    'GitHub logins allowed in this repository. Leave empty to use the channel-wide list.',
  'channels.editor.field.gitlab.repositorySpeakers.description':
    'GitLab usernames allowed to start tasks in this project. Empty means nobody.',
  'channels.editor.field.gitlab.repositorySpeakers.inherited':
    'GitLab usernames allowed in this project. Leave empty to use the channel-wide list.',
  'channels.editor.field.github.retainedRepositorySettings.title':
    'Repository settings still apply',
  'channels.editor.field.github.retainedRepositorySettings.description': (v) =>
    `These repositories keep their own speaker and mention settings even though the group policy no longer uses an allowlist: ${v?.repositories ?? ''}. Switch the group policy back to Allowlist to edit them.`,
  'channels.editor.field.github.retainedRepositorySettings.disabled.title':
    'Repository settings are kept but not applied',
  'channels.editor.field.github.retainedRepositorySettings.disabled.description':
    (v) =>
      `The group policy is Disabled, so no repository traffic is processed. These repositories keep their own speaker and mention settings, and they apply again once the policy admits group traffic: ${v?.repositories ?? ''}. Switch the group policy back to Allowlist to edit them.`,
  'channels.editor.field.github.groupPolicy': 'Group Policy',
  'channels.editor.field.github.groupPolicy.description':
    'Must be "Open", "Allowlist", or "Pairing" for notifications to flow',
  'channels.editor.field.github.reasonFilter': 'Reason Filter',
  'channels.editor.field.github.reasonFilter.description':
    'Optional. Only notifications with a checked reason are processed. Leave every reason unchecked to process all of them.',
  'channels.editor.field.github.reasonFilter.option.mention':
    'mention — the bot is @mentioned',
  'channels.editor.field.github.reasonFilter.option.review_requested':
    'review_requested — the bot, or a team it belongs to, was asked to review a pull request',
  'channels.editor.field.github.reasonFilter.option.assign':
    'assign — the bot was assigned to the issue',
  'channels.editor.field.github.reasonFilter.option.author':
    'author — the bot created the thread',
  'channels.editor.field.github.reasonFilter.option.comment':
    'comment — the bot commented on the thread',
  'channels.editor.field.github.reasonFilter.option.ci_activity':
    'ci_activity — a workflow run the bot triggered completed',
  'channels.editor.field.github.reasonFilter.option.manual':
    'manual — the bot subscribed to the thread from an issue or pull request',
  'channels.editor.field.github.reasonFilter.option.state_change':
    'state_change — the bot changed the thread state, such as closing an issue',
  'channels.editor.field.github.reasonFilter.option.subscribed':
    'subscribed — the bot is watching the repository',
  'channels.editor.field.github.reasonFilter.option.team_mention':
    'team_mention — a team the bot belongs to is @mentioned',
  'channels.editor.field.github.reasonFilter.option.security_alert':
    'security_alert — GitHub found a security vulnerability in the repository',
  'channels.editor.field.github.reasonFilter.option.approval_requested':
    'approval_requested — the bot was asked to review and approve a deployment',
  'channels.editor.field.github.reasonFilter.option.invitation':
    'invitation — the bot accepted an invitation to contribute to the repository',
  'channels.editor.field.github.reasonFilter.option.member_feature_requested':
    'member_feature_requested — organization members asked to enable a feature such as Copilot',
  'channels.editor.field.github.reasonFilter.option.security_advisory_credit':
    'security_advisory_credit — the bot was credited for contributing to a security advisory',
  'channels.editor.field.github.repoFilterMode': 'Repository Filter',
  'channels.editor.field.github.repoFilterMode.description':
    'Filter incoming notifications by repository. Notifications about PRs bound to a session are filtered too; only their PR state watch events bypass the filter.',
  'channels.editor.field.github.repoFilterMode.option.off':
    'Off — all repositories',
  'channels.editor.field.github.repoFilterMode.option.allowlist':
    'Allowlist — only listed repositories',
  'channels.editor.field.github.repoFilterMode.option.blocklist':
    'Blocklist — all except listed repositories',
  'channels.editor.field.github.repoFilter': 'Filtered Repositories',
  'channels.editor.field.github.repoFilter.description':
    'Comma-separated owner/repo names. You can paste repository or PR URLs; they are shortened to owner/repo on save.',
  'channels.editor.field.github.deliverToBoundSessions':
    'Deliver To PR-Bound Sessions',
  'channels.editor.field.github.deliverToBoundSessions.description':
    'Deliver events for PRs bound to a live session into that session as a prompt, instead of a channel-owned session. Requires a daemon-managed channel.',
  'channels.editor.field.github.requireBoundWatch':
    'Require Active Watch For Review/Verify Sessions',
  'channels.editor.field.github.requireBoundWatch.description':
    'Only deliver events to review/verify bound sessions while they hold an active watch on that PR (an /autofix-pr watch or /verify-pr --watch). One-shot /review and /verify-pr sessions stay bound but receive nothing; events with no eligible session retire privately instead of a public reply. Requires Deliver To PR-Bound Sessions. Unknown watch state (detection failure) keeps delivering.',
  'channels.editor.field.github.requireBoundWatch.disabledHint':
    'Enable "Deliver To PR-Bound Sessions" above to require an active watch.',
  'channels.editor.field.github.prCommentWatch': 'PR Comment Watch',
  'channels.editor.field.github.prCommentWatch.description':
    'Poll same-account conversation and inline review comments on bound PRs and deliver each new one to every bound session that did not post it. Enabled by default; turn off to disable. Requires Deliver To PR-Bound Sessions.',
  'channels.editor.field.github.prWatchEvents': 'PR Watch Events',
  'channels.editor.field.github.prWatchEvents.description':
    'Deprecated. The daemon now detects PR-state transitions: configure serve.sessionPrWatch in the daemon settings. For one minor release the key is accepted and read as a per-host alias for PRs on this channel’s web host while that setting is unset and Deliver To PR-Bound Sessions is on.',
  'channels.editor.field.github.prWatchEvents.disabledHint':
    'Enable "Deliver To PR-Bound Sessions" above to select watch events.',
  'channels.editor.field.github.prWatchEvents.option.ci_failure':
    'ci_failure — CI checks turn red on a head commit',
  'channels.editor.field.github.prWatchEvents.option.merge_conflict':
    'merge_conflict — the PR develops a merge conflict',
  'channels.editor.field.github.prWatchEvents.option.head_change':
    'head_change — the PR’s head commit changes',
  'channels.editor.field.github.prWatchEvents.option.state_change':
    'state_change — the PR is merged or closed',
  'channels.editor.field.github.boundSessionActions': 'Bound Session Actions',
  'channels.editor.field.github.boundSessionActions.description':
    'Optional. Instruction templates delivered to PR-bound sessions. Pick an event key below; a role prefix (review:, verify:, fix:) targets that binding role only. Requires Deliver To PR-Bound Sessions. Each role with a matching key gets its own delivery; roles without one skip the event. Variables: %repo%, %pr%, %url%, %title%, %event%, %sender%, %role%; %% for a literal %. Leave empty for the default generic prompt.',
  'channels.editor.field.github.boundSessionActions.disabledHint':
    'Enable "Deliver To PR-Bound Sessions" above to add templates.',
  'channels.editor.field.github.boundSessionActions.group.any': 'Any role',
  'channels.editor.field.github.boundSessionActions.group.review':
    'review — code review sessions',
  'channels.editor.field.github.boundSessionActions.group.verify':
    'verify — verification sessions',
  'channels.editor.field.github.boundSessionActions.group.fix':
    'fix — fix sessions',
  'channels.editor.field.github.boundSessionActions.empty':
    'No templates configured yet.',
  'channels.editor.field.github.boundSessionActions.addPlaceholder':
    'Add template…',
  'channels.editor.field.gitlab.action_prompt_template.empty':
    'No templates configured yet.',
  'channels.editor.field.gitlab.action_prompt_template.addPlaceholder':
    'Add template…',
  // Generic defaults for every record field; template-worded fields override
  // them through their field label key (messageRoutes is routes, not templates).
  'channels.editor.record.addPlaceholder': 'Add entry…',
  'channels.editor.record.empty': 'No entries configured yet.',
  'channels.editor.record.remove': (v) => `Remove ${v?.key ?? ''}`,
  'channels.editor.field.gitlab.token': 'Personal Access Token',
  'channels.editor.field.gitlab.token.description':
    'PAT with "read_api" + "api" scopes',
  'channels.editor.field.gitlab.baseUrl': 'Instance URL',
  'channels.editor.field.gitlab.baseUrl.description':
    'Self-hosted instance URL (e.g. https://gitlab.example.com). Leave empty for gitlab.com',
  'channels.editor.field.gitlab.groupPolicy': 'Group Policy',
  'channels.editor.field.gitlab.groupPolicy.description':
    'Must be "Open", "Allowlist", or "Pairing" for todos to be processed',
  'channels.editor.field.gitlab.action_prompt_template': 'Action Templates',
  'channels.editor.field.gitlab.action_prompt_template.description':
    'Only actions with a template are processed; others are skipped. Template variables: %project%, %project_url%, %author%, %target_type%, %iid%, %title%, %description%, %todo_id%. Use %% for a literal %. Example for "mentioned": Project: %project% | Author: %author% | Title: %title%',
  'channels.editor.field.gitlab.action_prompt_template.option.mentioned':
    'Mentioned — @bot in a comment or description',
  'channels.editor.field.gitlab.action_prompt_template.option.directly_addressed':
    'Directly Addressed — comment starts with @bot',
  'channels.editor.field.gitlab.action_prompt_template.option.assigned':
    'Assigned — bot assigned to an issue or MR',
  'channels.editor.field.gitlab.action_prompt_template.option.review_requested':
    'Review Requested — bot requested as MR reviewer',
  'channels.editor.field.gitlab.action_prompt_template.option.approval_required':
    'Approval Required — MR needs bot approval',
  'channels.editor.field.gitlab.action_prompt_template.option.marked':
    "Marked — someone stars bot's comment/issue/MR",
  'channels.editor.field.gitlab.action_prompt_template.option.build_failed':
    'Build Failed — CI/CD pipeline fails on bot branch/MR',
  'channels.editor.field.gitlab.action_prompt_template.option.unmergeable':
    'Unmergeable — MR becomes unmergeable (conflicts)',
  'channels.editor.field.gitlab.action_prompt_template.option.merge_train_removed':
    'Merge Train Removed — MR removed from merge train',
  'channels.editor.field.email.address': 'Mailbox Address',
  'channels.editor.field.email.imapHost': 'IMAP Host',
  'channels.editor.field.email.imapUser': 'IMAP Username',
  'channels.editor.field.email.imapPassword': 'IMAP Password',
  'channels.editor.field.email.smtpHost': 'SMTP Host',
  'channels.editor.field.email.smtpUser': 'SMTP Username',
  'channels.editor.field.email.smtpPassword': 'SMTP Password',
  'channels.editor.field.email.folder': 'IMAP Folder',
  'channels.editor.field.email.imapPort': 'IMAP Port',
  'channels.editor.field.email.smtpPort': 'SMTP Port',
  'channels.editor.field.email.imapSecure': 'IMAP Implicit TLS',
  'channels.editor.field.email.imapSecure.description':
    'When disabled, STARTTLS is mandatory.',
  'channels.editor.field.email.smtpSecure': 'SMTP Implicit TLS',
  'channels.editor.field.email.smtpSecure.description':
    'When disabled, STARTTLS is mandatory.',
  'channels.editor.field.email.proactiveRecipients': 'Proactive Recipients',
  'channels.editor.field.email.proactiveRecipients.description':
    'Explicit bare addresses. Empty disables proactive email.',
  'channels.editor.field.email.pollInterval': 'Poll Interval (ms)',
  'channels.editor.field.email.maxMessageBytes': 'Message Size Limit (bytes)',
  'channels.editor.field.email.maxAttachmentBytes':
    'Attachment Size Limit (bytes)',
  'channels.editor.field.email.maxTextLength': 'Text Character Limit',
  'channels.editor.field.email.allowedUsers': 'Allowed email addresses',
  'channels.editor.field.email.allowedUsers.description':
    'Comma-separated bare mailbox addresses that can start private conversations.',
  'channels.editor.field.email.operators': 'Session operator addresses',
  'channels.editor.field.email.operators.description':
    'Comma-separated bare mailbox addresses that may approve tool use and run /cancel, /clear or /loop in shared sessions.',
  'channels.editor.secret.environment': 'Stored in environment',
  'channels.editor.secret.stored': 'Stored securely',
  'channels.editor.secret.preserve': 'Keep',
  'channels.editor.secret.replace': 'Replace',
  'channels.editor.secret.clear': 'Clear',
  'channels.editor.secret.placeholder': (v) => `Enter ${v?.label ?? 'secret'}`,
  'channels.editor.secret.clearHint':
    'This credential will be removed when you save.',
  'channels.editor.field.shared.outputMode': 'Output Mode',
  'channels.editor.field.shared.outputMode.description':
    'Choose one final result for the complete task, each complete assistant response, or the last reply in each turn. Defaults to per turn: the main response finishes independently of background follow-ups. Applies to cards and ordinary messages.',
  'channels.editor.field.shared.outputMode.option.per_task': 'Per task',
  'channels.editor.field.shared.outputMode.option.per_response': 'Per response',
  'channels.editor.field.shared.outputMode.option.per_turn':
    'Per turn (default)',
  'channels.editor.field.shared.privatePolicy': 'Direct message policy',
  'channels.editor.field.dws.privatePolicy': 'Direct message policy',
  'channels.editor.field.dws.privatePolicy.description':
    'Controls which users can start direct-message, document-notification, and native-todo tasks.',
  'channels.editor.field.shared.privatePolicy.description':
    'Choose who can start a direct conversation with this Channel.',
  'channels.editor.field.shared.privatePolicy.option.disabled': 'Disabled',
  'channels.editor.field.shared.privatePolicy.option.pairing': 'Pairing',
  'channels.editor.field.shared.privatePolicy.option.allowlist': 'Allowlist',
  'channels.editor.field.shared.privatePolicy.option.open': 'Open',
  'channels.editor.field.shared.allowedUsers': 'Allowed user IDs',
  'channels.editor.field.shared.allowedUsers.description':
    'Comma-separated stable user IDs that can start private conversations without pairing.',
  'channels.editor.field.shared.groupPolicy': 'Group policy',
  'channels.editor.field.shared.groupPolicy.description':
    'Choose which group conversations can use this Channel.',
  'channels.editor.field.shared.groupPolicy.option.disabled': 'Disabled',
  'channels.editor.field.shared.groupPolicy.option.pairing': 'Pairing',
  'channels.editor.field.shared.groupPolicy.option.allowlist': 'Allowlist',
  'channels.editor.field.shared.groupPolicy.option.open': 'Open',
  'channels.editor.field.shared.allowedGroupIds': 'Allowed group IDs',
  'channels.editor.field.shared.allowedGroupIds.description':
    'Comma-separated stable chat or repository IDs allowed to use this Channel.',
  'channels.editor.field.shared.allowedGroupIds.placeholder':
    'group-a, group-b',
  'channels.editor.field.shared.groupSenders': 'Who can talk in groups',
  'channels.editor.field.shared.groupSenders.description':
    'Applies to every admitted group. Set a single group differently in settings.json.',
  'channels.editor.field.shared.groupSenders.option.open': 'Any group member',
  'channels.editor.field.shared.groupSenders.option.allowlist':
    'Listed members only',
  'channels.editor.field.shared.groupAllowedUsers': 'Allowed group member IDs',
  'channels.editor.field.shared.groupAllowedUsers.description':
    'Comma-separated stable user IDs who can talk in groups. Separate from the allowed user IDs for direct messages.',
  'channels.editor.field.shared.groupAllowedUsers.placeholder':
    'user-a, user-b',
  'channels.editor.field.shared.operators': 'Session operators',
  'channels.editor.field.shared.operators.description':
    'Comma-separated user IDs who can approve tool use and run /cancel, /clear or /loop in shared sessions. Leave empty to grant no shared-session operator permissions.',
  'channels.editor.field.shared.sessionScope': 'Conversation isolation',
  'channels.editor.field.shared.sessionScope.description':
    'Choose how conversations share persistent agent context.',
  'channels.editor.field.shared.sessionScope.option.user': 'By user',
  'channels.editor.field.shared.sessionScope.option.thread':
    'By thread (legacy)',
  'channels.editor.field.shared.sessionScope.option.chat_thread':
    'By chat or thread',
  'channels.editor.field.shared.sessionScope.option.single': 'Share all',
  'channels.editor.field.shared.sessionScope.detail.user':
    "The same user's messages continue in one conversation; users stay isolated from each other.",
  'channels.editor.field.shared.sessionScope.detail.thread':
    'Preserves the legacy thread routing used by existing Channel sessions.',
  'channels.editor.field.shared.sessionScope.detail.chat_thread':
    'Messages in the same group or topic share one conversation; best for collaboration.',
  'channels.editor.field.shared.sessionScope.detail.single':
    'Every message shares one conversation; best for a single-bot duty channel.',
  'channels.editor.field.shared.multiSession': 'Named tasks',
  'channels.editor.field.shared.instructions': 'Instructions',
  'channels.editor.field.shared.instructions.description':
    'Guidance injected into the context of each channel session. Some channels replace their own default guidance when this is set.',
  'channels.editor.field.shared.multiSession.description':
    'Keep a separate owner-scoped catalog of named tasks in daemon-managed mode.',
  'channels.editor.policy.disabled.title': 'Disabled',
  'channels.editor.policy.disabled.description':
    'Disable private conversations.',
  'channels.editor.policy.allowlist.title': 'Allowlist',
  'channels.editor.policy.allowlist.description':
    'Only listed users can start private conversations.',
  'channels.editor.policy.pairing.title': 'Pairing',
  'channels.editor.policy.pairing.description':
    'People receive a pairing code and can chat after you approve them.',
  'channels.editor.pairing.title': 'Pending requests',
  'channels.editor.pairing.description':
    'Match the shared code before approving access. Approvals take effect immediately; Save and Cancel do not undo them.',
  'channels.editor.pairing.subject.group': (v) =>
    `Group: ${v?.name ?? 'Unknown'}`,
  'channels.editor.pairing.requestedBy': (v) =>
    `Requested by ${v?.sender ?? 'Unknown'}`,
  'channels.editor.pairing.refresh': 'Refresh pairing requests',
  'channels.editor.pairing.approve': 'Approve',
  'channels.editor.pairing.approveFor': (v) =>
    `Approve ${v?.sender ?? 'request'}, code ${v?.code ?? ''}`,
  'channels.editor.pairing.approved': (v) =>
    `${v?.sender ?? 'This person'} can now use this Channel.`,
  'channels.editor.pairing.error': 'Pairing requests were not updated',
  'channels.editor.pairing.unavailable':
    'Pairing requests are temporarily unavailable. Try again.',
  'channels.editor.pairing.retry': 'Try again',
  'channels.editor.pairing.empty.title': 'No pending requests',
  'channels.editor.pairing.empty.description':
    'New requests appear here after someone messages the bot.',
  'channels.editor.pairing.saveFirst.title': 'Save pairing mode first',
  'channels.editor.pairing.saveFirst.description':
    'Pending requests will appear here after this Channel is saved in pairing mode.',
  'channels.editor.pairing.approvals.title': 'Pairing approvals',
  'channels.editor.pairing.approvals.description':
    'User and group IDs approved through pairing for this Channel.',
  'channels.editor.pairing.approvals.refresh': 'Refresh pairing approvals',
  'channels.editor.pairing.approvals.revoke': 'Revoke',
  'channels.editor.pairing.approvals.revokeFor': (v) =>
    `Revoke ${v?.senderId ?? 'pairing approval'}`,
  'channels.editor.pairing.approvals.revoked': (v) =>
    `Pairing approval for ${v?.senderId ?? 'this sender'} was revoked.`,
  'channels.editor.pairing.approvals.error':
    'Pairing approvals were not updated',
  'channels.editor.pairing.approvals.unavailable':
    'Pairing approvals are temporarily unavailable. Try again.',
  'channels.editor.pairing.approvals.empty.title': 'No pairing approvals',
  'channels.editor.pairing.approvals.empty.description':
    'Approved user and group IDs will appear here.',
  'channels.editor.pairing.approvals.confirm.title': (v) =>
    `Revoke pairing approval for ${v?.senderId || 'this sender'}?`,
  'channels.editor.pairing.approvals.confirm.description':
    'Only the approval created through pairing will be removed. Access configured in the Channel allowlist is not changed.',
  'channels.editor.pairing.approvals.confirm.action': 'Revoke approval',
  'channels.editor.pairing.allowlist.title': 'Configured allowlist',
  'channels.editor.pairing.allowlist.description':
    'Configured allowlist users remain allowed after a pairing approval is revoked.',
  'channels.editor.policy.open.title': 'Open',
  'channels.editor.policy.open.description':
    'Anyone who can reach the bot can start a conversation.',
  'channels.editor.validation.required': (v) =>
    `${v?.label ?? 'This field'} is required.`,
  'channels.editor.validation.credential':
    'Enter a token or enable local GitHub CLI authentication.',
  'channels.editor.validation.duplicate':
    'A Channel with this name already exists.',
  'channels.editor.validation.invalidName': 'Choose a different instance name.',
  'channels.editor.validation.invalidGroupId':
    'Enter a group ID other than __proto__, constructor, or prototype.',
  'channels.editor.validation.invalidRepoId':
    'Enter each repository as owner/repo.',
  'channels.editor.validation.invalidProjectPath':
    'Enter each project as a path, for example group/subgroup/project.',
  'channels.editor.validation.conflictingRepoAliases':
    'This channel lists one repository twice with different settings, spelled differently (for example Owner/repo and owner/repo). Remove one of the entries from settings.json before saving.',
  'channels.editor.validation.conflictingProjectAliases':
    'This channel lists one project twice with different settings, spelled differently (for example Group/Project and group/project). Remove one of the entries from settings.json before saving.',
  'channels.editor.validation.invalidGroupEntry': (v) =>
    `This channel stores a group entry that is not an object: ${v?.repositories ?? ''}. The daemon refuses every save while it is there, and the form has no row for it. Fix or remove that entry in settings.json, then reload the channel.`,
  'channels.editor.validation.invalidOption':
    "Remove values that aren't in the allowed list.",
  'channels.editor.validation.requiresBoundDeliveryForWatchGate':
    'Enable "Deliver To PR-Bound Sessions" to require an active watch.',
  'channels.editor.validation.repoFilterRequired':
    'List at least one repository, or set Repository Filter to Off.',
  'channels.editor.validation.number': 'Enter a valid number.',
  'channels.editor.validation.outOfRange': (v) => {
    const lower =
      v?.minInclusive !== undefined
        ? `at least ${v.minInclusive}`
        : v?.min !== undefined
          ? `greater than ${v.min}`
          : undefined;
    if (lower !== undefined && v?.max !== undefined) {
      return `Enter a number ${lower} and at most ${v.max}.`;
    }
    if (v?.max !== undefined) return `Enter a number at most ${v.max}.`;
    return `Enter a number ${lower ?? 'greater than 0'}.`;
  },
  'channels.editor.validation.policy': 'Choose an access policy.',
  'channels.editor.saveError': 'Changes were not saved',
  'channels.editor.reloadLatest': 'Reload latest',
  'channels.editor.cancel': 'Cancel',
  'channels.editor.save': 'Save',
  'localControl.open': 'Mobile access',
  'localControl.expires': (v) =>
    `One-time QR · Expires in ${v?.seconds ?? ''}s · Refreshes automatically`,
  'localControl.expired': 'QR code expired. Getting a fresh code…',
  'localControl.retry': 'Retry',
  'localControl.noNetwork':
    'No local network address is available. Open the Web Shell through an address your phone can reach.',
  'localControl.securePairing':
    'Scan to grant access until this daemon restarts.',
  'localControl.insecurePairing':
    'Scan to grant access until this daemon restarts. Traffic is unencrypted; use a trusted network.',
  'localControl.securePairingDynamic':
    "Scan to grant access to this daemon. The device that scans stays signed in until the daemon restarts or that device's tab is closed.",
  'localControl.insecurePairingDynamic':
    "Scan to grant access to this daemon. The device that scans stays signed in until the daemon restarts or that device's tab is closed. Traffic is unencrypted; use a trusted network.",
  'localControl.disabledHint':
    'Local Control is off. Turn it on in Settings to pair a phone on the same network.',
  'localControl.openSettings': 'Open Settings',
  'welcome.changeModel': '(/model to change)',
  'welcome.defaultModel': 'unknown model',
  'welcome.modeHint': 'Shift+Tab or /approval-mode',
  'welcome.prompt': 'What would you like to do?',
  'welcome.titlePrefix': 'Welcome to',
  'welcome.tipLabel': 'Tips:',
  ...BROWSER_NOTIFICATION_MESSAGES_EN,
  ...MCP_APP_MESSAGES_EN,
  ...VOICE_MESSAGES_EN,
  ...LIVE_MESSAGES_EN,
  ...COLLAB_MESSAGES_EN,
  ...SETTINGS_MESSAGES_EN,
  ...MANAGED_TASK_MESSAGES_EN,
  ...MANAGED_LIFECYCLE_MESSAGES_EN,
  ...WORKSPACE_REGISTRATION_MESSAGES_EN,
  ...ARTIFACT_LIBRARY_MESSAGES_EN,
  ...MANAGED_MCP_MESSAGES_EN,
  ...MANAGED_EXTENSION_MESSAGES_EN,
  ...TRAJECTORY_EXECUTION_MESSAGES_EN,
  ...TRAJECTORY_FILTER_MESSAGES_EN,
  ...TRAJECTORY_WINDOW_MESSAGES_EN,
};

/**
 * Every local-files message key, derived from the EN catalog so the
 * locale-parity test covers new keys automatically instead of drifting
 * behind a hardcoded subset.
 */
export const LOCAL_FILES_MESSAGE_KEYS = Object.keys(EN).filter((key) =>
  key.startsWith('localFiles.'),
);

const catalogs = new Map(eagerCatalogs);
catalogs.set('en', EN);
const pendingCatalogs = new Map<WebShellLanguage, Promise<void>>();
const catalogListeners = new Set<() => void>();

function subscribeToCatalogs(listener: () => void) {
  catalogListeners.add(listener);
  return () => {
    catalogListeners.delete(listener);
  };
}

export function loadLanguage(
  language: WebShellLanguage,
): Promise<void> | undefined {
  if (catalogs.has(language)) return;
  const pending = pendingCatalogs.get(language);
  if (pending) return pending;
  const load = lazyCatalogs.get(language);
  if (!load) return;
  const request = load()
    .then(
      (messages) => {
        catalogs.set(language, messages);
        for (const listener of catalogListeners) listener();
      },
      (error: unknown) => {
        console.warn(`[web-shell] Could not load locale ${language}`, error);
      },
    )
    .finally(() => pendingCatalogs.delete(language));
  pendingCatalogs.set(language, request);
  return request;
}

const LANGUAGE_LABELS: Record<WebShellLanguage, string> = {
  en: 'English [en]',
  'zh-CN': '中文 [zh-CN]',
  'zh-TW': '繁體中文 [zh-TW]',
  ru: 'Русский [ru]',
};

const Context = createContext<{
  language: WebShellLanguage;
  t: (key: string, vars?: Record<string, string | number>) => string;
}>({
  language: 'en',
  t: (key) => key,
});

function isTraditionalChineseTag(normalized: string): boolean {
  return (
    normalized === 'zh-tw' ||
    normalized.startsWith('zh-tw-') ||
    normalized === 'zh-hant' ||
    normalized.startsWith('zh-hant-') ||
    normalized === 'zh-hk' ||
    normalized.startsWith('zh-hk-') ||
    normalized === 'zh-mo' ||
    normalized.startsWith('zh-mo-')
  );
}

function isSimplifiedChineseTag(normalized: string): boolean {
  return (
    normalized === 'zh' ||
    normalized === 'zh-cn' ||
    normalized.startsWith('zh-cn-') ||
    normalized === 'zh-hans' ||
    normalized.startsWith('zh-hans-') ||
    normalized === 'zh-sg' ||
    normalized.startsWith('zh-sg-')
  );
}

export function normalizeLanguage(
  value: string | undefined | null,
): WebShellLanguage {
  const normalized = value?.trim().toLowerCase().replace(/_/g, '-');
  if (!normalized) return 'en';
  // zh-TW is a full catalog. Do not fold it into zh-CN or English.
  if (isTraditionalChineseTag(normalized)) return 'zh-TW';
  if (isSimplifiedChineseTag(normalized)) return 'zh-CN';
  // Prefix match: ru, region-qualified ru (ru-RU, ru-UA, ru-KZ, …) and the
  // underscore form all resolve to ru — region-qualified Russian speakers
  // must not fall through to en.
  if (normalized.startsWith('ru') || normalized === 'русский') {
    return 'ru';
  }
  return 'en';
}

export function languageSettingToWebShellLanguage(
  value: unknown,
): WebShellLanguage | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  if (!normalized) return undefined;
  if (normalized === 'auto') {
    return normalizeLanguage(
      typeof navigator !== 'undefined' ? navigator.language : undefined,
    );
  }
  if (
    isTraditionalChineseTag(normalized) ||
    normalized === '繁體中文' ||
    normalized === '繁体中文'
  ) {
    return 'zh-TW';
  }
  if (
    isSimplifiedChineseTag(normalized) ||
    normalized === 'chinese' ||
    normalized === '中文'
  ) {
    return 'zh-CN';
  }
  // Same prefix match as normalizeLanguage: region-qualified settings
  // (ru-UA, …) map to ru instead of an unknown setting.
  if (normalized.startsWith('ru') || normalized === 'русский') {
    return 'ru';
  }
  if (
    normalized === 'en' ||
    normalized === 'en-us' ||
    normalized === 'english'
  ) {
    return 'en';
  }
  return undefined;
}

export function languageLabel(language: WebShellLanguage): string {
  return LANGUAGE_LABELS[language];
}

function createTranslator(messages: Messages) {
  return (key: string, vars?: Record<string, string | number>) => {
    const message = messages[key] ?? EN[key] ?? key;
    return typeof message === 'function' ? message(vars) : message;
  };
}

function getCatalog(language: WebShellLanguage) {
  return catalogs.get(language) ?? EN;
}

export function getTranslator(language: WebShellLanguage) {
  return createTranslator(getCatalog(language));
}

export function useTranslator(language: WebShellLanguage) {
  const getSnapshot = () => getCatalog(language);
  const messages = useSyncExternalStore(
    subscribeToCatalogs,
    getSnapshot,
    getSnapshot,
  );
  useEffect(() => {
    void loadLanguage(language);
  }, [language]);
  return useMemo(() => createTranslator(messages), [messages]);
}

export function I18nProvider({
  language,
  children,
}: PropsWithChildren<{ language: WebShellLanguage }>) {
  const t = useTranslator(language);
  const value = useMemo(() => ({ language, t }), [language, t]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useI18n() {
  return useContext(Context);
}
