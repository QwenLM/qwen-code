# Derived Config ownership

`Config` derivation is a state-ownership operation, not a clone. `deriveConfig` keeps the existing prototype overlay model behind one boundary while production callers are migrated incrementally.

| State                      | Ownership                        | Contract                                                                                                                                |
| -------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| workspace path and context | shared until explicitly overlaid | Worktree profiles must override the paired public getters and private reads together.                                                   |
| file service and discovery | shared until explicitly overlaid | Worktree profiles rebind both to the target workspace.                                                                                  |
| tool registry              | shared or explicitly replaced    | Agent profiles that rebuild it own cleanup of the replacement registry.                                                                 |
| permission manager         | shared or explicitly replaced    | Agent profiles preserve the existing strip/restore lifecycle.                                                                           |
| approval mode              | shared or explicitly copied      | Bare derived profiles cannot mutate it; agent execution profiles own child-local state and preserve the canonical permission lifecycle. |
| file-read cache            | child-local                      | The first getter call installs a fresh cache on the derived Config.                                                                     |
| memory-pressure monitor    | child-local                      | The first getter call installs a new monitor using the inherited configuration snapshot.                                                |
| active todo state          | child-local                      | The first mutation installs independent maps.                                                                                           |
| chat recording service     | shared unless hidden             | Scoped profiles may hide it through a getter override.                                                                                  |
| goal runtime               | prohibited                       | A derived Config cannot resolve the parent conversation's runtime.                                                                      |
| session writer state       | prohibited                       | Writer ownership stays with the canonical session Config.                                                                               |
| canonical lifecycle        | prohibited                       | A derived Config cannot initialize, start a session, relocate the workspace, or clean up inherited Team/Arena runtime resources.        |
| approval mode mutation     | prohibited or explicitly copied  | Only the approval-profile factory may install a child-local transition method and cleanup contract.                                     |

Migration order:

1. Worktree contexts.
2. Agent execution contexts.
3. Scoped memory/remember/skill-review profiles.
4. Enforce that production prototype derivation occurs only inside `deriveConfig`.

The generic factory intentionally accepts public getter overrides only. Named profiles keep private field rebinding and lifecycle management inside `config.ts` without exposing arbitrary Config mutation.

The approval profile owns child-local approval state and its parent permission-manager strip/restore contract. Callers remain responsible for invoking its cleanup callback when the agent lifecycle ends.

Production core modules that import `Config` are linted against non-null `Object.create(...)` calls, keeping new prototype overlays behind the generic or named factories.
