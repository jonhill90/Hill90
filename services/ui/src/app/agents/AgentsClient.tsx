'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Terminal, Folder, Heart } from 'lucide-react'
import type { Session } from 'next-auth'

interface Agent {
  id: string
  agent_id: string
  name: string
  description: string
  status: string
  cpus: string
  mem_limit: string
  pids_limit: number
  tools_config: Record<string, any> | null
  models: string[]
  skills: Array<{ id: string; name: string; scope: string }>
  created_at: string
  updated_at: string
  created_by: string
}

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

type StatusFilter = 'all' | 'running' | 'stopped' | 'error'

const STATUS_ORDER: Record<string, number> = { running: 0, error: 1, stopped: 2 }

export default function AgentsClient({ session }: { session: Session }) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const isAdmin = session.user?.roles?.includes('admin')

  const fetchData = useCallback(async () => {
    try {
      const agentsRes = await fetch('/api/agents')
      if (agentsRes.ok) setAgents(await agentsRes.json())
    } catch (err) {
      console.error('Failed to fetch agents:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleAction = async (agentId: string, action: 'start' | 'stop') => {
    setActionLoading(agentId)
    try {
      const res = await fetch(`/api/agents/${agentId}/${action}`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json()
        alert(data.error || `Failed to ${action} agent`)
      }
      await fetchData()
    } catch (err) {
      console.error(`Failed to ${action} agent:`, err)
    } finally {
      setActionLoading(null)
    }
  }

  // Filter then sort: running first, then error, then stopped
  const filteredAgents = agents
    .filter((a) => statusFilter === 'all' || a.status === statusFilter)
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3))

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="h-8 w-8 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
      </div>
    )
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Agents</h1>
          <p className="text-sm text-mountain-400 mt-1">
            {agents.length} agent{agents.length !== 1 ? 's' : ''}
          </p>
        </div>
        <Link
          href="/agents/new"
          className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors"
        >
          Create Agent
        </Link>
      </div>

      {/* Status Filter */}
      {agents.length > 0 && (
        <div className="flex gap-1 mb-6">
          {(['all', 'running', 'stopped', 'error'] as StatusFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                statusFilter === f
                  ? 'bg-brand-600 text-white'
                  : 'bg-navy-800 text-mountain-400 hover:text-white border border-navy-700'
              }`}
            >
              {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      )}

      {agents.length === 0 ? (
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-12 text-center">
          <p className="text-mountain-400 mb-4">No agents yet</p>
          <Link
            href="/agents/new"
            className="text-brand-400 hover:text-brand-300 text-sm font-medium"
          >
            Create your first agent
          </Link>
        </div>
      ) : filteredAgents.length === 0 ? (
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-12 text-center">
          <p className="text-mountain-400">No {statusFilter} agents</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredAgents.map((agent) => {
            const tc = agent.tools_config || {}
            return (
              <div
                key={agent.id}
                className="rounded-lg border border-navy-700 bg-navy-800 p-5 flex flex-col"
              >
                <div className="flex items-center justify-between mb-2">
                  <Link
                    href={`/agents/${agent.id}`}
                    className="font-semibold text-white hover:text-brand-400 transition-colors truncate"
                  >
                    {agent.name}
                  </Link>
                  <StatusBadge status={agent.status} />
                </div>

                <p className="text-sm text-mountain-400 mb-3 line-clamp-2 flex-1">
                  {agent.description || 'No description'}
                </p>

                {/* Tool Badges */}
                <div className="flex items-center gap-1.5 mb-3">
                  {tc.shell?.enabled && (
                    <span aria-label="Shell access" className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-navy-900 border border-navy-600" title="Shell access">
                      <Terminal className="h-3.5 w-3.5 text-brand-400" />
                    </span>
                  )}
                  {tc.filesystem?.enabled && (
                    <span aria-label="Filesystem access" className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-navy-900 border border-navy-600" title="Filesystem access">
                      <Folder className="h-3.5 w-3.5 text-brand-400" />
                    </span>
                  )}
                  {tc.health?.enabled && (
                    <span aria-label="Health endpoint" className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-navy-900 border border-navy-600" title="Health endpoint">
                      <Heart className="h-3.5 w-3.5 text-mountain-400" />
                    </span>
                  )}
                </div>

                {/* Skill Badges */}
                <div className="mb-3 flex flex-wrap gap-1">
                  {agent.skills && agent.skills.length > 0 ? (
                    <>
                      {agent.skills.slice(0, 3).map((skill: { id: string; name: string; scope: string }) => (
                        <span key={skill.id} className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-md ${scopeBadge(skill.scope).colorClasses}`}>
                          {skill.name}
                          <span className="opacity-75">· {scopeBadge(skill.scope).label}</span>
                        </span>
                      ))}
                      {agent.skills.length > 3 && (
                        <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-md bg-navy-900 text-mountain-400 border border-navy-700">
                          +{agent.skills.length - 3} more
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-md bg-navy-900 text-mountain-400 border border-navy-700">
                      Custom
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-3 text-xs text-mountain-500 mb-3">
                  <span>{agent.cpus} CPU</span>
                  <span>{agent.mem_limit} RAM</span>
                  <span>{agent.pids_limit} PIDs</span>
                </div>

                {agent.models && agent.models.length > 0 && (
                  <div className="mb-3">
                    <div className="flex flex-wrap gap-1">
                      {agent.models.slice(0, 2).map((m) => (
                        <span key={m} className="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-md bg-brand-900/30 text-brand-400 border border-brand-800">
                          {m}
                        </span>
                      ))}
                      {agent.models.length > 2 && (
                        <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-md bg-navy-900 text-mountain-400 border border-navy-700">
                          +{agent.models.length - 2}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-2">
                  {isAdmin && (
                    <>
                      {agent.status === 'stopped' || agent.status === 'error' ? (
                        <button
                          onClick={() => handleAction(agent.id, 'start')}
                          disabled={actionLoading === agent.id}
                          className="px-3 py-1.5 text-xs font-medium rounded-md bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                        >
                          {actionLoading === agent.id ? 'Starting...' : 'Start'}
                        </button>
                      ) : agent.status === 'running' ? (
                        <button
                          onClick={() => handleAction(agent.id, 'stop')}
                          disabled={actionLoading === agent.id}
                          className="px-3 py-1.5 text-xs font-medium rounded-md bg-red-600 hover:bg-red-500 text-white transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                        >
                          {actionLoading === agent.id ? 'Stopping...' : 'Stop'}
                        </button>
                      ) : null}
                    </>
                  )}
                  <Link
                    href={`/agents/${agent.id}`}
                    className="px-3 py-1.5 text-xs font-medium rounded-md border border-navy-600 text-mountain-400 hover:text-white hover:border-navy-500 transition-colors"
                  >
                    Details
                  </Link>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'running':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-400">
          <span className="h-2 w-2 rounded-full bg-brand-500" />
          Running
        </span>
      )
    case 'stopped':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-mountain-400">
          <span className="h-2 w-2 rounded-full bg-mountain-500" />
          Stopped
        </span>
      )
    case 'error':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-400">
          <span className="h-2 w-2 rounded-full bg-red-500" />
          Error
        </span>
      )
    default:
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-yellow-400">
          <span className="h-2 w-2 rounded-full bg-yellow-500 animate-pulse" />
          {status}
        </span>
      )
  }
}
