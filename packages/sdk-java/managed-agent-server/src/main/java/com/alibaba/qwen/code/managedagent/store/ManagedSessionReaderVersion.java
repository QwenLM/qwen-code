package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import org.springframework.http.HttpStatus;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

/** The ceiling of a remote Store reader; in-process readers support both formats. */
final class ManagedSessionReaderVersion {
    static final String HEADER = "X-Qwen-Managed-Max-Readable-Storage-Version";
    static final int SUPPORTED = 2;

    private ManagedSessionReaderVersion() {}

    static void requireReadable(int floor) {
        int ceiling = SUPPORTED;
        if (RequestContextHolder.getRequestAttributes() instanceof ServletRequestAttributes attributes) {
            var request = attributes.getRequest();
            String path = request.getRequestURI().substring(request.getContextPath().length());
            if (path.startsWith("/internal/managed-session-store/")
                    || path.startsWith("/internal/managed-tool-publications/")) {
                String header = request.getHeader(HEADER);
                if (header != null && !header.matches("[12]")) {
                    throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_managed_session_reader_version",
                            "The Managed Session reader version is invalid.");
                }
                ceiling = header == null ? 1 : Integer.parseInt(header);
            }
        }
        if (floor > ceiling) {
            throw new ApiException(HttpStatus.CONFLICT, "managed_session_reader_version_unsupported",
                    "This reader cannot read the Managed Session storage version.");
        }
    }
}
