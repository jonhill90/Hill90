'use client'

import React, { useState, useEffect, useCallback } from 'react'

interface Stats {
  total_inferences: number
  total_tokens: number
  estimated_cost: number
  distinct_models: number
  knowledge_entries: number
  chat_messages: number
  total_uptime_seconds: number
  skills_assigned: number
}

interface Artifact {
  id: string
  name: string
  icon: string
  description: string
  earned: boolean
}

interface Props {
  agentId: string
}

function formatUptime(seconds: number | undefined | null): string {
  if (seconds == null || seconds === 0) return '0m'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  return `${days}d ${hours}h`
}

function formatNumber(n: number | undefined | null): string {
  if (n == null) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

export default function AgentProgression({ agentId }: Props) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [earnedCount, setEarnedCount] = useState(0)
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    try {
      const [statsRes, artifactsRes] = await Promise.all([
        fetch(`/api/agents/${agentId}/stats`),
        fetch(`/api/agents/${agentId}/artifacts`),
      ])

      if (statsRes.ok) {
        const data = await statsRes.json()
        setStats(data)
      }

      if (artifactsRes.ok) {
        const data = await artifactsRes.json()
        setArtifacts(data.artifacts || [])
        setEarnedCount(data.earned_count || 0)
      }
    } catch {
      // Non-fatal
    } finally {
      setLoading(false)
    }
  }, [agentId])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6" data-testid="progression-loading">
        <div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
      </div>
    )
  }

  if (!stats) return null

  const statCards = [
    { label: 'Inferences', value: formatNumber(stats.total_inferences) },
    { label: 'Tokens', value: formatNumber(stats.total_tokens) },
    { label: 'Est. Cost', value: `$${Number(stats.estimated_cost || 0).toFixed(2)}` },
    { label: 'Knowledge', value: formatNumber(stats.knowledge_entries) },
    { label: 'Messages', value: formatNumber(stats.chat_messages) },
    { label: 'Uptime', value: formatUptime(stats.total_uptime_seconds) },
  ]

  return (
    <div className="space-y-4" data-testid="progression">
      {/* Stats Grid */}
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
        <h2 className="text-lg font-semibold text-white mb-3">Stats</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4" data-testid="stats-grid">
          {statCards.map(s => (
            <div key={s.label}>
              <p className="text-xl font-bold text-white">{s.value}</p>
              <p className="text-xs text-mountain-400">{s.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Artifacts */}
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-white">Artifacts</h2>
          <span className="text-xs text-mountain-400" data-testid="earned-count">
            {earnedCount} / {artifacts.length} earned
          </span>
        </div>
        {artifacts.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2" data-testid="artifacts-grid">
            {artifacts.map(a => (
              <div
                key={a.id}
                className={`rounded-md border p-2 text-center transition-colors ${
                  a.earned
                    ? 'border-brand-700 bg-brand-900/20'
                    : 'border-navy-700 bg-navy-900/50 opacity-40'
                }`}
                title={a.earned ? `${a.name}: ${a.description}` : `${a.name} (locked)`}
                data-testid={a.earned ? 'artifact-earned' : 'artifact-locked'}
              >
                <span className="text-xl">{a.earned ? a.icon : '?'}</span>
                <p className="text-[10px] text-mountain-400 mt-0.5 truncate">{a.name}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-mountain-500">No artifacts discovered yet.</p>
        )}
      </div>
    </div>
  )
}
