package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.daemon.HarnessSessionRef;
import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.managedagent.harness.QwenHostedHarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.SdkHarnessBoundary;
import com.alibaba.qwen.code.managedagent.harness.UnavailableHarnessConnector;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.test.util.ReflectionTestUtils;

import java.io.UncheckedIOException;
import java.net.BindException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

import static com.alibaba.qwen.code.managedagent.HostedGateTestSupport.attachment;
import static com.alibaba.qwen.code.managedagent.HostedGateTestSupport.attachmentsOf;
import static com.alibaba.qwen.code.managedagent.HostedGateTestSupport.bootWithFreshPorts;
import static com.alibaba.qwen.code.managedagent.HostedGateTestSupport.camel;
import static com.alibaba.qwen.code.managedagent.HostedGateTestSupport.connectorOwning;
import static com.alibaba.qwen.code.managedagent.HostedGateTestSupport.quote;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

// #14921 R1-2: these two helpers are shared by nine Hosted*IT classes whose
// only lane needs MySQL and the Harness. Pinning them here keeps a wrong edit
// red in the default surefire lane instead of the slowest CI job.
class HostedGateTestSupportTest {
    @Test
    void quoteClosesTheLiteralAndReopensItAroundASingleQuote() {
        assertThat(quote("plain")).isEqualTo("'plain'");
        assertThat(quote("it's")).isEqualTo("'it'\"'\"'s'");
        assertThat(quote("")).isEqualTo("''");
    }

    @Test
    void camelUppercasesTheLetterAfterAnUnderscore() {
        assertThat(camel("foo_bar")).isEqualTo("fooBar");
        assertThat(camel("a_b_c")).isEqualTo("aBC");
        assertThat(camel("plain")).isEqualTo("plain");
    }

    @Test
    void camelKeepsATrailingUnderscoreLiteral() {
        assertThat(camel("foo_")).isEqualTo("foo_");
    }

    // The lookup reads the connector's private field by name; renaming that
    // field turns this red here rather than in five Hosted gate classes.
    @Test
    void attachmentReturnsTheSessionsRefFromTheConnector() {
        var connector = mock(QwenHostedHarnessConnector.class);
        var attachments = new LinkedHashMap<Object, HarnessSessionRef>();
        attachments.put("other", ref("session-b"));
        HarnessSessionRef mine = ref("session-a");
        attachments.put("mine", mine);
        ReflectionTestUtils.setField(connector, "attachments", attachments);

        assertThat(attachment(connector, "session-a")).isSameAs(mine);
        assertThat(attachment(connector, "session-c")).isNull();
    }

    // The Spring bean is a decorator, not the connector that owns the map, so
    // the lookup has to walk the delegate chain. Without this the Hosted gates
    // fail in the test-support layer before the row under test runs (#15972).
    @Test
    void attachmentUnwrapsTheBoundaryToTheConnectorThatOwnsTheMap() {
        var connector = mock(QwenHostedHarnessConnector.class);
        var attachments = new LinkedHashMap<Object, HarnessSessionRef>();
        HarnessSessionRef mine = ref("session-a");
        attachments.put("mine", mine);
        ReflectionTestUtils.setField(connector, "attachments", attachments);
        var decorated = new SdkHarnessBoundary(new SdkHarnessBoundary(connector));

        assertThat(attachment(decorated, "session-a")).isSameAs(mine);
        assertThat(attachment(decorated, "session-c")).isNull();
        assertThat(attachmentsOf(decorated)).isSameAs(attachments);
    }

    // The same bean is read for its client one line after its attachment, so
    // resolving the owner has to serve every private read on it, not just the
    // map (#15972 R1-1).
    @Test
    void connectorOwningServesEveryPrivateReadOnTheDecoratedBean() {
        var connector = mock(QwenHostedHarnessConnector.class);
        var attachments = new LinkedHashMap<Object, HarnessSessionRef>();
        attachments.put("mine", ref("session-a"));
        ReflectionTestUtils.setField(connector, "attachments", attachments);
        HostedHarnessClient client = mock(HostedHarnessClient.class);
        ReflectionTestUtils.setField(connector, "client", client);
        var decorated = new SdkHarnessBoundary(new SdkHarnessBoundary(connector));

        assertThat(ReflectionTestUtils.getField(connectorOwning(decorated), "client"))
                .isSameAs(client);
        assertThat(connectorOwning(decorated)).isSameAs(connector);
        assertThat(attachmentsOf(decorated)).isSameAs(attachments);

        // A declared field holding null is still a field: the read returns null
        // instead of the owner being treated as unresolved.
        ReflectionTestUtils.setField(connector, "client", null);
        assertThat(ReflectionTestUtils.getField(connectorOwning(decorated), "client"))
                .isNull();
    }

    // findField's type argument matches the declared type exactly, so a
    // decorator that declares its delegate as a concrete connector is only
    // walked past by a name-plus-assignability match. Without this the next
    // such wrapper silently reintroduces #15972 on a green build.
    @Test
    void theWalkFollowsADelegateDeclaredAsAConcreteConnector() {
        var connector = mock(QwenHostedHarnessConnector.class);
        var attachments = new LinkedHashMap<Object, HarnessSessionRef>();
        attachments.put("mine", ref("session-a"));
        ReflectionTestUtils.setField(connector, "attachments", attachments);
        var decorated = new ConcreteTypedBoundary(connector);

        assertThat(connectorOwning(decorated)).isSameAs(connector);
        assertThat(attachmentsOf(decorated)).isSameAs(attachments);
    }

    // A chain whose leaf owns neither field — the pooled connector is shaped
    // like this — must stop at the leaf, so the caller still gets the error
    // naming the missing field rather than a NullPointerException from
    // dereferencing past the end.
    @Test
    void aChainThatOwnsNoMapStopsAndStillNamesTheMissingField() {
        var leaf = new UnavailableHarnessConnector();
        var decorated = new SdkHarnessBoundary(leaf);

        assertThat(connectorOwning(decorated)).isSameAs(leaf);
        assertThatThrownBy(() -> attachmentsOf(decorated))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("attachments");
    }

    // Declares its delegate as the concrete connector, not the interface.
    private static final class ConcreteTypedBoundary
            extends UnavailableHarnessConnector {
        private final QwenHostedHarnessConnector delegate;

        ConcreteTypedBoundary(QwenHostedHarnessConnector delegate) {
            this.delegate = delegate;
        }
    }

    // The boot retry's only consumer is the deep MySQL lane; pin its contract
    // here so a wrong edit goes red in the default surefire lane instead.
    @Test
    void successfulBootProbesOnceAndBootsOnce() {
        ConfigurableApplicationContext context = mock(ConfigurableApplicationContext.class);
        List<String> events = new ArrayList<>();

        ConfigurableApplicationContext result =
                bootWithFreshPorts(
                        () -> events.add("probe"),
                        () -> {
                            events.add("boot");
                            return context;
                        });

        assertThat(result).isSameAs(context);
        assertThat(events).containsExactly("probe", "boot");
    }

    @Test
    void bindConflictRetriesWithAProbeBeforeEachAttempt() {
        List<String> events = new ArrayList<>();
        AtomicInteger boots = new AtomicInteger();

        bootWithFreshPorts(
                () -> events.add("probe"),
                () -> {
                    events.add("boot");
                    if (boots.incrementAndGet() < 3) {
                        throw bindConflict();
                    }
                    return null;
                });

        assertThat(events)
                .containsExactly("probe", "boot", "probe", "boot", "probe", "boot");
    }

    @Test
    void bindExceptionDeepInTheCauseChainStillRetries() {
        List<String> events = new ArrayList<>();
        AtomicInteger boots = new AtomicInteger();

        bootWithFreshPorts(
                () -> events.add("probe"),
                () -> {
                    events.add("boot");
                    if (boots.incrementAndGet() == 1) {
                        throw new RuntimeException(
                                "unsatisfied dependency",
                                new IllegalStateException(
                                        "broker start",
                                        new UncheckedIOException(
                                                new BindException(
                                                        "Address already in use"))));
                    }
                    return null;
                });

        assertThat(events).containsExactly("probe", "boot", "probe", "boot");
    }

    @Test
    void thirdBindConflictIsRethrownInsteadOfLooping() {
        AtomicInteger probes = new AtomicInteger();
        List<RuntimeException> thrown = new ArrayList<>();
        Supplier<ConfigurableApplicationContext> boot =
                () -> {
                    RuntimeException error = bindConflict();
                    thrown.add(error);
                    throw error;
                };

        assertThatThrownBy(() -> bootWithFreshPorts(() -> probes.incrementAndGet(), boot))
                .isSameAs(thrown.get(2));
        assertThat(probes).hasValue(3);
        assertThat(thrown).hasSize(3);
    }

    @Test
    void nonBindFailureIsRethrownOnTheFirstAttempt() {
        AtomicInteger probes = new AtomicInteger();
        AtomicInteger boots = new AtomicInteger();
        RuntimeException failure = new IllegalStateException("not a bind conflict");

        assertThatThrownBy(
                        () ->
                                bootWithFreshPorts(
                                        () -> probes.incrementAndGet(),
                                        () -> {
                                            boots.incrementAndGet();
                                            throw failure;
                                        }))
                .isSameAs(failure);
        assertThat(probes).hasValue(1);
        assertThat(boots).hasValue(1);
    }

    @Test
    void probeFailureIsNotRetried() {
        AtomicInteger probes = new AtomicInteger();
        AtomicInteger boots = new AtomicInteger();
        RuntimeException failure =
                new UncheckedIOException("probe failed", new java.io.IOException());

        assertThatThrownBy(
                        () ->
                                bootWithFreshPorts(
                                        () -> {
                                            probes.incrementAndGet();
                                            throw failure;
                                        },
                                        () -> {
                                            boots.incrementAndGet();
                                            return null;
                                        }))
                .isSameAs(failure);
        assertThat(probes).hasValue(1);
        assertThat(boots).hasValue(0);
    }

    private static RuntimeException bindConflict() {
        return new RuntimeException("boot failed", new BindException("Address already in use"));
    }

    private static HarnessSessionRef ref(String sessionId) {
        HarnessSessionRef ref = mock(HarnessSessionRef.class);
        when(ref.getHarnessSessionId()).thenReturn(sessionId);
        return ref;
    }
}
