# Copyright 2026 Qwen Team
# SPDX-License-Identifier: Apache-2.0

from harbor.agents.installed.qwen_code import QwenCode
from harbor.environments.base import BaseEnvironment

NVM_SHA256 = "9290aec6cc2efc89273e16a77214eb37303caaff8c943102de5116fdef47ba86"
NVM_EXEC_SHA256 = (
    "e6b7a2bafac6994e1ba14282cff82c75476fba0788f68a9ecf558dfdf3331621"
)
BASH_COMPLETION_SHA256 = (
    "b7eb3bf03d59b61e451957b020640aa55fe8bf47fb39d85d244e259f445d2fbe"
)


class QwenCoderMirror(QwenCode):
    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command="apt-get update && apt-get install -y curl",
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        version_spec = f"@{self._version}" if self._version else "@latest"
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                'export NVM_DIR="$HOME/.nvm"; '
                'mkdir -p "$NVM_DIR"; '
                'cd "$NVM_DIR"; '
                "curl --fail --silent --show-error --location "
                "https://gitee.com/mirrors/nvm/raw/v0.40.2/nvm.sh "
                "-o nvm.sh && "
                "curl --fail --silent --show-error --location "
                "https://gitee.com/mirrors/nvm/raw/v0.40.2/nvm-exec "
                "-o nvm-exec && "
                "curl --fail --silent --show-error --location "
                "https://gitee.com/mirrors/nvm/raw/v0.40.2/bash_completion "
                "-o bash_completion && "
                f"printf '%s\\n' '{NVM_SHA256}  nvm.sh' "
                f"'{NVM_EXEC_SHA256}  nvm-exec' "
                f"'{BASH_COMPLETION_SHA256}  bash_completion' | "
                "sha256sum --check --status && "
                "chmod +x nvm-exec && "
                "\\. ./nvm.sh && "
                "nvm install 22 && npm -v && "
                f"npm install -g @qwen-code/qwen-code{version_spec} && "
                "qwen --version"
            ),
        )
