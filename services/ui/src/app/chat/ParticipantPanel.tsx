'use client'

import { useState, useEffect } from 'react'
import { X, Plus, UserMinus } from 'lucide-react'
import type { ChatAgent } from './ChatLayout'

interface Agent {
  id: string
  agent_id: string
  name: string
  status: string
}

interface Props {
  threadId: string
  currentAgents: ChatAgent[]
  onUpdated: () => void
  onClose: () => void
}

const MAX_AGENTS = 8

export default function ParticipantPanel({ threadId, currentAgents, onUpdated, onClose }: Props) {
  const [availableAgents, setAvailableAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)

  const currentIds = new Set(currentAgents.map(a => a.id))
  const addableAgents = availableAgents.filter(
    a => !currentIds.has(a.id) && a.status === 'running'
  )
  const atLimit = currentAgents.length >= MAX_AGENTS

  useEffect(() => {
    async function fetchAgents() {
      try {
        const res = await fetch('/api/agents')
        if (res.ok) {
          const data = await res.json()
          setAvailableAgents(data)
        }
      } catch {
        // Non-fatal
      } finally {
        setLoading(false)
      }
    }
    fetchAgents()
  }, [])

  const handleAdd = async (agentId: string) => {
    setActionLoading(agentId)
    setError(null)
    try {
      const res = await fetch(`/api/chat/${threadId}/participants`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ add: [agentId] }),
      })
      if (res.ok) {
        onUpdated()
      } else {
        const data = await res.json()
        setError(data.error || 'Failed to add agent')
      }
    } catch {
      setError('Failed to add agent')
    } finally {
      setActionLoading(null)
    }
  }

  const handleRemove = async (agentId: string) => {
    setConfirmRemoveId(null)
    setActionLoading(agentId)
    setError(null)
    try {
      const res = await fetch(`/api/chat/${threadId}/participants`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remove: [agentId] }),
      })
      if (res.ok) {
        onUpdated()
      } else {
        const data = await res.json()
        setError(data.error || 'Failed to remove agent')
      }
    } catch {
      setError('Failed to remove agent')
    } finally {
      setActionLoading(null)
    }
  }

  return (
    <div className="flex flex-col h-full" data-testid="participant-panel">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-navy-700">
        <h3 className="text-sm font-semibold text-white">Participants</h3>
        <button
          onClick={onClose}
          className="text-mountain-400 hover:text-white transition-colors"
          aria-label="Close participants"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {error && (
          <div className="text-xs text-red-400 bg-red-900/20 rounded px-2 py-1">
            {error}
          </div>
        )}

        {/* Current participants */}
        <div>
          <h4 className="text-xs font-medium text-mountain-400 uppercase tracking-wider mb-2">
            Current ({currentAgents.length}/{MAX_AGENTS})
          </h4>
          <div className="space-y-1">
            {currentAgents.map(agent => (
              <div
                key={agent.id}
                className="flex items-center justify-between px-2 py-1.5 rounded bg-navy-800"
                data-testid="current-participant"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      agent.status === 'running' ? 'bg-brand-400' : 'bg-mountain-500'
                    }`}
                  />
                  <span className="text-sm text-gray-200 truncate">{agent.name}</span>
                  <span className="text-xs text-mountain-500">@{agent.agent_id}</span>
                </div>
                {confirmRemoveId === agent.id ? (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleRemove(agent.id)}
                      disabled={actionLoading === agent.id}
                      className="text-xs text-red-400 hover:text-red-300 px-1"
                      data-testid="confirm-remove"
                    >
                      Remove
                    </button>
                    <button
                      onClick={() => setConfirmRemoveId(null)}
                      className="text-xs text-mountain-400 hover:text-white px-1"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmRemoveId(agent.id)}
                    className="text-mountain-500 hover:text-red-400 transition-colors p-0.5"
                    title="Remove agent"
                    data-testid="remove-button"
                  >
                    <UserMinus size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Add agents */}
        {!atLimit && (
          <div>
            <h4 className="text-xs font-medium text-mountain-400 uppercase tracking-wider mb-2">
              Add Agent
            </h4>
            {loading ? (
              <p className="text-xs text-mountain-500">Loading agents...</p>
            ) : addableAgents.length === 0 ? (
              <p className="text-xs text-mountain-500">No available agents to add</p>
            ) : (
              <div className="space-y-1">
                {addableAgents.map(agent => (
                  <button
                    key={agent.id}
                    onClick={() => handleAdd(agent.id)}
                    disabled={actionLoading === agent.id}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded bg-navy-800 hover:bg-navy-700 transition-colors disabled:opacity-50 text-left"
                    data-testid="add-agent-button"
                  >
                    <Plus size={14} className="text-brand-400 flex-shrink-0" />
                    <span className="text-sm text-gray-200 truncate">{agent.name}</span>
                    <span className="text-xs text-mountain-500">@{agent.agent_id}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {atLimit && (
          <p className="text-xs text-mountain-500">
            Maximum {MAX_AGENTS} agents per group reached
          </p>
        )}
      </div>
    </div>
  )
}
