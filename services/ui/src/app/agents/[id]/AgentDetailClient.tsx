'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
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
  tools_config: Record<string, any>
  soul_md: string
  rules_md: string
  container_id: string | null
  error_message: string | null
  created_at: string
  updated_at: string
  created_by: string
}

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
  const [logs, setLogs] = useState('')
  const [showLogs, setShowLogs] = useState(false)
  const logsEndRef = useRef<HTMLDivElement>(null)
  const eventSourceRef = useRef<EventSource | null>(null)

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

  useEffect(() => {
    fetchAgent()
  }, [fetchAgent])

  // Poll status while running
  useEffect(() => {
    if (agent?.status !== 'running') return
    const interval = setInterval(fetchAgent, 10000)
    return () => clearInterval(interval)
  }, [agent?.status, fetchAgent])

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

    es.addEventListener('end', () => {
      es.close()
    })

    es.addEventListener('error', () => {
      es.close()
    })

    return () => {
      es.close()
    }
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

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
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

      {/* Status */}
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-5 mb-6">
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

      {/* Config */}
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-5 mb-6">
        <h2 className="text-lg font-semibold text-white mb-3">Configuration</h2>
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
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

        <div className="mt-4">
          <dt className="text-mountain-400 text-sm">Tools</dt>
          <dd className="mt-1 flex gap-2">
            <ToolBadge label="Shell" enabled={agent.tools_config?.shell?.enabled} />
            <ToolBadge label="Filesystem" enabled={agent.tools_config?.filesystem?.enabled} />
            <ToolBadge label="Health" enabled={agent.tools_config?.health?.enabled} />
          </dd>
        </div>

        {agent.description && (
          <div className="mt-4">
            <dt className="text-mountain-400 text-sm">Description</dt>
            <dd className="text-white mt-1 text-sm">{agent.description}</dd>
          </div>
        )}
      </div>

      {/* Identity */}
      {(agent.soul_md || agent.rules_md) && (
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-5 mb-6">
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

      {/* Logs */}
      {isAdmin && (
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

      {/* Meta */}
      <div className="mt-6 text-xs text-mountain-500">
        Created {new Date(agent.created_at).toLocaleString()} by {agent.created_by}
      </div>
    </>
  )
}

function StatusDot({ status }: { status: string }) {
  const color = status === 'running' ? 'bg-brand-500'
    : status === 'error' ? 'bg-red-500'
    : 'bg-mountain-500'
  return <span className={`h-2 w-2 rounded-full ${color} inline-block`} />
}

function ToolBadge({ label, enabled }: { label: string; enabled?: boolean }) {
  return (
    <span className={`px-2 py-0.5 text-xs rounded-md ${
      enabled
        ? 'bg-brand-900/50 text-brand-400 border border-brand-700'
        : 'bg-navy-900 text-mountain-500 border border-navy-700'
    }`}>
      {label}
    </span>
  )
}
