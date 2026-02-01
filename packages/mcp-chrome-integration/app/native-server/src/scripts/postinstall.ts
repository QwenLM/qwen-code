#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { COMMAND_NAME } from './constant';
import { colorText, tryRegisterUserLevelHost, writeNodePathFile } from './utils';

// Check if this script is run directly
const isDirectRun = require.main === module;

// Detect global installation for both npm and pnpm
function detectGlobalInstall(): boolean {
  // npm uses npm_config_global
  if (process.env.npm_config_global === 'true') {
    return true;
  }

  // pnpm detection methods
  // Method 1: Check if PNPM_HOME is set and current path contains it
  if (process.env.PNPM_HOME && __dirname.includes(process.env.PNPM_HOME)) {
    return true;
  }

  // Method 2: Check if we're in a global pnpm directory structure
  // pnpm global packages are typically installed in ~/.local/share/pnpm/global/5/node_modules
  // Windows: %APPDATA%\pnpm\global\5\node_modules
  const globalPnpmPatterns =
    process.platform === 'win32'
      ? ['\\pnpm\\global\\', '\\pnpm-global\\', '\\AppData\\Roaming\\pnpm\\']
      : ['/pnpm/global/', '/.local/share/pnpm/', '/pnpm-global/'];

  if (globalPnpmPatterns.some((pattern) => __dirname.includes(pattern))) {
    return true;
  }

  // Method 3: Check npm_config_prefix for pnpm
  if (process.env.npm_config_prefix && __dirname.includes(process.env.npm_config_prefix)) {
    return true;
  }

  // Method 4: Windows-specific global installation paths
  if (process.platform === 'win32') {
    const windowsGlobalPatterns = [
      '\\npm\\node_modules\\',
      '\\AppData\\Roaming\\npm\\node_modules\\',
      '\\Program Files\\nodejs\\node_modules\\',
      '\\nodejs\\node_modules\\',
    ];

    if (windowsGlobalPatterns.some((pattern) => __dirname.includes(pattern))) {
      return true;
    }
  }

  return false;
}

const isGlobalInstall = detectGlobalInstall();

/**
 * Detect if running with elevated privileges (sudo/admin)
 * This can cause issues because user-level registration will go to root's home directory
 */
function isRunningElevated(): boolean {
  if (process.platform === 'win32') {
    // On Windows, check common admin indicators
    // Note: Full admin check requires is-admin package which is ESM
    return false; // Skip for now, Windows npm usually doesn't run as admin by default
  } else {
    // On Unix, check if running as root (UID 0)
    return process.getuid?.() === 0;
  }
}

/**
 * 确保执行权限（无论是否为全局安装）
 */
async function ensureExecutionPermissions(): Promise<void> {
  if (process.platform === 'win32') {
    // Windows 平台处理
    await ensureWindowsFilePermissions();
    return;
  }

  // Unix/Linux 平台处理
  const filesToCheck = [
    path.join(__dirname, '..', 'index.js'),
    path.join(__dirname, '..', 'run_host.sh'),
    path.join(__dirname, '..', 'cli.js'),
  ];

  for (const filePath of filesToCheck) {
    if (fs.existsSync(filePath)) {
      try {
        fs.chmodSync(filePath, '755');
        console.log(
          colorText(`✓ Set execution permissions for ${path.basename(filePath)}`, 'green'),
        );
      } catch (err: any) {
        console.warn(
          colorText(
            `⚠️ Unable to set execution permissions for ${path.basename(filePath)}: ${err.message}`,
            'yellow',
          ),
        );
      }
    } else {
      console.warn(colorText(`⚠️ File not found: ${filePath}`, 'yellow'));
    }
  }
}

/**
 * Windows 平台文件权限处理
 */
async function ensureWindowsFilePermissions(): Promise<void> {
  const filesToCheck = [
    path.join(__dirname, '..', 'index.js'),
    path.join(__dirname, '..', 'run_host.bat'),
    path.join(__dirname, '..', 'cli.js'),
  ];

  for (const filePath of filesToCheck) {
    if (fs.existsSync(filePath)) {
      try {
        // 检查文件是否为只读，如果是则移除只读属性
        const stats = fs.statSync(filePath);
        if (!(stats.mode & parseInt('200', 8))) {
          // 检查写权限
          // 尝试移除只读属性
          fs.chmodSync(filePath, stats.mode | parseInt('200', 8));
          console.log(
            colorText(`✓ Removed read-only attribute from ${path.basename(filePath)}`, 'green'),
          );
        }

        // 验证文件可读性
        fs.accessSync(filePath, fs.constants.R_OK);
        console.log(
          colorText(`✓ Verified file accessibility for ${path.basename(filePath)}`, 'green'),
        );
      } catch (err: any) {
        console.warn(
          colorText(
            `⚠️ Unable to verify file permissions for ${path.basename(filePath)}: ${err.message}`,
            'yellow',
          ),
        );
      }
    } else {
      console.warn(colorText(`⚠️ File not found: ${filePath}`, 'yellow'));
    }
  }
}

async function tryRegisterNativeHost(): Promise<void> {
  try {
    console.log(colorText('Attempting to register Chrome Native Messaging host...', 'blue'));

    // Always ensure execution permissions, regardless of installation type
    await ensureExecutionPermissions();

    // Check if running with elevated privileges
    if (isRunningElevated()) {
      console.log(
        colorText('\n⚠️  WARNING: Running with elevated privileges (sudo/root)', 'yellow'),
      );
      console.log(
        colorText("   User-level registration will be written to root's home directory,", 'yellow'),
      );
      console.log(
        colorText('   which may not work correctly for your normal user account.', 'yellow'),
      );
      console.log(
        colorText(
          '\n   Please run the following command as your normal user after installation:',
          'blue',
        ),
      );
      console.log(`   ${COMMAND_NAME} register`);
      console.log(colorText('\n   Or if you need system-level installation, use:', 'blue'));
      console.log(`   sudo ${COMMAND_NAME} register --system`);
      // Skip automatic registration when running as root
      return;
    }

    if (isGlobalInstall) {
      // First try user-level installation (no elevated permissions required)
      const userLevelSuccess = await tryRegisterUserLevelHost();

      if (!userLevelSuccess) {
        // User-level installation failed, suggest using register command
        console.log(
          colorText(
            'User-level installation failed, system-level installation may be needed',
            'yellow',
          ),
        );
        console.log(
          colorText('Please run the following command for system-level installation:', 'blue'),
        );
        console.log(`  ${COMMAND_NAME} register --system`);
        printManualInstructions();
      }
    } else {
      // Local installation mode, don't attempt automatic registration
      console.log(
        colorText('Local installation detected, skipping automatic registration', 'yellow'),
      );
      printManualInstructions();
    }
  } catch (error) {
    console.log(
      colorText(
        `注册过程中出现错误: ${error instanceof Error ? error.message : String(error)}`,
        'red',
      ),
    );
    printManualInstructions();
  }
}

/**
 * 打印手动安装指南
 */
function printManualInstructions(): void {
  console.log('\n' + colorText('===== Manual Registration Guide =====', 'blue'));

  console.log(colorText('1. Try user-level installation (recommended):', 'yellow'));
  if (isGlobalInstall) {
    console.log(`  ${COMMAND_NAME} register`);
  } else {
    console.log(`  npx ${COMMAND_NAME} register`);
  }

  console.log(
    colorText('\n2. If user-level installation fails, try system-level installation:', 'yellow'),
  );

  console.log(colorText('   Use --system parameter (requires admin privileges):', 'yellow'));
  if (isGlobalInstall) {
    console.log(`  ${COMMAND_NAME} register --system`);
  } else {
    console.log(`  npx ${COMMAND_NAME} register --system`);
  }

  console.log(colorText('\n   Or use administrator privileges directly:', 'yellow'));
  if (os.platform() === 'win32') {
    console.log(
      colorText(
        '   Please run Command Prompt or PowerShell as administrator and execute:',
        'yellow',
      ),
    );
    if (isGlobalInstall) {
      console.log(`  ${COMMAND_NAME} register`);
    } else {
      console.log(`  npx ${COMMAND_NAME} register`);
    }
  } else {
    console.log(colorText('   Please run the following command in terminal:', 'yellow'));
    if (isGlobalInstall) {
      console.log(`  sudo ${COMMAND_NAME} register`);
    } else {
      console.log(`  sudo npx ${COMMAND_NAME} register`);
    }
  }

  console.log(
    '\n' +
      colorText(
        'Ensure Chrome extension is installed and refresh the extension to connect to local service.',
        'blue',
      ),
  );
}

/**
 * 主函数
 */
async function main(): Promise<void> {
  console.log(colorText(`Installing ${COMMAND_NAME}...`, 'green'));

  // Debug information
  console.log(colorText('Installation environment debug info:', 'blue'));
  console.log(`  __dirname: ${__dirname}`);
  console.log(`  npm_config_global: ${process.env.npm_config_global}`);
  console.log(`  PNPM_HOME: ${process.env.PNPM_HOME}`);
  console.log(`  npm_config_prefix: ${process.env.npm_config_prefix}`);
  console.log(`  isGlobalInstall: ${isGlobalInstall}`);

  // Always ensure execution permissions first
  await ensureExecutionPermissions();

  // Write Node.js path for run_host scripts to use
  writeNodePathFile(path.join(__dirname, '..'));

  // If global installation, try automatic registration
  if (isGlobalInstall) {
    await tryRegisterNativeHost();
  } else {
    console.log(colorText('Local installation detected', 'yellow'));
    printManualInstructions();
  }
}

// Only execute main function when running this script directly
if (isDirectRun) {
  main().catch((error) => {
    console.error(
      colorText(
        `Installation script error: ${error instanceof Error ? error.message : String(error)}`,
        'red',
      ),
    );
    // Set non-zero exit code to indicate installation failure
    process.exitCode = 1;
  });
}
