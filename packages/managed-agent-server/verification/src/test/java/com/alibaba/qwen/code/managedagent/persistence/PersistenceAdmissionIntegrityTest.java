package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.runtimebroker.security.SecretProtector;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

class PersistenceAdmissionIntegrityTest {
    @Test
    void channelClaimRequiresItsSourceBeforeAnyDatabaseAccess() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        var store = new ChannelInstanceStore(jdbc);
        assertThrows(IllegalArgumentException.class, () -> store.claim("tenant", "channel", "delivery", null));
        verifyNoInteractions(jdbc);
    }

    @Test
    void invalidArchiveSizesCannotStartATransactionOrWriteAPublication() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        PlatformTransactionManager manager = mock(PlatformTransactionManager.class);
        var secrets = new StaticListableBeanFactory().getBeanProvider(SecretProtector.class);
        var store = new JdbcExtensionPackageRepository(jdbc, manager, new ObjectMapper(), secrets);
        for (long length : new long[] {-1, ManagedExtensionPackages.MAX_ARCHIVE_BYTES + 1}) {
            assertThrows(ManagedAgentException.class, () -> store.finishPublish(
                    "tenant", "actor", "workspace", "extension", "digest", "operation", length, null, null));
        }
        verifyNoInteractions(jdbc, manager);
    }
}
