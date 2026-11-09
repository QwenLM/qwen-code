/*
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
package com.alibaba.qwen.code.managedagent.extensions;

import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionPolicyStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ManagedExtensionManagementServiceTest {
    @Test
    void lookupRejectsUnknownKeyWhenSessionHasNoWorkspace() {
        SessionPolicyStore store = mock(SessionPolicyStore.class);
        ManagedAgentService sessions = mock(ManagedAgentService.class);
        SessionRecord session = mock(SessionRecord.class);
        when(sessions.requireReadableSession("tenant", "actor", "legacy")).thenReturn(session);
        when(session.workspace()).thenReturn(null);
        ManagedExtensionManagementService service = new ManagedExtensionManagementService(store, sessions,
                mock(ManagedExtensionRecordStore.class), mock(ManagedExtensionPackageService.class), new ObjectMapper(),
                mock(HarnessConnector.class));

        assertThat(service.query("tenant", "actor", "legacy", null).path("supported").asBoolean()).isFalse();
        assertThatThrownBy(() -> service.lookup("tenant", "actor", "legacy", "never-submitted"))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(404);
                    assertThat(error.getCode()).isEqualTo("extension_operation_not_found");
                });
    }
}
