/**
 * @license
 * Copyright 2026 Qmode
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IntentType, PromptTemplate } from '../types.js';

/**
 * Base template for all prompt types
 */
export const BASE_TEMPLATE = `## Task
{task}

## Context
{context}

## Requirements
{requirements}

## Constraints
{constraints}

## Acceptance Criteria
{acceptanceCriteria}

## Implementation Plan
{implementationPlan}
`;

/**
 * Template for code creation tasks
 */
export const CODE_CREATION_TEMPLATE: PromptTemplate = {
  id: 'code-creation',
  name: 'Code Creation',
  description: 'Template for creating new code, features, or components',
  intent: 'code-creation',
  template: `## Task
{task}

## Context
- Project: {projectName}
- Location: {filePath}
- Related files: {relatedFiles}
- Existing patterns: {existingPatterns}

## Requirements
- [ ] Functional: {functionalRequirements}
- [ ] Code style: Follow existing project conventions ({namingConvention})
- [ ] Testing: Include unit tests using {testingFramework}
- [ ] Documentation: Add {documentationStyle} comments

## Constraints
- TypeScript strict mode compliance
- No new dependencies without justification
- Backward compatibility with existing APIs
- Performance: {performanceRequirements}

## Acceptance Criteria
1. {acceptanceCriteria1}
2. {acceptanceCriteria2}
3. All existing tests pass
4. Linter checks pass
5. Code reviewed for patterns consistency

## Implementation Plan
1. Analyze existing similar implementations
2. Create interface/type definitions
3. Implement core logic
4. Write tests
5. Update documentation
6. Run linter and type checker
`,
  variables: [
    'task',
    'projectName',
    'filePath',
    'relatedFiles',
    'existingPatterns',
    'namingConvention',
    'testingFramework',
    'documentationStyle',
    'functionalRequirements',
    'performanceRequirements',
    'acceptanceCriteria1',
    'acceptanceCriteria2',
  ],
};

/**
 * Template for bug fix tasks
 */
export const BUG_FIX_TEMPLATE: PromptTemplate = {
  id: 'bug-fix',
  name: 'Bug Fix',
  description: 'Template for diagnosing and fixing bugs',
  intent: 'bug-fix',
  template: `## Bug Report
{task}

## Investigation
- Error location: {errorLocation}
- Error message: {errorMessage}
- Stack trace: {stackTrace}
- Reproduction steps: {reproductionSteps}
- Affected files: {affectedFiles}

## Hypothesis
{hypothesis}

## Fix Requirements
- [ ] Root cause identified and documented
- [ ] Fix implemented with minimal changes
- [ ] Regression test added
- [ ] No breaking changes to existing APIs
- [ ] Edge cases considered

## Constraints
- Maintain backward compatibility
- No performance degradation
- Follow existing error handling patterns
- Document the fix in code comments

## Validation
- [ ] Original issue resolved
- [ ] Reproduction steps no longer trigger the bug
- [ ] No new test failures
- [ ] Edge cases tested
- [ ] Related functionality verified

## Implementation Plan
1. Reproduce the bug locally
2. Identify root cause through debugging
3. Design minimal fix
4. Implement fix
5. Write regression test
6. Run full test suite
7. Verify fix resolves the issue
`,
  variables: [
    'task',
    'errorLocation',
    'errorMessage',
    'stackTrace',
    'reproductionSteps',
    'affectedFiles',
    'hypothesis',
  ],
};

/**
 * Template for code review tasks
 */
export const REVIEW_TEMPLATE: PromptTemplate = {
  id: 'review',
  name: 'Code Review',
  description: 'Template for reviewing code changes',
  intent: 'review',
  template: `## Review Request
{task}

## Scope
- Files changed: {filesChanged}
- Type of review: {reviewType}
- PR/Commit: {prReference}

## Review Focus Areas
1. **Correctness**: Logic errors, edge cases, null handling
2. **Performance**: Complexity, bottlenecks, memory usage
3. **Security**: Vulnerabilities, data handling, input validation
4. **Maintainability**: Code clarity, patterns, naming
5. **Testing**: Coverage, test quality, edge cases

## Review Guidelines
- Use line comments for specific issues
- Suggest concrete improvements
- Reference style guide when applicable
- Distinguish between blocking and non-blocking feedback

## Output Format
### Summary
Brief overview of the changes

### Critical Issues (Must Fix)
- [ ] Issue 1 with suggested fix
- [ ] Issue 2 with suggested fix

### Suggestions (Nice to Have)
- Suggestion 1
- Suggestion 2

### Positive Observations
- What was done well

## Constraints
- Follow team style guide: {styleGuide}
- Check against project conventions: {conventions}
- Consider performance requirements: {performanceRequirements}
`,
  variables: [
    'task',
    'filesChanged',
    'reviewType',
    'prReference',
    'styleGuide',
    'conventions',
    'performanceRequirements',
  ],
};

/**
 * Template for refactoring tasks
 */
export const REFACTOR_TEMPLATE: PromptTemplate = {
  id: 'refactor',
  name: 'Refactor',
  description: 'Template for refactoring and code improvement',
  intent: 'refactor',
  template: `## Refactoring Task
{task}

## Current State
- Files to refactor: {filesToRefactor}
- Current issues: {currentIssues}
- Technical debt: {technicalDebt}

## Goals
- {refactorGoal1}
- {refactorGoal2}
- {refactorGoal3}

## Constraints
- Maintain all existing functionality
- No breaking changes to public APIs
- Preserve backward compatibility
- Keep git diff reviewable (consider splitting if large)

## Approach
1. Analyze current implementation
2. Identify patterns to apply
3. Plan incremental changes
4. Ensure test coverage before changes
5. Refactor in small steps
6. Verify after each step

## Success Criteria
- [ ] All tests pass (existing + new)
- [ ] Code complexity reduced ({complexityMetric})
- [ ] Readability improved
- [ ] Performance maintained or improved
- [ ] Documentation updated

## Risk Mitigation
- Run full test suite after each change
- Have rollback plan ready
- Consider feature flag for large changes
`,
  variables: [
    'task',
    'filesToRefactor',
    'currentIssues',
    'technicalDebt',
    'refactorGoal1',
    'refactorGoal2',
    'refactorGoal3',
    'complexityMetric',
  ],
};

/**
 * Template for Q&A tasks
 */
export const ASK_TEMPLATE: PromptTemplate = {
  id: 'ask',
  name: 'Ask / Question',
  description: 'Template for questions and explanations',
  intent: 'ask',
  template: `## Question
{task}

## Context
- Project: {projectName}
- Topic: {topic}
- What I know: {priorKnowledge}
- What I've tried: {attemptedSolutions}

## What I Need
- {specificQuestion}

## Expected Answer Format
- Clear explanation of the concept
- Code examples if applicable
- References to documentation
- Common pitfalls to avoid

## Constraints
- Keep explanation concise but complete
- Include practical examples
- Reference project-specific patterns where relevant
`,
  variables: [
    'task',
    'projectName',
    'topic',
    'priorKnowledge',
    'attemptedSolutions',
    'specificQuestion',
  ],
};

/**
 * Template for debug tasks
 */
export const DEBUG_TEMPLATE: PromptTemplate = {
  id: 'debug',
  name: 'Debug',
  description: 'Template for debugging and investigation',
  intent: 'debug',
  template: `## Debug Session
{task}

## Symptoms
- What's happening: {symptoms}
- What should happen: {expectedBehavior}
- When it occurs: {occurrencePattern}

## Environment
- OS: {os}
- Node version: {nodeVersion}
- Relevant dependencies: {dependencies}

## Investigation Steps
1. Gather logs and error messages
2. Reproduce the issue consistently
3. Add logging/debug statements
4. Form hypotheses about root cause
5. Test each hypothesis
6. Narrow down to specific code

## Available Information
- Logs: {logs}
- Error messages: {errorMessages}
- Recent changes: {recentChanges}

## Next Steps
- [ ] Collect additional information
- [ ] Test hypothesis 1
- [ ] Test hypothesis 2
- [ ] Implement fix once root cause found
`,
  variables: [
    'task',
    'symptoms',
    'expectedBehavior',
    'occurrencePattern',
    'os',
    'nodeVersion',
    'dependencies',
    'logs',
    'errorMessages',
    'recentChanges',
  ],
};

/**
 * Template for test tasks
 */
export const TEST_TEMPLATE: PromptTemplate = {
  id: 'test',
  name: 'Test Creation',
  description: 'Template for writing tests',
  intent: 'test',
  template: `## Test Task
{task}

## Test Subject
- File/Module to test: {testSubject}
- Functions/Methods: {functionsToTest}
- Expected behavior: {expectedBehavior}

## Test Requirements
- Testing framework: {testingFramework}
- Coverage target: {coverageTarget}
- Test patterns: {testPatterns}

## Test Cases to Cover
1. Happy path
2. Edge cases
3. Error cases
4. Boundary conditions
5. Integration points

## Test Structure
\`\`\`typescript
describe('{moduleName}', () => {
  describe('{functionName}', () => {
    it('should {expectedBehavior}', () => {
      // Arrange
      // Act
      // Assert
    });
  });
});
\`\`\`

## Constraints
- Follow existing test patterns in project
- Use descriptive test names
- Mock external dependencies
- Keep tests independent
- Ensure tests are deterministic
`,
  variables: [
    'task',
    'testSubject',
    'functionsToTest',
    'expectedBehavior',
    'testingFramework',
    'coverageTarget',
    'testPatterns',
    'moduleName',
    'functionName',
  ],
};

/**
 * Template for documentation tasks
 */
export const DOCUMENTATION_TEMPLATE: PromptTemplate = {
  id: 'documentation',
  name: 'Documentation',
  description: 'Template for documentation tasks',
  intent: 'documentation',
  template: `## Documentation Task
{task}

## Documentation Type
- Type: {docType}
- Target audience: {audience}
- Format: {format}

## Content Requirements
- Topics to cover: {topics}
- Key concepts: {keyConcepts}
- Code examples needed: {codeExamples}

## Style Guidelines
- Documentation style: {documentationStyle}
- Tone: {tone}
- Level of detail: {detailLevel}

## Structure
1. Overview/Introduction
2. Prerequisites
3. Main content
4. Examples
5. Troubleshooting (if applicable)
6. Related resources

## Quality Checklist
- [ ] Clear and concise
- [ ] Includes examples
- [ ] Up-to-date with code
- [ ] Proper formatting
- [ ] Links to related docs
`,
  variables: [
    'task',
    'docType',
    'audience',
    'format',
    'topics',
    'keyConcepts',
    'codeExamples',
    'documentationStyle',
    'tone',
    'detailLevel',
  ],
};

/**
 * Registry of all templates
 */
export const TEMPLATE_REGISTRY: Record<IntentType, PromptTemplate> = {
  'code-creation': CODE_CREATION_TEMPLATE,
  'bug-fix': BUG_FIX_TEMPLATE,
  review: REVIEW_TEMPLATE,
  refactor: REFACTOR_TEMPLATE,
  ask: ASK_TEMPLATE,
  debug: DEBUG_TEMPLATE,
  test: TEST_TEMPLATE,
  documentation: DOCUMENTATION_TEMPLATE,
  unknown: CODE_CREATION_TEMPLATE, // Default fallback
};

/**
 * Get template by intent
 */
export function getTemplate(intent: IntentType): PromptTemplate {
  return TEMPLATE_REGISTRY[intent] || TEMPLATE_REGISTRY['code-creation'];
}

/**
 * Get all available templates
 */
export function getAllTemplates(): PromptTemplate[] {
  return Object.values(TEMPLATE_REGISTRY);
}
