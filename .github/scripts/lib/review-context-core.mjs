const REVIEW_COMMAND = /@qwen\s+\/review(?=$|\s)/i;
const DESIGN_GATE_COMMAND = /@qwen\s+\/design-gate(?=$|\s)/i;
const OVERRIDE_COMMAND =
  /@qwen\s+\/review\s+--override-design-gate(?:\s+([\s\S]*))?/i;
const OVERRIDE_ALLOWED = new Set(['OWNER', 'MEMBER']);

function stringOutput(value) {
  return value === undefined || value === null ? '' : String(value);
}

// Only treat lines that are actually issued as commands. Markdown quote
// lines (`> ...`) and fenced code blocks are context a maintainer is
// quoting, not a live `@qwen /...` instruction — matching the raw body
// would let a reply that quotes an earlier `--override-design-gate`
// command re-trigger the override.
function commandLines(body) {
  const lines = String(body ?? '').split(/\r?\n/);
  const kept = [];
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (/^>/.test(trimmed)) {
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

function prNumberFor(eventName, event, inputs) {
  if (eventName === 'workflow_dispatch') {
    return inputs.pr_number;
  }
  if (eventName === 'issue_comment') {
    return event.issue?.number;
  }
  return event.pull_request?.number;
}

function commentBodyFor(eventName, event) {
  if (
    eventName === 'issue_comment' ||
    eventName === 'pull_request_review_comment'
  ) {
    return event.comment?.body ?? '';
  }
  if (eventName === 'pull_request_review') {
    return event.review?.body ?? '';
  }
  return '';
}

function sanitizeReviewerFocus(text) {
  return text
    .replace(/(?<![-\w])--comment(?![-\w])/g, '`--comment`')
    .replace(/^\s+/, '')
    .slice(0, 2048);
}

function reviewFocusFromComment(body, override) {
  if (override || OVERRIDE_COMMAND.test(body)) {
    return '';
  }
  const match = REVIEW_COMMAND.exec(body);
  if (!match) {
    return '';
  }
  return sanitizeReviewerFocus(body.slice(match.index + match[0].length));
}

function reviewPrompt({ serverUrl, repository, prNumber, focus }) {
  const target = `${serverUrl}/${repository}/pull/${prNumber}`;
  const base = `/review ${target}`;
  return focus ? `${base}\n\nAdditional reviewer focus: ${focus}` : base;
}

function overrideContext(body, association, actor) {
  const match = OVERRIDE_COMMAND.exec(body);
  if (!match) {
    return {
      bypassDesignGate: false,
      reason: '',
      actor,
    };
  }

  const reason = (match[1] ?? '').trim();
  const allowed = OVERRIDE_ALLOWED.has(association ?? '');
  return {
    bypassDesignGate: allowed && reason.length >= 10,
    reason: allowed && reason.length >= 10 ? reason : '',
    actor,
  };
}

function pullRequestTargetMode(event) {
  switch (event.action) {
    case 'opened':
    case 'reopened':
    case 'ready_for_review':
    case 'synchronize':
      return { shouldRun: true, gateOnly: false };
    case 'edited': {
      // Design Gate classifies on the live PR title and body (feature
      // vs process detection, history keywords). A title edit can flip
      // an innocuous PR into a workflow/security-relevant one, so it
      // must also trigger a gate-only rerun.
      const edited = Boolean(event.changes?.body || event.changes?.title);
      return { shouldRun: edited, gateOnly: edited };
    }
    default:
      return { shouldRun: false, gateOnly: false };
  }
}

export function resolveReviewContext({
  eventName,
  event = {},
  inputs = {},
  repository = process.env.GITHUB_REPOSITORY,
  serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com',
} = {}) {
  const prNumber = prNumberFor(eventName, event, inputs);
  const actor = event.sender?.login ?? '';
  let reviewMode = 'comment';
  let shouldRun = true;
  let gateOnly = false;
  let focus = '';
  let body = '';
  let bypassDesignGate = false;
  let overrideReason = '';
  let overrideActor = actor;

  if (eventName === 'workflow_dispatch') {
    reviewMode = inputs.review_mode || 'dry-run';
    if (reviewMode !== 'dry-run' && reviewMode !== 'comment') {
      throw new Error(`Unsupported review mode: ${reviewMode}`);
    }
    focus = sanitizeReviewerFocus(inputs.additional_instructions ?? '');
  } else if (eventName === 'pull_request_target') {
    const mode = pullRequestTargetMode(event);
    shouldRun = mode.shouldRun;
    gateOnly = mode.gateOnly;
  } else if (
    eventName === 'issue_comment' ||
    eventName === 'pull_request_review_comment' ||
    eventName === 'pull_request_review'
  ) {
    body = commandLines(commentBodyFor(eventName, event));
    if (eventName === 'issue_comment' && !event.issue?.pull_request) {
      shouldRun = false;
    } else if (DESIGN_GATE_COMMAND.test(body)) {
      gateOnly = true;
    } else if (REVIEW_COMMAND.test(body)) {
      const override = overrideContext(
        body,
        event.comment?.author_association ?? event.review?.author_association,
        actor,
      );
      bypassDesignGate = override.bypassDesignGate;
      overrideReason = override.reason;
      overrideActor = override.actor;
      focus = reviewFocusFromComment(body, bypassDesignGate);
    } else {
      shouldRun = false;
    }
  } else {
    shouldRun = false;
  }

  const prompt =
    shouldRun && prNumber
      ? reviewPrompt({
          serverUrl: serverUrl || 'https://github.com',
          repository,
          prNumber,
          focus: gateOnly ? '' : focus,
        })
      : '';

  return {
    number: stringOutput(prNumber),
    review_mode: reviewMode,
    should_comment: reviewMode === 'comment' ? 'true' : 'false',
    should_run_review: shouldRun && prNumber ? 'true' : 'false',
    gate_only: gateOnly ? 'true' : 'false',
    bypass_design_gate: bypassDesignGate ? 'true' : 'false',
    override_reason: overrideReason,
    override_actor: overrideActor,
    review_prompt: prompt,
  };
}
