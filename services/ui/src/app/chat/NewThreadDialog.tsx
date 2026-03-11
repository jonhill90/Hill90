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
  const [selectedAgent, setSelectedAgent] = useState<string>('')
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedAgent || !message.trim()) return

    setSending(true)
    setError(null)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: selectedAgent,
          message: message.trim(),
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        setError(data.error || data.detail || `Error: ${res.status}`)
        return
      }

      const data = await res.json()
      onCreated(data.thread_id)
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
            <label className="block text-sm text-mountain-400 mb-1.5">Agent</label>
            {loading ? (
              <p className="text-sm text-mountain-500">Loading agents...</p>
            ) : agents.length === 0 ? (
              <p className="text-sm text-mountain-500">No running agents available</p>
            ) : (
              <select
                value={selectedAgent}
                onChange={e => setSelectedAgent(e.target.value)}
                className="w-full bg-navy-900 border border-navy-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                <option value="">Select an agent...</option>
                {agents.map(agent => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
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
              disabled={!selectedAgent || !message.trim() || sending}
              className="px-4 py-2 text-sm bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {sending ? 'Sending...' : 'Start Chat'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
