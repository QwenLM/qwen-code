# Safe symlinks in public GitHub archives

## Context

The public GitHub archive fallback supports older Git versions, but GitHub archives preserve repository symlinks. Rejecting every link prevents otherwise valid extensions such as `obra/superpowers` from installing.

## Design

Only the public GitHub fallback opts into symlink support. The archive scan accepts a symlink only when its relative target resolves to a regular-file entry in the same archive. Absolute, escaping, chained, dangling, directory, and hard links remain unsupported. Resource accounting includes each accepted target because the later extension copy can materialize it as another file.

Extraction runs in strict mode, then the archive wrapper is flattened. A second filesystem check validates the final layout because moving a link can change where its relative target resolves. That check requires the immediate target to be a regular file and separately verifies its real path remains inside the final extraction root. Requiring an immediate file also rejects chains created by filesystem case collisions.

Other archive sources retain their existing fail-closed behavior. Zip handling is unchanged.
