FROM maven:3.9.11-eclipse-temurin-21 AS build

WORKDIR /workspace
COPY packages/sdk-java/qwencode packages/sdk-java/qwencode
COPY packages/sdk-java/runtime-broker packages/sdk-java/runtime-broker
COPY packages/sdk-java/managed-agent-server packages/sdk-java/managed-agent-server
COPY packages/core/src/managed-runtime/contracts/managed-tool-result-v1.schema.json packages/core/src/managed-runtime/contracts/

RUN mvn --batch-mode --no-transfer-progress \
      -f packages/sdk-java/qwencode/pom.xml \
      -DskipTests -Dgpg.skip=true install \
    && mvn --batch-mode --no-transfer-progress \
      -f packages/sdk-java/runtime-broker/pom.xml \
      -DskipTests install \
    && mvn --batch-mode --no-transfer-progress \
      -f packages/sdk-java/managed-agent-server/pom.xml \
      -DskipTests package

FROM eclipse-temurin:21-jre

WORKDIR /app
# Version-independent: the build fails (not a silent bad image) unless the
# package step produced exactly one jar.
COPY --from=build \
  /workspace/packages/sdk-java/managed-agent-server/target/qwen-managed-agent-server-*.jar \
  /app/qwen-managed-agent-server.jar

# A published image must listen beyond loopback for -p to work; the
# application.yml loopback defaults stay host-appropriate.
ENV QWEN_MANAGED_AGENT_SERVER_ADDRESS=0.0.0.0 \
    QWEN_MANAGED_AGENT_RUNTIME_BROKER_HOST=0.0.0.0

EXPOSE 8080 4182
USER 10001
ENTRYPOINT ["java", "-jar", "/app/qwen-managed-agent-server.jar"]
