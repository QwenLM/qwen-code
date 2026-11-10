package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.QueuedRequest;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.Registration;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.persistence.ClientFilesRelayStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ClientFilesRelayServiceTest {
    private static final String ACTOR = "operator";
    private JdbcTemplate jdbc;
    private ClientFilesRelayStore store;
    private ManagedAgentProperties properties;
    private ManagedAgentService agentService;
    private ManagedWorkspaceRegistry workspaces;
    private ClientFilesRelayService service;
    private String tenant;
    private final String session = "session";

    @BeforeEach
    void setup() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:client-files-service-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1;LOCK_TIMEOUT=10000");
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        store = new ClientFilesRelayStore(jdbc);
        properties = new ManagedAgentProperties();
        properties.getClientFiles().setEnabled(true);
        properties.getClientFiles().setRequestTtl(Duration.ofMillis(300));
        agentService = mock(ManagedAgentService.class);
        workspaces = mock(ManagedWorkspaceRegistry.class);
        when(agentService.requireReadableSession(anyString(), anyString(), anyString()))
                .thenAnswer(invocation -> session(invocation.getArgument(0), invocation.getArgument(2)));
        when(workspaces.accessOf(anyString(), anyString(), anyString())).thenReturn(WorkspaceAccess.OPERATOR);
        service = new ClientFilesRelayService(store, agentService, workspaces, properties, new ObjectMapper());
        tenant = "tenant-" + UUID.randomUUID();
    }

    @Test
    void registerIssuesOneTimeCredentialAndPersistsOnlyItsDigest() {
        Registration registration = service.register(tenant, ACTOR, session);
        assertThat(registration.serverId()).isEqualTo("local-files");
        assertThat(registration.generation()).isEqualTo(1L);
        assertThat(registration.token()).isNotBlank();
        assertThat(jdbc.queryForObject("SELECT token_hash FROM ma_client_files_binding", String.class))
                .isEqualTo(DigestUtils.sha256Hex(registration.token()));
        assertThat(service.status(tenant, ACTOR, session).state()).isEqualTo("active");
    }

    @Test
    void registerRefusedWhileDisabled() {
        properties.getClientFiles().setEnabled(false);
        assertThatThrownBy(() -> service.register(tenant, ACTOR, session))
                .hasFieldOrPropertyWithValue("code", "client_files_disabled");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_client_files_binding", Integer.class)).isZero();
    }

    @Test
    void registerRefusedBelowExecutionAuthority() {
        when(workspaces.accessOf(anyString(), anyString(), anyString())).thenReturn(WorkspaceAccess.READER);
        assertThatThrownBy(() -> service.register(tenant, ACTOR, session))
                .hasFieldOrPropertyWithValue("code", "client_files_execution_forbidden");
    }

    @Test
    void reRegisterAdvancesGenerationAndFailsTheOldQueue() throws Exception {
        Registration first = service.register(tenant, ACTOR, session);
        mcpInBackground(first.token(), request("1"));
        awaitQueue(first.generation(), 1);
        Registration second = service.register(tenant, ACTOR, session);
        assertThat(second.generation()).isEqualTo(2L);
        assertThat(jdbc.queryForObject("SELECT state FROM ma_client_files_request WHERE request_id='1'",
                String.class)).isEqualTo("failed");
        assertThat(jdbc.queryForObject("SELECT error_code FROM ma_client_files_request WHERE request_id='1'",
                String.class)).isEqualTo("client_files_offline");
    }

    @Test
    void mcpRefusesWrongOrMissingCredential() {
        service.register(tenant, ACTOR, session);
        assertThatThrownBy(() -> service.mcp(tenant, session, "wrong", request("1")))
                .hasFieldOrPropertyWithValue("code", "client_files_credential_invalid");
        assertThatThrownBy(() -> service.mcp(tenant, session, null, request("1")))
                .hasFieldOrPropertyWithValue("code", "client_files_credential_invalid");
    }

    @Test
    void mcpRoundTripsThroughTheBrowserQueue() throws Exception {
        Registration registration = service.register(tenant, ACTOR, session);
        CompletableFuture<String> call = CompletableFuture.supplyAsync(() ->
                service.mcp(tenant, session, registration.token(), request("7")));
        List<QueuedRequest> drained = awaitQueue(registration.generation(), 1);
        assertThat(drained.get(0).requestId()).isEqualTo("7");
        service.respond(tenant, ACTOR, session, registration.generation(), "7",
                "{\"jsonrpc\":\"2.0\",\"id\":\"7\",\"result\":{\"tools\":[]}}", null);
        assertThat(call.get(5, TimeUnit.SECONDS)).contains("\"tools\":[]");
    }

    @Test
    void mcpExpiresToTheStructuredOfflineError() {
        Registration registration = service.register(tenant, ACTOR, session);
        String answer = service.mcp(tenant, session, registration.token(), request("9"));
        assertThat(answer).contains("client_files_offline").contains("\"id\":\"9\"");
    }

    @Test
    void mcpNotificationIsFireAndForget() {
        Registration registration = service.register(tenant, ACTOR, session);
        assertThat(service.mcp(tenant, session, registration.token(),
                "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}")).isNull();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_client_files_request", Integer.class)).isEqualTo(1);
    }

    @Test
    void respondValidatesShapeOwnershipAndGeneration() {
        Registration registration = service.register(tenant, ACTOR, session);
        long generation = registration.generation();
        assertThatThrownBy(() -> service.respond(tenant, ACTOR, session, generation, "1", "{}", "boom"))
                .hasFieldOrPropertyWithValue("code", "client_files_invalid");
        assertThatThrownBy(() -> service.respond(tenant, ACTOR, session, generation, "1", null, null))
                .hasFieldOrPropertyWithValue("code", "client_files_invalid");
        assertThatThrownBy(() -> service.respond(tenant, ACTOR, session, generation, "missing", "{}", null))
                .hasFieldOrPropertyWithValue("code", "client_files_request_not_found");
        assertThatThrownBy(() -> service.respond(tenant, "other-actor", session, generation, "1", "{}", null))
                .hasFieldOrPropertyWithValue("code", "client_files_not_found");
        assertThatThrownBy(() -> service.respond(tenant, ACTOR, session, generation + 1, "1", "{}", null))
                .hasFieldOrPropertyWithValue("code", "client_files_generation_conflict");
    }

    @Test
    void unregisterClosesTheBindingAndFailsQueuedRequests() throws Exception {
        Registration registration = service.register(tenant, ACTOR, session);
        mcpInBackground(registration.token(), request("1"));
        awaitQueue(registration.generation(), 1);
        assertThat(service.unregister(tenant, ACTOR, session).state()).isEqualTo("closed");
        assertThat(jdbc.queryForObject("SELECT state FROM ma_client_files_request WHERE request_id='1'",
                String.class)).isEqualTo("failed");
        assertThatThrownBy(() -> service.mcp(tenant, session, registration.token(), request("2")))
                .hasFieldOrPropertyWithValue("code", "client_files_credential_invalid");
    }

    @Test
    void oversizePayloadIsRefused() {
        Registration registration = service.register(tenant, ACTOR, session);
        String body = "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"tools/call\",\"params\":\""
                + "x".repeat(properties.getClientFiles().getMaxPayloadBytes()) + "\"}";
        assertThatThrownBy(() -> service.mcp(tenant, session, registration.token(), body))
                .hasFieldOrPropertyWithValue("code", "client_files_payload_too_large");
    }

    @Test
    void queueDepthIsBounded() throws Exception {
        properties.getClientFiles().setQueueDepth(1);
        Registration registration = service.register(tenant, ACTOR, session);
        mcpInBackground(registration.token(), request("1"));
        awaitQueue(registration.generation(), 1);
        assertThatThrownBy(() -> service.mcp(tenant, session, registration.token(), request("2")))
                .hasFieldOrPropertyWithValue("code", "client_files_queue_full");
    }

    private void mcpInBackground(String token, String body) {
        CompletableFuture.runAsync(() -> service.mcp(tenant, session, token, body));
    }

    private List<QueuedRequest> awaitQueue(long generation, int expected) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 5_000;
        while (System.currentTimeMillis() < deadline) {
            List<QueuedRequest> rows = service.requests(tenant, ACTOR, session, generation);
            if (rows.size() >= expected) {
                return rows;
            }
            Thread.sleep(20);
        }
        throw new AssertionError("queue never reached " + expected);
    }

    private static String request(String id) {
        return "{\"jsonrpc\":\"2.0\",\"id\":\"" + id + "\",\"method\":\"tools/list\"}";
    }

    private static SessionRecord session(String tenant, String session) {
        return new SessionRecord(tenant, session, "qwen-code", "1", "title", "ACTIVE",
                null, null, 0, 0, 0, 1, 1, null, 1,
                new ContextBinding(tenant, "ws", 1, "storage", ".", "hosted-workspace-files/1", 1),
                "default", "hosted-workspace-mcp/1");
    }
}
