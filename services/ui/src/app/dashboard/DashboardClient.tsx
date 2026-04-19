'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import type { Session } from 'next-auth'
import { Bot, MessageSquare, MessagesSquare, Activity, Plus, BarChart3, ExternalLink, Zap, BookOpen } from 'lucide-react'
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

interface AgentInfo {
  id: string
  agent_id: string
  name: string
  status: string
}

interface RecentThread {
  id: string
  title: string | null
  last_message: string | null
  last_author_type: string | null
  updated_at: string
}

const REFRESH_INTERVAL = 30_000

function sevenDaysAgo(): string {
  const d = new Date()
  d.setDate(d.getDate() - 7)
  return d.toISOString().split('T')[0]
}

function statusDotColor(status: string): string {
  switch (status) {
    case 'running':
      return 'bg-brand-400'
    case 'error':
      return 'bg-red-400'
    default:
      return 'bg-mountain-500'
  }
}

function timeAgo(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
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
  const [activeAgents, setActiveAgents] = useState<AgentInfo[]>([])
  const [recentThreads, setRecentThreads] = useState<RecentThread[]>([])
  const [workflowCount, setWorkflowCount] = useState(0)
  const [knowledgeSources, setKnowledgeSources] = useState(0)
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null)

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

      // Extract 5 most recent threads for the widget
      const sorted = [...arr]
        .sort((a: any, b: any) => {
          const aTime = a.updated_at || a.created_at || ''
          const bTime = b.updated_at || b.created_at || ''
          return bTime.localeCompare(aTime)
        })
        .slice(0, 5)
      setRecentThreads(
        sorted.map((t: any) => ({
          id: t.id,
          title: t.title,
          last_message: t.last_message ?? null,
          last_author_type: t.last_author_type ?? null,
          updated_at: t.updated_at || t.created_at || '',
        }))
      )
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
      const running: AgentInfo[] = []
      for (const a of agents) {
        agentCounts.total++
        if (a.status === 'running') {
          agentCounts.running++
          running.push({ id: a.id, agent_id: a.agent_id, name: a.name, status: a.status })
        } else if (a.status === 'error') {
          agentCounts.error++
        } else {
          agentCounts.stopped++
        }
      }
      setActiveAgents(running)

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

  const refreshAll = useCallback(() => {
    checkHealth()
    fetchHarness()
    fetchChat()
    // Fetch workflow + knowledge counts
    fetch('/api/workflows').then(r => r.ok ? r.json() : []).then(d => setWorkflowCount(Array.isArray(d) ? d.length : 0)).catch(() => {})
    fetch('/api/shared-knowledge/stats').then(r => r.ok ? r.json() : null).then(d => { if (d?.sources?.by_status?.active) setKnowledgeSources(d.sources.by_status.active) }).catch(() => {})
  }, [checkHealth, fetchHarness, fetchChat])

  useEffect(() => {
    refreshAll()
    refreshTimer.current = setInterval(refreshAll, REFRESH_INTERVAL)
    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current)
    }
  }, [refreshAll])

  const healthyCount = services.filter((s) => s.status === 'healthy').length

  return (
    <>
      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <Link href="/agents" className="rounded-lg border border-navy-700 bg-navy-800 p-5 hover:border-navy-600 transition-colors">
          <div className="flex items-center gap-3 mb-3">
            <div className="rounded-md bg-brand-400/10 p-2">
              <Bot className="h-5 w-5 text-brand-400" />
            </div>
            <h3 className="text-sm font-medium text-mountain-400">Running Agents</h3>
          </div>
          <p className="text-3xl font-bold text-white">
            {harness?.agents.running ?? '\u2014'}
          </p>
          {harness && harness.agents.total > 0 && (
            <p className="text-xs text-mountain-500 mt-1">
              of {harness.agents.total} total
            </p>
          )}
        </Link>

        <Link href="/chat" className="rounded-lg border border-navy-700 bg-navy-800 p-5 hover:border-navy-600 transition-colors">
          <div className="flex items-center gap-3 mb-3">
            <div className="rounded-md bg-brand-400/10 p-2">
              <MessageSquare className="h-5 w-5 text-brand-400" />
            </div>
            <h3 className="text-sm font-medium text-mountain-400">Chat Threads</h3>
          </div>
          <p className="text-3xl font-bold text-white">{chat.threads}</p>
        </Link>

        <Link href="/chat" className="rounded-lg border border-navy-700 bg-navy-800 p-5 hover:border-navy-600 transition-colors">
          <div className="flex items-center gap-3 mb-3">
            <div className="rounded-md bg-brand-400/10 p-2">
              <MessagesSquare className="h-5 w-5 text-brand-400" />
            </div>
            <h3 className="text-sm font-medium text-mountain-400">Messages Today</h3>
          </div>
          <p className="text-3xl font-bold text-white">{chat.messagesToday}</p>
        </Link>

        <Link href="/harness/monitoring" className="rounded-lg border border-navy-700 bg-navy-800 p-5 hover:border-navy-600 transition-colors">
          <div className="flex items-center gap-3 mb-3">
            <div className="rounded-md bg-brand-400/10 p-2">
              <Activity className="h-5 w-5 text-brand-400" />
            </div>
            <h3 className="text-sm font-medium text-mountain-400">System Health</h3>
          </div>
          <p className="text-3xl font-bold text-white">
            {services.some((s) => s.status === 'loading')
              ? '\u2014'
              : healthyCount === services.length
                ? 'All Go'
                : `${healthyCount}/${services.length}`}
          </p>
          {!services.some((s) => s.status === 'loading') && (
            <p className={`text-xs mt-1 ${healthyCount === services.length ? 'text-brand-400' : 'text-yellow-400'}`}>
              {healthyCount === services.length ? 'Operational' : 'Degraded'}
            </p>
          )}
        </Link>
      </div>

      {/* Secondary stats */}
      {(workflowCount > 0 || knowledgeSources > 0) && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {workflowCount > 0 && (
            <Link href="/harness/workflows" className="rounded-lg border border-navy-700 bg-navy-800 p-4 hover:border-navy-600 transition-colors">
              <div className="flex items-center gap-2 mb-1">
                <Zap className="h-4 w-4 text-amber-400" />
                <span className="text-xs text-mountain-400">Workflows</span>
              </div>
              <p className="text-xl font-bold text-white">{workflowCount}</p>
            </Link>
          )}
          {knowledgeSources > 0 && (
            <Link href="/harness/shared-knowledge" className="rounded-lg border border-navy-700 bg-navy-800 p-4 hover:border-navy-600 transition-colors">
              <div className="flex items-center gap-2 mb-1">
                <BookOpen className="h-4 w-4 text-blue-400" />
                <span className="text-xs text-mountain-400">Knowledge Sources</span>
              </div>
              <p className="text-xl font-bold text-white">{knowledgeSources}</p>
            </Link>
          )}
        </div>
      )}

      {/* Quick Actions */}
      <div className="flex flex-wrap gap-3 mb-8">
        <Link
          href="/agents"
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors"
        >
          <Plus className="h-4 w-4" />
          New Agent
        </Link>
        <Link
          href="/chat"
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-navy-700 hover:bg-navy-600 text-white border border-navy-600 transition-colors"
        >
          <MessageSquare className="h-4 w-4" />
          Start Chat
        </Link>
        <Link
          href="/harness/usage"
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-navy-700 hover:bg-navy-600 text-white border border-navy-600 transition-colors"
        >
          <BarChart3 className="h-4 w-4" />
          View Usage
        </Link>
      </div>

      {/* Active Agents + Recent Chat Threads (2-col on desktop) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
        {/* Active Agents */}
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">Active Agents</h2>
            <Link href="/agents" className="text-xs text-brand-400 hover:text-brand-300 transition-colors">
              View all
            </Link>
          </div>
          {activeAgents.length === 0 ? (
            <p className="text-sm text-mountain-500">No active agents</p>
          ) : (
            <ul className="space-y-3">
              {activeAgents.map((agent) => (
                <li key={agent.id} className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`h-2.5 w-2.5 rounded-full flex-shrink-0 ${statusDotColor(agent.status)}`}
                      aria-label={agent.status}
                    />
                    <span className="text-sm text-white truncate">{agent.name}</span>
                  </div>
                  <Link
                    href={`/agents/${agent.id}`}
                    className="flex-shrink-0 ml-3 inline-flex items-center gap-1 text-xs text-brand-400 hover:text-brand-300 transition-colors"
                  >
                    Open
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Recent Chat Threads */}
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">Recent Chats</h2>
            <Link href="/chat" className="text-xs text-brand-400 hover:text-brand-300 transition-colors">
              View all
            </Link>
          </div>
          {recentThreads.length === 0 ? (
            <p className="text-sm text-mountain-500">No chat threads yet</p>
          ) : (
            <ul className="space-y-3">
              {recentThreads.map((thread) => (
                <li key={thread.id}>
                  <Link
                    href={`/chat/${thread.id}`}
                    className="block rounded-md p-2 -mx-2 hover:bg-navy-700/50 transition-colors"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-white truncate">
                        {thread.title || 'Untitled thread'}
                      </span>
                      {thread.updated_at && (
                        <span className="text-xs text-mountain-500 flex-shrink-0 ml-2">
                          {timeAgo(thread.updated_at)}
                        </span>
                      )}
                    </div>
                    {thread.last_message && (
                      <p className="text-xs text-mountain-400 truncate">
                        {thread.last_author_type === 'agent' ? 'Agent: ' : ''}
                        {thread.last_message}
                      </p>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Session info card */}
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-5 mb-8">
        <h2 className="text-lg font-semibold text-white mb-3">Session</h2>
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
          <div>
            <dt className="text-mountain-400">Name</dt>
            <dd className="text-white mt-1">{session.user?.name ?? '\u2014'}</dd>
          </div>
          <div>
            <dt className="text-mountain-400">Email</dt>
            <dd className="text-white mt-1">{session.user?.email ?? '\u2014'}</dd>
          </div>
          <div>
            <dt className="text-mountain-400">Roles</dt>
            <dd className="text-white mt-1">
              {session.user?.roles?.length
                ? session.user.roles.join(', ')
                : '\u2014'}
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
                    {harness.agents.running > 0 && harness.agents.stopped > 0 && ' \u00b7 '}
                    {harness.agents.stopped > 0 && (
                      <span>{harness.agents.stopped} stopped</span>
                    )}
                    {harness.agents.error > 0 && (
                      <span className="text-red-400"> \u00b7 {harness.agents.error} error</span>
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
