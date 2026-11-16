package com.alibaba.qwen.code.maintenance;

import com.alibaba.druid.pool.DruidDataSource;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.persistence.ResidentRetirementFixture;
import com.alibaba.qwen.code.managedagent.persistence.ResidentWorkspaceRetirementStore;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import java.io.IOException;
import java.net.URL;
import java.util.Collections;
import java.util.Enumeration;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class WorkspaceRecoveryApplicationTest {
    @Test
    void residentSqlMaintenanceDoesNotDiscoverOrRequireOnlineFactories() {
        var discoveries = new AtomicInteger();
        ClassLoader previous = Thread.currentThread().getContextClassLoader();
        var withoutFactories = new ClassLoader(previous) {
            @Override
            public Enumeration<URL> getResources(String name) throws IOException {
                if (name.equals("META-INF/services/" + RuntimeProviderFactory.class.getName())) {
                    discoveries.incrementAndGet();
                    return Collections.emptyEnumeration();
                }
                return super.getResources(name);
            }
        };
        String prefix = "qwen.managed-agent.runtime-broker.";
        String mapping = prefix + "resident-workspaces[0].";
        String uid = "11111111-1111-4111-8111-111111111111";
        Thread.currentThread().setContextClassLoader(withoutFactories);
        try {
            new ApplicationContextRunner().withClassLoader(withoutFactories)
                    .withUserConfiguration(WorkspaceRecoveryApplication.class)
                    .withPropertyValues(
                            "spring.datasource.url=jdbc:h2:mem:maintenance-" + UUID.randomUUID()
                                    + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
                            "spring.datasource.username=sa",
                            "qwen.managed-agent.harness.enabled=true",
                            "qwen.managed-agent.harness.workspace-files-enabled=true",
                            "qwen.managed-agent.session-store.enabled=true",
                            prefix + "enabled=true", prefix + "provisioner=kubernetes-workspace",
                            prefix + "isolation-class=workspace", prefix + "trusted-local-reboot-recovery=false",
                            prefix + "resident-kubernetes-api-url=https://unused.invalid",
                            prefix + "resident-kubernetes-token-file=/unread-token",
                            prefix + "resident-kubernetes-ca-file=/unread-ca",
                            mapping + "workspace-id=workspace", mapping + "workspace-generation=1",
                            mapping + "registration.tenant-id=tenant", mapping + "registration.storage-id=storage",
                            mapping + "registration.cluster-domain=cluster", mapping + "registration.namespace=runtime",
                            mapping + "registration.pvc-name=claim", mapping + "registration.pvc-uid=pvc-uid",
                            mapping + "registration.pv-name=volume", mapping + "registration.pv-uid=pv-uid",
                            mapping + "registration.driver=diskplugin.csi.alibabacloud.com",
                            mapping + "registration.volume-handle=handle", mapping + "registration.backend-domain=backend",
                            mapping + "registration.disk-serial=serial", mapping + "registration.mount-root=/workspace",
                            mapping + "registration.revision=1", mapping + "protection.namespace-uid=" + uid,
                            mapping + "protection.policy-name=protect", mapping + "protection.policy-uid=" + uid,
                            mapping + "protection.policy-generation=1", mapping + "protection.binding-name=protect-binding",
                            mapping + "protection.binding-uid=" + uid, mapping + "protection.binding-generation=1",
                            mapping + "image=worker@sha256:" + "a".repeat(64),
                            mapping + "command[0]=node", mapping + "command[1]=/worker/cli.js", mapping + "artifacts=")
                    .run(context -> {
                        assertThat(context).hasNotFailed();
                        assertThat(discoveries).hasValue(0);
                        var properties = context.getBean(ManagedAgentProperties.class);
                        var fixture = new ResidentRetirementFixture(context.getBean(DruidDataSource.class));
                        fixture.ready();
                        var store = new ResidentWorkspaceRetirementStore(fixture.jdbc, fixture.manager, fixture.bindings,
                                properties.getRuntimeBroker().getResidentWorkspaces(), new ObjectMapper());
                        assertThat(store.inspect(fixture.request).state()).isEqualTo("NOT_STARTED");
                        assertThat(store.begin(fixture.request).state()).isEqualTo("DRAINING");
                        assertThat(store.inspect(fixture.request).state()).isEqualTo("DRAINING");
                        assertThat(discoveries).hasValue(0);
                        assertThatThrownBy(properties::validateRuntimeProvider)
                                .hasMessageContaining("not installed: kubernetes-workspace");
                    });
        } finally {
            Thread.currentThread().setContextClassLoader(previous);
        }
    }

    @Test
    void bindsAndClosesMaintenanceDataSource() {
        var source = new java.util.concurrent.atomic.AtomicReference<DruidDataSource>();
        new ApplicationContextRunner().withUserConfiguration(WorkspaceRecoveryApplication.class)
                .withPropertyValues("spring.datasource.url=jdbc:h2:mem:maintenance",
                        "spring.datasource.username=sa", "spring.datasource.druid.max-active=7")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    source.set(context.getBean(DruidDataSource.class));
                    assertThat(source.get().getMaxActive()).isEqualTo(7);
                    try (var connection = source.get().getConnection();
                            var statement = connection.createStatement()) {
                        statement.execute("CREATE TABLE maintenance_probe (id INTEGER)");
                        statement.executeUpdate("INSERT INTO maintenance_probe VALUES (1)");
                        try (var rows = statement.executeQuery("SELECT id FROM maintenance_probe")) {
                            assertThat(rows.next()).isTrue();
                            assertThat(rows.getInt(1)).isEqualTo(1);
                        }
                    } catch (java.sql.SQLException error) {
                        throw new AssertionError(error);
                    }
                    assertThat(context.containsBean("managedAgentService")).isFalse();
                });
        assertThat(source.get().isClosed()).isTrue();
    }
}
