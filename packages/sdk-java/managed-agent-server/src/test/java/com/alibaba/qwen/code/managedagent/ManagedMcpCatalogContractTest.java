package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.List;
import org.junit.jupiter.api.Test;

class ManagedMcpCatalogContractTest {
    private static final OpenApiContract CONTRACT = OpenApiContract.load();
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void catalogSchemaKeepsPublicRevisionsAndExcludesInternalConnectionData() throws Exception {
        ObjectNode catalog = (ObjectNode) JSON.readTree("""
                {"object":"agent.mcp_catalog","session_id":"6f1c7d7e-3a4b-4c2d-9e8f-0123456789ab","servers":[
                  {"server_id":"server","server_revision":2,"catalog_revision":3,
                   "tools":[{"name":"read","input_schema":{"type":"object"}}],
                   "resources":[{"name":"note","uri":"note:1","mime_type":"text/plain"}],
                   "prompts":[{"name":"greet","arguments":[{"name":"who","required":true}]}],
                   "discovery":{"tools":"complete","resources":"failed","prompts":"partial"}}]}
                """);
        assertThat(CONTRACT.validate("/components/schemas/PublicMcpCatalog", catalog)).isEmpty();
        for (String field : List.of("connectionGeneration", "runtime_binding_id", "configRevision", "grant", "headers", "env")) {
            ObjectNode leaked = catalog.deepCopy();
            ((ObjectNode) leaked.at("/servers/0")).put(field, "secret");
            assertThat(CONTRACT.validate("/components/schemas/PublicMcpCatalog", leaked)).as(field).isNotEmpty();
        }
        for (String field : List.of("server_revision", "catalog_revision")) {
            ObjectNode missing = catalog.deepCopy();
            ((ObjectNode) missing.at("/servers/0")).remove(field);
            assertThat(CONTRACT.validate("/components/schemas/PublicMcpCatalog", missing)).as(field).isNotEmpty();
            ObjectNode invalid = catalog.deepCopy();
            ((ObjectNode) invalid.at("/servers/0")).put(field, 0);
            assertThat(CONTRACT.validate("/components/schemas/PublicMcpCatalog", invalid)).as(field).isNotEmpty();
        }
        ObjectNode pending = catalog.deepCopy();
        ((ObjectNode) pending.at("/servers/0")).putNull("catalog_revision");
        ObjectNode discovery = (ObjectNode) pending.at("/servers/0/discovery");
        for (String kind : List.of("tools", "resources", "prompts")) {
            discovery.put(kind, "stale");
        }
        assertThat(CONTRACT.validate("/components/schemas/PublicMcpCatalog", pending)).isEmpty();
    }
}
