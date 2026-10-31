ARG SERVER_IMAGE
ARG HARNESS_IMAGE
FROM ${SERVER_IMAGE} AS server

FROM ${HARNESS_IMAGE}

USER root
COPY --from=server /opt/java/openjdk /opt/java/openjdk
COPY --from=server /app/qwen-managed-agent-server.jar /app/qwen-managed-agent-server.jar
COPY --chmod=755 deploy/kubernetes/start-server.sh /opt/qwen/bin/start-server
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH=/opt/java/openjdk/bin:$PATH

RUN useradd --uid 10001 --gid 1000 --home-dir /runtime-data/home --no-create-home qwen-managed \
    && node --version \
    && java -version \
    && test -r /usr/local/share/npm-global/lib/node_modules/@qwen-code/qwen-code/cli.js \
    && test -x /usr/bin/stat

USER 10001
ENTRYPOINT ["/opt/qwen/bin/start-server"]
CMD []
