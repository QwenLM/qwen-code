/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WorkflowRegistryInlineDefinition } from './workflow-registry.js';

export const DEEP_RESEARCH_WORKFLOW_NAME = 'deep-research';

export const DEEP_RESEARCH_WORKFLOW_SCRIPT = `export const meta = {
  name: "deep-research",
  description: "Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report.",
  whenToUse: "When the user wants a deep, multi-source, fact-checked research report on any topic. BEFORE invoking, check if the question is specific enough to research directly — if underspecified (e.g., \\"what car to buy\\" without budget/use-case/region), ask 2-3 clarifying questions to narrow scope. Then pass the refined question as args, weaving the answers in.",
  phases: [
    { title: "Scope", detail: "Decompose question (from args) into 5 search angles" },
    { title: "Search", detail: "5 parallel WebSearch agents, one per angle" },
    { title: "Fetch", detail: "URL-dedup, fetch top 15 sources, extract falsifiable claims" },
    { title: "Verify", detail: "3-vote adversarial verification per claim (need 2/3 refutes to kill)" },
    { title: "Synthesize", detail: "Merge semantic dupes, rank by confidence, cite sources" }
  ]
};

const QUESTION = typeof args === "string" ? args.trim() : "";
if (!QUESTION) {
  return {
    error: "No research question provided. Pass it as args: Workflow({ name: \\"deep-research\\", args: \\"<question>\\" })."
  };
}

const ANGLES_SCHEMA = {
  type: "object",
  required: ["question", "summary", "angles"],
  properties: {
    question: { type: "string" },
    summary: { type: "string" },
    angles: {
      type: "array",
      minItems: 3,
      maxItems: 6,
      items: {
        type: "object",
        required: ["label", "query"],
        properties: {
          label: { type: "string" },
          query: { type: "string" },
          rationale: { type: "string" }
        }
      }
    }
  }
};

const SEARCH_SCHEMA = {
  type: "object",
  required: ["results"],
  properties: {
    results: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        required: ["url", "title", "relevance"],
        properties: {
          url: { type: "string" },
          title: { type: "string" },
          snippet: { type: "string" },
          relevance: { type: "string", enum: ["high", "medium", "low"] }
        }
      }
    }
  }
};

const CLAIMS_SCHEMA = {
  type: "object",
  required: ["sourceQuality", "claims"],
  properties: {
    sourceQuality: { type: "string", enum: ["primary", "secondary", "blog", "forum", "unreliable"] },
    publishDate: { type: "string" },
    claims: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        required: ["claim", "quote", "importance"],
        properties: {
          claim: { type: "string" },
          quote: { type: "string" },
          importance: { type: "string", enum: ["central", "supporting", "tangential"] }
        }
      }
    }
  }
};

const VERDICT_SCHEMA = {
  type: "object",
  required: ["refuted", "evidence", "confidence"],
  properties: {
    refuted: { type: "boolean" },
    evidence: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    counterSource: { type: "string" }
  }
};

const REPORT_SCHEMA = {
  type: "object",
  required: ["summary", "findings", "caveats"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["claim", "confidence", "sources", "evidence"],
        properties: {
          claim: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          sources: { type: "array", items: { type: "string" } },
          evidence: { type: "string" },
          vote: { type: "string" }
        }
      }
    },
    caveats: { type: "string" },
    openQuestions: { type: "array", items: { type: "string" } }
  }
};

const VOTES_PER_CLAIM = 3;
const REFUTATIONS_REQUIRED = 2;
const MAX_FETCH = 15;
const MAX_VERIFY_CLAIMS = 25;
const URL_HOST_PATTERN = /^[a-z][a-z0-9+.-]*:\\/\\/(?:[^/?#\\\\]*@)?(?:www\\.)?([^/:?#@\\\\]+)(?::\\d+)?([^?#]*)/i;
const normalizeUrl = (url) => {
  const match = String(url).match(URL_HOST_PATTERN);
  return match
    ? (match[1] + match[2].replace(/\\/$/, "")).toLowerCase()
    : String(url).toLowerCase();
};
const LABEL_CAP = 40;
const LABEL_STRIP = /[\\x00-\\x1f\\x7f-\\x9f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff\\u0022\\u201c-\\u201f\\u2033\\u2036\\u275d\\u275e\\u301d\\u301e\\uff02]/g;
const STRICT_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const stripLabelChars = (value) => String(value).replace(LABEL_STRIP, "");
const quotedLabel = (value) => {
  const codePoints = Array.from(stripLabelChars(value));
  return "\\"" + codePoints.slice(0, LABEL_CAP).join("").trim() +
    (codePoints.length > LABEL_CAP ? "…" : "") + "\\"";
};
const sourceLabel = (source) => {
  const capturedHost = String(source.url).match(URL_HOST_PATTERN)?.[1] || "";
  const host = capturedHost.toLowerCase();
  const cleanHost = stripLabelChars(host);
  const isCleanBareHost = cleanHost === host && host !== "" &&
    Array.from(host).length <= LABEL_CAP && STRICT_HOST.test(host);
  const hostLabel = cleanHost === "" ? "" : isCleanBareHost ? host : quotedLabel(host);
  return hostLabel ||
    (stripLabelChars(source.title).trim() && quotedLabel(source.title)) ||
    "unknown";
};

phase("Scope");
const scope = await agent(
  "Decompose this research question into complementary search angles.\\n\\n" +
    "## Question\\n" + QUESTION + "\\n\\n" +
    "## Task\\n" +
    "Generate 5 distinct web search queries that together cover the question from different angles. Pick angles that suit the question's domain. Examples:\\n" +
    "- broad/primary  · academic/technical  · recent news  · contrarian/skeptical  · practitioner/implementation\\n" +
    "- For medical: anatomy · common causes · serious differentials · authoritative refs · red flags\\n" +
    "- For tech: state-of-art · benchmarks · limitations · industry adoption · cost/tradeoffs\\n\\n" +
    "Make queries specific enough to surface high-signal results. Avoid redundancy.\\n" +
    "Return: the question (verbatim or lightly normalized), a 1-2 sentence decomposition strategy, and the angles.\\n\\n" +
    "Structured output only.",
  { label: "scope", phase: "Scope", schema: ANGLES_SCHEMA }
);
if (!scope) {
  return { error: "Scope agent returned no result - cannot decompose the research question." };
}
log("Question: " + QUESTION.slice(0, 80) + (QUESTION.length > 80 ? "…" : ""));
log("Decomposed into " + scope.angles.length + " angles: " + scope.angles.map((angle) => angle.label).join(", "));

const seen = new Map();
const duplicates = [];
const budgetDropped = [];
const relevanceRank = { high: 0, medium: 1, low: 2 };
let fetchSlots = MAX_FETCH;

const searchResults = await pipeline(
  scope.angles,
  (angle) =>
    agent(
      "## Web Searcher: " + angle.label + "\\n\\n" +
        "Research question: \\"" + QUESTION + "\\"\\n\\n" +
        "Your angle: **" + angle.label + "** — " + (angle.rationale || "") + "\\n" +
        "Search query: \`" + angle.query + "\`\\n\\n" +
        "## Task\\n" +
        "Use WebSearch with the query above (or a refined version). Return the top 4-6 most relevant results.\\n" +
        "Rank by relevance to the ORIGINAL question, not just the search query. Skip obvious SEO spam/content farms.\\n" +
        "Include a short snippet capturing why each result is relevant.\\n\\n" +
        "Structured output only.",
      { label: "search:" + angle.label, phase: "Search", schema: SEARCH_SCHEMA }
    ).then((result) => {
      if (!result) return null;
      log(angle.label + ": " + result.results.length + " search results");
      return { angle: angle.label, results: result.results };
    }),
  (searchResult) => {
    const sorted = [...searchResult.results].sort(
      (a, b) => relevanceRank[a.relevance] - relevanceRank[b.relevance]
    );
    const novel = sorted.filter((result) => {
      const key = normalizeUrl(result.url);
      if (seen.has(key)) {
        duplicates.push({ ...result, angle: searchResult.angle, duplicateOf: seen.get(key) });
        return false;
      }
      if (fetchSlots <= 0 && relevanceRank[result.relevance] >= 1) {
        budgetDropped.push({ ...result, angle: searchResult.angle });
        return false;
      }
      seen.set(key, { angle: searchResult.angle, title: result.title });
      fetchSlots--;
      return true;
    });
    if (novel.length < searchResult.results.length) {
      log(searchResult.angle + ": " + novel.length + " novel (" +
        (searchResult.results.length - novel.length) + " filtered)");
    }
    return parallel(
      novel.map((source) => () =>
        agent(
          "## Source Extractor\\n\\n" +
            "Research question: \\"" + QUESTION + "\\"\\n\\n" +
            "Fetch and extract key claims from this source:\\n" +
            "**URL:** " + source.url + "\\n" +
            "**Title:** " + source.title + "\\n" +
            "**Found via:** " + searchResult.angle + " search\\n\\n" +
            "## Task\\n" +
            "1. Use WebFetch to retrieve the page content.\\n" +
            "2. Assess source quality: primary research/institution? secondary reporting? blog/opinion? forum? unreliable?\\n" +
            "3. Extract 2-5 FALSIFIABLE claims that bear on the research question. Each claim must:\\n" +
            "   - be a concrete, checkable statement (not vague generalities)\\n" +
            "   - include a direct quote from the source as support\\n" +
            "   - be rated central/supporting/tangential to the research question\\n" +
            "4. Note publish date if available.\\n\\n" +
            "If the fetch fails or the page is irrelevant/paywalled, return claims: [] and sourceQuality: \\"unreliable\\".\\n\\n" +
            "Structured output only.",
          { label: "fetch:" + sourceLabel(source), phase: "Fetch", schema: CLAIMS_SCHEMA }
        ).then((result) => {
          if (!result) return null;
          return {
            url: source.url,
            title: source.title,
            angle: searchResult.angle,
            sourceQuality: result.sourceQuality,
            publishDate: result.publishDate,
            claims: result.claims.map((claim) => ({
              ...claim,
              sourceUrl: source.url,
              sourceQuality: result.sourceQuality
            }))
          };
        }).catch((error) => {
          log("fetch failed: " + source.url + " - " + (error && error.message ? error.message : String(error)));
          return {
            url: source.url,
            title: source.title,
            angle: searchResult.angle,
            sourceQuality: "unreliable",
            claims: []
          };
        })
      )
    );
  }
);

const sources = searchResults.flat().filter(Boolean);
const allClaims = sources.flatMap((source) => source.claims);
const importanceRank = { central: 0, supporting: 1, tangential: 2 };
const qualityRank = { primary: 0, secondary: 1, blog: 2, forum: 3, unreliable: 4 };
const claims = [...allClaims]
  .sort((a, b) =>
    (importanceRank[a.importance] - importanceRank[b.importance]) ||
    (qualityRank[a.sourceQuality] - qualityRank[b.sourceQuality])
  )
  .slice(0, MAX_VERIFY_CLAIMS);
log("Fetched " + sources.length + " sources -> " + allClaims.length +
  " claims -> verifying top " + claims.length);

if (claims.length === 0) {
  return {
    question: QUESTION,
    summary: "No claims extracted. " + sources.length + " sources fetched, all empty or failed. " +
      duplicates.length + " URL duplicates, " + budgetDropped.length + " budget-dropped.",
    findings: [],
    refuted: [],
    unverified: [],
    sources: sources.map((source) => ({ url: source.url, quality: source.sourceQuality })),
    stats: {
      angles: scope.angles.length,
      sources: sources.length,
      claims: 0,
      urlDupes: duplicates.length,
      budgetDropped: budgetDropped.length
    }
  };
}

phase("Verify");
const voted = (await parallel(
  claims.map((claim) => () =>
    parallel(
      Array.from({ length: VOTES_PER_CLAIM }, (_, vote) => () =>
        agent(
          "## Adversarial Claim Verifier (voter " + (vote + 1) + "/" + VOTES_PER_CLAIM + ")\\n\\n" +
            "Be SKEPTICAL. Try to REFUTE this claim. ≥" + REFUTATIONS_REQUIRED +
            "/" + VOTES_PER_CLAIM + " refutations kill it.\\n\\n" +
            "## Research question\\n" + QUESTION + "\\n\\n" +
            "## Claim under review\\n\\"" + claim.claim + "\\"\\n\\n" +
            "**Source:** " + claim.sourceUrl + " (" + claim.sourceQuality + ")\\n" +
            "**Supporting quote:** \\"" + claim.quote + "\\"\\n\\n" +
            "## Checklist\\n" +
            "1. Is the claim actually supported by the quote, or is it an overreach/misread?\\n" +
            "2. WebSearch for contradicting evidence — does any credible source dispute or heavily qualify this?\\n" +
            "3. Is the source quality sufficient for the claim's strength? (extraordinary claims need primary sources)\\n" +
            "4. Is the claim outdated? (check dates — old claims about fast-moving fields are suspect)\\n" +
            "5. Is this a marketing claim / press release / cherry-picked benchmark / forum speculation?\\n\\n" +
            "**refuted=true** if: unsupported by quote / contradicted / low-quality source for strong claim / outdated / marketing fluff.\\n" +
            "**refuted=false** ONLY if: claim is well-supported, current, and source quality matches claim strength.\\n" +
            "Default to refuted=true if uncertain.\\n\\n" +
            "Structured output only. Evidence MUST be specific.",
          { label: "v" + vote + ":" + claim.claim.slice(0, 40), phase: "Verify", schema: VERDICT_SCHEMA }
        )
      )
    ).then((verdicts) => {
      const valid = verdicts.filter(Boolean);
      const refutedVotes = valid.filter((verdict) => verdict.refuted).length;
      const erroredVotes = VOTES_PER_CLAIM - valid.length;
      const survives = valid.length >= REFUTATIONS_REQUIRED && refutedVotes < REFUTATIONS_REQUIRED;
      const isRefuted = refutedVotes >= REFUTATIONS_REQUIRED;
      const mark = survives ? "confirmed" : isRefuted ? "refuted" : "unverified";
      log(mark + ": " + claim.claim.slice(0, 70) +
        (erroredVotes > 0 ? " (" + erroredVotes + " verifier errors)" : ""));
      return {
        ...claim,
        verdicts: valid,
        refutedVotes,
        erroredVotes,
        survives,
        isRefuted
      };
    })
  )
)).filter(Boolean);

const confirmed = voted.filter((claim) => claim.survives);
const refuted = voted.filter((claim) => claim.isRefuted);
const unverified = voted.filter((claim) => !claim.survives && !claim.isRefuted);
log("Verified " + voted.length + " claims; confirmed " + confirmed.length +
  ", refuted " + refuted.length + ", unverified " + unverified.length);

const toRefuted = (claim) => ({
  claim: claim.claim,
  source: claim.sourceUrl,
  vote: (claim.verdicts.length - claim.refutedVotes) + "-" + claim.refutedVotes
});
const toUnverified = (claim) => ({
  claim: claim.claim,
  source: claim.sourceUrl,
  validVotes: claim.verdicts.length,
  erroredVotes: claim.erroredVotes
});

if (confirmed.length === 0) {
  let summary;
  if (refuted.length === 0 && unverified.length > 0) {
    summary = "Could not verify any claims - all " + unverified.length +
      " verifier panels failed. This is an infrastructure failure, not a research finding. Retry or verify manually.";
  } else if (unverified.length > 0) {
    summary = refuted.length + " claims were refuted; " + unverified.length +
      " could not be verified because verifier agents failed. Research is inconclusive.";
  } else {
    summary = "All " + refuted.length +
      " claims were refuted by adversarial verification. Research is inconclusive.";
  }
  return {
    question: QUESTION,
    summary,
    findings: [],
    refuted: refuted.map(toRefuted),
    unverified: unverified.map(toUnverified),
    sources: sources.map((source) => ({ url: source.url, quality: source.sourceQuality, claimCount: source.claims.length })),
    stats: {
      angles: scope.angles.length,
      sources: sources.length,
      claims: allClaims.length,
      verified: voted.length,
      confirmed: 0,
      killed: refuted.length,
      unverified: unverified.length,
      urlDupes: duplicates.length,
      budgetDropped: budgetDropped.length
    }
  };
}

phase("Synthesize");
const confidenceRank = { high: 0, medium: 1, low: 2 };
const evidenceBlock = confirmed.map((claim, index) => {
  const best = claim.verdicts
    .filter((verdict) => !verdict.refuted)
    .sort((a, b) => confidenceRank[a.confidence] - confidenceRank[b.confidence])[0];
  return "### [" + index + "] " + claim.claim + "\\n" +
    "Vote: " + (claim.verdicts.length - claim.refutedVotes) + "-" + claim.refutedVotes +
    " · Source: " + claim.sourceUrl + " (" + claim.sourceQuality + ")\\n" +
    "Quote: \\"" + claim.quote + "\\"\\n" +
    "Verifier evidence (" + (best ? best.confidence : "unknown") + "): " +
    (best ? best.evidence : "No supporting verifier evidence.") + "\\n";
}).join("\\n");

const refutedBlock = refuted.length > 0
  ? "\\n## Refuted claims (for transparency)\\n" +
    refuted.map((claim) => "- \\"" + claim.claim + "\\" (" + claim.sourceUrl + ", vote " +
      (claim.verdicts.length - claim.refutedVotes) + "-" + claim.refutedVotes + ")").join("\\n")
  : "";
const unverifiedBlock = unverified.length > 0
  ? "\\n## Unverified claims (" + unverified.length +
    " — verifier agents failed; neither confirmed nor refuted)\\n" +
    unverified.map((claim) => "- \\"" + claim.claim + "\\" (" + claim.sourceUrl + ", " +
      claim.erroredVotes + "/" + VOTES_PER_CLAIM + " votes errored)").join("\\n") +
    "\\n\\nMention in caveats that " + unverified.length +
    " claim(s) could not be verified due to infrastructure errors."
  : "";

const report = await agent(
  "## Synthesis: research report\\n\\n" +
    "**Question:** " + QUESTION + "\\n\\n" +
    confirmed.length + " claims survived " + VOTES_PER_CLAIM +
    "-vote adversarial verification. Merge semantic duplicates and synthesize.\\n\\n" +
    "## Confirmed claims\\n" + evidenceBlock + "\\n" + refutedBlock + unverifiedBlock + "\\n\\n" +
    "## Instructions\\n" +
    "1. Identify claims that say the same thing — merge them, combine their sources.\\n" +
    "2. Group related claims into coherent findings. Each finding should directly address the research question.\\n" +
    "3. Assign confidence per finding: high (multiple primary sources, unanimous votes), medium (secondary sources or split votes), low (single source or blog-quality).\\n" +
    "4. Write a 3-5 sentence executive summary answering the research question.\\n" +
    "5. Note caveats: what's uncertain, what sources were weak, what time-sensitivity applies.\\n" +
    "6. List 2-4 open questions that emerged but weren't answered.\\n\\n" +
    "Structured output only.",
  { label: "synthesize", phase: "Synthesize", schema: REPORT_SCHEMA }
);

if (!report) {
  return {
    question: QUESTION,
    summary: "Synthesis was skipped or failed - returning " + confirmed.length +
      " verified claims without merging.",
    findings: [],
    confirmed: confirmed.map((claim) => ({
      claim: claim.claim,
      source: claim.sourceUrl,
      quote: claim.quote,
      vote: (claim.verdicts.length - claim.refutedVotes) + "-" + claim.refutedVotes
    })),
    refuted: refuted.map(toRefuted),
    unverified: unverified.map(toUnverified),
    sources: sources.map((source) => ({
      url: source.url,
      quality: source.sourceQuality,
      claimCount: source.claims.length
    })),
    stats: {
      angles: scope.angles.length,
      sources: sources.length,
      claims: allClaims.length,
      verified: voted.length,
      confirmed: confirmed.length,
      killed: refuted.length,
      unverified: unverified.length,
      afterSynthesis: 0,
      urlDupes: duplicates.length,
      budgetDropped: budgetDropped.length
    }
  };
}

return {
  question: QUESTION,
  ...report,
  refuted: refuted.map(toRefuted),
  unverified: unverified.map(toUnverified),
  sources: sources.map((source) => ({ url: source.url, quality: source.sourceQuality, angle: source.angle, claimCount: source.claims.length })),
  stats: {
    angles: scope.angles.length,
    sourcesFetched: sources.length,
    claimsExtracted: allClaims.length,
    claimsVerified: voted.length,
    confirmed: confirmed.length,
    killed: refuted.length,
    unverified: unverified.length,
    afterSynthesis: report.findings.length,
    urlDupes: duplicates.length,
    budgetDropped: budgetDropped.length,
    agentCalls: 1 + scope.angles.length + sources.length +
      (voted.length * VOTES_PER_CLAIM) + 1
  }
};`;

export const BUILT_IN_WORKFLOWS: WorkflowRegistryInlineDefinition[] = [
  {
    script: DEEP_RESEARCH_WORKFLOW_SCRIPT,
    sourceId: DEEP_RESEARCH_WORKFLOW_NAME,
  },
];
