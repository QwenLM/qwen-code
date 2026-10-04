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
      -DskipTests package \
    # The pom attaches classified repackage executions (workspace-bundle,
    # operator-recovery) alongside the unclassified server jar, so a
    # wildcard matches three artifacts and a pinned version drifts. Select
    # the unclassified jar by exclusion and publish it under a fixed name;
    # fail the build (rather than ship a bad image) unless exactly one
    # exists.
    && cd packages/sdk-java/managed-agent-server/target \
    && main="" && count=0 \
    && for f in qwen-managed-agent-server-*.jar; do \
         case "$f" in \
           *-workspace-bundle.jar|*-operator-recovery.jar) ;; \
           *) main="$f"; count=$((count+1)) ;; \
         esac; \
       done \
    && test "$count" -eq 1 \
    && cp "$main" /tmp/qwen-managed-agent-server.jar

FROM eclipse-temurin:21-jre

WORKDIR /app
COPY --from=build /tmp/qwen-managed-agent-server.jar \
  /app/qwen-managed-agent-server.jar

# A published image must listen beyond loopback for -p to work; the
# application.yml loopback defaults stay host-appropriate.
ENV QWEN_MANAGED_AGENT_SERVER_ADDRESS=0.0.0.0 \
    QWEN_MANAGED_AGENT_RUNTIME_BROKER_HOST=0.0.0.0

EXPOSE 8080 4182
USER 10001
ENTRYPOINT ["java", "-jar", "/app/qwen-managed-agent-server.jar"]
