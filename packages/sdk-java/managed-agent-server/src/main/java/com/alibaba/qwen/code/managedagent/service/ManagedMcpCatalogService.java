package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import org.springframework.stereotype.Service;

@Service
public class ManagedMcpCatalogService {
    private final ManagedAgentService sessions;
    private final ManagedExtensionRecordStore records;

    public ManagedMcpCatalogService(ManagedAgentService sessions, ManagedExtensionRecordStore records) {
        this.sessions = sessions;
        this.records = records;
    }

    public JsonNode get(String tenantId, String actorId, String sessionId) {
        sessions.requireReadableSession(tenantId, actorId, sessionId);
        Map<String, JsonNode> latest = new LinkedHashMap<>();
        for (JsonNode record : records.listRecords(tenantId, sessionId, "mcp_configuration")) {
            latest.merge(record.get("serverId").textValue(), record, (previous, next) -> {
                boolean published = previous.hasNonNull("catalogRef");
                if (published != next.hasNonNull("catalogRef")) {
                    return published ? previous : next;
                }
                return previous.get("configRevision").longValue() >= next.get("configRevision").longValue()
                        ? previous : next;
            });
        }
        ObjectNode result = JsonNodeFactory.instance.objectNode()
                .put("object", "agent.mcp_catalog").put("session_id", sessionId);
        ArrayNode servers = result.putArray("servers");
        for (JsonNode record : latest.values()) {
            JsonNode catalog = record.hasNonNull("catalogRef")
                    ? records.readRecordResource(tenantId, sessionId, record.get("catalogRef"))
                    : JsonNodeFactory.instance.objectNode();
            ObjectNode server = servers.addObject().put("server_id", record.get("serverId").textValue());
            server.set("server_revision", record.get("serverRevision"));
            server.set("catalog_revision", record.get("catalogRevision"));
            for (String kind : new String[] {"tools", "resources", "prompts"}) {
                ArrayNode capabilities = server.putArray(kind);
                for (JsonNode capability : catalog.path(kind)) {
                    ObjectNode item = capabilities.addObject();
                    copy(capability, item, "name", "description");
                    if ("tools".equals(kind)) {
                        item.set("input_schema", capability.path("inputSchema").deepCopy());
                    } else if ("resources".equals(kind)) {
                        copy(capability, item, "uri");
                        if (capability.has("mimeType")) {
                            item.set("mime_type", capability.get("mimeType").deepCopy());
                        }
                    } else if (capability.has("arguments")) {
                        ArrayNode arguments = item.putArray("arguments");
                        for (JsonNode argument : capability.get("arguments")) {
                            copy(argument, arguments.addObject(), "name", "description", "required");
                        }
                    }
                }
            }
            ObjectNode discovery = server.putObject("discovery");
            boolean active = "active".equals(record.path("releaseState").asText());
            for (String kind : new String[] {"tools", "resources", "prompts"}) {
                String state = catalog.path("discovery").path(kind).asText("stale");
                discovery.put(kind, active && Set.of("complete", "partial", "failed", "stale").contains(state)
                        ? state : "stale");
            }
        }
        return result;
    }

    private static void copy(JsonNode source, ObjectNode target, String... fields) {
        for (String field : fields) {
            if (source.has(field)) {
                target.set(field, source.get(field).deepCopy());
            }
        }
    }
}
