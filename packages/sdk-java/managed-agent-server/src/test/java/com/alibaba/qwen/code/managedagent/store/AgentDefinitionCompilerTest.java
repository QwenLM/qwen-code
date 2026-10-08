package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The D8c-1 compile: accepted shapes map to the approval mode and tool
 * profile a Session pins; every other shape refuses admission with
 * {@code 409 agent_definition_unsupported} and names its field.
 */
class AgentDefinitionCompilerTest {
    private static final List<String> FILES_ONLY = List.of(
            "hosted-workspace-files/1");

    private static String definition(String tools,
            String permissionPolicy) {
        return "{\"model\":{},\"instructions\":\"\",\"tools\":" + tools
                + ",\"permission_policy\":" + permissionPolicy + "}";
    }

    private static String hostedProfile(String profile) {
        return "[{\"type\":\"hosted_profile\",\"profile\":\"" + profile
                + "\"}]";
    }

    @Test
    void compilesTheApprovalModeAndProfileForABoundSession() {
        AgentDefinitionCompiler.Compiled compiled =
                AgentDefinitionCompiler.compile(definition(
                        hostedProfile("hosted-workspace-files/1"),
                        "{\"approval_mode\":\"default\"}"), true, "yolo",
                        FILES_ONLY);
        assertThat(compiled.approvalMode()).isEqualTo("default");
        assertThat(compiled.toolProfile())
                .isEqualTo("hosted-workspace-files/1");
    }

    @Test
    void inheritsTheDeploymentApprovalModeFromAnEmptyPolicy() {
        AgentDefinitionCompiler.Compiled compiled =
                AgentDefinitionCompiler.compile(definition(
                        hostedProfile("hosted-workspace-files/1"), "{}"),
                        true, "auto-edit", FILES_ONLY);
        assertThat(compiled.approvalMode()).isEqualTo("auto-edit");
    }

    @Test
    void unboundSessionsCompileModelOnly() {
        AgentDefinitionCompiler.Compiled compiled =
                AgentDefinitionCompiler.compile(definition("[]",
                        "{\"approval_mode\":\"auto-edit\"}"), false, "yolo",
                        FILES_ONLY);
        assertThat(compiled.approvalMode()).isEqualTo("auto-edit");
        assertThat(compiled.toolProfile()).isNull();
    }

    @Test
    void aNonDefaultProfileJoinsThroughTheDeploymentAllowlist() {
        AgentDefinitionCompiler.Compiled compiled =
                AgentDefinitionCompiler.compile(definition(
                        hostedProfile("hosted-workspace-files/2"), "{}"),
                        true, "yolo", List.of("hosted-workspace-files/1",
                                "hosted-workspace-files/2"));
        assertThat(compiled.toolProfile())
                .isEqualTo("hosted-workspace-files/2");
    }

    @Test
    void shellProfilesNeverPairWithYolo() {
        List<String> allowlist = List.of("hosted-workspace-shell/1");
        assertThatThrownBy(() -> AgentDefinitionCompiler.compile(definition(
                hostedProfile("hosted-workspace-shell/1"), "{}"), true,
                "yolo", allowlist))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertThat(error.getDetails().get("field"))
                                .isEqualTo("tools"));
        AgentDefinitionCompiler.Compiled compiled =
                AgentDefinitionCompiler.compile(definition(
                        hostedProfile("hosted-workspace-shell/1"),
                        "{\"approval_mode\":\"default\"}"), true, "yolo",
                        allowlist);
        assertThat(compiled.toolProfile())
                .isEqualTo("hosted-workspace-shell/1");
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.CsvSource("""
            '{"model":{"id":"qwen3"},"instructions":"","tools":[],"permission_policy":{}}', model
            '{"model":{},"instructions":"Review.","tools":[],"permission_policy":{}}', instructions
            '{"model":{},"instructions":"","tools":[],"permission_policy":{"plan":true}}', permission_policy
            '{"model":{},"instructions":"","tools":[],"permission_policy":{"approval_timeout_ms":5000}}', permission_policy
            '{"model":{},"instructions":"","tools":[],"permission_policy":{"approval_mode":"plan"}}', permission_policy
            '{"model":{},"instructions":"","tools":[],"permission_policy":{"approval_mode":"default","extra":1}}', permission_policy
            '{"model":{},"instructions":"","tools":[],"permission_policy":{}, "skills":[{"name":"review"}]}', skills
            '{"model":{},"instructions":"","tools":[],"permission_policy":{}, "mcp_servers":[{"id":"fs"}]}', mcp_servers
            '{"model":{},"instructions":"","tools":[],"permission_policy":{}, "environment_template_id":"tpl"}', environment_template_id
            """)
    void refusesContentThatCannotTakeEffect(String json, String field) {
        assertThatThrownBy(() -> AgentDefinitionCompiler.compile(json, false,
                "yolo", FILES_ONLY))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus().value()).isEqualTo(409);
                    assertThat(error.getCode())
                            .isEqualTo("agent_definition_unsupported");
                    assertThat(error.getDetails().get("field"))
                            .isEqualTo(field);
                });
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.CsvSource("""
            '[{"type":"hosted_profile","profile":"hosted-workspace-files/2"}]'
            '[{"type":"hosted_profile","profile":"hosted-workspace-shell/1"}]'
            '[{"type":"tool","name":"read_file"}]'
            '[{"type":"hosted_profile"}]'
            '[{"type":"hosted_profile","profile":"hosted-workspace-files/1","extra":1}]'
            '[{"type":"hosted_profile","profile":"hosted-workspace-files/1"},{"type":"hosted_profile","profile":"hosted-workspace-files/1"}]'
            '[]'
            """)
    void boundSessionsRefuseAnythingButOneAllowlistedProfile(String tools) {
        assertThatThrownBy(() -> AgentDefinitionCompiler.compile(
                definition(tools, "{}"), true, "yolo", FILES_ONLY))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getDetails().get("field"))
                                .isEqualTo("tools"));
    }

    @Test
    void unboundSessionsRefuseAnyToolProfile() {
        assertThatThrownBy(() -> AgentDefinitionCompiler.compile(definition(
                hostedProfile("hosted-workspace-files/1"), "{}"), false,
                "yolo", FILES_ONLY))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getDetails().get("field"))
                                .isEqualTo("tools"));
    }

    @Test
    void metadataNeverAffectsExecution() {
        String json = "{\"model\":{},\"instructions\":\"\",\"tools\":[],"
                + "\"permission_policy\":{},"
                + "\"metadata\":{\"team\":\"review\",\"mode\":\"yolo\"}}";
        assertThat(AgentDefinitionCompiler.compile(json, false, "yolo",
                FILES_ONLY).approvalMode()).isEqualTo("yolo");
    }
}
