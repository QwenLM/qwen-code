import { describe, expect, it } from 'bun:test'
import type { ImageProcessor } from '../runtime/platform'
import { inspectImageBuffer } from './image-utils'

const buffer = Buffer.from('test-image')

describe('inspectImageBuffer', () => {
  it('returns ok when metadata is available', async () => {
    const processor: ImageProcessor = {
      getMetadata: async () => ({ width: 640, height: 480 }),
      process: async () => Buffer.from('unused'),
    }

    await expect(inspectImageBuffer(buffer, processor)).resolves.toEqual({
      status: 'ok',
      width: 640,
      height: 480,
    })
  })

  it('returns invalid_image when the processor can run but the input is unreadable', async () => {
    const processor: ImageProcessor = {
      getMetadata: async () => null,
      process: async () => {
        throw new Error('Input buffer contains unsupported image format')
      },
    }

    await expect(inspectImageBuffer(buffer, processor)).resolves.toMatchObject({
      status: 'invalid_image',
    })
  })

  it('returns processor_unavailable when image processing support is missing', async () => {
    const processor: ImageProcessor = {
      getMetadata: async () => null,
      process: async () => {
        throw new Error("Cannot find package 'sharp' imported from image-utils")
      },
    }

    await expect(inspectImageBuffer(buffer, processor)).resolves.toMatchObject({
      status: 'processor_unavailable',
    })
  })
})
