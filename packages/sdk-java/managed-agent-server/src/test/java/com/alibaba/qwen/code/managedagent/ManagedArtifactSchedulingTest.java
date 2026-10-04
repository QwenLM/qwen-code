package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.service.MessageMaterializer;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedArtifactReader;
import com.alibaba.qwen.code.managedagent.store.ManagedToolResultProjector;
import com.alibaba.qwen.code.managedagent.store.StoreModels.MaterializationTarget;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationDataStore;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.boot.autoconfigure.task.TaskSchedulingAutoConfiguration;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

class ManagedArtifactSchedulingTest {
    @Configuration
    @EnableScheduling
    static class SchedulingHarness {}

    @Test
    void slowOriginalPublicationReadDoesNotStallMessageMaterializer() throws Exception {
        var fixture = ToolPublicationStoreTest.apiFixture();
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        var data = mock(ToolPublicationDataStore.class, org.mockito.Mockito.withSettings()
                .spiedInstance(fixture.publications()).defaultAnswer(invocation -> {
                    if ("readResource".equals(invocation.getMethod().getName())) {
                        entered.countDown();
                        if (!release.await(5, TimeUnit.SECONDS)) {
                            throw new IllegalStateException("fixture release timeout");
                        }
                    }
                    return invocation.callRealMethod();
                }));
        var beans = new StaticListableBeanFactory();
        beans.addBean("publication", data);
        var provider = beans.getBeanProvider(ToolPublicationDataStore.class);
        fixture.jdbc().update("DELETE FROM managed_agent_artifact");
        fixture.jdbc()
                .update(
                        "UPDATE managed_agent_tool_result SET work_state='PENDING',"
                            + " next_attempt_at=0");
        var state = mock(AgentStateStore.class);
        AtomicInteger materialized = new AtomicInteger();
        when(state.findMaterializationTargets(anyInt()))
                .thenReturn(List.of(new MaterializationTarget("tenant-1", "other-live-session")));
        doAnswer(
                        invocation -> {
                            materialized.incrementAndGet();
                            return null;
                        })
                .when(state)
                .materializeNextBatch(eq("tenant-1"), eq("other-live-session"), anyInt());
        var context = new AnnotationConfigApplicationContext();
        context.register(
                SchedulingHarness.class,
                TaskSchedulingAutoConfiguration.class,
                com.alibaba.qwen.code.managedagent.config.ManagedArtifactConfiguration.class);
        context.registerBean(
                com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.class,
                fixture::properties);
        context.registerBean(
                com.alibaba.qwen.code.managedagent.service.ManagedArtifactPolicy.class,
                fixture::policy);
        context.registerBean(
                "materializer", MessageMaterializer.class, () -> new MessageMaterializer(state));
        context.registerBean(
                "projector",
                ManagedToolResultProjector.class,
                () ->
                        new ManagedToolResultProjector(
                                fixture.results(),
                                fixture.jdbc(),
                                provider,
                                new ManagedArtifactReader(provider),
                                fixture.policy(),
                                fixture.properties()));
        try {
            context.refresh();
            assertThat(entered.await(3, TimeUnit.SECONDS)).isTrue();
            int before = materialized.get();
            Thread.sleep(450);
            int after = materialized.get();
            release.countDown();
            assertThat(after).isGreaterThan(before);
        } finally {
            release.countDown();
            context.close();
        }
    }

    // Parks Boot's shared one-thread scheduler with a long-running
    // @Scheduled sibling: the materialize pass must keep firing on its own
    // pool. This is the arm the publication/preview parking tests cannot
    // see — their slow sibling lives on another dedicated scheduler.
    @Test
    void materializerKeepsPassingWhileTheSharedDefaultPoolIsParked()
            throws Exception {
        var state = mock(AgentStateStore.class);
        AtomicInteger materialized = new AtomicInteger();
        when(state.findMaterializationTargets(anyInt()))
                .thenReturn(List.of(new MaterializationTarget("tenant-1",
                        "session-1")));
        doAnswer(invocation -> {
            materialized.incrementAndGet();
            return null;
        }).when(state).materializeNextBatch(eq("tenant-1"), eq("session-1"),
                anyInt());
        DefaultPoolHog.parked = new CountDownLatch(1);
        DefaultPoolHog.release = new CountDownLatch(1);
        var context = new AnnotationConfigApplicationContext();
        context.register(SchedulingHarness.class,
                TaskSchedulingAutoConfiguration.class,
                com.alibaba.qwen.code.managedagent.config.ManagedArtifactConfiguration.class);
        context.registerBean(
                com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.class,
                com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties::new);
        context.registerBean("materializer", MessageMaterializer.class,
                () -> new MessageMaterializer(state));
        context.registerBean("defaultPoolHog", DefaultPoolHog.class,
                DefaultPoolHog::new);
        try {
            context.refresh();
            assertThat(DefaultPoolHog.parked.await(5, TimeUnit.SECONDS))
                    .isTrue();
            int before = materialized.get();
            Thread.sleep(500);
            DefaultPoolHog.release.countDown();
            assertThat(materialized.get()).isGreaterThan(before);
        } finally {
            DefaultPoolHog.release.countDown();
            context.close();
        }
    }

    static class DefaultPoolHog {
        static volatile CountDownLatch parked;
        static volatile CountDownLatch release;

        @org.springframework.scheduling.annotation.Scheduled(
                fixedDelay = 50)
        void hog() throws InterruptedException {
            parked.countDown();
            release.await(30, TimeUnit.SECONDS);
        }
    }
}
