'use client'

import { useState, useEffect, useCallback } from 'react'
import { Server, Plus, Trash2 } from 'lucide-react'

interface McpServer {
  id: string
  name: string
  transport: string
  description: string | null
}

interface AssignedServer {
  mcp_server_id: string
  name: string
  transport: string
  enabled: boolean
  added_at: string
}

export default function AgentMcpServers({ agentId, agentStatus }: { agentId: string; agentStatus: string }) {
  const [assigned, setAssigned] = useState<AssignedServer[]>([])
  const [available, setAvailable] = useState<McpServer[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [selectedId, setSelectedId] = useState('')

  const fetchData = useCallback(async () => {
    try {
      const [assignedRes, allRes] = await Promise.all([
        fetch(`/api/mcp-servers`),  // TODO: add agent-scoped endpoint
        fetch('/api/mcp-servers'),
      ])
      if (allRes.ok) {
        const all = await allRes.json()
        setAvailable(all)
        // For now show all servers — agent assignment endpoint coming in Phase 2
        setAssigned([])
      }
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [agentId])

  useEffect(() => { fetchData() }, [fetchData])

  if (loading) return <div className="flex justify-center py-4"><div className="h-5 w-5 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" /></div>

  return (
    <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Server className="w-4 h-4 text-mountain-400" />
          <h2 className="text-lg font-semibold text-white">MCP Servers</h2>
        </div>
        <a href="/harness/mcp-servers" className="text-xs text-brand-400 hover:text-brand-300">Manage Servers →</a>
      </div>

      {available.length === 0 ? (
        <div className="text-center py-4">
          <p className="text-sm text-mountain-400">No MCP servers configured</p>
          <a href="/harness/mcp-servers" className="text-xs text-brand-400 hover:underline mt-1 inline-block">Add a server →</a>
        </div>
      ) : (
        <div className="space-y-2">
          {available.map(s => (
            <div key={s.id} className="flex items-center justify-between rounded border border-navy-600 bg-navy-900 px-3 py-2">
              <div className="flex items-center gap-2">
                <Server className="w-3.5 h-3.5 text-mountain-400" />
                <span className="text-sm text-white">{s.name}</span>
                <span className="text-xs text-mountain-500 bg-navy-700 px-1.5 py-0.5 rounded">{s.transport}</span>
              </div>
              {s.description && <span className="text-xs text-mountain-500 truncate max-w-xs">{s.description}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
