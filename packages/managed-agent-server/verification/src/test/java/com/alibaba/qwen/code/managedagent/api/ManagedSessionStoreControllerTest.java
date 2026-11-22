package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.WriterGrant;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedUserMessageStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcSessionResourceObjects;
import com.alibaba.qwen.code.managedagent.persistence.ManagedNativeJournalSnapshots;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

class ManagedSessionStoreControllerTest {
    private final ManagedSessionStoreController controller = new ManagedSessionStoreController(
            mock(JdbcManagedSessionStore.class), mock(JdbcManagedUserMessageStore.class),
            mock(ManagedNativeJournalSnapshots.class), mock(JdbcSessionResourceObjects.class));

    @Test
    void advertisesIndependentCapabilitiesWithoutChangingTheOriginalGrant() {
        WriterGrant grant = new WriterGrant(1, 2, 3, 4, null, 0, false);
        ReflectionTestUtils.setField(controller, "wakeDispatch", true);
        ReflectionTestUtils.setField(controller, "runtimeObservation", true);
        ReflectionTestUtils.setField(controller, "actionParking", true);

        WriterGrant advertised = ReflectionTestUtils.invokeMethod(controller, "advertise", grant);

        assertThat(advertised).isNotNull();
        assertThat(advertised.wakeDispatch()).isTrue();
        assertThat(advertised.runtimeObservation()).isTrue();
        assertThat(advertised.actionParking()).isTrue();
        assertThat(grant.wakeDispatch()).isFalse();
        assertThat(grant.runtimeObservation()).isFalse();
        assertThat(grant.actionParking()).isFalse();
    }
}
