package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.Duration;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/** Fresh lifecycle admissions retain request identity across retries and claims. */
class ManagedSessionOperationMigrationTest {
    @Test
    void completesFreshLifecycleOperationsAndReplaysTheirOriginalKeys() {
        var source = new JdbcDataSource();
        source.setURL(
                "jdbc:h2:mem:lifecycle-baseline-"
                        + UUID.randomUUID()
                        + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        ManagedSchema.initialize(source);
        var jdbc = new JdbcTemplate(source);
        var tx = new TransactionTemplate(new DataSourceTransactionManager(source));
        var store =
                new ManagedAgentStore(
                        jdbc,
                        new ObjectMapper(),
                        Clock.systemUTC(),
                        ignored -> {},
                        new ManagedWorkspaceRegistry(jdbc),
                        new ManagedAgentProperties());
        String session =
                tx.execute(
                        status ->
                                store.insertSessionCommand(
                                                "tenant",
                                                null,
                                                "CREATE_SESSION",
                                                "create",
                                                "digest-create",
                                                "qwen-code",
                                                null,
                                                "title",
                                                java.util.List.of(),
                                                null)
                                        .sessionId());
        var close =
                tx.execute(
                        status ->
                                store.beginOperation(
                                        "tenant",
                                        session,
                                        OperationKind.CLOSE,
                                        "",
                                        "close",
                                        "digest-close"));
        var retry =
                tx.execute(
                        status ->
                                store.beginOperation(
                                        "tenant",
                                        session,
                                        OperationKind.CLOSE,
                                        "",
                                        "close",
                                        "digest-close"));
        assertThat(retry.replayed()).isTrue();
        assertThat(retry.operation().operationId()).isEqualTo(close.operation().operationId());
        var claim =
                tx.execute(
                        status ->
                                store.claimOperation(
                                                "tenant",
                                                session,
                                                close.operation().operationId(),
                                                "worker",
                                                Duration.ofSeconds(30))
                                        .orElseThrow());
        assertThat(
                        tx.<Boolean>execute(
                                status ->
                                        store.completeOperation(
                                                "tenant",
                                                session,
                                                claim.operationId(),
                                                "worker",
                                                claim.claimGeneration(),
                                                true)))
                .isTrue();
        assertThat(store.requireSession("tenant", session).status()).isEqualTo("CLOSED");
        var archive =
                tx.execute(
                        status ->
                                store.beginOperation(
                                        "tenant",
                                        session,
                                        OperationKind.ARCHIVE,
                                        "",
                                        "archive",
                                        "digest-archive"));
        assertThat(archive.operation().state()).isEqualTo("COMPLETED");
        assertThat(store.requireSession("tenant", session).status()).isEqualTo("ARCHIVED");
        assertThat(
                        tx.execute(
                                        status ->
                                                store.beginOperation(
                                                        "tenant",
                                                        session,
                                                        OperationKind.ARCHIVE,
                                                        "",
                                                        "archive",
                                                        "digest-archive"))
                                .replayed())
                .isTrue();
        var delete =
                tx.execute(
                        status ->
                                store.beginOperation(
                                        "tenant",
                                        session,
                                        OperationKind.DELETE,
                                        "",
                                        "delete",
                                        "digest-delete"));
        var deleting =
                tx.execute(
                        status ->
                                store.claimOperation(
                                                "tenant",
                                                session,
                                                delete.operation().operationId(),
                                                "worker",
                                                Duration.ofSeconds(30))
                                        .orElseThrow());
        assertThat(
                        tx.<Boolean>execute(
                                status ->
                                        store.completeOperation(
                                                "tenant",
                                                session,
                                                deleting.operationId(),
                                                "worker",
                                                deleting.claimGeneration(),
                                                false)))
                .isTrue();
        assertThat(store.requireSession("tenant", session).status()).isEqualTo("DELETED");
        assertThat(store.findOperation("tenant", session, delete.operation().operationId()))
                .hasValueSatisfying(
                        operation -> {
                            assertThat(operation.admissionStage()).isEqualTo("JAVA_DURABLE");
                            assertThat(operation.sessionStatusBefore()).isEqualTo("ARCHIVED");
                        });
        assertThat(
                        jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_operation WHERE operation_kind IN"
                                    + " ('CLOSE','ARCHIVE','DELETE')",
                                Integer.class))
                .isEqualTo(3);
    }
}
