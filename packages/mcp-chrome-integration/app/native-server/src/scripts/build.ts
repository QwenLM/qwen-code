import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const distDir = path.join(__dirname, '..', '..', 'dist');
// 清理上次构建
console.log('清理上次构建...');
try {
  fs.rmSync(distDir, { recursive: true, force: true });
} catch (err) {
  // 忽略目录不存在的错误
  console.log(err);
}

// 创建dist目录
fs.mkdirSync(distDir, { recursive: true });
fs.mkdirSync(path.join(distDir, 'logs'), { recursive: true }); // 创建logs目录
console.log('dist 和 dist/logs 目录已创建/确认存在');

// 编译TypeScript
console.log('编译TypeScript...');
execSync('tsc', { stdio: 'inherit' });

// 复制配置文件
console.log('复制配置文件...');
const configSourcePath = path.join(__dirname, '..', 'mcp', 'stdio-config.json');
const configDestPath = path.join(distDir, 'mcp', 'stdio-config.json');

try {
  // 确保目标目录存在
  fs.mkdirSync(path.dirname(configDestPath), { recursive: true });

  if (fs.existsSync(configSourcePath)) {
    fs.copyFileSync(configSourcePath, configDestPath);
    console.log(`已将 stdio-config.json 复制到 ${configDestPath}`);
  } else {
    console.error(`错误: 配置文件未找到: ${configSourcePath}`);
  }
} catch (error) {
  console.error('复制配置文件时出错:', error);
}

// 复制package.json并更新其内容
console.log('准备package.json...');
const packageJson = require('../../package.json');

// 创建安装说明
const readmeContent = `# ${packageJson.name}

本程序为Chrome扩展的Native Messaging主机端。

## 安装说明

1. 确保已安装Node.js
2. 全局安装本程序:
   \`\`\`
   npm install -g ${packageJson.name}
   \`\`\`
3. 注册Native Messaging主机:
   \`\`\`
   # 用户级别安装（推荐）
   ${packageJson.name} register

   # 如果用户级别安装失败，可以尝试系统级别安装
   ${packageJson.name} register --system
   # 或者使用管理员权限
   sudo ${packageJson.name} register
   \`\`\`

## 使用方法

此应用程序由Chrome扩展自动启动，无需手动运行。
`;

fs.writeFileSync(path.join(distDir, 'README.md'), readmeContent);

console.log('复制包装脚本...');
const scriptsSourceDir = path.join(__dirname, '.');
const macOsWrapperSourcePath = path.join(scriptsSourceDir, 'run_host.sh');
const windowsWrapperSourcePath = path.join(scriptsSourceDir, 'run_host.bat');

const macOsWrapperDestPath = path.join(distDir, 'run_host.sh');
const windowsWrapperDestPath = path.join(distDir, 'run_host.bat');

try {
  if (fs.existsSync(macOsWrapperSourcePath)) {
    fs.copyFileSync(macOsWrapperSourcePath, macOsWrapperDestPath);
    console.log(`已将 ${macOsWrapperSourcePath} 复制到 ${macOsWrapperDestPath}`);
  } else {
    console.error(`错误: macOS 包装脚本源文件未找到: ${macOsWrapperSourcePath}`);
  }

  if (fs.existsSync(windowsWrapperSourcePath)) {
    fs.copyFileSync(windowsWrapperSourcePath, windowsWrapperDestPath);
    console.log(`已将 ${windowsWrapperSourcePath} 复制到 ${windowsWrapperDestPath}`);
  } else {
    console.error(`错误: Windows 包装脚本源文件未找到: ${windowsWrapperSourcePath}`);
  }
} catch (error) {
  console.error('复制包装脚本时出错:', error);
}

// 为关键JavaScript文件和macOS包装脚本添加可执行权限
console.log('添加可执行权限...');
const filesToMakeExecutable = ['index.js', 'cli.js', 'run_host.sh']; // cli.js 假设在 dist 根目录

filesToMakeExecutable.forEach((file) => {
  const filePath = path.join(distDir, file); // filePath 现在是目标路径
  try {
    if (fs.existsSync(filePath)) {
      fs.chmodSync(filePath, '755');
      console.log(`已为 ${file} 添加可执行权限 (755)`);
    } else {
      console.warn(`警告: ${filePath} 不存在，无法添加可执行权限`);
    }
  } catch (error) {
    console.error(`为 ${file} 添加可执行权限时出错:`, error);
  }
});

// Write node_path.txt immediately after build to ensure Chrome uses the correct Node.js version.
// This is critical for development mode where dist is deleted on each rebuild.
// The file points to the same Node.js that compiled the native modules (better-sqlite3 etc.)
console.log('写入 node_path.txt...');
const nodePathFile = path.join(distDir, 'node_path.txt');
fs.writeFileSync(nodePathFile, process.execPath, 'utf8');
console.log(`已写入 Node.js 路径: ${process.execPath}`);

console.log('✅ 构建完成');
