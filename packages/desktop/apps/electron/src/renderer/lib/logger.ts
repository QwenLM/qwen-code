import log from 'electron-log/renderer'

// Export scoped loggers for renderer process
export const rendererLog = log.scope('renderer')
export const searchLog = log.scope('search')

export default log
