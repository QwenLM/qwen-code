package com.alibaba.qwen.code.managedagent.api;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.core.MethodParameter;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;

@Component
public class TenantContextArgumentResolver
        implements HandlerMethodArgumentResolver {
    @Override
    public boolean supportsParameter(MethodParameter parameter) {
        return TenantContext.class.equals(parameter.getParameterType());
    }

    @Override
    public Object resolveArgument(MethodParameter parameter,
            ModelAndViewContainer container, NativeWebRequest request,
            WebDataBinderFactory binderFactory) {
        HttpServletRequest servletRequest = request.getNativeRequest(
                HttpServletRequest.class);
        if (servletRequest == null) {
            throw new IllegalStateException("HTTP request is unavailable");
        }
        Object context = servletRequest.getAttribute(
                TenantContextFilter.ATTRIBUTE);
        if (!(context instanceof TenantContext)) {
            throw new IllegalStateException("Tenant context is unavailable");
        }
        return context;
    }
}
