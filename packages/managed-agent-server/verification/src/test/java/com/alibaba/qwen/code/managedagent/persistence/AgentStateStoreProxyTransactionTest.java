package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import org.junit.jupiter.api.Test;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.CALLS_REAL_METHODS;
import static org.mockito.Mockito.mock;

class AgentStateStoreProxyTransactionTest {
    @Test
    void bothCreationBoundariesCommitAndRollbackOnTheDedicatedConnection() throws Exception {
        var source = new DriverManagerDataSource("jdbc:h2:mem:transaction-boundaries-" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1", "sa", "");
        var business = new DriverManagerDataSource("jdbc:h2:mem:host-business-" + UUID.randomUUID(), "sa", "");
        var jdbc = new JdbcTemplate(source);
        jdbc.execute("CREATE TABLE probe (step INTEGER NOT NULL)");
        var fail = new AtomicBoolean();
        var target = mock(ManagedAgentStore.class, invocation -> {
            var method = invocation.getMethod();
            if (method.getName().equals("insertSessionCommand") && method.getParameterCount() == 10
                    || method.getName().equals("insertWorkspaceSessionCommand") && method.getParameterCount() == 1) {
                assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isTrue();
                assertThat(TransactionSynchronizationManager.hasResource(source)).isTrue();
                assertThat(TransactionSynchronizationManager.hasResource(business)).isFalse();
                jdbc.update("INSERT INTO probe VALUES (1)");
                jdbc.update("INSERT INTO probe VALUES (2)");
                if (fail.get()) {
                    throw new IllegalStateException("after both writes");
                }
                return null;
            }
            return CALLS_REAL_METHODS.answer(invocation);
        });
        var beans = new DefaultListableBeanFactory();
        beans.registerSingleton("managedAgentTransactionManager", new DataSourceTransactionManager(source));
        beans.registerSingleton("businessTransactionManager", new DataSourceTransactionManager(business));
        var interceptor = new TransactionInterceptor();
        interceptor.setBeanFactory(beans);
        interceptor.setTransactionAttributeSource(new AnnotationTransactionAttributeSource());
        interceptor.setTransactionManagerBeanName("businessTransactionManager");
        interceptor.afterPropertiesSet();
        var factory = new ProxyFactory(target);
        factory.setProxyTargetClass(true);
        factory.addAdvice(interceptor);
        var proxy = (AgentStateStore) factory.getProxy();
        List<Method> entries = Arrays.stream(AgentStateStore.class.getMethods()).filter(method ->
                method.getName().equals("insertSessionCommand") && method.getParameterCount() == 9
                || method.getName().equals("insertWorkspaceSessionCommand") && method.getParameterCount() == 1).toList();
        assertThat(entries).hasSize(2);
        for (var entry : entries) {
            assertThat(ManagedAgentStore.class.getDeclaredMethod(entry.getName(), entry.getParameterTypes())
                    .getAnnotation(org.springframework.transaction.annotation.Transactional.class)).isNotNull();
            Object[] arguments =
                    Arrays.stream(entry.getParameterTypes())
                            .map(
                                    type -> {
                                        if (type == boolean.class) {
                                            return false;
                                        }
                                        if (type == List.class) {
                                            return List.of();
                                        }
                                        if (type == Set.class) {
                                            return Set.of();
                                        }
                                        return null;
                                    })
                            .toArray();
            fail.set(false);
            entry.invoke(proxy, arguments);
            assertThat(jdbc.queryForList("SELECT step FROM probe ORDER BY step", Integer.class)).containsExactly(1, 2);
            jdbc.update("DELETE FROM probe");
            fail.set(true);
            assertThatThrownBy(() -> entry.invoke(proxy, arguments)).isInstanceOf(InvocationTargetException.class)
                    .hasCauseInstanceOf(IllegalStateException.class);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM probe", Integer.class)).isZero();
        }
    }
}
