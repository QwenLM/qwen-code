package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.WriterGrant;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedUserMessageStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcSessionResourceObjects;
import com.alibaba.qwen.code.managedagent.persistence.ManagedNativeJournalSnapshots;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ManagedSessionStoreControllerTest {
    private final JdbcManagedSessionStore store = mock(JdbcManagedSessionStore.class);
    private final ManagedSessionStoreController controller = new ManagedSessionStoreController(
            store, mock(JdbcManagedUserMessageStore.class),
            mock(ManagedNativeJournalSnapshots.class), mock(JdbcSessionResourceObjects.class));

    // Both writer endpoints advertise: the Harness client replaces its grant
    // capabilities on every renewal.
    @Test
    void advertisesIndependentCapabilitiesOnAcquireAndRenew() {
        WriterGrant grant = new WriterGrant(1, 2, 3, 4, null, 0, false);
        when(store.acquireWriter(any(), any(), any(), any(), any())).thenReturn(grant);
        when(store.renewWriter(any(), any(), any(), any(), any())).thenReturn(grant);
        ReflectionTestUtils.setField(controller, "wakeDispatch", true);
        ReflectionTestUtils.setField(controller, "runtimeObservation", true);
        ReflectionTestUtils.setField(controller, "actionParking", true);
        TenantContext tenant = new TenantContext("tenant", "actor");

        for (WriterGrant advertised : List.of(
                controller.acquire(tenant, "session", "token", null, new HttpHeaders()),
                controller.renew(tenant, "session", "token", null, new HttpHeaders()))) {
            assertThat(advertised.wakeDispatch()).isTrue();
            assertThat(advertised.runtimeObservation()).isTrue();
            assertThat(advertised.actionParking()).isTrue();
        }
        assertThat(grant.wakeDispatch()).isFalse();
        assertThat(grant.runtimeObservation()).isFalse();
        assertThat(grant.actionParking()).isFalse();
    }
}
