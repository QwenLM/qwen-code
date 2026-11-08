package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.McpOAuthRepository.Attempt;
import com.alibaba.qwen.code.managedagent.repository.McpOAuthRepository.Scope;
import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.security.SecretProtector;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class JdbcMcpOAuthRepositoryTest {
    private final ObjectMapper json = new ObjectMapper();
    private final Scope scope = new Scope("tenant", "workspace", "actor-a");
    private JdbcTemplate jdbc;
    private JdbcMcpOAuthRepository repository;

    @BeforeEach
    void setup() {
        var source =
                new DriverManagerDataSource(
                        "jdbc:h2:mem:oauth-"
                                + UUID.randomUUID()
                                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
                        "sa",
                        "");
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        jdbc.update(
                "INSERT INTO ma_workspace"
                    + " (tenant_id,workspace_id,workspace_generation,storage_id,display_name,config_ref,policy_ref,state)"
                    + " VALUES"
                    + " ('tenant','workspace',1,'storage','Workspace','config','policy','ACTIVE')");
        var beans = new DefaultListableBeanFactory();
        beans.registerSingleton("secrets", new AesGcmSecretProtector("key", new byte[32]));
        repository =
                new JdbcMcpOAuthRepository(
                        jdbc,
                        new DataSourceTransactionManager(source),
                        json,
                        beans.getBeanProvider(SecretProtector.class));
    }

    @Test
    void keepsAuthorizationPrivateAndSingleUseAcrossRepositoryRestart() {
        Attempt value = attempt();
        assertThat(repository.createAttempt(value).id()).isEqualTo(value.id());
        assertThat(repository.createAttempt(value).id()).isEqualTo(value.id());
        assertThatThrownBy(
                        () ->
                                repository.createAttempt(
                                        new Attempt(
                                                value.id(),
                                                scope,
                                                value.stateHash(),
                                                value.nonceHash(),
                                                "f".repeat(64),
                                                "pending",
                                                value.expiresAt(),
                                                value.binding(),
                                                value.secrets(),
                                                null)))
                .isInstanceOf(ManagedAgentException.class);
        assertThat(
                        jdbc.queryForObject(
                                "SELECT encrypted_values FROM ma_mcp_oauth_attempt", String.class))
                .doesNotContain("private-verifier");
        assertThatThrownBy(
                        () ->
                                repository.attempt(
                                        new Scope("tenant", "workspace", "actor-b"), value.id()))
                .isInstanceOfSatisfying(
                        ManagedAgentException.class,
                        error -> assertThat(error.getStatus()).isEqualTo(404));
        repository.receiveCode(
                value.stateHash(),
                "https://issuer.example",
                "secret-code",
                System.currentTimeMillis());
        assertThatThrownBy(
                        () ->
                                repository.receiveCode(
                                        value.stateHash(),
                                        null,
                                        "replayed",
                                        System.currentTimeMillis()))
                .isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(
                        () ->
                                repository.claimAttempt(
                                        scope, value.id(), "wrong", System.currentTimeMillis()))
                .isInstanceOf(ManagedAgentException.class);
        repository.claimAttempt(scope, value.id(), value.nonceHash(), System.currentTimeMillis());
        var grant =
                repository.completeAttempt(
                        scope,
                        value.id(),
                        tokens("access-a", "refresh-a"),
                        System.currentTimeMillis() + 3600_000,
                        System.currentTimeMillis());
        assertThat(grant.generation()).isEqualTo(1);
        assertThat(
                        repository
                                .completeAttempt(
                                        scope,
                                        value.id(),
                                        tokens("different", "different"),
                                        0,
                                        System.currentTimeMillis())
                                .id())
                .isEqualTo(grant.id());
        assertThat(
                        jdbc.queryForObject(
                                "SELECT encrypted_values FROM ma_mcp_credential", String.class))
                .doesNotContain("access-a", "refresh-a");
        assertThat(repository.credential(scope, grant.id()).secrets().path("access_token").asText())
                .isEqualTo("access-a");
        assertThat(repository.attempt(scope, value.id()).secrets().isEmpty()).isTrue();
    }

    @Test
    void refreshLeaseAndRevocationFenceLateProviderResponses() {
        Attempt attempt = attempt();
        repository.createAttempt(attempt);
        repository.receiveCode(attempt.stateHash(), null, "code", System.currentTimeMillis());
        repository.claimAttempt(
                scope, attempt.id(), attempt.nonceHash(), System.currentTimeMillis());
        var grant =
                repository.completeAttempt(
                        scope,
                        attempt.id(),
                        tokens("access", "refresh"),
                        System.currentTimeMillis() + 1000,
                        System.currentTimeMillis());
        repository.claimRefresh(
                scope,
                grant.id(),
                1,
                "lease-a",
                System.currentTimeMillis(),
                System.currentTimeMillis() + 30_000);
        assertThatThrownBy(
                        () ->
                                repository.claimRefresh(
                                        scope,
                                        grant.id(),
                                        1,
                                        "lease-b",
                                        System.currentTimeMillis(),
                                        System.currentTimeMillis() + 30_000))
                .isInstanceOf(ManagedAgentException.class);
        var revoked = repository.revoke(scope, grant.id(), 1);
        assertThat(revoked.generation()).isEqualTo(2);
        assertThat(revoked.state()).isEqualTo("revoked");
        assertThatThrownBy(
                        () ->
                                repository.completeRefresh(
                                        scope,
                                        grant.id(),
                                        1,
                                        "lease-a",
                                        tokens("late", "late"),
                                        System.currentTimeMillis() + 3600_000))
                .isInstanceOf(ManagedAgentException.class);
        assertThat(repository.credential(scope, grant.id()).secrets().isEmpty()).isTrue();
        assertThat(repository.revoke(scope, grant.id(), 1).generation()).isEqualTo(2);
    }

    @Test
    void executionPrincipalRejectsAnotherActorAndUnattendedAdmission() {
        jdbc.update(
                "INSERT INTO ma_session"
                    + " (tenant_id,session_id,agent_id,title,gmt_create,gmt_modified,personal_execution_actor_key,personal_auth_config_revision)"
                    + " VALUES ('tenant','session','agent','test',1,1,?,1)",
                DigestUtils.sha256Hex("actor-a"));
        ManagedMcpOAuthAdmission.requireActor(jdbc, "tenant", "session", "actor-a");
        assertThatThrownBy(
                        () ->
                                ManagedMcpOAuthAdmission.requireActor(
                                        jdbc, "tenant", "session", "actor-b"))
                .isInstanceOfSatisfying(
                        ManagedAgentException.class,
                        error -> assertThat(error.getStatus()).isEqualTo(403));
        assertThatThrownBy(
                        () ->
                                ManagedMcpOAuthAdmission.requireUnattendedAllowed(
                                        jdbc, "tenant", "session"))
                .isInstanceOf(ManagedAgentException.class);
        jdbc.update(
                "UPDATE ma_session SET personal_execution_actor_key=NULL WHERE tenant_id=? AND"
                    + " session_id=?",
                "tenant",
                "session");
        ManagedMcpOAuthAdmission.requireActor(jdbc, "tenant", "session", "actor-b");
    }

    @Test
    void aCodeExchangeStartedBeforeRevocationCannotCreateANewLiveGrant() {
        Attempt first = attempt();
        repository.createAttempt(first);
        repository.receiveCode(first.stateHash(), null, "code", System.currentTimeMillis());
        repository.claimAttempt(scope, first.id(), first.nonceHash(), System.currentTimeMillis());
        var grant =
                repository.completeAttempt(
                        scope,
                        first.id(),
                        tokens("access", "refresh"),
                        System.currentTimeMillis() + 3600_000,
                        System.currentTimeMillis());
        Attempt second = attempt();
        ((com.fasterxml.jackson.databind.node.ObjectNode) second.binding())
                .put("credentialEpoch", grant.generation());
        repository.createAttempt(second);
        repository.receiveCode(second.stateHash(), null, "late-code", System.currentTimeMillis());
        repository.claimAttempt(scope, second.id(), second.nonceHash(), System.currentTimeMillis());
        repository.revoke(scope, grant.id(), grant.generation());
        assertThatThrownBy(
                        () ->
                                repository.completeAttempt(
                                        scope,
                                        second.id(),
                                        tokens("late", "late"),
                                        System.currentTimeMillis() + 3600_000,
                                        System.currentTimeMillis()))
                .isInstanceOf(ManagedAgentException.class);
        assertThat(repository.credential(scope, grant.id()).state()).isEqualTo("revoked");
    }

    private Attempt attempt() {
        return new Attempt(
                "mauth_" + UUID.randomUUID(),
                scope,
                DigestUtils.sha256Hex(UUID.randomUUID().toString()),
                DigestUtils.sha256Hex("nonce"),
                "a".repeat(64),
                "pending",
                System.currentTimeMillis() + 600_000,
                json.createObjectNode()
                        .put("issuer", "https://issuer.example")
                        .put("serverId", "server"),
                json.createObjectNode()
                        .put("verifier", "private-verifier")
                        .put("state", "private-state"),
                null);
    }

    private com.fasterxml.jackson.databind.JsonNode tokens(String access, String refresh) {
        return json.createObjectNode()
                .put("access_token", access)
                .put("refresh_token", refresh)
                .put("expires_in", 3600)
                .put("token_type", "Bearer");
    }
}
