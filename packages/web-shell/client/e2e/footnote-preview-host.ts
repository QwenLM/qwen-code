import type {
  WebShellFootnotePreviewMount,
  WebShellFootnotePreviewInfo,
} from '../customization';

let nextMountId = 0;

export const mountDemoFootnotePreview: WebShellFootnotePreviewMount = (
  container,
  initial,
) => {
  const document = container.ownerDocument;
  const content = document.createElement('article');
  content.dataset['demoPreviewContent'] = '';
  content.dataset['mountId'] = String(++nextMountId);
  content.dataset['mountWidth'] = String(container.clientWidth);
  Object.assign(content.style, {
    borderLeft: '3px solid #879af0',
    padding: '4px 0 4px 12px',
    display: 'grid',
    gap: '10px',
  });
  const label = document.createElement('div');
  label.style.cssText = 'font-size:11px;color:#9aa6d7;letter-spacing:.04em';
  label.textContent = '宿主自定义内容';
  const source = document.createElement('div');
  source.style.cssText = 'font-size:12px;opacity:.7';
  const title = document.createElement('div');
  title.style.cssText = 'font-size:16px;line-height:1.5';
  const summary = document.createElement('p');
  summary.style.cssText = 'margin:0;font-size:13px;line-height:1.7';
  const details = document.createElement('pre');
  details.style.cssText =
    'margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;opacity:.7';
  details.hidden = true;
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = '查看脚注原文';
  toggle.style.cssText =
    'justify-self:start;font-size:12px;color:#a9b9ff;cursor:pointer';
  const onToggle = () => {
    details.hidden = !details.hidden;
    toggle.textContent = details.hidden ? '查看脚注原文' : '收起脚注原文';
  };
  toggle.addEventListener('click', onToggle);
  content.append(label, source, title, summary, toggle, details);
  container.append(content);
  const update = (info: WebShellFootnotePreviewInfo) => {
    content.dataset['index'] = String(info.index);
    content.dataset['ids'] = info.footnotes.map((note) => note.id).join(',');
    source.textContent = info.sourceLabel;
    title.replaceChildren(info.sourceLink);
    summary.textContent = info.footnote.summary;
    details.textContent = info.footnote.definitionMarkdown;
  };
  update(initial);
  return {
    update,
    dispose() {
      toggle.removeEventListener('click', onToggle);
      content.remove();
    },
  };
};
