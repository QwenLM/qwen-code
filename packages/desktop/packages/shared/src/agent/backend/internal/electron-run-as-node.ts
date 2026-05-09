export function shouldRunElectronAsNode(
  command: string,
  args: readonly string[],
): boolean {
  return (
    !!process.versions.electron &&
    command === process.execPath &&
    !!args[0]?.endsWith('.js')
  );
}

export function withElectronRunAsNodeEnv(
  env: NodeJS.ProcessEnv,
  command: string,
  args: readonly string[],
): NodeJS.ProcessEnv {
  if (!shouldRunElectronAsNode(command, args)) return env;
  return {
    ...env,
    ELECTRON_RUN_AS_NODE: '1',
  };
}
