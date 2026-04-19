'use client'

import { useState, useEffect, useCallback } from 'react'
import { Plus, Server, Trash2, Edit2, Users } from 'lucide-react'

interface McpServer {
  id: string
  name: string
  description: string | null
  transport: string
  connection_config: Record<string, unknown>
  is_platform: boolean
  agent_count: number
  created_by: string
  created_at: string
}

export default function McpServersClient() {
  const [servers, setServers] = useState<McpServer[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({
    name: '', description: '', transport: 'stdio',
    command: '', args: '', env: '', url: ''
  })

  const fetchServers = useCallback(async () => {
    try {
      const res = await fetch('/api/mcp-servers')
      if (res.ok) {
        const data = await res.json()
        if (Array.isArray(data)) setServers(data)
      }
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchServers() }, [fetchServers])

  const handleSubmit = async () => {
    const connection_config: Record<string, unknown> = {}
    if (form.transport === 'stdio') {
      connection_config.command = form.command
      if (form.args) connection_config.args = form.args.split(' ').filter(Boolean)
      if (form.env) {
        try { connection_config.env = JSON.parse(form.env) } catch { /* ignore */ }
      }
    } else {
      connection_config.url = form.url
    }

    const body = {
      name: form.name,
      description: form.description || null,
      transport: form.transport,
      connection_config,
    }

    const url = editingId ? `/api/mcp-servers/${editingId}` : '/api/mcp-servers'
    const method = editingId ? 'PUT' : 'POST'
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (res.ok) {
      setShowForm(false)
      setEditingId(null)
      setForm({ name: '', description: '', transport: 'stdio', command: '', args: '', env: '', url: '' })
      fetchServers()
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this MCP server?')) return
    await fetch(`/api/mcp-servers/${id}`, { method: 'DELETE' })
    fetchServers()
  }

  const handleEdit = (s: McpServer) => {
    const cfg = s.connection_config || {}
    setForm({
      name: s.name,
      description: s.description || '',
      transport: s.transport,
      command: (cfg.command as string) || '',
      args: Array.isArray(cfg.args) ? cfg.args.join(' ') : '',
      env: cfg.env ? JSON.stringify(cfg.env) : '',
      url: (cfg.url as string) || '',
    })
    setEditingId(s.id)
    setShowForm(true)
  }

  if (loading) {
    return <div className="flex-1 flex items-center justify-center"><div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" /></div>
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">MCP Servers</h1>
          <p className="text-mountain-400 text-sm mt-1">Manage Model Context Protocol servers for agent tools</p>
        </div>
        <button
          onClick={() => { setShowForm(true); setEditingId(null); setForm({ name: '', description: '', transport: 'stdio', command: '', args: '', env: '', url: '' }) }}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium cursor-pointer"
        >
          <Plus className="w-4 h-4" /> Add Server
        </button>
      </div>

      {showForm && (
        <div className="mb-6 rounded-lg border border-navy-700 bg-navy-800 p-5">
          <h3 className="text-lg font-semibold text-white mb-4">{editingId ? 'Edit MCP Server' : 'New MCP Server'}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-mountain-400 mb-1">Name</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full rounded border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none" placeholder="GitHub MCP Server" />
            </div>
            <div>
              <label className="block text-sm text-mountain-400 mb-1">Transport</label>
              <select value={form.transport} onChange={e => setForm(f => ({ ...f, transport: e.target.value }))}
                className="w-full rounded border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none">
                <option value="stdio">stdio (local process)</option>
                <option value="sse">SSE (server-sent events)</option>
                <option value="http">HTTP (streamable)</option>
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm text-mountain-400 mb-1">Description</label>
              <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                className="w-full rounded border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none" placeholder="GitHub API tools for repo management" />
            </div>
            {form.transport === 'stdio' ? (
              <>
                <div>
                  <label className="block text-sm text-mountain-400 mb-1">Command</label>
                  <input value={form.command} onChange={e => setForm(f => ({ ...f, command: e.target.value }))}
                    className="w-full rounded border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white font-mono focus:border-brand-500 focus:outline-none" placeholder="npx -y @modelcontextprotocol/server-github" />
                </div>
                <div>
                  <label className="block text-sm text-mountain-400 mb-1">Arguments (space-separated)</label>
                  <input value={form.args} onChange={e => setForm(f => ({ ...f, args: e.target.value }))}
                    className="w-full rounded border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white font-mono focus:border-brand-500 focus:outline-none" placeholder="--token ghp_xxx" />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm text-mountain-400 mb-1">Environment (JSON)</label>
                  <input value={form.env} onChange={e => setForm(f => ({ ...f, env: e.target.value }))}
                    className="w-full rounded border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white font-mono focus:border-brand-500 focus:outline-none" placeholder='{"GITHUB_TOKEN": "ghp_..."}' />
                </div>
              </>
            ) : (
              <div className="md:col-span-2">
                <label className="block text-sm text-mountain-400 mb-1">Server URL</label>
                <input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                  className="w-full rounded border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white font-mono focus:border-brand-500 focus:outline-none" placeholder="http://localhost:3001/mcp" />
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 mt-4">
            <button onClick={handleSubmit} disabled={!form.name || (form.transport === 'stdio' ? !form.command : !form.url)}
              className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium disabled:opacity-50 cursor-pointer">
              {editingId ? 'Save Changes' : 'Create Server'}
            </button>
            <button onClick={() => { setShowForm(false); setEditingId(null) }}
              className="px-4 py-2 rounded-lg text-mountain-400 hover:text-white text-sm cursor-pointer">Cancel</button>
          </div>
        </div>
      )}

      {servers.length === 0 && !showForm ? (
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-12 flex flex-col items-center justify-center text-center">
          <div className="mb-4 rounded-full bg-navy-700 p-4"><Server className="h-8 w-8 text-mountain-400" /></div>
          <h2 className="text-lg font-semibold text-white mb-2">No MCP servers configured</h2>
          <p className="text-mountain-400 max-w-md mb-4">Add MCP servers to give your agents access to external tools and data sources.</p>
          <button onClick={() => setShowForm(true)} className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium cursor-pointer">
            <Plus className="w-4 h-4 inline mr-1" /> Add Server
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {servers.map(s => (
            <div key={s.id} className="rounded-lg border border-navy-700 bg-navy-800 p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Server className="w-4 h-4 text-mountain-400" />
                  <h3 className="font-semibold text-white">{s.name}</h3>
                  <span className="px-1.5 py-0.5 text-xs rounded bg-navy-700 text-mountain-400">{s.transport}</span>
                  {s.is_platform && <span className="px-1.5 py-0.5 text-xs rounded bg-brand-600/20 text-brand-400">platform</span>}
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-mountain-500 mr-2 flex items-center gap-1">
                    <Users className="w-3 h-3" /> {s.agent_count} agent{Number(s.agent_count) !== 1 ? 's' : ''}
                  </span>
                  <button onClick={() => handleEdit(s)} className="p-1.5 rounded text-mountain-400 hover:text-white hover:bg-navy-700 cursor-pointer"><Edit2 className="w-3.5 h-3.5" /></button>
                  <button onClick={() => handleDelete(s.id)} className="p-1.5 rounded text-mountain-400 hover:text-red-400 hover:bg-navy-700 cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              </div>
              {s.description && <p className="text-xs text-mountain-400 mb-1">{s.description}</p>}
              <div className="text-xs text-mountain-500 font-mono">
                {s.transport === 'stdio'
                  ? `${(s.connection_config as any).command || ''} ${((s.connection_config as any).args || []).join(' ')}`.trim()
                  : (s.connection_config as any).url || ''
                }
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
