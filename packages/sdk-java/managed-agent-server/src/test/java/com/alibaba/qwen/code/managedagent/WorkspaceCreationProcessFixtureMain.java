package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.util.HexFormat;
import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

/** Separate JVM for the committed Workspace creation and replay proof. */
public final class WorkspaceCreationProcessFixtureMain {
    private WorkspaceCreationProcessFixtureMain() {
    }

    public static void main(String[] args) {
        DriverManagerDataSource dataSource = new DriverManagerDataSource(
                required("W0_MYSQL_URL"), required("W0_MYSQL_USER"),
                System.getenv().getOrDefault("W0_MYSQL_PASSWORD", ""));
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        ManagedAgentStore store = new ManagedAgentStore(jdbc,
                new ObjectMapper(), Clock.systemUTC(), ignored -> {
                }, new ManagedWorkspaceRegistry(jdbc));
        TransactionTemplate transactions = new TransactionTemplate(
                new DataSourceTransactionManager(dataSource));
        String tenant = required("W0_TENANT");
        String digest = "sha256:" + "a".repeat(64);
        switch (required("W0_ACTION")) {
            case "create-and-exit" -> {
                Admission first = transactions.execute(status ->
                        store.insertWorkspaceSessionCommand(tenant, "actor-a",
                                "workspace-create", digest, "qwen-code",
                                null, List.of(), null, null));
                require(first != null && !first.replayed(),
                        "creation did not commit a new command");
                System.exit(23);
            }
            case "replay" -> {
                String sessionId = required("W0_SESSION");
                ContextBinding expected = new ContextBinding(tenant,
                        "workspace-a", 3, "storage-a", ".",
                        descriptorRef(), 1);
                Admission replay = transactions.execute(status ->
                        store.replayWorkspaceSessionCommand(tenant, "actor-a",
                                "workspace-create", digest));
                require(replay != null && replay.replayed()
                                && sessionId.equals(replay.sessionId()),
                        "replay changed the original Session");
                require(expected.equals(
                        store.requireSession(tenant, sessionId).workspace()),
                        "replay changed the original binding");
                System.out.println("W0_PROCESS_REPLAY_OK");
            }
            default -> throw new IllegalArgumentException("unknown action");
        }
    }

    private static String required(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(name + " is required");
        }
        return value;
    }

    private static String descriptorRef() {
        try {
            byte[] pair = "config-a\u0000policy-a"
                    .getBytes(StandardCharsets.UTF_8);
            return "sha256:" + HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(pair));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }
}
