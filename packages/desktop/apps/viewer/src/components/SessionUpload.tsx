/**
 * SessionUpload - File upload component for session JSON files
 *
 * Supports:
 * - Click to browse files
 * - Drag and drop
 * - Paste from clipboard
 */

import * as React from 'react'
import { useState, useCallback, useRef, useEffect } from 'react'
import type { StoredSession } from '@craft-agent/core'
import { Upload, FileJson, AlertCircle } from 'lucide-react'

interface SessionUploadProps {
  onSessionLoad: (session: StoredSession) => void
}

export function SessionUpload({ onSessionLoad }: SessionUploadProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const parseSessionFile = useCallback(async (file: File) => {
    setError(null)

    if (!file.name.endsWith('.json')) {
      setError('Please upload a JSON file')
      return
    }

    try {
      const text = await file.text()
      const data = JSON.parse(text)

      // Validate basic session structure
      if (!data.id || !data.messages || !Array.isArray(data.messages)) {
        setError('Invalid session format: missing id or messages array')
        return
      }

      onSessionLoad(data as StoredSession)
    } catch {
      setError('Failed to parse JSON file')
    }
  }, [onSessionLoad])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    const file = e.dataTransfer.files[0]
    if (file) {
      parseSessionFile(file)
    }
  }, [parseSessionFile])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      parseSessionFile(file)
    }
  }, [parseSessionFile])

  const handleClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  // Handle paste from clipboard
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text')
      if (!text) return

      try {
        const data = JSON.parse(text)
        if (data.id && data.messages && Array.isArray(data.messages)) {
          onSessionLoad(data as StoredSession)
        }
      } catch {
        // Not valid JSON, ignore
      }
    }

    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [onSessionLoad])

  return (
    <div className="w-full max-w-xl">
      <div
        onClick={handleClick}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`
          drop-zone cursor-pointer rounded-lg border-2 border-dashed p-12
          flex flex-col items-center justify-center gap-4
          transition-all duration-200
          ${isDragging
            ? 'active border-accent bg-accent/5'
            : 'border-foreground/10 hover:border-foreground/20 hover:bg-foreground/3'
          }
        `}
      >
        <div className={`
          p-4 rounded-full
          ${isDragging ? 'bg-accent/10 text-accent' : 'bg-foreground/5 text-foreground/50'}
        `}>
          {isDragging ? (
            <FileJson className="w-8 h-8" />
          ) : (
            <Upload className="w-8 h-8" />
          )}
        </div>

        <div className="text-center">
          <p className="text-lg font-medium text-foreground">
            {isDragging ? 'Drop session file here' : 'Upload session JSON'}
          </p>
          <p className="mt-1 text-sm text-foreground/50">
            Drag and drop, click to browse, or paste from clipboard
          </p>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          onChange={handleFileSelect}
          className="hidden"
        />
      </div>

      {error && (
        <div className="mt-4 flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="mt-6 text-center text-xs text-foreground/30">
        <p>Session files are processed locally in your browser.</p>
        <p>No data is uploaded to any server.</p>
      </div>
    </div>
  )
}
