package com.alibaba.qwen.code.runtimebroker.managedworkspace;

import java.util.List;
import java.util.Objects;
import java.util.Optional;

/**
 * A caller's Workspace choice at Session creation: omitted, or an explicit
 * Workspace ID with a relative directory. The directory is normalized when
 * the selection is built, so an invalid one fails with {@code invalid_cwd}
 * before any lookup. The API layer rejects {@code null} and an empty object
 * before building a selection; only an omitted one may use a default.
 */
public final class WorkspaceSelection {
    private static final WorkspaceSelection OMITTED =
            new WorkspaceSelection(null, WorkspaceRelativePath.ROOT);

    private final String workspaceId;
    private final String cwdRelative;

    private WorkspaceSelection(String workspaceId, String cwdRelative) {
        this.workspaceId = workspaceId;
        this.cwdRelative = cwdRelative;
    }

    public static WorkspaceSelection omitted() {
        return OMITTED;
    }

    /** An explicit Workspace with the root directory. */
    public static WorkspaceSelection explicit(String workspaceId) {
        return explicit(workspaceId, WorkspaceRelativePath.ROOT);
    }

    /**
     * An explicit Workspace and relative directory. The ID is caller input:
     * an ID that cannot exist later resolves as {@code workspace_not_found}.
     *
     * @throws WorkspaceException {@code invalid_cwd} for an invalid directory
     */
    public static WorkspaceSelection explicit(String workspaceId,
            String cwdRelative) {
        if (workspaceId == null) {
            throw new IllegalArgumentException("workspaceId is required");
        }
        return new WorkspaceSelection(workspaceId,
                WorkspaceRelativePath.normalize(cwdRelative));
    }

    public boolean isOmitted() {
        return workspaceId == null;
    }

    public Optional<String> getWorkspaceId() {
        return Optional.ofNullable(workspaceId);
    }

    /** The normalized directory; {@code .} for an omitted selection. */
    public String getCwdRelative() {
        return cwdRelative;
    }

    /**
     * The values a request digest covers: a fixed omission marker, or the
     * Workspace ID with the normalized directory. Spellings of the same
     * directory therefore digest alike, and omission never digests like an
     * explicit choice of the default. The Workspace ID is unvalidated caller
     * input: request validation must reject one that is not well-formed
     * Unicode before any digest, because UTF-8 cannot encode it.
     */
    public List<String> digestFields() {
        return isOmitted()
                ? List.of("omitted")
                : List.of("explicit", workspaceId, cwdRelative);
    }

    @Override
    public boolean equals(Object candidate) {
        if (this == candidate) {
            return true;
        }
        if (!(candidate instanceof WorkspaceSelection)) {
            return false;
        }
        WorkspaceSelection other = (WorkspaceSelection) candidate;
        return Objects.equals(workspaceId, other.workspaceId)
                && cwdRelative.equals(other.cwdRelative);
    }

    @Override
    public int hashCode() {
        return Objects.hash(workspaceId, cwdRelative);
    }
}
