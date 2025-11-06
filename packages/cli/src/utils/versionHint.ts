import * as fs from 'node:fs';

//  版本号对比
function compareVersion(x: string, y: string): number {
  const arrX = x.split('.');
  const arrY = y.split('.');
  const length = arrX.length > arrY.length ? arrX.length : arrY.length;

  for (let index = 0; index < length; index++) {
    const arrXItem = Number(arrX[index] ?? 0);
    const arrYItem = Number(arrY[index] ?? 0);

    if (arrXItem > arrYItem) {
      return 1;
    } else if (arrXItem < arrYItem) {
      return -1;
    }
  }

  return 0;
}

//  根据当前 CLI 的运行路径，判断安装方式，并返回对应的手动更新命令。
//  如果无法识别，返回提示用户自行处理的文案。
export function getManualUpdateCommand(name: string): string {
  try {
    const cliPath = process.argv[1];
    if (!cliPath) {
      return '暂时无法提供更新命令，请自行查看安装方式并更新。';
    }

    // 获取真实路径，并统一为正斜杠（兼容 Windows）
    const realPath = fs.realpathSync(cliPath).replace(/\\/g, '/');

    // 场景 1: 通过 npx 运行（临时执行）
    if (realPath.includes('/_npx/') || realPath.includes('/npm/_npx')) {
      return '当前通过 npx 临时运行，无需更新。如需长期使用，请全局安装。';
    }

    // 场景 2: 通过 pnpx 运行
    if (realPath.includes('/.pnpm/_pnpx')) {
      return '当前通过 pnpx 临时运行，无需更新。如需长期使用，请全局安装。';
    }

    // 场景 3: 通过 bunx 运行
    if (realPath.includes('/.bun/install/cache')) {
      return '当前通过 bunx 临时运行，无需更新。如需长期使用，请全局安装。';
    }

    // 场景 4: 从本地源码直接运行（开发模式，不在 node_modules 中）
    if (!realPath.includes('/node_modules/')) {
      return '检测到你正在从源码目录运行，请使用 "git pull" 更新代码。';
    }

    // 场景 5: pnpm 全局安装
    if (realPath.includes('/.pnpm/global')) {
      return `pnpm add -g ${name}@latest`;
    }

    // 场景 6: yarn 全局安装
    if (realPath.includes('/.yarn/global')) {
      return `yarn global add ${name}@latest`;
    }

    // 场景 7: bun 全局安装
    if (realPath.includes('/.bun/bin')) {
      return `bun add -g ${name}@latest`;
    }

    // 场景 8: npm 全局安装
    if (realPath.includes('/node_modules/')) {
      return `npm install -g ${name}@latest`;
    }

    // 兜底：以上都没命中
    return '暂时无法提供更新命令，请自行查看安装方式并更新。';
  } catch (_error) {
    // 任何异常都安全降级
    return '暂时无法提供更新命令，请自行查看安装方式并更新。';
  }
}

export async function versionHint(
  version: string,
  name: string,
): Promise<{ tips: string; result: number }> {
  let tips: string;
  let result: number;

  try {
    // 发送 HTTP 请求包的最新信息
    const response = await fetch(`https://registry.npmjs.org/${name}`);
    const data = await response.json();
    // 假设是取这个字段的信息是最新版本号
    const latestVersion = data['dist-tags']['latest'];

    result = compareVersion(version, latestVersion);

    if (result === -1) {
      const updateCommand = getManualUpdateCommand(name);
      tips = `当前版本：${version}，最新版本：${latestVersion}已发布啦!
${updateCommand}`;
    } else {
      tips = `版本：${version}`;
    }
  } catch (_error) {
    tips = `版本校验失败！`;
    result = 0;
  }

  return {
    tips,
    result,
  };
}
