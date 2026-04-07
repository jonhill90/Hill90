'use client'

import { useState } from 'react'
import { ChevronRight, ChevronDown, File, Folder, FolderOpen } from 'lucide-react'

interface FileNode {
  name: string
  type: 'file' | 'directory'
  size?: number
  children?: FileNode[]
}

// Mock workspace tree — will connect to real agent workspace API later
const MOCK_WORKSPACE: FileNode[] = [
  {
    name: 'workspace',
    type: 'directory',
    children: [
      {
        name: 'plans',
        type: 'directory',
        children: [
          { name: 'current-task.md', type: 'file', size: 2048 },
          { name: 'backlog.md', type: 'file', size: 1024 },
        ],
      },
      {
        name: 'scratch',
        type: 'directory',
        children: [
          { name: 'notes.txt', type: 'file', size: 512 },
          { name: 'research.md', type: 'file', size: 3072 },
        ],
      },
      {
        name: 'output',
        type: 'directory',
        children: [
          { name: 'report.md', type: 'file', size: 4096 },
          { name: 'analysis.json', type: 'file', size: 1536 },
        ],
      },
      { name: 'SOUL.md', type: 'file', size: 768 },
      { name: 'RULES.md', type: 'file', size: 512 },
      { name: '.env', type: 'file', size: 128 },
    ],
  },
]

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

function TreeNode({ node, depth = 0 }: { node: FileNode; depth?: number }) {
  const [expanded, setExpanded] = useState(depth === 0)

  const isDir = node.type === 'directory'
  const paddingLeft = depth * 16 + 8

  if (isDir) {
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 w-full py-1 px-2 text-sm text-mountain-300 hover:text-white hover:bg-navy-700/50 rounded transition-colors cursor-pointer"
          style={{ paddingLeft }}
        >
          {expanded ? (
            <ChevronDown size={14} className="text-mountain-500 flex-shrink-0" />
          ) : (
            <ChevronRight size={14} className="text-mountain-500 flex-shrink-0" />
          )}
          {expanded ? (
            <FolderOpen size={16} className="text-yellow-400 flex-shrink-0" />
          ) : (
            <Folder size={16} className="text-yellow-400 flex-shrink-0" />
          )}
          <span className="font-medium">{node.name}</span>
          {node.children && (
            <span className="text-xs text-mountain-600 ml-auto">{node.children.length} items</span>
          )}
        </button>
        {expanded && node.children && (
          <div>
            {node.children
              .sort((a, b) => {
                if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
                return a.name.localeCompare(b.name)
              })
              .map((child) => (
                <TreeNode key={child.name} node={child} depth={depth + 1} />
              ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className="flex items-center gap-1.5 py-1 px-2 text-sm text-mountain-400 hover:text-white hover:bg-navy-700/50 rounded transition-colors cursor-pointer"
      style={{ paddingLeft: paddingLeft + 18 }}
    >
      <File size={14} className="text-mountain-500 flex-shrink-0" />
      <span>{node.name}</span>
      {node.size != null && (
        <span className="text-xs text-mountain-600 ml-auto">{formatSize(node.size)}</span>
      )}
    </div>
  )
}

export default function WorkspaceBrowser({ agentId }: { agentId: string }) {
  return (
    <div className="rounded-lg border border-navy-700 bg-navy-800 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-white">Workspace Files</h2>
        <span className="text-xs text-mountain-500">Agent: {agentId}</span>
      </div>
      <div className="rounded-md border border-navy-700 bg-navy-900 p-2 max-h-[500px] overflow-y-auto">
        {MOCK_WORKSPACE.map((node) => (
          <TreeNode key={node.name} node={node} />
        ))}
      </div>
      <p className="text-xs text-mountain-600 mt-3">
        Static preview — will connect to agent workspace API in a future update.
      </p>
    </div>
  )
}
