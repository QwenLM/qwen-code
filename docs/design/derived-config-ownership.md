# Derived Config ownership

`Config` derivation is a state-ownership operation, not a clone. `deriveConfig` keeps the existing prototype overlay model behind one boundary while production callers are migrated incrementally.

| State                      | Ownership                        | Contract                                                                                                                         |
| -------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| workspace path and context | shared until explicitly overlaid | Worktree profiles must override the paired public getters and private reads together.                                            |
| file service and discovery | shared until explicitly overlaid | Worktree profiles rebind both to the target workspace.                                                                           |
| tool registry              | shared or explicitly replaced    | Agent profiles that rebuild it own cleanup of the replacement registry.                                                          |
| permission manager         | shared or explicitly replaced    | Agent profiles preserve the existing strip/restore lifecycle.                                                                    |
| approval mode              | shared                           | Derived profiles may read the inherited mode but cannot mutate it until they own an independent permission-manager lifecycle.    |
| file-read cache            | child-local                      | The first getter call installs a fresh cache on the derived Config.                                                              |
| memory-pressure monitor    | child-local                      | The first getter call installs a new monitor using the inherited configuration snapshot.                                         |
| active todo state          | child-local                      | The first mutation installs independent maps.                                                                                    |
| chat recording service     | shared unless hidden             | Scoped profiles may hide it through a getter override.                                                                           |
| goal runtime               | prohibited                       | A derived Config cannot resolve the parent conversation's runtime.                                                               |
| session writer state       | prohibited                       | Writer ownership stays with the canonical session Config.                                                                        |
| canonical lifecycle        | prohibited                       | A derived Config cannot initialize, start a session, relocate the workspace, or clean up inherited Team/Arena runtime resources. |
| approval mode mutation     | prohibited                       | A derived Config cannot restore or strip rules on the canonical PermissionManager.                                               |

Migration order:

1. Worktree contexts.
2. Agent execution contexts.
3. Scoped memory/remember/skill-review profiles.
4. Enforce that production prototype derivation occurs only inside `deriveConfig`.

The factory intentionally accepts public getter overrides only. Private field rebinding needed by worktree contexts remains a separate migration concern and must be encoded without exposing arbitrary Config mutation.

Approval-mode override wrappers that call Config prototype mutators remain outside `deriveConfig` until their strip/restore lifecycle is owned independently from the parent permission manager.
