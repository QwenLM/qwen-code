// 在 Service Worker 控制台执行这段代码测试工具调用

console.log("=== 测试 hangwin 浏览器工具 ===");

// 1. 测试启动服务器
async function testStartServer() {
  console.log("1. 测试启动 HTTP 服务器...");
  try {
    const response = await self.NativeMessaging.sendMessageWithResponse({
      type: 'start',
      payload: { port: 12306 }
    });
    console.log("✅ 服务器启动成功:", response);
    return true;
  } catch (error) {
    console.error("❌ 服务器启动失败:", error);
    return false;
  }
}

// 2. 测试调用浏览器工具 - 截图
async function testScreenshot() {
  console.log("2. 测试截图工具...");
  try {
    const response = await self.NativeMessaging.sendMessageWithResponse({
      type: 'call_tool',
      payload: {
        name: 'chrome_screenshot',
        arguments: { fullPage: false }
      }
    }, 60000); // 60秒超时
    console.log("✅ 截图成功:", response);
    return true;
  } catch (error) {
    console.error("❌ 截图失败:", error);
    return false;
  }
}

// 3. 测试读取页面
async function testReadPage() {
  console.log("3. 测试读取页面...");
  try {
    const response = await self.NativeMessaging.sendMessageWithResponse({
      type: 'call_tool',
      payload: {
        name: 'chrome_read_page',
        arguments: {}
      }
    }, 60000);
    console.log("✅ 读取页面成功:", response);
    return true;
  } catch (error) {
    console.error("❌ 读取页面失败:", error);
    return false;
  }
}

// 执行所有测试
async function runAllTests() {
  console.log("\n开始测试...\n");

  const serverStarted = await testStartServer();

  if (serverStarted) {
    await new Promise(r => setTimeout(r, 2000)); // 等待2秒
    await testScreenshot();
    await testReadPage();
  }

  console.log("\n测试完成！");
}

// 运行测试
runAllTests();
