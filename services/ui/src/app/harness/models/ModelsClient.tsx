'use client'

import { useState, useEffect, useCallback } from 'react'
import { ProviderIcon, CompositeProviderIcon } from './provider-icons'

interface RouteEntry {
  key: string
  connection_id: string
  litellm_model: string
  detected_type?: string
  capabilities?: string[]
  task_types?: string[]
  priority: number
}

interface RoutingConfig {
  strategy: 'fallback' | 'task_routing'
  default_route: string
  routes: RouteEntry[]
}

interface UserModel {
  id: string
  name: string
  connection_id: string | null
  litellm_model: string | null
  description: string
  is_active: boolean
  is_platform?: boolean
  model_type: 'single' | 'router'
  detected_type: string | null
  capabilities: string[] | null
  routing_config: RoutingConfig | null
  icon_emoji: string | null  // deprecated — always null on new writes
  icon_url: string | null
  created_at: string
  updated_at: string
}

interface ProviderConnection {
  id: string
  name: string
  provider: string
}

interface ProviderModel {
  id: string
  display_name: string
  detected_type: string
  capabilities: string[]
}

type ModelFormData = {
  name: string
  connection_id: string
  description: string
  icon_url: string
  detected_type: string
  capabilities: string[]
  // For the multi-select picker
  selectedModels: string[]
  // For cross-connection routes
  extraRoutes: Array<{ connection_id: string; litellm_model: string }>
  // Router config
  strategy: 'fallback' | 'task_routing'
  default_route: string
  customModelId: string
}

export default function ModelsClient() {
  const [models, setModels] = useState<UserModel[]>([])
  const [connections, setConnections] = useState<ProviderConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [formError, setFormError] = useState('')

  // Provider model picker state
  const [providerModels, setProviderModels] = useState<ProviderModel[]>([])
  const [providerModelsLoading, setProviderModelsLoading] = useState(false)
  const [providerModelsError, setProviderModelsError] = useState('')
  const [showCustomInput, setShowCustomInput] = useState(false)

  const defaultFormData: ModelFormData = {
    name: '',
    connection_id: '',
    description: '',
    icon_url: '',
    detected_type: '',
    capabilities: [],
    selectedModels: [],
    extraRoutes: [],
    strategy: 'fallback',
    default_route: '',
    customModelId: '',
  }

  const [formData, setFormData] = useState<ModelFormData>(defaultFormData)

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
    setFormData(defaultFormData)
    setFormError('')
    setShowCreate(false)
    setEditingId(null)
    setProviderModels([])
    setProviderModelsError('')
    setShowCustomInput(false)
  }

  const fetchProviderModels = async (connId: string) => {
    setProviderModelsLoading(true)
    setProviderModelsError('')
    setProviderModels([])

    try {
      const res = await fetch(`/api/provider-connections/${connId}/models`)
      if (res.ok) {
        const data = await res.json()
        if (data.error) {
          setProviderModelsError(data.error)
        }
        setProviderModels(data.models || [])
      } else {
        setProviderModelsError('Failed to fetch models')
      }
    } catch {
      setProviderModelsError('Failed to connect to provider')
    } finally {
      setProviderModelsLoading(false)
    }
  }

  const handleConnectionChange = (connId: string) => {
    setFormData({ ...formData, connection_id: connId, selectedModels: [], customModelId: '' })
    setShowCustomInput(false)
    if (connId) {
      fetchProviderModels(connId)
    } else {
      setProviderModels([])
      setProviderModelsError('')
    }
  }

  const handleModelToggle = (modelId: string) => {
    setFormData(prev => ({
      ...prev,
      selectedModels: prev.selectedModels.includes(modelId)
        ? prev.selectedModels.filter(m => m !== modelId)
        : [...prev.selectedModels, modelId],
    }))
  }

  const isRouterMode = formData.selectedModels.length + formData.extraRoutes.length > 1

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError('')

    if (!formData.name.trim()) {
      setFormError('Name is required')
      return
    }

    const allSelectedModels = [
      ...formData.selectedModels,
      ...(formData.customModelId ? [formData.customModelId] : []),
    ]

    if (allSelectedModels.length === 0 && formData.extraRoutes.length === 0 && !isRouterMode) {
      setFormError('At least one model must be selected')
      return
    }

    let body: Record<string, unknown>

    if (isRouterMode || allSelectedModels.length + formData.extraRoutes.length > 1) {
      // Router mode
      const routes: RouteEntry[] = []
      let priority = 1

      for (const modelId of allSelectedModels) {
        const key = modelId.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
        routes.push({
          key: `${key}-${priority}`,
          connection_id: formData.connection_id,
          litellm_model: modelId,
          priority: priority++,
        })
      }

      for (const extra of formData.extraRoutes) {
        const key = extra.litellm_model.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
        routes.push({
          key: `${key}-${priority}`,
          connection_id: extra.connection_id,
          litellm_model: extra.litellm_model,
          priority: priority++,
        })
      }

      // Validate all routes have a connection selected
      if (routes.some(r => !r.connection_id)) {
        setFormError('All routes must have a connection selected')
        return
      }

      const defaultRoute = routes[0]?.key || ''

      body = {
        name: formData.name.trim(),
        model_type: 'router',
        routing_config: {
          strategy: formData.strategy,
          default_route: formData.default_route || defaultRoute,
          routes,
        },
      }
    } else {
      // Single model
      const litellmModel = allSelectedModels[0] || formData.customModelId
      if (!formData.connection_id) {
        setFormError('Connection is required')
        return
      }
      if (!litellmModel) {
        setFormError('A model must be selected')
        return
      }

      body = {
        name: formData.name.trim(),
        connection_id: formData.connection_id,
        litellm_model: litellmModel,
      }
    }

    if (formData.description.trim()) body.description = formData.description.trim()
    if (formData.icon_url.trim()) body.icon_url = formData.icon_url.trim()
    if (formData.detected_type) body.detected_type = formData.detected_type
    if (formData.capabilities.length > 0) body.capabilities = formData.capabilities

    try {
      const url = editingId ? `/api/user-models/${editingId}` : '/api/user-models'
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
    if (model.model_type === 'router' && model.routing_config) {
      // Populate router form
      const primaryConnId = model.routing_config.routes[0]?.connection_id || ''
      const primaryModels = model.routing_config.routes
        .filter(r => r.connection_id === primaryConnId)
        .map(r => r.litellm_model)
      const extraRoutes = model.routing_config.routes
        .filter(r => r.connection_id !== primaryConnId)
        .map(r => ({ connection_id: r.connection_id, litellm_model: r.litellm_model }))

      setFormData({
        name: model.name,
        connection_id: primaryConnId,
        description: model.description || '',
        icon_url: model.icon_url || '',
        detected_type: '',
        capabilities: [],
        selectedModels: primaryModels,
        extraRoutes,
        strategy: model.routing_config.strategy,
        default_route: model.routing_config.default_route,
        customModelId: '',
      })

      if (primaryConnId) fetchProviderModels(primaryConnId)
    } else {
      setFormData({
        name: model.name,
        connection_id: model.connection_id || '',
        description: model.description || '',
        icon_url: model.icon_url || '',
        detected_type: model.detected_type || '',
        capabilities: model.capabilities || [],
        selectedModels: model.litellm_model ? [model.litellm_model] : [],
        extraRoutes: [],
        strategy: 'fallback',
        default_route: '',
        customModelId: '',
      })

      if (model.connection_id) fetchProviderModels(model.connection_id)
    }
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

  const typeBadgeColor = (type: string) => {
    switch (type) {
      case 'embedding': return 'bg-purple-900/50 text-purple-400 border-purple-700'
      case 'audio': return 'bg-blue-900/50 text-blue-400 border-blue-700'
      case 'image': return 'bg-pink-900/50 text-pink-400 border-pink-700'
      case 'transcription': return 'bg-teal-900/50 text-teal-400 border-teal-700'
      default: return 'bg-brand-900/50 text-brand-400 border-brand-700'
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
                  onChange={(e) => handleConnectionChange(e.target.value)}
                  className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none"
                >
                  <option value="">Select a connection</option>
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} ({c.provider})</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Provider Model Picker */}
            {formData.connection_id && (
              <div>
                <label className="block text-sm text-mountain-400 mb-1">Provider Models</label>

                {providerModelsLoading && (
                  <div className="flex items-center gap-2 py-3">
                    <div className="h-4 w-4 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
                    <span className="text-sm text-mountain-400">Loading models from provider...</span>
                  </div>
                )}

                {providerModelsError && !providerModelsLoading && (
                  <div className="rounded-md border border-red-700 bg-red-900/30 p-3 mb-2">
                    <p className="text-sm text-red-400">
                      Could not fetch models from provider. Check your connection credentials.
                    </p>
                    <p className="text-xs text-red-500 mt-1">{providerModelsError}</p>
                    <button
                      type="button"
                      onClick={() => fetchProviderModels(formData.connection_id)}
                      className="mt-2 px-3 py-1 text-xs font-medium rounded-md border border-red-700 text-red-400 hover:bg-red-900/50 transition-colors cursor-pointer"
                    >
                      Retry
                    </button>
                  </div>
                )}

                {!providerModelsLoading && !providerModelsError && providerModels.length === 0 && (
                  <div className="rounded-md border border-navy-600 bg-navy-900 p-3 mb-2">
                    <span className="inline-block px-2 py-0.5 text-xs rounded-md bg-navy-700 text-mountain-400 border border-navy-600 mb-2">
                      Model listing not supported for this provider
                    </span>
                    <p className="text-xs text-mountain-500">Enter model IDs manually below.</p>
                  </div>
                )}

                {!providerModelsLoading && providerModels.length > 0 && (
                  <div className="max-h-48 overflow-y-auto rounded-md border border-navy-600 bg-navy-900 p-2 space-y-1">
                    {providerModels.map((pm) => (
                      <label key={pm.id} className="flex items-center gap-2 text-sm text-white cursor-pointer py-1 px-1 rounded hover:bg-navy-800">
                        <input
                          type="checkbox"
                          checked={formData.selectedModels.includes(pm.id)}
                          onChange={() => handleModelToggle(pm.id)}
                          className="rounded border-navy-600"
                        />
                        <ProviderIcon provider={connectionProvider(formData.connection_id)} className="h-4 w-4" />
                        <span className="font-mono text-xs">{pm.display_name}</span>
                        <span className={`px-1.5 py-0.5 text-xs rounded-md border ${typeBadgeColor(pm.detected_type)}`}>
                          {pm.detected_type}
                        </span>
                      </label>
                    ))}
                  </div>
                )}

                {/* Custom model ID fallback */}
                {!showCustomInput ? (
                  <button
                    type="button"
                    onClick={() => setShowCustomInput(true)}
                    className="mt-2 text-xs text-brand-400 hover:text-brand-300 transition-colors"
                  >
                    Enter custom model ID
                  </button>
                ) : (
                  <div className="mt-2">
                    <input
                      type="text"
                      value={formData.customModelId}
                      onChange={(e) => setFormData({ ...formData, customModelId: e.target.value })}
                      className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
                      placeholder="openai/gpt-4o-mini"
                    />
                  </div>
                )}

                {/* Selected count indicator */}
                {(formData.selectedModels.length > 0 || formData.customModelId) && (
                  <p className="text-xs text-mountain-500 mt-1">
                    {formData.selectedModels.length + (formData.customModelId ? 1 : 0)} model{(formData.selectedModels.length + (formData.customModelId ? 1 : 0)) !== 1 ? 's' : ''} selected
                  </p>
                )}
              </div>
            )}

            {/* Router Configuration Panel — appears when 2+ models selected */}
            {isRouterMode && (
              <div className="rounded-md border border-navy-600 bg-navy-900 p-4 space-y-3">
                <h3 className="text-sm font-medium text-white">Router Configuration</h3>
                <p className="text-xs text-mountain-500">
                  Multiple models selected. Configure routing strategy.
                </p>

                <div>
                  <label className="block text-xs text-mountain-400 mb-1">Strategy</label>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 text-sm text-white cursor-pointer">
                      <input
                        type="radio"
                        name="strategy"
                        value="fallback"
                        checked={formData.strategy === 'fallback'}
                        onChange={() => setFormData({ ...formData, strategy: 'fallback' })}
                        className="border-navy-600"
                      />
                      Fallback
                    </label>
                    <label className="flex items-center gap-2 text-sm text-white cursor-pointer">
                      <input
                        type="radio"
                        name="strategy"
                        value="task_routing"
                        checked={formData.strategy === 'task_routing'}
                        onChange={() => setFormData({ ...formData, strategy: 'task_routing' })}
                        className="border-navy-600"
                      />
                      Task Routing
                    </label>
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-mountain-400 mb-1">Routes (ordered by priority)</label>
                  <div className="space-y-2">
                    {formData.selectedModels.map((modelId, idx) => (
                      <div key={modelId} className="flex items-center gap-2 text-sm text-mountain-300 bg-navy-800 rounded-md px-3 py-2">
                        <span className="text-xs text-mountain-500 w-6">{idx + 1}.</span>
                        <span className="font-mono text-xs flex-1">{modelId}</span>
                        <span className="text-xs text-mountain-500">{connectionName(formData.connection_id)}</span>
                      </div>
                    ))}
                    {formData.extraRoutes.map((route, idx) => (
                      <div key={`extra-${idx}`} className="flex items-center gap-2 text-sm text-mountain-300 bg-navy-800 rounded-md px-3 py-2">
                        <span className="text-xs text-mountain-500 w-6">{formData.selectedModels.length + idx + 1}.</span>
                        <span className="font-mono text-xs flex-1">{route.litellm_model}</span>
                        <span className="text-xs text-mountain-500">{connectionName(route.connection_id)}</span>
                        <button
                          type="button"
                          onClick={() => setFormData(prev => ({
                            ...prev,
                            extraRoutes: prev.extraRoutes.filter((_, i) => i !== idx),
                          }))}
                          className="text-xs text-red-400 hover:text-red-300"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Add model from different connection */}
                <button
                  type="button"
                  onClick={() => setFormData(prev => ({
                    ...prev,
                    extraRoutes: [...prev.extraRoutes, { connection_id: '', litellm_model: '' }],
                  }))}
                  className="text-xs text-brand-400 hover:text-brand-300 transition-colors"
                >
                  Add model from different connection
                </button>

                {/* Extra route inputs */}
                {formData.extraRoutes.filter(r => !r.connection_id).map((_, idx) => {
                  const actualIdx = formData.extraRoutes.findIndex((r, i) => !r.connection_id && i >= idx)
                  if (actualIdx < 0) return null
                  return (
                    <div key={`extra-input-${idx}`} className="grid grid-cols-2 gap-2">
                      <select
                        value={formData.extraRoutes[actualIdx]?.connection_id || ''}
                        onChange={(e) => {
                          const newRoutes = [...formData.extraRoutes]
                          newRoutes[actualIdx] = { ...newRoutes[actualIdx], connection_id: e.target.value }
                          setFormData({ ...formData, extraRoutes: newRoutes })
                        }}
                        className="rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none"
                      >
                        <option value="">Select connection</option>
                        {connections.filter(c => c.id !== formData.connection_id).map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={formData.extraRoutes[actualIdx]?.litellm_model || ''}
                        onChange={(e) => {
                          const newRoutes = [...formData.extraRoutes]
                          newRoutes[actualIdx] = { ...newRoutes[actualIdx], litellm_model: e.target.value }
                          setFormData({ ...formData, extraRoutes: newRoutes })
                        }}
                        placeholder="provider/model-id"
                        className="rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
                      />
                    </div>
                  )
                })}
              </div>
            )}

            {/* Icon configuration */}
            <div>
              <label className="block text-sm text-mountain-400 mb-1">
                Icon URL <span className="text-mountain-500">(optional)</span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={formData.icon_url}
                  onChange={(e) => setFormData({ ...formData, icon_url: e.target.value })}
                  className="flex-1 rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
                  placeholder="https://example.com/icon.png"
                />
                {formData.icon_url && (
                  <img src={formData.icon_url} alt="icon" className="h-8 w-8 rounded-md object-cover" />
                )}
              </div>
            </div>

            {/* Description */}
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

            {/* Type Override */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-mountain-400 mb-1">
                  Detected Type <span className="text-mountain-500">(auto or override)</span>
                </label>
                <select
                  value={formData.detected_type}
                  onChange={(e) => setFormData({ ...formData, detected_type: e.target.value })}
                  className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none"
                >
                  <option value="">Auto-detect</option>
                  <option value="chat">Chat</option>
                  <option value="embedding">Embedding</option>
                  <option value="audio">Audio</option>
                  <option value="image">Image</option>
                  <option value="transcription">Transcription</option>
                </select>
              </div>
              <div>
                <label className="block text-sm text-mountain-400 mb-1">
                  Capabilities <span className="text-mountain-500">(override)</span>
                </label>
                <div className="flex flex-wrap gap-2 mt-1">
                  {['chat', 'function_calling', 'vision', 'embedding', 'audio', 'image_generation', 'transcription'].map((cap) => (
                    <label key={cap} className="flex items-center gap-1 text-xs text-mountain-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formData.capabilities.includes(cap)}
                        onChange={() => setFormData(prev => ({
                          ...prev,
                          capabilities: prev.capabilities.includes(cap)
                            ? prev.capabilities.filter(c => c !== cap)
                            : [...prev.capabilities, cap],
                        }))}
                        className="rounded border-navy-600"
                      />
                      {cap}
                    </label>
                  ))}
                </div>
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
                <th className="px-4 py-3 font-medium">Type</th>
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
                    <div className="flex items-center gap-2">
                      {model.model_type === 'router' && model.routing_config ? (
                        <CompositeProviderIcon
                          providers={model.routing_config.routes.map(r => connectionProvider(r.connection_id))}
                        />
                      ) : model.connection_id ? (
                        <ProviderIcon provider={connectionProvider(model.connection_id)} />
                      ) : (
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-navy-700 text-xs font-medium text-mountain-400">
                          {model.name.charAt(0).toUpperCase()}
                        </span>
                      )}
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-white font-medium">{model.name}</span>
                          {model.is_platform && (
                            <span className="px-1.5 py-0.5 text-xs rounded-md border bg-blue-900/50 text-blue-400 border-blue-700">Platform</span>
                          )}
                        </div>
                        {model.description && (
                          <div className="text-xs text-mountain-500 mt-0.5">{model.description}</div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-1.5 py-0.5 text-xs rounded-md border ${
                      model.model_type === 'router'
                        ? 'bg-amber-900/50 text-amber-400 border-amber-700'
                        : 'bg-navy-800 text-mountain-300 border-navy-600'
                    }`}>
                      {model.model_type === 'router' ? 'Router' : 'Single'}
                    </span>
                    {model.detected_type && (
                      <span className={`ml-1 px-1.5 py-0.5 text-xs rounded-md border ${typeBadgeColor(model.detected_type)}`}>
                        {model.detected_type}
                      </span>
                    )}
                    {model.model_type === 'router' && model.routing_config && (
                      <span className="ml-1 text-xs text-mountain-500">
                        {model.routing_config.routes.length} routes
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-mountain-300">
                    {model.model_type === 'router'
                      ? model.routing_config?.routes.map(r => r.litellm_model).join(', ')
                      : model.litellm_model
                    }
                  </td>
                  <td className="px-4 py-3">
                    {model.model_type === 'router' ? (
                      <span className="text-mountain-400 text-xs">
                        {[...new Set(model.routing_config?.routes.map(r => connectionName(r.connection_id)) || [])].join(', ')}
                      </span>
                    ) : model.connection_id ? (
                      connections.find(c => c.id === model.connection_id) ? (
                        <>
                          <span className="text-mountain-300">{connectionName(model.connection_id)}</span>
                          <span className="text-mountain-500 text-xs ml-1">({connectionProvider(model.connection_id)})</span>
                        </>
                      ) : (
                        <span className="px-1.5 py-0.5 text-xs rounded-md border bg-red-900/30 text-red-400 border-red-700">Unknown connection</span>
                      )
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-mountain-400">{new Date(model.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    {!model.is_platform && (
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
                    )}
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
