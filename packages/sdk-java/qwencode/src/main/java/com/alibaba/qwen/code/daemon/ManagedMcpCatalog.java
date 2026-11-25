package com.alibaba.qwen.code.daemon;

import java.util.List;
import java.util.Map;

/** Effective MCP tools, resources and prompts for a Session. */
public final class ManagedMcpCatalog extends ManagedJson {
    ManagedMcpCatalog(Map<String, Object> json) {
        super(json);
    }

    public String getSessionId() {
        return string("session_id");
    }

    public List<Server> getServers() {
        return objects("servers", Server::new);
    }

    /** Published descriptors for one MCP server. */
    public static final class Server extends ManagedJson {
        Server(Map<String, Object> json) {
            super(json);
        }

        public String getId() {
            return string("server_id");
        }

        public long getRevision() {
            return number("server_revision");
        }

        public Long getCatalogRevision() {
            return optionalNumber("catalog_revision");
        }

        public Discovery getDiscovery() {
            return new Discovery(object("discovery"));
        }

        public List<Tool> getTools() {
            return objects("tools", Tool::new);
        }

        public List<Resource> getResources() {
            return objects("resources", Resource::new);
        }

        public List<Prompt> getPrompts() {
            return objects("prompts", Prompt::new);
        }
    }

    /** Discovery status for each MCP surface. */
    public static final class Discovery extends ManagedJson {
        Discovery(Map<String, Object> json) {
            super(json);
        }

        public String getTools() {
            return string("tools");
        }

        public String getResources() {
            return string("resources");
        }

        public String getPrompts() {
            return string("prompts");
        }
    }

    /** One MCP tool and its JSON input schema. */
    public static final class Tool extends ManagedJson {
        Tool(Map<String, Object> json) {
            super(json);
        }

        public String getName() {
            return string("name");
        }

        public String getDescription() {
            return optionalString("description");
        }

        public Map<String, Object> getInputSchema() {
            return object("input_schema");
        }
    }

    /** One MCP resource. */
    public static final class Resource extends ManagedJson {
        Resource(Map<String, Object> json) {
            super(json);
        }

        public String getName() {
            return string("name");
        }

        public String getUri() {
            return string("uri");
        }

        public String getDescription() {
            return optionalString("description");
        }

        public String getMimeType() {
            return optionalString("mime_type");
        }
    }

    /** One MCP prompt and its arguments. */
    public static final class Prompt extends ManagedJson {
        Prompt(Map<String, Object> json) {
            super(json);
        }

        public String getName() {
            return string("name");
        }

        public String getDescription() {
            return optionalString("description");
        }

        public List<Argument> getArguments() {
            return json().get("arguments") == null ? List.of() : objects("arguments", Argument::new);
        }
    }

    /** One MCP prompt argument. */
    public static final class Argument extends ManagedJson {
        Argument(Map<String, Object> json) {
            super(json);
        }

        public String getName() {
            return string("name");
        }

        public String getDescription() {
            return optionalString("description");
        }

        public Boolean isRequired() {
            return optionalFlag("required");
        }
    }
}
