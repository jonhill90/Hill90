'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
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
  models: string[]
  skills: Array<{ id: string; name: string; scope: string; tools?: Array<{ id: string; name: string }>; instructions_md?: string }>
  error_message: string | null
  created_at: string
  updated_at: string
  created_by: string
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

  // Knowledge tab sub-views
  const [knowledgeSearch, setKnowledgeSearch] = useState('')
  const [knowledgeSearchResults, setKnowledgeSearchResults] = useState<any[] | null>(null)
  const [knowledgeSearchLoading, setKnowledgeSearchLoading] = useState(false)
  const [selectedEntry, setSelectedEntry] = useState<any | null>(null)
  const [selectedEntryContent, setSelectedEntryContent] = useState<string | null>(null)
  const [selectedEntryLoading, setSelectedEntryLoading] = useState(false)

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

      {activeTab === 'knowledge' && (
        <div className="space-y-6">
          {selectedEntry ? (
            /* Entry detail view */
            <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
              <div className="mb-3">
                <button
                  onClick={() => { setSelectedEntry(null); setSelectedEntryContent(null) }}
                  className="text-sm text-brand-400 hover:text-brand-300 transition-colors cursor-pointer"
                >
                  Back to list
                </button>
              </div>
              <div className="mb-3">
                <h2 className="text-lg font-semibold text-white">{selectedEntry.title || selectedEntry.path}</h2>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs font-mono text-mountain-400">{selectedEntry.path}</span>
                  <span className="px-1.5 py-0.5 text-xs rounded-md bg-navy-900 text-mountain-300 border border-navy-600">
                    {selectedEntry.entry_type}
                  </span>
                </div>
              </div>
              {selectedEntryLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
                </div>
              ) : selectedEntryContent !== null ? (
                <pre className="text-sm text-mountain-300 whitespace-pre-wrap bg-navy-900 rounded-md p-4 max-h-96 overflow-auto">
                  {selectedEntryContent}
                </pre>
              ) : (
                <p className="text-sm text-mountain-500">Failed to load entry content</p>
              )}
            </div>
          ) : (
            /* List / search view */
            <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
              <div className="mb-3">
                <h2 className="text-lg font-semibold text-white">Knowledge Entries</h2>
              </div>

              {/* Search input */}
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!knowledgeSearch.trim() || !agent) return
                  setKnowledgeSearchLoading(true)
                  fetch(`/api/knowledge/search?q=${encodeURIComponent(knowledgeSearch.trim())}&agent_id=${agent.agent_id}`)
                    .then((res) => (res.ok ? res.json() : null))
                    .then((data) => {
                      if (data && data.results) setKnowledgeSearchResults(data.results)
                      else setKnowledgeSearchResults([])
                    })
                    .catch(() => setKnowledgeSearchResults([]))
                    .finally(() => setKnowledgeSearchLoading(false))
                }}
                className="flex gap-2 mb-4"
              >
                <input
                  type="text"
                  value={knowledgeSearch}
                  onChange={(e) => {
                    setKnowledgeSearch(e.target.value)
                    if (!e.target.value.trim()) setKnowledgeSearchResults(null)
                  }}
                  placeholder="Search knowledge entries..."
                  className="flex-1 rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white placeholder-mountain-500 focus:outline-none focus:border-brand-500"
                />
                <button
                  type="submit"
                  disabled={knowledgeSearchLoading || !knowledgeSearch.trim()}
                  className="px-4 py-2 text-sm font-medium rounded-md bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                >
                  Search
                </button>
              </form>

              {knowledgeSearchResults !== null ? (
                /* Search results view */
                <div>
                  {knowledgeSearchLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
                    </div>
                  ) : knowledgeSearchResults.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-sm text-mountain-400 mb-2">{knowledgeSearchResults.length} results</p>
                      {knowledgeSearchResults.map((result: any) => (
                        <button
                          key={result.id || result.path}
                          onClick={() => {
                            setSelectedEntry(result)
                            setSelectedEntryLoading(true)
                            fetch(`/api/knowledge/entries/${agent.agent_id}/${result.path}`)
                              .then((res) => (res.ok ? res.json() : null))
                              .then((data) => { if (data) setSelectedEntryContent(data.content ?? null) })
                              .catch(() => setSelectedEntryContent(null))
                              .finally(() => setSelectedEntryLoading(false))
                          }}
                          className="w-full text-left rounded-md border border-navy-700 bg-navy-900 p-3 hover:border-navy-500 transition-colors cursor-pointer"
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-sm font-medium text-white">{result.title || result.path}</span>
                            <span className="px-1.5 py-0.5 text-xs rounded-md bg-navy-800 text-mountain-300 border border-navy-600">
                              {result.entry_type}
                            </span>
                            {result.score != null && (
                              <span className="text-xs text-mountain-500">score: {Number(result.score).toFixed(2)}</span>
                            )}
                          </div>
                          <p className="text-xs font-mono text-mountain-400 mb-1">{result.path}</p>
                          {result.headline && (
                            <p className="text-xs text-mountain-300">{renderHeadline(result.headline)}</p>
                          )}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-mountain-500">No results found</p>
                  )}
                </div>
              ) : knowledgeLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
                </div>
              ) : knowledge.length > 0 ? (
                /* Entry list */
                <div className="space-y-2">
                  <p className="text-sm text-mountain-400 mb-3">{knowledge.length} entries</p>
                  {knowledge.map((entry: any) => (
                    <button
                      key={entry.id}
                      onClick={() => {
                        setSelectedEntry(entry)
                        setSelectedEntryLoading(true)
                        fetch(`/api/knowledge/entries/${agent.agent_id}/${entry.path}`)
                          .then((res) => (res.ok ? res.json() : null))
                          .then((data) => { if (data) setSelectedEntryContent(data.content ?? null) })
                          .catch(() => setSelectedEntryContent(null))
                          .finally(() => setSelectedEntryLoading(false))
                      }}
                      className="w-full text-left rounded-md border border-navy-700 bg-navy-900 p-3 hover:border-navy-500 transition-colors cursor-pointer"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium text-white">{entry.title || entry.path}</span>
                        <span className="px-1.5 py-0.5 text-xs rounded-md bg-navy-800 text-mountain-300 border border-navy-600">
                          {entry.entry_type}
                        </span>
                      </div>
                      <p className="text-xs font-mono text-mountain-400">{entry.path}</p>
                      <p className="text-xs text-mountain-500 mt-1">
                        {new Date(entry.created_at).toLocaleString()}
                      </p>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-mountain-500">No knowledge entries</p>
              )}
            </div>
          )}
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

function renderHeadline(text: string): React.ReactNode {
  const parts = text.split('**')
  return parts.map((part, i) =>
    i % 2 === 1
      ? React.createElement('strong', { key: i, className: 'text-white' }, part)
      : part
  )
}

function StatusDot({ status }: { status: string }) {
  const color = status === 'running' ? 'bg-brand-500'
    : status === 'error' ? 'bg-red-500'
    : 'bg-mountain-500'
  return <span className={`h-2 w-2 rounded-full ${color} inline-block`} />
}
