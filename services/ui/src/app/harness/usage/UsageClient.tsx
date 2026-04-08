'use client'

import { useState, useEffect, useCallback } from 'react'
import { BarChart3 } from 'lucide-react'

interface UsageSummary {
  total_requests: number
  successful_requests: number
  total_input_tokens: number
  total_output_tokens: number
  total_tokens: number
  total_cost_usd: number
}

interface GroupedRow extends UsageSummary {
  agent_id?: string
  model_name?: string
  day?: string
}

interface Agent {
  id: string
  name: string
  agent_id: string
}

type GroupBy = 'agent' | 'model' | 'day'

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().split('T')[0]
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

const DATE_PRESETS = [
  { label: '24h', days: 1 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: 'All Time', days: 0 },
] as const

export default function UsageClient() {
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [groupedData, setGroupedData] = useState<GroupedRow[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [groupBy, setGroupBy] = useState<GroupBy>('agent')
  const [fromDate, setFromDate] = useState(() => daysAgo(7))
  const [toDate, setToDate] = useState(today)
  const [activePreset, setActivePreset] = useState('7d')
  const [agentFilter, setAgentFilter] = useState('')
  const [modelFilter, setModelFilter] = useState('')

  const agentName = useCallback((id: string) =>
    agents.find((a) => a.id === id || a.agent_id === id)?.name ?? id.substring(0, 8),
  [agents])

  const buildQuery = useCallback((extra?: Record<string, string>) => {
    const params = new URLSearchParams()
    if (fromDate) params.set('from', fromDate)
    if (toDate) params.set('to', toDate)
    if (agentFilter) params.set('agent_id', agentFilter)
    if (modelFilter) params.set('model_name', modelFilter)
    if (extra) {
      for (const [k, v] of Object.entries(extra)) params.set(k, v)
    }
    return params.toString()
  }, [fromDate, toDate, agentFilter, modelFilter])

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [summaryRes, groupedRes, agentsRes] = await Promise.all([
        fetch(`/api/usage?${buildQuery()}`),
        fetch(`/api/usage?${buildQuery({ group_by: groupBy })}`),
        fetch('/api/agents'),
      ])
      if (summaryRes.ok) setSummary(await summaryRes.json())
      if (groupedRes.ok) {
        const data = await groupedRes.json()
        setGroupedData(data.data || [])
      }
      if (agentsRes.ok) setAgents(await agentsRes.json())
    } catch (err) {
      console.error('Failed to fetch usage:', err)
    } finally {
      setLoading(false)
    }
  }, [buildQuery, groupBy])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const applyPreset = (label: string, days: number) => {
    setActivePreset(label)
    if (days === 0) {
      setFromDate('')
      setToDate('')
    } else {
      setFromDate(daysAgo(days))
      setToDate(today())
    }
  }

  const groupByOptions: { value: GroupBy; label: string }[] = [
    { value: 'agent', label: 'Agent' },
    { value: 'model', label: 'Model' },
    { value: 'day', label: 'Day' },
  ]

  if (loading && !summary) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="h-8 w-8 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
      </div>
    )
  }

  const successRate = summary && summary.total_requests > 0
    ? ((Number(summary.successful_requests) / Number(summary.total_requests)) * 100).toFixed(1)
    : null

  return (
    <>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Usage</h1>
        <p className="text-sm text-mountain-400 mt-1">
          Track model usage across your agents.
        </p>
      </div>

      {/* Date range presets */}
      <div className="flex items-center gap-2 mb-4">
        {DATE_PRESETS.map((p) => (
          <button
            key={p.label}
            onClick={() => applyPreset(p.label, p.days)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              activePreset === p.label
                ? 'bg-brand-600 text-white'
                : 'border border-navy-600 text-mountain-400 hover:text-white hover:border-navy-500'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
          <SummaryCard label="Total Requests" value={Number(summary.total_requests).toLocaleString()} />
          <SummaryCard
            label="Total Tokens"
            value={Number(summary.total_tokens).toLocaleString()}
            subtitle={`${Number(summary.total_input_tokens).toLocaleString()} in / ${Number(summary.total_output_tokens).toLocaleString()} out`}
          />
          <SummaryCard label="Estimated Cost" value={`$${Number(summary.total_cost_usd).toFixed(4)}`} />
          <SummaryCard
            label="Success Rate"
            value={successRate ? `${successRate}%` : '\u2014'}
            subtitle={successRate ? `${Number(summary.successful_requests).toLocaleString()} of ${Number(summary.total_requests).toLocaleString()}` : undefined}
          />
          <SummaryCard
            label="Avg Tokens/Req"
            value={summary.total_requests > 0
              ? Math.round(Number(summary.total_tokens) / Number(summary.total_requests)).toLocaleString()
              : '\u2014'}
          />
        </div>
      )}

      {/* Filter bar */}
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-4 mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs text-mountain-400 mb-1">From</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => { setFromDate(e.target.value); setActivePreset('') }}
              className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-1.5 text-sm text-white focus:border-brand-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-mountain-400 mb-1">To</label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => { setToDate(e.target.value); setActivePreset('') }}
              className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-1.5 text-sm text-white focus:border-brand-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-mountain-400 mb-1">Agent</label>
            <select
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-1.5 text-sm text-white focus:border-brand-500 focus:outline-none"
            >
              <option value="">All agents</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-mountain-400 mb-1">Model</label>
            <input
              type="text"
              value={modelFilter}
              onChange={(e) => setModelFilter(e.target.value)}
              placeholder="Filter by model"
              className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-1.5 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Group-by toggle */}
      <div className="flex items-center gap-2 mb-4">
        <span className="text-sm text-mountain-400">Group by:</span>
        {groupByOptions.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setGroupBy(opt.value)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors cursor-pointer ${
              groupBy === opt.value
                ? 'bg-brand-900/50 text-brand-400 border-brand-700'
                : 'bg-navy-900 text-mountain-400 border-navy-700 hover:border-navy-500'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Data table */}
      {groupedData.length === 0 ? (
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-16 text-center">
          <BarChart3 size={40} className="text-mountain-600 mx-auto mb-4" />
          <p className="text-lg text-mountain-400 mb-2">No usage data for this period</p>
          <p className="text-sm text-mountain-500 max-w-md mx-auto">
            {fromDate
              ? 'Try expanding the date range or clearing filters to see data.'
              : 'Assign one or more models to an agent and run it to begin tracking usage.'}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-navy-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-navy-800 text-mountain-400 text-left">
                <th className="px-4 py-3 font-medium">
                  {groupBy === 'agent' ? 'Agent' : groupBy === 'model' ? 'Model' : 'Date'}
                </th>
                <th className="px-4 py-3 font-medium text-right">Requests</th>
                <th className="px-4 py-3 font-medium text-right">Tokens</th>
                <th className="px-4 py-3 font-medium text-right">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-700">
              {groupedData.map((row, i) => {
                const groupLabel = groupBy === 'agent'
                  ? agentName(row.agent_id || '')
                  : groupBy === 'model'
                  ? row.model_name || 'Unknown'
                  : row.day || 'Unknown'

                return (
                  <tr key={i} className="bg-navy-900 hover:bg-navy-800 transition-colors">
                    <td className="px-4 py-3 text-white">{groupLabel}</td>
                    <td className="px-4 py-3 text-mountain-300 text-right">{Number(row.total_requests).toLocaleString()}</td>
                    <td className="px-4 py-3 text-mountain-300 text-right">{Number(row.total_tokens).toLocaleString()}</td>
                    <td className="px-4 py-3 text-mountain-300 text-right">${Number(row.total_cost_usd).toFixed(4)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function SummaryCard({ label, value, subtitle }: { label: string; value: string; subtitle?: string }) {
  return (
    <div className="rounded-lg border border-navy-700 bg-navy-800 p-4">
      <dt className="text-xs text-mountain-500 uppercase tracking-wider mb-1">{label}</dt>
      <dd className="text-2xl font-bold text-white">{value}</dd>
      {subtitle && <p className="text-xs text-mountain-500 mt-1">{subtitle}</p>}
    </div>
  )
}
