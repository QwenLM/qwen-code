package com.alibaba.qwen.code.managedagent.config;

import org.aopalliance.intercept.MethodInterceptor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.beans.factory.BeanFactory;
import org.springframework.beans.factory.config.BeanDefinition;
import org.springframework.beans.factory.support.AbstractBeanDefinition;
import org.springframework.beans.factory.support.BeanDefinitionRegistry;
import org.springframework.beans.factory.support.RootBeanDefinition;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.ImportBeanDefinitionRegistrar;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.Environment;
import org.springframework.core.io.ResourceLoader;
import org.springframework.core.type.AnnotationMetadata;

import java.util.LinkedHashMap;
import java.util.Map;

public final class EmbeddedManagedAgentBootstrap implements AutoCloseable {
    private static final Logger LOG = LoggerFactory.getLogger(EmbeddedManagedAgentBootstrap.class);

    private final AnnotationConfigApplicationContext context;
    private RuntimeException initializationFailure;

    public EmbeddedManagedAgentBootstrap(ResourceLoader host, Environment environment, BeanFactory beanFactory) {
        context = new AnnotationConfigApplicationContext();
        context.setParent((ApplicationContext) host);
        context.setEnvironment((ConfigurableEnvironment) environment);
        context.register(ManagedAgentConfiguration.class);
        try {
            context.refresh();
        } catch (RuntimeException failure) {
            initializationFailure = failure;
        }
        Map<String, Class<?>> beanTypes = beanTypes((BeanDefinitionRegistry) beanFactory);
        if (initializationFailure != null) {
            context.close();
            LOG.warn("Embedded Managed Agent initialization failed; API beans will reject invocations", initializationFailure);
        }
        exposeBeans((BeanDefinitionRegistry) beanFactory, beanTypes);
    }

    private Map<String, Class<?>> beanTypes(BeanDefinitionRegistry registry) {
        var types = new LinkedHashMap<String, Class<?>>();
        for (String name : context.getBeanDefinitionNames()) {
            if (isManagedBean(context.getBeanDefinition(name)) && !registry.containsBeanDefinition(name)) {
                types.put(name, context.getBeanFactory().getType(name));
            }
        }
        return types;
    }

    private void exposeBeans(BeanDefinitionRegistry registry, Map<String, Class<?>> beanTypes) {
        for (var entry : beanTypes.entrySet()) {
            String name = entry.getKey();
            Class<?> beanType = entry.getValue();
            BeanDefinition definition = context.getBeanDefinition(name);
            if (beanType == null) {
                throw new IllegalStateException("Cannot determine the type of " + name, initializationFailure);
            }
            RootBeanDefinition exposed = definition instanceof RootBeanDefinition original
                    ? new RootBeanDefinition(original)
                    : new RootBeanDefinition(beanType);
            if (definition instanceof AbstractBeanDefinition original) {
                exposed.setDefaultCandidate(original.isDefaultCandidate());
            }
            exposed.setDestroyMethodName("");
            if (initializationFailure == null) {
                exposed.setInstanceSupplier(() -> context.getBean(name, beanType));
            } else {
                exposed.setInstanceSupplier(() -> failureProxy(beanType, initializationFailure));
            }
            registry.registerBeanDefinition(name, exposed);
        }
    }

    private boolean isManagedBean(BeanDefinition definition) {
        String owner = definition.getBeanClassName();
        if (definition.getFactoryBeanName() != null && context.containsBeanDefinition(definition.getFactoryBeanName())) {
            owner = context.getBeanDefinition(definition.getFactoryBeanName()).getBeanClassName();
        }
        return owner != null && owner.startsWith("com.alibaba.qwen.");
    }

    @Override
    public void close() {
        context.close();
    }

    private static <T> T failureProxy(Class<T> type, RuntimeException failure) {
        IllegalStateException unavailable = new IllegalStateException("Embedded Managed Agent is unavailable", failure);
        var proxy = new ProxyFactory();
        if (type.isInterface()) {
            proxy.setInterfaces(type);
        } else {
            proxy.setTargetClass(type);
        }
        proxy.addAdvice(new RejectionHandler(unavailable));
        return type.cast(proxy.getProxy(type.getClassLoader()));
    }

    private record RejectionHandler(IllegalStateException failure) implements MethodInterceptor {
        @Override
        public Object invoke(org.aopalliance.intercept.MethodInvocation invocation) throws Throwable {
            String method = invocation.getMethod().getName();
            return switch (method) {
                case "toString" -> "Unavailable Managed Agent";
                case "equals" -> invocation.getThis() == invocation.getArguments()[0];
                case "hashCode" -> System.identityHashCode(invocation.getThis());
                case "close" -> null;
                default -> throw failure;
            };
        }
    }

    public static class Registrar implements ImportBeanDefinitionRegistrar {
        @Override
        public void registerBeanDefinitions(AnnotationMetadata metadata, BeanDefinitionRegistry registry) {
            var definition = new RootBeanDefinition(EmbeddedManagedAgentBootstrap.class);
            definition.setAutowireMode(RootBeanDefinition.AUTOWIRE_CONSTRUCTOR);
            definition.setDefaultCandidate(false);
            definition.setRole(BeanDefinition.ROLE_INFRASTRUCTURE);
            registry.registerBeanDefinition(EmbeddedManagedAgentBootstrap.class.getName(), definition);
        }
    }
}
