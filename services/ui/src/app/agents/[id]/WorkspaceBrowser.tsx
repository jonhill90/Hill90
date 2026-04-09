'use client'

import { useState, useEffect, useCallback } from 'react'
import { ChevronRight, File, Folder, FolderOpen, ArrowLeft, RefreshCw } from 'lucide-react'

interface WorkspaceFile {
  name: string
  size: number
  type: 'file' | 'directory'
  modified: string
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function WorkspaceBrowser({ agentId, agentUuid, status }: { agentId: string; agentUuid: string; status: string }) {
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [currentPath, setCurrentPath] = useState('/workspace')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchFiles = useCallback(async (path: string) => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ path })
      const res = await fetch(`/api/agents/${agentUuid}/workspace?${params}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Failed to list files (${res.status})`)
      }
      const data = await res.json()
      setFiles(data.files || [])
      setCurrentPath(path)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to list files')
      setFiles([])
    } finally {
      setLoading(false)
    }
  }, [agentUuid])

  useEffect(() => {
    if (status === 'running') {
      fetchFiles('/workspace')
    }
  }, [status, fetchFiles])

  if (status !== 'running') {
    return (
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-8 text-center">
        <Folder className="h-10 w-10 text-mountain-500 mx-auto mb-3" />
        <p className="text-mountain-400">Agent must be running to browse workspace files.</p>
      </div>
    )
  }

  const navigateTo = (dir: string) => {
    fetchFiles(currentPath === '/' ? `/${dir}` : `${currentPath}/${dir}`)
  }

  const navigateUp = () => {
    const parts = currentPath.split('/')
    parts.pop()
    const parent = parts.join('/') || '/'
    fetchFiles(parent)
  }

  const pathParts = currentPath.split('/').filter(Boolean)

  return (
    <div className="rounded-lg border border-navy-700 bg-navy-800 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-navy-700">
        <div className="flex items-center gap-2 text-sm">
          {currentPath !== '/workspace' && (
            <button
              onClick={navigateUp}
              className="p-1 rounded text-mountain-400 hover:text-white hover:bg-navy-700 transition-colors cursor-pointer"
              title="Go up"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <nav className="flex items-center gap-1 text-mountain-400">
            {pathParts.map((part, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="h-3 w-3 text-mountain-600" />}
                <span className={i === pathParts.length - 1 ? 'text-white' : ''}>{part}</span>
              </span>
            ))}
          </nav>
        </div>
        <button
          onClick={() => fetchFiles(currentPath)}
          disabled={loading}
          className="p-1.5 rounded text-mountain-400 hover:text-white hover:bg-navy-700 transition-colors cursor-pointer disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="px-4 py-3 bg-red-900/20 border-b border-red-700">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Content */}
      {loading && !error ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-5 w-5 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
        </div>
      ) : files.length === 0 && !error ? (
        <div className="py-12 text-center">
          <p className="text-sm text-mountain-500">Empty directory</p>
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-navy-700 text-left text-mountain-400">
              <th className="px-4 py-2.5 font-medium">Name</th>
              <th className="px-4 py-2.5 font-medium w-24 text-right">Size</th>
              <th className="px-4 py-2.5 font-medium w-40 text-right">Modified</th>
            </tr>
          </thead>
          <tbody>
            {files.map((file) => (
              <tr
                key={file.name}
                className={`border-b border-navy-700/50 hover:bg-navy-700/30 transition-colors ${file.type === 'directory' ? 'cursor-pointer' : ''}`}
                onClick={file.type === 'directory' ? () => navigateTo(file.name) : undefined}
              >
                <td className="px-4 py-2">
                  <span className="flex items-center gap-2 text-white">
                    {file.type === 'directory' ? (
                      <FolderOpen className="h-4 w-4 text-yellow-400 flex-shrink-0" />
                    ) : (
                      <File className="h-4 w-4 text-mountain-400 flex-shrink-0" />
                    )}
                    {file.name}{file.type === 'directory' ? '/' : ''}
                  </span>
                </td>
                <td className="px-4 py-2 text-right text-mountain-400">
                  {file.type === 'directory' ? '--' : formatSize(file.size)}
                </td>
                <td className="px-4 py-2 text-right text-mountain-400">
                  {formatDate(file.modified)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
