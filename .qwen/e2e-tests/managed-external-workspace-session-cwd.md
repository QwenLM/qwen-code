# External Workspace Session directories

Use an external Files provider, an authorized operator and an owner with a real mounted volume. Prepare two directories on the mount and register its alias with `isolationClass: workspace`.

1. Create two Sessions in the registered Workspace, selecting `conversations/alpha` and `conversations/bravo`. Check the committed native cwd for each Session and the Broker's original binding ID and generation.
2. Using the two actual Sessions, write different values to the same relative filename. Read the file from each Session and check both values against the respective directories on the mounted volume.
3. Close the first Session. Verify that its Runtime hold was released, the second Session still has the original binding and generation, and the second Session can read its value.
4. Try a missing directory and a symlink out of the mount. Acquiring the context must fail. Withhold provider continuity evidence and verify that the Broker refuses acquisition.
5. Release the remaining Session and remove the test resources with their owning operator.

The SQL-backed creation and placement checks run in `ExternalWorkspaceMaterializationTest` and its MySQL subclass. The provider, Worker and Broker checks run in their respective focused suites. The full journey requires a deployment able to verify the real storage mount.
