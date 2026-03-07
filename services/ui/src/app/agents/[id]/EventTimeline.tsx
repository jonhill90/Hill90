'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import EventCard, { type AgentEvent } from './EventCard'

const MAX_EVENTS = 500
const TOOL_FILTERS = ['All', 'Shell', 'Filesystem', 'Runtime'] as const
type ToolFilter = typeof TOOL_FILTERS[number]

export default function EventTimeline({
  agentId,
  agentStatus,
}: {
  agentId: string
  agentStatus: string
}) {
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [filter, setFilter] = useState<ToolFilter>('All')
  const [autoScroll, setAutoScroll] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Track whether user scrolled away from bottom
  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setAutoScroll(nearBottom)
  }, [])

  // SSE connection when agent is running
  useEffect(() => {
    if (agentStatus !== 'running') return

    const es = new EventSource(`/api/agents/${agentId}/events?follow=true&tail=50`)

    es.onmessage = (msg) => {
      try {
        const event: AgentEvent = JSON.parse(msg.data)
        setEvents((prev) => {
          const next = [...prev, event]
          return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next
        })
      } catch {
        // skip non-JSON lines
      }
    }

    es.addEventListener('end', () => es.close())
    es.addEventListener('error', () => es.close())

    return () => es.close()
  }, [agentId, agentStatus])

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [events, autoScroll])

  if (agentStatus !== 'running') {
    return (
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
        <p className="text-sm text-mountain-500">Start the agent to see live activity.</p>
      </div>
    )
  }

  const filtered =
    filter === 'All'
      ? events
      : events.filter((e) => e.tool === filter.toLowerCase())

  return (
    <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-white">Events</h2>
        <div className="flex items-center gap-1">
          {TOOL_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2 py-1 text-xs rounded-md transition-colors cursor-pointer ${
                filter === f
                  ? 'bg-brand-600 text-white'
                  : 'text-mountain-400 hover:text-white hover:bg-navy-700'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="space-y-1 max-h-96 overflow-y-auto"
      >
        {filtered.length === 0 ? (
          <p className="text-sm text-mountain-500 py-4 text-center" data-testid="no-events">
            {events.length === 0 ? 'Waiting for events...' : 'No events match the current filter.'}
          </p>
        ) : (
          filtered.map((e) => <EventCard key={e.id} event={e} />)
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
