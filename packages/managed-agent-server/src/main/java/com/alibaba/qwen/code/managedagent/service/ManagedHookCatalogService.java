package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Service;

@Service
public class ManagedHookCatalogService {
    private final ManagedAgentService sessions;
    private final ManagedExtensionRecordStore records;

    public ManagedHookCatalogService(ManagedAgentService sessions, ManagedExtensionRecordStore records) {
        this.sessions = sessions;
        this.records = records;
    }

    public JsonNode get(String tenantId, String actorId, String sessionId) {
        sessions.requireReadableSession(tenantId, actorId, sessionId);
        ObjectNode result = JsonNodeFactory.instance.objectNode()
                .put("object", "agent.hook_catalog").put("session_id", sessionId);
        ArrayNode catalogs = result.putArray("catalogs");
        records.latestHookRegistration(tenantId, sessionId).ifPresent(registration -> {
            JsonNode catalog = records.readRecordResource(tenantId, sessionId, registration.get("catalogRef"));
            ObjectNode published = catalogs.addObject().put("catalog_id", registration.get("catalogId").textValue());
            published.set("catalog_revision", registration.get("catalogRevision"));
            ArrayNode hooks = published.putArray("hooks");
            for (JsonNode descriptor : catalog.path("hooks")) {
                ObjectNode hook = hooks.addObject()
                        .put("hook_id", descriptor.path("hookId").asText())
                        .put("event_name", descriptor.path("eventName").asText())
                        .put("type", descriptor.path("config").path("type").asText())
                        .put("sequential", descriptor.path("sequential").asBoolean())
                        .put("async", descriptor.path("async").asBoolean())
                        .put("fail_closed", descriptor.path("failClosed").asBoolean())
                        .put("once", descriptor.hasNonNull("onceKey"));
                if (descriptor.path("matcher").isTextual()) {
                    hook.put("matcher", descriptor.get("matcher").textValue());
                }
            }
        });
        return result;
    }
}
