'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
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
  model_policy_id: string | null
  created_at: string
  updated_at: string
  created_by: string
}

interface ModelPolicy {
  id: string
  name: string
}

export default function AgentsClient({ session }: { session: Session }) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [policies, setPolicies] = useState<ModelPolicy[]>([])
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const isAdmin = session.user?.roles?.includes('admin')

  const policyName = useCallback((id: string | null) => {
    if (!id) return null
    return policies.find((p) => p.id === id)?.name ?? null
  }, [policies])

  const fetchData = useCallback(async () => {
    try {
      const [agentsRes, policiesRes] = await Promise.all([
        fetch('/api/agents'),
        fetch('/api/model-policies'),
      ])
      if (agentsRes.ok) setAgents(await agentsRes.json())
      if (policiesRes.ok) setPolicies(await policiesRes.json())
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
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {agents.map((agent) => {
            const policy = policyName(agent.model_policy_id)
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

                <div className="flex items-center gap-3 text-xs text-mountain-500 mb-3">
                  <span>{agent.cpus} CPU</span>
                  <span>{agent.mem_limit} RAM</span>
                  <span>{agent.pids_limit} PIDs</span>
                </div>

                {policy && (
                  <div className="mb-3">
                    <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-md bg-brand-900/30 text-brand-400 border border-brand-800">
                      {policy}
                    </span>
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
