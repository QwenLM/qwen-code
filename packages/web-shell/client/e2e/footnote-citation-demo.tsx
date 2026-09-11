import { useMemo, useState, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import type { ExtraProps } from 'react-markdown';
import { WebShellTranscript } from '../components/WebShellTranscript';
import type { WebShellFootnoteIconResolver } from '../customization';
import knowledgeIconUrl from '../assets/icons/knowledge.svg?url&no-inline';
import fileIconUrl from '../assets/icons/at-file.svg?url&no-inline';
import referencesIconUrl from './assets/citation-references.svg?url&no-inline';
import { mountDemoFootnotePreview } from './footnote-preview-host';

const getInlineFootnoteIcon: WebShellFootnoteIconResolver = (footnotes) =>
  footnotes.every((note) => note.href?.startsWith(sentinelPrefix))
    ? knowledgeIconUrl
    : fileIconUrl;
const getAssistantFootnoteIcon: WebShellFootnoteIconResolver = () =>
  referencesIconUrl;

const sentinelPrefix = 'https://citation.invalid/dataworks-knowledge#';

const report = `## 订单主题分析

订单表需要遵循统一的业务定义和状态口径。[^a][^b]

资源组规格会影响任务可用并发，需要结合运行规模选择。[^c]

[^a]: [订单业务定义](<https://citation.invalid/dataworks-knowledge#v=1&kind=semantic&kbInstanceId=instance-a&docId=kb%3Aorder> "DataWorks Knowledge") — 用户提交交易后形成的业务订单定义。
[^b]: [订单规范原文](<https://citation.invalid/dataworks-knowledge#v=1&kind=content&kbInstanceId=instance-a&sourceFileId=file-order&citationId=citation-order&relativePath=docs%2Forder.md&anchor=markdown%3Ablock%3A7> "DataWorks Knowledge") — 订单状态字段及约束说明。
[^c]: [资源组规格说明](https://example.com/resource-groups) — 不同规格对应不同并发上限。
`;

function block(
  value: Omit<
    DaemonTranscriptBlock,
    'clientReceivedAt' | 'createdAt' | 'updatedAt'
  >,
  timestamp: number,
): DaemonTranscriptBlock {
  return {
    ...value,
    clientReceivedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  } as DaemonTranscriptBlock;
}

const demoTimestamp = Date.now();
const blocks: DaemonTranscriptBlock[] = [
  block(
    { id: 'demo-user', kind: 'user', text: '生成带知识来源的订单分析。' },
    demoTimestamp,
  ),
  block(
    { id: 'demo-assistant', kind: 'assistant', text: report },
    demoTimestamp + 1,
  ),
];

interface ResolvedLocator {
  title: string;
  fields: Array<[string, string]>;
}

function App() {
  const [resolved, setResolved] = useState<ResolvedLocator>();
  const [customPreview, setCustomPreview] = useState(
    () => new URLSearchParams(location.search).get('preview') === 'custom',
  );
  const markdown = useMemo(
    () => ({
      getInlineFootnoteIcon,
      getAssistantFootnoteIcon,
      mountFootnotePreview: customPreview
        ? mountDemoFootnotePreview
        : undefined,
      components: {
        a({ href, children, className }: ComponentProps<'a'> & ExtraProps) {
          if (href?.startsWith(sentinelPrefix)) {
            const open = () => {
              const url = new URL(href);
              setResolved({
                title: String(children),
                fields: [...new URLSearchParams(url.hash.slice(1)).entries()],
              });
            };
            return (
              <a
                href="#"
                role="button"
                className={className}
                onClick={(event) => {
                  event.preventDefault();
                  open();
                }}
                onAuxClick={(event) => {
                  if (event.button !== 1) return;
                  event.preventDefault();
                  open();
                }}
              >
                {children}
              </a>
            );
          }
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className={className}
            >
              {children}
            </a>
          );
        },
      },
    }),
    [customPreview],
  );

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        gridTemplateColumns: resolved ? 'minmax(0, 1fr) 380px' : '1fr',
        background: '#0b0b0c',
        color: '#f6f6f6',
      }}
    >
      <label
        style={{
          position: 'fixed',
          top: 12,
          left: 20,
          zIndex: 10,
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          fontSize: 12,
          color: '#aeb0bb',
        }}
      >
        <input
          type="checkbox"
          checked={customPreview}
          onChange={(event) => setCustomPreview(event.target.checked)}
        />
        使用宿主卡片
      </label>
      <WebShellTranscript
        blocks={blocks}
        theme="dark"
        language="zh-CN"
        collapseCompletedTurns={false}
        markdown={markdown}
        style={{ minHeight: '100vh' }}
      />
      {resolved && (
        <aside
          data-demo-source-panel=""
          style={{
            borderLeft: '1px solid #303034',
            background: '#151517',
            padding: 24,
          }}
        >
          <div style={{ color: '#9b9ba3', fontSize: 12 }}>
            宿主右侧面板 Demo
          </div>
          <h2 style={{ margin: '12px 0 8px', fontSize: 18 }}>
            {resolved.title}
          </h2>
          <p style={{ color: '#b8b8c0', fontSize: 14, lineHeight: 1.6 }}>
            OpenCode 已接管 locator。实际产品将在这里校验当前会话并拼接真实来源
            URL。
          </p>
          <dl style={{ display: 'grid', gap: 10, marginTop: 24 }}>
            {resolved.fields.map(([key, value]) => (
              <div key={key}>
                <dt style={{ color: '#85858e', fontSize: 12 }}>{key}</dt>
                <dd
                  style={{
                    margin: '3px 0 0',
                    overflowWrap: 'anywhere',
                    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                    fontSize: 12,
                  }}
                >
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <button
            type="button"
            onClick={() => setResolved(undefined)}
            style={{
              marginTop: 28,
              border: '1px solid #3c3c42',
              borderRadius: 8,
              background: '#222226',
              color: '#fff',
              padding: '8px 12px',
              cursor: 'pointer',
            }}
          >
            关闭面板
          </button>
        </aside>
      )}
    </main>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
