'use client'

import { useState, useEffect, useCallback } from 'react'
import { MessageSquare, Plus, Trash2, Link2, Bot, CheckCircle, XCircle } from 'lucide-react'

interface Binding {
  id: string
  channel_id: string
  guild_id: string
  agent_id: string
  agent_name: string
  agent_slug: string
  thread_id: string | null
  created_at: string
}

interface UserLink {
  id: string
  discord_user_id: string
  hill90_user_id: string
  created_at: string
}

interface BotStatus {
  configured: boolean
  status: string
  message: string
}

export default function DiscordClient() {
  const [bindings, setBindings] = useState<Binding[]>([])
  const [userLinks, setUserLinks] = useState<UserLink[]>([])
  const [botStatus, setBotStatus] = useState<BotStatus | null>(null)
  const [agents, setAgents] = useState<Array<{ id: string; name: string; agent_id: string }>>([])
  const [loading, setLoading] = useState(true)
  const [showBindingForm, setShowBindingForm] = useState(false)
  const [showLinkForm, setShowLinkForm] = useState(false)
  const [bindingForm, setBindingForm] = useState({ channel_id: '', guild_id: '', agent_id: '' })
  const [linkForm, setLinkForm] = useState({ discord_user_id: '' })

  const fetchData = useCallback(async () => {
    try {
      const [bindingsRes, statusRes, agentsRes] = await Promise.all([
        fetch('/api/discord/bindings'),
        fetch('/api/discord/status'),
        fetch('/api/agents'),
      ])

      if (bindingsRes.ok) {
        const data = await bindingsRes.json()
        if (Array.isArray(data)) setBindings(data)
      }
      if (statusRes.ok) setBotStatus(await statusRes.json())
      if (agentsRes.ok) {
        const data = await agentsRes.json()
        if (Array.isArray(data)) setAgents(data)
      }

      // Try user links (admin only)
      const linksRes = await fetch('/api/discord/user-links')
      if (linksRes.ok) {
        const data = await linksRes.json()
        if (Array.isArray(data)) setUserLinks(data)
      }
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  const handleCreateBinding = async () => {
    if (!bindingForm.channel_id || !bindingForm.guild_id || !bindingForm.agent_id) return
    const res = await fetch('/api/discord/bindings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bindingForm),
    })
    if (res.ok) {
      setShowBindingForm(false)
      setBindingForm({ channel_id: '', guild_id: '', agent_id: '' })
      fetchData()
    }
  }

  const handleDeleteBinding = async (id: string) => {
    if (!confirm('Remove this channel binding?')) return
    await fetch(`/api/discord/bindings/${id}`, { method: 'DELETE' })
    fetchData()
  }

  const handleLinkUser = async () => {
    if (!linkForm.discord_user_id) return
    const res = await fetch('/api/discord/user-links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(linkForm),
    })
    if (res.ok) {
      setShowLinkForm(false)
      setLinkForm({ discord_user_id: '' })
      fetchData()
    }
  }

  const handleDeleteLink = async (id: string) => {
    if (!confirm('Remove this user link?')) return
    await fetch(`/api/discord/user-links/${id}`, { method: 'DELETE' })
    fetchData()
  }

  if (loading) {
    return <div className="flex-1 flex items-center justify-center"><div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" /></div>
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Discord Integration</h1>
          <p className="text-mountain-400 text-sm mt-1">Connect Discord channels to Hill90 agents</p>
        </div>
      </div>

      {/* Bot Status */}
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-5 mb-6">
        <div className="flex items-center gap-3">
          <MessageSquare className="h-5 w-5 text-[#5865F2]" />
          <h2 className="text-lg font-semibold text-white">Bot Status</h2>
          {botStatus?.configured ? (
            <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-brand-900/30 text-brand-400">
              <CheckCircle className="w-3 h-3" /> Configured
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-900/30 text-red-400">
              <XCircle className="w-3 h-3" /> Not Configured
            </span>
          )}
        </div>
        {!botStatus?.configured && (
          <p className="text-sm text-mountain-400 mt-2">
            Add DISCORD_BOT_TOKEN and DISCORD_BOT_SERVICE_TOKEN to vault to enable the Discord bot.
          </p>
        )}
      </div>

      {/* Channel Bindings */}
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Link2 className="h-5 w-5 text-mountain-400" />
            <h2 className="text-lg font-semibold text-white">Channel Bindings</h2>
          </div>
          <button
            onClick={() => setShowBindingForm(true)}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" /> Bind Channel
          </button>
        </div>

        {showBindingForm && (
          <div className="mb-4 rounded-md border border-navy-600 bg-navy-900 p-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
              <div>
                <label className="block text-xs text-mountain-400 mb-1">Channel ID</label>
                <input value={bindingForm.channel_id} onChange={e => setBindingForm(f => ({ ...f, channel_id: e.target.value }))}
                  className="w-full rounded border border-navy-600 bg-navy-800 px-3 py-2 text-sm text-white font-mono focus:border-brand-500 focus:outline-none"
                  placeholder="123456789012345678" />
              </div>
              <div>
                <label className="block text-xs text-mountain-400 mb-1">Guild (Server) ID</label>
                <input value={bindingForm.guild_id} onChange={e => setBindingForm(f => ({ ...f, guild_id: e.target.value }))}
                  className="w-full rounded border border-navy-600 bg-navy-800 px-3 py-2 text-sm text-white font-mono focus:border-brand-500 focus:outline-none"
                  placeholder="987654321098765432" />
              </div>
              <div>
                <label className="block text-xs text-mountain-400 mb-1">Agent</label>
                <select value={bindingForm.agent_id} onChange={e => setBindingForm(f => ({ ...f, agent_id: e.target.value }))}
                  className="w-full rounded border border-navy-600 bg-navy-800 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none">
                  <option value="">Select agent...</option>
                  {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={handleCreateBinding} disabled={!bindingForm.channel_id || !bindingForm.guild_id || !bindingForm.agent_id}
                className="px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm disabled:opacity-50 cursor-pointer">Create</button>
              <button onClick={() => setShowBindingForm(false)}
                className="px-3 py-1.5 rounded-lg text-mountain-400 hover:text-white text-sm cursor-pointer">Cancel</button>
            </div>
          </div>
        )}

        {bindings.length === 0 ? (
          <p className="text-sm text-mountain-500">No channels bound yet. Bind a Discord channel to an agent to start.</p>
        ) : (
          <div className="space-y-2">
            {bindings.map(b => (
              <div key={b.id} className="flex items-center justify-between rounded-md border border-navy-700 bg-navy-900 p-3">
                <div className="flex items-center gap-3 min-w-0">
                  <MessageSquare className="w-4 h-4 text-[#5865F2] flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm text-white font-mono truncate">Channel: {b.channel_id}</p>
                    <p className="text-xs text-mountain-500">Guild: {b.guild_id}</p>
                  </div>
                  <span className="text-mountain-500">→</span>
                  <div className="flex items-center gap-1">
                    <Bot className="w-3.5 h-3.5 text-brand-400" />
                    <span className="text-sm text-brand-400">{b.agent_name || b.agent_slug}</span>
                  </div>
                </div>
                <button onClick={() => handleDeleteBinding(b.id)} className="p-1.5 rounded text-mountain-400 hover:text-red-400 cursor-pointer">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* User Links */}
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">User Links</h2>
          <button
            onClick={() => setShowLinkForm(true)}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-navy-700 hover:bg-navy-600 text-white text-sm font-medium cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" /> Link Account
          </button>
        </div>

        {showLinkForm && (
          <div className="mb-4 rounded-md border border-navy-600 bg-navy-900 p-4">
            <div className="mb-3">
              <label className="block text-xs text-mountain-400 mb-1">Your Discord User ID</label>
              <input value={linkForm.discord_user_id} onChange={e => setLinkForm({ discord_user_id: e.target.value })}
                className="w-full max-w-sm rounded border border-navy-600 bg-navy-800 px-3 py-2 text-sm text-white font-mono focus:border-brand-500 focus:outline-none"
                placeholder="123456789012345678" />
              <p className="text-xs text-mountain-500 mt-1">Right-click your name in Discord → Copy User ID (enable Developer Mode in Discord settings)</p>
            </div>
            <div className="flex gap-2">
              <button onClick={handleLinkUser} disabled={!linkForm.discord_user_id}
                className="px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm disabled:opacity-50 cursor-pointer">Link</button>
              <button onClick={() => setShowLinkForm(false)}
                className="px-3 py-1.5 rounded-lg text-mountain-400 hover:text-white text-sm cursor-pointer">Cancel</button>
            </div>
          </div>
        )}

        {userLinks.length === 0 ? (
          <p className="text-sm text-mountain-500">No Discord accounts linked. Link your Discord user ID to your Hill90 account.</p>
        ) : (
          <div className="space-y-2">
            {userLinks.map(l => (
              <div key={l.id} className="flex items-center justify-between rounded-md border border-navy-700 bg-navy-900 p-3">
                <p className="text-sm text-white font-mono">Discord: {l.discord_user_id} → Hill90: {l.hill90_user_id.slice(0, 8)}…</p>
                <button onClick={() => handleDeleteLink(l.id)} className="p-1.5 rounded text-mountain-400 hover:text-red-400 cursor-pointer">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
