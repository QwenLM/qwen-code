// node-specs-builtin.ts — builtin NodeSpecs shared for UI + runtime
import type { NodeSpec } from './node-spec';
import { registerNodeSpec } from './node-spec-registry';
import { STEP_TYPES } from './step-types';

export function registerBuiltinSpecs() {
  const nav: NodeSpec = {
    type: STEP_TYPES.NAVIGATE,
    version: 1,
    display: { label: '导航', iconClass: 'icon-navigate', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'url',
        label: 'URL',
        type: 'string',
        required: true,
        placeholder: 'https://example.com',
        help: '目标地址，支持变量模板 {var}',
        default: '',
      },
    ],
    defaults: { url: '' },
    validate: (cfg) => {
      const errs: string[] = [];
      if (!cfg || !cfg.url || String(cfg.url).trim() === '') errs.push('URL 必填');
      return errs;
    },
  };
  registerNodeSpec(nav);

  // Click / Dblclick
  registerNodeSpec({
    type: STEP_TYPES.CLICK,
    version: 1,
    display: { label: '点击', iconClass: 'icon-click', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'target',
        label: '目标',
        type: 'json',
        widget: 'targetlocator',
        help: '选择或输入元素选择器',
      },
      {
        key: 'before',
        label: '执行前',
        type: 'object',
        fields: [
          { key: 'scrollIntoView', label: '滚动到可见', type: 'boolean', default: true },
          { key: 'waitForSelector', label: '等待选择器', type: 'boolean', default: true },
        ],
      },
      {
        key: 'after',
        label: '执行后',
        type: 'object',
        fields: [
          { key: 'waitForNavigation', label: '等待导航完成', type: 'boolean', default: false },
          { key: 'waitForNetworkIdle', label: '等待网络空闲', type: 'boolean', default: false },
        ],
      },
    ],
    defaults: { before: { scrollIntoView: true, waitForSelector: true }, after: {} },
  });
  registerNodeSpec({
    type: STEP_TYPES.DBLCLICK,
    version: 1,
    display: { label: '双击', iconClass: 'icon-click', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'target', label: '目标', type: 'json', widget: 'targetlocator' },
      {
        key: 'before',
        label: '执行前',
        type: 'object',
        fields: [
          { key: 'scrollIntoView', label: '滚动到可见', type: 'boolean', default: true },
          { key: 'waitForSelector', label: '等待选择器', type: 'boolean', default: true },
        ],
      },
      {
        key: 'after',
        label: '执行后',
        type: 'object',
        fields: [
          { key: 'waitForNavigation', label: '等待导航完成', type: 'boolean', default: false },
          { key: 'waitForNetworkIdle', label: '等待网络空闲', type: 'boolean', default: false },
        ],
      },
    ],
    defaults: { before: { scrollIntoView: true, waitForSelector: true }, after: {} },
  });

  // Fill
  registerNodeSpec({
    type: STEP_TYPES.FILL,
    version: 1,
    display: { label: '填充', iconClass: 'icon-fill', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'target', label: '目标', type: 'json', widget: 'targetlocator' },
      { key: 'value', label: '输入值', type: 'string', required: true, help: '支持 {var} 模板' },
    ],
    defaults: { value: '' },
  });

  // Key
  registerNodeSpec({
    type: STEP_TYPES.KEY,
    version: 1,
    display: { label: '键盘', iconClass: 'icon-key', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'keys',
        label: '按键序列',
        type: 'string',
        widget: 'keysequence',
        required: true,
        help: '如 Backspace Enter 或 cmd+a',
      },
      { key: 'target', label: '焦点目标(可选)', type: 'json', widget: 'targetlocator' },
    ],
    defaults: { keys: '' },
  });

  // Scroll
  registerNodeSpec({
    type: STEP_TYPES.SCROLL,
    version: 1,
    display: { label: '滚动', iconClass: 'icon-scroll', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'mode',
        label: '模式',
        type: 'select',
        options: [
          { label: '元素', value: 'element' },
          { label: '偏移', value: 'offset' },
          { label: '容器', value: 'container' },
        ] as any,
        default: 'offset',
      },
      { key: 'target', label: '目标(当元素/容器)', type: 'json', widget: 'targetlocator' },
      {
        key: 'offset',
        label: '偏移',
        type: 'object',
        fields: [
          { key: 'x', label: 'X', type: 'number' },
          { key: 'y', label: 'Y', type: 'number' },
        ],
      },
    ],
    defaults: { mode: 'offset', offset: { x: 0, y: 300 } },
  });

  // Drag
  registerNodeSpec({
    type: STEP_TYPES.DRAG,
    version: 1,
    display: { label: '拖拽', iconClass: 'icon-drag', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'start', label: '起点', type: 'json', widget: 'targetlocator' },
      { key: 'end', label: '终点', type: 'json', widget: 'targetlocator' },
      {
        key: 'path',
        label: '路径坐标',
        type: 'array',
        item: {
          key: 'p',
          label: '点',
          type: 'object',
          fields: [
            { key: 'x', label: 'X', type: 'number' },
            { key: 'y', label: 'Y', type: 'number' },
          ],
        } as any,
      },
    ],
    defaults: {},
  });

  // Wait
  registerNodeSpec({
    type: STEP_TYPES.WAIT,
    version: 1,
    display: { label: '等待', iconClass: 'icon-wait', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'condition',
        label: '条件(JSON)',
        type: 'json',
        help: '如 {"sleep":1000} 或 {"text":"Hello","appear":true}',
      },
    ],
    defaults: { condition: { sleep: 500 } },
  });

  // Assert
  registerNodeSpec({
    type: STEP_TYPES.ASSERT,
    version: 1,
    display: { label: '断言', iconClass: 'icon-assert', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }, { label: 'onError' }] },
    schema: [
      {
        key: 'assert',
        label: '断言(JSON)',
        type: 'json',
        help: '如 {"exists":"#id"} / {"visible":".btn"}',
      },
      {
        key: 'failStrategy',
        label: '失败策略',
        type: 'select',
        options: [
          { label: '停止', value: 'stop' },
          { label: '警告', value: 'warn' },
          { label: '重试', value: 'retry' },
        ] as any,
        default: 'stop',
      },
    ],
    defaults: { assert: {} },
  });

  // HTTP
  registerNodeSpec({
    type: STEP_TYPES.HTTP,
    version: 1,
    display: { label: 'HTTP', iconClass: 'icon-http', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'method',
        label: '方法',
        type: 'select',
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({
          label: m,
          value: m,
        })) as any,
        default: 'GET',
      },
      { key: 'url', label: 'URL', type: 'string', required: true },
      { key: 'headers', label: '请求头(JSON)', type: 'json' },
      { key: 'body', label: '请求体(JSON)', type: 'json' },
      { key: 'formData', label: '表单(JSON)', type: 'json' },
      { key: 'saveAs', label: '保存为变量', type: 'string' },
      { key: 'assign', label: '映射(JSON)', type: 'json' },
    ],
    defaults: { method: 'GET' },
  });

  // Extract
  registerNodeSpec({
    type: STEP_TYPES.EXTRACT,
    version: 1,
    display: { label: '提取', iconClass: 'icon-extract', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'selector', label: '选择器', type: 'string', widget: 'selector' },
      {
        key: 'attr',
        label: '属性',
        type: 'select',
        options: [
          { label: '文本(text)', value: 'text' },
          { label: '文本(textContent)', value: 'textContent' },
          { label: '自定义属性名', value: 'attr' },
        ] as any,
      },
      { key: 'js', label: '自定义JS', type: 'string', help: '在页面中执行并返回值' },
      { key: 'saveAs', label: '保存变量', type: 'string', required: true },
    ],
    defaults: { saveAs: '' },
  });

  // Screenshot
  registerNodeSpec({
    type: STEP_TYPES.SCREENSHOT,
    version: 1,
    display: { label: '截图', iconClass: 'icon-screenshot', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'selector', label: '目标选择器', type: 'string' },
      { key: 'fullPage', label: '整页截图', type: 'boolean', default: false },
      { key: 'saveAs', label: '保存变量', type: 'string' },
    ],
    defaults: { fullPage: false },
  });

  // TriggerEvent
  registerNodeSpec({
    type: STEP_TYPES.TRIGGER_EVENT,
    version: 1,
    display: { label: '触发事件', iconClass: 'icon-trigger', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'target', label: '目标', type: 'json', widget: 'targetlocator' },
      { key: 'event', label: '事件类型', type: 'string', required: true },
      { key: 'bubbles', label: '冒泡', type: 'boolean', default: true },
      { key: 'cancelable', label: '可取消', type: 'boolean', default: false },
    ],
    defaults: { event: '' },
  });

  // SetAttribute
  registerNodeSpec({
    type: STEP_TYPES.SET_ATTRIBUTE,
    version: 1,
    display: { label: '设置属性', iconClass: 'icon-attr', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'target', label: '目标', type: 'json', widget: 'targetlocator' },
      { key: 'name', label: '属性名', type: 'string', required: true },
      { key: 'value', label: '属性值', type: 'string' },
      { key: 'remove', label: '移除属性', type: 'boolean', default: false },
    ],
    defaults: { remove: false },
  });

  // LoopElements
  registerNodeSpec({
    type: STEP_TYPES.LOOP_ELEMENTS,
    version: 1,
    display: { label: '循环元素', iconClass: 'icon-loop', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'selector', label: '选择器', type: 'string', required: true },
      { key: 'saveAs', label: '列表变量名', type: 'string', default: 'elements' },
      { key: 'itemVar', label: '项变量名', type: 'string', default: 'item' },
      { key: 'subflowId', label: '子流程ID', type: 'string', required: true },
    ],
    defaults: { saveAs: 'elements', itemVar: 'item' },
  });

  // SwitchFrame
  registerNodeSpec({
    type: STEP_TYPES.SWITCH_FRAME,
    version: 1,
    display: { label: '切换Frame', iconClass: 'icon-frame', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'frame',
        label: 'frame定位',
        type: 'object',
        fields: [
          { key: 'index', label: '索引', type: 'number' },
          { key: 'urlContains', label: 'URL包含', type: 'string' },
        ],
      },
    ],
    defaults: {},
  });

  // HandleDownload
  registerNodeSpec({
    type: STEP_TYPES.HANDLE_DOWNLOAD,
    version: 1,
    display: { label: '下载处理', iconClass: 'icon-download', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'filenameContains', label: '文件名包含', type: 'string' },
      { key: 'waitForComplete', label: '等待完成', type: 'boolean', default: true },
      { key: 'timeoutMs', label: '超时(ms)', type: 'number', default: 60000 },
      { key: 'saveAs', label: '保存变量', type: 'string' },
    ],
    defaults: { waitForComplete: true, timeoutMs: 60000 },
  });

  // Script
  registerNodeSpec({
    type: STEP_TYPES.SCRIPT,
    version: 1,
    display: { label: '脚本', iconClass: 'icon-script', category: 'Tools' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'world',
        label: '执行上下文',
        type: 'select',
        options: [
          { label: 'ISOLATED', value: 'ISOLATED' },
          { label: 'MAIN', value: 'MAIN' },
        ] as any,
        default: 'ISOLATED',
      },
      { key: 'code', label: '脚本代码', type: 'string', widget: 'code', required: true },
      {
        key: 'when',
        label: '执行时机',
        type: 'select',
        options: [
          { label: 'before', value: 'before' },
          { label: 'after', value: 'after' },
        ] as any,
        default: 'after',
      },
      { key: 'assign', label: '映射(JSON)', type: 'json' },
      { key: 'saveAs', label: '保存变量', type: 'string' },
    ],
    defaults: { world: 'ISOLATED', when: 'after' },
  });

  // Tabs
  registerNodeSpec({
    type: STEP_TYPES.OPEN_TAB,
    version: 1,
    display: { label: '打开标签', iconClass: 'icon-openTab', category: 'Tabs' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'url', label: 'URL', type: 'string' },
      { key: 'newWindow', label: '新窗口', type: 'boolean', default: false },
    ],
    defaults: { newWindow: false },
  });
  registerNodeSpec({
    type: 'executeFlow' as any,
    version: 1,
    display: { label: '执行子流程', iconClass: 'icon-exec', category: 'Flow' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'flowId', label: '流程ID', type: 'string', required: true },
      { key: 'inline', label: '内联执行', type: 'boolean', default: false },
      { key: 'args', label: '参数(JSON)', type: 'json' },
    ],
    defaults: { inline: false },
  });
  registerNodeSpec({
    type: STEP_TYPES.SWITCH_TAB,
    version: 1,
    display: { label: '切换标签', iconClass: 'icon-switchTab', category: 'Tabs' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'tabId', label: 'TabId', type: 'number' },
      { key: 'urlContains', label: 'URL包含', type: 'string' },
      { key: 'titleContains', label: '标题包含', type: 'string' },
    ],
    defaults: {},
  });
  registerNodeSpec({
    type: STEP_TYPES.CLOSE_TAB,
    version: 1,
    display: { label: '关闭标签', iconClass: 'icon-closeTab', category: 'Tabs' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'tabIds',
        label: 'TabIds',
        type: 'array',
        item: { key: 'id', label: 'id', type: 'number' } as any,
      },
      { key: 'url', label: 'URL', type: 'string' },
    ],
    defaults: {},
  });

  // Logic
  registerNodeSpec({
    type: STEP_TYPES.IF,
    version: 1,
    display: { label: '条件', iconClass: 'icon-if', category: 'Logic' },
    ports: { inputs: 1, outputs: 'any' },
    schema: [
      {
        key: 'condition',
        label: '条件表达式(JSON)',
        type: 'json',
        help: '如 {"expression":"vars.a>0"} 等',
      },
      {
        key: 'branches',
        label: '分支',
        type: 'array',
        item: {
          key: 'b',
          label: 'case',
          type: 'object',
          fields: [
            { key: 'id', label: 'ID', type: 'string' },
            { key: 'name', label: '名称', type: 'string' },
            { key: 'expr', label: '表达式', type: 'string' },
          ],
        } as any,
      },
      { key: 'else', label: '启用 else', type: 'boolean', default: true },
    ],
    defaults: { else: true },
  });
  registerNodeSpec({
    type: STEP_TYPES.FOREACH,
    version: 1,
    display: { label: '循环', iconClass: 'icon-foreach', category: 'Logic' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'listVar', label: '列表变量', type: 'string', required: true },
      { key: 'itemVar', label: '项变量', type: 'string', default: 'item' },
      { key: 'subflowId', label: '子流程ID', type: 'string', required: true },
      {
        key: 'concurrency',
        label: '并发数',
        type: 'number',
        default: 1,
        help: '并发执行子流程（浅拷贝变量，不自动合并）',
      },
    ],
    defaults: { itemVar: 'item' },
  });
  registerNodeSpec({
    type: STEP_TYPES.WHILE,
    version: 1,
    display: { label: '循环', iconClass: 'icon-while', category: 'Logic' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'condition', label: '条件(JSON)', type: 'json' },
      { key: 'subflowId', label: '子流程ID', type: 'string', required: true },
      { key: 'maxIterations', label: '最大次数', type: 'number', default: 100 },
    ],
    defaults: { maxIterations: 100 },
  });

  // Delay (UI-only helper)
  registerNodeSpec({
    type: STEP_TYPES.DELAY,
    version: 1,
    display: { label: '延迟', iconClass: 'icon-delay', category: 'Actions' },
    ports: { inputs: 1, outputs: [{ label: 'default' }] },
    schema: [
      {
        key: 'sleep',
        label: '延迟',
        type: 'number',
        widget: 'duration',
        required: true,
        default: 1000,
      },
    ],
    defaults: { sleep: 1000 },
  });

  // Trigger (builder-only, flow-level node)
  registerNodeSpec({
    type: STEP_TYPES.TRIGGER,
    version: 1,
    display: { label: '触发器', iconClass: 'icon-trigger', category: 'Flow' },
    ports: { inputs: 0, outputs: [{ label: 'default' }] },
    schema: [
      { key: 'enabled', label: '启用', type: 'boolean', default: true },
      { key: 'description', label: '描述', type: 'string' },
      {
        key: 'modes',
        label: '模式',
        type: 'object',
        fields: [
          { key: 'manual', label: '手动', type: 'boolean', default: true },
          { key: 'url', label: 'URL 触发', type: 'boolean', default: false },
          { key: 'contextMenu', label: '右键菜单', type: 'boolean', default: false },
          { key: 'command', label: '快捷键', type: 'boolean', default: false },
          { key: 'dom', label: 'DOM 事件', type: 'boolean', default: false },
          { key: 'schedule', label: '定时', type: 'boolean', default: false },
        ],
      },
      {
        key: 'url',
        label: 'URL 规则',
        type: 'object',
        fields: [
          {
            key: 'rules',
            label: '规则列表',
            type: 'array',
            item: {
              key: 'rule',
              label: '规则',
              type: 'object',
              fields: [
                {
                  key: 'kind',
                  label: '类型',
                  type: 'select',
                  options: [
                    { label: 'URL', value: 'url' },
                    { label: '域名', value: 'domain' },
                    { label: '路径', value: 'path' },
                  ] as any,
                  default: 'url',
                },
                { key: 'value', label: '值', type: 'string' },
              ],
            } as any,
          },
        ],
      },
      {
        key: 'contextMenu',
        label: '右键菜单',
        type: 'object',
        fields: [
          { key: 'title', label: '标题', type: 'string', default: '运行工作流' },
          { key: 'enabled', label: '启用', type: 'boolean', default: false },
        ],
      },
      {
        key: 'command',
        label: '快捷键',
        type: 'object',
        fields: [
          { key: 'commandKey', label: '快捷键', type: 'string' },
          { key: 'enabled', label: '启用', type: 'boolean', default: false },
        ],
      },
      {
        key: 'dom',
        label: 'DOM 事件',
        type: 'object',
        fields: [
          { key: 'selector', label: '选择器', type: 'string' },
          { key: 'appear', label: '出现', type: 'boolean', default: true },
          { key: 'once', label: '一次', type: 'boolean', default: true },
          { key: 'debounceMs', label: '防抖(ms)', type: 'number', default: 800 },
          { key: 'enabled', label: '启用', type: 'boolean', default: false },
        ],
      },
      {
        key: 'schedules',
        label: '定时',
        type: 'array',
        item: {
          key: 'sched',
          label: '计划',
          type: 'object',
          fields: [
            { key: 'id', label: 'ID', type: 'string' },
            {
              key: 'type',
              label: '类型',
              type: 'select',
              options: [
                { label: '一次', value: 'once' },
                { label: '间隔', value: 'interval' },
                { label: '每日', value: 'daily' },
              ] as any,
            },
            { key: 'when', label: '时间(ISO/cron)', type: 'string' },
            { key: 'enabled', label: '启用', type: 'boolean', default: true },
          ],
        } as any,
      },
    ],
    defaults: { enabled: true },
  });
}
