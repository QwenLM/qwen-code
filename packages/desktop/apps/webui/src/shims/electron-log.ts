/** electron-log shim for browser — routes to console. */
export default {
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
  verbose: console.debug.bind(console),
  silly: console.debug.bind(console),
  log: console.log.bind(console),
  transports: { ipc: { level: false } },
  scope: () => ({
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  }),
}
