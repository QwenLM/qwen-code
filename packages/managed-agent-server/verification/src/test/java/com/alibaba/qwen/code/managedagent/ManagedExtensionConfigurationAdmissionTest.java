package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedConfigInstall;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.persistence.JdbcMcpOAuthRepository;
import com.alibaba.qwen.code.managedagent.persistence.ManagedMcpOAuthAdmission;
import com.alibaba.qwen.code.managedagent.persistence.ManagedMcpSettings;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.repository.McpOAuthRepository;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.security.SecretProtector;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.AopTestUtils;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.*;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-extension-admission;MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver", "spring.datasource.username=sa", "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
class ManagedExtensionConfigurationAdmissionTest {
    @Autowired private ManagedSessionStore store;
    @Autowired private AgentStateStore sessions;
    @Qualifier("managedJdbcTemplate")
    @Autowired private JdbcTemplate jdbc;
    @Autowired private ObjectMapper json;
    @Qualifier("managedAgentTransactionManager")
    @Autowired private PlatformTransactionManager transactionManager;

    @BeforeEach
    void enableOnlyTheStoreAdmissionBranch() {
        Object target = AopTestUtils.getUltimateTargetObject(sessions);
        com.alibaba.qwen.code.managedagent.VerificationFixtures.setAgentStoreField(target, "workspaceFilesEnabled", true);
    }

    @Test
    void liveChildBlocksBothOperatorSelectionAndConfigurationCommitButNotASiblingSession() throws Exception {
        String workspace = registerWorkspace();
        String parent = UUID.randomUUID().toString();
        String sibling = UUID.randomUUID().toString();
        var journal = publicJournal(parent, workspace);
        publicJournal(sibling, workspace);
        ObjectNode child = ManagedChildRunRecordContractTest.fixtures().required("templates").required("child_agent").deepCopy();
        child.put("childRunId", "live-child").put("rootSessionId", parent);
        byte[] inputBytes = "{}".getBytes(StandardCharsets.UTF_8);
        var input = new CommitResource("child-input", "managed-input", 1, inputBytes.length, DigestUtils.sha256Hex(inputBytes),
                Base64.getEncoder().encodeToString(inputBytes));
        child.putObject("inputRef").put("resourceId", input.resourceId()).put("kind", input.kind()).put("schemaVersion", input.schemaVersion())
                .put("byteLength", input.byteLength()).put("digest", input.digest());
        commitChild(journal, child, input, "admitted", 1_000);
        String operation = UUID.randomUUID().toString();
        ObjectNode content = ManagedConfigInstallContractTest.record(ManagedConfigInstallContractTest.content("nullable_preparing"), 1);
        assertBusy(() -> transaction(() -> sessions.requireExtensionManagement("tenant", "actor", parent, operation, true)));
        assertBusy(() -> transaction(() -> {
            sessions.requireConfigurationCommit("tenant", workspace, parent, content);
            return null;
        }));
        assertThatCode(() -> transaction(() -> sessions.requireExtensionManagement("tenant", "actor", sibling, operation, true))).doesNotThrowAnyException();
        assertThatCode(() -> transaction(() -> {
            sessions.requireConfigurationCommit("tenant", workspace, sibling, content);
            return null;
        })).doesNotThrowAnyException();
        child.put("stopRequested", true).put("stopReason", "stop_requested");
        ((ObjectNode) child.required("run")).put("state", "cancelled").put("execution", "not_started_proven");
        ((ObjectNode) child.path("run").required("delivery")).put("state", "cancelled");
        commitChild(journal, child, input, "cancelled", 1_001);
        assertThatCode(() -> transaction(() -> sessions.requireExtensionManagement("tenant", "actor", parent, operation, true))).doesNotThrowAnyException();
    }

    private void commitChild(ExtensionRecordJournal journal, ObjectNode child, CommitResource input, String phase, long occurredAt) {
        var request = journal.request("commitDomainRecord", "live-child:" + phase, ExtensionRecordJournal.bytes(child), occurredAt,
                event -> ((ObjectNode) event.path("payload")).put("operationId", "live-child"), records -> records,
                0, "child_run", List.of(input));
        journal.commit(request);
        journal.committed(request);
    }

    @Test
    void committedPhaseRequiresAtomicMatchingConfigBindingAndItsBarrierStaysSessionScoped() throws Exception {
        String workspace = registerWorkspace();
        String id = UUID.randomUUID().toString();
        String sibling = UUID.randomUUID().toString();
        var journal = publicJournal(id, workspace);
        publicJournal(sibling, workspace);
        ObjectNode preparing = phase("nullable_preparing", 1, null);
        commit(journal, id, workspace, preparing, false, false);
        ObjectNode prepared = phase("prepared", 2, preparing);
        commit(journal, id, workspace, prepared, false, false);
        ObjectNode committed = phase("prepared", 3, prepared).put("phase", "committed");
        assertThatThrownBy(() -> commit(journal, id, workspace, committed, false, false)).isInstanceOf(ManagedAgentException.class);
        assertThat(ManagedMcpSettings.find(jdbc, "tenant", id).path("phase").asText()).isEqualTo("prepared");
        assertThatThrownBy(() -> commit(journal, id, workspace, committed, true, true)).isInstanceOf(ManagedAgentException.class);
        assertThat(ManagedMcpSettings.find(jdbc, "tenant", id).path("phase").asText()).isEqualTo("prepared");
        commit(journal, id, workspace, committed, true, false);
        assertThat(transaction(() -> com.alibaba.qwen.code.managedagent.persistence.PersistenceTestAccess.blocked(jdbc, "tenant", id))).isTrue();
        assertThat(transaction(() -> com.alibaba.qwen.code.managedagent.persistence.PersistenceTestAccess.blocked(jdbc, "tenant", sibling))).isFalse();
        assertThatCode(() -> transaction(() -> sessions.requireExtensionManagement("tenant", "actor", sibling, UUID.randomUUID().toString(), true))).doesNotThrowAnyException();
        assertThatThrownBy(() -> transaction(() -> sessions.requireExtensionManagement("tenant", "actor", id, UUID.randomUUID().toString(), true)))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("session_config_recovery_required"));
    }

    @Test
    void packageConfigProjectionRetainsItsRecoveryResourceClosure() throws Exception {
        String workspace = registerWorkspace();
        String id = UUID.randomUUID().toString();
        var journal = publicJournal(id, workspace);
        byte[] partBytes = "{\"commands\":[]}".getBytes(StandardCharsets.UTF_8);
        var part = new CommitResource("part", "managed-extension-contributions-part", 1,
                partBytes.length, DigestUtils.sha256Hex(partBytes), Base64.getEncoder().encodeToString(partBytes));
        ObjectNode manifest = json.createObjectNode().put("kind", "managed-extension-contributions")
                .put("formatVersion", 1).put("byteLength", partBytes.length).put("digest", part.digest());
        manifest.putArray("parts").addObject().put("resourceId", part.resourceId()).put("kind", part.kind())
                .put("schemaVersion", 1).put("byteLength", part.byteLength()).put("digest", part.digest());
        byte[] manifestBytes = ExtensionRecordJournal.bytes(manifest);
        var contributions = new CommitResource("contributions", "managed-extension-contributions", 1,
                manifestBytes.length, DigestUtils.sha256Hex(manifestBytes), Base64.getEncoder().encodeToString(manifestBytes));
        ObjectNode bundle = json.createObjectNode();
        bundle.putArray("packages").addObject().putObject("contributionsRef")
                .put("resourceId", contributions.resourceId()).put("kind", contributions.kind())
                .put("schemaVersion", 1).put("byteLength", contributions.byteLength()).put("digest", contributions.digest());
        byte[] bundleBytes = ExtensionRecordJournal.bytes(bundle);
        var bundleResource = new CommitResource("bundle", "managed-extension-config-bundle", 1,
                bundleBytes.length, DigestUtils.sha256Hex(bundleBytes), Base64.getEncoder().encodeToString(bundleBytes));
        ObjectNode bundleRef = json.createObjectNode().put("resourceId", bundleResource.resourceId())
                .put("kind", bundleResource.kind()).put("schemaVersion", 1)
                .put("byteLength", bundleResource.byteLength()).put("digest", bundleResource.digest());
        ObjectNode inheritedRef = json.createObjectNode().put("resourceId", "inherited-baseline")
                .put("kind", "managed-extension-config-bundle").put("schemaVersion", 1)
                .put("byteLength", 2).put("digest", DigestUtils.sha256Hex("{}"));
        List<CommitResource> resources = new ArrayList<>(resources());
        resources.removeIf(resource -> resource.resourceId().equals("bundle"));
        resources.addAll(List.of(bundleResource, contributions, part));
        ObjectNode preparing = phase("nullable_preparing", 1, null).set("previousBundleRef", inheritedRef);
        commit(journal, id, workspace, preparing, false, false, resources);
        ObjectNode prepared = (ObjectNode) phase("prepared", 2, preparing).set("bundleRef", bundleRef);
        prepared.set("previousBundleRef", inheritedRef);
        commit(journal, id, workspace, prepared, false, false, resources);
        ObjectNode committed = (ObjectNode) phase("prepared", 3, prepared).put("phase", "committed")
                .set("bundleRef", bundleRef);
        committed.set("previousBundleRef", inheritedRef);
        commit(journal, id, workspace, committed, true, false, resources);
        ObjectNode active = (ObjectNode) phase("active", 4, committed).set("bundleRef", bundleRef);
        active.set("previousBundleRef", inheritedRef);
        commit(journal, id, workspace, active, false, false, resources);

        assertThat(jdbc.queryForList("SELECT resource_id FROM ma_resource_ref"
                        + " WHERE owner_kind='SESSION_RECORD'", String.class))
                .contains(bundleResource.resourceId(), contributions.resourceId(), part.resourceId(),
                        ExtensionRecordJournal.resourceId(ExtensionRecordJournal.bytes(preparing)),
                        ExtensionRecordJournal.resourceId(ExtensionRecordJournal.bytes(prepared)),
                        ExtensionRecordJournal.resourceId(ExtensionRecordJournal.bytes(committed)));
    }

    @Test
    void packageConfigProjectionGrowsByDeltaWithoutRewritingRetainedRows() throws Exception {
        String workspace = registerWorkspace();
        String id = UUID.randomUUID().toString();
        var journal = publicJournal(id, workspace);
        byte[] partBytes = "{\"commands\":[]}".getBytes(StandardCharsets.UTF_8);
        var part = new CommitResource("part", "managed-extension-contributions-part", 1,
                partBytes.length, DigestUtils.sha256Hex(partBytes), Base64.getEncoder().encodeToString(partBytes));
        ObjectNode manifest = json.createObjectNode().put("kind", "managed-extension-contributions")
                .put("formatVersion", 1).put("byteLength", partBytes.length).put("digest", part.digest());
        manifest.putArray("parts").addObject().put("resourceId", part.resourceId()).put("kind", part.kind())
                .put("schemaVersion", 1).put("byteLength", part.byteLength()).put("digest", part.digest());
        byte[] manifestBytes = ExtensionRecordJournal.bytes(manifest);
        var contributions = new CommitResource("contributions", "managed-extension-contributions", 1,
                manifestBytes.length, DigestUtils.sha256Hex(manifestBytes), Base64.getEncoder().encodeToString(manifestBytes));
        ObjectNode bundle = json.createObjectNode();
        bundle.putArray("packages").addObject().putObject("contributionsRef")
                .put("resourceId", contributions.resourceId()).put("kind", contributions.kind())
                .put("schemaVersion", 1).put("byteLength", contributions.byteLength()).put("digest", contributions.digest());
        byte[] bundleBytes = ExtensionRecordJournal.bytes(bundle);
        var bundleResource = new CommitResource("bundle", "managed-extension-config-bundle", 1,
                bundleBytes.length, DigestUtils.sha256Hex(bundleBytes), Base64.getEncoder().encodeToString(bundleBytes));
        ObjectNode bundleRef = json.createObjectNode().put("resourceId", bundleResource.resourceId())
                .put("kind", bundleResource.kind()).put("schemaVersion", 1)
                .put("byteLength", bundleResource.byteLength()).put("digest", bundleResource.digest());
        ObjectNode inheritedRef = json.createObjectNode().put("resourceId", "inherited-baseline")
                .put("kind", "managed-extension-config-bundle").put("schemaVersion", 1)
                .put("byteLength", 2).put("digest", DigestUtils.sha256Hex("{}"));
        List<CommitResource> resources = new ArrayList<>(resources());
        resources.removeIf(resource -> resource.resourceId().equals("bundle"));
        resources.addAll(List.of(bundleResource, contributions, part));
        ObjectNode preparing = phase("nullable_preparing", 1, null).set("previousBundleRef", inheritedRef);
        commit(journal, id, workspace, preparing, false, false, resources);

        byte[] session = id.getBytes(StandardCharsets.UTF_8);
        long sentinel = 12345L;
        int firstCount = jdbc.update("UPDATE ma_resource_ref SET gmt_create = ?"
                + " WHERE owner_kind='SESSION_RECORD' AND session_id = ?", sentinel, session);
        assertThat(firstCount).isPositive();
        List<String> firstIds = jdbc.queryForList("SELECT resource_id FROM ma_resource_ref"
                + " WHERE owner_kind='SESSION_RECORD' AND session_id = ?", String.class, session);

        ObjectNode prepared = (ObjectNode) phase("prepared", 2, preparing).set("bundleRef", bundleRef);
        prepared.set("previousBundleRef", inheritedRef);
        commit(journal, id, workspace, prepared, false, false, resources);

        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref"
                        + " WHERE owner_kind='SESSION_RECORD' AND session_id = ? AND gmt_create = ?",
                        Integer.class, session, sentinel)).isEqualTo(firstCount);
        List<String> secondIds = jdbc.queryForList("SELECT resource_id FROM ma_resource_ref"
                + " WHERE owner_kind='SESSION_RECORD' AND session_id = ?", String.class, session);
        assertThat(secondIds).containsAll(firstIds)
                .contains(bundleResource.resourceId(), contributions.resourceId(), part.resourceId());
        assertThat(secondIds.size()).isGreaterThan(firstIds.size());
        // R2-8 / R2-5: the retained seed must keep every recovery resource
        // projected exactly once across revisions. If the dedupe is lost, the
        // prepared commit re-projects a resource the preparing commit already
        // retained and its id appears a second time — projection growth would
        // then track the revision count instead of the delta.
        assertThat(secondIds).doesNotHaveDuplicates();
    }

    @Test
    void revokedCommittedGrantCanRecordRecoveryAndRestoreEmptyWithoutAdmittingANewRevokedBinding() throws Exception {
        String workspace = registerWorkspace();
        String id = UUID.randomUUID().toString();
        var journal = publicJournal(id, workspace);
        var beans = new DefaultListableBeanFactory();
        beans.registerSingleton("secrets", new AesGcmSecretProtector("test", new byte[32]));
        var grants = new JdbcMcpOAuthRepository(jdbc, transactionManager, json, beans.getBeanProvider(SecretProtector.class));
        var scope = new McpOAuthRepository.Scope("tenant", workspace, "actor");
        String attemptId = "mauth_" + UUID.randomUUID();
        String stateHash = DigestUtils.sha256Hex(attemptId);
        String nonceHash = DigestUtils.sha256Hex("nonce");
        grants.createAttempt(new McpOAuthRepository.Attempt(attemptId, scope, stateHash, nonceHash, DigestUtils.sha256Hex("request"), "pending",
                System.currentTimeMillis() + 60_000, json.createObjectNode().put("serverId", "ext_fixture:server")
                        .put("providerId", "test").put("resourceUri", "https://mcp.example/mcp").put("credentialEpoch", 0),
                json.createObjectNode().put("verifier", "private"), null));
        grants.receiveCode(stateHash, null, "code", System.currentTimeMillis());
        grants.claimAttempt(scope, attemptId, nonceHash, System.currentTimeMillis());
        var grant = grants.completeAttempt(scope, attemptId, json.createObjectNode().put("access_token", "private"),
                System.currentTimeMillis() + 3600_000, System.currentTimeMillis());
        ObjectNode bindings = json.createObjectNode();
        bindings.putArray("values").addObject().put("serverId", "ext_fixture:server")
                .put("credentialId", grant.id()).put("credentialGeneration", grant.generation());
        var auth = bindings.get("values");
        var empty = json.createArrayNode();
        CommitResource baseline = bundle("baseline-empty", 1, empty);
        CommitResource personal = bundle("personal", 2, auth);
        CommitResource altered = bundle("altered-personal", 2, auth);
        CommitResource restored = bundle("restored-empty", 3, empty);
        CommitResource rejected = bundle("new-revoked-binding", 4, auth);
        List<CommitResource> closure = new ArrayList<>(resources());
        closure.addAll(List.of(baseline, personal, altered, restored, rejected));
        ObjectNode initialCommand = command(0, empty);
        ObjectNode current = null;
        for (String phase : List.of("preparing", "prepared", "committed", "active")) {
            current = configurationPhase(phase, current, initialCommand, 1, null, null, baseline);
            commit(journal, id, workspace, current, "committed".equals(phase), false, closure);
        }
        ObjectNode personalCommand = command(1, auth);
        for (String phase : List.of("preparing", "prepared", "committed")) {
            current = configurationPhase(phase, current, personalCommand, 2, baseline, null, personal);
            commit(journal, id, workspace, current, "committed".equals(phase), false, closure);
        }
        grants.revoke(scope, grant.id(), grant.generation());
        assertThat(grants.credential(scope, grant.id()).state()).isEqualTo("revoked");
        ObjectNode committed = current;
        ObjectNode active = configurationPhase("active", committed, personalCommand, 2, baseline, null, personal);
        assertThatCode(() -> transaction(() -> {
            sessions.requireConfigurationCommit("tenant", workspace, id, active);
            return null;
        })).doesNotThrowAnyException();
        ObjectNode recovery = configurationPhase("recovery_required", committed, personalCommand, 2, baseline, null, personal);
        ObjectNode changedBundle = recovery.deepCopy();
        changedBundle.set("bundleRef", reference(altered));
        assertThatThrownBy(() -> commit(journal, id, workspace, changedBundle, false, false, closure))
                .isInstanceOf(ManagedAgentException.class);
        ObjectNode changedOperation = recovery.deepCopy();
        String other = UUID.randomUUID().toString();
        changedOperation.put("operationId", other).put("phaseOperationId", other);
        ((ObjectNode) changedOperation.get("command")).put("operationId", other);
        assertThatThrownBy(() -> commit(journal, id, workspace, changedOperation, false, false, closure))
                .isInstanceOf(ManagedAgentException.class);
        commit(journal, id, workspace, recovery, false, false, closure);
        assertThat(ManagedMcpSettings.find(jdbc, "tenant", id).path("phase").asText()).isEqualTo("recovery_required");
        assertThat(grants.credential(scope, grant.id()).state()).isEqualTo("revoked");
        assertThat(ManagedMcpOAuthAdmission.actor(jdbc, "tenant", id)).isEqualTo(DigestUtils.sha256Hex("actor"));
        assertThat(sessions.supportsPersonalMcpExecution()).isTrue();
        sessions.requirePersonalMcpActor("tenant", id, "actor");
        assertThatThrownBy(() -> sessions.requirePersonalMcpActor("tenant", id, "other"))
                .isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> sessions.requirePersonalMcpUnattended("tenant", id))
                .isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> ManagedMcpOAuthAdmission.requireActor(jdbc, "tenant", id, "other"))
                .isInstanceOf(ManagedAgentException.class);
        current = recovery;
        for (String phase : List.of("preparing", "prepared", "committed", "active")) {
            current = configurationPhase(phase, current, personalCommand, 3, personal, baseline, restored);
            commit(journal, id, workspace, current, "committed".equals(phase), false, closure);
        }
        assertThat(ManagedMcpSettings.find(jdbc, "tenant", id).path("configRevision").asLong()).isEqualTo(3);
        assertThat(ManagedMcpSettings.find(jdbc, "tenant", id).path("phase").asText()).isEqualTo("active");
        assertThat(ManagedMcpOAuthAdmission.actor(jdbc, "tenant", id)).isNull();
        ManagedMcpOAuthAdmission.requireActor(jdbc, "tenant", id, "other");
        ObjectNode newCommand = command(3, auth);
        for (String phase : List.of("preparing", "prepared")) {
            current = configurationPhase(phase, current, newCommand, 4, restored, null, rejected);
            commit(journal, id, workspace, current, false, false, closure);
        }
        ObjectNode newCommit = configurationPhase("committed", current, newCommand, 4, restored, null, rejected);
        assertThatThrownBy(() -> commit(journal, id, workspace, newCommit, true, false, closure))
                .isInstanceOf(ManagedAgentException.class);
        assertThat(ManagedMcpSettings.find(jdbc, "tenant", id).path("phase").asText()).isEqualTo("prepared");
        assertThat(ManagedMcpOAuthAdmission.actor(jdbc, "tenant", id)).isNull();
    }

    @Test
    void restoresThePersonalOwnerAfterAnotherOperatorFailsToRemoveTheBinding() throws Exception {
        String workspace = registerWorkspace();
        String id = UUID.randomUUID().toString();
        var journal = publicJournal(id, workspace);
        var beans = new DefaultListableBeanFactory();
        beans.registerSingleton("secrets", new AesGcmSecretProtector("test", new byte[32]));
        var grants = new JdbcMcpOAuthRepository(jdbc, transactionManager, json, beans.getBeanProvider(SecretProtector.class));
        var scope = new McpOAuthRepository.Scope("tenant", workspace, "actor");
        String attemptId = "mauth_" + UUID.randomUUID();
        String state = DigestUtils.sha256Hex(attemptId);
        String nonce = DigestUtils.sha256Hex("nonce");
        grants.createAttempt(new McpOAuthRepository.Attempt(attemptId, scope, state, nonce, DigestUtils.sha256Hex("request"), "pending",
                System.currentTimeMillis() + 120_000, json.createObjectNode().put("serverId", "ext_fixture:server")
                        .put("providerId", "test").put("resourceUri", "https://mcp.example/mcp").put("credentialEpoch", 0),
                json.createObjectNode().put("verifier", "private"), null));
        grants.receiveCode(state, null, "code", System.currentTimeMillis());
        grants.claimAttempt(scope, attemptId, nonce, System.currentTimeMillis());
        var grant = grants.completeAttempt(scope, attemptId, json.createObjectNode().put("access_token", "private"),
                System.currentTimeMillis() + 3600_000, System.currentTimeMillis());
        var auth = json.createArrayNode();
        auth.addObject().put("serverId", "ext_fixture:server").put("credentialId", grant.id())
                .put("credentialGeneration", grant.generation());
        var empty = json.createArrayNode();
        CommitResource personal = bundle("owner-active", 1, auth);
        CommitResource removal = bundle("owner-removed", 2, empty);
        CommitResource restored = bundle("owner-restored", 3, auth);
        CommitResource borrowed = bundle("owner-borrow-attempt", 2, auth);
        CommitResource forged = bundle("owner-forged-restore", 4, auth);
        List<CommitResource> closure = new ArrayList<>(resources());
        closure.addAll(List.of(personal, removal, restored, borrowed, forged));
        ObjectNode current = null;
        ObjectNode initial = command(0, auth);
        for (String phase : List.of("preparing", "prepared", "committed", "active")) {
            current = configurationPhase(phase, current, initial, 1, null, null, personal);
            commit(journal, id, workspace, current, "committed".equals(phase), false, closure);
        }
        ObjectNode remove = command(1, empty).put("actorKey", DigestUtils.sha256Hex("other-operator"));
        ObjectNode borrowing = configurationPhase("committed", current, remove, 2, personal, null, borrowed);
        assertThatThrownBy(() -> transaction(() -> {
            ManagedMcpOAuthAdmission.commit(jdbc, "tenant", id, borrowing);
            return null;
        })).isInstanceOf(ManagedAgentException.class);
        for (String phase : List.of("preparing", "prepared", "committed", "recovery_required")) {
            current = configurationPhase(phase, current, remove, 2, personal, null, removal);
            commit(journal, id, workspace, current, "committed".equals(phase), false, closure);
        }
        for (String phase : List.of("preparing", "prepared", "committed", "active")) {
            current = configurationPhase(phase, current, remove, 3, removal, personal, restored);
            commit(journal, id, workspace, current, "committed".equals(phase), false, closure);
        }
        JsonNode active = ManagedMcpSettings.find(jdbc, "tenant", id);
        assertThat(active.path("phase").asText()).isEqualTo("active");
        assertThat(active.path("command").path("actorKey").asText()).isEqualTo(DigestUtils.sha256Hex("other-operator"));
        assertThat(ManagedMcpOAuthAdmission.actor(jdbc, "tenant", id)).isEqualTo(DigestUtils.sha256Hex("actor"));
        ObjectNode wrongBaseline = configurationPhase("committed", current, remove, 4, restored, personal, forged);
        assertThatThrownBy(() -> transaction(() -> {
            ManagedMcpOAuthAdmission.commit(jdbc, "tenant", id, wrongBaseline);
            return null;
        })).isInstanceOf(ManagedAgentException.class);
        assertThat(ManagedMcpOAuthAdmission.actor(jdbc, "tenant", id)).isEqualTo(DigestUtils.sha256Hex("actor"));
    }

    private ObjectNode command(long revision, JsonNode bindings) {
        ObjectNode command = json.createObjectNode().put("operationId", UUID.randomUUID().toString())
                .put("actorKey", DigestUtils.sha256Hex("actor")).put("expectedRevision", revision).put("selectionVersion", 2);
        command.putArray("extensions");
        command.set("mcpAuthBindings", bindings.deepCopy());
        return command;
    }

    private CommitResource bundle(String id, long revision, JsonNode bindings) {
        ObjectNode body = json.createObjectNode().put("kind", "managed-extension-config-bundle")
                .put("formatVersion", 2).put("configRevision", revision);
        body.set("mcpAuthBindings", bindings.deepCopy());
        body.set("executionActorKey", bindings.isEmpty() ? json.nullNode() : json.getNodeFactory().textNode(DigestUtils.sha256Hex("actor")));
        byte[] bytes = ExtensionRecordJournal.bytes(body);
        return new CommitResource(id, "managed-extension-config-bundle", 1, bytes.length, DigestUtils.sha256Hex(bytes), Base64.getEncoder().encodeToString(bytes));
    }

    private ObjectNode reference(CommitResource resource) {
        return json.createObjectNode().put("resourceId", resource.resourceId()).put("kind", resource.kind())
                .put("schemaVersion", resource.schemaVersion()).put("byteLength", resource.byteLength()).put("digest", resource.digest());
    }

    private ObjectNode configurationPhase(String phase, JsonNode previous, JsonNode command, long revision,
            CommitResource previousBundle, CommitResource restores, CommitResource bundle) throws Exception {
        ObjectNode body = phase("active".equals(phase) ? "active" : "preparing".equals(phase) ? "nullable_preparing" : "prepared",
                previous == null ? 1 : previous.path("revision").asLong() + 1, previous);
        String operation = command.path("operationId").asText();
        body.put("phase", phase).put("configRevision", revision).put("previousConfigRevision", revision - 1)
                .put("operationId", operation).put("mode", restores == null ? "apply" : "recoverPrevious")
                .put("phaseOperationId", restores == null ? operation : ManagedConfigInstall.derivedOperationId("managed-extension-recoverPrevious:", operation));
        body.set("command", command.deepCopy());
        body.set("bundleRef", reference(bundle));
        body.set("previousBundleRef", previousBundle == null ? json.nullNode() : reference(previousBundle));
        body.set("restoresBundleRef", restores == null ? json.nullNode() : reference(restores));
        if ("recovery_required".equals(phase)) {
            body.putObject("error").put("code", "mcp_authorization_required");
        }
        return (ObjectNode) json.readTree(ExtensionRecordJournal.bytes(body));
    }

    private void commit(ExtensionRecordJournal journal, String id, String workspace, ObjectNode body,
            boolean binding, boolean mismatch) {
        commit(journal, id, workspace, body, binding, mismatch, resources());
    }

    private void commit(ExtensionRecordJournal journal, String id, String workspace, ObjectNode body,
            boolean binding, boolean mismatch, List<CommitResource> resources) {
        String operation = body.path("operationId").asText();
        var request = journal.request("commitDomainRecord", operation + ":phase:" + body.path("revision").asLong(), ExtensionRecordJournal.bytes(body), 1000,
                event -> ((ObjectNode) event.path("payload")).put("operationId", operation), records -> {
                    if (!binding) {
                        return records;
                    }
                    ObjectNode event = json.createObjectNode().put("v", 1).put("sequence", journal.committedSequence() + 2)
                            .put("eventId", "config-bound:" + body.path("revision").asLong()).put("kind", "config.bound").put("occurredAt", 1000);
                    event.putObject("sessionKey").put("tenantId", "tenant").put("workspaceId", workspace).put("sessionId", id);
                    ObjectNode payload = event.putObject("payload").put("revision", mismatch ? 99 : body.path("configRevision").asLong());
                    if (body.path("previousConfigRevision").asLong() == 0) {
                        payload.putNull("previousRevision");
                    } else {
                        payload.put("previousRevision", body.path("previousConfigRevision").asLong());
                    }
                    payload.set("bundleRef", body.get("bundleRef"));
                    payload.set("rootSnapshotRef", body.get("rootSnapshotRef"));
                    int cut = records.indexOf('\n') + 1;
                    return records.substring(0, cut) + ExtensionRecordJournal.line(id, "managed_session_event_v1", event) + records.substring(cut);
                }, binding ? 1 : 0, "config_install", resources);
        journal.commit(request);
        journal.committed(request);
    }

    private ObjectNode phase(String name, long revision, JsonNode previous) throws Exception {
        ObjectNode body = ManagedConfigInstallContractTest.record(ManagedConfigInstallContractTest.content(name), revision);
        if (previous != null) {
            byte[] bytes = ExtensionRecordJournal.bytes(previous);
            body.putObject("previousRecordRef").put("resourceId", ExtensionRecordJournal.resourceId(bytes)).put("kind", "managed-config_install")
                    .put("schemaVersion", 1).put("byteLength", bytes.length).put("digest", DigestUtils.sha256Hex(bytes));
        }
        for (String field : List.of("rootSnapshotRef", "bundleRef")) {
            if (!body.path(field).isNull()) {
                ((ObjectNode) body.path(field)).put("digest", DigestUtils.sha256Hex("{}"));
                if ("bundleRef".equals(field)) {
                    body.set(field, reference(bundle("bundle", 1, json.createArrayNode())));
                }
            }
        }
        for (String field : List.of("stageAckRefs", "enableAckRefs")) {
            for (JsonNode ref : body.path(field)) {
                ((ObjectNode) ref).put("digest", DigestUtils.sha256Hex("{}"));
            }
        }
        return body;
    }

    private List<CommitResource> resources() {
        List<CommitResource> resources = new ArrayList<>();
        for (String id : List.of("root", "bundle", "hstage", "rstage", "henable", "renable")) {
            if ("bundle".equals(id)) {
                resources.add(bundle(id, 1, json.createArrayNode()));
            } else {
                resources.add(new CommitResource(id, "managed-test", 1, 2, DigestUtils.sha256Hex("{}"), Base64.getEncoder().encodeToString("{}".getBytes(StandardCharsets.UTF_8))));
            }
        }
        return resources;
    }

    private String registerWorkspace() {
        String workspace = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id, display_name, config_ref, policy_ref, state)"
                        + " VALUES ('tenant', ?, 1, 'storage', ?, ?, ?, 'ACTIVE')", workspace, workspace, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES ('tenant', ?, ?, 'OPERATOR')", workspace, "actor".getBytes(StandardCharsets.UTF_8));
        return workspace;
    }

    private ExtensionRecordJournal publicJournal(String id, String workspace) {
        var journal = new ExtensionRecordJournal(store, "tenant", workspace, id).open();
        jdbc.update("UPDATE ma_session SET session_kind='PUBLIC', agent_id='qwen-code', workspace_id=?, workspace_generation=1, workspace_storage_id='storage',"
                + " cwd_relative='.', context_config_ref=?, context_revision=1, workspace_config_ref=?, workspace_policy_ref=?, creator_actor_key=?,"
                + " tool_profile='hosted-workspace-shell/1' WHERE tenant_id=? AND session_id=?", workspace, WorkspaceExecutionProfile.CONTEXT_CONFIG_REF,
                WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF, "actor".getBytes(StandardCharsets.UTF_8),
                "tenant".getBytes(StandardCharsets.UTF_8), id.getBytes(StandardCharsets.UTF_8));
        return journal;
    }

    private <T> T transaction(java.util.function.Supplier<T> work) { return new TransactionTemplate(transactionManager).execute(status -> work.get()); }
    private void assertBusy(org.assertj.core.api.ThrowableAssert.ThrowingCallable work) {
        assertThatThrownBy(work).isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("session_context_busy"));
    }
}
