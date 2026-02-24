'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

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
  }
  agentUuid?: string
  disabled?: boolean
}) {
  const router = useRouter()
  const isEdit = !!agentUuid
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const [agentId, setAgentId] = useState(initial?.agent_id || '')
  const [name, setName] = useState(initial?.name || '')
  const [description, setDescription] = useState(initial?.description || '')
  const [tools, setTools] = useState<ToolsConfig>(initial?.tools_config || defaultTools)
  const [cpus, setCpus] = useState(initial?.cpus || '1.0')
  const [memLimit, setMemLimit] = useState(initial?.mem_limit || '1g')
  const [pidsLimit, setPidsLimit] = useState(initial?.pids_limit || 200)
  const [soulMd, setSoulMd] = useState(initial?.soul_md || '')
  const [rulesMd, setRulesMd] = useState(initial?.rules_md || '')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError('')

    const body = {
      agent_id: agentId,
      name,
      description,
      tools_config: tools,
      cpus,
      mem_limit: memLimit,
      pids_limit: pidsLimit,
      soul_md: soulMd,
      rules_md: rulesMd,
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

      {/* Tools */}
      <fieldset disabled={disabled} className="space-y-4">
        <legend className="text-lg font-semibold text-white mb-4">Tools</legend>

        <div className="rounded-lg border border-navy-700 bg-navy-800 p-4 space-y-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={tools.shell.enabled}
              onChange={(e) => setTools({ ...tools, shell: { ...tools.shell, enabled: e.target.checked } })}
              className="rounded border-navy-600"
            />
            <span className="text-sm text-white">Shell access</span>
          </label>

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
            <label className="flex items-center gap-2 cursor-pointer ml-6">
              <input
                type="checkbox"
                checked={tools.filesystem.read_only}
                onChange={(e) => setTools({ ...tools, filesystem: { ...tools.filesystem, read_only: e.target.checked } })}
                className="rounded border-navy-600"
              />
              <span className="text-sm text-mountain-400">Read-only filesystem</span>
            </label>
          )}

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
          <label htmlFor="soul_md" className="block text-xs font-medium text-mountain-500 uppercase tracking-wide mb-1">
            SOUL.md
          </label>
          <textarea
            id="soul_md"
            value={soulMd}
            onChange={(e) => setSoulMd(e.target.value)}
            rows={6}
            placeholder="Agent personality and purpose..."
            className="w-full rounded-lg border border-navy-600 bg-navy-900 px-3 py-2 text-white text-sm font-mono placeholder:text-mountain-600 focus:border-brand-500 focus:outline-none disabled:opacity-50"
          />
        </div>

        <div>
          <label htmlFor="rules_md" className="block text-xs font-medium text-mountain-500 uppercase tracking-wide mb-1">
            RULES.md
          </label>
          <textarea
            id="rules_md"
            value={rulesMd}
            onChange={(e) => setRulesMd(e.target.value)}
            rows={6}
            placeholder="Agent operational constraints..."
            className="w-full rounded-lg border border-navy-600 bg-navy-900 px-3 py-2 text-white text-sm font-mono placeholder:text-mountain-600 focus:border-brand-500 focus:outline-none disabled:opacity-50"
          />
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
