package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.QueuedRequest;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.Registration;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.Status;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
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
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ClientFilesRelayServiceTest {
    private static final String CONNECTION = "conn-service";
    private static final String ACTOR = "operator";
    private JdbcTemplate jdbc;
    private ClientFilesRelayStore store;
    private ManagedAgentProperties properties;
    private ManagedAgentService agentService;
    private ManagedWorkspaceRegistry workspaces;
    private HarnessConnector harness;
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
        properties.getClientFiles().setRelayUrl("http://127.0.0.1:4170");
        agentService = mock(ManagedAgentService.class);
        workspaces = mock(ManagedWorkspaceRegistry.class);
        harness = mock(HarnessConnector.class);
        when(agentService.requireReadableSession(anyString(), anyString(), anyString()))
                .thenAnswer(invocation -> session(invocation.getArgument(0), invocation.getArgument(2)));
        when(workspaces.accessOf(anyString(), anyString(), anyString())).thenReturn(WorkspaceAccess.OPERATOR);
        when(harness.clientFilesOperation(anyString(), anyString(), any()))
                .thenReturn(Map.of("registered", true, "toolCount", 1));
        service = new ClientFilesRelayService(store, agentService, workspaces, properties, harness, new ObjectMapper());
        tenant = "tenant-" + UUID.randomUUID();
    }

    @org.junit.jupiter.api.AfterEach
    void tearDown() {
        // The constructor starts the waiter poller; stop it so each test does
        // not leak a scheduled executor thread.
        service.shutdown();
    }

    @Test
    void registerIssuesOneTimeCredentialAndPersistsOnlyItsDigest() {
        Registration registration = service.register(tenant, ACTOR, session, CONNECTION);
        assertThat(registration.serverId()).isEqualTo("local-files");
        assertThat(registration.generation()).isEqualTo(1L);
        assertThat(registration.token()).isNotBlank();
        assertThat(registration.toolCount()).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT token_hash FROM ma_client_files_binding", String.class))
                .isEqualTo(DigestUtils.sha256Hex(registration.token()));
        assertThat(service.status(tenant, ACTOR, session).state()).isEqualTo("active");
        // The one-time credential must not leak through the record's toString
        // into any log or error that prints the registration.
        assertThat(registration.toString()).doesNotContain(registration.token());
    }

    @Test
    void registerRefusedWhileDisabled() {
        properties.getClientFiles().setEnabled(false);
        assertThatThrownBy(() -> service.register(tenant, ACTOR, session, CONNECTION))
                .hasFieldOrPropertyWithValue("code", "client_files_disabled");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_client_files_binding", Integer.class)).isZero();
    }

    @Test
    void registerRefusedBelowExecutionAuthority() {
        when(workspaces.accessOf(anyString(), anyString(), anyString())).thenReturn(WorkspaceAccess.READER);
        assertThatThrownBy(() -> service.register(tenant, ACTOR, session, CONNECTION))
                .hasFieldOrPropertyWithValue("code", "client_files_execution_forbidden");
    }

    @Test
    void registerRefusedWithoutRelayUrl() {
        properties.getClientFiles().setRelayUrl("");
        assertThatThrownBy(() -> service.register(tenant, ACTOR, session, CONNECTION))
                .hasFieldOrPropertyWithValue("code", "client_files_relay_unconfigured");
    }

    @Test
    @SuppressWarnings("unchecked")
    void registerDispatchesTheRelayEndpointAndTokenToTheHarness() throws Exception {
        Registration registration = service.register(tenant, ACTOR, session, CONNECTION);
        // The CLI harness route test posts this same fixture, so a field
        // rename on either side of the dispatch turns one suite red.
        Map<String, Object> expected = new ObjectMapper().readValue(
                getClass().getResourceAsStream("/clientfiles/dispatch-register.json"), Map.class);
        expected.put("generation", ((Number) expected.get("generation")).longValue());
        expected.put("token", registration.token());
        verify(harness).clientFilesOperation(eq(tenant), eq(session), eq(expected));
    }

    @Test
    void registerFailsWhenTheHarnessCannotBeReached() {
        when(harness.clientFilesOperation(anyString(), anyString(), any()))
                .thenThrow(new UnsupportedOperationException("unavailable"));
        assertThatThrownBy(() -> service.register(tenant, ACTOR, session, CONNECTION))
                .hasFieldOrPropertyWithValue("code", "client_files_relay_unavailable");
    }

    @Test
    void refusedReRegisterRestoresThePreviousBinding() throws Exception {
        Registration first = service.register(tenant, ACTOR, session, CONNECTION);
        when(harness.clientFilesOperation(anyString(), anyString(), any()))
                .thenThrow(new UnsupportedOperationException("hosted_turn_active"));
        assertThatThrownBy(() -> service.register(tenant, ACTOR, session, CONNECTION))
                .hasFieldOrPropertyWithValue("code", "client_files_relay_unavailable");
        // The previous credential is active again at the generation the previous
        // client's downlink was opened with, so a stream at that generation keeps
        // draining rows mcp() enqueues afterwards (instead of being refused 409).
        long restoredGeneration = first.generation();
        assertThat(service.status(tenant, ACTOR, session).generation())
                .isEqualTo(restoredGeneration);
        assertThat(service.status(tenant, ACTOR, session).state()).isEqualTo("active");
        service.mcp(tenant, session, first.token(), request("1"));
        assertThat(awaitQueue(restoredGeneration, 1).get(0).requestId()).isEqualTo("1");
    }

    @Test
    void refusedReRegisterKeepsTheInFlightCallsAnswerable() throws Exception {
        Registration first = service.register(tenant, ACTOR, session, CONNECTION);
        CompletableFuture<String> call =
                service.mcp(tenant, session, first.token(), request("1"));
        awaitQueue(first.generation(), 1);
        when(harness.clientFilesOperation(anyString(), anyString(), any()))
                .thenThrow(new UnsupportedOperationException("hosted_turn_active"));
        assertThatThrownBy(() -> service.register(tenant, ACTOR, session, CONNECTION))
                .hasFieldOrPropertyWithValue("code", "client_files_relay_unavailable");
        // The registration that keeps serving must not have its in-flight queue
        // failed by the refused attempt: the row stays queued and the browser's
        // answer still settles the Runtime call.
        assertThat(jdbc.queryForObject("SELECT state FROM ma_client_files_request WHERE request_id='1'",
                String.class)).isEqualTo("queued");
        service.respond(tenant, ACTOR, session, first.generation(), CONNECTION, "1",
                "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"result\":{\"ok\":true}}", null);
        assertThat(call.get(5, TimeUnit.SECONDS)).contains("\"ok\":true");
    }

    @Test
    void streamClosedTearsDownTheBindingAndQueue() throws Exception {
        Registration registration = service.register(tenant, ACTOR, session, CONNECTION);
        mcpInBackground(registration.token(), request("1"));
        awaitQueue(registration.generation(), 1);
        service.streamClosed(tenant, ACTOR, session, registration.generation());
        assertThat(jdbc.queryForObject("SELECT state FROM ma_client_files_binding", String.class))
                .isEqualTo("closed");
        assertThat(jdbc.queryForObject("SELECT state FROM ma_client_files_request WHERE request_id='1'",
                String.class)).isEqualTo("failed");
        assertThat(jdbc.queryForObject("SELECT error_code FROM ma_client_files_request WHERE request_id='1'",
                String.class)).isEqualTo("client_files_offline");
        verify(harness).clientFilesOperation(eq(tenant), eq(session),
                eq(Map.of("action", "unregister", "generation", registration.generation())));
    }

    @Test
    void streamClosedIsGenerationFencedAndIdempotent() throws Exception {
        Registration registration = service.register(tenant, ACTOR, session, CONNECTION);
        // A stale stream callback for an older generation must not close the
        // current binding.
        service.streamClosed(tenant, ACTOR, session, registration.generation() + 1);
        assertThat(service.status(tenant, ACTOR, session).state()).isEqualTo("active");
        service.streamClosed(tenant, ACTOR, session, registration.generation());
        assertThat(service.status(tenant, ACTOR, session).state()).isEqualTo("closed");
        // A second callback for the now-closed binding is a no-op.
        service.streamClosed(tenant, ACTOR, session, registration.generation());
        assertThat(service.status(tenant, ACTOR, session).state()).isEqualTo("closed");
    }

    @Test
    void reRegisterAdvancesGenerationAndFailsTheOldQueue() throws Exception {
        Registration first = service.register(tenant, ACTOR, session, CONNECTION);
        mcpInBackground(first.token(), request("1"));
        awaitQueue(first.generation(), 1);
        Registration second = service.register(tenant, ACTOR, session, CONNECTION);
        assertThat(second.generation()).isEqualTo(2L);
        assertThat(jdbc.queryForObject("SELECT state FROM ma_client_files_request WHERE request_id='1'",
                String.class)).isEqualTo("failed");
        assertThat(jdbc.queryForObject("SELECT error_code FROM ma_client_files_request WHERE request_id='1'",
                String.class)).isEqualTo("client_files_offline");
    }

    @Test
    void mcpRefusesWrongOrMissingCredential() {
        service.register(tenant, ACTOR, session, CONNECTION);
        assertThatThrownBy(() -> service.mcp(tenant, session, "wrong", request("1")))
                .hasFieldOrPropertyWithValue("code", "client_files_credential_invalid");
        assertThatThrownBy(() -> service.mcp(tenant, session, null, request("1")))
                .hasFieldOrPropertyWithValue("code", "client_files_credential_invalid");
    }

    @Test
    void mcpRoundTripsThroughTheBrowserQueue() throws Exception {
        Registration registration = service.register(tenant, ACTOR, session, CONNECTION);
        CompletableFuture<String> call =
                service.mcp(tenant, session, registration.token(), request("7"));
        List<QueuedRequest> drained = awaitQueue(registration.generation(), 1);
        assertThat(drained.get(0).requestId()).isEqualTo("7");
        service.respond(tenant, ACTOR, session, registration.generation(), CONNECTION, "7",
                "{\"jsonrpc\":\"2.0\",\"id\":\"7\",\"result\":{\"tools\":[]}}", null);
        assertThat(call.get(5, TimeUnit.SECONDS)).contains("\"tools\":[]");
    }

    @Test
    void mcpExpiresToTheStructuredOfflineError() throws Exception {
        Registration registration = service.register(tenant, ACTOR, session, CONNECTION);
        String answer = service.mcp(tenant, session, registration.token(), request("9"))
                .get(5, TimeUnit.SECONDS);
        assertThat(answer).contains("client_files_offline").contains("\"id\":\"9\"");
    }

    @Test
    void mcpRetryOfAnAnsweredIdReplaysTheAnswer() throws Exception {
        Registration registration = service.register(tenant, ACTOR, session, CONNECTION);
        CompletableFuture<String> call =
                service.mcp(tenant, session, registration.token(), request("3"));
        awaitQueue(registration.generation(), 1);
        service.respond(tenant, ACTOR, session, registration.generation(), CONNECTION, "3",
                "{\"jsonrpc\":\"2.0\",\"id\":\"3\",\"result\":{\"v\":1}}", null);
        String first = call.get(5, TimeUnit.SECONDS);
        assertThat(service.mcp(tenant, session, registration.token(), request("3"))
                .get(5, TimeUnit.SECONDS)).isEqualTo(first);
    }

    @Test
    void mcpSessionResolvesTheTenantFromTheBinding() throws Exception {
        Registration registration = service.register(tenant, ACTOR, session, CONNECTION);
        CompletableFuture<String> call =
                service.mcpSession(session, registration.token(), request("5"));
        List<QueuedRequest> drained = awaitQueue(registration.generation(), 1);
        assertThat(drained.get(0).requestId()).isEqualTo("5");
        service.respond(tenant, ACTOR, session, registration.generation(), CONNECTION, "5",
                "{\"jsonrpc\":\"2.0\",\"id\":\"5\",\"result\":{\"ok\":true}}", null);
        assertThat(call.get(5, TimeUnit.SECONDS)).contains("\"ok\":true");
        assertThatThrownBy(() -> service.mcpSession("missing", registration.token(), request("6")))
                .hasFieldOrPropertyWithValue("code", "client_files_credential_invalid");
    }

    @Test
    void mcpNotificationIsFireAndForget() throws Exception {
        Registration registration = service.register(tenant, ACTOR, session, CONNECTION);
        assertThat(service.mcp(tenant, session, registration.token(),
                "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}")
                .get(5, TimeUnit.SECONDS)).isNull();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_client_files_request", Integer.class)).isEqualTo(1);
    }

    @Test
    void respondValidatesShapeOwnershipAndGeneration() {
        Registration registration = service.register(tenant, ACTOR, session, CONNECTION);
        long generation = registration.generation();
        assertThatThrownBy(() -> service.respond(tenant, ACTOR, session, generation, CONNECTION, "1", "{}", "boom"))
                .hasFieldOrPropertyWithValue("code", "client_files_invalid");
        assertThatThrownBy(() -> service.respond(tenant, ACTOR, session, generation, CONNECTION, "1", null, null))
                .hasFieldOrPropertyWithValue("code", "client_files_invalid");
        assertThatThrownBy(() -> service.respond(tenant, ACTOR, session, generation, CONNECTION, "missing", "{}", null))
                .hasFieldOrPropertyWithValue("code", "client_files_request_not_found");
        assertThatThrownBy(() -> service.respond(tenant, "other-actor", session, generation, CONNECTION, "1", "{}", null))
                .hasFieldOrPropertyWithValue("code", "client_files_not_found");
        assertThatThrownBy(() -> service.respond(tenant, ACTOR, session, generation + 1, CONNECTION, "1", "{}", null))
                .hasFieldOrPropertyWithValue("code", "client_files_generation_conflict");
    }

    @Test
    void respondRequiresTheOwnedConnectionIdentity() throws Exception {
        Registration registration = service.register(tenant, ACTOR, session, CONNECTION);
        long generation = registration.generation();
        CompletableFuture<String> call =
                service.mcp(tenant, session, registration.token(), request("1"));
        awaitQueue(generation, 1);
        // A second client of the same actor knows the generation (status hands
        // it out) but not this registration's identity: an omitted or foreign
        // connectionId must be refused, and the waiter must stay unsettled.
        assertThatThrownBy(() -> service.respond(tenant, ACTOR, session, generation, null,
                "1", "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"result\":{}}", null))
                .hasFieldOrPropertyWithValue("code", "client_files_generation_conflict");
        assertThatThrownBy(() -> service.respond(tenant, ACTOR, session, generation, "other-tab",
                "1", "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"result\":{}}", null))
                .hasFieldOrPropertyWithValue("code", "client_files_generation_conflict");
        assertThat(jdbc.queryForObject("SELECT state FROM ma_client_files_request WHERE request_id='1'",
                String.class)).isEqualTo("queued");
        assertThat(call.isDone()).isFalse();
        // The owning connection still settles it.
        service.respond(tenant, ACTOR, session, generation, CONNECTION, "1",
                "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"result\":{\"ok\":true}}", null);
        assertThat(call.get(5, TimeUnit.SECONDS)).contains("\"ok\":true");
    }

    @Test
    void streamRequiresTheOwnedConnectionIdentity() {
        Registration registration = service.register(tenant, ACTOR, session, CONNECTION);
        long generation = registration.generation();
        // The owning connection attaches.
        service.requireStreamConnection(tenant, ACTOR, session, generation, CONNECTION);
        // An omitted or foreign identity is refused, not short-circuited: a
        // second client of the same actor must not attach to this queue.
        assertThatThrownBy(() -> service.requireStreamConnection(tenant, ACTOR, session, generation, null))
                .hasFieldOrPropertyWithValue("code", "client_files_generation_conflict");
        assertThatThrownBy(() -> service.requireStreamConnection(tenant, ACTOR, session, generation, "other-tab"))
                .hasFieldOrPropertyWithValue("code", "client_files_generation_conflict");
        // A stale generation is refused as well.
        assertThatThrownBy(() -> service.requireStreamConnection(tenant, ACTOR, session, generation + 1, CONNECTION))
                .hasFieldOrPropertyWithValue("code", "client_files_generation_conflict");
    }

    @Test
    void respondRefusesAnOversizeErrorCode() {
        Registration registration = service.register(tenant, ACTOR, session, CONNECTION);
        assertThatThrownBy(() -> service.respond(tenant, ACTOR, session, registration.generation(),
                CONNECTION, "1", null, "x".repeat(129)))
                .hasFieldOrPropertyWithValue("code", "client_files_invalid");
    }

    @Test
    void unregisterClosesTheBindingAndFailsQueuedRequests() throws Exception {
        Registration registration = service.register(tenant, ACTOR, session, CONNECTION);
        mcpInBackground(registration.token(), request("1"));
        awaitQueue(registration.generation(), 1);
        assertThat(service.unregister(tenant, ACTOR, session, null).state()).isEqualTo("closed");
        assertThat(jdbc.queryForObject("SELECT state FROM ma_client_files_request WHERE request_id='1'",
                String.class)).isEqualTo("failed");
        assertThatThrownBy(() -> service.mcp(tenant, session, registration.token(), request("2")))
                .hasFieldOrPropertyWithValue("code", "client_files_credential_invalid");
    }

    @Test
    void staleUnregisterDoesNotCloseAReplacedBinding() throws Exception {
        Registration registration = service.register(tenant, ACTOR, session, CONNECTION);
        // An old tab whose registration was replaced tears down with its own
        // (now stale) connection identity: it must not close the current binding.
        Status stale = service.unregister(tenant, ACTOR, session, "superseded-connection");
        assertThat(stale.state()).isEqualTo("active");
        assertThat(stale.generation()).isEqualTo(registration.generation());
        assertThat(service.status(tenant, ACTOR, session).state()).isEqualTo("active");
        // The owning connection still closes it.
        assertThat(service.unregister(tenant, ACTOR, session, CONNECTION).state())
                .isEqualTo("closed");
    }

    @Test
    void deliveryRefusedAfterTheActorLosesExecutionAuthority() throws Exception {
        Registration registration = service.register(tenant, ACTOR, session, CONNECTION);
        mcpInBackground(registration.token(), request("1"));
        awaitQueue(registration.generation(), 1);
        when(workspaces.accessOf(anyString(), anyString(), anyString())).thenReturn(WorkspaceAccess.READER);
        assertThatThrownBy(() -> service.requests(tenant, ACTOR, session, registration.generation()))
                .hasFieldOrPropertyWithValue("code", "client_files_execution_forbidden");
        assertThat(jdbc.queryForObject("SELECT state FROM ma_client_files_request WHERE request_id='1'",
                String.class)).isEqualTo("failed");
        assertThat(jdbc.queryForObject("SELECT state FROM ma_client_files_binding", String.class))
                .isEqualTo("closed");
    }

    @Test
    void settlementRefusedAfterTheActorLosesExecutionAuthority() throws Exception {
        Registration registration = service.register(tenant, ACTOR, session, CONNECTION);
        mcpInBackground(registration.token(), request("1"));
        awaitQueue(registration.generation(), 1);
        when(workspaces.accessOf(anyString(), anyString(), anyString())).thenReturn(WorkspaceAccess.READER);
        assertThatThrownBy(() -> service.respond(tenant, ACTOR, session, registration.generation(),
                CONNECTION, "1", "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"result\":{}}", null))
                .hasFieldOrPropertyWithValue("code", "client_files_execution_forbidden");
        assertThat(jdbc.queryForObject("SELECT state FROM ma_client_files_request WHERE request_id='1'",
                String.class)).isEqualTo("failed");
        assertThat(jdbc.queryForObject("SELECT state FROM ma_client_files_binding", String.class))
                .isEqualTo("closed");
    }

    @Test
    void oversizePayloadIsRefused() {
        Registration registration = service.register(tenant, ACTOR, session, CONNECTION);
        String body = "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"tools/call\",\"params\":\""
                + "x".repeat(properties.getClientFiles().getMaxPayloadBytes()) + "\"}";
        assertThatThrownBy(() -> service.mcp(tenant, session, registration.token(), body))
                .hasFieldOrPropertyWithValue("code", "client_files_payload_too_large");
    }

    @Test
    void queueDepthIsBounded() throws Exception {
        properties.getClientFiles().setQueueDepth(1);
        Registration registration = service.register(tenant, ACTOR, session, CONNECTION);
        mcpInBackground(registration.token(), request("1"));
        awaitQueue(registration.generation(), 1);
        assertThatThrownBy(() -> service.mcp(tenant, session, registration.token(), request("2")))
                .hasFieldOrPropertyWithValue("code", "client_files_queue_full");
    }

    @Test
    void retentionSweepDrainsTheSettledBacklogInOneTick() {
        Registration registration = service.register(tenant, ACTOR, session, CONNECTION);
        // Seed more settled rows than a single bounded delete (256) can clear,
        // all older than the retention cutoff (request-ttl + 60s).
        long old = System.currentTimeMillis() - 120_000;
        for (int i = 0; i < 300; i++) {
            store.enqueue(tenant, session, registration.generation(), "r" + i, "{}",
                    old + 1_000, old);
            store.answer(tenant, session, registration.generation(), CONNECTION, "r" + i, "{}", old);
        }
        service.expireRequests();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_client_files_request", Integer.class))
                .isZero();
    }

    @Test
    void retentionSweepsStillRunAfterTheFeatureIsDisabled() {
        Registration registration = service.register(tenant, ACTOR, session, CONNECTION);
        long old = System.currentTimeMillis() - 120_000;
        store.enqueue(tenant, session, registration.generation(), "settled", "{}", old + 1_000, old);
        store.answer(tenant, session, registration.generation(), CONNECTION, "settled", "{}", old);
        jdbc.update("UPDATE ma_client_files_binding SET expires_at=?", old);
        // Turning the flag off must not strand already-persisted rows (whose
        // bodies may hold file content) past their TTL: the sweeps create no
        // state, so they keep running. Restoring the isEnabled early return
        // turns this red.
        properties.getClientFiles().setEnabled(false);
        service.expireRequests();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_client_files_request", Integer.class))
                .isZero();
        assertThat(jdbc.queryForObject("SELECT state FROM ma_client_files_binding", String.class))
                .isEqualTo("closed");
    }

    @Test
    void expirySweepDispatchesAGenerationFencedUnregister() {
        Registration registration = service.register(tenant, ACTOR, session, CONNECTION);
        // A browser that vanished without an unregister: the deadline passes
        // and the sweep closes the row. It must also tear down the harness
        // catalog, not leave it advertising tools every call then refuses.
        jdbc.update("UPDATE ma_client_files_binding SET expires_at=?", System.currentTimeMillis() - 1);
        service.expireRequests();
        assertThat(jdbc.queryForObject("SELECT state FROM ma_client_files_binding", String.class))
                .isEqualTo("closed");
        verify(harness).clientFilesOperation(eq(tenant), eq(session),
                eq(Map.of("action", "unregister", "generation", registration.generation())));
    }

    @Test
    void refusedFirstRegistrationDoesNotLeaveAnActiveBinding() {
        when(harness.clientFilesOperation(anyString(), anyString(), any()))
                .thenThrow(new UnsupportedOperationException("unavailable"));
        assertThatThrownBy(() -> service.register(tenant, ACTOR, session, CONNECTION))
                .hasFieldOrPropertyWithValue("code", "client_files_relay_unavailable");
        // No browser holds the credential of a refused first registration, so
        // the binding this attempt created must not linger active until
        // binding-ttl with nothing able to drain it.
        assertThat(jdbc.queryForObject("SELECT state FROM ma_client_files_binding", String.class))
                .isEqualTo("closed");
    }

    private void mcpInBackground(String token, String body) {
        // mcp registers a waiter and returns immediately; no thread needed.
        service.mcp(tenant, session, token, body);
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
