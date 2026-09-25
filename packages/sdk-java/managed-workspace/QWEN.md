# Qwen Managed Workspace Binding

Keep this module independent of Spring, Qwen Code CLI internals, the Runtime Broker and any scheduler, and keep it free of runtime dependencies.

Treat every caller-supplied Workspace ID and directory as untrusted input. Resolution reports one typed error, never falls back to a default Workspace or a launch directory, and never reveals whether another tenant's Workspace exists. The working-directory rule is lexical; do not add filesystem checks here, because the Runtime verifies the directory where the files live.

A decoder that builds a `ContextBinding` from text must accept only the ASCII form `[1-9][0-9]*`, at most 2^63−1, for the generation and the revision, as the TypeScript implementation does. `Long.parseLong` alone also accepts a sign, leading zeros and non-ASCII digits.

A change to the directory rule or to the ContextBinding encoding must update, in the same change, the shared fixtures in `packages/cli/src/serve/contracts/managed-workspace-binding-v1.fixtures.json` and the TypeScript implementation in `packages/cli/src/serve/managed-workspace-binding.ts`, so both languages keep producing the same bytes. Compute new expected values with an implementation independent of both.

Use JDK 21 or later to build and run this module.

Build and test with:

```bash
mvn test
mvn checkstyle:check
```
