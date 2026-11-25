package com.alibaba.qwen.code.managedagent.config;

import org.aopalliance.intercept.MethodInterceptor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.aop.TargetSource;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.core.env.ConfigurableEnvironment;

public final class EmbeddedManagedAgentBootstrap implements AutoCloseable, SmartInitializingSingleton {
    private static final Logger LOG = LoggerFactory.getLogger(EmbeddedManagedAgentBootstrap.class);

    private final ApplicationContext host;
    private final ConfigurableEnvironment environment;
    private AnnotationConfigApplicationContext context;
    private RuntimeException initializationFailure;
    private volatile boolean initialized;

    public EmbeddedManagedAgentBootstrap(ApplicationContext host, ConfigurableEnvironment environment) {
        this.host = host;
        this.environment = environment;
    }

    public <T> T bridge(Class<T> service) {
        var proxy = new ProxyFactory();
        if (service.isInterface()) {
            proxy.setInterfaces(service);
        } else {
            proxy.setTargetClass(service);
            proxy.setProxyTargetClass(true);
        }
        proxy.setTargetSource(new ManagedTargetSource<>(this, service));
        proxy.addAdvice(new BridgeAdvice(service));
        return service.cast(proxy.getProxy(host.getClassLoader()));
    }

    public boolean isAvailable() {
        return initialized && initializationFailure == null && context.isActive();
    }

    @Override
    public void afterSingletonsInstantiated() {
        initialize();
    }

    private synchronized void initialize() {
        if (initialized) {
            return;
        }
        context = new AnnotationConfigApplicationContext();
        context.setParent(host);
        context.setEnvironment(environment);
        context.register(ManagedAgentConfiguration.class);
        try {
            context.refresh();
        } catch (RuntimeException failure) {
            initializationFailure = failure;
            context.close();
            LOG.warn("Embedded Managed Agent initialization failed; public services will reject invocations", failure);
        } finally {
            initialized = true;
        }
    }

    private Object resolve(Class<?> service) {
        initialize();
        if (initializationFailure != null) {
            throw new IllegalStateException("Embedded Managed Agent is unavailable", initializationFailure);
        }
        return context.getBean(service);
    }

    @Override
    public synchronized void close() {
        if (context != null && context.isActive()) {
            context.close();
        }
    }

    private record ManagedTargetSource<T>(EmbeddedManagedAgentBootstrap owner, Class<T> service) implements TargetSource {
        @Override
        public Class<T> getTargetClass() {
            return service;
        }

        @Override
        public boolean isStatic() {
            return false;
        }

        @Override
        public Object getTarget() {
            return owner.resolve(service);
        }

        @Override
        public void releaseTarget(Object target) {
        }
    }

    private record BridgeAdvice(Class<?> service) implements MethodInterceptor {
        @Override
        public Object invoke(org.aopalliance.intercept.MethodInvocation invocation) throws Throwable {
            if (invocation.getMethod().getDeclaringClass() == Object.class) {
                return switch (invocation.getMethod().getName()) {
                    case "toString" -> "Embedded Managed Agent proxy for " + service.getName();
                    case "equals" -> invocation.getThis() == invocation.getArguments()[0];
                    default -> System.identityHashCode(invocation.getThis());
                };
            }
            return invocation.proceed();
        }
    }
}
