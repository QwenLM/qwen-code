# Asynchronous Release Finalization Test Plan

1. Publish a stable release and confirm the main Release workflow completes after the GitHub Release is created.
2. Confirm `Finalize Stable Release` starts from the `release.published` event while OSS synchronization runs independently.
3. Confirm successful AI generation updates the Release before CHANGELOG regeneration and release PR creation.
4. Force AI generation to fail and confirm GitHub-generated notes remain while the changelog and release PR steps continue.
5. Publish or dispatch a preview/nightly tag and confirm all finalization steps after tag validation are skipped.
6. Dispatch an existing stable tag manually and confirm package publication is not rerun.
7. Dispatch a stable tag whose release PR is already merged and confirm no replacement PR is created or merged.
