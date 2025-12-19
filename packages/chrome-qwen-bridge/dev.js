#!/usr/bin/env node

/**
 * 开发环境一键启动脚本
 * 自动完成所有配置和启动步骤
 */

const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m'
};

function log(message, color = '') {
  console.log(`${color}${message}${colors.reset}`);
}

function logStep(step, message) {
  log(`\n[${step}] ${message}`, colors.bright + colors.blue);
}

function logSuccess(message) {
  log(`✅ ${message}`, colors.green);
}

function logWarning(message) {
  log(`⚠️  ${message}`, colors.yellow);
}

function logError(message) {
  log(`❌ ${message}`, colors.red);
}

function logInfo(message) {
  log(`ℹ️  ${message}`, colors.cyan);
}

// 检查命令是否存在
function commandExists(command) {
  return new Promise((resolve) => {
    exec(`command -v ${command}`, (error) => {
      resolve(!error);
    });
  });
}

// 获取 Chrome 路径
function getChromePath() {
  const platform = process.platform;

  const chromePaths = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium'
    ]
  };

  const paths = chromePaths[platform] || [];

  for (const chromePath of paths) {
    if (fs.existsSync(chromePath)) {
      return chromePath;
    }
  }

  return null;
}

// 获取扩展 ID
function getExtensionId(extensionPath) {
  // 这是一个简化的方法，实际的 Extension ID 是通过 Chrome 生成的
  // 开发时可以固定使用一个 ID
  return 'development-extension-id';
}

// 安装 Native Host
async function installNativeHost(extensionPath) {
  logStep(2, 'Installing Native Host...');

  const hostPath = path.join(extensionPath, 'native-host');
  const scriptPath = path.join(hostPath, 'host.js');

  if (!fs.existsSync(scriptPath)) {
    logError('Native host script not found!');
    return false;
  }

  const platform = process.platform;
  const hostName = 'com.qwen.cli.bridge';

  let manifestDir;
  if (platform === 'darwin') {
    manifestDir = path.join(os.homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts');
  } else if (platform === 'linux') {
    manifestDir = path.join(os.homedir(), '.config/google-chrome/NativeMessagingHosts');
  } else if (platform === 'win32') {
    // Windows 需要写注册表
    logWarning('Windows requires registry modification. Please run install.bat manually.');
    return true;
  } else {
    logError('Unsupported platform');
    return false;
  }

  // 创建目录
  if (!fs.existsSync(manifestDir)) {
    fs.mkdirSync(manifestDir, { recursive: true });
  }

  // 创建 manifest 文件
  const manifest = {
    name: hostName,
    description: 'Native messaging host for Qwen CLI Bridge',
    path: scriptPath,
    type: 'stdio',
    allowed_origins: [
      'chrome-extension://jniepomhbdkeifkadbfolbcihcmfpfjo/',  // 开发用 ID
      'chrome-extension://*/'  // 允许任何扩展（仅开发环境）
    ]
  };

  const manifestPath = path.join(manifestDir, `${hostName}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  logSuccess(`Native Host installed at: ${manifestPath}`);
  return true;
}

// 检查 Qwen CLI
async function checkQwenCli() {
  logStep(3, 'Checking Qwen CLI...');

  const qwenExists = await commandExists('qwen');

  if (qwenExists) {
    logSuccess('Qwen CLI is installed');

    // 获取版本
    return new Promise((resolve) => {
      exec('qwen --version', (error, stdout) => {
        if (!error && stdout) {
          logInfo(`Version: ${stdout.trim()}`);
        }
        resolve(true);
      });
    });
  } else {
    logWarning('Qwen CLI is not installed');
    logInfo('You can still use the extension, but some features will be limited');
    return false;
  }
}

// 启动 Qwen CLI 服务器
function startQwenServer(port = 8080) {
  logStep(4, 'Starting Qwen CLI Server...');

  return new Promise((resolve) => {
    // 检查端口是否被占用
    exec(`lsof -i:${port} || netstat -an | grep ${port}`, (error, stdout) => {
      if (stdout && stdout.length > 0) {
        logWarning(`Port ${port} is already in use`);
        logInfo('Qwen server might already be running');
        resolve(null);
        return;
      }

      // 启动服务器
      const qwenProcess = spawn('qwen', ['server', '--port', String(port)], {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      qwenProcess.stdout.on('data', (data) => {
        const output = data.toString();
        if (output.includes('Server started') || output.includes('listening')) {
          logSuccess(`Qwen server started on port ${port}`);
          resolve(qwenProcess);
        }
      });

      qwenProcess.stderr.on('data', (data) => {
        logError(`Qwen server error: ${data}`);
      });

      qwenProcess.on('error', (error) => {
        logError(`Failed to start Qwen server: ${error.message}`);
        resolve(null);
      });

      // 超时处理
      setTimeout(() => {
        logWarning('Qwen server start timeout, continuing anyway...');
        resolve(qwenProcess);
      }, 5000);
    });
  });
}

// 启动 Chrome 开发模式
function startChrome(extensionPath, chromePath) {
  logStep(5, 'Starting Chrome with extension...');

  const args = [
    `--load-extension=${extensionPath}`,
    '--auto-open-devtools-for-tabs',  // 自动打开 DevTools
    '--disable-extensions-except=' + extensionPath,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-popup-blocking',
    '--disable-translate',
    '--disable-sync',
    '--no-pings',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-device-discovery-notifications'
  ];

  // 开发模式特定参数
  if (process.env.DEBUG === 'true') {
    args.push('--enable-logging=stderr');
    args.push('--v=1');
  }

  // 添加测试页面
  args.push('http://localhost:3000'); // 或其他测试页面

  const chromeProcess = spawn(chromePath, args, {
    detached: false,
    stdio: 'inherit'
  });

  chromeProcess.on('error', (error) => {
    logError(`Failed to start Chrome: ${error.message}`);
  });

  logSuccess('Chrome started with extension loaded');
  logInfo('Extension should be visible in the toolbar');

  return chromeProcess;
}

// 创建测试服务器
function createTestServer(port = 3000) {
  logStep(6, 'Starting test server...');

  const http = require('http');
  const testHtml = `
<!DOCTYPE html>
<html>
<head>
    <title>Qwen CLI Bridge Test Page</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 40px 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
        }
        .container {
            background: white;
            padding: 40px;
            border-radius: 10px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
        }
        h1 {
            color: #333;
            border-bottom: 3px solid #667eea;
            padding-bottom: 10px;
        }
        .test-content {
            margin: 20px 0;
        }
        .test-button {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 5px;
            cursor: pointer;
            margin: 5px;
        }
        .test-button:hover {
            opacity: 0.9;
        }
        #console-output {
            background: #f5f5f5;
            padding: 10px;
            border-radius: 5px;
            font-family: monospace;
            min-height: 100px;
            margin-top: 20px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 Qwen CLI Bridge Test Page</h1>

        <div class="test-content">
            <h2>Test Content</h2>
            <p>This is a test page for the Qwen CLI Bridge Chrome Extension.</p>
            <p>Click the extension icon in your toolbar to start testing!</p>

            <h3>Sample Data</h3>
            <ul>
                <li>Item 1: Lorem ipsum dolor sit amet</li>
                <li>Item 2: Consectetur adipiscing elit</li>
                <li>Item 3: Sed do eiusmod tempor incididunt</li>
            </ul>

            <h3>Test Actions</h3>
            <button class="test-button" onclick="testLog()">Test Console Log</button>
            <button class="test-button" onclick="testError()">Test Console Error</button>
            <button class="test-button" onclick="testNetwork()">Test Network Request</button>

            <h3>Console Output</h3>
            <div id="console-output"></div>
        </div>

        <div class="test-content">
            <h2>Test Form</h2>
            <form>
                <input type="text" placeholder="Test input" style="padding: 5px; margin: 5px;">
                <textarea placeholder="Test textarea" style="padding: 5px; margin: 5px;"></textarea>
                <select style="padding: 5px; margin: 5px;">
                    <option>Option 1</option>
                    <option>Option 2</option>
                </select>
            </form>
        </div>

        <div class="test-content">
            <h2>Images</h2>
            <img src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjEwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMjAwIiBoZWlnaHQ9IjEwMCIgZmlsbD0iIzY2N2VlYSIvPjx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBmaWxsPSJ3aGl0ZSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZHk9Ii4zZW0iPjIwMHgxMDA8L3RleHQ+PC9zdmc+" alt="Test Image">
        </div>
    </div>

    <script>
        function addOutput(message, type = 'log') {
            const output = document.getElementById('console-output');
            const time = new Date().toLocaleTimeString();
            const color = type === 'error' ? 'red' : type === 'warn' ? 'orange' : 'black';
            output.innerHTML += \`<div style="color: \${color}">[\${time}] \${message}</div>\`;
            console[type](message);
        }

        function testLog() {
            addOutput('This is a test log message', 'log');
        }

        function testError() {
            addOutput('This is a test error message', 'error');
        }

        async function testNetwork() {
            addOutput('Making network request...', 'log');
            try {
                const response = await fetch('https://api.github.com/users/github');
                const data = await response.json();
                addOutput('Network request successful: ' + JSON.stringify(data).substring(0, 100) + '...', 'log');
            } catch (error) {
                addOutput('Network request failed: ' + error.message, 'error');
            }
        }

        // 自动记录一些日志
        console.log('Test page loaded');
        console.info('Extension test environment ready');
    </script>
</body>
</html>
  `;

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(testHtml);
  });

  server.listen(port, () => {
    logSuccess(`Test server running at http://localhost:${port}`);
  });

  return server;
}

// 主函数
async function main() {
  console.clear();
  log(`
╔════════════════════════════════════════════════════════════════╗
║                                                                ║
║     🚀 Qwen CLI Bridge - Development Environment Setup        ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝
`, colors.bright + colors.cyan);

  const extensionPath = path.join(__dirname, 'extension');

  // Step 1: 检查 Chrome
  logStep(1, 'Checking Chrome installation...');
  const chromePath = getChromePath();

  if (!chromePath) {
    logError('Chrome not found! Please install Google Chrome.');
    process.exit(1);
  }

  logSuccess(`Chrome found at: ${chromePath}`);

  // Step 2: 安装 Native Host
  const nativeHostInstalled = await installNativeHost(__dirname);
  if (!nativeHostInstalled && process.platform === 'win32') {
    logWarning('Please run install.bat as Administrator to complete Native Host setup');
  }

  // Step 3: 检查 Qwen CLI
  const qwenInstalled = await checkQwenCli();

  // Step 4: 启动 Qwen 服务器（如果已安装）
  let qwenProcess = null;
  if (qwenInstalled) {
    qwenProcess = await startQwenServer(8080);
  }

  // Step 5: 启动测试服务器
  const testServer = createTestServer(3000);

  // Step 6: 启动 Chrome
  await new Promise(resolve => setTimeout(resolve, 1000)); // 等待服务器启动
  const chromeProcess = startChrome(extensionPath, chromePath);

  // 设置清理处理
  const cleanup = () => {
    log('\n\nShutting down...', colors.yellow);

    if (qwenProcess) {
      qwenProcess.kill();
      logInfo('Qwen server stopped');
    }

    if (testServer) {
      testServer.close();
      logInfo('Test server stopped');
    }

    if (chromeProcess) {
      chromeProcess.kill();
      logInfo('Chrome stopped');
    }

    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // 显示使用说明
  log(`
╔════════════════════════════════════════════════════════════════╗
║                         ✅ Setup Complete!                     ║
╠════════════════════════════════════════════════════════════════╣
║                                                                ║
║  📍 Chrome is running with the extension loaded                ║
║  📍 Test page: http://localhost:3000                          ║
║  ${qwenInstalled ? '📍 Qwen server: http://localhost:8080                        ' : '📍 Qwen CLI not installed (limited functionality)              '}║
║                                                                ║
║  📝 How to debug:                                              ║
║  1. Click the extension icon in Chrome toolbar                 ║
║  2. Open Chrome DevTools (F12) to see console logs            ║
║  3. Check background page: chrome://extensions → Details      ║
║  4. Native Host logs: /tmp/qwen-bridge-host.log              ║
║                                                                ║
║  🛑 Press Ctrl+C to stop all services                         ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝
`, colors.bright + colors.green);

  // 保持进程运行
  await new Promise(() => {});
}

// 运行
main().catch((error) => {
  logError(`Fatal error: ${error.message}`);
  process.exit(1);
});