'use client'

import { useState, useEffect } from 'react'
import { X } from 'lucide-react'

interface Agent {
  id: string
  agent_id: string
  name: string
  status: string
}

interface Props {
  onClose: () => void
  onCreated: (threadId: string) => void
}

export default function NewThreadDialog({ onClose, onCreated }: Props) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchAgents() {
      try {
        const res = await fetch('/api/agents')
        if (res.ok) {
          const data = await res.json()
          setAgents(data.filter((a: Agent) => a.status === 'running'))
        }
      } catch {
        setError('Failed to load agents')
      } finally {
        setLoading(false)
      }
    }
    fetchAgents()
  }, [])

  const toggleAgent = (agentId: string) => {
    setSelectedAgents(prev => {
      const next = new Set(prev)
      if (next.has(agentId)) {
        next.delete(agentId)
      } else {
        if (next.size >= 8) return prev // Max 8 agents
        next.add(agentId)
      }
      return next
    })
  }

  const isGroup = selectedAgents.size > 1

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (selectedAgents.size === 0 || !message.trim()) return

    setSending(true)
    setError(null)

    const agentIds = Array.from(selectedAgents)

    try {
      const body = isGroup
        ? { agent_ids: agentIds, message: message.trim() }
        : { agent_id: agentIds[0], message: message.trim() }

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const data = await res.json()
        setError(data.error || data.detail || `Error: ${res.status}`)
        return
      }

      const data = await res.json()
      onCreated(data.thread.id)
    } catch {
      setError('Failed to create thread')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-navy-800 border border-navy-700 rounded-xl w-full max-w-md mx-4 shadow-xl">
        <div className="flex items-center justify-between p-4 border-b border-navy-700">
          <h3 className="text-lg font-semibold text-gray-200">New Chat</h3>
          <button onClick={onClose} className="text-mountain-400 hover:text-gray-200 transition-colors">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-sm text-mountain-400 mb-1.5">
              Select agents {isGroup && <span className="text-mountain-500">(group chat)</span>}
            </label>
            {loading ? (
              <p className="text-sm text-mountain-500">Loading agents...</p>
            ) : agents.length === 0 ? (
              <p className="text-sm text-mountain-500">No running agents available</p>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-y-auto" data-testid="agent-picker">
                {agents.map(agent => {
                  const checked = selectedAgents.has(agent.id)
                  return (
                    <label
                      key={agent.id}
                      className={`flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                        checked
                          ? 'bg-brand-600/10 border border-brand-600/30'
                          : 'bg-navy-900 border border-navy-700 hover:border-navy-600'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleAgent(agent.id)}
                        className="sr-only"
                      />
                      <span
                        className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                          checked
                            ? 'bg-brand-600 border-brand-600'
                            : 'border-navy-600 bg-navy-800'
                        }`}
                      >
                        {checked && (
                          <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
                            <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </span>
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-brand-400 flex-shrink-0" />
                        <span className="text-sm text-gray-200 truncate">{agent.name}</span>
                      </div>
                    </label>
                  )
                })}
                <p className="text-[10px] text-mountain-500 mt-1">
                  Select 1 for direct chat, 2+ for group chat (max 8)
                </p>
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm text-mountain-400 mb-1.5">Message</label>
            <textarea
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder="Type your first message..."
              rows={3}
              className="w-full bg-navy-900 border border-navy-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-mountain-500 focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none"
            />
          </div>

          {error && (
            <p className="text-sm text-red-400">{error}</p>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-mountain-400 hover:text-gray-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={selectedAgents.size === 0 || !message.trim() || sending}
              className="px-4 py-2 text-sm bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {sending ? 'Sending...' : isGroup ? 'Start Group Chat' : 'Start Chat'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
