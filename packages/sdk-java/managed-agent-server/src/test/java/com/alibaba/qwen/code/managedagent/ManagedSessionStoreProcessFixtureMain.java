package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitReceipt;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.RestoreHead;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.WriterGrant;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

/** Child JVM for the Managed Session store process-loss proof. */
public final class ManagedSessionStoreProcessFixtureMain {
    static final String TENANT = "mysql-session-process-tenant";
    static final String SESSION = "mysql-session-process-session";
    static final String WORKSPACE = "mysql-session-process-workspace";
    private static final String WRITER_A = "mysql-session-process-writer-a";
    private static final String WRITER_B = "mysql-session-process-writer-b";
    private static final String TOKEN_A =
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static final String TOKEN_B =
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static final byte[] RESOURCE_BYTES =
            "mysql-process-resource".getBytes(StandardCharsets.UTF_8);

    private ManagedSessionStoreProcessFixtureMain() {
    }

    public static void main(String[] args) {
        DriverManagerDataSource dataSource = new DriverManagerDataSource(
                required("D1_MYSQL_URL"), required("D1_MYSQL_USER"),
                System.getenv().getOrDefault("D1_MYSQL_PASSWORD", ""));
        TransactionTemplate transactions = new TransactionTemplate(
                new DataSourceTransactionManager(dataSource));
        ManagedSessionStore store = new ManagedSessionStore(
                new JdbcTemplate(dataSource));
        String action = required("D1_PROCESS_ACTION");
        switch (action) {
            case "commit-and-crash" -> commitAndCrash(store, transactions);
            case "takeover" -> takeover(store, transactions);
            case "replay" -> replay(store, transactions);
            case "stale-write" -> staleWrite(store, transactions);
            case "restore" -> restore(store, transactions);
            default -> throw new IllegalArgumentException(
                    "unknown fixture action: " + action);
        }
    }

    private static void commitAndCrash(ManagedSessionStore store,
            TransactionTemplate transactions) {
        WriterGrant grant = inTransaction(transactions,
                () -> store.acquireWriter(TENANT, SESSION, TOKEN_A,
                        new AcquireWriterRequest(WORKSPACE, WRITER_A,
                                1_000L)));
        require(grant.writerGeneration() == 1,
                "the first writer did not receive generation one");
        CommitReceipt receipt;
        try {
            receipt = inTransaction(transactions,
                    () -> store.commit(TENANT, SESSION, TOKEN_A, genesis()));
        } catch (ApiException error) {
            JdbcTemplate jdbc = new JdbcTemplate(new DriverManagerDataSource(
                    required("D1_MYSQL_URL"), required("D1_MYSQL_USER"),
                    System.getenv().getOrDefault("D1_MYSQL_PASSWORD", "")));
            Map<String, Object> head = jdbc.queryForMap(
                    "SELECT state, writer_generation, writer_id,"
                            + " writer_lease_until,"
                            + " CURRENT_TIMESTAMP(6) AS observed_now,"
                            + " lease_token_hash = ? AS token_matches,"
                            + " TIMESTAMPDIFF(MICROSECOND,"
                            + " CURRENT_TIMESTAMP(6), writer_lease_until)"
                            + " AS lease_remaining_micros FROM"
                            + " qwen_managed_session_journal_head WHERE"
                            + " tenant_id = ? AND session_id = ?",
                    sha256(TOKEN_A.getBytes(StandardCharsets.UTF_8)),
                    TENANT, SESSION);
            System.err.println("Writer diagnostic: " + head);
            throw error;
        }
        require(receipt.journalRevision() == 1 && !receipt.replayed(),
                "the genesis transaction did not commit exactly once");
        Runtime.getRuntime().halt(23);
        throw new AssertionError("Runtime.halt returned");
    }

    private static void takeover(ManagedSessionStore store,
            TransactionTemplate transactions) {
        WriterGrant grant = inTransaction(transactions,
                () -> store.acquireWriter(TENANT, SESSION, TOKEN_B,
                        new AcquireWriterRequest(WORKSPACE, WRITER_B,
                                60_000L)));
        require(grant.writerGeneration() == 2,
                "the replacement writer did not advance the generation");
        require(grant.journalRevision() == 1,
                "the replacement writer did not observe the durable commit");
        System.out.println("D1_PROCESS_TAKEOVER_OK");
    }

    private static void replay(ManagedSessionStore store,
            TransactionTemplate transactions) {
        CommitReceipt receipt = inTransaction(transactions,
                () -> store.commit(TENANT, SESSION, TOKEN_A, genesis()));
        require(receipt.replayed() && receipt.journalRevision() == 1,
                "the lost response did not return its original receipt");
        System.out.println("D1_PROCESS_REPLAY_OK");
    }

    private static void staleWrite(ManagedSessionStore store,
            TransactionTemplate transactions) {
        try {
            inTransaction(transactions,
                    () -> store.commit(TENANT, SESSION, TOKEN_A,
                            staleTurn()));
        } catch (ApiException error) {
            require(ManagedSessionStoreModels.ERROR_WRITER_CONFLICT
                            .equals(error.getCode()),
                    "the stale writer returned an unexpected error");
            System.out.println("D1_PROCESS_STALE_WRITER_OK");
            return;
        }
        throw new AssertionError("the stale writer committed new bytes");
    }

    private static void restore(ManagedSessionStore store,
            TransactionTemplate transactions) {
        RestoreHead head = inTransaction(transactions,
                () -> store.restore(TENANT, WORKSPACE, SESSION, TOKEN_B));
        require(head.writerGeneration() == 2
                        && head.journalRevision() == 1,
                "the replacement writer restored the wrong head");
        StoredResource resource = inTransaction(transactions,
                () -> store.readResource(TENANT, WORKSPACE, SESSION,
                        "mysql-process-resource", TOKEN_B));
        require(MessageDigest.isEqual(RESOURCE_BYTES, resource.bytes()),
                "the replacement writer restored different resource bytes");
        System.out.println("D1_PROCESS_RESTORE_OK");
    }

    private static CommitTransactionRequest genesis() {
        String records = "{\"subtype\":\"session_execution_engine\"}\n"
                + "{\"subtype\":\"managed_session_header_v1\"}\n";
        return new CommitTransactionRequest(WORKSPACE, WRITER_A, 1, 0, 0,
                "mysql-process-genesis-transaction", "session.create",
                "mysql-process-genesis-command", sha256(records), 0, 0, 0,
                null, null, null, 0, null, 2,
                Base64.getEncoder().encodeToString(
                        records.getBytes(StandardCharsets.UTF_8)),
                sha256(records), List.of(new CommitResource(
                        "mysql-process-resource", "managed-context", 1,
                        RESOURCE_BYTES.length, sha256(RESOURCE_BYTES),
                        Base64.getEncoder().encodeToString(RESOURCE_BYTES))));
    }

    private static CommitTransactionRequest staleTurn() {
        String records = "{\"subtype\":\"managed_session_event_v1\"}\n"
                + "{\"subtype\":\"managed_session_commit_v1\"}\n";
        return new CommitTransactionRequest(WORKSPACE, WRITER_A, 1, 1, 0,
                "mysql-process-stale-transaction", "turn.submit",
                "mysql-process-stale-command", sha256("stale-content"),
                1, 1, 1, "e".repeat(64), null, "c".repeat(64), 0,
                null, 2, Base64.getEncoder().encodeToString(
                        records.getBytes(StandardCharsets.UTF_8)),
                sha256(records), List.of());
    }

    private static <T> T inTransaction(TransactionTemplate transactions,
            Supplier<T> operation) {
        return transactions.execute(status -> operation.get());
    }

    private static String sha256(String value) {
        return sha256(value.getBytes(StandardCharsets.UTF_8));
    }

    private static String sha256(byte[] value) {
        try {
            return HexFormat.of().formatHex(MessageDigest
                    .getInstance("SHA-256").digest(value));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private static String required(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(name + " is required");
        }
        return value;
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }
}
