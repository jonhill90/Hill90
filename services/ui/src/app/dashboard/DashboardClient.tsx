'use client'

import { useState, useEffect, useCallback } from 'react'
import type { Session } from 'next-auth'
import { Bot, MessageSquare, MessagesSquare, Activity } from 'lucide-react'
import StatusBadge from '@/components/StatusBadge'

interface ServiceHealth {
  name: string
  status: 'healthy' | 'unhealthy' | 'loading'
  responseTime?: number
}

interface HarnessOverview {
  agents: { total: number; running: number; stopped: number; error: number }
  models: number
  usage: { requests: number; tokens: number; cost: number }
}

interface ChatSummary {
  threads: number
  messagesToday: number
}

function sevenDaysAgo(): string {
  const d = new Date()
  d.setDate(d.getDate() - 7)
  return d.toISOString().split('T')[0]
}

export default function DashboardClient({ session }: { session: Session }) {
  const [services, setServices] = useState<ServiceHealth[]>([
    { name: 'API', status: 'loading' },
    { name: 'AI', status: 'loading' },
    { name: 'Auth', status: 'loading' },
    { name: 'MCP', status: 'loading' },
  ])
  const [lastChecked, setLastChecked] = useState<string>('')
  const [harness, setHarness] = useState<HarnessOverview | null>(null)
  const [chat, setChat] = useState<ChatSummary>({ threads: 0, messagesToday: 0 })

  const fetchChat = useCallback(async () => {
    try {
      const res = await fetch('/api/chat')
      if (!res.ok) return
      const threads = await res.json()
      const arr = Array.isArray(threads) ? threads : []
      const start = new Date().toISOString().split('T')[0] + 'T00:00:00.000Z'
      let messagesToday = 0
      for (const t of arr) {
        if (t.last_message_at && t.last_message_at >= start) {
          messagesToday += Number(t.message_count ?? 0)
        }
      }
      setChat({ threads: arr.length, messagesToday })
    } catch (err) {
      console.error('Failed to fetch chat summary:', err)
    }
  }, [])

  const checkHealth = useCallback(async () => {
    setServices((prev) =>
      prev.map((s) => ({ ...s, status: 'loading' as const }))
    )
    try {
      const res = await fetch('/api/services/health')
      const data = await res.json()
      setServices(data.services)
      setLastChecked(new Date().toLocaleTimeString())
    } catch {
      setServices((prev) =>
        prev.map((s) => ({ ...s, status: 'unhealthy' as const }))
      )
      setLastChecked(new Date().toLocaleTimeString())
    }
  }, [])

  const fetchHarness = useCallback(async () => {
    try {
      const [agentsRes, modelsRes, usageRes] = await Promise.all([
        fetch('/api/agents'),
        fetch('/api/user-models'),
        fetch(`/api/usage?from=${sevenDaysAgo()}`),
      ])

      const agents = agentsRes.ok ? await agentsRes.json() : []
      const models = modelsRes.ok ? await modelsRes.json() : []
      const usage = usageRes.ok ? await usageRes.json() : null

      const agentCounts = { total: 0, running: 0, stopped: 0, error: 0 }
      for (const a of agents) {
        agentCounts.total++
        if (a.status === 'running') agentCounts.running++
        else if (a.status === 'error') agentCounts.error++
        else agentCounts.stopped++
      }

      setHarness({
        agents: agentCounts,
        models: models.length,
        usage: {
          requests: Number(usage?.total_requests ?? 0),
          tokens: Number(usage?.total_tokens ?? 0),
          cost: Number(usage?.total_cost_usd ?? 0),
        },
      })
    } catch (err) {
      console.error('Failed to fetch harness overview:', err)
    }
  }, [])

  useEffect(() => {
    checkHealth()
    fetchHarness()
    fetchChat()
  }, [checkHealth, fetchHarness, fetchChat])

  const healthyCount = services.filter((s) => s.status === 'healthy').length

  return (
    <>
      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="rounded-md bg-brand-400/10 p-2">
              <Bot className="h-5 w-5 text-brand-400" />
            </div>
            <h3 className="text-sm font-medium text-mountain-400">Running Agents</h3>
          </div>
          <p className="text-3xl font-bold text-white">
            {harness?.agents.running ?? '—'}
          </p>
          {harness && harness.agents.total > 0 && (
            <p className="text-xs text-mountain-500 mt-1">
              of {harness.agents.total} total
            </p>
          )}
        </div>

        <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="rounded-md bg-brand-400/10 p-2">
              <MessageSquare className="h-5 w-5 text-brand-400" />
            </div>
            <h3 className="text-sm font-medium text-mountain-400">Chat Threads</h3>
          </div>
          <p className="text-3xl font-bold text-white">{chat.threads}</p>
        </div>

        <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="rounded-md bg-brand-400/10 p-2">
              <MessagesSquare className="h-5 w-5 text-brand-400" />
            </div>
            <h3 className="text-sm font-medium text-mountain-400">Messages Today</h3>
          </div>
          <p className="text-3xl font-bold text-white">{chat.messagesToday}</p>
        </div>

        <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="rounded-md bg-brand-400/10 p-2">
              <Activity className="h-5 w-5 text-brand-400" />
            </div>
            <h3 className="text-sm font-medium text-mountain-400">System Health</h3>
          </div>
          <p className="text-3xl font-bold text-white">
            {services.some((s) => s.status === 'loading')
              ? '—'
              : healthyCount === services.length
                ? 'All Go'
                : `${healthyCount}/${services.length}`}
          </p>
          {!services.some((s) => s.status === 'loading') && (
            <p className={`text-xs mt-1 ${healthyCount === services.length ? 'text-brand-400' : 'text-yellow-400'}`}>
              {healthyCount === services.length ? 'Operational' : 'Degraded'}
            </p>
          )}
        </div>
      </div>

      {/* Session info card */}
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-5 mb-8">
        <h2 className="text-lg font-semibold text-white mb-3">Session</h2>
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
          <div>
            <dt className="text-mountain-400">Name</dt>
            <dd className="text-white mt-1">{session.user?.name ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-mountain-400">Email</dt>
            <dd className="text-white mt-1">{session.user?.email ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-mountain-400">Roles</dt>
            <dd className="text-white mt-1">
              {session.user?.roles?.length
                ? session.user.roles.join(', ')
                : '—'}
            </dd>
          </div>
        </dl>
      </div>

      {/* Harness overview */}
      {harness && (
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-5 mb-8">
          <h2 className="text-lg font-semibold text-white mb-3">Harness Overview</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <dt className="text-mountain-400">Agents</dt>
              <dd className="text-white mt-1">
                <span className="text-2xl font-bold">{harness.agents.total}</span>
                {harness.agents.total > 0 && (
                  <span className="text-xs text-mountain-500 ml-2">
                    {harness.agents.running > 0 && (
                      <span className="text-brand-400">{harness.agents.running} running</span>
                    )}
                    {harness.agents.running > 0 && harness.agents.stopped > 0 && ' · '}
                    {harness.agents.stopped > 0 && (
                      <span>{harness.agents.stopped} stopped</span>
                    )}
                    {harness.agents.error > 0 && (
                      <span className="text-red-400"> · {harness.agents.error} error</span>
                    )}
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-mountain-400">Models</dt>
              <dd className="text-2xl font-bold text-white mt-1">{harness.models}</dd>
            </div>
            <div>
              <dt className="text-mountain-400">Requests (7d)</dt>
              <dd className="text-2xl font-bold text-white mt-1">{harness.usage.requests.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-mountain-400">Cost (7d)</dt>
              <dd className="text-2xl font-bold text-white mt-1">${harness.usage.cost.toFixed(4)}</dd>
            </div>
          </div>
        </div>
      )}

      {/* Service health */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Service Health</h1>
          {lastChecked && (
            <p className="text-sm text-mountain-400 mt-1">
              Last checked: {lastChecked}
            </p>
          )}
        </div>
        <button
          onClick={checkHealth}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors cursor-pointer"
        >
          Refresh
        </button>
      </div>

      {/* Health grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {services.map((svc) => (
          <div
            key={svc.name}
            className="rounded-lg border border-navy-700 bg-navy-800 p-5"
          >
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold text-white">{svc.name}</h3>
              <StatusBadge status={svc.status} />
            </div>
            {svc.responseTime !== undefined && (
              <p className="text-xs text-mountain-400">
                Response: {svc.responseTime}ms
              </p>
            )}
          </div>
        ))}
      </div>
    </>
  )
}
