package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.api.ApiModels.ChangeCwdRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicCwdOperation;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellChangeCwdRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellCwdOperation;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Instance-level validation of the cwd operation request/response shapes
 * against the reviewed OpenAPI schemas, including the
 * {@code failed → failure_code required} condition and the oneOf unions
 * the GET-operation routes serve. The drift harness also goes red when
 * the DTO records and their schemas drift; what this suite adds is the
 * discriminated cwd instances' conformance to the published contracts.
 */
class ManagedCwdOperationContractShapeTest {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String SESSION_ID =
            UUID.randomUUID().toString();

    @Test
    void completedAndFailedOperationsMatchTheirPublishedSchemas() {
        PublicCwdOperation completed = new PublicCwdOperation("op_1",
                SESSION_ID, "cwd_change", "completed", 1,
                "services/b", 2L, null, false);
        assertThat(CONTRACT.validate("/components/schemas/PublicCwdOperation",
                MAPPER.valueToTree(completed))).isEmpty();

        PublicCwdOperation failed = new PublicCwdOperation("op_2",
                SESSION_ID, "cwd_change", "failed", 1, "gone", null,
                "workspace_unavailable", true);
        assertThat(CONTRACT.validate("/components/schemas/PublicCwdOperation",
                MAPPER.valueToTree(failed))).isEmpty();

        WebShellCwdOperation webCompleted = new WebShellCwdOperation("op_3",
                SESSION_ID, "cwd_change", "completed", 2, "services/c",
                3L, null, false);
        assertThat(CONTRACT.validate(
                "/components/schemas/WebShellCwdOperation",
                MAPPER.valueToTree(webCompleted))).isEmpty();

        WebShellCwdOperation webFailed = new WebShellCwdOperation("op_4",
                SESSION_ID, "cwd_change", "failed", 2, "gone", null,
                "context_revision_conflict", false);
        assertThat(CONTRACT.validate(
                "/components/schemas/WebShellCwdOperation",
                MAPPER.valueToTree(webFailed))).isEmpty();

        // ... and against the oneOf unions the GET routes actually serve.
        assertThat(CONTRACT.validate("/components/schemas/PublicOperation",
                MAPPER.valueToTree(completed))).isEmpty();
        assertThat(CONTRACT.validate("/components/schemas/PublicOperation",
                MAPPER.valueToTree(failed))).isEmpty();
        assertThat(CONTRACT.validate("/components/schemas/WebShellOperation",
                MAPPER.valueToTree(webCompleted))).isEmpty();
        assertThat(CONTRACT.validate("/components/schemas/WebShellOperation",
                MAPPER.valueToTree(webFailed))).isEmpty();
    }

    @Test
    void theFailedConditionalRequiresAFailureCode() {
        PublicCwdOperation failedWithoutCode = new PublicCwdOperation(
                "op_5", SESSION_ID, "cwd_change", "failed", 1, "gone", null,
                null, false);
        assertThat(CONTRACT.validate("/components/schemas/PublicCwdOperation",
                MAPPER.valueToTree(failedWithoutCode))).isNotEmpty();

        WebShellCwdOperation webFailedWithoutCode = new WebShellCwdOperation(
                "op_6", SESSION_ID, "cwd_change", "failed", 1, "gone",
                null, null, false);
        assertThat(CONTRACT.validate(
                "/components/schemas/WebShellCwdOperation",
                MAPPER.valueToTree(webFailedWithoutCode))).isNotEmpty();

        PublicCwdOperation wrongType = new PublicCwdOperation("op_7",
                SESSION_ID, "terminal_close", "completed", 1, "x", 1L,
                null, false);
        assertThat(CONTRACT.validate("/components/schemas/PublicCwdOperation",
                MAPPER.valueToTree(wrongType))).isNotEmpty();

        PublicCwdOperation outsideEnum = new PublicCwdOperation("op_8",
                SESSION_ID, "cwd_change", "provisioning", 1, "x", null,
                null, false);
        assertThat(CONTRACT.validate("/components/schemas/PublicCwdOperation",
                MAPPER.valueToTree(outsideEnum))).isNotEmpty();
    }

    @Test
    void requestRecordsMatchTheirPublishedSchemas() {
        assertThat(CONTRACT.validate("/components/schemas/ChangeCwdRequest",
                MAPPER.valueToTree(new ChangeCwdRequest("services/api", 1L))))
                .isEmpty();
        assertThat(CONTRACT.validate(
                "/components/schemas/WebShellChangeCwdRequest",
                MAPPER.valueToTree(new WebShellChangeCwdRequest(
                        "request-1", SESSION_ID, "key", "services/api",
                        1L)))).isEmpty();

        JsonNode nullCwd = MAPPER.createObjectNode()
                .put("expected_context_revision", 1);
        assertThat(CONTRACT.validate("/components/schemas/ChangeCwdRequest",
                nullCwd)).isNotEmpty();
    }
}
