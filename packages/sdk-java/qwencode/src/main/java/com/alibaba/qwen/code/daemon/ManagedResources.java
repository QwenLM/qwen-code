package com.alibaba.qwen.code.daemon;

import java.util.List;
import java.util.Map;

/** Diagnostic view of Skill and MCP resources associated with a Session. */
public final class ManagedResources extends ManagedJson {
    ManagedResources(Map<String, Object> json) {
        super(json);
    }

    public long getSchemaVersion() {
        return number("schemaVersion");
    }

    public String getSessionId() {
        return string("sessionId");
    }

    public String getReadRevision() {
        return optionalString("readRevision");
    }

    public String getAvailability() {
        return string("availability");
    }

    public List<String> getCoverageReasons() {
        return List.copyOf(JsonSupport.stringList(json(), "coverageReasons"));
    }

    public String getConfigCoverage() {
        return string("configCoverage");
    }

    public String getHistoryCoverage() {
        return string("historyCoverage");
    }

    public Long getActiveConfigRevision() {
        return optionalNumber("activeConfigRevision");
    }

    public String getActiveOperationPhase() {
        return optionalString("activeOperationPhase");
    }

    public boolean isOutputTruncated() {
        return flag("outputTruncated");
    }

    public List<Skill> getSkills() {
        return objects("skills", Skill::new);
    }

    public List<Server> getServers() {
        return objects("servers", Server::new);
    }

    /** One selected Skill and its availability. */
    public static final class Skill extends ManagedJson {
        Skill(Map<String, Object> json) {
            super(json);
        }

        public String getName() {
            return string("name");
        }

        public String getDescription() {
            return optionalString("description");
        }

        public String getKind() {
            return string("kind");
        }

        public String getOrigin() {
            return string("origin");
        }

        public String getExtensionId() {
            return optionalString("extensionId");
        }

        public boolean isModelInvocable() {
            return flag("modelInvocable");
        }

        public boolean isUserInvocable() {
            return flag("userInvocable");
        }
    }

    /** Diagnostic state of one MCP server. */
    public static final class Server extends ManagedJson {
        Server(Map<String, Object> json) {
            super(json);
        }

        public String getId() {
            return string("serverId");
        }

        public long getRevision() {
            return number("serverRevision");
        }

        public String getOrigin() {
            return string("origin");
        }

        public String getExtensionId() {
            return optionalString("extensionId");
        }

        public String getSelectionState() {
            return string("selectionState");
        }

        public String getLiveState() {
            return string("liveState");
        }

        public Long getCatalogRevision() {
            return optionalNumber("catalogRevision");
        }

        public Long getCatalogServerRevision() {
            return optionalNumber("catalogServerRevision");
        }

        public Long getAttemptRevision() {
            return optionalNumber("attemptRevision");
        }

        public Long getAttemptServerRevision() {
            return optionalNumber("attemptServerRevision");
        }

        public String getLastAttemptState() {
            return optionalString("lastAttemptState");
        }

        public String getLastExecutionState() {
            return optionalString("lastExecutionState");
        }

        public String getReleaseState() {
            return optionalString("releaseState");
        }

        public boolean isHistorical() {
            return flag("historical");
        }

        public Map<String, Object> getDiscovery() {
            return object("discovery");
        }

        public List<Descriptor> getTools() {
            return objects("tools", Descriptor::new);
        }

        public List<Descriptor> getResources() {
            return objects("resources", Descriptor::new);
        }

        public List<Descriptor> getPrompts() {
            return objects("prompts", Descriptor::new);
        }
    }

    /** Summary of a discovered tool, resource or prompt. */
    public static final class Descriptor extends ManagedJson {
        Descriptor(Map<String, Object> json) {
            super(json);
        }

        public String getName() {
            return string("name");
        }

        public String getDescription() {
            return optionalString("description");
        }

        public String getUri() {
            return optionalString("uri");
        }

        public String getMimeType() {
            return optionalString("mimeType");
        }
    }
}
