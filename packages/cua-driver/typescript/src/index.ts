/**
 * Rust-backed SDK for Cua Driver client applications.
 *
 * Agents should configure `qwen-cua-driver mcp` through their runtime's existing
 * MCP client instead of importing a language MCP facade.
 */
import { CuaDriver, CuaDriverSession, SdkClientKind } from "./native/cua_driver_sdk.js"
import { withMainRunLoop } from "./native/node-runtime.js"

for (const prototype of [CuaDriver.prototype, CuaDriverSession.prototype]) {
  const paste = prototype.paste
  prototype.paste = async function (input, options) {
    options?.signal.throwIfAborted()
    // A dispatched paste must finish clipboard cleanup before cancellation
    // can stop the host's AppKit pump or free its native future.
    const result = await withMainRunLoop(() => paste.call(this, input))
    options?.signal.throwIfAborted()
    return result
  }
  const callTool = prototype.callTool
  prototype.callTool = async function (name, argumentsJson, options) {
    if (name !== "paste") return callTool.call(this, name, argumentsJson, options)
    options?.signal.throwIfAborted()
    const result = await withMainRunLoop(() => callTool.call(this, name, argumentsJson))
    options?.signal.throwIfAborted()
    return result
  }
}

// The same native library backs Python and TypeScript. The package root tags
// both the canonical same-process constructor and the temporary daemon
// compatibility constructor with the importing runtime.
CuaDriver.create = (options) =>
  CuaDriver.createWithClientKind(options, SdkClientKind.Typescript)
CuaDriver.createConfigured = (options) =>
  CuaDriver.createConfiguredWithClientKind(options, SdkClientKind.Typescript)
CuaDriver.createConfiguredWithAuthorizationHost = (options, host) =>
  CuaDriver.createConfiguredWithAuthorizationHostAndClientKind(
    options,
    host,
    SdkClientKind.Typescript,
  )
CuaDriver.createConfiguredWithActivityObserver = (options, observer) =>
  CuaDriver.createConfiguredWithActivityObserverAndClientKind(
    options,
    observer,
    SdkClientKind.Typescript,
  )
CuaDriver.createConfiguredWithHostIntegrations = (options, host, observer) =>
  CuaDriver.createConfiguredWithHostIntegrationsAndClientKind(
    options,
    host,
    observer,
    SdkClientKind.Typescript,
  )
CuaDriver.createPrivateWorker = (options) =>
  CuaDriver.createPrivateWorkerWithClientKind(options, SdkClientKind.Typescript)
CuaDriver.connect = (socketPath: string | undefined) =>
  CuaDriver.connectWithClientKind(socketPath, SdkClientKind.Typescript)

export * from "./native/index.js"
export { default } from "./native/index.js"
