import { describe, expect, it } from 'bun:test'
import { transcribeQwenAsrBatch } from './transcribe'

describe('transcribeQwenAsrBatch', () => {
  it('posts audio chat completions and returns trimmed text', async () => {
    let requestUrl = ''
    let requestBody: unknown
    let requestHeaders: RequestInit['headers']
    let requestInit: RequestInit | undefined
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(url)
      requestBody = JSON.parse(String(init?.body))
      requestHeaders = init?.headers
      requestInit = init
      return Response.json({
        choices: [{ message: { content: ' hello desktop ' } }],
      })
    }

    await expect(
      transcribeQwenAsrBatch(
        { data: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' },
        {
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/',
          model: 'qwen3-asr-flash',
          apiKey: 'secret-key',
        },
        { language: 'en' },
        fetchFn as unknown as typeof fetch,
      ),
    ).resolves.toBe('hello desktop')

    expect(requestUrl).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    )
    expect(requestHeaders).toMatchObject({
      Authorization: 'Bearer secret-key',
      'Content-Type': 'application/json',
    })
    expect(requestInit?.redirect).toBe('error')
    expect(requestBody).toMatchObject({
      model: 'qwen3-asr-flash',
      asr_options: { enable_itn: true, language: 'en' },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: {
                data: 'data:audio/wav;base64,AQID',
                format: 'wav',
              },
            },
          ],
        },
      ],
    })
  })

  it('redacts credentials from failed provider responses', async () => {
    const fetchFn = async () =>
      new Response(
        'Bearer leaked-token and explicit leaked-token should not escape',
        {
          status: 500,
          statusText: 'Internal Server Error',
        },
      )

    const promise = transcribeQwenAsrBatch(
      { data: new Uint8Array([1]), mimeType: 'audio/wav' },
      {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3-asr-flash',
        apiKey: 'leaked-token',
      },
      {},
      fetchFn as unknown as typeof fetch,
    )

    await expect(promise).rejects.toThrow('Bearer [REDACTED]')
    await expect(promise).rejects.not.toThrow('leaked-token')
  })

  it('redacts credentials leaked through the response status line', async () => {
    // A malicious/non-standard ASR proxy controls the reason phrase too; the
    // body is clean so any leak can only come from response.statusText.
    const fetchFn = async () =>
      new Response('', {
        status: 500,
        statusText: 'Bearer leaked-token rejected for leaked-token',
      })

    const promise = transcribeQwenAsrBatch(
      { data: new Uint8Array([1]), mimeType: 'audio/wav' },
      {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3-asr-flash',
        apiKey: 'leaked-token',
      },
      {},
      fetchFn as unknown as typeof fetch,
    )

    await expect(promise).rejects.toThrow('[REDACTED]')
    await expect(promise).rejects.not.toThrow('leaked-token')
  })
})
