'use client'

import { useState, useEffect, useCallback } from 'react'

interface ModelPolicy {
  id: string
  name: string
  description: string
  allowed_models: string[]
  max_requests_per_minute: number | null
  max_tokens_per_day: number | null
  model_aliases?: Record<string, string>
  created_at: string
  updated_at: string
  created_by: string | null
}

interface UserModel {
  id: string
  name: string
  litellm_model: string
}

export default function PoliciesClient() {
  const [policies, setPolicies] = useState<ModelPolicy[]>([])
  const [userModels, setUserModels] = useState<UserModel[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    allowed_models: [] as string[],
    max_requests_per_minute: '',
    max_tokens_per_day: '',
  })
  const [formError, setFormError] = useState('')

  const fetchData = useCallback(async () => {
    try {
      const [policiesRes, modelsRes] = await Promise.all([
        fetch('/api/model-policies'),
        fetch('/api/user-models'),
      ])
      if (policiesRes.ok) setPolicies(await policiesRes.json())
      if (modelsRes.ok) setUserModels(await modelsRes.json())
    } catch (err) {
      console.error('Failed to fetch data:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Collect available model names from user models for the multi-select
  const availableModels = userModels.map((m) => m.name)

  const resetForm = () => {
    setFormData({ name: '', description: '', allowed_models: [], max_requests_per_minute: '', max_tokens_per_day: '' })
    setFormError('')
    setShowCreate(false)
    setEditingId(null)
  }

  const toggleModel = (modelName: string) => {
    setFormData((prev) => ({
      ...prev,
      allowed_models: prev.allowed_models.includes(modelName)
        ? prev.allowed_models.filter((m) => m !== modelName)
        : [...prev.allowed_models, modelName],
    }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError('')

    if (!formData.name.trim()) {
      setFormError('Name is required')
      return
    }
    if (formData.allowed_models.length === 0) {
      setFormError('At least one allowed model is required')
      return
    }

    const body: Record<string, unknown> = {
      name: formData.name.trim(),
      allowed_models: formData.allowed_models,
    }
    if (formData.description.trim()) {
      body.description = formData.description.trim()
    }
    if (formData.max_requests_per_minute) {
      body.max_requests_per_minute = parseInt(formData.max_requests_per_minute, 10)
    } else {
      body.max_requests_per_minute = null
    }
    if (formData.max_tokens_per_day) {
      body.max_tokens_per_day = parseInt(formData.max_tokens_per_day, 10)
    } else {
      body.max_tokens_per_day = null
    }

    try {
      const url = editingId
        ? `/api/model-policies/${editingId}`
        : '/api/model-policies'
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
        setFormError(data.error || 'Failed to save policy')
      }
    } catch {
      setFormError('Request failed')
    }
  }

  const handleEdit = (policy: ModelPolicy) => {
    setFormData({
      name: policy.name,
      description: policy.description || '',
      allowed_models: [...policy.allowed_models],
      max_requests_per_minute: policy.max_requests_per_minute?.toString() ?? '',
      max_tokens_per_day: policy.max_tokens_per_day?.toString() ?? '',
    })
    setEditingId(policy.id)
    setShowCreate(true)
  }

  const handleDelete = async (policy: ModelPolicy) => {
    if (!confirm(`Delete policy "${policy.name}"? Agents using this policy will lose their model access configuration.`)) return
    setActionLoading(policy.id)
    try {
      const res = await fetch(`/api/model-policies/${policy.id}`, { method: 'DELETE' })
      if (res.ok) {
        await fetchData()
      } else {
        const data = await res.json()
        alert(data.error || 'Failed to delete policy')
      }
    } catch {
      alert('Failed to delete policy')
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
          <h1 className="text-2xl font-bold">Model Policies</h1>
          <p className="text-sm text-mountain-400 mt-1">
            {policies.length} polic{policies.length !== 1 ? 'ies' : 'y'}
          </p>
        </div>
        <button
          onClick={() => { resetForm(); setShowCreate(true) }}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors cursor-pointer"
        >
          Add Policy
        </button>
      </div>

      {/* Create/Edit form */}
      {showCreate && (
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-5 mb-6">
          <h2 className="text-lg font-semibold text-white mb-4">
            {editingId ? 'Edit Policy' : 'New Policy'}
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
                  placeholder="Agent Default Policy"
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
                  placeholder="Standard access for production agents"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm text-mountain-400 mb-2">Allowed Models</label>
              {availableModels.length === 0 ? (
                <p className="text-sm text-mountain-500">No user models available. Create models first.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {availableModels.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => toggleModel(name)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors cursor-pointer ${
                        formData.allowed_models.includes(name)
                          ? 'bg-brand-900/50 text-brand-400 border-brand-700'
                          : 'bg-navy-900 text-mountain-400 border-navy-600 hover:border-navy-500'
                      }`}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-mountain-400 mb-1">
                  Rate Limit <span className="text-mountain-500">(requests/min, blank = unlimited)</span>
                </label>
                <input
                  type="number"
                  min="1"
                  value={formData.max_requests_per_minute}
                  onChange={(e) => setFormData({ ...formData, max_requests_per_minute: e.target.value })}
                  className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
                  placeholder="60"
                />
              </div>
              <div>
                <label className="block text-sm text-mountain-400 mb-1">
                  Token Budget <span className="text-mountain-500">(tokens/day, blank = unlimited)</span>
                </label>
                <input
                  type="number"
                  min="1"
                  value={formData.max_tokens_per_day}
                  onChange={(e) => setFormData({ ...formData, max_tokens_per_day: e.target.value })}
                  className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
                  placeholder="1000000"
                />
              </div>
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

      {/* Policies table */}
      {policies.length === 0 ? (
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-12 text-center">
          <p className="text-mountain-400 mb-4">No model policies yet</p>
          <p className="text-sm text-mountain-500">
            Create a policy to control which models your agents can access.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {policies.map((policy) => {
            const isExpanded = expandedId === policy.id
            const aliases = policy.model_aliases && Object.keys(policy.model_aliases).length > 0
              ? policy.model_aliases
              : null

            return (
              <div
                key={policy.id}
                className="rounded-lg border border-navy-700 bg-navy-900 overflow-hidden"
              >
                {/* Summary row */}
                <div
                  className="flex items-center gap-4 px-4 py-3 cursor-pointer hover:bg-navy-800 transition-colors"
                  onClick={() => setExpandedId(isExpanded ? null : policy.id)}
                  role="button"
                  tabIndex={0}
                  aria-expanded={isExpanded}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setExpandedId(isExpanded ? null : policy.id) }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3">
                      <span className="font-medium text-white">{policy.name}</span>
                      <div className="flex flex-wrap gap-1">
                        {policy.allowed_models.slice(0, 3).map((m) => (
                          <span
                            key={m}
                            className="px-2 py-0.5 text-xs rounded-md bg-brand-900/50 text-brand-400 border border-brand-700"
                          >
                            {m}
                          </span>
                        ))}
                        {policy.allowed_models.length > 3 && (
                          <span className="px-2 py-0.5 text-xs rounded-md bg-navy-800 text-mountain-400 border border-navy-700">
                            +{policy.allowed_models.length - 3}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-mountain-400 shrink-0">
                    <span>{policy.max_requests_per_minute ? `${policy.max_requests_per_minute} req/min` : 'No rate limit'}</span>
                    <span>{policy.max_tokens_per_day ? `${policy.max_tokens_per_day.toLocaleString()} tok/day` : 'No token budget'}</span>
                    <svg
                      className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="border-t border-navy-700 px-4 py-4 bg-navy-800/50">
                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm mb-4">
                      {policy.description && (
                        <div className="sm:col-span-2">
                          <dt className="text-mountain-400">Description</dt>
                          <dd className="text-white mt-1">{policy.description}</dd>
                        </div>
                      )}
                      <div>
                        <dt className="text-mountain-400">Allowed Models</dt>
                        <dd className="flex flex-wrap gap-1 mt-1">
                          {policy.allowed_models.map((m) => (
                            <span
                              key={m}
                              className="px-2 py-0.5 text-xs rounded-md bg-brand-900/50 text-brand-400 border border-brand-700"
                            >
                              {m}
                            </span>
                          ))}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-mountain-400">Limits</dt>
                        <dd className="text-white mt-1">
                          {policy.max_requests_per_minute
                            ? `${policy.max_requests_per_minute} requests/min`
                            : 'Unlimited requests'}
                          {' / '}
                          {policy.max_tokens_per_day
                            ? `${policy.max_tokens_per_day.toLocaleString()} tokens/day`
                            : 'Unlimited tokens'}
                        </dd>
                      </div>
                      {aliases && (
                        <div className="sm:col-span-2">
                          <dt className="text-mountain-400">Model Aliases</dt>
                          <dd className="mt-1 space-y-1">
                            {Object.entries(aliases).map(([alias, target]) => (
                              <div key={alias} className="text-xs font-mono">
                                <span className="text-mountain-300">{alias}</span>
                                <span className="text-mountain-500 mx-2">&rarr;</span>
                                <span className="text-brand-400">{target}</span>
                              </div>
                            ))}
                          </dd>
                        </div>
                      )}
                      <div>
                        <dt className="text-mountain-400">Created</dt>
                        <dd className="text-white mt-1">{new Date(policy.created_at).toLocaleString()}</dd>
                      </div>
                    </dl>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleEdit(policy)}
                        className="px-3 py-1.5 text-xs font-medium rounded-md border border-navy-600 text-mountain-400 hover:text-white hover:border-navy-500 transition-colors cursor-pointer"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(policy)}
                        disabled={actionLoading === policy.id}
                        className="px-3 py-1.5 text-xs font-medium rounded-md border border-red-700 text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
