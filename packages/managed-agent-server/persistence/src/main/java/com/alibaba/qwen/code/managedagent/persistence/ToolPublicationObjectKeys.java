package com.alibaba.qwen.code.managedagent.persistence;

import com.fasterxml.jackson.databind.JsonNode;

import static com.alibaba.qwen.code.managedagent.contracts.persistence.ToolPublicationContract.ossScope;

final class ToolPublicationObjectKeys {
    private ToolPublicationObjectKeys() {
    }

    static String forSlot(JsonNode key, String publicationId, String slot) {
        return "managed-tool-results/" + ossScope(key) + "/" + publicationId + "/" + slot;
    }
}
