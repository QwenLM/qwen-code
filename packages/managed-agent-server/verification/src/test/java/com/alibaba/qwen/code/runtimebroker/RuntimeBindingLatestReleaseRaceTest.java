package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

import javax.sql.DataSource;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * A read-only latest-generation lookup that straddles a concurrent release
 * must return the retired generation instead of failing the locked-read
 * consistency check.
 */
class RuntimeBindingLatestReleaseRaceTest {
    private static final RuntimeScope SCOPE = new RuntimeScope(
            "tenant", "workspace", "generation", "/workspace", "capability", "session");

    @Test
    void latestLookupReturnsTheGenerationReleasedBetweenTheSlotAndBindingReads() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:latest-release-race-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        ManagedSchema.initialize(source);
        var repository = new JdbcRuntimeBindingRepository(
                source, new AesGcmSecretProtector("test", new byte[32]));
        var request = new RuntimeProvisionRequest(SCOPE, "harness");
        var binding = repository.findOrCreate(request);
        binding = repository.claimOperation(
                binding.getBindingId(), "test-owner", Duration.ofMinutes(1));
        binding = repository.compareAndSet(binding,
                binding.withState(RuntimeBindingRecord.State.READY, null, Instant.now()));
        var ready = binding;
        var released = new AtomicBoolean();
        Runnable releaseBetweenReads = () -> {
            if (released.compareAndSet(false, true)) {
                var retired = repository.compareAndSet(ready,
                        ready.withState(RuntimeBindingRecord.State.RELEASED, null, Instant.now()));
                assertFalse(retired.isActive());
            }
        };
        var racing = new JdbcRuntimeBindingRepository(
                releaseOnBindingRead(source, releaseBetweenReads),
                new AesGcmSecretProtector("test", new byte[32]));
        var latest = racing.findLatestForRequest(request);
        assertTrue(released.get(), "the release hook never fired");
        assertEquals(ready.getBindingId(), latest.getBindingId());
        assertEquals(ready.getGeneration(), latest.getGeneration());
        assertFalse(latest.isActive());
    }

    /**
     * Fires the release on a separate auto-commit connection right before the
     * unlocked binding-by-id read, reproducing a release committed between the
     * slot read and the binding read.
     */
    private static DataSource releaseOnBindingRead(DataSource source, Runnable release) {
        return (DataSource) Proxy.newProxyInstance(
                DataSource.class.getClassLoader(), new Class<?>[] {DataSource.class},
                (proxy, method, args) -> {
                    if (!method.getName().equals("getConnection")) {
                        return invoke(method, source, args);
                    }
                    var connection = source.getConnection();
                    return Proxy.newProxyInstance(
                            connection.getClass().getClassLoader(),
                            new Class<?>[] {java.sql.Connection.class},
                            (connectionProxy, connectionMethod, connectionArgs) -> {
                                if (connectionMethod.getName().equals("prepareStatement")
                                        && connectionArgs != null
                                        && connectionArgs.length == 1
                                        && ((String) connectionArgs[0]).contains(
                                                "FROM ma_runtime_binding WHERE binding_id = ?")) {
                                    release.run();
                                }
                                return invoke(connectionMethod, connection, connectionArgs);
                            });
                });
    }

    private static Object invoke(java.lang.reflect.Method method, Object target, Object[] args)
            throws Throwable {
        try {
            return method.invoke(target, args);
        } catch (InvocationTargetException exception) {
            throw exception.getCause();
        }
    }
}
