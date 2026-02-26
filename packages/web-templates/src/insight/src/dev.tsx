/**
 * Dev entry point — injects mock data then mounts the app.
 * Used by `vite` dev server via index.html.
 */
import type { InsightData } from './types';

const MOCK_DATA: InsightData = {
  heatmap: {
    '2026-02-03': 469,
    '2026-02-04': 244,
    '2026-02-02': 268,
    '2026-01-15': 105,
    '2026-01-19': 39,
    '2026-02-10': 1584,
    '2026-02-09': 1175,
    '2026-02-05': 338,
    '2025-12-11': 29,
    '2026-02-11': 585,
    '2026-02-06': 671,
    '2026-01-16': 17,
    '2026-01-14': 120,
    '2025-12-31': 18,
    '2025-12-05': 24,
  },
  currentStreak: 3,
  longestStreak: 5,
  longestWorkDate: '2026-02-03',
  longestWorkDuration: 1520,
  activeHours: {
    '0': 161,
    '9': 4,
    '10': 211,
    '11': 852,
    '12': 263,
    '13': 682,
    '14': 1465,
    '15': 518,
    '16': 347,
    '17': 116,
    '18': 194,
    '19': 680,
    '20': 188,
    '21': 5,
  },
  latestActiveTime: '08:00 AM',
  totalSessions: 314,
  totalMessages: 5686,
  totalHours: 60,
  topTools: [
    ['read_file', 209],
    ['run_shell_command', 166],
    ['edit', 98],
    ['grep_search', 53],
    ['todo_write', 52],
    ['web_fetch', 19],
    ['list_directory', 15],
    ['glob', 14],
    ['write_file', 5],
    ['skill', 4],
  ],
  totalLinesAdded: 3000,
  totalLinesRemoved: 285,
  totalFiles: 23,
  qualitative: {
    impressiveWorkflows: {
      intro:
        "You're a highly active Qwen Code user with 314 sessions over 67 days, achieving strong results in test creation, PR workflows, and debugging with a 68% success rate on clear tasks.",
      impressive_workflows: [
        {
          title: 'Comprehensive Test Creation Workflow',
          description:
            'You successfully requested and received comprehensive unit tests for DataProcessor.ts, resulting in 34 test cases covering all major methods with proper mocking. When tests initially failed due to mock implementation issues, you iterated through fixes until all tests passed, demonstrating strong test-driven development practices.',
        },
        {
          title: 'Efficient PR Creation Process',
          description:
            "You've mastered the PR creation workflow, successfully creating pull requests using existing templates multiple times. You know how to leverage Qwen to format PRs properly in English and complete this task efficiently, often in single responses with multiple coordinated tool calls.",
        },
        {
          title: 'Systematic Debugging and Refactoring',
          description:
            "You effectively use Qwen for debugging failing tests, successfully identifying issues like missing KeypressProvider context and ink mock setup problems. You also completed clean refactoring tasks like migrating openFileInBrowser to use the 'open' package, with all checks passing on the first attempt.",
        },
      ],
    },
    projectAreas: {
      areas: [
        {
          name: 'Feature Development',
          session_count: 6,
          description:
            'Implementation of new features including ESC cancellation support for slash commands (specifically /compress). Work involved adding signal to CommandContext and implementing Promise.race patterns for proper abort handling.',
        },
        {
          name: 'Pull Request Management',
          session_count: 4,
          description:
            'Creating pull requests from existing commits using PR templates. Sessions involved automated PR generation with proper formatting, with some initial friction around template application that was resolved.',
        },
        {
          name: 'Test Creation & Debugging',
          session_count: 3,
          description:
            'Creating comprehensive unit tests for components like DataProcessor.ts using Vitest, and debugging failing tests including fixing KeypressProvider context issues and ink mock setup problems through iterative refinement.',
        },
        {
          name: 'Code Review',
          session_count: 3,
          description:
            'Reviewing GitHub pull requests and commit ranges to identify issues and provide feedback. Included manual review of large PRs when automated skills failed, focusing on missing tests and error handling problems.',
        },
        {
          name: 'Code Refactoring',
          session_count: 2,
          description:
            "Improving existing code quality through targeted refactoring efforts, such as updating openFileInBrowser to use the 'open' package and reverting unnecessary script file changes.",
        },
      ],
    },
    futureOpportunities: {
      intro:
        'As AI-assisted development evolves from reactive pair-programming to proactive autonomous systems, usage patterns reveal massive opportunities for self-improving agent loops that can iterate, test, and refactor without human intervention.',
      opportunities: [
        {
          title: 'Autonomous Test-Iterate-Fix Loop',
          whats_possible:
            'An agent that runs your full test suite, identifies failures, generates fixes, and re-runs tests in a closed loop until achieving 100% pass rate—no human intervention required. The system could learn from each iteration, applying increasingly targeted fixes while tracking which approaches work best for different failure types.',
          how_to_try:
            "Configure your AI to watch test output files, parse failure messages, and apply fixes using your test framework's reporters; Vitest and Jest both support JSON output for easy parsing.",
          copyable_prompt:
            "I want you to run my test suite in watch mode. When tests fail, analyze the failure output, identify the root cause, propose a fix, apply it, and re-run the tests automatically. Keep iterating until all tests pass. For each iteration, show me: (1) which test failed, (2) your diagnosis, (3) the fix you're applying, and (4) the result. If a fix doesn't work after 2 attempts, try a different approach. Track which patterns of fixes work best so you can apply learned strategies.",
        },
        {
          title: 'Parallel Agent Exploration with Consensus',
          whats_possible:
            'Spawn multiple independent AI agents to solve the same problem using different strategies (TDD vs implementation-first, different architectural patterns, different libraries), then automatically merge the best aspects of each solution. This parallel approach could solve complex problems 5-10x faster while discovering novel solutions a single agent would miss.',
          how_to_try:
            'Use terminal multiplexers or containerized environments to run multiple AI agent instances concurrently, then use a meta-agent to analyze and synthesize outputs.',
          copyable_prompt:
            "I want you to solve this problem using parallel exploration. Open 3 separate terminal sessions and in each one, implement a solution using a different approach: (1) Test-driven development - write tests first, (2) Implementation-first with aggressive refactoring, (3) Use a different library/algorithm than you'd normally choose. Work on all three simultaneously, switching between them every few minutes. After 10 minutes, compare all three solutions and create a final version that combines the best aspects of each. Show me the tradeoffs you discovered and why the final hybrid solution is better than any individual approach.",
        },
        {
          title: 'Continuous Code Health Agent',
          whats_possible:
            'A background agent that continuously monitors your codebase for code smells, missing tests, security vulnerabilities, and refactoring opportunities—automatically creating pull requests with improvements while you sleep. It could maintain a living document of technical debt, prioritize fixes by impact, and learn from code review feedback to improve its suggestions over time.',
          how_to_try:
            'Set up a scheduled CI/CD job that runs your AI against changed files with a comprehensive code health checklist, using git hooks to trigger analysis on commits.',
          copyable_prompt:
            'Run as a continuous code health monitor. Scan the entire codebase and create a prioritized list of improvements in these categories: (1) Missing or inadequate tests - identify untested edge cases, (2) Code smells - long functions, duplication, complex conditionals, (3) Security issues - hardcoded secrets, unsafe patterns, (4) Performance bottlenecks, (5) Outdated dependencies with breaking changes. For each issue, assign a priority score (1-10) based on impact and effort. Then automatically fix the top 5 highest-priority issues and create a summary PR. Add a comment on each file explaining what you changed and why. Set this up to run nightly and track improvements over time.',
        },
      ],
    },
    frictionPoints: {
      intro:
        'Your usage shows significant friction from unproductive sessions and technical issues, with many interactions never progressing beyond greetings and several work items requiring multiple iterations to resolve.',
      categories: [
        {
          category: 'Unproductive Session Overhead',
          description:
            "You spent significant time in sessions that never progressed beyond greetings or warmups, with 28 out of 48 analyzed sessions being minimal interactions that didn't result in actual work being completed.",
          examples: [
            "28 sessions were just warmup_minimal with 'hi' greetings and no actual requests, consuming your time without delivering value",
            "Multiple sessions had only 'hi' or 'nihao' exchanges in Chinese where you greeted back but no task was ever requested or completed",
          ],
        },
        {
          category: 'Buggy Code and Incomplete Solutions',
          description:
            "You encountered buggy code generation in 5 instances where Qwen's initial implementations were incorrect, forcing you to spend additional time iterating on fixes before achieving working solutions.",
          examples: [
            'Test creation required multiple iterations to fix incorrect vi.mocked() usage patterns and fs module mocking approaches before tests finally passed',
            "ESC cancellation feature initially created AbortController but didn't pass signal to command actions, requiring a follow-up fix to properly implement Promise.race in compressCommand",
          ],
        },
        {
          category: 'Tool and Skill Reliability Issues',
          description:
            "You experienced situations where Qwen's tools or skills failed to execute properly, forcing manual workarounds and excessive exploration that extended task completion time.",
          examples: [
            'The code-reviewer subagent skill failed to execute, forcing you to manually review a large PR with 416 files instead of leveraging the automated review capability',
            'PR creation initially generated empty content instead of reading and applying the template file, requiring you to complain and request a fix before getting proper output',
          ],
        },
      ],
    },
    memorableMoment: {
      headline:
        "User paused mid-work to verify Qwen's corporate identity—\"Are you Alibaba's model or Zhipu's GLM?\"",
      detail:
        "During what appears to be routine development work, a user stopped everything to ask Qwen to confirm its corporate origins. Qwen correctly identified itself as Alibaba's model, not Zhipu's GLM. A rare moment of AI identity verification in the wild.",
    },
    improvements: {
      Qwen_md_additions: [
        {
          addition:
            '## Code Review Standards\n- Always check for test coverage when reviewing new features\n- Flag missing error handling in async functions\n- Prefer focused PRs over large multi-file changes',
          why: 'Code review friction showed issues with subagent failures and excessive exploration on large PRs',
          prompt_scaffold:
            'Create new ## Code Review Standards section in QWEN.md',
        },
        {
          addition:
            '## Testing Conventions\n- Use vi.mock() for module mocks before vi.mocked() for function mocking\n- Always wrap components with required providers (e.g., KeypressProvider) in tests\n- Run tests after modifying related files to catch issues early',
          why: 'Multiple test sessions had buggy mock implementation issues that required iterative fixes',
          prompt_scaffold:
            'Create new ## Testing Conventions section in QWEN.md',
        },
        {
          addition:
            '## PR Workflow\n- Always read and apply PR template before creating PR content\n- Use English as default language for PR descriptions unless specified otherwise',
          why: 'One session created empty PR initially, another required English specification - both are repetitive clarifications',
          prompt_scaffold: 'Create new ## PR Workflow section in QWEN.md',
        },
      ],
      features_to_try: [
        {
          feature: 'Custom Skills',
          one_liner: 'Create reusable prompt templates for common workflows',
          why_for_you:
            'You have 6 feature requests and 3+ PR creation sessions - these repetitive workflows would benefit from /pr, /review, /test commands',
          example_code:
            'Create .qwen/skills/pr/SKILL.md:\n```\nCreate a PR using the template at .github/PULL_REQUEST_TEMPLATE.md\n- Summarize commits since main\n- Use English language\n- Include test coverage notes\n```',
        },
        {
          feature: 'Custom Skills',
          one_liner: 'Define test generation standards as a reusable skill',
          why_for_you:
            'You had 2 test creation sessions with mock implementation issues - a /test skill would ensure consistent patterns',
          example_code:
            'Create .qwen/skills/test/SKILL.md:\n```\nGenerate Vitest tests for the specified file:\n- Use vi.mock() for modules before vi.mocked()\n- Include provider wrappers as needed\n- Run tests after generation to verify\n```',
        },
        {
          feature: 'Custom Skills',
          one_liner: 'Create a code review checklist skill',
          why_for_you:
            'You had 3 code review sessions where the code-reviewer subagent failed - a manual /review skill would be more reliable',
          example_code:
            'Create .qwen/skills/review/SKILL.md:\n```\nReview code for:\n1. Test coverage for new features\n2. Error handling in async functions\n3. Security implications\n4. Breaking changes\n```',
        },
        {
          feature: 'Headless Mode',
          one_liner: 'Run Qwen non-interactively for batch operations',
          why_for_you:
            'With 166 run_shell_command calls and repetitive tasks like PR creation, you could automate routine workflows',
          example_code:
            '# Create PR from latest commits\nqwen -p "Create a PR for recent commits using .github/PULL_REQUEST_TEMPLATE.md"\n\n# Batch test generation\nqwen -p "Generate tests for src/DataProcessor.ts"',
        },
        {
          feature: 'Task Agents',
          one_liner: 'Spawn focused sub-agents for complex exploration',
          why_for_you:
            'Your grep_search (53) and file exploration could be more efficient with dedicated agents for codebase understanding',
          example_code:
            'Ask Qwen: "Use an agent to explore the test infrastructure and identify all test utilities available"',
        },
      ],
      usage_patterns: [
        {
          title: 'Reduce Empty Warmup Sessions',
          suggestion:
            'Start sessions with a specific task or use /compress to load context quickly',
          detail:
            "28 of your sessions are warmup_minimal with just 'hi' greetings. These consume time without progress. Instead, start with your actual request or use a skill like /compress to load recent context and continue previous work.",
          copyable_prompt:
            "Instead of 'hi', try: 'Continue working on [specific task]' or '/compress'",
        },
        {
          title: 'Leverage Skills for Repetitive Work',
          suggestion:
            'Create skills for PR creation and test generation since you do these repeatedly',
          detail:
            "You've created multiple PRs and tests with similar patterns each time. Creating /pr and /test skills would ensure consistency (English language, proper templates, correct mock patterns) and save time across your 314 sessions.",
          copyable_prompt:
            'Create .qwen/skills/pr/SKILL.md with your PR template requirements, then just type /pr',
        },
        {
          title: 'Improve Session Completion Rate',
          suggestion:
            'Use todo_write to track progress and ensure full completion before ending sessions',
          detail:
            "Your outcomes show 7 not_achieved vs 13 fully_achieved. With 52 todo_write calls, you're already tracking tasks - ensure you complete all items or explicitly carry them to the next session rather than leaving work incomplete.",
          copyable_prompt:
            "At session start: 'Review my recent incomplete tasks and continue from where we left off'",
        },
        {
          title: 'Preempt Common Issues',
          suggestion:
            'Add testing conventions to QWEN.md to avoid iterative mock fixes',
          detail:
            '5 buggy_code friction points mostly came from test mock implementation issues. Documenting your testing patterns in QWEN.md would help Qwen generate correct tests on the first attempt.',
          copyable_prompt:
            "Add to QWEN.md: 'When generating tests, use vi.mock() before vi.mocked() and always include required providers'",
        },
      ],
    },
    interactionStyle: {
      narrative:
        'Your interaction pattern shows **high-frequency, low-intensity engagement** with Qwen Code. With 314 sessions over just 68 days (averaging 4-5 sessions daily) and 58% of analyzed sessions being "warmup_minimal," you treat Qwen as a readily-available assistant you check in with frequently but often don\'t have specific tasks ready. You say "hi" or "nihao" and wait to see what happens, suggesting you keep Qwen accessible as a background tool rather than planning extensive work sessions.\n\nWhen you do have actual work, you\'re **iterative and feedback-driven rather than specification-heavy**. Examples: when creating PRs, you accepted an initial implementation that created empty content, then reported the issue for Qwen to fix; when implementing ESC cancellation support, you tested the code, discovered the signal wasn\'t being passed through, and reported the specific bug for correction; when requesting tests for DataProcessor, you worked through multiple rounds of fixing mock implementation issues. You don\'t provide exhaustive upfront requirements—you point Qwen at a problem, see what it produces, and course-correct.\n\n**You trust Qwen to explore autonomously but intervene when things go wrong.** Your tool usage (209 read_file calls, 166 shell commands, 98 edits) shows you let Qwen investigate and modify freely. The friction data reveals low rejection rates (0 user_rejected_action, 0 excessive_changes) and zero misunderstood requests, indicating you give Qwen space to work. However, 5 instances of buggy code required your feedback to fix, and you clearly communicate specific issues when they arise ("abort() was called but execution didn\'t stop"). You\'re a collaborative debugger who provides precise problem descriptions rather than vague complaints.',
      key_pattern:
        'You use Qwen Code as a high-frequency, low-commitment tool with iterative feedback loops—many brief check-ins with "hi" or minimal interaction, and when real work happens, you prefer to test implementations and report specific issues for correction rather than providing comprehensive upfront specifications.',
    },
    atAGlance: {
      whats_working:
        'You take a direct, task-oriented approach—submitting clear requests for PR creation, test generation, and refactoring work. Your test generation sessions were particularly effective, producing comprehensive test suites that passed after iteration, and your debugging work successfully identified root causes like missing context providers.',
      whats_hindering:
        "On Qwen's side: some implementations needed follow-up fixes (missing signal passing in abort handling, initial empty PR content), and buggy code generation required multiple iterations—especially around mocking patterns. The code-reviewer skill also failed during a large PR review. On your side: many sessions were empty or just greetings without actual requests, and some friction around iterative debugging could be smoothed with more upfront context about testing frameworks and patterns you prefer.",
      quick_wins:
        'Try using subagents more deliberately for complex tasks like code reviews (you only called skills 4 times)—they can handle multi-step analysis autonomously. When generating tests, specify your preferred mocking patterns upfront to reduce iteration cycles.',
      ambitious_workflows:
        "As models improve, you'll be able to hand off larger autonomous refactoring tasks across many files (you've only done multi-file changes once). Complex debugging sessions that currently require multiple iterations could become single-shot successes. Large PR reviews that stalled due to skill failures will flow smoothly through automated analysis, letting you focus on architectural decisions rather than line-by-line review.",
    },
  },
  satisfaction: {
    unknown: 0,
    satisfied: 4,
    happy: 0,
    likely_satisfied: 7,
    dissatisfied: 1,
    frustrated: 0,
  },
  friction: {
    missing_transcript: 2,
    misunderstood_request: 0,
    wrong_approach: 2,
    buggy_code: 5,
    user_rejected_action: 0,
    excessive_changes: 0,
    tool_failure: 1,
    excessive_exploration: 1,
  },
  primarySuccess: {
    correct_code_edits: 7,
    good_debugging: 1,
    fast_accurate_search: 4,
    multi_file_changes: 1,
    good_explanations: 1,
    proactive_help: 1,
  },
  outcomes: {
    unclear_from_transcript: 25,
    fully_achieved: 13,
    not_achieved: 7,
    mostly_achieved: 2,
    partially_achieved: 1,
  },
  topGoals: {
    unknown: 0,
    warmup_minimal: 28,
    bug_fix: 2,
    feature_request: 6,
    debugging: 1,
    test_creation: 2,
    code_refactoring: 2,
    code_review: 3,
  },
};

// Inject mock data into window so App.tsx can read it on mount
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).INSIGHT_DATA = MOCK_DATA;

// Dynamic import to ensure INSIGHT_DATA is set before App.tsx executes
import('./App');
