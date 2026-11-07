package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRepositorySupport;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcToolExecutionRepository;
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
        String writeJson = "{\"toolName\":\"write_file\",\"input\":{}}";
        String writeDigest = "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(writeJson.getBytes(StandardCharsets.UTF_8)));
        var read = VerifiedDispatchPayload.verify(json, digest);
        var writePayload = VerifiedDispatchPayload.verify(writeJson, writeDigest);
        var first = prepare(fixture, "first", digest);
        var second = prepare(fixture, "second", digest);
        var write = prepare(fixture, "write", writeDigest);
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
        // A new write admission stays fenced while a read is in flight.
        assertNull(executions.claimValidatedDispatch(write.getExecutionCallId(), "owner-w", lease, writePayload));
        // Taking over a lapsed claim is lifecycle maintenance, not a new
        // admission: the payload-less claim path must not be judged as a
        // writer and refused while a read runs on the same binding.
        try (var connection = source.getConnection();
                var statement = connection.prepareStatement("UPDATE ma_tool_execution SET dispatch_lease_until = 1"
                        + " WHERE execution_call_id_hash = ?")) {
            statement.setString(1, JdbcRepositorySupport.valueKey(second.getExecutionCallId()));
            statement.executeUpdate();
        }
        assertNotNull(executions.claimDispatch(second.getExecutionCallId(), "owner-takeover", lease));
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
