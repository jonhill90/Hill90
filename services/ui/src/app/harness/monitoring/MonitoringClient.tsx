'use client'

import { useState, useEffect, useCallback } from 'react'
import { Activity, Server, Bot, Clock, RefreshCw } from 'lucide-react'

interface HealthStatus {
  service: string
  status: 'healthy' | 'unhealthy'
  error?: string
}

interface Agent {
  id: string
  agent_id: string
  name: string
  status: string
}

interface AgentSummary {
  total: number
  running: number
  stopped: number
  errored: number
}

function StatusDot({ healthy }: { healthy: boolean }) {
  return (
    <span
      className={`inline-block h-3 w-3 rounded-full ${
        healthy ? 'bg-brand-500' : 'bg-red-500'
      }`}
      aria-label={healthy ? 'healthy' : 'unhealthy'}
    />
  )
}

function SectionHeading({ icon: Icon, title }: { icon: React.ComponentType<{ className?: string }>; title: string }) {
  return (
    <h2 className="flex items-center gap-2 text-lg font-semibold text-white mb-4">
      <Icon className="h-5 w-5 text-mountain-400" />
      {title}
    </h2>
  )
}

export default function MonitoringClient() {
  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [healthLoading, setHealthLoading] = useState(true)
  const [agentSummary, setAgentSummary] = useState<AgentSummary | null>(null)
  const [agentsLoading, setAgentsLoading] = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [refreshing, setRefreshing] = useState(false)

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/health')
      if (res.ok) {
        const data = await res.json()
        setHealth({ service: data.service || 'api', status: 'healthy' })
      } else {
        setHealth({ service: 'api', status: 'unhealthy', error: `HTTP ${res.status}` })
      }
    } catch {
      setHealth({ service: 'api', status: 'unhealthy', error: 'Connection failed' })
    } finally {
      setHealthLoading(false)
    }
  }, [])

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch('/api/agents')
      if (res.ok) {
        const data = await res.json()
        const agents: Agent[] = Array.isArray(data) ? data : data.agents ?? []
        const summary: AgentSummary = {
          total: agents.length,
          running: agents.filter((a) => a.status === 'running').length,
          stopped: agents.filter((a) => a.status === 'stopped').length,
          errored: agents.filter((a) => a.status === 'error').length,
        }
        setAgentSummary(summary)
      } else {
        setAgentSummary(null)
      }
    } catch {
      setAgentSummary(null)
    } finally {
      setAgentsLoading(false)
    }
  }, [])

  const refreshAll = useCallback(async () => {
    setRefreshing(true)
    setHealthLoading(true)
    setAgentsLoading(true)
    await Promise.all([fetchHealth(), fetchAgents()])
    setLastRefresh(new Date())
    setRefreshing(false)
  }, [fetchHealth, fetchAgents])

  useEffect(() => {
    refreshAll()
    const interval = setInterval(refreshAll, 30_000)
    return () => clearInterval(interval)
  }, [refreshAll])

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Activity className="h-6 w-6 text-mountain-400" />
            Monitoring
          </h1>
          <p className="text-sm text-navy-400 mt-1">System health at a glance</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-navy-400">
            Last refresh: {lastRefresh.toLocaleTimeString()}
          </span>
          <button
            onClick={refreshAll}
            disabled={refreshing}
            className="flex items-center gap-1.5 rounded-md bg-navy-700 px-3 py-1.5 text-sm text-white hover:bg-navy-600 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Service Health */}
      <section>
        <SectionHeading icon={Server} title="Service Health" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {healthLoading ? (
            <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
              <div className="h-4 w-24 bg-navy-700 rounded animate-pulse" />
            </div>
          ) : health ? (
            <div className="rounded-lg border border-navy-700 bg-navy-800 p-5 flex items-start gap-3">
              <StatusDot healthy={health.status === 'healthy'} />
              <div>
                <p className="text-sm font-medium text-white capitalize">{health.service}</p>
                <p className={`text-xs mt-0.5 ${health.status === 'healthy' ? 'text-brand-400' : 'text-red-400'}`}>
                  {health.status === 'healthy' ? 'Healthy' : health.error || 'Unhealthy'}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-navy-400">Unable to fetch health status.</p>
          )}
        </div>
      </section>

      {/* Agent Overview */}
      <section>
        <SectionHeading icon={Bot} title="Agent Overview" />
        {agentsLoading ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="rounded-lg border border-navy-700 bg-navy-800 p-5">
                <div className="h-4 w-16 bg-navy-700 rounded animate-pulse mb-2" />
                <div className="h-8 w-12 bg-navy-700 rounded animate-pulse" />
              </div>
            ))}
          </div>
        ) : agentSummary ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Total" value={agentSummary.total} color="text-white" />
            <StatCard label="Running" value={agentSummary.running} color="text-brand-400" />
            <StatCard label="Stopped" value={agentSummary.stopped} color="text-navy-400" />
            <StatCard label="Errored" value={agentSummary.errored} color="text-red-400" />
          </div>
        ) : (
          <p className="text-sm text-navy-400">Unable to fetch agent data.</p>
        )}
      </section>

      {/* Recent Activity */}
      <section>
        <SectionHeading icon={Clock} title="Recent Activity" />
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-6 text-center">
          <p className="text-sm text-navy-400">
            Metrics integration coming soon. This section will display recent system events and activity trends.
          </p>
        </div>
      </section>
    </div>
  )
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
      <p className="text-xs text-navy-400 uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
    </div>
  )
}
