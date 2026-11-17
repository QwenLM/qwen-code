package com.alibaba.qwen.code.managedagent.harness;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.daemon.HarnessRuntimeRecovery;
import com.alibaba.qwen.code.daemon.HarnessSessionRef;
import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.daemon.HostedHarnessPlacement;
import com.alibaba.qwen.code.daemon.LoadHarnessSession;
import com.alibaba.qwen.code.daemon.PromptReceipt;
import com.alibaba.qwen.code.daemon.SubmitHarnessTurn;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessAttachmentLostFailure;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.test.util.ReflectionTestUtils;

import java.net.URI;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BiFunction;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class QwenHostedVanishedAttachmentReproductionTest {
    private static final String SESSION = "33333333-3333-4333-8333-333333333333";

    @Test
    void promptRecoveryUsesALoadTheResidentHarnessAccepts() {
        HostedHarnessClient client = fixture("harnessClient");
        var stale = mock(HarnessSessionRef.class);
        var fresh = mock(HarnessSessionRef.class);
        String bootId = client.capabilities().getBootId();
        when(fresh.getHarnessBootId()).thenReturn(bootId);
        when(fresh.getRuntimeRecovery()).thenReturn(mock(HarnessRuntimeRecovery.class));
        var loads = new AtomicInteger();
        when(client.loadSession(any())).thenAnswer(call -> {
            LoadHarnessSession load = call.getArgument(0);
            if (loads.getAndIncrement() == 0) {
                return stale;
            }
            boolean passive = Boolean.TRUE.equals(ReflectionTestUtils.getField(load,
                    "passiveManagedRuntimeRecovery"));
            boolean driving = Boolean.TRUE.equals(ReflectionTestUtils.getField(load, "driveRuntimeRecovery"));
            if (!passive && !driving) {
                throw refusal(409, "hosted_session_already_attached");
            }
            return fresh;
        });
        when(client.submitTurn(any())).thenAnswer(call -> {
            SubmitHarnessTurn turn = call.getArgument(0);
            if (ReflectionTestUtils.getField(turn, "session") == stale) {
                throw refusal(404, "hosted_session_not_found");
            }
            return mock(PromptReceipt.class);
        });
        QwenHostedHarnessConnector connector = fixture("connector", client);
        List<Map<String, Object>> content = List.of(Map.of("type", "text", "text", "hi"));
        assertThatThrownBy(() -> connector.submit("tenant-a", SESSION,
                "66666666-6666-4666-8666-666666666666", content,
                SubmitHarnessTurn.computePayloadDigest(content))).isInstanceOf(HarnessAttachmentLostFailure.class);
        assertThat(loads).hasValue(1);
        assertThat(connector.recoverManagedRuntime("tenant-a", SESSION, false).runtimeRecovery()).isNotNull();
        assertThat(loads).hasValue(2);
    }

    @Test
    @SuppressWarnings("unchecked")
    void oldEvictionPreservesMarkerPublishedWithANewerReference() throws Exception {
        HostedHarnessClient client = fixture("harnessClient");
        QwenHostedHarnessConnector connector = fixture("connector", client);
        var stale = mock(HarnessSessionRef.class);
        var fresh = mock(HarnessSessionRef.class);
        String bootId = client.capabilities().getBootId();
        when(fresh.getHarnessBootId()).thenReturn(bootId);
        when(fresh.getRuntimeRecovery()).thenReturn(mock(HarnessRuntimeRecovery.class));
        when(client.loadSession(any())).thenReturn(fresh);
        var removed = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var refs = new ConcurrentHashMap<Object, HarnessSessionRef>() {
            @Override
            public boolean remove(Object key, Object value) {
                boolean result = super.remove(key, value);
                if (result) {
                    afterRemoval();
                }
                return result;
            }

            @Override
            public HarnessSessionRef computeIfPresent(Object key,
                    BiFunction<? super Object, ? super HarnessSessionRef, ? extends HarnessSessionRef> update) {
                HarnessSessionRef result = super.computeIfPresent(key, update);
                if (result == null) {
                    afterRemoval();
                }
                return result;
            }

            private void afterRemoval() {
                removed.countDown();
                try {
                    if (!release.await(5, TimeUnit.SECONDS)) {
                        throw new AssertionError("Replacement was not published");
                    }
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new AssertionError(error);
                }
            }
        };
        ReflectionTestUtils.setField(connector, "attachments", refs);
        Object key = ReflectionTestUtils.invokeMethod(connector, "attachmentKey", "tenant-a", SESSION);
        Set<Object> markers = (Set<Object>) ReflectionTestUtils.getField(connector, "pendingRecovery");
        refs.put(key, stale);
        markers.add(key);
        var failure = new AtomicReference<Throwable>();
        var worker = new Thread(() -> {
            try {
                ReflectionTestUtils.invokeMethod(connector, "evictVanished",
                        "tenant-a", SESSION, stale, refusal(404, "hosted_session_not_found"));
            } catch (Throwable error) {
                failure.set(error);
            }
        });
        worker.start();
        try {
            assertThat(removed.await(5, TimeUnit.SECONDS)).isTrue();
            connector.createOrLoad("tenant-a", SESSION, true, true);
        } finally {
            release.countDown();
            worker.join(5000);
        }
        assertThat(worker.isAlive()).isFalse();
        assertThat(failure.get()).isNull();
        assertThat(refs.get(key)).isSameAs(fresh);
        assertThat(markers).contains(key);
        assertThat(connector.recoverManagedRuntime("tenant-a", SESSION, false).runtimeRecovery()).isNotNull();
    }

    @Test
    void runtimeSkillReadKeepsItsCodedRefusal() {
        HostedHarnessClient client = fixture("harnessClient");
        var stale = mock(HarnessSessionRef.class);
        when(client.loadSession(any())).thenReturn(stale);
        QwenHostedHarnessConnector connector = fixture("connector", client);
        connector.rename("tenant-a", SESSION, "title");
        var vanished = refusal(404, "hosted_session_not_found");
        doThrow(vanished).when(client).runtimeSkillCandidates(any());
        assertThatThrownBy(() -> connector.runtimeSkillCandidates("tenant-a", SESSION)).isSameAs(vanished);
    }

    @Test
    void aPoolRetryPassivelyLoadsAndPreservesASecondCodedRefusal() {
        HostedHarnessClient client = fixture("harnessClient");
        QwenHostedHarnessConnector connector = fixture("connector", client);
        String bootId = client.capabilities().getBootId();
        var fresh = mock(HarnessSessionRef.class);
        when(fresh.getHarnessBootId()).thenReturn(bootId);
        when(client.loadSession(any())).thenAnswer(call -> {
            LoadHarnessSession load = call.getArgument(0);
            assertThat(ReflectionTestUtils.getField(load, "passiveManagedRuntimeRecovery")).isEqualTo(true);
            return fresh;
        });
        var endpoint = new HarnessDiscovery.Endpoint("instance-a", URI.create("http://127.0.0.1:4101"), true);
        connector.configurePool(endpoint, client, null, null);
        var retry = new QwenHostedHarnessConnector.PoolCall("tenant-a", SESSION,
                new HostedHarnessPlacement("instance-a", bootId, 2), "w".repeat(32), true);
        var body = Map.<String, Object>of("kind", "submit_input");
        var refused = refusal(404, "hosted_session_not_found");
        when(client.runChannelOperation(fresh, body)).thenThrow(refused);

        assertThatThrownBy(() -> connector.withPlacement(retry,
                () -> connector.runChannelOperation("tenant-a", SESSION, body))).isSameAs(refused);
        verify(client).loadSession(any());
        verify(client).runChannelOperation(fresh, body);
    }

    @ParameterizedTest
    @ValueSource(strings = {"approval", "question", "automation", "message", "child"})
    void safeAdmissionsRecoverPassively(String verb) {
        HostedHarnessClient client = fixture("harnessClient");
        QwenHostedHarnessConnector connector = fixture("connector", client);
        var stale = mock(HarnessSessionRef.class);
        var fresh = mock(HarnessSessionRef.class);
        String bootId = client.capabilities().getBootId();
        when(fresh.getHarnessBootId()).thenReturn(bootId);
        var loads = new AtomicInteger();
        when(client.loadSession(any())).thenAnswer(call -> {
            if (loads.getAndIncrement() == 0) {
                return stale;
            }
            LoadHarnessSession load = call.getArgument(0);
            assertThat(ReflectionTestUtils.getField(load, "passiveManagedRuntimeRecovery"))
                    .isEqualTo(true);
            return fresh;
        });
        connector.rename("tenant-a", SESSION, "initial");
        var vanished = refusal(404, "hosted_session_not_found");
        Map<String, Object> body = Map.of("kind", "admit");
        var response = new ObjectMapper().valueToTree("question".equals(verb)
                ? Map.of("answers", List.of(Map.of("questionId", "question", "text", "yes")))
                : Map.of("optionId", "allow"));
        switch (verb) {
            case "approval" -> {
                doThrow(vanished).when(client).resolveAction(eq(stale), anyString(), anyString(), anyLong(), anyString());
                connector.resolveAction("tenant-a", SESSION, "action", response);
                verify(client).resolveAction(eq(fresh), anyString(), anyString(), anyLong(), anyString());
            }
            case "question" -> {
                doThrow(vanished).when(client).resolveQuestion(eq(stale), anyString(), any(), anyLong(), anyString());
                connector.resolveAction("tenant-a", SESSION, "action", response);
                verify(client).resolveQuestion(eq(fresh), anyString(), any(), anyLong(), anyString());
            }
            case "automation" -> {
                when(client.runAutomationOperation(stale, body)).thenThrow(vanished);
                connector.runAutomationOperation("tenant-a", SESSION, body);
                verify(client).runAutomationOperation(fresh, body);
            }
            case "message" -> {
                when(client.runMessageOperation(stale, body)).thenThrow(vanished);
                connector.runMessageOperation("tenant-a", SESSION, body);
                verify(client).runMessageOperation(fresh, body);
            }
            case "child" -> {
                doThrow(vanished).when(client).runChildOperation(stale, body);
                connector.runChildOperation("tenant-a", SESSION, body);
                verify(client).runChildOperation(fresh, body);
            }
            default -> throw new AssertionError(verb);
        }
        verify(client, times(2)).loadSession(any());
        connector.rename("tenant-a", SESSION, "after");
        verify(client).updateSessionTitle(fresh, "after");
    }

    @ParameterizedTest
    @ValueSource(strings = {"cancel", "cancel_run", "stop", "child_cancel", "close_scope", "cancel_delivery", "rename"})
    void cancellationsAndOtherNonAdmissionsKeepTheOriginalRefusal(String verb) {
        HostedHarnessClient client = fixture("harnessClient");
        QwenHostedHarnessConnector connector = fixture("connector", client);
        var stale = mock(HarnessSessionRef.class);
        when(client.loadSession(any())).thenReturn(stale);
        connector.rename("tenant-a", SESSION, "initial");
        var vanished = refusal(404, "hosted_session_not_found");
        var body = Map.<String, Object>of("kind", "child_cancel".equals(verb) ? "cancel" : verb);
        Runnable operation;
        switch (verb) {
            case "cancel" -> {
                doThrow(vanished).when(client).cancelTurn(stale);
                operation = () -> connector.cancel("tenant-a", SESSION);
            }
            case "cancel_run" -> {
                when(client.runAutomationOperation(stale, body)).thenThrow(vanished);
                operation = () -> connector.runAutomationOperation("tenant-a", SESSION, body);
            }
            case "stop" -> {
                when(client.runMessageOperation(stale, body)).thenThrow(vanished);
                operation = () -> connector.runMessageOperation("tenant-a", SESSION, body);
            }
            case "child_cancel", "close_scope" -> {
                doThrow(vanished).when(client).runChildOperation(stale, body);
                operation = () -> connector.runChildOperation("tenant-a", SESSION, body);
            }
            case "cancel_delivery" -> {
                when(client.runChannelOperation(stale, body)).thenThrow(vanished);
                operation = () -> connector.runChannelOperation("tenant-a", SESSION, body);
            }
            case "rename" -> {
                doThrow(vanished).when(client).updateSessionTitle(stale, "after");
                operation = () -> connector.rename("tenant-a", SESSION, "after");
            }
            default -> throw new AssertionError(verb);
        }
        assertThatThrownBy(operation::run).isSameAs(vanished);
        verify(client).loadSession(any());
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    @SuppressWarnings("unchecked")
    void evictionHandlesBothCachesWithoutRemovingANewerManagementRef(boolean newerManagement) {
        HostedHarnessClient client = fixture("harnessClient");
        QwenHostedHarnessConnector connector = fixture("connector", client);
        var stale = mock(HarnessSessionRef.class);
        var fresh = mock(HarnessSessionRef.class);
        Object key = ReflectionTestUtils.invokeMethod(connector, "attachmentKey", "tenant-a", SESSION);
        Map<Object, HarnessSessionRef> ordinary = (Map<Object, HarnessSessionRef>) ReflectionTestUtils.getField(connector, "attachments");
        Map<Object, HarnessSessionRef> management = (Map<Object, HarnessSessionRef>) ReflectionTestUtils.getField(connector, "mcpManagementAttachments");
        ordinary.put(key, stale);
        management.put(key, newerManagement ? fresh : stale);
        ReflectionTestUtils.invokeMethod(connector, "evictVanished", "tenant-a", SESSION, stale,
                refusal(404, "hosted_session_not_found"));
        assertThat(ordinary).isEmpty();
        if (newerManagement) {
            assertThat(management.get(key)).isSameAs(fresh);
        } else {
            assertThat(management).isEmpty();
        }
    }

    private static DaemonHttpException refusal(int status, String code) {
        try {
            var constructor = DaemonHttpException.class.getDeclaredConstructor(String.class, int.class, String.class);
            constructor.setAccessible(true);
            return constructor.newInstance("admission", status, "{\"code\":\"" + code + "\"}");
        } catch (ReflectiveOperationException error) {
            throw new AssertionError(error);
        }
    }

    private static <T> T fixture(String method, Object... arguments) {
        return ReflectionTestUtils.invokeMethod(QwenHostedHarnessConnectorTest.class, method, arguments);
    }
}
