'use client'

import { useState, useEffect, useCallback } from 'react'

interface UserModel {
  id: string
  name: string
  connection_id: string
  litellm_model: string
  description: string
  is_active: boolean
  created_at: string
  updated_at: string
}

interface ProviderConnection {
  id: string
  name: string
  provider: string
}

export default function ModelsClient() {
  const [models, setModels] = useState<UserModel[]>([])
  const [connections, setConnections] = useState<ProviderConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [formData, setFormData] = useState({ name: '', connection_id: '', litellm_model: '', description: '' })
  const [formError, setFormError] = useState('')

  const fetchData = useCallback(async () => {
    try {
      const [modelsRes, connsRes] = await Promise.all([
        fetch('/api/user-models'),
        fetch('/api/provider-connections'),
      ])
      if (modelsRes.ok) setModels(await modelsRes.json())
      if (connsRes.ok) setConnections(await connsRes.json())
    } catch (err) {
      console.error('Failed to fetch data:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const connectionName = (id: string) =>
    connections.find((c) => c.id === id)?.name ?? id.substring(0, 8)

  const connectionProvider = (id: string) =>
    connections.find((c) => c.id === id)?.provider ?? ''

  const resetForm = () => {
    setFormData({ name: '', connection_id: '', litellm_model: '', description: '' })
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
    if (!formData.connection_id) {
      setFormError('Connection is required')
      return
    }
    if (!formData.litellm_model.trim()) {
      setFormError('Provider model ID is required')
      return
    }

    const body: Record<string, string> = {
      name: formData.name.trim(),
      connection_id: formData.connection_id,
      litellm_model: formData.litellm_model.trim(),
    }
    if (formData.description.trim()) {
      body.description = formData.description.trim()
    }

    try {
      const url = editingId
        ? `/api/user-models/${editingId}`
        : '/api/user-models'
      const res = await fetch(url, {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (res.ok) {
        resetForm()
        await fetchData()
      } else {
        const data = await res.json()
        setFormError(data.error || 'Failed to save model')
      }
    } catch {
      setFormError('Request failed')
    }
  }

  const handleEdit = (model: UserModel) => {
    setFormData({
      name: model.name,
      connection_id: model.connection_id,
      litellm_model: model.litellm_model,
      description: model.description || '',
    })
    setEditingId(model.id)
    setShowCreate(true)
  }

  const handleDelete = async (model: UserModel) => {
    if (!confirm(`Delete model "${model.name}"? Agents and internal model access config referencing this model will need updates.`)) return
    setActionLoading(model.id)
    try {
      const res = await fetch(`/api/user-models/${model.id}`, { method: 'DELETE' })
      if (res.ok) {
        await fetchData()
      } else {
        const data = await res.json()
        alert(data.error || 'Failed to delete model')
      }
    } catch {
      alert('Failed to delete model')
    } finally {
      setActionLoading(null)
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
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">User Models</h1>
          <p className="text-sm text-mountain-400 mt-1">
            {models.length} model{models.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={() => { resetForm(); setShowCreate(true) }}
          disabled={connections.length === 0}
          title={connections.length === 0 ? 'Create a provider connection first' : undefined}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Add Model
        </button>
      </div>

      {/* Create/Edit form */}
      {showCreate && (
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-5 mb-6">
          <h2 className="text-lg font-semibold text-white mb-4">
            {editingId ? 'Edit Model' : 'New Model'}
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
                  placeholder="GPT-4o Mini"
                />
              </div>
              <div>
                <label className="block text-sm text-mountain-400 mb-1">Connection</label>
                <select
                  value={formData.connection_id}
                  onChange={(e) => setFormData({ ...formData, connection_id: e.target.value })}
                  className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none"
                >
                  <option value="">Select a connection</option>
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} ({c.provider})</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm text-mountain-400 mb-1">Provider Model ID</label>
              <input
                type="text"
                value={formData.litellm_model}
                onChange={(e) => setFormData({ ...formData, litellm_model: e.target.value })}
                className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
                placeholder="gpt-4o-mini"
              />
            </div>
            <div>
              <label className="block text-sm text-mountain-400 mb-1">
                Description <span className="text-mountain-500">(optional)</span>
              </label>
              <input
                type="text"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
                placeholder="Fast and affordable for most tasks"
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

      {/* Models table */}
      {models.length === 0 ? (
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-12 text-center">
          <p className="text-mountain-400 mb-4">No models defined yet</p>
          <p className="text-sm text-mountain-500">
            {connections.length === 0
              ? 'Create a provider connection first, then add models.'
              : 'Create a model to use with your provider connections.'}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-navy-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-navy-800 text-mountain-400 text-left">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Provider Model</th>
                <th className="px-4 py-3 font-medium">Connection</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium w-28"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-700">
              {models.map((model) => (
                <tr key={model.id} className="bg-navy-900 hover:bg-navy-800 transition-colors">
                  <td className="px-4 py-3">
                    <div className="text-white font-medium">{model.name}</div>
                    {model.description && (
                      <div className="text-xs text-mountain-500 mt-0.5">{model.description}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-mountain-300">{model.litellm_model}</td>
                  <td className="px-4 py-3">
                    <span className="text-mountain-300">{connectionName(model.connection_id)}</span>
                    <span className="text-mountain-500 text-xs ml-1">({connectionProvider(model.connection_id)})</span>
                  </td>
                  <td className="px-4 py-3 text-mountain-400">{new Date(model.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 justify-end">
                      <button
                        onClick={() => handleEdit(model)}
                        className="px-2.5 py-1 text-xs font-medium rounded-md border border-navy-600 text-mountain-400 hover:text-white hover:border-navy-500 transition-colors cursor-pointer"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(model)}
                        disabled={actionLoading === model.id}
                        className="px-2.5 py-1 text-xs font-medium rounded-md border border-red-700 text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
