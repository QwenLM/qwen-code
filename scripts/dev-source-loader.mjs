const coreSourceUrl = new URL('../packages/core/index.ts', import.meta.url).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier === '@qwen-code/qwen-code-core') {
    return {
      shortCircuit: true,
      url: coreSourceUrl,
      format: 'module',
    };
  }
  return nextResolve(specifier, context);
}
