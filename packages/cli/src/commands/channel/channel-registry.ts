import type {
  ChannelConfigFieldDescriptor,
  ChannelConfigFieldKind,
  ChannelPlugin,
  SessionScope,
} from '@qwen-code/channel-base';

export interface ChannelTypeDescriptor {
  type: string;
  displayName: string;
  manageable: boolean;
  fields: readonly ChannelConfigFieldDescriptor[];
}

const registry = new Map<string, ChannelPlugin>();
let builtinsPromise: Promise<void> | null = null;
export const UNSAFE_OBJECT_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

const FIELD_KINDS: ReadonlySet<ChannelConfigFieldKind> = new Set([
  'string',
  'secret',
  'boolean',
  'number',
  'enum',
  'string-list',
  'record',
  'object',
]);

const SHARED_ACCESS_FIELDS: readonly ChannelConfigFieldDescriptor[] = [
  {
    key: 'senderPolicy',
    label: 'Sender Policy',
    kind: 'enum',
    required: true,
    default: 'pairing',
    description: 'Controls who can start direct conversations',
    options: [
      { value: 'pairing', label: 'Pairing' },
      { value: 'allowlist', label: 'Allowlist' },
      { value: 'open', label: 'Open' },
    ],
  },
  {
    key: 'allowedUsers',
    label: 'Allowed Users',
    kind: 'string-list',
    description: 'Stable user IDs allowed without pairing',
  },
  {
    key: 'groupPolicy',
    label: 'Group Policy',
    kind: 'enum',
    required: true,
    default: 'disabled',
    description: 'Controls which group conversations can use this Channel',
    options: [
      { value: 'disabled', label: 'Disabled' },
      { value: 'pairing', label: 'Pairing' },
      { value: 'allowlist', label: 'Allowlist' },
      { value: 'open', label: 'Open' },
    ],
  },
];

const SESSION_SCOPE_OPTIONS: ReadonlyArray<{
  value: SessionScope;
  label: string;
}> = [
  { value: 'user', label: 'Per User and Chat' },
  { value: 'thread', label: 'Per Thread (Legacy)' },
  { value: 'chat_thread', label: 'Per Chat and Thread' },
  { value: 'single', label: 'One Shared Session' },
];

function managementFieldsWithSharedControls(
  fields: readonly ChannelConfigFieldDescriptor[],
  defaultSessionScope: SessionScope,
): readonly ChannelConfigFieldDescriptor[] {
  const declared = new Set(fields.map((field) => field.key));
  const normalizedFields = fields.map((field) =>
    field.key === 'sessionScope' && field.default === undefined
      ? { ...field, default: defaultSessionScope }
      : field,
  );
  return [
    ...normalizedFields,
    ...SHARED_ACCESS_FIELDS.filter((field) => !declared.has(field.key)),
    ...(declared.has('sessionScope')
      ? []
      : [
          {
            key: 'sessionScope',
            label: 'Session Scope',
            kind: 'enum' as const,
            required: true,
            default: defaultSessionScope,
            description:
              'Controls how conversations share persistent agent sessions',
            options: SESSION_SCOPE_OPTIONS,
          },
        ]),
  ];
}

function assertManagementFields(
  fields: readonly ChannelConfigFieldDescriptor[],
  parentPath?: string,
  nested = false,
): void {
  const seen = new Set<string>();
  for (const field of fields) {
    const path = parentPath ? `${parentPath}.${field.key}` : field.key;
    if (typeof field.key !== 'string' || field.key.length === 0) {
      throw new Error(
        `Channel field "${path}" must declare a non-empty string key.`,
      );
    }
    if (seen.has(field.key)) {
      throw new Error(`Channel field "${path}" is declared more than once.`);
    }
    seen.add(field.key);
    assertManagementField(field, path, nested);
  }
}

function assertManagementField(
  field: ChannelConfigFieldDescriptor,
  path: string,
  nested: boolean,
): void {
  if (!FIELD_KINDS.has(field.kind)) {
    throw new Error(
      `Channel field "${path}" declares an unknown kind "${field.kind}".`,
    );
  }
  if (UNSAFE_OBJECT_KEYS.has(field.key)) {
    throw new Error(`Channel field "${path}" cannot use a reserved key.`);
  }
  if (!nested && field.key === 'type') {
    throw new Error(
      `Channel field "${path}" cannot use the reserved key "type".`,
    );
  }
  if (typeof field.label !== 'string' || field.label.length === 0) {
    throw new Error(`Channel field "${path}" must declare a string label.`);
  }
  if (
    field.description !== undefined &&
    typeof field.description !== 'string'
  ) {
    throw new Error(
      `Channel field "${path}" must declare a string description.`,
    );
  }
  if (field.default !== undefined && typeof field.default !== 'string') {
    throw new Error(`Channel field "${path}" must declare a string default.`);
  }
  const envResolvable = Boolean(field.envResolvable);
  const required = Boolean(field.required);
  if (field.kind === 'secret' && nested) {
    throw new Error(`Channel field "${path}" cannot declare a nested secret.`);
  }
  if (
    envResolvable &&
    (nested || (field.kind !== 'string' && field.kind !== 'secret'))
  ) {
    throw new Error(
      `Channel field "${path}" cannot resolve environment references.`,
    );
  }
  const exclusiveMinimum = (field as { exclusiveMinimum?: unknown })
    .exclusiveMinimum;
  if (exclusiveMinimum !== undefined) {
    if (field.kind !== 'number') {
      throw new Error(
        `Channel field "${path}" can only declare exclusiveMinimum on number fields.`,
      );
    }
    if (
      typeof exclusiveMinimum !== 'number' ||
      !Number.isFinite(exclusiveMinimum)
    ) {
      throw new Error(
        `Channel field "${path}" must declare a finite exclusiveMinimum.`,
      );
    }
  }
  if (field.kind === 'enum') {
    if (!Array.isArray(field.options) || field.options.length === 0) {
      throw new Error(
        `Channel field "${path}" must declare at least one option.`,
      );
    }
    if (
      field.options.some(
        (option) =>
          typeof option?.value !== 'string' || option.value.length === 0,
      )
    ) {
      throw new Error(
        `Channel field "${path}" must declare non-empty string option values.`,
      );
    }
    if (
      new Set(field.options.map((option) => option.value)).size !==
      field.options.length
    ) {
      throw new Error(
        `Channel field "${path}" declares duplicate option values.`,
      );
    }
    if (
      field.default !== undefined &&
      !field.options.some((option) => option.value === field.default)
    ) {
      throw new Error(
        `Channel field "${path}" declares a default that is not one of its options.`,
      );
    }
  }
  if (field.kind !== 'object') return;
  if (required) {
    throw new Error(`Channel field "${path}" cannot be a required object.`);
  }
  if (!Array.isArray(field.properties)) {
    throw new Error(`Channel field "${path}" must declare a properties array.`);
  }
  if (field.properties.length === 0) {
    throw new Error(
      `Channel field "${path}" must declare at least one property.`,
    );
  }
  assertManagementFields(field.properties, path, true);
}

function assertManagementDescriptor(plugin: ChannelPlugin): void {
  const management = plugin.management;
  if (management === undefined) return;
  const defaultSessionScope: unknown = plugin.defaultSessionScope ?? 'user';
  if (
    !SESSION_SCOPE_OPTIONS.some(
      (option) => option.value === defaultSessionScope,
    )
  ) {
    throw new Error('Channel defaultSessionScope is invalid.');
  }
  if (
    management.validateConfig !== undefined &&
    (typeof management.validateConfig !== 'function' ||
      management.validateConfig.constructor.name === 'AsyncFunction')
  ) {
    throw new Error(
      'Channel management metadata must declare validateConfig as a synchronous function.',
    );
  }
  if (!Array.isArray(management.fields)) {
    throw new Error('Channel management metadata must declare a fields array.');
  }
  assertManagementFields(management.fields);
  const sessionScopeField = management.fields.find(
    (field) => field.key === 'sessionScope',
  );
  if (sessionScopeField) {
    if (sessionScopeField.kind !== 'enum') {
      throw new Error('Channel field "sessionScope" must be an enum.');
    }
    if (
      !sessionScopeField.options?.some(
        (option: { value: string }) => option.value === defaultSessionScope,
      )
    ) {
      throw new Error(
        'Channel field "sessionScope" must include the channel defaultSessionScope.',
      );
    }
  }
}

function ensureBuiltins(): Promise<void> {
  if (!builtinsPromise) {
    builtinsPromise = (async () => {
      const labelled = [
        { name: 'telegram', promise: import('@qwen-code/channel-telegram') },
        { name: 'weixin', promise: import('@qwen-code/channel-weixin') },
        { name: 'dingtalk', promise: import('@qwen-code/channel-dingtalk') },
        { name: 'dws', promise: import('@qwen-code/channel-dws') },
        { name: 'wecom', promise: import('@qwen-code/channel-wecom') },
        { name: 'feishu', promise: import('@qwen-code/channel-feishu') },
        { name: 'qqbot', promise: import('@qwen-code/channel-qqbot') },
        { name: 'github', promise: import('@qwen-code/channel-github') },
        { name: 'gitlab', promise: import('@qwen-code/channel-gitlab') },
      ];

      const results = await Promise.allSettled(labelled.map((l) => l.promise));

      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        if (result.status === 'fulfilled') {
          registerWithManagementValidation(
            result.value.plugin,
            labelled[i]!.name,
          );
        } else {
          process.stderr.write(
            `[channel-registry] Failed to load "${labelled[i]!.name}" channel: ${result.reason}\n`,
          );
        }
      }
    })();
  }
  return builtinsPromise;
}

export function registerPlugin(plugin: ChannelPlugin): void {
  if (registry.has(plugin.channelType)) {
    throw new Error(
      `Channel type "${plugin.channelType}" is already registered.`,
    );
  }
  registerWithManagementValidation(plugin, plugin.channelType);
}

function registerWithManagementValidation(
  plugin: ChannelPlugin,
  label: string,
): void {
  try {
    assertManagementDescriptor(plugin);
  } catch (error) {
    // Fail closed on the management surface only; the channel runtime keeps
    // working with management stripped. The copy over the original prototype
    // keeps prototype methods (e.g. class-instance plugins) alive, and
    // defineProperty shadows getter-only accessors that would reject an
    // assignment. The copy only carries own enumerable state, so ES #private
    // fields and non-enumerable own properties do not survive it.
    process.stderr.write(
      `[channel-registry] Invalid management metadata in "${label}" channel: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    const stripped = Object.assign(
      Object.create(
        Object.getPrototypeOf(plugin) ?? Object.prototype,
      ) as ChannelPlugin,
      plugin,
    );
    Object.defineProperty(stripped, 'management', {
      value: undefined,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    registry.set(plugin.channelType, stripped);
    return;
  }
  registry.set(plugin.channelType, plugin);
}

export async function getPlugin(
  channelType: string,
): Promise<ChannelPlugin | undefined> {
  await ensureBuiltins();
  return registry.get(channelType);
}

export async function supportedTypes(): Promise<string[]> {
  await ensureBuiltins();
  return [...registry.keys()];
}

export async function supportedChannelCatalog(): Promise<
  ChannelTypeDescriptor[]
> {
  await ensureBuiltins();
  return [...registry.values()].map(
    ({ channelType, displayName, management, defaultSessionScope }) => ({
      type: channelType,
      displayName,
      manageable: management !== undefined,
      fields: management
        ? managementFieldsWithSharedControls(
            management.fields,
            defaultSessionScope ?? 'user',
          )
        : [],
    }),
  );
}
