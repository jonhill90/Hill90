'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { Session } from 'next-auth'
import EventTimeline from './EventTimeline'

interface Agent {
  id: string
  agent_id: string
  name: string
  description: string
  status: string
  cpus: string
  mem_limit: string
  pids_limit: number
  tools_config: Record<string, any>
  soul_md: string
  rules_md: string
  container_id: string | null
  model_policy_id: string | null
  skills: Array<{ id: string; name: string; scope: string; tools?: Array<{ id: string; name: string }>; instructions_md?: string }>
  error_message: string | null
  created_at: string
  updated_at: string
  created_by: string
}

interface ModelPolicy {
  id: string
  name: string
  allowed_models: string[]
  max_requests_per_minute: number | null
  max_tokens_per_day: number | null
  created_by: string | null
}

interface SkillRecord {
  id: string
  name: string
  scope: string
  tools?: Array<{ id: string; name: string }>
  instructions_md?: string
}

interface ToolInstallStatus {
  tool_id: string
  tool_name: string
  tool_description: string
  status: 'pending' | 'installed' | 'failed'
  install_message: string
  installed_at: string | null
  updated_at: string
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

type TabId = 'overview' | 'configuration' | 'model-access' | 'knowledge' | 'activity'

export default function AgentDetailClient({
  agentId,
  session,
}: {
  agentId: string
  session: Session
}) {
  const router = useRouter()
  const [agent, setAgent] = useState<Agent | null>(null)
  const [policies, setPolicies] = useState<ModelPolicy[]>([])
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<TabId>('overview')

  // Lazy-loaded data
  const [usage, setUsage] = useState<any>(null)
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageFetched, setUsageFetched] = useState(false)
  const [knowledge, setKnowledge] = useState<any[]>([])
  const [knowledgeLoading, setKnowledgeLoading] = useState(false)
  const [knowledgeFetched, setKnowledgeFetched] = useState(false)

  // Logs
  const [logs, setLogs] = useState('')
  const [showLogs, setShowLogs] = useState(false)
  const logsEndRef = useRef<HTMLDivElement>(null)
  const eventSourceRef = useRef<EventSource | null>(null)

  // Skills
  const [allSkills, setAllSkills] = useState<SkillRecord[]>([])
  const [showAssignPicker, setShowAssignPicker] = useState(false)
  const [expandedSkillInstructions, setExpandedSkillInstructions] = useState<Set<string>>(new Set())
  const [toolInstalls, setToolInstalls] = useState<ToolInstallStatus[]>([])
  const [toolInstallsLoading, setToolInstallsLoading] = useState(false)

  // Activity sub-view state
  const [activityView, setActivityView] = useState<'events' | 'logs'>('events')

  const isAdmin = session.user?.roles?.includes('admin')

  const fetchAgent = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${agentId}`)
      if (res.ok) {
        setAgent(await res.json())
      } else if (res.status === 404) {
        router.push('/agents')
      }
    } catch (err) {
      console.error('Failed to fetch agent:', err)
    } finally {
      setLoading(false)
    }
  }, [agentId, router])

  const fetchPolicies = useCallback(async () => {
    try {
      const res = await fetch('/api/model-policies')
      if (res.ok) {
        setPolicies(await res.json())
      }
    } catch (err) {
      console.error('Failed to fetch policies:', err)
    }
  }, [])

  const fetchAllSkills = useCallback(async () => {
    try {
      const res = await fetch('/api/skills')
      if (res.ok) {
        setAllSkills(await res.json())
      }
    } catch (err) {
      console.error('Failed to fetch skills:', err)
    }
  }, [])

  const fetchToolInstalls = useCallback(async () => {
    setToolInstallsLoading(true)
    try {
      const res = await fetch(`/api/agents/${agentId}/tool-installs`)
      if (res.ok) {
        setToolInstalls(await res.json())
      }
    } catch (err) {
      console.error('Failed to fetch tool installs:', err)
    } finally {
      setToolInstallsLoading(false)
    }
  }, [agentId])

  useEffect(() => {
    fetchAgent()
    fetchPolicies()
    fetchAllSkills()
    fetchToolInstalls()
  }, [fetchAgent, fetchPolicies, fetchAllSkills, fetchToolInstalls])

  // Poll status while running
  useEffect(() => {
    if (agent?.status !== 'running') return
    const interval = setInterval(fetchAgent, 10000)
    return () => clearInterval(interval)
  }, [agent?.status, fetchAgent])

  // Lazy-load usage when Model Access tab selected
  useEffect(() => {
    if (activeTab !== 'model-access' || usageFetched || !agent) return
    setUsageLoading(true)
    fetch(`/api/usage?agent_id=${agent.agent_id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setUsage(data) })
      .catch(() => {})
      .finally(() => { setUsageLoading(false); setUsageFetched(true) })
  }, [activeTab, usageFetched, agent])

  // Lazy-load knowledge when Knowledge tab selected
  useEffect(() => {
    if (activeTab !== 'knowledge' || knowledgeFetched || !agent) return
    setKnowledgeLoading(true)
    fetch(`/api/knowledge/entries?agent_id=${agent.agent_id}`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setKnowledge(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => { setKnowledgeLoading(false); setKnowledgeFetched(true) })
  }, [activeTab, knowledgeFetched, agent])

  // SSE log streaming
  useEffect(() => {
    if (!showLogs || !isAdmin || agent?.status !== 'running') {
      eventSourceRef.current?.close()
      eventSourceRef.current = null
      return
    }

    const es = new EventSource(`/api/agents/${agentId}/logs?follow=true&tail=100`)
    eventSourceRef.current = es

    es.onmessage = (event) => {
      setLogs((prev) => prev + event.data + '\n')
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }

    es.addEventListener('end', () => { es.close() })
    es.addEventListener('error', () => { es.close() })

    return () => { es.close() }
  }, [showLogs, isAdmin, agent?.status, agentId])

  const handleAction = async (action: 'start' | 'stop') => {
    setActionLoading(true)
    try {
      const res = await fetch(`/api/agents/${agentId}/${action}`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json()
        alert(data.error || `Failed to ${action} agent`)
      }
      await fetchAgent()
      await fetchToolInstalls()
    } catch (err) {
      console.error(`Failed to ${action}:`, err)
    } finally {
      setActionLoading(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm(`Delete agent "${agent?.name}"? This cannot be undone.`)) return
    setActionLoading(true)
    try {
      const res = await fetch(`/api/agents/${agentId}`, { method: 'DELETE' })
      if (res.ok) {
        router.push('/agents')
      } else {
        const data = await res.json()
        alert(data.error || 'Failed to delete agent')
      }
    } catch (err) {
      console.error('Failed to delete:', err)
    } finally {
      setActionLoading(false)
    }
  }

  const fetchLogs = async () => {
    try {
      const res = await fetch(`/api/agents/${agentId}/logs?tail=200`)
      if (res.ok) {
        const data = await res.json()
        setLogs(data.logs || '')
      }
    } catch (err) {
      console.error('Failed to fetch logs:', err)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="h-8 w-8 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
      </div>
    )
  }

  if (!agent) return null

  const currentPolicy = policies.find((p) => p.id === agent.model_policy_id)
  const agentSkills = agent.skills || []
  const tc = agent.tools_config || {}

  const handleAssignSkill = async (skillId: string) => {
    try {
      const res = await fetch(`/api/agents/${agentId}/skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skill_id: skillId }),
      })
      if (!res.ok) {
        const data = await res.json()
        alert(data.error || 'Failed to assign skill')
        return
      }
      setShowAssignPicker(false)
      await fetchAgent()
      await fetchToolInstalls()
    } catch (err) {
      console.error('Failed to assign skill:', err)
    }
  }

  const handleRemoveSkill = async (skillId: string) => {
    if (!confirm('Remove this skill from the agent?')) return
    try {
      const res = await fetch(`/api/agents/${agentId}/skills/${skillId}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const data = await res.json()
        alert(data.error || 'Failed to remove skill')
        return
      }
      await fetchAgent()
      await fetchToolInstalls()
    } catch (err) {
      console.error('Failed to remove skill:', err)
    }
  }

  const toggleSkillInstructions = (skillId: string) => {
    setExpandedSkillInstructions(prev => {
      const next = new Set(prev)
      if (next.has(skillId)) next.delete(skillId)
      else next.add(skillId)
      return next
    })
  }

  // For assign picker: admins see all skills, non-admins see only container_local
  // Exclude already-assigned skills (additive semantics)
  const assignedIds = new Set(agentSkills.map(s => s.id))
  const assignableSkills = (isAdmin
    ? allSkills
    : allSkills.filter(s => !ELEVATED_SCOPES.includes(s.scope))
  ).filter(s => !assignedIds.has(s.id))

  const tabs: { id: TabId; label: string; adminOnly?: boolean }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'configuration', label: 'Configuration' },
    { id: 'model-access', label: 'Model Access' },
    { id: 'knowledge', label: 'Knowledge' },
    { id: 'activity', label: 'Activity' },
  ]

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">{agent.name}</h1>
          <p className="text-sm text-mountain-400 mt-1 font-mono">{agent.agent_id}</p>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && agent.status !== 'running' && (
            <button
              onClick={() => handleAction('start')}
              disabled={actionLoading}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
            >
              {actionLoading ? 'Starting...' : 'Start'}
            </button>
          )}
          {isAdmin && agent.status === 'running' && (
            <button
              onClick={() => handleAction('stop')}
              disabled={actionLoading}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-red-600 hover:bg-red-500 text-white transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
            >
              {actionLoading ? 'Stopping...' : 'Stop'}
            </button>
          )}
          {agent.status !== 'running' && (
            <Link
              href={`/agents/${agent.id}/edit`}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-navy-600 text-mountain-400 hover:text-white hover:border-navy-500 transition-colors"
            >
              Edit
            </Link>
          )}
          {isAdmin && (
            <button
              onClick={handleDelete}
              disabled={actionLoading}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-red-700 text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {/* Tab Bar */}
      <div className="flex gap-1 border-b border-navy-700 mb-6">
        {tabs
          .filter((t) => !t.adminOnly || isAdmin)
          .map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                activeTab === t.id
                  ? 'text-brand-400 border-brand-500'
                  : 'text-mountain-400 border-transparent hover:text-white hover:border-navy-500'
              }`}
            >
              {t.label}
            </button>
          ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Status Card */}
          <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
            <h2 className="text-lg font-semibold text-white mb-3">Status</h2>
            <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
              <div>
                <dt className="text-mountain-400">State</dt>
                <dd className="text-white mt-1 flex items-center gap-2">
                  <StatusDot status={agent.status} />
                  {agent.status}
                </dd>
              </div>
              <div>
                <dt className="text-mountain-400">Container</dt>
                <dd className="text-white mt-1 font-mono text-xs">
                  {agent.container_id ? agent.container_id.substring(0, 12) : '--'}
                </dd>
              </div>
              <div>
                <dt className="text-mountain-400">Last Updated</dt>
                <dd className="text-white mt-1">{new Date(agent.updated_at).toLocaleString()}</dd>
              </div>
            </dl>
            {agent.error_message && (
              <div className="mt-3 rounded-md border border-red-700 bg-red-900/30 p-3 text-sm text-red-400">
                {agent.error_message}
              </div>
            )}
          </div>

          {/* Description */}
          {agent.description && (
            <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
              <h2 className="text-lg font-semibold text-white mb-2">Description</h2>
              <p className="text-sm text-mountain-300">{agent.description}</p>
            </div>
          )}

          {/* Skills Card */}
          <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-white">Skills</h2>
              {agent.status !== 'running' && (
                <button
                  onClick={() => setShowAssignPicker(!showAssignPicker)}
                  className="px-3 py-1.5 text-xs font-medium rounded-md bg-brand-600 hover:bg-brand-500 text-white transition-colors cursor-pointer"
                >
                  Assign Skill
                </button>
              )}
            </div>

            {/* Assign picker */}
            {showAssignPicker && (
              <div className="mb-4 rounded-md border border-navy-600 bg-navy-900 p-3">
                <p className="text-xs text-mountain-400 mb-2">Select a skill to assign:</p>
                <div className="space-y-1">
                  {assignableSkills.map(s => (
                    <button
                      key={s.id}
                      onClick={() => handleAssignSkill(s.id)}
                      className="w-full text-left px-3 py-2 text-sm rounded-md hover:bg-navy-800 text-white transition-colors flex items-center gap-2 cursor-pointer"
                    >
                      <span>{s.name}</span>
                      <span className={`px-1.5 py-0.5 text-xs rounded-md ${scopeBadge(s.scope).colorClasses}`}>
                        {scopeBadge(s.scope).label}
                      </span>
                    </button>
                  ))}
                  {assignableSkills.length === 0 && (
                    <p className="text-xs text-mountain-500 py-2">No skills available</p>
                  )}
                </div>
              </div>
            )}

            {agentSkills.length > 0 ? (
              <div className="space-y-3">
                {agentSkills.map(skill => {
                  const badge = scopeBadge(skill.scope)
                  const canRemove = isAdmin || !ELEVATED_SCOPES.includes(skill.scope)
                  const instructionsExpanded = expandedSkillInstructions.has(skill.id)
                  return (
                    <div key={skill.id} className="rounded-md border border-navy-700 bg-navy-900 p-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-white">{skill.name}</span>
                          <span className={`px-1.5 py-0.5 text-xs rounded-md ${badge.colorClasses}`}>
                            {badge.label}
                          </span>
                          {skill.tools && skill.tools.length > 0 && (
                            <span className="px-1.5 py-0.5 text-xs rounded-md bg-navy-800 text-mountain-300 border border-navy-600 font-mono">
                              Tools: {skill.tools.map(t => t.name).join(', ')}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {skill.instructions_md && (
                            <button
                              onClick={() => toggleSkillInstructions(skill.id)}
                              className="text-xs text-brand-400 hover:text-brand-300 transition-colors cursor-pointer"
                            >
                              {instructionsExpanded ? 'Hide Instructions' : 'Show Instructions'}
                            </button>
                          )}
                          {canRemove && agent.status !== 'running' && (
                            <button
                              onClick={() => handleRemoveSkill(skill.id)}
                              className="px-2 py-1 text-xs font-medium rounded-md border border-red-700 text-red-400 hover:bg-red-900/30 transition-colors cursor-pointer"
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      </div>
                      {instructionsExpanded && skill.instructions_md && (
                        <pre className="mt-2 text-sm text-mountain-300 whitespace-pre-wrap bg-navy-800 rounded-md p-3 max-h-64 overflow-y-auto">
                          {skill.instructions_md}
                        </pre>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="text-sm text-mountain-500">No skills assigned</p>
            )}
          </div>

          {/* Tool Install Status */}
          <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
            <h2 className="text-lg font-semibold text-white mb-3">Tool Install Status</h2>
            {toolInstallsLoading ? (
              <p className="text-sm text-mountain-400">Loading…</p>
            ) : toolInstalls.length === 0 ? (
              <p className="text-sm text-mountain-500">No tool installs recorded for this agent yet.</p>
            ) : (
              <div className="space-y-2">
                {toolInstalls.map((row) => (
                  <div key={row.tool_id} className="rounded-md border border-navy-700 bg-navy-900 px-3 py-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-white">{row.tool_name}</span>
                      <span className={`px-2 py-0.5 text-xs rounded-md border ${
                        row.status === 'installed'
                          ? 'bg-brand-900/50 text-brand-400 border-brand-700'
                          : row.status === 'failed'
                            ? 'bg-red-900/40 text-red-400 border-red-700'
                            : 'bg-amber-900/40 text-amber-400 border-amber-700'
                      }`}>
                        {row.status}
                      </span>
                    </div>
                    {row.install_message && (
                      <p className="text-xs text-mountain-500 mt-1">{row.install_message}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Quick Tool Summary */}
          <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
            <h2 className="text-lg font-semibold text-white mb-3">Tool Access</h2>
            <div className="flex flex-wrap gap-2">
              <ToolBadge label="Shell" enabled={tc.shell?.enabled} summary={tc.shell?.enabled ? `${tc.shell.allowed_binaries?.length || 0} binaries` : undefined} />
              <ToolBadge label="Filesystem" enabled={tc.filesystem?.enabled} summary={tc.filesystem?.enabled ? (tc.filesystem.read_only ? 'Read-only' : 'Read-write') : undefined} />
              <ToolBadge label="Health" enabled={tc.health?.enabled} />
            </div>
          </div>

          {/* Resource Grid */}
          <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
            <h2 className="text-lg font-semibold text-white mb-3">Resources</h2>
            <dl className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <dt className="text-mountain-400">CPUs</dt>
                <dd className="text-white mt-1">{agent.cpus}</dd>
              </div>
              <div>
                <dt className="text-mountain-400">Memory</dt>
                <dd className="text-white mt-1">{agent.mem_limit}</dd>
              </div>
              <div>
                <dt className="text-mountain-400">PID Limit</dt>
                <dd className="text-white mt-1">{agent.pids_limit}</dd>
              </div>
            </dl>
          </div>

          {/* Policy Summary */}
          {currentPolicy && (
            <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
              <h2 className="text-lg font-semibold text-white mb-2">Model Policy</h2>
              <p className="text-sm text-mountain-300">
                {currentPolicy.name} — {currentPolicy.allowed_models.length} model{currentPolicy.allowed_models.length !== 1 ? 's' : ''}
                {currentPolicy.max_requests_per_minute ? `, ${currentPolicy.max_requests_per_minute} req/min` : ''}
              </p>
            </div>
          )}

          {/* Meta */}
          <div className="text-xs text-mountain-500">
            Created {new Date(agent.created_at).toLocaleString()} by {agent.created_by}
          </div>
        </div>
      )}

      {activeTab === 'configuration' && (
        <div className="space-y-6">
          {/* Tool Details */}
          <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-white">Tool Configuration</h2>
              {agent.status !== 'running' && (
                <Link
                  href={`/agents/${agent.id}/edit`}
                  className="text-sm text-brand-400 hover:text-brand-300 transition-colors"
                >
                  Edit
                </Link>
              )}
            </div>

            <div className="space-y-4">
              {/* Shell */}
              <ConfigSection title="Shell" enabled={tc.shell?.enabled}>
                {tc.shell?.enabled && (
                  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                    <div>
                      <dt className="text-mountain-400 mb-1">Allowed Binaries</dt>
                      <dd className="flex flex-wrap gap-1">
                        {(tc.shell.allowed_binaries || []).length > 0
                          ? tc.shell.allowed_binaries.map((b: string) => <Badge key={b}>{b}</Badge>)
                          : <span className="text-mountain-500 text-xs">All allowed</span>}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-mountain-400 mb-1">Max Timeout</dt>
                      <dd className="text-white">{tc.shell.max_timeout || 300}s</dd>
                    </div>
                  </dl>
                )}
              </ConfigSection>

              {/* Filesystem */}
              <ConfigSection title="Filesystem" enabled={tc.filesystem?.enabled}>
                {tc.filesystem?.enabled && (
                  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                    <div>
                      <dt className="text-mountain-400 mb-1">Mode</dt>
                      <dd className="text-white">{tc.filesystem.read_only ? 'Read-only' : 'Read-write'}</dd>
                    </div>
                    <div>
                      <dt className="text-mountain-400 mb-1">Allowed Paths</dt>
                      <dd className="flex flex-wrap gap-1">
                        {(tc.filesystem.allowed_paths || []).map((p: string) => <Badge key={p}>{p}</Badge>)}
                      </dd>
                    </div>
                  </dl>
                )}
              </ConfigSection>

              {/* Health */}
              <ConfigSection title="Health" enabled={tc.health?.enabled} />
            </div>
          </div>

          {/* Resources */}
          <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
            <h2 className="text-lg font-semibold text-white mb-3">Resources</h2>
            <dl className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <dt className="text-mountain-400">CPUs</dt>
                <dd className="text-white mt-1">{agent.cpus}</dd>
              </div>
              <div>
                <dt className="text-mountain-400">Memory</dt>
                <dd className="text-white mt-1">{agent.mem_limit}</dd>
              </div>
              <div>
                <dt className="text-mountain-400">PID Limit</dt>
                <dd className="text-white mt-1">{agent.pids_limit}</dd>
              </div>
            </dl>
          </div>

          {/* Identity */}
          {(agent.soul_md || agent.rules_md) && (
            <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
              <h2 className="text-lg font-semibold text-white mb-3">Identity</h2>
              {agent.soul_md && (
                <div className="mb-4">
                  <h3 className="text-sm font-medium text-mountain-400 mb-2">SOUL.md</h3>
                  <pre className="text-xs text-mountain-300 whitespace-pre-wrap bg-navy-900 rounded-md p-3 max-h-48 overflow-y-auto">
                    {agent.soul_md}
                  </pre>
                </div>
              )}
              {agent.rules_md && (
                <div>
                  <h3 className="text-sm font-medium text-mountain-400 mb-2">RULES.md</h3>
                  <pre className="text-xs text-mountain-300 whitespace-pre-wrap bg-navy-900 rounded-md p-3 max-h-48 overflow-y-auto">
                    {agent.rules_md}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {activeTab === 'model-access' && (
        <div className="space-y-6">
          {/* Policy Detail */}
          <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
            <h2 className="text-lg font-semibold text-white mb-3">Model Policy</h2>
            {currentPolicy ? (
              <div className="space-y-3">
                <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
                  <div>
                    <dt className="text-mountain-400">Policy</dt>
                    <dd className="text-white mt-1">{currentPolicy.name}</dd>
                  </div>
                  <div>
                    <dt className="text-mountain-400">Rate Limit</dt>
                    <dd className="text-white mt-1">
                      {currentPolicy.max_requests_per_minute
                        ? `${currentPolicy.max_requests_per_minute} req/min`
                        : 'Unlimited'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-mountain-400">Token Budget</dt>
                    <dd className="text-white mt-1">
                      {currentPolicy.max_tokens_per_day
                        ? `${Number(currentPolicy.max_tokens_per_day).toLocaleString()} tokens/day`
                        : 'Unlimited'}
                    </dd>
                  </div>
                </dl>
                <div>
                  <dt className="text-mountain-400 text-sm">Allowed Models</dt>
                  <dd className="mt-1 flex flex-wrap gap-1">
                    {currentPolicy.allowed_models.map((m) => (
                      <span
                        key={m}
                        className="px-2 py-0.5 text-xs rounded-md bg-brand-900/50 text-brand-400 border border-brand-700"
                      >
                        {m}
                      </span>
                    ))}
                  </dd>
                </div>
              </div>
            ) : (
              <p className="text-sm text-mountain-500">No model policy assigned</p>
            )}
          </div>

          {/* Usage Summary */}
          <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-white">Usage (7-day)</h2>
              <Link
                href={`/harness/usage?agent_id=${agent.agent_id}`}
                className="text-sm text-brand-400 hover:text-brand-300 transition-colors"
              >
                View full usage in Harness
              </Link>
            </div>
            {usageLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
              </div>
            ) : usage ? (
              <dl className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <dt className="text-mountain-400">Requests</dt>
                  <dd className="text-white mt-1 text-lg font-semibold">
                    {Number(usage.total_requests || 0).toLocaleString()}
                  </dd>
                </div>
                <div>
                  <dt className="text-mountain-400">Tokens</dt>
                  <dd className="text-white mt-1 text-lg font-semibold">
                    {Number(usage.total_tokens || 0).toLocaleString()}
                  </dd>
                </div>
                <div>
                  <dt className="text-mountain-400">Cost</dt>
                  <dd className="text-white mt-1 text-lg font-semibold">
                    ${Number(usage.total_cost_usd || 0).toFixed(2)}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="text-sm text-mountain-500">No usage data available</p>
            )}
          </div>
        </div>
      )}

      {activeTab === 'knowledge' && (
        <div className="space-y-6">
          <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-white">Knowledge Entries</h2>
              <Link
                href="/harness/knowledge"
                className="text-sm text-brand-400 hover:text-brand-300 transition-colors"
              >
                Browse in Harness
              </Link>
            </div>
            {knowledgeLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
              </div>
            ) : knowledge.length > 0 ? (
              <div className="space-y-2">
                <p className="text-sm text-mountain-400 mb-3">{knowledge.length} entries</p>
                {knowledge.slice(0, 10).map((entry: any) => (
                  <div key={entry.id} className="rounded-md border border-navy-700 bg-navy-900 p-3">
                    <pre className="text-xs text-mountain-300 whitespace-pre-wrap line-clamp-3">
                      {entry.content}
                    </pre>
                    <p className="text-xs text-mountain-500 mt-1">
                      {new Date(entry.created_at).toLocaleString()}
                    </p>
                  </div>
                ))}
                {knowledge.length > 10 && (
                  <p className="text-xs text-mountain-500">
                    Showing 10 of {knowledge.length} entries.{' '}
                    <Link href="/harness/knowledge" className="text-brand-400 hover:text-brand-300">
                      View all
                    </Link>
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-mountain-500">No knowledge entries</p>
            )}
          </div>
        </div>
      )}

      {activeTab === 'activity' && (
        <div className="space-y-4">
          {/* Sub-view toggle */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setActivityView('events')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                activityView === 'events'
                  ? 'bg-brand-600 text-white'
                  : 'text-mountain-400 hover:text-white hover:bg-navy-700'
              }`}
            >
              Events
            </button>
            {isAdmin && (
              <button
                onClick={() => setActivityView('logs')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  activityView === 'logs'
                    ? 'bg-brand-600 text-white'
                    : 'text-mountain-400 hover:text-white hover:bg-navy-700'
                }`}
                data-testid="raw-logs-toggle"
              >
                Raw Logs
              </button>
            )}
          </div>

          {activityView === 'events' && (
            <EventTimeline agentId={agentId} agentStatus={agent.status} />
          )}

          {activityView === 'logs' && isAdmin && (
            <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold text-white">Logs</h2>
                <div className="flex items-center gap-2">
                  {agent.status === 'running' && (
                    <button
                      onClick={() => setShowLogs(!showLogs)}
                      className="px-3 py-1.5 text-xs font-medium rounded-md border border-navy-600 text-mountain-400 hover:text-white hover:border-navy-500 transition-colors cursor-pointer"
                    >
                      {showLogs ? 'Stop Streaming' : 'Stream Live'}
                    </button>
                  )}
                  <button
                    onClick={fetchLogs}
                    className="px-3 py-1.5 text-xs font-medium rounded-md border border-navy-600 text-mountain-400 hover:text-white hover:border-navy-500 transition-colors cursor-pointer"
                  >
                    Fetch Logs
                  </button>
                </div>
              </div>
              <div className="bg-navy-900 rounded-md p-3 h-64 overflow-y-auto font-mono text-xs text-mountain-300">
                {logs ? (
                  <>
                    <pre className="whitespace-pre-wrap">{logs}</pre>
                    <div ref={logsEndRef} />
                  </>
                ) : (
                  <p className="text-mountain-500">No logs available</p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  )
}

function StatusDot({ status }: { status: string }) {
  const color = status === 'running' ? 'bg-brand-500'
    : status === 'error' ? 'bg-red-500'
    : 'bg-mountain-500'
  return <span className={`h-2 w-2 rounded-full ${color} inline-block`} />
}

function ToolBadge({ label, enabled, summary }: { label: string; enabled?: boolean; summary?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md ${
      enabled
        ? 'bg-brand-900/50 text-brand-400 border border-brand-700'
        : 'bg-navy-900 text-mountain-500 border border-navy-700'
    }`}>
      {label}
      {summary && <span className="text-mountain-400">({summary})</span>}
    </span>
  )
}

function ConfigSection({ title, enabled, children }: { title: string; enabled?: boolean; children?: React.ReactNode }) {
  return (
    <div className="rounded-md border border-navy-700 bg-navy-900 p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className={`h-2 w-2 rounded-full ${enabled ? 'bg-brand-500' : 'bg-mountain-600'}`} />
        <h3 className="text-sm font-medium text-white">{title}</h3>
        <span className={`text-xs ${enabled ? 'text-brand-400' : 'text-mountain-500'}`}>
          {enabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>
      {children}
    </div>
  )
}

function Badge({ children, variant }: { children: React.ReactNode; variant?: 'red' }) {
  const cls = variant === 'red'
    ? 'bg-red-900/30 text-red-400 border border-red-800'
    : 'bg-navy-800 text-mountain-300 border border-navy-600'
  return <span className={`px-2 py-0.5 text-xs rounded-md ${cls}`}>{children}</span>
}
