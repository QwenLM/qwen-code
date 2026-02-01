console.log("=== Service Worker 快速诊断 ===");

// 1. 检查 NativeMessaging 对象
console.log("1. NativeMessaging 对象:", typeof self.NativeMessaging);
if (self.NativeMessaging) {
  console.log("   - isConnected:", self.NativeMessaging.isConnected());
  console.log("   - getStatus:", self.NativeMessaging.getStatus());
}

// 2. 检查连接状态
console.log("2. 全局连接状态:", { isConnected, qwenCliStatus });

// 3. 检查监听器
console.log("3. Runtime listeners:", chrome.runtime.onMessage.hasListeners());

// 4. 测试消息响应
console.log("4. 测试发送 CONNECT 消息...");
chrome.runtime.sendMessage({ type: 'CONNECT' }, (response) => {
  if (chrome.runtime.lastError) {
    console.error("   ❌ 错误:", chrome.runtime.lastError.message);
  } else {
    console.log("   ✅ 响应:", response);
  }
});

// 5. 尝试手动连接
console.log("5. 尝试手动连接...");
connectToNativeHost()
  .then(() => {
    console.log("   ✅ 连接成功");
    console.log("   状态:", self.NativeMessaging.getStatus());
  })
  .catch((error) => {
    console.error("   ❌ 连接失败:", error.message);
  });
