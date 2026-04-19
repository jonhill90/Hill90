'use client'

import { useState, useEffect, useCallback } from 'react'
import { Webhook, Plus, Trash2, TestTube } from 'lucide-react'

interface AgentWebhook {
  id: string
  url: string
  events: string[]
  active: boolean
  created_at: string
}

export default function AgentWebhooks({ agentId }: { agentId: string }) {
  const [webhooks, setWebhooks] = useState<AgentWebhook[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState(['start', 'stop', 'error'])
  const [saving, setSaving] = useState(false)

  const isDiscord = (u: string) => u.includes('discord.com/api/webhooks/') || u.includes('discordapp.com/api/webhooks/')

  const fetchWebhooks = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${agentId}/webhooks`)
      if (res.ok) setWebhooks(await res.json())
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [agentId])

  useEffect(() => { fetchWebhooks() }, [fetchWebhooks])

  const handleCreate = async () => {
    setSaving(true)
    try {
      const res = await fetch(`/api/agents/${agentId}/webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, events }),
      })
      if (res.ok) {
        setShowForm(false)
        setUrl('')
        fetchWebhooks()
      }
    } catch { /* ignore */ }
    finally { setSaving(false) }
  }

  const handleDelete = async (webhookId: string) => {
    if (!confirm('Remove this webhook?')) return
    await fetch(`/api/agents/${agentId}/webhooks/${webhookId}`, { method: 'DELETE' })
    fetchWebhooks()
  }

  if (loading) return <div className="flex justify-center py-4"><div className="h-5 w-5 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" /></div>

  return (
    <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Webhook className="w-4 h-4 text-mountain-400" />
          <h2 className="text-lg font-semibold text-white">Webhooks & Discord</h2>
        </div>
        <button onClick={() => setShowForm(true)} className="flex items-center gap-1 text-xs text-brand-400 hover:text-brand-300 cursor-pointer">
          <Plus className="w-3 h-3" /> Add
        </button>
      </div>

      {showForm && (
        <div className="mb-4 rounded border border-navy-600 bg-navy-900 p-3">
          <div className="space-y-2">
            <div>
              <label className="block text-xs text-mountain-400 mb-1">Webhook URL</label>
              <input value={url} onChange={e => setUrl(e.target.value)}
                placeholder="https://discord.com/api/webhooks/... or any URL"
                className="w-full rounded border border-navy-600 bg-navy-800 px-3 py-1.5 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none" />
              {url && isDiscord(url) && (
                <p className="text-xs text-brand-400 mt-1">Discord webhook detected — events will be formatted as rich embeds automatically</p>
              )}
            </div>
            <div>
              <label className="block text-xs text-mountain-400 mb-1">Events</label>
              <div className="flex gap-2">
                {['start', 'stop', 'error'].map(evt => (
                  <label key={evt} className="flex items-center gap-1 text-xs text-mountain-300 cursor-pointer">
                    <input type="checkbox" checked={events.includes(evt)}
                      onChange={e => setEvents(prev => e.target.checked ? [...prev, evt] : prev.filter(v => v !== evt))}
                      className="rounded border-navy-600" />
                    {evt}
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={handleCreate} disabled={!url || events.length === 0 || saving}
              className="px-3 py-1 text-xs rounded bg-brand-600 hover:bg-brand-500 text-white disabled:opacity-50 cursor-pointer">
              {saving ? 'Adding...' : 'Add Webhook'}
            </button>
            <button onClick={() => { setShowForm(false); setUrl('') }} className="px-3 py-1 text-xs text-mountain-400 hover:text-white cursor-pointer">Cancel</button>
          </div>
        </div>
      )}

      {webhooks.length === 0 && !showForm ? (
        <p className="text-sm text-mountain-500 text-center py-4">No webhooks configured. Add a Discord or custom webhook to receive agent events.</p>
      ) : (
        <div className="space-y-2">
          {webhooks.map(wh => (
            <div key={wh.id} className="flex items-center justify-between rounded border border-navy-600 bg-navy-900 px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {isDiscord(wh.url) && <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-600/20 text-indigo-400">Discord</span>}
                  <span className="text-xs text-mountain-300 font-mono truncate">{wh.url.length > 50 ? wh.url.slice(0, 50) + '...' : wh.url}</span>
                </div>
                <div className="flex gap-1 mt-1">
                  {wh.events.map(evt => (
                    <span key={evt} className="text-xs px-1 py-0.5 rounded bg-navy-700 text-mountain-400">{evt}</span>
                  ))}
                </div>
              </div>
              <button onClick={() => handleDelete(wh.id)} className="p-1 text-mountain-400 hover:text-red-400 cursor-pointer ml-2">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
