// packages/core/src/copilot/copilot-route.ts
export type CopilotWire = 'messages' | 'responses' | 'chat';

export function routeForModel(
  _slug: string,
  _warn?: (msg: string) => void,
  _liveModels?: Map<string, CopilotWire>,
): CopilotWire {
  throw new Error('not implemented');
}
