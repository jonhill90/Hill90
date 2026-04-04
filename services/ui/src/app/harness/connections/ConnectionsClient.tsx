'use client'

import { useState, useEffect, useCallback } from 'react'
import type { Session } from 'next-auth'

interface ProviderConnection {
  id: string
  name: string
  provider: string
  api_base_url: string | null
  is_valid: boolean | null
  last_validated_at: string | null
  last_validation_error: string | null
  validation_latency_ms: number | null
  created_at: string
  updated_at: string
}

interface HealthStats {
  total: number
  valid: number
  invalid: number
  untested: number
  avg_latency_ms: number | null
  by_provider: ProviderHealthRow[]
}

interface ProviderHealthRow {
  provider: string
  total: number
  valid: number
  invalid: number
  untested: number
  avg_latency_ms: number | null
}

const PROVIDERS = ['openai', 'anthropic', 'google', 'mistral', 'cohere', 'azure']

export default function ConnectionsClient({ session }: { session: Session }) {
  const [connections, setConnections] = useState<ProviderConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [formData, setFormData] = useState({ name: '', provider: 'openai', api_key: '', api_base_url: '' })
  const [formError, setFormError] = useState('')
  const [activeTab, setActiveTab] = useState<'connections' | 'health'>('connections')
  const [healthStats, setHealthStats] = useState<HealthStats | null>(null)
  const [healthLoading, setHealthLoading] = useState(false)
  const [checkAllLoading, setCheckAllLoading] = useState(false)

  const fetchConnections = useCallback(async () => {
    try {
      const res = await fetch('/api/provider-connections')
      if (res.ok) {
        setConnections(await res.json())
      }
    } catch (err) {
      console.error('Failed to fetch connections:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchHealth = useCallback(async () => {
    setHealthLoading(true)
    try {
      const res = await fetch('/api/provider-connections/health')
      if (res.ok) {
        setHealthStats(await res.json())
      }
    } catch (err) {
      console.error('Failed to fetch health stats:', err)
    } finally {
      setHealthLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchConnections()
  }, [fetchConnections])

  useEffect(() => {
    if (activeTab === 'health') {
      fetchHealth()
    }
  }, [activeTab, fetchHealth])

  const resetForm = () => {
    setFormData({ name: '', provider: 'openai', api_key: '', api_base_url: '' })
    setFormError('')
    setShowCreate(false)
    setEditingId(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError('')

    if (!formData.name.trim()) {
      setFormError('Name is required')
      return
    }
    if (!editingId && !formData.api_key.trim()) {
      setFormError('API key is required')
      return
    }

    const body: Record<string, string> = {
      name: formData.name.trim(),
      provider: formData.provider,
    }
    if (formData.api_key.trim()) {
      body.api_key = formData.api_key.trim()
    }
    if (formData.api_base_url.trim()) {
      body.api_base_url = formData.api_base_url.trim()
    }

    try {
      const url = editingId
        ? `/api/provider-connections/${editingId}`
        : '/api/provider-connections'
      const res = await fetch(url, {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (res.ok) {
        resetForm()
        await fetchConnections()
      } else {
        const data = await res.json()
        setFormError(data.error || 'Failed to save connection')
      }
    } catch {
      setFormError('Request failed')
    }
  }

  const handleEdit = (conn: ProviderConnection) => {
    setFormData({
      name: conn.name,
      provider: conn.provider,
      api_key: '',
      api_base_url: conn.api_base_url || '',
    })
    setEditingId(conn.id)
    setShowCreate(true)
  }

  const handleDelete = async (conn: ProviderConnection) => {
    if (!confirm(`Delete connection "${conn.name}"? Models using this connection will also be deleted.`)) return
    setActionLoading(conn.id)
    try {
      const res = await fetch(`/api/provider-connections/${conn.id}`, { method: 'DELETE' })
      if (res.ok) {
        await fetchConnections()
      } else {
        const data = await res.json()
        alert(data.error || 'Failed to delete connection')
      }
    } catch {
      alert('Failed to delete connection')
    } finally {
      setActionLoading(null)
    }
  }

  const handleValidate = async (conn: ProviderConnection) => {
    setActionLoading(conn.id)
    try {
      const res = await fetch(`/api/provider-connections/${conn.id}/validate`, { method: 'POST' })
      if (res.ok) {
        await fetchConnections()
      } else {
        const data = await res.json()
        alert(data.error || 'Validation failed')
      }
    } catch {
      alert('Failed to validate connection')
    } finally {
      setActionLoading(null)
    }
  }

  const handleCheckAll = async () => {
    setCheckAllLoading(true)
    try {
      const res = await fetch('/api/provider-connections/validate-all', { method: 'POST' })
      if (res.ok) {
        await fetchConnections()
        if (activeTab === 'health') {
          await fetchHealth()
        }
      }
    } catch {
      alert('Failed to validate connections')
    } finally {
      setCheckAllLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="h-8 w-8 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
      </div>
    )
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Provider Connections</h1>
          <p className="text-sm text-mountain-400 mt-1">
            {connections.length} connection{connections.length !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {connections.length > 0 && (
            <button
              onClick={handleCheckAll}
              disabled={checkAllLoading}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-navy-600 text-mountain-400 hover:text-white hover:border-navy-500 transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
            >
              {checkAllLoading ? 'Checking...' : 'Check All'}
            </button>
          )}
          <button
            onClick={() => { resetForm(); setShowCreate(true); setActiveTab('connections') }}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors cursor-pointer"
          >
            Add Connection
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-navy-700">
        <button
          onClick={() => setActiveTab('connections')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
            activeTab === 'connections'
              ? 'border-brand-500 text-white'
              : 'border-transparent text-mountain-400 hover:text-white'
          }`}
        >
          Connections
        </button>
        <button
          onClick={() => setActiveTab('health')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
            activeTab === 'health'
              ? 'border-brand-500 text-white'
              : 'border-transparent text-mountain-400 hover:text-white'
          }`}
        >
          Health
        </button>
      </div>

      {activeTab === 'connections' && (
        <>
          {/* Create/Edit form */}
          {showCreate && (
            <div className="rounded-lg border border-navy-700 bg-navy-800 p-5 mb-6">
              <h2 className="text-lg font-semibold text-white mb-4">
                {editingId ? 'Edit Connection' : 'New Connection'}
              </h2>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-mountain-400 mb-1">Name</label>
                    <input
                      type="text"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
                      placeholder="My OpenAI Key"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-mountain-400 mb-1">Provider</label>
                    <select
                      value={formData.provider}
                      onChange={(e) => setFormData({ ...formData, provider: e.target.value })}
                      className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none"
                    >
                      {PROVIDERS.map((p) => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-sm text-mountain-400 mb-1">
                    API Key {editingId && <span className="text-mountain-500">(leave blank to keep current)</span>}
                  </label>
                  <input
                    type="password"
                    value={formData.api_key}
                    onChange={(e) => setFormData({ ...formData, api_key: e.target.value })}
                    className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
                    placeholder={editingId ? 'Enter new key to update' : 'sk-...'}
                  />
                </div>
                <div>
                  <label className="block text-sm text-mountain-400 mb-1">
                    Custom Base URL <span className="text-mountain-500">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={formData.api_base_url}
                    onChange={(e) => setFormData({ ...formData, api_base_url: e.target.value })}
                    className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
                    placeholder="https://api.example.com/v1"
                  />
                </div>
                {formError && (
                  <p className="text-sm text-red-400">{formError}</p>
                )}
                <div className="flex items-center gap-2">
                  <button
                    type="submit"
                    className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors cursor-pointer"
                  >
                    {editingId ? 'Update' : 'Create'}
                  </button>
                  <button
                    type="button"
                    onClick={resetForm}
                    className="px-4 py-2 text-sm font-medium rounded-lg border border-navy-600 text-mountain-400 hover:text-white hover:border-navy-500 transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Connection list */}
          {connections.length === 0 ? (
            <div className="rounded-lg border border-navy-700 bg-navy-800 p-12 text-center">
              <p className="text-mountain-400 mb-4">No provider connections yet</p>
              <button
                onClick={() => { resetForm(); setShowCreate(true) }}
                className="text-brand-400 hover:text-brand-300 text-sm font-medium cursor-pointer"
              >
                Add your first API key to get started
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {connections.map((conn) => (
                <div
                  key={conn.id}
                  className="rounded-lg border border-navy-700 bg-navy-800 p-5 flex flex-col"
                >
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-semibold text-white truncate">{conn.name}</h3>
                    <ValidityBadge isValid={conn.is_valid} />
                  </div>

                  <p className="text-sm text-mountain-400 mb-1">{conn.provider}</p>
                  {conn.api_base_url && (
                    <p className="text-xs text-mountain-500 mb-1 truncate">{conn.api_base_url}</p>
                  )}
                  <p className="text-xs text-mountain-500 mb-1">
                    Added {new Date(conn.created_at).toLocaleDateString()}
                  </p>
                  {conn.last_validated_at && (
                    <p className="text-xs text-mountain-500 mb-1">
                      Checked {formatRelativeTime(conn.last_validated_at)}
                      {conn.validation_latency_ms != null && ` (${conn.validation_latency_ms}ms)`}
                    </p>
                  )}
                  {conn.last_validation_error && (
                    <p className="text-xs text-red-400 mb-1 truncate" title={conn.last_validation_error}>
                      {conn.last_validation_error}
                    </p>
                  )}

                  <div className="flex items-center gap-2 mt-auto pt-2">
                    <button
                      onClick={() => handleValidate(conn)}
                      disabled={actionLoading === conn.id}
                      className="px-3 py-1.5 text-xs font-medium rounded-md bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                    >
                      {actionLoading === conn.id ? 'Testing...' : 'Test'}
                    </button>
                    <button
                      onClick={() => handleEdit(conn)}
                      className="px-3 py-1.5 text-xs font-medium rounded-md border border-navy-600 text-mountain-400 hover:text-white hover:border-navy-500 transition-colors cursor-pointer"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(conn)}
                      disabled={actionLoading === conn.id}
                      className="px-3 py-1.5 text-xs font-medium rounded-md border border-red-700 text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {activeTab === 'health' && (
        <HealthTab
          stats={healthStats}
          loading={healthLoading}
          connections={connections}
        />
      )}
    </>
  )
}

function HealthTab({
  stats,
  loading,
  connections,
}: {
  stats: HealthStats | null
  loading: boolean
  connections: ProviderConnection[]
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
      </div>
    )
  }

  if (!stats || stats.total === 0) {
    return (
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-12 text-center">
        <p className="text-mountain-400">No connections to monitor</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label="Total" value={stats.total} color="text-white" />
        <StatCard label="Valid" value={stats.valid} color="text-brand-400" />
        <StatCard label="Invalid" value={stats.invalid} color="text-red-400" />
        <StatCard label="Untested" value={stats.untested} color="text-mountain-400" />
      </div>

      {stats.avg_latency_ms != null && (
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-4">
          <p className="text-sm text-mountain-400">
            Average validation latency: <span className="text-white font-medium">{stats.avg_latency_ms}ms</span>
          </p>
        </div>
      )}

      {/* Per-provider breakdown */}
      {stats.by_provider.length > 0 && (
        <div className="rounded-lg border border-navy-700 bg-navy-800 overflow-hidden">
          <div className="px-4 py-3 border-b border-navy-700">
            <h3 className="text-sm font-semibold text-white">By Provider</h3>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-mountain-400 text-left">
                <th className="px-4 py-2 font-medium">Provider</th>
                <th className="px-4 py-2 font-medium">Total</th>
                <th className="px-4 py-2 font-medium">Valid</th>
                <th className="px-4 py-2 font-medium">Invalid</th>
                <th className="px-4 py-2 font-medium">Avg Latency</th>
              </tr>
            </thead>
            <tbody>
              {stats.by_provider.map((row) => (
                <tr key={row.provider} className="border-t border-navy-700">
                  <td className="px-4 py-2 text-white">{row.provider}</td>
                  <td className="px-4 py-2 text-mountain-400">{row.total}</td>
                  <td className="px-4 py-2 text-brand-400">{row.valid}</td>
                  <td className="px-4 py-2 text-red-400">{row.invalid}</td>
                  <td className="px-4 py-2 text-mountain-400">
                    {row.avg_latency_ms != null ? `${row.avg_latency_ms}ms` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Per-connection health table */}
      <div className="rounded-lg border border-navy-700 bg-navy-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-navy-700">
          <h3 className="text-sm font-semibold text-white">Connection Details</h3>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-mountain-400 text-left">
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Provider</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Latency</th>
              <th className="px-4 py-2 font-medium">Last Checked</th>
              <th className="px-4 py-2 font-medium">Error</th>
            </tr>
          </thead>
          <tbody>
            {connections.map((conn) => (
              <tr key={conn.id} className="border-t border-navy-700">
                <td className="px-4 py-2 text-white">{conn.name}</td>
                <td className="px-4 py-2 text-mountain-400">{conn.provider}</td>
                <td className="px-4 py-2">
                  <ValidityBadge isValid={conn.is_valid} />
                </td>
                <td className="px-4 py-2 text-mountain-400">
                  {conn.validation_latency_ms != null ? `${conn.validation_latency_ms}ms` : '—'}
                </td>
                <td className="px-4 py-2 text-mountain-400">
                  {conn.last_validated_at ? formatRelativeTime(conn.last_validated_at) : 'Never'}
                </td>
                <td className="px-4 py-2 text-red-400 max-w-xs truncate" title={conn.last_validation_error || ''}>
                  {conn.last_validation_error || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg border border-navy-700 bg-navy-800 p-4">
      <p className="text-xs text-mountain-400 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
    </div>
  )
}

function ValidityBadge({ isValid }: { isValid: boolean | null }) {
  if (isValid === true) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-400">
        <span className="h-2 w-2 rounded-full bg-brand-500" />
        Valid
      </span>
    )
  }
  if (isValid === false) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-400">
        <span className="h-2 w-2 rounded-full bg-red-500" />
        Invalid
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-mountain-400">
      <span className="h-2 w-2 rounded-full bg-mountain-500" />
      Untested
    </span>
  )
}

function formatRelativeTime(iso: string): string {
  const now = Date.now()
  const then = new Date(iso).getTime()
  const diffMs = now - then

  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return 'just now'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
