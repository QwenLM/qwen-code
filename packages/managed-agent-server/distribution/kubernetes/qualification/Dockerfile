ARG SERVER_IMAGE
ARG HARNESS_IMAGE
FROM ${SERVER_IMAGE} AS server
FROM ${HARNESS_IMAGE}

USER 0:0
RUN apt-get update && apt-get install -y --no-install-recommends bash git procps util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 qwen \
    && useradd --uid 10001 --gid 10001 --home-dir /data/home --no-create-home qwen \
    && mkdir -p /data/home /data/runtime /data/default-workspace /data/workspaces \
    && chown -R 10001:10001 /data \
    && chmod 700 /data/home /data/runtime /data/default-workspace /data/workspaces
COPY --from=server /opt/java/openjdk /opt/java/openjdk
COPY --from=server /app/qwen-managed-agent-server.jar /app/qwen-managed-agent-server.jar
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH=/opt/java/openjdk/bin:${PATH}
ENV HOME=/data/home
ENV QWEN_HOME=/data/home/.qwen
ENV QWEN_MANAGED_AGENT_NODE_EXECUTABLE=/usr/local/bin/node
ENV QWEN_MANAGED_AGENT_RUNTIME_WORKER_ENTRY=/usr/local/lib/node_modules/@qwen-code/qwen-code/cli.js
ENV QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY=/data/runtime
ENV QWEN_MANAGED_AGENT_WORKSPACE_CWD=/data/default-workspace
ENV QWEN_MANAGED_AGENT_WORKSPACE_CREATION_ROOT=/data/workspaces
ENV QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY=false
RUN java -version && node --version \
    && test -f /usr/local/lib/node_modules/@qwen-code/qwen-code/cli.js
USER 10001:10001
WORKDIR /data/default-workspace
ENTRYPOINT ["java", "-jar", "/app/qwen-managed-agent-server.jar"]
