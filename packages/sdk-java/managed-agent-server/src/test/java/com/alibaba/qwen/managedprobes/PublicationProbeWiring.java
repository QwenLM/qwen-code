package com.alibaba.qwen.managedprobes;

import com.alibaba.qwen.code.managedagent.api.ToolPublicationController;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationAdmissionStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationContract;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.time.Duration;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;

/**
 * The real publication controller and grant/data/admission stores with an
 * in-memory object store, mirroring the conditional OSS-backed
 * {@code ToolPublicationConfiguration} that only provisioned rigs can boot.
 * Object bytes are never touched by the probe ITs' reserve/close arms, so
 * the store can be a stable in-memory stub.
 *
 * <p>Shared by {@code HostedBackgroundPublicationIT} and
 * {@code HostedRecoveryBlockedWedgeIT}. It deliberately contains no request
 * advice: the refusal-diagnosis advice (which changes the 400 envelope) must
 * exist only in the publication witness's context, since the wedge witness
 * observes the production envelope as it is.
 */
@Configuration(proxyBeanMethods = false)
public final class PublicationProbeWiring {

    private static final long EXECUTION_BYTES = 268_435_456L;
    private static final long SESSION_BYTES = 536_870_912L;
    private static final long TENANT_BYTES = 1_073_741_824L;
    private static final long ACTIVE_CAPTURES = 8;

    @Bean
    ToolPublicationObjectStore publicationObjectStore() {
        return new InMemoryObjectStore();
    }

    @Bean
    ToolPublicationStore publicationStore(JdbcTemplate jdbc,
            PlatformTransactionManager manager, ManagedSessionStore sessions,
            ToolExecutionRepository executions, RuntimeBindingRepository bindings) {
        return new ToolPublicationStore(jdbc, manager, sessions, executions,
                bindings, new ToolPublicationStore.Capacity(EXECUTION_BYTES,
                        SESSION_BYTES, TENANT_BYTES, ACTIVE_CAPTURES), false);
    }

    @Bean
    ToolPublicationDataStore publicationDataStore(JdbcTemplate jdbc,
            PlatformTransactionManager manager, ToolPublicationStore grants,
            ManagedSessionStore sessions, ToolPublicationObjectStore objects) {
        var operationTimeout = Duration.ofSeconds(60);
        var budget = new ToolPublicationDataStore.VerificationBudget(
                1_048_576L, Duration.ofMinutes(10));
        budget.timeout(operationTimeout, Math.addExact(
                EXECUTION_BYTES, ToolPublicationContract.PRODUCER_BYTES));
        return new ToolPublicationDataStore(jdbc, manager, grants, sessions,
                objects, operationTimeout, Duration.ofSeconds(30), budget);
    }

    @Bean
    ToolPublicationAdmissionStore publicationAdmissionStore(JdbcTemplate jdbc,
            PlatformTransactionManager manager, ManagedSessionStore sessions,
            ToolPublicationDataStore data) {
        return new ToolPublicationAdmissionStore(jdbc, manager, sessions, data);
    }

    @Bean
    ToolPublicationController publicationController(ToolPublicationStore grants,
            ToolPublicationDataStore data, ToolPublicationAdmissionStore admissions,
            ManagedAgentProperties properties) {
        return new ToolPublicationController(grants, data, admissions, properties);
    }

    static final class InMemoryObjectStore implements ToolPublicationObjectStore {
        private final ConcurrentHashMap<String, byte[]> objects = new ConcurrentHashMap<>();

        @Override
        public void requireUnversioned() {
        }

        @Override
        public void putIfAbsent(String key, byte[] bytes) {
            objects.putIfAbsent(key, bytes);
        }

        @Override
        public void deleteIfPresent(String key) {
            objects.remove(key);
        }

        @Override
        public InputStream open(String key) {
            byte[] bytes = objects.get(key);
            if (bytes == null) {
                throw new IllegalStateException("Unknown object " + key);
            }
            return new ByteArrayInputStream(bytes);
        }

        @Override
        public InputStream open(String key, Runnable guard) {
            guard.run();
            return open(key);
        }
    }
}
