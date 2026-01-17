#!/usr/bin/env node
import path from 'path';
import { COMMAND_NAME } from './constant';
import { colorText, registerWithElevatedPermissions, writeNodePathFile } from './utils';

/**
 * 主函数
 */
async function main(): Promise<void> {
  console.log(colorText(`正在注册 ${COMMAND_NAME} Native Messaging主机...`, 'blue'));

  try {
    // Write Node.js path before registration
    writeNodePathFile(path.join(__dirname, '..'));

    await registerWithElevatedPermissions();
    console.log(
      colorText('注册成功！现在Chrome扩展可以通过Native Messaging与本地服务通信。', 'green'),
    );
  } catch (error: any) {
    console.error(colorText(`注册失败: ${error.message}`, 'red'));
    process.exit(1);
  }
}

// 执行主函数
main();
