'use client'

import { useState, useEffect, useRef } from 'react'
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

interface SkillOption {
  id: string
  name: string
  description: string
  scope: string
  tools_config: ToolsConfig
  instructions_md?: string
  is_platform: boolean
  tools?: Array<{ id: string; name: string }>
}

const ELEVATED_SCOPES = ['host_docker', 'vps_system']

function scopeBadge(scope: string): { label: string; colorClasses: string } {
  switch (scope) {
    case 'container_local':
      return { label: 'Container', colorClasses: 'bg-brand-900/50 text-brand-400 border border-brand-700' }
    case 'host_docker':
      return { label: 'Host · Docker', colorClasses: 'bg-amber-900/50 text-amber-400 border border-amber-700' }
    case 'vps_system':
      return { label: 'VPS · System', colorClasses: 'bg-red-900/50 text-red-400 border border-red-700' }
    default:
      return { label: scope, colorClasses: 'bg-navy-900 text-mountain-400 border border-navy-700' }
  }
}

interface PolicyOption {
  id: string
  name: string
}

export default function AgentFormClient({
  initial,
  agentUuid,
  disabled,
  isAdmin = false,
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
    skills?: Array<{ id: string; name: string; scope: string }>
    sandbox_profile?: string | null
  }
  agentUuid?: string
  disabled?: boolean
  isAdmin?: boolean
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
  const [skills, setSkills] = useState<SkillOption[]>([])
  const [sandboxProfile, setSandboxProfile] = useState(initial?.sandbox_profile || '')
  // Mode: 'custom' = manual tools_config; 'skills' = checkbox multi-select
  const hasInitialSkills = (initial?.skills?.length ?? 0) > 0
  const [mode, setMode] = useState<'custom' | 'skills'>(
    initial ? (hasInitialSkills ? 'skills' : 'custom') : 'skills'
  )
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(
    new Set(initial?.skills?.map(s => s.id) || [])
  )
  const toolsCustomDirty = useRef(false)

  const [shellAdvanced, setShellAdvanced] = useState(false)
  const [fsAdvanced, setFsAdvanced] = useState(false)
  const [soulPreview, setSoulPreview] = useState(false)
  const [rulesPreview, setRulesPreview] = useState(false)

  useEffect(() => {
    fetch('/api/model-policies')
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setPolicies(data))
      .catch(() => {})
    fetch('/api/skills')
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setSkills(data))
      .catch(() => {})
  }, [])

  // Wrapper: marks tools as user-modified when editing in Custom mode
  const updateToolsCustom = (newTools: ToolsConfig) => {
    setTools(newTools)
    toolsCustomDirty.current = true
  }

  const handleModeChange = (newMode: 'custom' | 'skills') => {
    if (newMode === mode) return

    if (newMode === 'skills' && toolsCustomDirty.current) {
      if (!confirm('Switching to Skills mode will overwrite your custom tool configuration. Continue?')) {
        return
      }
    }

    if (newMode === 'custom') {
      setSelectedSkillIds(new Set())
      toolsCustomDirty.current = false
    } else {
      toolsCustomDirty.current = false
    }

    setMode(newMode)
  }

  const handleSkillToggle = (skillId: string) => {
    setSelectedSkillIds(prev => {
      const next = new Set(prev)
      if (next.has(skillId)) next.delete(skillId)
      else next.add(skillId)
      return next
    })
  }

  const validateForm = (): boolean => {
    if (mode === 'skills' && selectedSkillIds.size === 0) {
      setValidationError('Please select at least one skill or switch to Custom mode')
      return false
    }
    if (mode === 'custom' && tools.shell.enabled && tools.shell.max_timeout < 1) {
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
      tools_config: mode === 'custom' ? tools : undefined,
      cpus,
      mem_limit: memLimit,
      pids_limit: pidsLimit,
      soul_md: soulMd,
      rules_md: rulesMd,
      model_policy_id: modelPolicyId || null,
      skill_ids: mode === 'skills' ? [...selectedSkillIds] : [],
      sandbox_profile: sandboxProfile || null,
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

      {/* Tools — Custom/Skills mode toggle */}
      <fieldset disabled={disabled} className="space-y-4">
        <legend className="text-lg font-semibold text-white mb-4">Tools</legend>

        {/* Sandbox Profile */}
        <div className="mb-4">
          <label htmlFor="sandbox_profile" className="block text-xs font-medium text-mountain-500 uppercase tracking-wide mb-1">Sandbox Profile</label>
          <select
            id="sandbox_profile"
            value={sandboxProfile}
            onChange={(e) => setSandboxProfile(e.target.value)}
            className="rounded-lg border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none"
          >
            <option value="">None (custom / skill-only)</option>
            <option value="minimal">Minimal</option>
            <option value="developer">Developer</option>
            <option value="research">Research</option>
            <option value="operator">Operator</option>
          </select>
        </div>

        {/* Mode radio toggle */}
        <div className="flex items-center gap-4" role="radiogroup" aria-label="Tools mode">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="tools-mode"
              value="skills"
              checked={mode === 'skills'}
              onChange={() => handleModeChange('skills')}
              className="text-brand-500"
            />
            <span className="text-sm text-white">Skills</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="tools-mode"
              value="custom"
              checked={mode === 'custom'}
              onChange={() => handleModeChange('custom')}
              className="text-brand-500"
            />
            <span className="text-sm text-white">Custom</span>
          </label>
        </div>

        {mode === 'skills' ? (
          /* Skills mode — checkbox multi-select */
          <div className="rounded-lg border border-navy-700 bg-navy-800 p-4 space-y-3">
            <p className="text-xs text-mountain-400 mb-2">
              Select one or more skills. Tool configurations are merged from all selected skills.
            </p>
            {(() => {
              const visibleSkills = isAdmin ? skills : skills.filter(s => !ELEVATED_SCOPES.includes(s.scope))
              return (
                <div className="space-y-2">
                  {visibleSkills.map((skill) => {
                    const badge = scopeBadge(skill.scope)
                    return (
                      <label key={skill.id} className="flex items-center gap-3 cursor-pointer py-1">
                        <input
                          type="checkbox"
                          checked={selectedSkillIds.has(skill.id)}
                          onChange={() => handleSkillToggle(skill.id)}
                          className="rounded border-navy-600"
                        />
                        <span className="text-sm text-white">{skill.name}</span>
                        <span className={`px-1.5 py-0.5 text-xs rounded-md ${badge.colorClasses}`}>
                          {badge.label}
                        </span>
                        {skill.tools && skill.tools.length > 0 && (
                          <span className="px-1.5 py-0.5 text-xs rounded-md bg-navy-800 text-mountain-300 border border-navy-600 font-mono">
                            {skill.tools.map(t => t.name).join(', ')}
                          </span>
                        )}
                      </label>
                    )
                  })}
                  {visibleSkills.length === 0 && (
                    <p className="text-xs text-mountain-500">No skills available</p>
                  )}
                </div>
              )
            })()}
            {selectedSkillIds.size > 0 && (
              <div className="border-t border-navy-700 pt-3">
                <p className="text-xs text-mountain-500">
                  {selectedSkillIds.size} skill{selectedSkillIds.size !== 1 ? 's' : ''} selected. Tools config will be merged at save time.
                </p>
              </div>
            )}
          </div>
        ) : (
          /* Custom mode — show manual tool toggles */
          <div className="rounded-lg border border-navy-700 bg-navy-800 p-4 space-y-3">
            {/* Shell */}
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={tools.shell.enabled}
                onChange={(e) => updateToolsCustom({ ...tools, shell: { ...tools.shell, enabled: e.target.checked } })}
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
                      onChange={(v) => updateToolsCustom({ ...tools, shell: { ...tools.shell, allowed_binaries: v } })}
                      placeholder="Add binary (e.g. bash)..."
                      disabled={disabled}
                    />
                    <TagInput
                      label="Denied Patterns"
                      value={tools.shell.denied_patterns}
                      onChange={(v) => updateToolsCustom({ ...tools, shell: { ...tools.shell, denied_patterns: v } })}
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
                        onChange={(e) => updateToolsCustom({ ...tools, shell: { ...tools.shell, max_timeout: parseInt(e.target.value) || 0 } })}
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
                onChange={(e) => updateToolsCustom({ ...tools, filesystem: { ...tools.filesystem, enabled: e.target.checked } })}
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
                    onChange={(e) => updateToolsCustom({ ...tools, filesystem: { ...tools.filesystem, read_only: e.target.checked } })}
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
                      onChange={(v) => updateToolsCustom({ ...tools, filesystem: { ...tools.filesystem, allowed_paths: v } })}
                      validate={pathValidate}
                      placeholder="Add path (e.g. /workspace)..."
                      disabled={disabled}
                    />
                    <TagInput
                      label="Denied Paths"
                      value={tools.filesystem.denied_paths}
                      onChange={(v) => updateToolsCustom({ ...tools, filesystem: { ...tools.filesystem, denied_paths: v } })}
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
                onChange={(e) => updateToolsCustom({ ...tools, health: { ...tools.health, enabled: e.target.checked } })}
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
