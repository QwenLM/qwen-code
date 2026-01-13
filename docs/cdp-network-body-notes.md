## CDP 获取响应体的坑位记录

- 使用 DevTools 的 `Network.getResponseBody` 只能在请求 ID 仍然有效时调用，重复调用或请求完成很久后会返回 `{"code":-32000,"message":"No resource with given identifier found"}`，并非插件逻辑错误。
- `requestId` 会很快被 Chrome 回收，尤其是页面加载完成、切换标签、或在附加调试器之前就结束的请求，之后再取 body 就会出现上述错误。
- 如果需要特定接口的返回体，要在请求刚完成时立即调用（或在 `Network.loadingFinished` 事件内抓取），无法通过“多次重放 getResponseBody”弥补早期错过的请求。
- 对于 fetch/XHR，可以在内容脚本里 hook（如当前实现的 `Captured.responseBody`）以不依赖 CDP 获取 body；非 fetch/XHR（如 WebSocket、媒体流）仍只能依赖 CDP，过期即失效。
- 摘要中应过滤掉这些 -32000 错误，避免误导模型；获取不到的请求需要重放才能取到响应体。
