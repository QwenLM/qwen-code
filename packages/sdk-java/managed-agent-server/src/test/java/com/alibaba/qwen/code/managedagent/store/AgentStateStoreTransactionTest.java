package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.transaction.TransactionDefinition;
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
        var nineAttr = source.getTransactionAttribute(nineArg,
                ManagedAgentStore.class);
        // A non-starting propagation (SUPPORTS/NOT_SUPPORTED/NEVER) also
        // resolves non-null, so pin the boundary-starting one.
        assertThat(nineAttr).isNotNull();
        assertThat(nineAttr.getPropagationBehavior())
                .isEqualTo(TransactionDefinition.PROPAGATION_REQUIRED);
        var tenArg = AgentStateStore.class.getMethod("insertSessionCommand",
                String.class, String.class, String.class, String.class,
                String.class, String.class, String.class, String.class,
                java.util.List.class, String.class);
        var tenAttr = source.getTransactionAttribute(tenArg,
                ManagedAgentStore.class);
        assertThat(tenAttr).isNotNull();
        assertThat(tenAttr.getPropagationBehavior())
                .isEqualTo(TransactionDefinition.PROPAGATION_REQUIRED);
    }
}
