package com.alibaba.qwen.code.daemon;

import java.util.Map;

/** Public state of one Managed Session. Optional fields are nullable. */
public final class ManagedSession extends ManagedJson {
    ManagedSession(Map<String, Object> json) {
        super(json);
    }

    public String getId() {
        return string("id");
    }

    public String getAgentId() {
        return string("agent_id");
    }

    public String getAgentRevision() {
        return string("agent_revision");
    }

    public String getAgentDigest() {
        return optionalString("agent_digest");
    }

    public Status getStatus() {
        return Status.fromWire(getStatusCode());
    }

    /** Exact Server value, including states added in newer Server versions. */
    public String getStatusCode() {
        return string("status");
    }

    public String getCreationOperationId() {
        return optionalString("creation_operation_id");
    }

    public long getCreatedAt() {
        return number("created_at");
    }

    public long getUpdatedAt() {
        return number("updated_at");
    }

    public Map<String, Object> getMetadata() {
        return optionalObject("metadata");
    }

    /** Returns the Session title, or null if there is no title. */
    public String getTitle() {
        Map<String, Object> metadata = getMetadata();
        return metadata == null ? null : JsonSupport.optionalString(metadata, "title");
    }

    public ManagedTurn getActiveTurn() {
        return optionalObject("active_turn", ManagedTurn::new);
    }

    public long getLastEventId() {
        return number("last_event_id");
    }

    public Long getReplayFloorSequence() {
        return optionalNumber("replay_floor_sequence");
    }

    public Long getSnapshotThroughSequence() {
        return optionalNumber("snapshot_through_sequence");
    }

    public Workspace getWorkspace() {
        return optionalObject("workspace", Workspace::new);
    }

    public Long getArchivedAt() {
        return optionalNumber("archived_at");
    }

    public Long getCompactionRevision() {
        return optionalNumber("compaction_revision");
    }

    public String getContextCompressionOperationId() {
        return optionalString("context_compression_operation_id");
    }

    public Capabilities getCapabilities() {
        return new Capabilities(object("capabilities"));
    }

    public ManagedRecovery getRecovery() {
        return optionalObject("recovery", ManagedRecovery::new);
    }

    public Worktree getWorktree() {
        return optionalObject("worktree", Worktree::new);
    }

    public String getMemoryStoreId() {
        return optionalString("memory_store_id");
    }

    public Boolean isOwnerOnly() {
        return optionalFlag("owner_only");
    }

    public enum Status {
        ACTIVE, ARCHIVING, ARCHIVED, DELETING, CLOSING, CLOSED, FAILED, RECOVERY_BLOCKED, UNKNOWN;

        private static Status fromWire(String value) {
            try {
                return valueOf(value.toUpperCase(java.util.Locale.ROOT));
            } catch (IllegalArgumentException unknown) {
                return UNKNOWN;
            }
        }
    }

    /** Resolved Workspace and working directory for this Session. */
    public static final class Workspace extends ManagedJson {
        Workspace(Map<String, Object> json) {
            super(json);
        }

        public String getId() {
            return string("workspace_id");
        }

        public String getCwdRelative() {
            return string("cwd_relative");
        }

        public long getContextRevision() {
            return number("context_revision");
        }

        public String getState() {
            return string("state");
        }
    }

    /** Public capabilities advertised for the Session. Absent optional capabilities are false. */
    public static final class Capabilities extends ManagedJson {
        Capabilities(Map<String, Object> json) {
            super(json);
        }

        public boolean supportsItems() {
            return flag("items");
        }

        public boolean supportsSnapshots() {
            return flag("snapshots");
        }

        public boolean supportsArtifacts() {
            return flag("artifacts");
        }

        public boolean supportsResync() {
            return flag("resync");
        }

        public boolean supportsWorkspaceContext() {
            return Boolean.TRUE.equals(optionalFlag("workspace_context"));
        }

        public boolean supportsCwdChange() {
            return Boolean.TRUE.equals(optionalFlag("cwd_change"));
        }

        public boolean supportsActions() {
            return flag("actions");
        }

        public boolean supportsSessionLifecycle() {
            return Boolean.TRUE.equals(optionalFlag("session_lifecycle"));
        }

        public boolean supportsTasks() {
            return flag("tasks");
        }

        public boolean supportsSessionClose() {
            return Boolean.TRUE.equals(optionalFlag("session_close"));
        }

        public boolean supportsSessionArchive() {
            return Boolean.TRUE.equals(optionalFlag("session_archive"));
        }

        public boolean supportsSessionUnarchive() {
            return Boolean.TRUE.equals(optionalFlag("session_unarchive"));
        }

        public boolean supportsSessionDelete() {
            return Boolean.TRUE.equals(optionalFlag("session_delete"));
        }

        public boolean supportsForegroundShell() {
            return Boolean.TRUE.equals(optionalFlag("foreground_shell"));
        }

        public boolean supportsContextCompression() {
            return Boolean.TRUE.equals(optionalFlag("context_compression"));
        }

        public boolean supportsChildAgents() {
            return Boolean.TRUE.equals(optionalFlag("child_agents"));
        }

        public boolean supportsBtw() {
            return Boolean.TRUE.equals(optionalFlag("btw"));
        }

        public boolean supportsRecap() {
            return Boolean.TRUE.equals(optionalFlag("recap"));
        }
    }

    /** Managed worktree selected at Session creation. */
    public static final class Worktree extends ManagedJson {
        Worktree(Map<String, Object> json) {
            super(json);
        }

        public String getId() {
            return string("id");
        }

        public String getSessionId() {
            return string("session_id");
        }

        public String getWorkspaceId() {
            return string("workspace_id");
        }

        public String getBranch() {
            return string("branch");
        }

        public String getBaseCommit() {
            return string("base_commit");
        }

        public String getCwdRelative() {
            return string("cwd_relative");
        }

        public String getOperationId() {
            return string("operation_id");
        }

        public String getState() {
            return string("state");
        }

        public long getRevision() {
            return number("revision");
        }

        public String getErrorCode() {
            return optionalString("error_code");
        }
    }
}
