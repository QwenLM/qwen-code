export type WebShellHostSettingValue = boolean | number;

export interface WebShellHostSettingItem {
  key: string;
  label: string;
  description?: string;
  kind: 'boolean' | 'number';
  value: WebShellHostSettingValue;
  disabled?: boolean;
}

export interface WebShellHostSettingsCategory {
  id: string;
  label: string;
  scopeLabel?: string;
  items: readonly WebShellHostSettingItem[];
  onChange: (
    key: string,
    value: WebShellHostSettingValue,
  ) => Promise<void> | void;
}
