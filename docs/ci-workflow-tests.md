CI Workflow Test Coverage

- Framework: Uses the repository's existing JS test framework (Jest/Mocha/Vitest).
- Scope: Validates the ".github/workflows" entry named "Test CI Workflow".
- The checks include the following:
  - Workflow name and triggers include push and pull_request events on branch ci-test-branch, and workflow_dispatch present
  - Job "test" runs on ubuntu-latest
  - actions/checkout is pinned to the exact SHA 08c6903cd8c0fde910a37f88322edcfb5dd907a8
  - Ratchet comment present for transparency
  - "Run a simple test" step echoes expected lines

If no YAML parsing library is in devDependencies, the tests fall back to raw content assertions and log a warning.