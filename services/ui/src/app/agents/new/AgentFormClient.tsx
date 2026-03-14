'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'

interface SkillOption {
  id: string
  name: string
  description: string
  scope: string
  tools_config?: Record<string, unknown>
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

interface ContainerProfileOption {
  id: string
  name: string
  description: string
  docker_image: string
  default_cpus: string
  default_mem_limit: string
  default_pids_limit: number
  is_platform: boolean
}

interface PolicyOption {
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
    tools_config?: Record<string, unknown>
    cpus: string
    mem_limit: string
    pids_limit: number
    soul_md: string
    rules_md: string
    models?: string[]
    skills?: Array<{ id: string; name: string; scope: string }>
    container_profile_id?: string | null
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
  const [cpus, setCpus] = useState(initial?.cpus || '1.0')
  const [memLimit, setMemLimit] = useState(initial?.mem_limit || '1g')
  const [pidsLimit, setPidsLimit] = useState(initial?.pids_limit || 200)
  const [soulMd, setSoulMd] = useState(initial?.soul_md || '')
  const [rulesMd, setRulesMd] = useState(initial?.rules_md || '')
  const [availableModels, setAvailableModels] = useState<PolicyOption[]>([])
  const [selectedModels, setSelectedModels] = useState<string[]>(initial?.models || [])
  const [skills, setSkills] = useState<SkillOption[]>([])
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(
    new Set(initial?.skills?.map(s => s.id) || [])
  )
  const [containerProfiles, setContainerProfiles] = useState<ContainerProfileOption[]>([])
  const [selectedProfileId, setSelectedProfileId] = useState<string>(initial?.container_profile_id || '')
  const [soulPreview, setSoulPreview] = useState(false)
  const [rulesPreview, setRulesPreview] = useState(false)

  useEffect(() => {
    Promise.all([
      fetch('/api/model-policies').then((res) => (res.ok ? res.json() : [])),
      fetch('/api/user-models').then((res) => (res.ok ? res.json() : [])),
    ])
      .then(([policiesData, userModelsData]) => {
        const names = new Set<string>()
        for (const p of policiesData as Array<{ allowed_models?: string[] }>) {
          for (const n of p.allowed_models || []) names.add(n)
        }
        for (const m of userModelsData as Array<{ name?: string }>) {
          if (m.name) names.add(m.name)
        }
        setAvailableModels([...names].sort().map((name) => ({ name })))
      })
      .catch(() => {})
    fetch('/api/skills')
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setSkills(data))
      .catch(() => {})
    fetch('/api/container-profiles')
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setContainerProfiles(data))
      .catch(() => {})
  }, [])

  const handleProfileChange = (profileId: string) => {
    setSelectedProfileId(profileId)
    const profile = containerProfiles.find(p => p.id === profileId)
    if (profile) {
      setCpus(profile.default_cpus)
      setMemLimit(profile.default_mem_limit)
      setPidsLimit(profile.default_pids_limit)
    }
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
    if (selectedSkillIds.size === 0) {
      setValidationError('Please select at least one skill')
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
      cpus,
      mem_limit: memLimit,
      pids_limit: pidsLimit,
      soul_md: soulMd,
      rules_md: rulesMd,
      model_names: selectedModels,
      skill_ids: [...selectedSkillIds],
    }
    if (selectedProfileId) {
      body.container_profile_id = selectedProfileId
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

      {/* Skills */}
      <fieldset disabled={disabled} className="space-y-4">
        <legend className="text-lg font-semibold text-white mb-4">Tools</legend>
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-4 space-y-3">
          <p className="text-xs text-mountain-400 mb-2">
            Select one or more skills. Runtime access is derived from skill dependencies and RBAC scope.
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
                {selectedSkillIds.size} skill{selectedSkillIds.size !== 1 ? 's' : ''} selected.
              </p>
            </div>
          )}
        </div>
      </fieldset>

      {/* Container Profile */}
      <fieldset disabled={disabled} className="space-y-4">
        <legend className="text-lg font-semibold text-white mb-4">Container Profile</legend>
        <div>
          <label htmlFor="container_profile" className="block text-xs font-medium text-mountain-500 uppercase tracking-wide mb-1">
            Runtime Profile
          </label>
          <select
            id="container_profile"
            value={selectedProfileId}
            onChange={(e) => handleProfileChange(e.target.value)}
            className="w-full rounded-lg border border-navy-600 bg-navy-900 px-3 py-2 text-white text-sm focus:border-brand-500 focus:outline-none disabled:opacity-50"
          >
            <option value="">None (default image)</option>
            {containerProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}{p.is_platform ? ' (platform)' : ''} — {p.docker_image}
              </option>
            ))}
          </select>
          <p className="text-xs text-mountain-500 mt-1">
            Determines the Docker image and default resource limits for this agent.
          </p>
        </div>
      </fieldset>

      {/* Models */}
      <fieldset disabled={disabled} className="space-y-4">
        <legend className="text-lg font-semibold text-white mb-4">Models</legend>

        <div>
          <label className="block text-xs font-medium text-mountain-500 uppercase tracking-wide mb-1">
            Assign Models
          </label>
          <div className="max-h-48 overflow-y-auto rounded-lg border border-navy-700 bg-navy-800 p-3 space-y-2">
            {availableModels.length === 0 ? (
              <p className="text-xs text-mountain-500">No models available yet</p>
            ) : (
              availableModels.map((m) => (
                <label key={m.name} className="flex items-center gap-2 text-sm text-white cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedModels.includes(m.name)}
                    onChange={() => {
                      setSelectedModels((prev) => (
                        prev.includes(m.name)
                          ? prev.filter((v) => v !== m.name)
                          : [...prev, m.name]
                      ))
                    }}
                    className="rounded border-navy-600"
                  />
                  {m.name}
                </label>
              ))
            )}
          </div>
          <p className="text-xs text-mountain-500 mt-1">
            Select one or more models this agent can access.
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
