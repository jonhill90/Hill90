'use client'

import { useState, useEffect, useCallback } from 'react'
import { Activity, Server, Bot, Clock, RefreshCw, ShieldCheck, HardDrive } from 'lucide-react'

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

function HealthCard({
  label,
  icon: Icon,
  status,
  loading,
}: {
  label: string
  icon: React.ComponentType<{ className?: string }>
  status: HealthStatus | null
  loading: boolean
}) {
  if (loading) {
    return (
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
        <div className="h-4 w-24 bg-navy-700 rounded animate-pulse" />
      </div>
    )
  }

  if (!status) {
    return (
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-5 flex items-start gap-3">
        <StatusDot healthy={false} />
        <div>
          <p className="text-sm font-medium text-white">{label}</p>
          <p className="text-xs mt-0.5 text-navy-400">Unable to check</p>
        </div>
      </div>
    )
  }

  const healthy = status.status === 'healthy'

  return (
    <div className="rounded-lg border border-navy-700 bg-navy-800 p-5 flex items-start gap-3">
      <StatusDot healthy={healthy} />
      <div className="flex-1">
        <div className="flex items-center gap-1.5">
          <Icon className="h-4 w-4 text-navy-400" />
          <p className="text-sm font-medium text-white">{label}</p>
        </div>
        <p className={`text-xs mt-0.5 ${healthy ? 'text-brand-400' : 'text-red-400'}`}>
          {healthy ? 'Healthy' : status.error || 'Unhealthy'}
        </p>
      </div>
    </div>
  )
}

export default function MonitoringClient() {
  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [healthLoading, setHealthLoading] = useState(true)
  const [vaultHealth, setVaultHealth] = useState<HealthStatus | null>(null)
  const [vaultLoading, setVaultLoading] = useState(true)
  const [storageHealth, setStorageHealth] = useState<HealthStatus | null>(null)
  const [storageLoading, setStorageLoading] = useState(true)
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

  const fetchVault = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/secrets/status')
      if (res.ok) {
        setVaultHealth({ service: 'vault', status: 'healthy' })
      } else {
        setVaultHealth({ service: 'vault', status: 'unhealthy', error: `HTTP ${res.status}` })
      }
    } catch {
      setVaultHealth({ service: 'vault', status: 'unhealthy', error: 'Connection failed' })
    } finally {
      setVaultLoading(false)
    }
  }, [])

  const fetchStorage = useCallback(async () => {
    try {
      const res = await fetch('/api/storage/buckets')
      if (res.ok) {
        setStorageHealth({ service: 'storage', status: 'healthy' })
      } else {
        setStorageHealth({ service: 'storage', status: 'unhealthy', error: `HTTP ${res.status}` })
      }
    } catch {
      setStorageHealth({ service: 'storage', status: 'unhealthy', error: 'Connection failed' })
    } finally {
      setStorageLoading(false)
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
    setVaultLoading(true)
    setStorageLoading(true)
    setAgentsLoading(true)
    await Promise.all([fetchHealth(), fetchVault(), fetchStorage(), fetchAgents()])
    setLastRefresh(new Date())
    setRefreshing(false)
  }, [fetchHealth, fetchVault, fetchStorage, fetchAgents])

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
          <HealthCard label="API" icon={Server} status={health} loading={healthLoading} />
          <HealthCard label="Vault" icon={ShieldCheck} status={vaultHealth} loading={vaultLoading} />
          <HealthCard label="Storage" icon={HardDrive} status={storageHealth} loading={storageLoading} />
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

      {/* Usage Stats */}
      <section>
        <SectionHeading icon={Activity} title="Usage (7 days)" />
        <UsageStats />
      </section>

      {/* Knowledge Stats */}
      <section>
        <SectionHeading icon={Clock} title="Knowledge" />
        <KnowledgeStats />
      </section>
    </div>
  )
}

function UsageStats() {
  const [usage, setUsage] = useState<any>(null)
  useEffect(() => {
    fetch('/api/usage?from=' + new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10))
      .then(r => r.ok ? r.json() : null)
      .then(d => setUsage(d))
      .catch(() => {})
  }, [])

  if (!usage) return <div className="rounded-lg border border-navy-700 bg-navy-800 p-5 text-sm text-navy-400">Loading usage...</div>

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <StatCard label="Requests" value={usage.total_requests ?? 0} color="text-white" />
      <StatCard label="Tokens" value={usage.total_tokens ?? 0} color="text-brand-400" />
      <StatCard label="Cost" value={`$${Number(usage.total_cost ?? 0).toFixed(4)}`} color="text-amber-400" isString />
      <StatCard label="Models Used" value={usage.distinct_models ?? 0} color="text-blue-400" />
    </div>
  )
}

function KnowledgeStats() {
  const [stats, setStats] = useState<any>(null)
  useEffect(() => {
    fetch('/api/shared-knowledge/stats')
      .then(r => r.ok ? r.json() : null)
      .then(d => setStats(d))
      .catch(() => {})
  }, [])

  if (!stats) return <div className="rounded-lg border border-navy-700 bg-navy-800 p-5 text-sm text-navy-400">Loading knowledge stats...</div>

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <StatCard label="Searches" value={stats.search?.total ?? 0} color="text-white" />
      <StatCard label="Zero-Result %" value={`${((stats.search?.zero_result_rate ?? 0) * 100).toFixed(1)}%`} color={stats.search?.zero_result_rate > 0.2 ? 'text-red-400' : 'text-brand-400'} isString />
      <StatCard label="Sources" value={stats.sources?.by_status?.active ?? 0} color="text-blue-400" />
      <StatCard label="Chunks" value={stats.corpus?.total_chunks ?? 0} color="text-mountain-300" />
    </div>
  )
}

function StatCard({ label, value, color, isString }: { label: string; value: number | string; color: string; isString?: boolean }) {
  const display = isString ? value : typeof value === 'number' && value > 999 ? `${(value / 1000).toFixed(1)}k` : value
  return (
    <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
      <p className="text-xs text-navy-400 uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>{display}</p>
    </div>
  )
}
