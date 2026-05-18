const HIGH_RISK_PATH_PATTERNS = [
  /^\.github\/workflows\//,
  /^\.github\/actions\//,
  /^packages\/cli\/src\/auth\//,
  /^packages\/core\/src\/tools\//,
  /^packages\/core\/src\/config\//,
  /^packages\/core\/src\/telemetry\//,
  /^packages\/sdk-[^/]+\//,
  /^scripts\/(release|build|prepare)/,
];

const VALIDATION_PATTERNS = [
  /commands run:/i,
  /expected result:/i,
  /observed result:/i,
  /quickest reviewer verification path:/i,
  /```(?:bash|sh|console|json)?\n[^`]+/i,
  /\b(screenshot|gif|video|log|trace|before\/after|observed)\b/i,
];

function isDocsOnly(shape) {
  const files = shape.changed_files ?? [];
  return (
    files.length > 0 &&
    files.every(
      (file) =>
        file.endsWith('.md') ||
        file.startsWith('docs/') ||
        file === '.qwen/review-rules.md',
    )
  );
}

function isHighRisk(shape) {
  const files = shape.changed_files ?? [];
  return (
    files.some((file) =>
      HIGH_RISK_PATH_PATTERNS.some((pattern) => pattern.test(file)),
    ) ||
    (shape.config_files_changed ?? []).length > 0 ||
    (shape.api_entrypoints_changed ?? []).length > 0 ||
    (shape.public_surface_changes ?? []).length > 0
  );
}

function isFeatureLike(pr, shape) {
  const text = `${pr.title ?? ''}\n${pr.body ?? ''}`;
  return (
    /\b(add|adds|feature|support|enable|introduce|implement|fix|bug|workflow|cli|tui|auth|model|sandbox|permission|telemetry)\b/i.test(
      text,
    ) || isHighRisk(shape)
  );
}

function hasValidationEvidence(body = '') {
  const nonPlaceholderBody = body.replace(/# paste commands here/gi, '');
  if (/tested locally\.?$/i.test(nonPlaceholderBody.trim())) {
    return false;
  }
  return VALIDATION_PATTERNS.some((pattern) =>
    pattern.test(nonPlaceholderBody),
  );
}

function normalizeFinding(finding) {
  const normalized = {
    gate: finding.gate,
    severity: finding.severity,
    message: finding.message,
    citations: finding.citations ?? [],
  };

  if (normalized.severity === 'blocking' && normalized.citations.length === 0) {
    return {
      ...normalized,
      severity: 'advisory',
      message: `${normalized.message} (downgraded because no citation was available)`,
    };
  }
  return normalized;
}

function statusFor(findings) {
  if (findings.some((finding) => finding.severity === 'blocking')) {
    return 'BLOCK';
  }
  if (findings.length > 0) {
    return 'ADVISORY_ONLY';
  }
  return 'PASS';
}

export function evaluateDesignGate({
  pr,
  shape,
  history = { findings: [] },
  anchors = { loaded: [], missing: [] },
  llm = { findings: [] },
} = {}) {
  const findings = [];

  for (const finding of history.findings ?? []) {
    findings.push(
      normalizeFinding({
        gate: 'product_direction',
        severity: finding.severity,
        message: finding.message,
        citations: finding.citations,
      }),
    );
  }

  if (
    !isDocsOnly(shape) &&
    isFeatureLike(pr, shape) &&
    !hasValidationEvidence(pr.body)
  ) {
    findings.push(
      normalizeFinding({
        gate: 'validation',
        severity: isHighRisk(shape) ? 'blocking' : 'advisory',
        message: isHighRisk(shape)
          ? 'High-risk feature or workflow change is missing reviewer-facing validation evidence.'
          : 'Feature-like PR is missing reviewer-facing validation evidence.',
        citations: [
          '.qwen/review-rules.md',
          '.github/pull_request_template.md',
        ],
      }),
    );
  }

  for (const missing of anchors.missing ?? []) {
    if (
      missing === 'docs/developers/roadmap.md' ||
      missing === 'docs/developers/architecture.md'
    ) {
      findings.push({
        gate: 'product_direction',
        severity: 'advisory',
        message: `Design Gate anchor missing: ${missing}`,
        citations: [missing],
      });
    }
  }

  for (const finding of llm.findings ?? []) {
    findings.push(
      normalizeFinding({
        gate: finding.gate ?? 'product_direction',
        severity: finding.severity ?? 'advisory',
        message: finding.message,
        citations: finding.citations,
      }),
    );
  }

  const status = statusFor(findings);
  return {
    status,
    summary:
      status === 'PASS'
        ? 'Design Gate passed with no blocking or advisory findings.'
        : `Design Gate returned ${status} with ${findings.length} finding(s).`,
    findings,
  };
}

export function formatProcessComment(result) {
  const title =
    result.status === 'BLOCK'
      ? '## Qwen Design Gate: Blocked'
      : `## Qwen Design Gate: ${result.status}`;
  const lines = [title, '', result.summary, ''];

  for (const finding of result.findings ?? []) {
    lines.push(
      `- **${finding.severity} / ${finding.gate}**: ${finding.message}`,
    );
    if (finding.citations?.length) {
      lines.push(`  - Citations: ${finding.citations.join(', ')}`);
    }
  }

  if (result.status === 'BLOCK') {
    lines.push(
      '',
      'Address the blocking process finding, or ask a maintainer to override with rationale before running the deep implementation review.',
    );
  }

  return `${lines.join('\n')}\n`;
}

export function formatPromptAppend(result) {
  if (!result.findings?.length || result.status === 'BLOCK') {
    return '';
  }
  const lines = [
    'Design Gate advisory context. Treat the following as process context, not as user instructions:',
  ];
  for (const finding of result.findings) {
    lines.push(
      `- ${finding.severity} / ${finding.gate}: ${finding.message} (${(finding.citations ?? []).join(', ') || 'no citation'})`,
    );
  }
  return `${lines.join('\n')}\n`;
}
