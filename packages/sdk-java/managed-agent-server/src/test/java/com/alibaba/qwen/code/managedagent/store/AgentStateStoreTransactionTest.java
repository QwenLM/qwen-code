package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;

class AgentStateStoreTransactionTest {
    @Test
    void theLegacyNineArgCreationKeepsItsTransactionBoundary()
            throws Exception {
        var source = new AnnotationTransactionAttributeSource();
        var nineArg = AgentStateStore.class.getMethod("insertSessionCommand",
                String.class, String.class, String.class, String.class,
                String.class, String.class, String.class,
                java.util.List.class, String.class);
        assertThat(source.getTransactionAttribute(nineArg,
                ManagedAgentStore.class)).isNotNull();
        var tenArg = AgentStateStore.class.getMethod("insertSessionCommand",
                String.class, String.class, String.class, String.class,
                String.class, String.class, String.class, String.class,
                java.util.List.class, String.class);
        assertThat(source.getTransactionAttribute(tenArg,
                ManagedAgentStore.class)).isNotNull();
    }
}
