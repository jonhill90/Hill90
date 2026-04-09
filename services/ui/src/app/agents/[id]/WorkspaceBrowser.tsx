'use client'

import { useState, useEffect, useCallback } from 'react'
import { ChevronRight, ChevronDown, File, Folder, FolderOpen, RefreshCw, AlertCircle } from 'lucide-react'

interface FileEntry {
  name: string
  type: 'file' | 'directory' | 'unknown'
  size: number
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

function FileRow({
  entry,
  depth,
  agentId,
}: {
  entry: FileEntry
  depth: number
  agentId: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FileEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [currentPath, setCurrentPath] = useState('')

  const isDir = entry.type === 'directory'
  const paddingLeft = depth * 16 + 8

  const loadChildren = useCallback(async (dirPath: string) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/agents/${agentId}/workspace?path=${encodeURIComponent(dirPath)}`)
      if (res.ok) {
        const data = await res.json()
        setChildren(data.entries || [])
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [agentId])

  const handleToggle = () => {
    if (!isDir) return
    if (!expanded && children === null) {
      loadChildren(currentPath)
    }
    setExpanded(!expanded)
  }

  // Set path from parent context
  useEffect(() => {
    if (entry.name && isDir) {
      // Path will be set by parent via prop — for now derive from context
    }
  }, [entry.name, isDir])

  if (isDir) {
    return (
      <div>
        <button
          onClick={handleToggle}
          className="flex items-center gap-1.5 w-full py-1 px-2 text-sm text-mountain-300 hover:text-white hover:bg-navy-700/50 rounded transition-colors cursor-pointer"
          style={{ paddingLeft }}
        >
          {loading ? (
            <RefreshCw size={14} className="text-mountain-500 flex-shrink-0 animate-spin" />
          ) : expanded ? (
            <ChevronDown size={14} className="text-mountain-500 flex-shrink-0" />
          ) : (
            <ChevronRight size={14} className="text-mountain-500 flex-shrink-0" />
          )}
          {expanded ? (
            <FolderOpen size={16} className="text-yellow-400 flex-shrink-0" />
          ) : (
            <Folder size={16} className="text-yellow-400 flex-shrink-0" />
          )}
          <span className="font-medium">{entry.name}</span>
          {children && (
            <span className="text-xs text-mountain-600 ml-auto">{children.length} items</span>
          )}
        </button>
        {expanded && children && (
          <div>
            {children
              .sort((a, b) => {
                if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
                return a.name.localeCompare(b.name)
              })
              .map((child) => (
                <FileRowWithPath
                  key={child.name}
                  entry={child}
                  depth={depth + 1}
                  agentId={agentId}
                  parentPath={currentPath}
                />
              ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className="flex items-center gap-1.5 py-1 px-2 text-sm text-mountain-400 hover:text-white hover:bg-navy-700/50 rounded transition-colors"
      style={{ paddingLeft: paddingLeft + 18 }}
    >
      <File size={14} className="text-mountain-500 flex-shrink-0" />
      <span>{entry.name}</span>
      {entry.size > 0 && (
        <span className="text-xs text-mountain-600 ml-auto">{formatSize(entry.size)}</span>
      )}
    </div>
  )
}

function FileRowWithPath({
  entry,
  depth,
  agentId,
  parentPath,
}: {
  entry: FileEntry
  depth: number
  agentId: string
  parentPath: string
}) {
  const fullPath = parentPath ? `${parentPath}/${entry.name}` : entry.name

  if (entry.type === 'directory') {
    return <DirNode entry={entry} depth={depth} agentId={agentId} path={fullPath} />
  }

  const paddingLeft = depth * 16 + 8 + 18
  return (
    <div
      className="flex items-center gap-1.5 py-1 px-2 text-sm text-mountain-400 hover:text-white hover:bg-navy-700/50 rounded transition-colors"
      style={{ paddingLeft }}
    >
      <File size={14} className="text-mountain-500 flex-shrink-0" />
      <span>{entry.name}</span>
      {entry.size > 0 && (
        <span className="text-xs text-mountain-600 ml-auto">{formatSize(entry.size)}</span>
      )}
    </div>
  )
}

function DirNode({
  entry,
  depth,
  agentId,
  path,
}: {
  entry: FileEntry
  depth: number
  agentId: string
  path: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FileEntry[] | null>(null)
  const [loading, setLoading] = useState(false)

  const paddingLeft = depth * 16 + 8

  const handleToggle = async () => {
    if (!expanded && children === null) {
      setLoading(true)
      try {
        const res = await fetch(`/api/agents/${agentId}/workspace?path=${encodeURIComponent(path)}`)
        if (res.ok) {
          const data = await res.json()
          setChildren(data.entries || [])
        }
      } catch {
        // ignore
      } finally {
        setLoading(false)
      }
    }
    setExpanded(!expanded)
  }

  return (
    <div>
      <button
        onClick={handleToggle}
        className="flex items-center gap-1.5 w-full py-1 px-2 text-sm text-mountain-300 hover:text-white hover:bg-navy-700/50 rounded transition-colors cursor-pointer"
        style={{ paddingLeft }}
      >
        {loading ? (
          <RefreshCw size={14} className="text-mountain-500 flex-shrink-0 animate-spin" />
        ) : expanded ? (
          <ChevronDown size={14} className="text-mountain-500 flex-shrink-0" />
        ) : (
          <ChevronRight size={14} className="text-mountain-500 flex-shrink-0" />
        )}
        {expanded ? (
          <FolderOpen size={16} className="text-yellow-400 flex-shrink-0" />
        ) : (
          <Folder size={16} className="text-yellow-400 flex-shrink-0" />
        )}
        <span className="font-medium">{entry.name}</span>
        {children && (
          <span className="text-xs text-mountain-600 ml-auto">{children.length} items</span>
        )}
      </button>
      {expanded && children && (
        <div>
          {children
            .sort((a, b) => {
              if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
              return a.name.localeCompare(b.name)
            })
            .map((child) => (
              <FileRowWithPath
                key={child.name}
                entry={child}
                depth={depth + 1}
                agentId={agentId}
                parentPath={path}
              />
            ))}
        </div>
      )}
    </div>
  )
}

export default function WorkspaceBrowser({ agentId }: { agentId: string }) {
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchRoot = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/agents/${agentId}/workspace`)
      if (res.status === 409) {
        setError('Agent is not running. Start the agent to browse workspace files.')
        return
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error || `Failed to load (${res.status})`)
        return
      }
      const data = await res.json()
      setEntries(data.entries || [])
    } catch {
      setError('Failed to connect to agent workspace')
    } finally {
      setLoading(false)
    }
  }, [agentId])

  useEffect(() => {
    fetchRoot()
  }, [fetchRoot])

  return (
    <div className="rounded-lg border border-navy-700 bg-navy-800 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-white">Workspace Files</h2>
        <button
          onClick={fetchRoot}
          disabled={loading}
          className="p-1 text-mountain-400 hover:text-white rounded transition-colors disabled:opacity-50 cursor-pointer"
          title="Refresh"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error ? (
        <div className="flex items-center gap-2 py-6 justify-center text-mountain-500 text-sm">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center py-8">
          <div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
        </div>
      ) : entries.length === 0 ? (
        <p className="text-sm text-mountain-500 text-center py-6">Workspace is empty</p>
      ) : (
        <div className="rounded-md border border-navy-700 bg-navy-900 p-2 max-h-[500px] overflow-y-auto">
          {entries
            .sort((a, b) => {
              if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
              return a.name.localeCompare(b.name)
            })
            .map((entry) => (
              <FileRowWithPath
                key={entry.name}
                entry={entry}
                depth={0}
                agentId={agentId}
                parentPath="/home/agentuser"
              />
            ))}
        </div>
      )}
    </div>
  )
}
