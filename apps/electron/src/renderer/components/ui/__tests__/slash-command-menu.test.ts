import { beforeAll, describe, expect, it, mock } from 'bun:test'

import type { AvailableSlashCommand } from '../../../../shared/types'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))

let createQwenSlashSections: typeof import('../slash-command-menu').createQwenSlashSections

beforeAll(async () => {
  const mod = await import('../slash-command-menu')
  createQwenSlashSections = mod.createQwenSlashSections
})

describe('createQwenSlashSections', () => {
  it('uses provider-advertised commands when available', () => {
    const commands: AvailableSlashCommand[] = [
      { name: 'status', description: 'Show version info' },
      { name: '/compress', description: 'Compress context', input: { hint: '[instructions]' } },
    ]

    const sections = createQwenSlashSections({ availableCommands: commands, enabled: true })
    const qwenSection = sections.find(section => section.id === 'qwen-commands')

    expect(qwenSection?.items.map(item => item.label)).toEqual(['/status', '/compress'])
    expect(qwenSection?.items[1]).toMatchObject({
      id: 'qwen:compress',
      description: 'Compress context',
      insertText: '/compress ',
    })
  })

  it('falls back to common Qwen commands before provider data arrives', () => {
    const sections = createQwenSlashSections({ enabled: true })
    const labels = sections.flatMap(section => section.items.map(item => item.label))

    expect(labels).toContain('/status')
    expect(labels).toContain('/tasks')
    expect(labels).toContain('/compress')
    expect(labels).not.toContain('/skills')
  })

  it('hides Qwen commands that cannot execute reliably', () => {
    const sections = createQwenSlashSections({
      availableCommands: [
        { name: 'model', description: 'Switch model' },
        { name: 'skills', description: 'List skills' },
        { name: 'status', description: 'Show status' },
      ],
      availableSkills: ['model', 'skills', 'commit'],
      enabled: true,
    })
    const labels = sections.flatMap(section => section.items.map(item => item.label))

    expect(labels).toEqual(['/status', '/commit'])
  })

  it('adds skills as slash commands without duplicating command names', () => {
    const sections = createQwenSlashSections({
      availableCommands: [{ name: 'review', description: 'Review code' }],
      availableSkills: ['review', 'commit'],
      enabled: true,
    })

    const skillSection = sections.find(section => section.id === 'qwen-skills')
    expect(skillSection?.items.map(item => item.label)).toEqual(['/commit'])
    expect(skillSection?.items[0]).toMatchObject({
      id: 'qwen-skill:commit',
      insertText: '/commit ',
    })
  })

  it('returns no sections when disabled', () => {
    expect(createQwenSlashSections({ enabled: false })).toEqual([])
  })
})
