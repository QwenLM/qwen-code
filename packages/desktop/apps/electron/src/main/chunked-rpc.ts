/**
 * Chunked RPC — send large payloads over WebSocket in small pieces.
 *
 * Splits a single large RPC argument into base64 chunks (~2.7MB each),
 * sends them via the transfer:start/chunk/commit protocol, and the
 * remote server reassembles and executes the original RPC handler.
 *
 * Each chunk is retried up to 3 times on failure to handle transient
 * connection issues through proxies/tunnels.
 */

import { createHash } from 'node:crypto'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { WsRpcClient } from '../transport/client'

/**
 * 2MB raw → ~2.7MB after base64 encoding.
 * Larger chunks = fewer round trips (a 250MB payload = ~125 chunks instead of 651).
 * Still well under common per-message proxy limits.
 */
export const CHUNK_SIZE = 2 * 1024 * 1024

/** Threshold above which we switch from direct RPC to chunked transfer. */
export const CHUNKED_TRANSFER_THRESHOLD = 5 * 1024 * 1024

/** Max retries per chunk before giving up. */
const MAX_CHUNK_RETRIES = 3

/** Delay between chunk retries (ms). */
const CHUNK_RETRY_DELAY = 1000

export interface PreparedChunkedPayload {
  bytes: Buffer
  checksum: string
  chunkCount: number
}

export function getChunkCount(totalBytes: number): number {
  return Math.ceil(totalBytes / CHUNK_SIZE)
}

export function prepareChunkedPayload(value: unknown): PreparedChunkedPayload {
  const json = JSON.stringify(value)
  const bytes = Buffer.from(json, 'utf-8')
  return {
    bytes,
    checksum: createHash('sha256').update(bytes).digest('hex'),
    chunkCount: getChunkCount(bytes.length),
  }
}

/**
 * Send a large RPC call in chunks over the existing WebSocket connection.
 *
 * @param client         Connected WsRpcClient to the remote server
 * @param channel        The original RPC channel (e.g. 'sessions:import')
 * @param args           The original arguments array
 * @param largeArgIndex  Which argument is the large payload (will be chunked)
 * @param onProgress     Optional callback with (sentChunks, totalChunks) for UI progress
 * @param prepared       Optional pre-serialized payload so callers can inspect size without re-serializing
 * @returns              The result from the remote handler (same as a direct invoke)
 */
export async function invokeChunked(
  client: WsRpcClient,
  channel: string,
  args: any[],
  largeArgIndex: number,
  onProgress?: (sent: number, total: number) => void,
  prepared?: PreparedChunkedPayload,
): Promise<any> {
  const payload = prepared ?? prepareChunkedPayload(args[largeArgIndex])

  // Build deferred args (replace large arg with null placeholder)
  const deferredArgs = [...args]
  deferredArgs[largeArgIndex] = null

  const payloadMB = (payload.bytes.length / (1024 * 1024)).toFixed(1)
  console.log(`[ChunkedRPC] Starting transfer: ${payload.chunkCount} chunks, ${payloadMB}MB, sha256: ${payload.checksum.slice(0, 12)}..., channel: ${channel}`)

  let transferId: string | null = null
  try {
    const startResult = await client.invoke(RPC_CHANNELS.transfer.START, {
      totalBytes: payload.bytes.length,
      chunkCount: payload.chunkCount,
      channel,
      args: deferredArgs,
      largeArgIndex,
      checksum: payload.checksum,
    }) as { transferId: string }

    transferId = startResult.transferId
    console.log(`[ChunkedRPC] Transfer started: ${transferId}`)

    for (let i = 0; i < payload.chunkCount; i++) {
      const start = i * CHUNK_SIZE
      const end = Math.min(start + CHUNK_SIZE, payload.bytes.length)
      const data = payload.bytes.subarray(start, end).toString('base64')

      let lastError: Error | null = null
      for (let attempt = 1; attempt <= MAX_CHUNK_RETRIES; attempt++) {
        try {
          await client.invoke(RPC_CHANNELS.transfer.CHUNK, {
            transferId,
            index: i,
            data,
          })
          lastError = null
          break
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err))
          if (attempt < MAX_CHUNK_RETRIES) {
            console.warn(`[ChunkedRPC] Chunk ${i + 1}/${payload.chunkCount} failed (attempt ${attempt}/${MAX_CHUNK_RETRIES}): ${lastError.message}. Retrying in ${CHUNK_RETRY_DELAY}ms...`)
            await new Promise(r => setTimeout(r, CHUNK_RETRY_DELAY))
          }
        }
      }

      if (lastError) {
        throw new Error(`Chunk ${i + 1}/${payload.chunkCount} failed after ${MAX_CHUNK_RETRIES} attempts: ${lastError.message}`)
      }

      onProgress?.(i + 1, payload.chunkCount)

      if ((i + 1) % 10 === 0 || i === payload.chunkCount - 1) {
        console.log(`[ChunkedRPC] Sent chunk ${i + 1}/${payload.chunkCount}`)
      }
    }

    console.log('[ChunkedRPC] All chunks sent, committing...')
    const result = await client.invoke(RPC_CHANNELS.transfer.COMMIT, { transferId })
    console.log('[ChunkedRPC] Transfer committed successfully')
    transferId = null
    return result
  } catch (error) {
    if (transferId) {
      try {
        await client.invoke(RPC_CHANNELS.transfer.ABORT, { transferId })
      } catch {
        // Best effort cleanup — the server may already have cleaned up.
      }
    }
    throw error
  }
}
