import * as React from 'react'
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { UserMessageBubbleProps } from '../UserMessageBubble'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

let UserMessageBubble: (props: UserMessageBubbleProps) => React.ReactElement

beforeAll(async () => {
  const mod = await import('../UserMessageBubble')
  UserMessageBubble = mod.UserMessageBubble
})

describe('UserMessageBubble text elements', () => {
  it('renders badges from textElements and ignores legacy badge props', () => {
    const propsWithLegacyBadges: UserMessageBubbleProps & {
      badges: Array<{ type: 'skill'; rawText: string; label: string; start: number; end: number }>
    } = {
      content: '@qc-helper please check this',
      badges: [{
        type: 'skill',
        rawText: '@wrong-skill',
        label: 'Wrong Skill',
        start: 0,
        end: '@wrong-skill'.length,
      }],
      textElements: [{
        type: 'skill',
        byte_range: { start: 0, end: '@qc-helper'.length },
        placeholder: '@qc-helper',
        label: 'QC Helper',
      }],
    }

    const html = renderToStaticMarkup(
      <UserMessageBubble {...propsWithLegacyBadges} />
    )

    expect(html).toContain('QC Helper')
    expect(html).not.toContain('Wrong Skill')
    expect(html).toContain('please check this')
  })
})
