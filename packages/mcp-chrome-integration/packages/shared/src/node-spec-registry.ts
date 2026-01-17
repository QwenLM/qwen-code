// node-spec-registry.ts — runtime registry for NodeSpec (shared between UI/runtime)
import type { NodeSpec } from './node-spec';

const REG = new Map<string, NodeSpec>();

export function registerNodeSpec(spec: NodeSpec) {
  REG.set(spec.type, spec);
}

export function getNodeSpec(type: string): NodeSpec | undefined {
  return REG.get(type);
}

export function listNodeSpecs(): NodeSpec[] {
  return Array.from(REG.values());
}
