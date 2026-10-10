package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.List;
import org.junit.jupiter.api.Test;

class ManagedHookCatalogContractTest {
    private static final OpenApiContract CONTRACT = OpenApiContract.load();
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void closesThePublicCatalogAndExcludesPrivateRecipesAndExecutionFields() throws Exception {
        ObjectNode catalog = (ObjectNode) JSON.readTree("""
                {"object":"agent.hook_catalog","session_id":"6f1c7d7e-3a4b-4c2d-9e8f-0123456789ab","catalogs":[
                  {"catalog_id":"catalog-1","catalog_revision":1,"hooks":[
                    {"hook_id":"hook-1","event_name":"BeforeTool","type":"prompt","matcher":"shell",
                     "sequential":true,"async":false,"fail_closed":true,"once":true}]}]}
                """);
        assertThat(CONTRACT.validate("/components/schemas/PublicHookCatalog", catalog)).isEmpty();
        for (String field : List.of("prompt", "command", "headers", "env", "modulePath", "handler", "runtimeSessionId", "onceKey")) {
            ObjectNode leaked = catalog.deepCopy();
            ((ObjectNode) leaked.at("/catalogs/0/hooks/0")).put(field, "secret");
            assertThat(CONTRACT.validate("/components/schemas/PublicHookCatalog", leaked)).as(field).isNotEmpty();
        }
        ObjectNode invalid = catalog.deepCopy();
        ((ObjectNode) invalid.at("/catalogs/0")).put("catalog_revision", 0);
        assertThat(CONTRACT.validate("/components/schemas/PublicHookCatalog", invalid)).isNotEmpty();
        ObjectNode untyped = catalog.deepCopy();
        ((ObjectNode) untyped.at("/catalogs/0/hooks/0")).putObject("matcher").put("prompt", "secret");
        assertThat(CONTRACT.validate("/components/schemas/PublicHookCatalog", untyped)).isNotEmpty();
    }
}
