'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { Session } from 'next-auth'
import EventTimeline from './EventTimeline'
import ActivityTimeline from './ActivityTimeline'
import AgentMemory from './AgentMemory'
import AgentNotebook from './AgentNotebook'
import AgentProgression from './AgentProgression'
import WorkspaceBrowser from './WorkspaceBrowser'
import AgentKnowledge from './AgentKnowledge'
import AgentAvatar from '@/components/AgentAvatar'

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
  models: string[]
  skills: Array<{ id: string; name: string; scope: string; tools?: Array<{ id: string; name: string }>; instructions_md?: string }>
  autonomy_level: string | null
  error_message: string | null
  created_at: string
  updated_at: string
  created_by: string
}

const AUTONOMY_LEVELS = [
  { value: 'ask', label: 'Ask before acting', description: 'Agent requests approval before taking any action' },
  { value: 'scoped', label: 'Act within scope', description: 'Agent acts freely within assigned skills and permissions' },
  { value: 'full', label: 'Full autonomy', description: 'Agent can take any action without approval' },
] as const

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
  status: 'pending' | 'installing' | 'installed' | 'failed'
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

function formatUptime(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime()
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

const STATUS_BADGE: Record<string, { dot: string; bg: string; text: string }> = {
  running: { dot: 'bg-brand-500', bg: 'bg-brand-900/50 border-brand-700', text: 'text-brand-400' },
  error: { dot: 'bg-red-500', bg: 'bg-red-900/50 border-red-700', text: 'text-red-400' },
  stopped: { dot: 'bg-mountain-500', bg: 'bg-navy-800/50 border-navy-700', text: 'text-mountain-400' },
}

type TabId = 'overview' | 'configuration' | 'model-access' | 'memory' | 'notebook' | 'workspace' | 'knowledge' | 'activity'

export default function AgentDetailClient({
  agentId,
  session,
}: {
  agentId: string
  session: Session
}) {
  const router = useRouter()
  const [agent, setAgent] = useState<Agent | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<TabId>('overview')

  // Lazy-loaded data
  const [usage, setUsage] = useState<any>(null)
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageFetched, setUsageFetched] = useState(false)

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
  const [activityView, setActivityView] = useState<'timeline' | 'events' | 'logs'>('timeline')

  // Model policy name
  const [policyName, setPolicyName] = useState<string | null>(null)

  // Editable identity (SOUL.md / RULES.md)
  const [editingSoul, setEditingSoul] = useState(false)
  const [editingRules, setEditingRules] = useState(false)
  const [soulDraft, setSoulDraft] = useState('')
  const [rulesDraft, setRulesDraft] = useState('')
  const [identitySaving, setIdentitySaving] = useState(false)
  const [autonomySaving, setAutonomySaving] = useState(false)

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
    fetchAllSkills()
    fetchToolInstalls()
  }, [fetchAgent, fetchAllSkills, fetchToolInstalls])

  // Poll status while running
  useEffect(() => {
    if (agent?.status !== 'running') return
    const interval = setInterval(fetchAgent, 10000)
    return () => clearInterval(interval)
  }, [agent?.status, fetchAgent])

  // Fetch model policy name
  useEffect(() => {
    if (!agent?.model_policy_id) return
    fetch(`/api/model-policies/${agent.model_policy_id}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data?.name) setPolicyName(data.name) })
      .catch(() => {})
  }, [agent?.model_policy_id])

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

  const handleReconcileTools = async () => {
    setActionLoading(true)
    try {
      const res = await fetch(`/api/agents/${agentId}/reconcile-tools`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json()
        alert(data.error || 'Failed to reconcile tools')
      }
      await fetchToolInstalls()
    } catch (err) {
      console.error('Failed to reconcile tools:', err)
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

  const modelNames = agent.models || []
  const agentSkills = agent.skills || []

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

  const handleSaveIdentity = async (field: 'soul_md' | 'rules_md', value: string) => {
    setIdentitySaving(true)
    try {
      const res = await fetch(`/api/agents/${agentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      })
      if (!res.ok) {
        const data = await res.json()
        alert(data.error || `Failed to save ${field}`)
        return
      }
      await fetchAgent()
      if (field === 'soul_md') setEditingSoul(false)
      if (field === 'rules_md') setEditingRules(false)
    } catch (err) {
      console.error(`Failed to save ${field}:`, err)
      alert(`Failed to save ${field}`)
    } finally {
      setIdentitySaving(false)
    }
  }

  // For assign picker: admins see all skills, non-admins see only container_local
  // Exclude already-assigned skills (additive semantics)
  const assignedIds = new Set(agentSkills.map(s => s.id))
  const assignableSkills = (isAdmin
    ? allSkills
    : allSkills.filter(s => !ELEVATED_SCOPES.includes(s.scope))
  ).filter(s => !assignedIds.has(s.id))

  const handleAutonomyChange = async (level: string) => {
    setAutonomySaving(true)
    try {
      const res = await fetch(`/api/agents/${agentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autonomy_level: level }),
      })
      if (!res.ok) {
        const data = await res.json()
        alert(data.error || 'Failed to save autonomy level')
        return
      }
      await fetchAgent()
    } catch {
      alert('Failed to save autonomy level')
    } finally {
      setAutonomySaving(false)
    }
  }

  const tabs: { id: TabId; label: string; adminOnly?: boolean }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'configuration', label: 'Configuration' },
    { id: 'model-access', label: 'Model Access' },
    { id: 'memory', label: 'Memory' },
    { id: 'notebook', label: 'Notebook' },
    { id: 'workspace', label: 'Workspace' },
    { id: 'knowledge', label: 'Knowledge' },
    { id: 'activity', label: 'Activity' },
  ]

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <AgentAvatar name={agent.name} size="xl" />
          <div>
            <h1 className="text-2xl font-bold">{agent.name}</h1>
            <p className="text-sm text-mountain-400 mt-1 font-mono">{agent.agent_id}</p>
          </div>
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
                <dd className="mt-1">
                  {(() => {
                    const badge = STATUS_BADGE[agent.status] || STATUS_BADGE.stopped
                    return (
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border ${badge.bg} ${badge.text}`}>
                        <span className={`h-2 w-2 rounded-full ${badge.dot} ${agent.status === 'running' ? 'animate-pulse' : ''}`} />
                        {agent.status}
                      </span>
                    )
                  })()}
                </dd>
              </div>
              <div>
                <dt className="text-mountain-400">Container</dt>
                <dd className="text-white mt-1 font-mono text-xs">
                  {agent.container_id ? agent.container_id.substring(0, 12) : '--'}
                </dd>
              </div>
              <div>
                <dt className="text-mountain-400">{agent.status === 'running' ? 'Uptime' : 'Last Updated'}</dt>
                <dd className="text-white mt-1">
                  {agent.status === 'running'
                    ? formatUptime(agent.updated_at)
                    : new Date(agent.updated_at).toLocaleString()}
                </dd>
              </div>
            </dl>
            {agent.model_policy_id && (
              <div className="mt-3 pt-3 border-t border-navy-700">
                <dt className="text-mountain-400 text-sm">Model Policy</dt>
                <dd className="text-white text-sm mt-1">{policyName || agent.model_policy_id}</dd>
              </div>
            )}
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
                            <div className="inline-flex items-center gap-1">
                              {skill.tools.map((tool) => (
                                <span
                                  key={`${skill.id}-tool-${tool.id}`}
                                  className="px-1.5 py-0.5 text-xs rounded-md bg-navy-800 text-mountain-300 border border-navy-600 font-mono"
                                >
                                  {tool.name}
                                </span>
                              ))}
                            </div>
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
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-white">Tool Install Status</h2>
              {isAdmin && agent.status === 'running' && (
                <button
                  onClick={handleReconcileTools}
                  disabled={actionLoading}
                  className="px-3 py-1.5 text-xs font-medium rounded-md border border-navy-600 text-mountain-400 hover:text-white hover:border-navy-500 transition-colors cursor-pointer disabled:opacity-50"
                >
                  Reconcile
                </button>
              )}
            </div>
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
                            : row.status === 'installing'
                              ? 'bg-blue-900/40 text-blue-400 border-blue-700'
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

          {/* Models Summary */}
          {modelNames.length > 0 && (
            <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
              <h2 className="text-lg font-semibold text-white mb-2">Models</h2>
              <div className="flex flex-wrap gap-1">
                {modelNames.map((model) => (
                  <span
                    key={model}
                    className="px-2 py-0.5 text-xs rounded-md bg-brand-900/50 text-brand-400 border border-brand-700"
                  >
                    {model}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Meta */}
          <div className="text-xs text-mountain-500">
            Created {new Date(agent.created_at).toLocaleString()} by {agent.created_by}
          </div>

          {/* Progression: Stats + Artifacts */}
          <AgentProgression agentId={agent.id} />
        </div>
      )}

      {activeTab === 'configuration' && (
        <div className="space-y-6">
          <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-lg font-semibold text-white">Skills Runtime</h2>
              {agent.status !== 'running' && (
                <Link
                  href={`/agents/${agent.id}/edit`}
                  className="text-sm text-brand-400 hover:text-brand-300 transition-colors"
                >
                  Edit
                </Link>
              )}
            </div>
            <p className="text-sm text-mountain-400">
              Runtime capabilities are derived from assigned skills and RBAC scope.
            </p>
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

          {/* Autonomy Level */}
          <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
            <h2 className="text-lg font-semibold text-white mb-1">Autonomy Level</h2>
            <p className="text-sm text-mountain-400 mb-4">Controls how much freedom this agent has to act without human approval.</p>
            <div className="space-y-2">
              {AUTONOMY_LEVELS.map((level) => {
                const isSelected = (agent.autonomy_level || 'scoped') === level.value
                return (
                  <label
                    key={level.value}
                    className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                      isSelected
                        ? 'border-brand-600 bg-brand-900/20'
                        : 'border-navy-700 bg-navy-900 hover:border-navy-500'
                    }`}
                  >
                    <input
                      type="radio"
                      name="autonomy_level"
                      value={level.value}
                      checked={isSelected}
                      onChange={() => handleAutonomyChange(level.value)}
                      disabled={autonomySaving || agent.status === 'running'}
                      className="mt-0.5 accent-brand-500"
                    />
                    <div>
                      <span className="text-sm font-medium text-white">{level.label}</span>
                      <p className="text-xs text-mountain-500 mt-0.5">{level.description}</p>
                    </div>
                  </label>
                )
              })}
            </div>
            {agent.status === 'running' && (
              <p className="text-xs text-mountain-600 mt-2">Stop the agent to change autonomy level.</p>
            )}
          </div>

          {/* Identity — SOUL.md */}
          <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-white">SOUL.md</h2>
              {agent.status !== 'running' && !editingSoul && (
                <button
                  onClick={() => { setSoulDraft(agent.soul_md || ''); setEditingSoul(true) }}
                  className="text-sm text-brand-400 hover:text-brand-300 transition-colors cursor-pointer"
                >
                  Edit
                </button>
              )}
            </div>
            <p className="text-xs text-mountain-500 mb-3">
              The agent&apos;s identity and personality. Defines who the agent is and how it behaves.
            </p>
            {editingSoul ? (
              <div>
                <textarea
                  value={soulDraft}
                  onChange={(e) => setSoulDraft(e.target.value)}
                  rows={12}
                  className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white font-mono placeholder-mountain-500 focus:border-brand-500 focus:outline-none resize-y"
                  placeholder="You are a helpful coding agent..."
                  data-testid="soul-md-editor"
                />
                <div className="flex items-center gap-2 mt-2">
                  <button
                    onClick={() => handleSaveIdentity('soul_md', soulDraft)}
                    disabled={identitySaving}
                    className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                  >
                    {identitySaving ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    onClick={() => setEditingSoul(false)}
                    disabled={identitySaving}
                    className="px-4 py-2 text-sm font-medium rounded-lg border border-navy-600 text-mountain-400 hover:text-white hover:border-navy-500 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : agent.soul_md ? (
              <pre className="text-xs text-mountain-300 whitespace-pre-wrap bg-navy-900 rounded-md p-3 max-h-64 overflow-y-auto">
                {agent.soul_md}
              </pre>
            ) : (
              <p className="text-sm text-mountain-500 italic">No SOUL.md configured</p>
            )}
          </div>

          {/* Identity — RULES.md */}
          <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-white">RULES.md</h2>
              {agent.status !== 'running' && !editingRules && (
                <button
                  onClick={() => { setRulesDraft(agent.rules_md || ''); setEditingRules(true) }}
                  className="text-sm text-brand-400 hover:text-brand-300 transition-colors cursor-pointer"
                >
                  Edit
                </button>
              )}
            </div>
            <p className="text-xs text-mountain-500 mb-3">
              Behavioral constraints and guidelines. Skill instructions are appended at start time.
            </p>
            {editingRules ? (
              <div>
                <textarea
                  value={rulesDraft}
                  onChange={(e) => setRulesDraft(e.target.value)}
                  rows={12}
                  className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white font-mono placeholder-mountain-500 focus:border-brand-500 focus:outline-none resize-y"
                  placeholder="Follow these rules..."
                  data-testid="rules-md-editor"
                />
                <div className="flex items-center gap-2 mt-2">
                  <button
                    onClick={() => handleSaveIdentity('rules_md', rulesDraft)}
                    disabled={identitySaving}
                    className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                  >
                    {identitySaving ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    onClick={() => setEditingRules(false)}
                    disabled={identitySaving}
                    className="px-4 py-2 text-sm font-medium rounded-lg border border-navy-600 text-mountain-400 hover:text-white hover:border-navy-500 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : agent.rules_md ? (
              <pre className="text-xs text-mountain-300 whitespace-pre-wrap bg-navy-900 rounded-md p-3 max-h-64 overflow-y-auto">
                {agent.rules_md}
              </pre>
            ) : (
              <p className="text-sm text-mountain-500 italic">No RULES.md configured</p>
            )}
          </div>
        </div>
      )}

      {activeTab === 'model-access' && (
        <div className="space-y-6">
          {/* Model Access */}
          <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
            <h2 className="text-lg font-semibold text-white mb-3">Models</h2>
            {modelNames.length > 0 ? (
              <div className="space-y-3">
                <div>
                  <dt className="text-mountain-400 text-sm">Assigned Models</dt>
                  <dd className="mt-1 flex flex-wrap gap-1">
                    {modelNames.map((m) => (
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
              <p className="text-sm text-mountain-500">No models assigned</p>
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

      {activeTab === 'memory' && agent && (
        <AgentMemory agentId={agent.agent_id} />
      )}

      {activeTab === 'notebook' && agent && (
        <AgentNotebook agentId={agent.agent_id} />
      )}

      {activeTab === 'workspace' && agent && (
        <WorkspaceBrowser agentId={agent.agent_id} />
      )}

      {activeTab === 'knowledge' && agent && (
        <AgentKnowledge agentName={agent.name} />
      )}

      {activeTab === 'activity' && (
        <div className="space-y-4">
          {/* Sub-view toggle */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setActivityView('timeline')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                activityView === 'timeline'
                  ? 'bg-brand-600 text-white'
                  : 'text-mountain-400 hover:text-white hover:bg-navy-700'
              }`}
              data-testid="timeline-toggle"
            >
              Timeline
            </button>
            <button
              onClick={() => setActivityView('events')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                activityView === 'events'
                  ? 'bg-brand-600 text-white'
                  : 'text-mountain-400 hover:text-white hover:bg-navy-700'
              }`}
              data-testid="events-toggle"
            >
              Detailed Events
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

          {activityView === 'timeline' && (
            <ActivityTimeline agentId={agentId} agentStatus={agent.status} />
          )}

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
