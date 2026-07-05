/** 'open' npm package shim — uses window.open in browser. */
export default function open(target: string) {
  window.open(target, '_blank', 'noopener,noreferrer')
  return Promise.resolve({ pid: 0 } as any)
}
