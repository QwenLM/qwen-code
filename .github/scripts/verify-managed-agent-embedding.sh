#!/usr/bin/env bash
set -euo pipefail
managed_version="$(mvn --batch-mode --no-transfer-progress help:evaluate -Dexpression=project.version -q -DforceStdout -Dstyle.color=never)"
mvn --batch-mode --no-transfer-progress -pl server -am -DskipTests -Dgpg.skip=true install
mvn --batch-mode --no-transfer-progress -f verification/src/test/embedding-host/pom.xml -Dmanaged-agent.version="${managed_version}" -Dtest=EmbeddingHostTest -DfailIfNoTests=true test
mvn --batch-mode --no-transfer-progress -f verification/src/test/embedding-host/pom.xml -Dmanaged-agent.version="${managed_version}" -Dtest=EnabledHostTest -DfailIfNoTests=true -Pembedded test
