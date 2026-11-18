package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.ParkedMcpOwners;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.persistence.RuntimeAdmissionFences;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Duration;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class JdbcParkedMcpOwnersTest {
    private static final String TENANT = "tenant";

    private JdbcTemplate jdbc;
    private JdbcParkedMcpOwners owners;

    @BeforeEach
    void setUp() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:parked-mcp-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        ManagedSchema.initialize(source);
        jdbc = new JdbcTemplate(source);
        owners = new JdbcParkedMcpOwners(jdbc);
    }

    private void runtimeSession(String id, String state, String storageKey) {
        jdbc.update("INSERT INTO ma_runtime_session (scope_key, runtime_session_id, tenant_id, workspace_id,"
                + " workspace_generation, canonical_cwd, capability_digest, isolation_class, harness_session_id,"
                + " turn_kind, binding_id, runtime_generation, session_state, record_version, last_active_at,"
                + " execution_storage_key) VALUES (?, ?, ?, 'workspace', '1', '/workspace', 'digest', 'workspace',"
                + " 'session', 'bootstrap', 'binding', 1, ?, 1, 0, ?)",
                "a".repeat(64), id, TENANT, state, storageKey);
    }

    private void head(String state, long sealedForMillis) {
        long now = System.currentTimeMillis();
        jdbc.update("INSERT INTO ma_session_head (tenant_id, session_id, harness_session_id, tenant_key, harness_key,"
                + " head_kind, state, storage_version, writer_generation, journal_revision, committed_sequence,"
                + " activation_epoch, gmt_create, gmt_modified) VALUES (?, 'session', 'session', ?, ?,"
                + " 'MANAGED_SESSION', ?, 1, 1, 0, 0, 0, ?, ?)",
                TENANT, RuntimeAdmissionFences.harnessDrainKey(TENANT), RuntimeAdmissionFences.harnessDrainKey("session"),
                state, now, now - sealedForMillis);
    }

    private static ParkedMcpOwners.Owner owner() {
        return new ParkedMcpOwners.Owner(1, TENANT, "session", "binding", 1, "mcp-owner", "b".repeat(64));
    }

    @Test
    void listsOnlyReadyDurableOwnersThatHoldAMount() {
        String storage = "b".repeat(64);
        runtimeSession("mcp-holder", "READY", storage);
        runtimeSession("extensions-components-holder", "READY", storage);
        runtimeSession("mcp-without-mount", "READY", null);
        runtimeSession("mcp-releasing", "RELEASING", storage);
        runtimeSession("turn-scoped", "READY", storage);
        assertEquals(List.of("mcp-holder", "extensions-components-holder"),
                owners.candidates(0, 10).stream().map(ParkedMcpOwners.Owner::runtimeSessionId).toList());
    }

    @Test
    void pagesByIdWithinTheLimit() {
        String storage = "b".repeat(64);
        runtimeSession("mcp-1", "READY", storage);
        runtimeSession("mcp-2", "READY", storage);
        List<ParkedMcpOwners.Owner> first = owners.candidates(0, 1);
        assertEquals(List.of("mcp-1"), first.stream().map(ParkedMcpOwners.Owner::runtimeSessionId).toList());
        assertEquals(List.of("mcp-2"), owners.candidates(first.getLast().id(), 1).stream()
                .map(ParkedMcpOwners.Owner::runtimeSessionId).toList());
    }

    @Test
    void findsOnlyTheOwnersOnOneStorage() {
        runtimeSession("mcp-here", "READY", "b".repeat(64));
        runtimeSession("mcp-elsewhere", "READY", "c".repeat(64));
        assertEquals(List.of("mcp-here"), owners.onStorage("b".repeat(64), 10).stream()
                .map(ParkedMcpOwners.Owner::runtimeSessionId).toList());
    }

    @Test
    void reportsHowLongAHeadHasBeenSealed() {
        head("SEALED", Duration.ofMinutes(45).toMillis());
        Duration sealed = owners.sealedFor(owner()).orElseThrow();
        assertTrue(sealed.compareTo(Duration.ofMinutes(45)) >= 0);
        assertTrue(sealed.compareTo(Duration.ofMinutes(46)) < 0);
    }

    @Test
    void anActiveHeadIsNotSealed() {
        head("ACTIVE", Duration.ofHours(2).toMillis());
        assertTrue(owners.sealedFor(owner()).isEmpty());
    }

    @Test
    void aMissingHeadIsNotSealed() {
        assertTrue(owners.sealedFor(owner()).isEmpty());
    }
}
