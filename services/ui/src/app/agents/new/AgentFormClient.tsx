'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import TagInput from '@/components/TagInput'

// Mirrors agentbox Pydantic ToolsConfig (services/agentbox/app/config.py)
interface ToolsConfig {
  shell: { enabled: boolean; allowed_binaries: string[]; denied_patterns: string[]; max_timeout: number }
  filesystem: { enabled: boolean; read_only: boolean; allowed_paths: string[]; denied_paths: string[] }
  health: { enabled: boolean }
}

const defaultTools: ToolsConfig = {
  shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
  filesystem: { enabled: false, read_only: false, allowed_paths: ['/workspace'], denied_paths: ['/etc/shadow', '/etc/passwd', '/root'] },
  health: { enabled: true },
}

interface PresetOption {
  id: string
  name: string
  description: string
  tools_config: ToolsConfig
  is_platform: boolean
}

interface PolicyOption {
  id: string
  name: string
}

export default function AgentFormClient({
  initial,
  agentUuid,
  disabled,
}: {
  initial?: {
    agent_id: string
    name: string
    description: string
    tools_config: ToolsConfig
    cpus: string
    mem_limit: string
    pids_limit: number
    soul_md: string
    rules_md: string
    model_policy_id?: string | null
    tool_preset_id?: string | null
  }
  agentUuid?: string
  disabled?: boolean
}) {
  const router = useRouter()
  const isEdit = !!agentUuid
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [validationError, setValidationError] = useState('')

  const [agentId, setAgentId] = useState(initial?.agent_id || '')
  const [name, setName] = useState(initial?.name || '')
  const [description, setDescription] = useState(initial?.description || '')
  const [tools, setTools] = useState<ToolsConfig>(initial?.tools_config || defaultTools)
  const [cpus, setCpus] = useState(initial?.cpus || '1.0')
  const [memLimit, setMemLimit] = useState(initial?.mem_limit || '1g')
  const [pidsLimit, setPidsLimit] = useState(initial?.pids_limit || 200)
  const [soulMd, setSoulMd] = useState(initial?.soul_md || '')
  const [rulesMd, setRulesMd] = useState(initial?.rules_md || '')
  const [modelPolicyId, setModelPolicyId] = useState(initial?.model_policy_id || '')
  const [policies, setPolicies] = useState<PolicyOption[]>([])
  const [presets, setPresets] = useState<PresetOption[]>([])
  const [toolPresetId, setToolPresetId] = useState(initial?.tool_preset_id || '')

  const [shellAdvanced, setShellAdvanced] = useState(false)
  const [fsAdvanced, setFsAdvanced] = useState(false)
  const [soulPreview, setSoulPreview] = useState(false)
  const [rulesPreview, setRulesPreview] = useState(false)

  useEffect(() => {
    fetch('/api/model-policies')
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setPolicies(data))
      .catch(() => {})
    fetch('/api/tool-presets')
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setPresets(data))
      .catch(() => {})
  }, [])

  const validateForm = (): boolean => {
    if (tools.shell.enabled && tools.shell.max_timeout < 1) {
      setValidationError('Timeout must be at least 1 second')
      return false
    }
    setValidationError('')
    return true
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validateForm()) return

    setSaving(true)
    setError('')

    const body: Record<string, unknown> = {
      agent_id: agentId,
      name,
      description,
      tools_config: tools,
      cpus,
      mem_limit: memLimit,
      pids_limit: pidsLimit,
      soul_md: soulMd,
      rules_md: rulesMd,
      model_policy_id: modelPolicyId || null,
      tool_preset_id: toolPresetId || null,
    }

    try {
      const url = isEdit ? `/api/agents/${agentUuid}` : '/api/agents'
      const method = isEdit ? 'PUT' : 'POST'
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const data = await res.json()
        setError(data.error || `Failed to ${isEdit ? 'update' : 'create'} agent`)
        return
      }

      const data = await res.json()
      router.push(`/agents/${data.id}`)
    } catch {
      setError('Request failed')
    } finally {
      setSaving(false)
    }
  }

  const pathValidate = (v: string) => (v.startsWith('/') ? null : 'Must start with /')

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      {error && (
        <div className="rounded-lg border border-red-700 bg-red-900/30 p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {validationError && (
        <div className="rounded-lg border border-red-700 bg-red-900/30 p-4 text-sm text-red-400">
          {validationError}
        </div>
      )}

      {disabled && (
        <div className="rounded-lg border border-yellow-700 bg-yellow-900/30 p-4 text-sm text-yellow-400">
          This agent is running. Stop it before making changes.
        </div>
      )}

      {/* Basic Info */}
      <fieldset disabled={disabled} className="space-y-4">
        <legend className="text-lg font-semibold text-white mb-4">Basic Info</legend>

        <div>
          <label htmlFor="agent_id" className="block text-xs font-medium text-mountain-500 uppercase tracking-wide mb-1">
            Agent ID (slug)
          </label>
          <input
            id="agent_id"
            type="text"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            disabled={isEdit}
            required
            pattern="[a-z0-9][a-z0-9-]{0,61}[a-z0-9]?"
            maxLength={63}
            placeholder="my-agent"
            className="w-full rounded-lg border border-navy-600 bg-navy-900 px-3 py-2 text-white text-sm placeholder:text-mountain-600 focus:border-brand-500 focus:outline-none disabled:opacity-50"
          />
        </div>

        <div>
          <label htmlFor="name" className="block text-xs font-medium text-mountain-500 uppercase tracking-wide mb-1">
            Name
          </label>
          <input
            id="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={255}
            placeholder="My Agent"
            className="w-full rounded-lg border border-navy-600 bg-navy-900 px-3 py-2 text-white text-sm placeholder:text-mountain-600 focus:border-brand-500 focus:outline-none disabled:opacity-50"
          />
        </div>

        <div>
          <label htmlFor="description" className="block text-xs font-medium text-mountain-500 uppercase tracking-wide mb-1">
            Description
          </label>
          <textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="What does this agent do?"
            className="w-full rounded-lg border border-navy-600 bg-navy-900 px-3 py-2 text-white text-sm placeholder:text-mountain-600 focus:border-brand-500 focus:outline-none disabled:opacity-50"
          />
        </div>
      </fieldset>

      {/* Tool Profile */}
      <fieldset disabled={disabled} className="space-y-4">
        <legend className="text-lg font-semibold text-white mb-4">Tools</legend>

        <div>
          <label htmlFor="tool_profile" className="block text-xs font-medium text-mountain-500 uppercase tracking-wide mb-1">
            Tool Profile
          </label>
          <select
            id="tool_profile"
            value={toolPresetId}
            onChange={(e) => {
              const newId = e.target.value
              if (newId) {
                // Switching to a preset — copy its tools_config into local state
                const preset = presets.find((p) => p.id === newId)
                if (preset) {
                  setTools(preset.tools_config)
                }
              }
              setToolPresetId(newId)
            }}
            className="rounded-lg border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none disabled:opacity-50"
          >
            <option value="">Custom</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <p className="text-xs text-mountain-500 mt-1">
            Select a preset profile or choose Custom for manual configuration.
          </p>
        </div>

        {toolPresetId ? (
          /* Preset selected — show read-only summary */
          <div className="rounded-lg border border-navy-700 bg-navy-800 p-4 space-y-3">
            {(() => {
              const preset = presets.find((p) => p.id === toolPresetId)
              if (!preset) return null
              const tc = preset.tools_config
              return (
                <>
                  {preset.description && (
                    <p className="text-sm text-mountain-300">{preset.description}</p>
                  )}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm">
                      <span className={`h-2 w-2 rounded-full ${tc.shell.enabled ? 'bg-brand-500' : 'bg-mountain-600'}`} />
                      <span className="text-white">Shell</span>
                      {tc.shell.enabled && (
                        <span className="text-mountain-400">
                          — {tc.shell.allowed_binaries.join(', ') || 'all binaries'}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <span className={`h-2 w-2 rounded-full ${tc.filesystem.enabled ? 'bg-brand-500' : 'bg-mountain-600'}`} />
                      <span className="text-white">Filesystem</span>
                      {tc.filesystem.enabled && (
                        <span className="text-mountain-400">
                          — {tc.filesystem.read_only ? 'Read-only' : 'Read-write'}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <span className={`h-2 w-2 rounded-full ${tc.health.enabled ? 'bg-brand-500' : 'bg-mountain-600'}`} />
                      <span className="text-white">Health</span>
                    </div>
                  </div>
                  <p className="text-xs text-mountain-500">
                    Profile applied at assignment time. Switch to Custom to edit manually.
                  </p>
                </>
              )
            })()}
          </div>
        ) : (
          /* Custom mode — show manual tool toggles */
          <div className="rounded-lg border border-navy-700 bg-navy-800 p-4 space-y-3">
            {/* Shell */}
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={tools.shell.enabled}
                onChange={(e) => setTools({ ...tools, shell: { ...tools.shell, enabled: e.target.checked } })}
                className="rounded border-navy-600"
              />
              <span className="text-sm text-white">Shell access</span>
            </label>

            {tools.shell.enabled && (
              <div className="ml-6 space-y-3">
                <button
                  type="button"
                  onClick={() => setShellAdvanced(!shellAdvanced)}
                  className="text-xs text-brand-400 hover:text-brand-300 transition-colors"
                >
                  Advanced settings
                </button>
                {shellAdvanced && (
                  <div className="space-y-3 border-l-2 border-navy-600 pl-4">
                    <TagInput
                      label="Allowed Binaries"
                      value={tools.shell.allowed_binaries}
                      onChange={(v) => setTools({ ...tools, shell: { ...tools.shell, allowed_binaries: v } })}
                      placeholder="Add binary (e.g. bash)..."
                      disabled={disabled}
                    />
                    <TagInput
                      label="Denied Patterns"
                      value={tools.shell.denied_patterns}
                      onChange={(v) => setTools({ ...tools, shell: { ...tools.shell, denied_patterns: v } })}
                      placeholder="Add pattern (e.g. rm -rf)..."
                      disabled={disabled}
                    />
                    <div>
                      <label htmlFor="max_timeout" className="block text-xs font-medium text-mountain-500 uppercase tracking-wide mb-1">
                        Max Timeout (seconds)
                      </label>
                      <input
                        id="max_timeout"
                        type="number"
                        value={tools.shell.max_timeout}
                        onChange={(e) => setTools({ ...tools, shell: { ...tools.shell, max_timeout: parseInt(e.target.value) || 0 } })}
                        min={1}
                        className="w-32 rounded-lg border border-navy-600 bg-navy-900 px-3 py-1.5 text-white text-sm focus:border-brand-500 focus:outline-none disabled:opacity-50"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Filesystem */}
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={tools.filesystem.enabled}
                onChange={(e) => setTools({ ...tools, filesystem: { ...tools.filesystem, enabled: e.target.checked } })}
                className="rounded border-navy-600"
              />
              <span className="text-sm text-white">Filesystem access</span>
            </label>

            {tools.filesystem.enabled && (
              <div className="ml-6 space-y-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={tools.filesystem.read_only}
                    onChange={(e) => setTools({ ...tools, filesystem: { ...tools.filesystem, read_only: e.target.checked } })}
                    className="rounded border-navy-600"
                  />
                  <span className="text-sm text-mountain-400">Read-only filesystem</span>
                </label>

                <button
                  type="button"
                  onClick={() => setFsAdvanced(!fsAdvanced)}
                  className="text-xs text-brand-400 hover:text-brand-300 transition-colors"
                >
                  Advanced settings
                </button>
                {fsAdvanced && (
                  <div className="space-y-3 border-l-2 border-navy-600 pl-4">
                    <TagInput
                      label="Allowed Paths"
                      value={tools.filesystem.allowed_paths}
                      onChange={(v) => setTools({ ...tools, filesystem: { ...tools.filesystem, allowed_paths: v } })}
                      validate={pathValidate}
                      placeholder="Add path (e.g. /workspace)..."
                      disabled={disabled}
                    />
                    <TagInput
                      label="Denied Paths"
                      value={tools.filesystem.denied_paths}
                      onChange={(v) => setTools({ ...tools, filesystem: { ...tools.filesystem, denied_paths: v } })}
                      validate={pathValidate}
                      placeholder="Add path (e.g. /etc/shadow)..."
                      disabled={disabled}
                    />
                  </div>
                )}
              </div>
            )}

            {/* Health */}
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={tools.health.enabled}
                onChange={(e) => setTools({ ...tools, health: { ...tools.health, enabled: e.target.checked } })}
                className="rounded border-navy-600"
              />
              <span className="text-sm text-white">Health endpoint</span>
            </label>
          </div>
        )}
      </fieldset>

      {/* Model Policy */}
      <fieldset disabled={disabled} className="space-y-4">
        <legend className="text-lg font-semibold text-white mb-4">Model Policy</legend>

        <div>
          <label htmlFor="model_policy_id" className="block text-xs font-medium text-mountain-500 uppercase tracking-wide mb-1">
            Model Policy
          </label>
          <select
            id="model_policy_id"
            value={modelPolicyId}
            onChange={(e) => setModelPolicyId(e.target.value)}
            className="rounded-lg border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none disabled:opacity-50"
          >
            <option value="">None</option>
            {policies.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <p className="text-xs text-mountain-500 mt-1">
            Controls which LLM models this agent can access.
          </p>
        </div>
      </fieldset>

      {/* Resources */}
      <fieldset disabled={disabled} className="space-y-4">
        <legend className="text-lg font-semibold text-white mb-4">Resources</legend>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label htmlFor="cpus" className="block text-xs font-medium text-mountain-500 uppercase tracking-wide mb-1">
              CPUs
            </label>
            <input
              id="cpus"
              type="text"
              value={cpus}
              onChange={(e) => setCpus(e.target.value)}
              placeholder="1.0"
              className="w-full rounded-lg border border-navy-600 bg-navy-900 px-3 py-2 text-white text-sm focus:border-brand-500 focus:outline-none disabled:opacity-50"
            />
          </div>
          <div>
            <label htmlFor="mem_limit" className="block text-xs font-medium text-mountain-500 uppercase tracking-wide mb-1">
              Memory
            </label>
            <input
              id="mem_limit"
              type="text"
              value={memLimit}
              onChange={(e) => setMemLimit(e.target.value)}
              placeholder="1g"
              className="w-full rounded-lg border border-navy-600 bg-navy-900 px-3 py-2 text-white text-sm focus:border-brand-500 focus:outline-none disabled:opacity-50"
            />
          </div>
          <div>
            <label htmlFor="pids_limit" className="block text-xs font-medium text-mountain-500 uppercase tracking-wide mb-1">
              PID Limit
            </label>
            <input
              id="pids_limit"
              type="number"
              value={pidsLimit}
              onChange={(e) => setPidsLimit(parseInt(e.target.value) || 200)}
              className="w-full rounded-lg border border-navy-600 bg-navy-900 px-3 py-2 text-white text-sm focus:border-brand-500 focus:outline-none disabled:opacity-50"
            />
          </div>
        </div>
      </fieldset>

      {/* Identity */}
      <fieldset disabled={disabled} className="space-y-4">
        <legend className="text-lg font-semibold text-white mb-4">Identity</legend>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="soul_md" className="block text-xs font-medium text-mountain-500 uppercase tracking-wide">
              SOUL.md
            </label>
            <div className="flex items-center gap-3">
              <span className="text-xs text-mountain-500">{soulMd.length} characters</span>
              <button
                type="button"
                onClick={() => setSoulPreview(!soulPreview)}
                className="text-xs text-brand-400 hover:text-brand-300 transition-colors"
              >
                {soulPreview ? 'Edit' : 'Preview'}
              </button>
            </div>
          </div>
          {soulPreview ? (
            <pre className="w-full rounded-lg border border-navy-600 bg-navy-900 px-3 py-2 text-white text-sm font-mono whitespace-pre-wrap min-h-[12rem] max-h-96 overflow-y-auto">
              {soulMd || 'Nothing to preview'}
            </pre>
          ) : (
            <textarea
              id="soul_md"
              value={soulMd}
              onChange={(e) => setSoulMd(e.target.value)}
              rows={12}
              placeholder="Agent personality and purpose..."
              className="w-full rounded-lg border border-navy-600 bg-navy-900 px-3 py-2 text-white text-sm font-mono placeholder:text-mountain-600 focus:border-brand-500 focus:outline-none disabled:opacity-50"
            />
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="rules_md" className="block text-xs font-medium text-mountain-500 uppercase tracking-wide">
              RULES.md
            </label>
            <div className="flex items-center gap-3">
              <span className="text-xs text-mountain-500">{rulesMd.length} characters</span>
              <button
                type="button"
                onClick={() => setRulesPreview(!rulesPreview)}
                className="text-xs text-brand-400 hover:text-brand-300 transition-colors"
              >
                {rulesPreview ? 'Edit' : 'Preview'}
              </button>
            </div>
          </div>
          {rulesPreview ? (
            <pre className="w-full rounded-lg border border-navy-600 bg-navy-900 px-3 py-2 text-white text-sm font-mono whitespace-pre-wrap min-h-[12rem] max-h-96 overflow-y-auto">
              {rulesMd || 'Nothing to preview'}
            </pre>
          ) : (
            <textarea
              id="rules_md"
              value={rulesMd}
              onChange={(e) => setRulesMd(e.target.value)}
              rows={12}
              placeholder="Agent operational constraints..."
              className="w-full rounded-lg border border-navy-600 bg-navy-900 px-3 py-2 text-white text-sm font-mono placeholder:text-mountain-600 focus:border-brand-500 focus:outline-none disabled:opacity-50"
            />
          )}
        </div>
      </fieldset>

      <div className="flex items-center gap-4 pt-4">
        <button
          type="submit"
          disabled={saving || disabled}
          className="px-6 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
        >
          {saving ? 'Saving...' : isEdit ? 'Update Agent' : 'Create Agent'}
        </button>
        <button
          type="button"
          onClick={() => router.back()}
          className="px-6 py-2 text-sm font-medium rounded-lg border border-navy-600 text-mountain-400 hover:text-white hover:border-navy-500 transition-colors cursor-pointer"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
