import { describe, expect, it } from 'bun:test'
import {
  MAX_DROPPED_VOICE_FRAMES,
  sendVoicePcmFrame,
} from './voice-frame-sender'

describe('sendVoicePcmFrame', () => {
  it('sends open frames and clears the dropped-frame count', () => {
    const sent: ArrayBuffer[] = []
    const ws = {
      OPEN: 1,
      readyState: 1,
      send: (frame: ArrayBuffer) => sent.push(frame),
    }
    const frame = new ArrayBuffer(2)

    const next = sendVoicePcmFrame(ws, frame, 2, () => {
      throw new Error('should not fail')
    })

    expect(sent).toEqual([frame])
    expect(next).toBe(0)
  })

  it('fails after repeated dropped frames while the socket is not open', () => {
    let failed = false
    const ws = {
      OPEN: 1,
      readyState: 0,
      send: () => {
        throw new Error('should not send')
      },
    }

    let dropped = 0
    for (let i = 0; i < MAX_DROPPED_VOICE_FRAMES; i++) {
      dropped = sendVoicePcmFrame(ws, new ArrayBuffer(1), dropped, () => {
        failed = true
      })
    }

    expect(failed).toBe(true)
    expect(dropped).toBe(MAX_DROPPED_VOICE_FRAMES)
  })
})
