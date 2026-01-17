// node-spec.ts — shared NodeSpec types for UI-driven forms

export type FieldType = 'string' | 'number' | 'boolean' | 'select' | 'object' | 'array' | 'json';

export interface FieldSpecBase {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
  help?: string;
  // widget name used by UI; runtime ignores it
  widget?: string;
  uiProps?: Record<string, any>;
}

export interface FieldString extends FieldSpecBase {
  type: 'string';
  default?: string;
}
export interface FieldNumber extends FieldSpecBase {
  type: 'number';
  min?: number;
  max?: number;
  step?: number;
  default?: number;
}
export interface FieldBoolean extends FieldSpecBase {
  type: 'boolean';
  default?: boolean;
}
export interface FieldSelect extends FieldSpecBase {
  type: 'select';
  options: Array<{ label: string; value: string | number | boolean }>;
  default?: string | number | boolean;
}
export interface FieldObject extends FieldSpecBase {
  type: 'object';
  fields: FieldSpec[];
  default?: Record<string, any>;
}
export interface FieldArray extends FieldSpecBase {
  type: 'array';
  item: FieldString | FieldNumber | FieldBoolean | FieldSelect | FieldObject | FieldJson;
  default?: any[];
}
export interface FieldJson extends FieldSpecBase {
  type: 'json';
  default?: any;
}

export type FieldSpec =
  | FieldString
  | FieldNumber
  | FieldBoolean
  | FieldSelect
  | FieldObject
  | FieldArray
  | FieldJson;

export type NodeCategory = 'Flow' | 'Actions' | 'Logic' | 'Tools' | 'Tabs' | 'Page';

export interface NodeSpecDisplay {
  label: string;
  iconClass: string;
  category: NodeCategory;
  docUrl?: string;
}

export interface NodeSpec {
  type: string; // Aligns with NodeType/StepType
  version: number;
  display: NodeSpecDisplay;
  ports: { inputs: number | 'any'; outputs: Array<{ label?: string }> | 'any' };
  schema: FieldSpec[];
  defaults: Record<string, any>;
  validate?: (config: any) => string[];
}
