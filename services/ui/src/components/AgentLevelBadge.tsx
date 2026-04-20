'use client'

import React, { useState, useEffect } from 'react'
import { getAgentLevel } from '@/utils/agent-level'

interface Props {
  agentId: string
}

/**
 * Compact level badge for agent list cards. Fetches stats on mount
 * and displays "Lv.N Title".
 */
export default function AgentLevelBadge({ agentId }: Props) {
  const [label, setLabel] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const res = await fetch(`/api/agents/${agentId}/stats`)
        if (!res.ok) return
        const stats = await res.json()
        if (cancelled) return
        const info = getAgentLevel(stats)
        setLabel(`L${info.level} · ${info.title}`)
      } catch {
        // Non-fatal — badge simply won't render
      }
    }

    load()
    return () => { cancelled = true }
  }, [agentId])

  if (!label) return null

  return (
    <span
      className="inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-md bg-navy-700 text-mountain-300"
      data-testid="level-badge"
    >
      {label}
    </span>
  )
}
