# Safe symlinks in public GitHub archives

## Context

The public GitHub archive fallback supports older Git versions, but GitHub archives preserve repository symlinks. Rejecting every link prevents otherwise valid extensions such as `obra/superpowers` from installing.

## Design

Only the public GitHub fallback opts into symlink support. The archive scan accepts at most 100 symlinks, each with a relative target that resolves to a regular-file entry in the same archive, and retains at most 8 MiB of path metadata. Absolute, escaping, chained, dangling, directory, and hard links remain unsupported. This deliberately narrow, fail-closed scope covers the motivating repository without introducing traversal through directory links or chains.

Extraction runs in strict mode, then the archive wrapper is flattened. A second filesystem check validates the final layout because moving a link can change where its relative target resolves. That check requires the immediate target to be a regular file and separately verifies its real path remains inside the final extraction root, which also rejects symlink chains. The same final-layout scan accounts for each link target because the later extension copy can materialize it as another file.

Strict extraction and final-layout validation apply to every archive on this opt-in fallback path, including archives without symlinks. This intentionally makes extraction warnings fail closed and verifies the same resource ceiling against the filesystem that later conversion copies.

Other archive sources retain their existing fail-closed behavior. Zip handling is unchanged.
