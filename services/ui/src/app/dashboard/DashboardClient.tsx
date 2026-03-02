'use client'

import { useState, useEffect, useCallback } from 'react'
import type { Session } from 'next-auth'
import StatusBadge from '@/components/StatusBadge'

interface ServiceHealth {
  name: string
  status: 'healthy' | 'unhealthy' | 'loading'
  responseTime?: number
}

interface HarnessOverview {
  agents: { total: number; running: number; stopped: number; error: number }
  policies: number
  usage: { requests: number; tokens: number; cost: number }
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
      const [agentsRes, policiesRes, usageRes] = await Promise.all([
        fetch('/api/agents'),
        fetch('/api/model-policies'),
        fetch(`/api/usage?from=${sevenDaysAgo()}`),
      ])

      const agents = agentsRes.ok ? await agentsRes.json() : []
      const policies = policiesRes.ok ? await policiesRes.json() : []
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
        policies: policies.length,
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
  }, [checkHealth, fetchHarness])

  return (
    <>
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
              <dt className="text-mountain-400">Policies</dt>
              <dd className="text-2xl font-bold text-white mt-1">{harness.policies}</dd>
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

