package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

class SharedExternalDispatchTest {
    @Test
    void sharedReadsCoexistButWritesAndUnknownRemainFenced() throws Exception {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:shared-dispatch-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        ManagedSchema.initialize(source);
        var bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
        var sessions = new JdbcRuntimeSessionRepository(source);
        var executions = new JdbcToolExecutionRepository(source);
        var fixture = new RuntimeRecoveryContract.Fixture(bindings, sessions, executions, UUID.randomUUID().toString());
        String json = "{\"toolName\":\"read_file\",\"input\":{}}";
        String digest = "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(json.getBytes(StandardCharsets.UTF_8)));
        var read = VerifiedDispatchPayload.verify(json, digest);
        var first = prepare(fixture, "first", digest);
        var second = prepare(fixture, "second", digest);
        var write = prepare(fixture, "write", digest);
        var third = prepare(fixture, "third", digest);
        try (var connection = source.getConnection();
                var statement = connection.prepareStatement("UPDATE ma_runtime_binding SET provisioner_kind = ?,"
                        + " isolation_class = ? WHERE binding_id = ?")) {
            statement.setString(1, "external-workspace");
            statement.setString(2, "workspace");
            JdbcRepositorySupport.setIdentity(statement, 3, fixture.binding.getBindingId());
            statement.executeUpdate();
        }
        var lease = Duration.ofMinutes(1);
        assertNotNull(executions.claimValidatedDispatch(first.getExecutionCallId(), "owner-a", lease, read));
        assertNotNull(executions.claimValidatedDispatch(second.getExecutionCallId(), "owner-b", lease, read));
        assertNull(executions.claimDispatch(write.getExecutionCallId(), "owner-w", lease));
        try (var connection = source.getConnection();
                var statement = connection.prepareStatement("UPDATE ma_tool_execution SET execution_state = 'UNKNOWN'"
                        + " WHERE execution_call_id_hash = ?")) {
            statement.setString(1, JdbcRepositorySupport.valueKey(first.getExecutionCallId()));
            statement.executeUpdate();
        }
        assertNull(executions.claimValidatedDispatch(third.getExecutionCallId(), "owner-c", lease, read));
    }
    private static ToolExecutionRecord prepare(RuntimeRecoveryContract.Fixture fixture, String suffix, String digest) {
        return fixture.bindings.admitExecution(fixture.sessions, fixture.executions,
                ToolExecutionRecord.prepared(fixture.id + suffix, fixture.id + suffix + "-key",
                        fixture.binding.getBindingId(), fixture.binding.getGeneration(), fixture.id + "-harness",
                        fixture.session.getRuntimeSessionId(), "turn", suffix, digest,
                        Map.of("sessionId", fixture.session.getRuntimeSessionId(), "promptId", "turn",
                                "callId", suffix, "argsDigest", digest)));
    }
}
